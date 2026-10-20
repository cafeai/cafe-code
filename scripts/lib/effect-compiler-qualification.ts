import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readYarnCatalog } from "./resolve-catalog.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const entryPoint = fileURLToPath(new URL("../qualify-effect-compiler.ts", import.meta.url));
const require = createRequire(new URL("../../package.json", import.meta.url));
const reviewedTypeScriptVersion = "5.9.3";
const maximumOutputBytes = 64 * 1024;
const compilerDeadlineMs = 30_000;
const fixturePrefix = "effect-compiler-";
const fixturePattern = /^effect-compiler-[A-Za-z0-9]{6}$/u;
const barrelSource = 'import { Effect } from "effect";\nexport const value = Effect.succeed(1);\n';
const namespaceSource =
  'import * as Effect from "effect/Effect";\nexport const value = Effect.succeed(1);\n';
const diagnosticMessage =
  "Importing from barrel module effect is not allowed.    effect(importFromBarrel)";
const cliDiagnostic = `barrel.mts(1,10): error TS12: ${diagnosticMessage}`;

type Phase = "installation" | "fixture" | "api" | "ordinary-cli" | "qualified-cli" | "cleanup";
export class EffectCompilerQualificationError extends Error {
  readonly phase: Phase;
  constructor(phase: Phase) {
    super(
      `Effect compiler qualification failed during ${phase}; no typecheck qualification was granted. Run corepack yarn prepare after installing the pinned dependencies; retire pre-patch generated build-info and see docs/test-performance.md. This check never changes either.`,
    );
    this.name = "EffectCompilerQualificationError";
    this.phase = phase;
  }
}

export interface CompilerProcessResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly failure: "spawn" | "deadline" | "cancelled" | "output" | null;
  readonly stdout: string;
  readonly stderr: string;
}
interface ApiDiagnostic {
  readonly code: number;
  readonly category: number;
  readonly source: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly messageMatches: boolean;
}
export interface EffectCompilerApiReport {
  readonly typescriptVersion: string;
  readonly qualified: readonly ApiDiagnostic[];
  readonly ordinary: readonly ApiDiagnostic[];
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

/** Validate behavior, not a patch marker or an upstream command's exit0. The
 * API worker projects only finite fixture-owned metadata, never error prose. */
export function validateEffectCompilerApiReport(output: string): EffectCompilerApiReport {
  if (Buffer.byteLength(output, "utf8") > maximumOutputBytes)
    throw new EffectCompilerQualificationError("api");
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new EffectCompilerQualificationError("api");
  }
  if (
    !hasExactKeys(value, ["typescriptVersion", "qualified", "ordinary"]) ||
    value.typescriptVersion !== reviewedTypeScriptVersion ||
    !Array.isArray(value.qualified) ||
    value.qualified.length !== 1 ||
    !Array.isArray(value.ordinary) ||
    value.ordinary.length !== 0
  ) {
    throw new EffectCompilerQualificationError("api");
  }
  const diagnostic: unknown = value.qualified[0];
  if (
    !hasExactKeys(diagnostic, [
      "code",
      "category",
      "source",
      "file",
      "line",
      "column",
      "messageMatches",
    ]) ||
    diagnostic.code !== 12 ||
    diagnostic.category !== 1 ||
    diagnostic.source !== "effect" ||
    diagnostic.file !== "barrel.mts" ||
    diagnostic.line !== 1 ||
    diagnostic.column !== 10 ||
    diagnostic.messageMatches !== true
  )
    throw new EffectCompilerQualificationError("api");
  return value as unknown as EffectCompilerApiReport;
}

/** A compiler syntax/resolution error, stale output, termination or exit-status
 * suppression cannot substitute for the one deliberately failing Effect rule. */
