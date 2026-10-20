// Exact no-follow descriptors and bigint identities are required at this
// disposable native fixture boundary; Effect FileSystem cannot supply them.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { constants } from "node:fs";
// The private-copy admission/retirement protocol must retain native namespace
// operations instead of weakening them to ordinary path-based file IO.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
// Native spelling must agree with the copied compiler's module resolution.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { basename, dirname, join, resolve } from "node:path";
import {
  runEffectCompilerQualificationProcess,
  type CompilerProcessResult,
} from "./effect-compiler-qualification.ts";

// This is an explicit, disposable native compiler fixture. It never installs,
// patches, imports an app/provider entry, or retires installed build-info.
const repositoryRoot = resolve(import.meta.dirname, "../..");
const entryPoint = resolve(repositoryRoot, "scripts/qualify-effect-language-service-queues.ts");
const require = createRequire(join(repositoryRoot, "package.json"));
const patchName = "@effect-language-service-npm-0.84.2-ast-fifo.patch";
const maximumPatchBytes = 256 * 1024;
const maximumBundleBytes = 4 * 1024 * 1024;
const maximumCompilerBytes = 24 * 1024 * 1024;
const maximumFixtureBytes = 192 * 1024;
const maximumOutputBytes = 64 * 1024;
const fixturePattern = /^effect-ls-queues-[A-Za-z0-9]{6}$/u;
const roles = ["original", "indexed"] as const;
type Role = (typeof roles)[number];
const probeNames = ["barrel.mts", "control.mts", "deep.mts", "wide.mts"] as const;
const requiredCodes = [12, 55, 56, 57, 58, 59, 60, 61, 62] as const;
const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

// Published 0.84.2 bytes and the reviewed same-version Yarn delta bind the
// inverse operation to a genuine upstream oracle, not a second queue model.
const bundles = {
  "cli.js": [
    "6785646836e8add8074ecee20acf78d730cf91a8cdf7028cf14c8696818c3fac",
    "791c4220cc29c821f19ef63ac944f26d8646c263e4b3195ef350ec5d58a76d44",
  ],
  "effect-lsp-patch-utils.js": [
    "4d9f93f554d51eacefa7c846aa2e2b83d4aa2b94a781dc99957e3570d4c04976",
    "621726ab724e47ac7a65fda1966f7f3a5ca1bdea658d79708cd853f1556c2a56",
  ],
  "index.js": [
    "f91dee5ac46d72e2efaa00b66220a9e5825508bc5d4f0c35628edc599aded375",
    "ddb446e453a8579a816d3c9b38ef6c9936e62c772c62d305c349577ebff3f9fe",
  ],
  "transform.js": [
    "9af9229adf6e80ec4b82fd50efbc0dc60891c3d22f33759792cacd2e0068545f",
    "33ddf23c04771c900c594dc629d3616f9e2b7c165287fa49fd7dcddb71a9477a",
  ],
} as const;
type BundleName = keyof typeof bundles;

export class EffectQueueQualificationError extends Error {
  constructor() {
    super(
      "Effect language-service FIFO equivalence was not qualified; retained fixture evidence is not a passing result.",
    );
    this.name = "EffectQueueQualificationError";
  }
}
function demand(condition: unknown): asserts condition {
  if (!condition) throw new EffectQueueQualificationError();
}

/** Invert exact reviewed unified hunks only. No fuzzy matches, executable
 * patch hooks, arbitrary paths or changing an installed package are admitted. */
