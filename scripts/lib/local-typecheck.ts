// The coordinator owns direct native child handles and their close receipts.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
// O_NOFOLLOW and descriptor identity must not be replaced by path-only IO.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { constants } from "node:fs";
// Manifest admission is a bounded native descriptor read, not effectful app IO.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
// Yarn portable paths must be checked against both actual native path grammars.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import * as Schema from "effect/Schema";
import { corepackTestCommand } from "./run-test-plan.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const metadataLimit = 1_048_576;
const workspaceLimit = 256;
const metadataDeadlineMs = 30_000;
const qualifiedTypeScriptVersion = "5.9.3";
const packageName = /^(?:@[a-z0-9][a-z0-9._-]{0,127}\/)?[a-z0-9][a-z0-9._-]{0,127}$/u;

type Refusal = "arguments" | "metadata" | "workspace" | "script" | "compiler" | "cancelled";

/** These are fixed operational classifications, not received compiler/metadata
 * errors. The canonical command remains available when a future workspace needs
 * a different compiler contract; such a program must never silently disappear. */
export class LocalTypecheckError extends Error {
  readonly reason: Refusal;
  constructor(reason: Refusal) {
    super(
      reason === "arguments"
        ? "Local typechecking accepts only --concurrency=1, --concurrency=2 or --concurrency=3 once."
        : reason === "cancelled"
          ? "Local typechecking was cancelled; no complete qualification was granted."
          : `Local typechecking refused an unsupported ${reason} contract. Run corepack yarn typecheck and review the local coordinator policy; no complete qualification was granted.`,
    );
    this.name = "LocalTypecheckError";
    this.reason = reason;
  }
}

export function parseLocalTypecheckArguments(args: readonly string[]): 1 | 2 | 3 {
  if (args.length === 0) return 3;
  if (args.length === 1 && args[0] === "--concurrency=1") return 1;
  if (args.length === 1 && args[0] === "--concurrency=2") return 2;
  if (args.length === 1 && args[0] === "--concurrency=3") return 3;
  throw new LocalTypecheckError("arguments");
}

interface WorkspaceMetadata {
  readonly name: string;
  readonly location: string;
}

export interface LocalTypecheckProgram {
  readonly name: string;
  readonly cwd: string;
  readonly compiler: string;
}

/**
 * Operational admission hints only, not a result cache or selection rule.
 * These two known expensive programs start first when multiple native slots are
 * available; stable ties retain discovery order and every unknown program.
 */