export function validateEffectCompilerCliResult(
  result: CompilerProcessResult,
  role: "ordinary" | "qualified",
): void {
  const phase = role === "ordinary" ? "ordinary-cli" : "qualified-cli";
  if (
    result.failure !== null ||
    result.signal !== null ||
    Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") >
      maximumOutputBytes ||
    result.stderr !== ""
  )
    throw new EffectCompilerQualificationError(phase);
  const output = result.stdout.replaceAll("\r\n", "\n").trim();
  if (
    role === "ordinary"
      ? result.code !== 0 || output !== ""
      : ![1, 2].includes(result.code ?? -1) || output !== cliDiagnostic
  ) {
    throw new EffectCompilerQualificationError(phase);
  }
}

export function effectCompilerQualificationEnvironment(
  inherited: NodeJS.ProcessEnv,
  fixture: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (!isAbsolute(fixture)) throw new EffectCompilerQualificationError("fixture");
  // Never inherit Node loaders, arbitrary compiler options, provider homes,
  // credentials or PATH. Both executables are exact installed absolute paths.
  const environment: NodeJS.ProcessEnv = {
    HOME: fixture,
    USERPROFILE: fixture,
    APPDATA: fixture,
    LOCALAPPDATA: fixture,
    XDG_CONFIG_HOME: fixture,
    XDG_DATA_HOME: fixture,
    XDG_CACHE_HOME: fixture,
    TMP: fixture,
    TEMP: fixture,
    TMPDIR: fixture,
    NODE_OPTIONS: "--max-old-space-size=4096",
    NODE_DISABLE_COMPILE_CACHE: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  if (platform === "win32") {
    for (const name of ["SystemRoot", "WINDIR"]) {
      const entry = Object.entries(inherited).find(
        ([key, value]) => value !== undefined && key.toLowerCase() === name.toLowerCase(),
      );
      if (entry?.[1] !== undefined) environment[name] = entry[1];
    }
  }
  return environment;
}

function fixtureFiles(): Record<string, string> {
  const config = (plugin: boolean) =>
    JSON.stringify({
      extends: join(repositoryRoot, "tsconfig.base.json"),
      compilerOptions: {
        composite: true,
        incremental: true,
        noEmit: true,
        tsBuildInfoFile: plugin ? "qualified.tsbuildinfo" : "ordinary.tsbuildinfo",
        types: ["node"],
        lib: ["ESNext", "esnext.disposable"],
        plugins: plugin
          ? [
              {
                name: "@effect/language-service",
                namespaceImportPackages: ["effect"],
                diagnosticSeverity: { importFromBarrel: "error" },
                includeSuggestionsInTsc: false,
                ignoreEffectErrorsInTscExitCode: false,
              },
            ]
          : [],
      },
      files: ["barrel.mts", "namespace.mts"],
      include: [],
    });
  return {
    "barrel.mts": barrelSource,
    "namespace.mts": namespaceSource,
    "qualified.json": config(true),
    "ordinary.json": config(false),
  };
}

interface FixtureIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}
function privateDirectory(stat: Stats, windows = process.platform === "win32"): boolean {
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    (windows || (stat.uid === process.getuid!() && (stat.mode & 0o077) === 0))
  );
}
async function assertFixture(identity: FixtureIdentity): Promise<void> {
  const stat = await lstat(identity.path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.dev !== identity.dev ||
    stat.ino !== identity.ino ||
    (process.platform !== "win32" &&
      (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n))
  ) {
    throw new EffectCompilerQualificationError("fixture");
  }
}

/** The worker accepts only the exact source/config bytes produced by this
 * module, under the source checkout's owned .logs namespace. It never executes
 * fixture TypeScript or loads a provider/application runtime. */