export function reverseExactQueuePatch(source: string, patch: string, file: string): string {
  demand(
    Object.hasOwn(bundles, file) &&
      Buffer.byteLength(patch) <= maximumPatchBytes &&
      Buffer.byteLength(source) <= maximumBundleBytes,
  );
  const lines = patch.split("\n");
  const header = `diff --git a/${file} b/${file}`;
  const begin = lines.indexOf(header);
  demand(begin >= 0 && lines.lastIndexOf(header) === begin);
  const end = lines.findIndex((line, index) => index > begin && line.startsWith("diff --git "));
  const section = lines.slice(begin + 1, end < 0 ? undefined : end);
  demand(section.includes(`--- a/${file}`) && section.includes(`+++ b/${file}`));
  const current = source.split("\n");
  const output: string[] = [];
  let cursor = 0,
    hunks = 0;
  for (let index = 0; index < section.length; index++) {
    const line = section[index]!;
    if (!line.startsWith("@@ ")) continue;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u.exec(line);
    demand(match);
    const oldCount = Number(match[2] ?? 1),
      newStart = Number(match[3]) - 1;
    const newCount = Number(match[4] ?? 1);
    demand(
      Number.isSafeInteger(newStart) &&
        newStart >= cursor &&
        oldCount > 0 &&
        newCount > 0 &&
        ++hunks <= 256,
    );
    const before: string[] = [],
      after: string[] = [];
    while (index + 1 < section.length && !section[index + 1]!.startsWith("@@ ")) {
      const body = section[++index]!;
      if (body === "" && index === section.length - 1) break;
      demand(body.startsWith(" ") || body.startsWith("+") || body.startsWith("-"));
      if (!body.startsWith("+")) before.push(body.slice(1));
      if (!body.startsWith("-")) after.push(body.slice(1));
    }
    demand(
      before.length === oldCount &&
        after.length === newCount &&
        newStart + newCount <= current.length &&
        current.slice(newStart, newStart + newCount).join("\n") === after.join("\n"),
    );
    output.push(...current.slice(cursor, newStart), ...before);
    cursor = newStart + newCount;
  }
  demand(hunks > 0);
  return [...output, ...current.slice(cursor)].join("\n");
}

/** Fixed inert input exercises wide FIFO frontiers, generator nesting, nested
 * function scope, early returns and clean namespace/plugin-absent controls.
 * No fixture statement is executed. Timings are never an assertion. */
export function effectQueueProbeSources(): Readonly<Record<(typeof probeNames)[number], string>> {
  const fields = Array.from(
    { length: 2_048 },
    (_, index) => `{ position: ${index}, nested: [${index}, ${index + 1}] }`,
  ).join(",\n");
  const globals =
    "const stamp = Date.now(); console.log(stamp, Math.random()); setTimeout(() => undefined, 0);";
  const source = {
    "barrel.mts": 'import { Effect } from "effect";\nexport const value = Effect.succeed(1);\n',
    "control.mts":
      'import * as Effect from "effect/Effect";\nexport const value = Effect.succeed(1);\n',
    "wide.mts": `import * as Effect from "effect/Effect";\nexport const wide = [${fields}];\nexport const value = Effect.succeed(wide);\n${Array.from({ length: 6 }, (_, index) => `export function observed${index}() { ${globals} return stamp; }`).join("\n")}\n`,
    "deep.mts": `import * as Effect from "effect/Effect";\nexport const nested = Effect.gen(function* () {\n${"if (true) {\n".repeat(32)}${globals}\nyield* Effect.succeed(stamp);\n${"}\n".repeat(32)}const outsideGenerator = () => Date.now();\nreturn outsideGenerator;\n});\nexport function early(value: boolean) { if (value) return 0; return Date.now(); }\n`,
  };
  demand(
    Object.values(source).reduce((sum, text) => sum + Buffer.byteLength(text), 0) <=
      maximumFixtureBytes,
  );
  return source;
}

interface QueueDiagnostic {
  readonly code: number;
  readonly category: number;
  readonly source: string;
  readonly file: string;
  readonly start: number;
  readonly length: number;
  readonly message: string;
}
export interface EffectQueueApiReport {
  readonly typescriptVersion: string;
  readonly diagnostics: readonly QueueDiagnostic[];
  readonly ordinary: readonly QueueDiagnostic[];
}
export function validateEffectQueueApiReport(text: string): EffectQueueApiReport {
  demand(Buffer.byteLength(text) <= maximumOutputBytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new EffectQueueQualificationError();
  }
  demand(value !== null && typeof value === "object" && !Array.isArray(value));
  const report = value as Record<string, unknown>;
  demand(
    Object.keys(report).sort().join(",") === "diagnostics,ordinary,typescriptVersion" &&
      report.typescriptVersion === "5.9.3" &&
      Array.isArray(report.diagnostics) &&
      report.diagnostics.length > 0 &&
      report.diagnostics.length <= 128 &&
      Array.isArray(report.ordinary) &&
      report.ordinary.length === 0,
  );
  for (const value of report.diagnostics) {
    demand(value !== null && typeof value === "object" && !Array.isArray(value));
    const row = value as Record<string, unknown>;
    demand(
      Object.keys(row).sort().join(",") === "category,code,file,length,message,source,start" &&
        row.source === "effect" &&
        row.category === 1 &&
        Number.isSafeInteger(row.code) &&
        Number.isSafeInteger(row.start) &&
        Number.isSafeInteger(row.length) &&
        Number(row.start) >= 0 &&
        Number(row.length) > 0 &&
        probeNames.some((name) => name === row.file) &&
        row.file !== "control.mts" &&
        typeof row.message === "string" &&
        row.message.length > 0 &&
        row.message.length <= 1_024,
    );
  }
  for (const code of requiredCodes)
    demand(report.diagnostics.some((row) => (row as QueueDiagnostic).code === code));
  return report as unknown as EffectQueueApiReport;
}
export function assertEffectQueueApiEquivalence(
  original: EffectQueueApiReport,
  indexed: EffectQueueApiReport,
): void {
  demand(JSON.stringify(original) === JSON.stringify(indexed));
}