export function prioritizeLocalTypecheckPrograms(
  programs: readonly LocalTypecheckProgram[],
): readonly LocalTypecheckProgram[] {
  const priority = (name: string) =>
    name === "effect-codex-app-server" ? 2 : name === "@cafeai/cafe-code" ? 1 : 0;
  return [...programs].sort((left, right) => priority(right.name) - priority(left.name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new LocalTypecheckError("cancelled");
}

/** Yarn emits portable workspace-relative paths. Refuse traversal and native
 * absolute/device spellings before any workspace manifest can be opened. */
export function parseLocalTypecheckMetadata(output: string): readonly WorkspaceMetadata[] {
  if (Buffer.byteLength(output) > metadataLimit) throw new LocalTypecheckError("metadata");
  const lines = output.trim().split(/\r?\n/u);
  if (lines.length === 0 || lines.length > workspaceLimit)
    throw new LocalTypecheckError("metadata");
  const names = new Set<string>();
  const locations = new Set<string>();
  const workspaces: WorkspaceMetadata[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = decodeJson(line);
    } catch {
      throw new LocalTypecheckError("metadata");
    }
    if (
      !isRecord(value) ||
      typeof value.name !== "string" ||
      value.name.length > 256 ||
      !packageName.test(value.name) ||
      typeof value.location !== "string" ||
      value.location.length === 0 ||
      value.location.length > 1_024 ||
      /[\u0000-\u001f\u007f\\:]/u.test(value.location) ||
      isAbsolute(value.location) ||
      win32.isAbsolute(value.location) ||
      (value.location !== "." &&
        value.location.split("/").some((part) => part === "" || part === "." || part === "..")) ||
      names.has(value.name) ||
      locations.has(value.location)
    )
      throw new LocalTypecheckError("metadata");
    names.add(value.name);
    locations.add(value.location);
    workspaces.push({ name: value.name, location: value.location });
  }
  if (!locations.has(".")) throw new LocalTypecheckError("metadata");
  return workspaces;
}

async function readBoundedJson(path: string): Promise<unknown> {
  const file = await open(
    path,
    // Refuse non-regular leaves through the held stat below without first
    // blocking on a FIFO's absent writer. Windows retains native open flags.
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > metadataLimit) throw new LocalTypecheckError("workspace");
    const bytes = Buffer.alloc(metadataLimit + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const after = await file.stat();
    if (
      size > metadataLimit ||
      before.size !== size ||
      after.size !== size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new LocalTypecheckError("workspace");
    return decodeJson(bytes.subarray(0, size).toString("utf8"));
  } finally {
    await file.close();
  }
}

/** Only the pinned Corepack metadata command runs here; no workspace script or
 * arbitrary shell receives these arguments. A timeout/cancel/overflow stops the
 * exact held metadata child, then waits for its native close before returning. */
export async function readLocalTypecheckMetadata(
  root: string,
  signal: AbortSignal,
): Promise<string> {
  throwIfCancelled(signal);
  let command: ReturnType<typeof corepackTestCommand>;
  try {
    command = corepackTestCommand(process.env.COREPACK_ROOT, ["workspaces", "list", "--json"]);
  } catch {
    throw new LocalTypecheckError("metadata");
  }
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: root,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let refused = false;
    let terminated = false;
    let byteCount = 0;
    const chunks: Buffer[] = [];
    const retire = () => {
      refused = true;
      if (terminated) return;
      terminated = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // A failed signal is not permission to detach, use a PID fallback, or
        // report completion. The exact child's close still owns retirement.
      }
    };
    const receive = (value: Buffer, stdout: boolean) => {
      byteCount += value.length;
      if (byteCount > metadataLimit) retire();
      else if (stdout && !refused) chunks.push(value);
    };
    // Metadata's owned native process has a real, nonrenewable deadline even
    // when a caller is running beneath a virtual Effect test clock.
    // @effect-diagnostics-next-line globalTimers:off
    const timer = setTimeout(retire, metadataDeadlineMs);
    signal.addEventListener("abort", retire, { once: true });
    child.stdout.on("data", (value: Buffer) => receive(value, true));
    child.stderr.on("data", (value: Buffer) => receive(value, false));
    child.once("error", () => {
      refused = true;
    });
    child.once("close", (code, nativeSignal) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", retire);
      if (signal.aborted) reject(new LocalTypecheckError("cancelled"));
      else if (refused || code !== 0 || nativeSignal !== null)
        reject(new LocalTypecheckError("metadata"));
      else resolveOutput(Buffer.concat(chunks).toString("utf8"));
    });
    if (signal.aborted) retire();
  });
}

/** Admission checks the actual installed entry, not a package label or PATH
 * shim. No two workspace declarations may alias one physical output owner. */