export async function runEffectCompilerApiWorker(
  fixture: string,
): Promise<EffectCompilerApiReport> {
  const logs = await realpath(join(repositoryRoot, ".logs"));
  if (dirname(fixture) !== logs || !fixturePattern.test(basename(fixture)))
    throw new EffectCompilerQualificationError("fixture");
  const root = await lstat(fixture);
  if (!privateDirectory(root)) throw new EffectCompilerQualificationError("fixture");
  for (const [name, expected] of Object.entries(fixtureFiles())) {
    const path = join(fixture, name);
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (process.platform !== "win32" &&
        (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)) ||
      stat.size !== Buffer.byteLength(expected) ||
      (await readFile(path, "utf8")) !== expected
    ) {
      throw new EffectCompilerQualificationError("fixture");
    }
  }
  const ts = require("typescript") as typeof import("typescript");
  const canonical = (path: string) =>
    ts.sys.useCaseSensitiveFileNames ? resolve(path) : resolve(path).toLowerCase();
  const diagnostics = (role: "qualified" | "ordinary"): readonly ApiDiagnostic[] => {
    const config = ts.readConfigFile(join(fixture, `${role}.json`), ts.sys.readFile);
    if (config.error) throw new EffectCompilerQualificationError("api");
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      fixture,
      undefined,
      join(fixture, `${role}.json`),
    );
    if (parsed.errors.length !== 0) throw new EffectCompilerQualificationError("api");
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    // Deliberately no oldProgram, emit or incremental-cache load. API and CLI
    // run in separate joined processes so compiler heaps never accumulate.
    const received = ts.getPreEmitDiagnostics(program);
    if (received.length > 8) throw new EffectCompilerQualificationError("api");
    return received.map((diagnostic) => {
      const receivedPath = diagnostic.file ? canonical(diagnostic.file.fileName) : undefined;
      const ownFile =
        receivedPath === canonical(join(fixture, "barrel.mts"))
          ? "barrel.mts"
          : receivedPath === canonical(join(fixture, "namespace.mts"))
            ? "namespace.mts"
            : "foreign";
      const position =
        diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : undefined;
      return {
        code: diagnostic.code,
        category: diagnostic.category,
        source: diagnostic.source === "effect" ? "effect" : "other",
        file: ownFile,
        line: position ? position.line + 1 : 0,
        column: position ? position.character + 1 : 0,
        messageMatches:
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") === diagnosticMessage,
      };
    });
  };
  return {
    typescriptVersion: ts.version,
    qualified: diagnostics("qualified"),
    ordinary: diagnostics("ordinary"),
  };
}