interface Identity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}
async function directoryIdentity(path: string): Promise<Identity> {
  const stat = await lstat(path, { bigint: true });
  demand(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (process.platform === "win32" ||
        (stat.uid === BigInt(process.getuid!()) && (stat.mode & 0o077n) === 0n)),
  );
  return { path, dev: stat.dev, ino: stat.ino };
}
async function assertIdentity(identity: Identity): Promise<void> {
  const current = await directoryIdentity(identity.path);
  demand(current.dev === identity.dev && current.ino === identity.ino);
}
async function readBounded(path: string, maximum: number, privateFile = false): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  demand(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size <= BigInt(maximum) &&
      (!privateFile ||
        process.platform === "win32" ||
        (before.uid === BigInt(process.getuid!()) && (before.mode & 0o077n) === 0n)),
  );
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await handle.stat({ bigint: true });
    demand(held.dev === before.dev && held.ino === before.ino && held.size === before.size);
    const bytes = Buffer.alloc(Number(before.size));
    let position = 0;
    while (position < bytes.length) {
      const result = await handle.read(bytes, position, bytes.length - position, position);
      demand(result.bytesRead > 0);
      position += result.bytesRead;
    }
    demand((await handle.read(Buffer.alloc(1), 0, 1, position)).bytesRead === 0);
    const heldAfter = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    demand(
      after.dev === before.dev &&
        after.ino === before.ino &&
        after.size === before.size &&
        after.mtimeNs === before.mtimeNs &&
        after.ctimeNs === before.ctimeNs &&
        heldAfter.dev === before.dev &&
        heldAfter.ino === before.ino &&
        heldAfter.size === before.size &&
        heldAfter.mtimeNs === before.mtimeNs &&
        heldAfter.ctimeNs === before.ctimeNs,
    );
    return bytes;
  } finally {
    await handle.close();
  }
}
async function privateWrite(path: string, value: string | Uint8Array): Promise<void> {
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
  const stat = await lstat(path);
  demand(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      (process.platform === "win32" ||
        (stat.uid === process.getuid!() && (stat.mode & 0o077) === 0)),
  );
}
function configuration(plugin: boolean): string {
  const diagnosticSeverity = Object.fromEntries(
    [
      "importFromBarrel",
      "globalDate",
      "globalDateInEffect",
      "globalConsole",
      "globalConsoleInEffect",
      "globalRandom",
      "globalRandomInEffect",
      "globalTimers",
      "globalTimersInEffect",
    ].map((name) => [name, "error"]),
  );
  return JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
      lib: ["ESNext", "DOM"],
      incremental: false,
      plugins: plugin
        ? [
            {
              name: "@effect/language-service",
              namespaceImportPackages: ["effect"],
              diagnosticSeverity,
              includeSuggestionsInTsc: false,
              ignoreEffectErrorsInTscExitCode: false,
            },
          ]
        : [],
    },
    files: probeNames,
  });
}

/** Worker uses its role's actual copied, independently patched API module.
 * It never imports the installed patched library as a diagnostic oracle. */