export async function discoverLocalTypecheckPrograms(
  sourceRoot: string,
  signal: AbortSignal,
  list: typeof readLocalTypecheckMetadata = readLocalTypecheckMetadata,
): Promise<readonly LocalTypecheckProgram[]> {
  throwIfCancelled(signal);
  try {
    const root = await realpath(sourceRoot);
    const manifest = await readBoundedJson(resolve(root, "package.json"));
    if (!isRecord(manifest) || manifest.packageManager !== "yarn@4.17.1")
      throw new LocalTypecheckError("metadata");
    const metadata = parseLocalTypecheckMetadata(await list(root, signal));
    throwIfCancelled(signal);
    if (metadata.find((workspace) => workspace.location === ".")?.name !== manifest.name)
      throw new LocalTypecheckError("metadata");
    const rootRequire = createRequire(resolve(root, "package.json"));
    const compiler = await realpath(rootRequire.resolve("typescript/bin/tsc"));
    const version = await readBoundedJson(rootRequire.resolve("typescript/package.json"));
    if (!isRecord(version) || version.version !== qualifiedTypeScriptVersion)
      throw new LocalTypecheckError("compiler");
    const programs: LocalTypecheckProgram[] = [];
    const owners = new Set<string>();
    for (const workspace of metadata) {
      throwIfCancelled(signal);
      // The exact root is excluded by its relative identity, not a package name
      // that can change. Its typecheck command would recursively invoke Turbo.
      if (workspace.location === ".") continue;
      const declared = resolve(root, workspace.location);
      const cwd = await realpath(declared);
      const inside = relative(root, cwd);
      if (
        cwd !== declared ||
        inside === "" ||
        inside === ".." ||
        inside.startsWith(`..${sep}`) ||
        isAbsolute(inside) ||
        owners.has(cwd)
      )
        throw new LocalTypecheckError("workspace");
      owners.add(cwd);
      const pkg = await readBoundedJson(resolve(cwd, "package.json"));
      if (!isRecord(pkg) || pkg.name !== workspace.name) throw new LocalTypecheckError("workspace");
      if (pkg.scripts === undefined) continue;
      if (!isRecord(pkg.scripts)) throw new LocalTypecheckError("script");
      if (!Object.hasOwn(pkg.scripts, "typecheck")) continue;
      if (pkg.scripts.typecheck !== "tsc --noEmit") throw new LocalTypecheckError("script");
      const workspaceRequire = createRequire(resolve(cwd, "package.json"));
      if ((await realpath(workspaceRequire.resolve("typescript/bin/tsc"))) !== compiler)
        throw new LocalTypecheckError("compiler");
      programs.push({ name: workspace.name, cwd, compiler });
    }
    throwIfCancelled(signal);
    if (programs.length === 0) throw new LocalTypecheckError("workspace");
    return programs;
  } catch (error) {
    if (signal.aborted) throw new LocalTypecheckError("cancelled");
    throw error instanceof LocalTypecheckError ? error : new LocalTypecheckError("workspace");
  }
}

export interface LocalCompilerExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly transportError: boolean;
}

export interface LocalCompilerChild {
  /** Settles only after this exact child's native close, never merely exit. */
  readonly closed: Promise<LocalCompilerExit>;
  readonly terminate: () => void;
}

export type LocalCompilerLaunch = (program: LocalTypecheckProgram) => LocalCompilerChild;

interface HeldCompiler {
  readonly program: LocalTypecheckProgram;
  readonly child: LocalCompilerChild;
  terminated: boolean;
}

/** Parallel native diagnostics need an exact workspace label, otherwise equal
 * relative paths from two programs are indistinguishable. Keep complete text
 * and UTF-8 decoding while bounding an unterminated line to 64K code units.
 * Only an oversized line is split, never truncated or treated as success. */
export function localTypecheckOutput(name: string, emit: (text: string) => void) {
  if (!packageName.test(name)) throw new LocalTypecheckError("workspace");
  const decoder = new StringDecoder("utf8");
  const limit = 65_536;
  let pending = "";
  const flush = (text: string, final: boolean) => {
    pending += text;
    while (pending.length > 0) {
      const newline = pending.indexOf("\n");
      if (newline >= 0 && newline < limit) {
        emit(`[${name}] ${pending.slice(0, newline + 1)}`);
        pending = pending.slice(newline + 1);
      } else if (pending.length >= limit) {
        // Do not split a UTF-16 surrogate pair when encoding a large fragment.
        const last = pending.charCodeAt(limit - 1);
        const cut = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit;
        emit(`[${name}] ${pending.slice(0, cut)}\n`);
        pending = pending.slice(cut);
      } else if (final) {
        emit(`[${name}] ${pending}\n`);
        pending = "";
      } else break;
    }
  };
  return {
    write: (bytes: Buffer) => flush(decoder.write(bytes), false),
    end: () => flush(decoder.end(), true),
  };
}