async function runCompiler(
  args: readonly string[],
  fixture: string,
  signal?: AbortSignal,
): Promise<CompilerProcessResult> {
  if (signal?.aborted)
    return { code: null, signal: null, failure: "cancelled", stdout: "", stderr: "" };
  return new Promise((complete) => {
    const child = spawn(process.execPath, args, {
      cwd: fixture,
      env: effectCompilerQualificationEnvironment(process.env, fixture),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0;
    let failure: CompilerProcessResult["failure"] = null;
    const retire = (reason: NonNullable<CompilerProcessResult["failure"]>) => {
      failure ??= reason;
      // This is only the exact disposable compiler child, never Cafe, a native
      // provider, a PID lookup or a process tree. Await close before retirement.
      child.kill("SIGKILL");
    };
    const receive = (target: Buffer[], data: Buffer) => {
      const remaining = maximumOutputBytes - bytes;
      if (remaining > 0) target.push(data.subarray(0, remaining));
      bytes += data.byteLength;
      if (bytes > maximumOutputBytes) retire("output");
    };
    child.stdout.on("data", (data: Buffer) => receive(stdout, data));
    child.stderr.on("data", (data: Buffer) => receive(stderr, data));
    child.on("error", () => {
      failure ??= "spawn";
    });
    const cancel = () => retire("cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => retire("deadline"), compilerDeadlineMs);
    child.once("close", (code, childSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      complete({
        code,
        signal: childSignal,
        failure,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (signal?.aborted) cancel();
  });
}

async function saveResult(
  fixture: string,
  label: string,
  result: CompilerProcessResult,
): Promise<void> {
  await writeFile(join(fixture, `${label}-result.json`), JSON.stringify(result), {
    flag: "wx",
    mode: 0o600,
  });
}

async function retireSuccessfulFixture(identity: FixtureIdentity): Promise<void> {
  await assertFixture(identity);
  const quarantine = await mkdtemp(join(dirname(identity.path), "effect-compiler-retired-"));
  const stat = await lstat(quarantine, { bigint: true });
  if (
    !stat.isDirectory() ||
    (process.platform !== "win32" &&
      (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n))
  )
    throw new EffectCompilerQualificationError("cleanup");
  const transferred = join(quarantine, "fixture");
  await rename(identity.path, transferred);
  await assertFixture({ ...identity, path: transferred });
  await assertFixture({ path: quarantine, dev: stat.dev, ino: stat.ino });
  // Only the atomically transferred exact inode inside the fresh private
  // quarantine is removed. Any failed/uncertain fixture remains evidence.
  await rm(transferred, { recursive: true });
  await rmdir(quarantine);
}

export async function qualifyInstalledEffectCompiler(signal?: AbortSignal): Promise<{
  readonly typescriptVersion: string;
  readonly languageServiceVersion: string;
}> {
  let phase: Phase = "installation";
  try {
    const tsPackage = require.resolve("typescript/package.json");
    const effectPackage = require.resolve("@effect/language-service/package.json");
    const tsVersion = (JSON.parse(await readFile(tsPackage, "utf8")) as { version?: unknown })
      .version;
    const effectVersion = (
      JSON.parse(await readFile(effectPackage, "utf8")) as { version?: unknown }
    ).version;
    if (
      tsVersion !== reviewedTypeScriptVersion ||
      typeof effectVersion !== "string" ||
      effectVersion !== readYarnCatalog(repositoryRoot)["@effect/language-service"]
    )
      throw new EffectCompilerQualificationError(phase);
    const cli = join(dirname(tsPackage), "bin", "tsc");
    phase = "fixture";
    const logsPath = join(repositoryRoot, ".logs");
    await mkdir(logsPath, { recursive: true });
    const logs = await realpath(logsPath);
    const logsStat = await lstat(logsPath);
    if (
      logs !== resolve(logsPath) ||
      !logsStat.isDirectory() ||
      logsStat.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (logsStat.uid !== process.getuid!() || (logsStat.mode & 0o022) !== 0))
    ) {
      throw new EffectCompilerQualificationError(phase);
    }
    const path = await mkdtemp(join(logs, fixturePrefix));
    const stat = await lstat(path, { bigint: true });
    const identity: FixtureIdentity = { path, dev: stat.dev, ino: stat.ino };
    await assertFixture(identity);
    for (const [name, data] of Object.entries(fixtureFiles()))
      await writeFile(join(path, name), data, { flag: "wx", mode: 0o600 });
    phase = "api";
    const api = await runCompiler([entryPoint, "--api-worker", path], path, signal);
    await saveResult(path, "api", api);
    if (api.code !== 0 || api.signal !== null || api.failure !== null || api.stderr !== "")
      throw new EffectCompilerQualificationError(phase);
    validateEffectCompilerApiReport(api.stdout);
    for (const role of ["ordinary", "qualified"] as const) {
      phase = role === "ordinary" ? "ordinary-cli" : "qualified-cli";
      // The API worker does not emit, and neither actual CLI may borrow old
      // semantic diagnostics. Both build-info names must be absent on admission.
      const existing = await lstat(join(path, `${role}.tsbuildinfo`)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (existing !== null) throw new EffectCompilerQualificationError(phase);
      const result = await runCompiler(
        [cli, "--project", `${role}.json`, "--pretty", "false"],
        path,
        signal,
      );
      await saveResult(path, role, result);
      validateEffectCompilerCliResult(result, role);
    }
    phase = "cleanup";
    if (signal?.aborted) throw new EffectCompilerQualificationError(phase);
    await retireSuccessfulFixture(identity);
    return { typescriptVersion: tsVersion, languageServiceVersion: effectVersion };
  } catch (error) {
    // Do not echo compiler output, absolute paths, environment or raw causes.
    // All closed child output remains bounded in the failed private fixture.
    throw error instanceof EffectCompilerQualificationError
      ? error
      : new EffectCompilerQualificationError(phase);
  }
}