export async function runEffectQueueApiWorker(
  fixture: string,
  role: string,
): Promise<EffectQueueApiReport> {
  demand(roles.some((candidate) => candidate === role));
  const logs = await realpath(join(repositoryRoot, ".logs"));
  demand(dirname(fixture) === logs && fixturePattern.test(basename(fixture)));
  await directoryIdentity(fixture);
  const probe = join(fixture, "probe");
  await directoryIdentity(probe);
  for (const [name, expected] of Object.entries(effectQueueProbeSources()))
    demand(
      (await readBounded(join(probe, name), maximumFixtureBytes, true)).toString("utf8") ===
        expected,
    );
  for (const enabled of [false, true])
    demand(
      (
        await readBounded(join(probe, enabled ? "qualified.json" : "ordinary.json"), 16_384, true)
      ).toString("utf8") === configuration(enabled),
    );
  // These paths are minted only by the outer process, not accepted as arbitrary
  // module names. Validate every private parent and the exact copied module
  // manifest before native require can execute either role's compiler.
  const roleRoot = join(fixture, role);
  const tsRoot = join(roleRoot, "node_modules/typescript");
  const lsRoot = join(roleRoot, "node_modules/@effect/language-service");
  for (const path of [
    roleRoot,
    join(roleRoot, "node_modules"),
    tsRoot,
    join(tsRoot, "lib"),
    join(roleRoot, "node_modules/@effect"),
    lsRoot,
  ])
    await directoryIdentity(path);
  const manifestText = (
    await readBounded(join(roleRoot, "modules.json"), maximumOutputBytes, true)
  ).toString("utf8");
  const manifest: unknown = JSON.parse(manifestText);
  demand(manifest !== null && typeof manifest === "object" && !Array.isArray(manifest));
  const files = manifest as Record<string, unknown>;
  const names = Object.keys(files);
  demand(
    names.length > 5 &&
      names.length <= 264 &&
      names.includes("lib/typescript.js") &&
      names.includes("lib/_tsc.js") &&
      names.includes("lib/tsc.js") &&
      names.includes("package.json"),
  );
  for (const name of names) {
    demand(
      (name === "package.json" ||
        /^lib\/(?:typescript\.js|_tsc\.js|tsc\.js|lib(?:\.[a-z0-9.-]+)?\.d\.ts)$/u.test(name)) &&
        typeof files[name] === "string" &&
        /^[a-f0-9]{64}$/u.test(files[name]),
    );
    demand(
      digest(await readBounded(join(tsRoot, name), maximumCompilerBytes, true)) === files[name],
    );
  }
  for (const [name, hashes] of Object.entries(bundles))
    demand(
      digest(await readBounded(join(lsRoot, name), maximumBundleBytes, true)) ===
        hashes[role === "original" ? 0 : 1],
    );
  const ts = require(join(tsRoot, "lib/typescript.js")) as typeof import("typescript");
  demand(ts.version === "5.9.3");
  const diagnostics = (enabled: boolean): readonly QueueDiagnostic[] => {
    const path = join(probe, enabled ? "qualified.json" : "ordinary.json");
    const config = ts.readConfigFile(path, ts.sys.readFile);
    demand(!config.error);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, probe, undefined, path);
    demand(parsed.errors.length === 0);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    const received = ts.getPreEmitDiagnostics(program);
    demand(received.length <= 128);
    return received.map((diagnostic) => ({
      code: diagnostic.code,
      category: diagnostic.category,
      source: diagnostic.source ?? "typescript",
      file:
        diagnostic.file && dirname(resolve(diagnostic.file.fileName)) === probe
          ? basename(diagnostic.file.fileName)
          : "foreign",
      start: diagnostic.start ?? -1,
      length: diagnostic.length ?? -1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    }));
  };
  return {
    typescriptVersion: ts.version,
    diagnostics: diagnostics(true),
    ordinary: diagnostics(false),
  };
}

async function successfulCleanup(identity: Identity): Promise<void> {
  await assertIdentity(identity);
  const quarantine = await mkdtemp(join(dirname(identity.path), "effect-ls-queues-retired-"));
  const owner = await directoryIdentity(quarantine);
  const transferred = join(quarantine, "fixture");
  await rename(identity.path, transferred);
  await assertIdentity({ ...identity, path: transferred });
  await assertIdentity(owner);
  await rm(transferred, { recursive: true });
  await assertIdentity(owner);
  await rmdir(quarantine);
}

/** Explicit dependency qualification, not a repeated default-suite compiler.
 * Both APIs/CLIs see identical fresh sources and ordinary TS cores. */