export const launchLocalTypecheckCompiler: LocalCompilerLaunch = (program) => {
  process.stdout.write(`Typechecking ${program.name}\n`);
  const started = performance.now();
  const child = spawn(process.execPath, [program.compiler, "--noEmit"], {
    cwd: program.cwd,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
  });
  let transportError = false;
  const stdout = localTypecheckOutput(program.name, (text) => process.stdout.write(text));
  const stderr = localTypecheckOutput(program.name, (text) => process.stderr.write(text));
  child.stdout.on("data", stdout.write);
  child.stderr.on("data", stderr.write);
  const streamFailure = () => {
    transportError = true;
    child.kill("SIGTERM");
  };
  child.stdout.once("error", streamFailure);
  child.stderr.once("error", streamFailure);
  const closed = new Promise<LocalCompilerExit>((resolveExit) => {
    child.once("error", () => {
      transportError = true;
    });
    child.once("close", (code, signal) => {
      stdout.end();
      stderr.end();
      process.stdout.write(
        `Typechecking ${program.name}: ${((performance.now() - started) / 1000).toFixed(2)}s; ${transportError ? "transport failure" : signal !== null ? "native signal" : code === 0 ? "passed" : "failed"}.\n`,
      );
      resolveExit({ code, signal, transportError });
    });
  });
  return {
    closed,
    terminate: () => {
      child.kill("SIGTERM");
    },
  };
};

export interface LocalTypecheckResult {
  readonly passed: boolean;
  readonly cancelled: boolean;
  readonly completed: number;
  readonly failures: readonly {
    readonly workspace: string;
    readonly reason: "compiler" | "spawn" | "transport" | "signal" | "termination";
  }[];
}

/** One tiny owned queue, not another build graph. Ordinary compiler failures
 * retain the rest of the complete diagnostic set. Cancellation and uncertain
 * native ownership fence admission before signalling only currently held child
 * handles; all those close receipts are joined even after an earlier failure. */
export async function runLocalTypecheckPrograms(
  programs: readonly LocalTypecheckProgram[],
  concurrency: 1 | 2 | 3,
  signal: AbortSignal,
  launch: LocalCompilerLaunch = launchLocalTypecheckCompiler,
): Promise<LocalTypecheckResult> {
  if (concurrency !== 1 && concurrency !== 2 && concurrency !== 3)
    throw new LocalTypecheckError("arguments");
  if (programs.length === 0 || programs.length > workspaceLimit)
    throw new LocalTypecheckError("workspace");
  // Copy finite scalars before any await, keeping queue identity independent of
  // a caller mutating its arrays while an earlier native program is closing.
  const selected = programs.map((program) => ({
    name: program.name,
    cwd: program.cwd,
    compiler: program.compiler,
  }));
  if (
    new Set(selected.map((program) => program.cwd)).size !== selected.length ||
    selected.some(
      (program) =>
        !packageName.test(program.name) ||
        !isAbsolute(program.cwd) ||
        !isAbsolute(program.compiler),
    )
  )
    throw new LocalTypecheckError("workspace");
  const active = new Set<HeldCompiler>();
  const failures: {
    workspace: string;
    reason: "compiler" | "spawn" | "transport" | "signal" | "termination";
  }[] = [];
  let stopped = false;
  let cancelled = false;
  let next = 0;
  let completed = 0;
  const terminate = (owner: HeldCompiler) => {
    if (owner.terminated) return;
    owner.terminated = true;
    try {
      owner.child.terminate();
    } catch {
      failures.push({ workspace: owner.program.name, reason: "termination" });
    }
  };
  const stop = () => {
    stopped = true;
    for (const owner of active) terminate(owner);
  };
  const cancel = () => {
    cancelled = true;
    stop();
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const worker = async () => {
    while (!stopped && next < selected.length) {
      const program = selected[next++]!;
      let child: LocalCompilerChild;
      try {
        child = launch(program);
      } catch {
        failures.push({ workspace: program.name, reason: "spawn" });
        stop();
        return;
      }
      const owner = { program, child, terminated: false };
      active.add(owner);
      // Covers an abort synchronously received during native spawn, before the
      // newly returned exact child could be inserted in the held set above.
      if (signal.aborted) cancel();
      if (stopped) terminate(owner);
      try {
        const result = await child.closed;
        active.delete(owner);
        completed += 1;
        if (result.transportError) {
          failures.push({ workspace: program.name, reason: "transport" });
          stop();
        } else if (result.signal !== null) {
          failures.push({ workspace: program.name, reason: "signal" });
          stop();
        } else if (result.code !== 0)
          failures.push({ workspace: program.name, reason: "compiler" });
      } catch {
        active.delete(owner);
        failures.push({ workspace: program.name, reason: "transport" });
        stop();
      } finally {
        active.delete(owner);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  return {
    passed: !cancelled && failures.length === 0 && completed === selected.length,
    cancelled,
    completed,
    failures,
  };
}