export async function qualifyEffectLanguageServiceQueues(
  signal?: AbortSignal,
): Promise<{ readonly diagnostics: number; readonly phases: number; readonly evidence: string }> {
  const logsPath = join(repositoryRoot, ".logs");
  await mkdir(logsPath, { recursive: true });
  demand((await realpath(logsPath)) === resolve(logsPath));
  const logs = await lstat(logsPath);
  demand(
    logs.isDirectory() &&
      !logs.isSymbolicLink() &&
      (process.platform === "win32" ||
        (logs.uid === process.getuid!() && (logs.mode & 0o022) === 0)),
  );
  const fixture = await mkdtemp(join(logsPath, "effect-ls-queues-"));
  const identity = await directoryIdentity(fixture);
  process.stdout.write(`Effect FIFO fixture (retained on failure): ${fixture}\n`);
  let phases = 0;
  const run = async (
    label: string,
    args: readonly string[],
    cwd: string,
  ): Promise<CompilerProcessResult> => {
    await assertIdentity(identity);
    const result = await runEffectCompilerQualificationProcess(args, cwd, signal);
    phases++;
    await privateWrite(join(fixture, `${label}.json`), JSON.stringify(result));
    demand(result.failure === null && result.signal === null && !signal?.aborted);
    return result;
  };
  try {
    const lsRoot = dirname(require.resolve("@effect/language-service/package.json"));
    const tsRoot = dirname(require.resolve("typescript/package.json"));
    const lsPackage = await readBounded(join(lsRoot, "package.json"), 16_384);
    const tsPackage = await readBounded(join(tsRoot, "package.json"), 16_384);
    demand(
      JSON.parse(lsPackage.toString("utf8")).version === "0.84.2" &&
        JSON.parse(tsPackage.toString("utf8")).version === "5.9.3",
    );
    const patch = (
      await readBounded(join(repositoryRoot, ".yarn/patches", patchName), maximumPatchBytes)
    ).toString("utf8");
    demand(digest(patch) === "e12fb41299dbb3cd2188100db1c6f24a645b566d15a8e22ae6c63d28971052b5");
    const bundleBytes = new Map<BundleName, { original: string; indexed: string }>();
    for (const [name, hashes] of Object.entries(bundles) as Array<
      [BundleName, readonly [string, string]]
    >) {
      const indexed = (await readBounded(join(lsRoot, name), maximumBundleBytes)).toString("utf8");
      demand(digest(indexed) === hashes[1]);
      const original = reverseExactQueuePatch(indexed, patch, name);
      demand(digest(original) === hashes[0]);
      bundleBytes.set(name, { original, indexed });
    }
    const probe = join(fixture, "probe");
    await mkdir(probe, { mode: 0o700 });
    for (const [name, source] of Object.entries(effectQueueProbeSources()))
      await privateWrite(join(probe, name), source);
    for (const enabled of [false, true])
      await privateWrite(
        join(probe, enabled ? "qualified.json" : "ordinary.json"),
        configuration(enabled),
      );
    const libraries = (await readdir(join(tsRoot, "lib"))).filter((name) =>
      /^lib(?:\.[a-z0-9.-]+)?\.d\.ts$/u.test(name),
    );
    demand(libraries.length > 0 && libraries.length <= 256);
    const cores = new Map<Role, readonly string[]>();
    const reports = new Map<Role, EffectQueueApiReport>();
    const cliResults = new Map<Role, CompilerProcessResult>();
    // A same-version marker does not prove that the installed compiler carries
    // this Yarn delta. Compare both full modules with the independently rebuilt
    // indexed role, and retain those exact reference hashes on success.
    const installedCompilerSha256 = {
      "typescript.js": digest(
        await readBounded(join(tsRoot, "lib/typescript.js"), maximumCompilerBytes),
      ),
      "_tsc.js": digest(await readBounded(join(tsRoot, "lib/_tsc.js"), maximumCompilerBytes)),
    };
    let indexedCompilerSha256: typeof installedCompilerSha256 | undefined;
    for (const role of roles) {
      const roleRoot = join(fixture, role);
      const ownTs = join(roleRoot, "node_modules/typescript");
      const ownLs = join(roleRoot, "node_modules/@effect/language-service");
      await mkdir(join(ownTs, "lib"), { recursive: true, mode: 0o700 });
      await mkdir(ownLs, { recursive: true, mode: 0o700 });
      await privateWrite(join(ownTs, "package.json"), tsPackage);
      await privateWrite(join(ownLs, "package.json"), lsPackage);
      for (const [name, bytes] of bundleBytes) await privateWrite(join(ownLs, name), bytes[role]);
      let copied = 0;
      for (const name of ["typescript.js", "_tsc.js", "tsc.js", ...libraries]) {
        const bytes = await readBounded(join(tsRoot, "lib", name), maximumCompilerBytes);
        if (name === "typescript.js" || name === "_tsc.js")
          demand(digest(bytes) === installedCompilerSha256[name]);
        copied += bytes.length;
        demand(copied <= 64 * 1024 * 1024);
        await privateWrite(join(ownTs, "lib", name), bytes);
      }
      const cli = join(ownLs, "cli.js");
      demand((await run(`${role}-unpatch`, [cli, "unpatch", "--dir", ownTs], roleRoot)).code === 0);
      cores.set(
        role,
        await Promise.all(
          ["typescript.js", "_tsc.js"].map(async (name) =>
            digest(await readBounded(join(ownTs, "lib", name), maximumCompilerBytes)),
          ),
        ),
      );
      if (role === "indexed")
        demand(JSON.stringify(cores.get("original")) === JSON.stringify(cores.get(role)));
      demand((await run(`${role}-patch`, [cli, "patch", "--dir", ownTs], roleRoot)).code === 0);
      if (role === "indexed") {
        indexedCompilerSha256 = {
          "typescript.js": digest(
            await readBounded(join(ownTs, "lib/typescript.js"), maximumCompilerBytes, true),
          ),
          "_tsc.js": digest(
            await readBounded(join(ownTs, "lib/_tsc.js"), maximumCompilerBytes, true),
          ),
        };
        for (const name of ["typescript.js", "_tsc.js"] as const)
          demand(indexedCompilerSha256[name] === installedCompilerSha256[name]);
      }
      const manifest = Object.fromEntries(
        await Promise.all(
          [
            "package.json",
            ...["typescript.js", "_tsc.js", "tsc.js", ...libraries].map((name) => `lib/${name}`),
          ].map(async (name) => [
            name,
            digest(await readBounded(join(ownTs, name), maximumCompilerBytes, true)),
          ]),
        ),
      );
      await privateWrite(join(roleRoot, "modules.json"), JSON.stringify(manifest));
      const api = await run(`${role}-api`, [entryPoint, "--api-worker", fixture, role], probe);
      demand(api.code === 0 && api.stderr === "");
      reports.set(role, validateEffectQueueApiReport(api.stdout));
      const ordinary = await run(
        `${role}-ordinary-cli`,
        [join(ownTs, "lib/tsc.js"), "--project", "ordinary.json", "--pretty", "false"],
        probe,
      );
      demand(ordinary.code === 0 && ordinary.stdout === "" && ordinary.stderr === "");
      const qualified = await run(
        `${role}-qualified-cli`,
        [join(ownTs, "lib/tsc.js"), "--project", "qualified.json", "--pretty", "false"],
        probe,
      );
      demand([1, 2].includes(qualified.code ?? -1) && qualified.stderr === "");
      for (const code of requiredCodes) demand(qualified.stdout.includes(`error TS${code}:`));
      cliResults.set(role, qualified);
    }
    demand(indexedCompilerSha256 !== undefined);
    // Retire neither mismatched installation evidence nor a concurrently
    // replaced compiler. This fixture does not repair the installed toolchain.
    for (const name of ["typescript.js", "_tsc.js"] as const) {
      demand(
        digest(await readBounded(join(tsRoot, "lib", name), maximumCompilerBytes)) ===
          installedCompilerSha256[name],
      );
      demand(
        digest(
          await readBounded(
            join(fixture, "indexed/node_modules/typescript/lib", name),
            maximumCompilerBytes,
            true,
          ),
        ) === indexedCompilerSha256[name],
      );
    }
    assertEffectQueueApiEquivalence(reports.get("original")!, reports.get("indexed")!);
    const original = cliResults.get("original")!,
      indexed = cliResults.get("indexed")!;
    demand(
      original.code === indexed.code &&
        original.stdout.replaceAll("\r\n", "\n") === indexed.stdout.replaceAll("\r\n", "\n"),
    );
    // Keep the small exact result outside the disposable compiler tree. The
    // normal success cleanup must not erase the ordered diagnostic evidence.
    const evidence = join(logsPath, `${basename(fixture)}-equivalence.json`);
    await privateWrite(
      evidence,
      JSON.stringify({
        version: 1,
        typescript: "5.9.3",
        languageService: "0.84.2",
        patchSha256: digest(patch),
        pristineCompilerSha256: cores.get("original"),
        indexedCompilerSha256,
        installedCompilerSha256,
        api: reports.get("indexed"),
        cli: {
          code: indexed.code,
          stdout: indexed.stdout.replaceAll("\r\n", "\n"),
          sha256: digest(indexed.stdout.replaceAll("\r\n", "\n")),
        },
        phases,
      }),
    );
    demand(!signal?.aborted);
    const diagnostics = reports.get("indexed")!.diagnostics.length;
    await successfulCleanup(identity);
    return { diagnostics, phases, evidence };
  } catch {
    throw new EffectQueueQualificationError();
  }
}
