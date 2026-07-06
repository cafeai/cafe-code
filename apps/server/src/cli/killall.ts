// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";

import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

export type CafeKillallProcessRole = "desktop-client" | "launcher" | "provider-runtime" | "server";

export interface CafeKillallProcessSnapshot {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

export interface CafeKillallProcessTarget extends CafeKillallProcessSnapshot {
  readonly role: CafeKillallProcessRole;
}

export interface CafeKillallTerminationResult extends CafeKillallProcessTarget {
  readonly signalSent: boolean;
  readonly escalated: boolean;
  readonly stillAlive: boolean;
  readonly error: string | null;
}

class CafeKillallError extends Data.TaggedError("CafeKillallError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const PROCESS_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_TERMINATE_GRACE_MS = 1_500;
const DEFAULT_KILL_GRACE_MS = 1_500;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function execFileText(command: string, args: ReadonlyArray<string>) {
  return Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        execFile(
          command,
          [...args],
          {
            encoding: "utf8",
            maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
            shell: false,
          },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(stderr.trim() || error.message));
              return;
            }
            resolve(stdout);
          },
        );
      }),
    catch: (cause) =>
      new CafeKillallError({
        message: `Failed to query running processes with ${command}.`,
        cause,
      }),
  });
}

export function parsePosixProcessList(output: string): ReadonlyArray<CafeKillallProcessSnapshot> {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      if (match === null) {
        return [];
      }
      return [
        {
          pid: Number.parseInt(match[1] as string, 10),
          ppid: Number.parseInt(match[2] as string, 10),
          command: match[3] as string,
        },
      ];
    });
}

interface WindowsProcessRow {
  readonly ProcessId?: unknown;
  readonly ParentProcessId?: unknown;
  readonly Name?: unknown;
  readonly CommandLine?: unknown;
}

function normalizeWindowsProcessRows(value: unknown): ReadonlyArray<WindowsProcessRow> {
  if (Array.isArray(value)) {
    return value.filter((row): row is WindowsProcessRow => row !== null && typeof row === "object");
  }
  if (value !== null && typeof value === "object") {
    return [value as WindowsProcessRow];
  }
  return [];
}

export function parseWindowsProcessList(output: string): ReadonlyArray<CafeKillallProcessSnapshot> {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return [];
  }

  return normalizeWindowsProcessRows(decoded).flatMap((row) => {
    const pid = typeof row.ProcessId === "number" ? row.ProcessId : Number(row.ProcessId);
    const ppid =
      typeof row.ParentProcessId === "number" ? row.ParentProcessId : Number(row.ParentProcessId);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) {
      return [];
    }

    const commandLine =
      typeof row.CommandLine === "string" && row.CommandLine.trim().length > 0
        ? row.CommandLine
        : typeof row.Name === "string"
          ? row.Name
          : "";
    if (commandLine.length === 0) {
      return [];
    }

    return [
      {
        pid,
        ppid,
        command: commandLine,
      },
    ];
  });
}

const listPosixProcesses = execFileText("ps", ["-axo", "pid=,ppid=,command="]).pipe(
  Effect.map(parsePosixProcessList),
);

const windowsProcessQuery = [
  "$ErrorActionPreference = 'Stop';",
  "Get-CimInstance Win32_Process |",
  "Select-Object ProcessId,ParentProcessId,Name,CommandLine |",
  "ConvertTo-Json -Compress -Depth 3",
].join(" ");

const listWindowsProcesses = execFileText("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  windowsProcessQuery,
]).pipe(Effect.map(parseWindowsProcessList));

export const listCafeKillallProcesses = (platform: NodeJS.Platform = process.platform) =>
  platform === "win32" ? listWindowsProcesses : listPosixProcesses;

function normalizeCommand(command: string): string {
  return command.replace(/\\/gu, "/");
}

function hasCafeCodeHint(command: string): boolean {
  const lower = normalizeCommand(command).toLowerCase();
  return (
    lower.includes("cafe-code") ||
    lower.includes("cafecode") ||
    lower.includes("cafe code") ||
    lower.includes("@cafeai/cafe-code")
  );
}

function executableToken(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  return trimmed.split(/\s+/u)[0] ?? "";
}

function executableBasename(command: string): string {
  const token = normalizeCommand(executableToken(command));
  return (
    token
      .split("/")
      .findLast((part) => part.length > 0)
      ?.toLowerCase() ?? ""
  );
}

function isNodeLikeExecutable(command: string): boolean {
  const basename = executableBasename(command);
  return (
    basename === "node" ||
    basename === "node.exe" ||
    basename === "bun" ||
    basename === "bun.exe" ||
    basename === "electron" ||
    basename === "electron.exe"
  );
}

function hasScriptPathToken(command: string, scriptName: string): boolean {
  const scriptPattern = `${scriptName}(?:\\.(?:cmd|exe|ps1))?`;
  return new RegExp(
    `(?:^|\\s)(?:"[^"]*[/\\\\]${scriptPattern}|[^\\s"']*[/\\\\]${scriptPattern})(?=$|[\\s"'])`,
    "iu",
  ).test(command);
}

function isCafeCodeServerExecutable(command: string): boolean {
  const basename = executableBasename(command);
  return (
    basename === "cafe-code-server" ||
    basename === "cafe-code-server.exe" ||
    basename === "cafe-code-server.cmd" ||
    basename === "cafe-code-server.ps1"
  );
}

function isCafeCodeLauncherExecutable(command: string): boolean {
  const basename = executableBasename(command);
  return (
    basename === "cafe-code" ||
    basename === "cafe-code.exe" ||
    basename === "cafe-code.cmd" ||
    basename === "cafe-code.ps1" ||
    basename === "cafe-code.appimage"
  );
}

function isCafeCodeWindowsAppExecutable(command: string): boolean {
  const basename = executableBasename(command).replace(/\.exe$/iu, "");
  return (
    basename === "cafe code" ||
    basename === "cafe code alpha" ||
    basename === "cafe code nightly" ||
    basename === "cafe code dev" ||
    /^cafe code \((?:alpha|nightly|dev)\)$/iu.test(basename)
  );
}

function matchesServerEntrypointPath(command: string): boolean {
  const lower = normalizeCommand(command).toLowerCase();
  return (
    lower.includes("/@cafeai/cafe-code/dist/bin.mjs") ||
    lower.includes("/app.asar/apps/server/dist/bin.mjs") ||
    ((lower.includes("/apps/server/dist/bin.mjs") || lower.includes("/apps/server/src/bin.ts")) &&
      hasCafeCodeHint(command))
  );
}

function matchesLauncherEntrypointPath(command: string): boolean {
  const lower = normalizeCommand(command).toLowerCase();
  return (
    lower.includes("/@cafeai/cafe-code/dist/launcher.mjs") ||
    lower.includes("/apps/server/src/launcher.ts") ||
    ((lower.includes("/apps/desktop/scripts/start-electron.mjs") ||
      lower.includes("/apps/desktop/scripts/dev-electron.mjs") ||
      lower.includes("/dist/apps/desktop/scripts/start-electron.mjs")) &&
      hasCafeCodeHint(command))
  );
}

function matchesProviderRuntimeCommand(command: string): boolean {
  const lower = normalizeCommand(command).toLowerCase();
  return (
    matchesServerEntrypointPath(command) &&
    /\sprovider-(?:daemon|supervisor)(?:\s|$)/u.test(` ${lower}`) &&
    lower.includes("--bootstrap-fd")
  );
}

function matchesServerCommand(command: string): boolean {
  return (
    matchesServerEntrypointPath(command) ||
    isCafeCodeServerExecutable(command) ||
    (isNodeLikeExecutable(command) && hasScriptPathToken(command, "cafe-code-server"))
  );
}

function matchesDesktopClientCommand(command: string): boolean {
  const lower = normalizeCommand(command).toLowerCase();
  return (
    (lower.includes("dist-electron/main.cjs") &&
      (hasCafeCodeHint(command) || isNodeLikeExecutable(command))) ||
    (lower.includes(".app/contents/macos/") && hasCafeCodeHint(command)) ||
    isCafeCodeWindowsAppExecutable(command)
  );
}

function matchesLauncherCommand(command: string): boolean {
  return (
    matchesLauncherEntrypointPath(command) ||
    isCafeCodeLauncherExecutable(command) ||
    (isNodeLikeExecutable(command) && hasScriptPathToken(command, "cafe-code"))
  );
}

export function classifyCafeKillallProcess(
  processSnapshot: CafeKillallProcessSnapshot,
): CafeKillallProcessRole | null {
  const { command } = processSnapshot;
  if (matchesProviderRuntimeCommand(command)) {
    return "provider-runtime";
  }
  if (matchesServerCommand(command)) {
    return "server";
  }
  if (matchesDesktopClientCommand(command)) {
    return "desktop-client";
  }
  if (matchesLauncherCommand(command)) {
    return "launcher";
  }
  return null;
}

function protectedPidSet(
  processes: ReadonlyArray<CafeKillallProcessSnapshot>,
  currentPid: number,
  currentParentPid: number,
): ReadonlySet<number> {
  const byPid = new Map(processes.map((processSnapshot) => [processSnapshot.pid, processSnapshot]));
  const protectedPids = new Set<number>([currentPid]);
  let cursor = byPid.get(currentPid)?.ppid ?? currentParentPid;

  while (cursor > 0 && !protectedPids.has(cursor)) {
    protectedPids.add(cursor);
    cursor = byPid.get(cursor)?.ppid ?? 0;
  }

  return protectedPids;
}

function processDepth(
  processSnapshot: CafeKillallProcessSnapshot,
  byPid: ReadonlyMap<number, CafeKillallProcessSnapshot>,
): number {
  let depth = 0;
  let cursor = processSnapshot.ppid;
  const visited = new Set<number>([processSnapshot.pid]);
  while (cursor > 0 && !visited.has(cursor)) {
    const parent = byPid.get(cursor);
    if (parent === undefined) {
      break;
    }
    visited.add(cursor);
    depth += 1;
    cursor = parent.ppid;
  }
  return depth;
}

export function selectCafeKillallTargets(
  processes: ReadonlyArray<CafeKillallProcessSnapshot>,
  options: {
    readonly currentPid?: number;
    readonly currentParentPid?: number;
  } = {},
): ReadonlyArray<CafeKillallProcessTarget> {
  const currentPid = options.currentPid ?? process.pid;
  const currentParentPid = options.currentParentPid ?? process.ppid;
  const protectedPids = protectedPidSet(processes, currentPid, currentParentPid);
  const byPid = new Map(processes.map((processSnapshot) => [processSnapshot.pid, processSnapshot]));

  return processes
    .flatMap((processSnapshot) => {
      if (processSnapshot.pid <= 0 || protectedPids.has(processSnapshot.pid)) {
        return [];
      }
      const role = classifyCafeKillallProcess(processSnapshot);
      return role === null ? [] : [{ ...processSnapshot, role }];
    })
    .toSorted((left, right) => {
      const depthDelta = processDepth(right, byPid) - processDepth(left, byPid);
      return depthDelta !== 0 ? depthDelta : left.pid - right.pid;
    });
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const waitForPidExit = (pid: number, timeoutMs: number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    while ((yield* Clock.currentTimeMillis) - startedAt < timeoutMs) {
      if (!isPidAlive(pid)) {
        return true;
      }
      yield* Effect.sleep(Duration.millis(50));
    }
    return !isPidAlive(pid);
  });

function signalPid(pid: number, signal: NodeJS.Signals): string | null {
  try {
    process.kill(pid, signal);
    return null;
  } catch (cause) {
    return errorMessage(cause);
  }
}

export const terminateCafeKillallTarget = (
  target: CafeKillallProcessTarget,
  options: {
    readonly terminateGraceMs?: number;
    readonly killGraceMs?: number;
  } = {},
): Effect.Effect<CafeKillallTerminationResult> =>
  Effect.gen(function* () {
    const terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    if (target.pid <= 0 || target.pid === process.pid) {
      return {
        ...target,
        signalSent: false,
        escalated: false,
        stillAlive: isPidAlive(target.pid),
        error: null,
      };
    }
    if (!isPidAlive(target.pid)) {
      return {
        ...target,
        signalSent: false,
        escalated: false,
        stillAlive: false,
        error: null,
      };
    }

    const terminateError = signalPid(target.pid, "SIGTERM");
    if (terminateError !== null) {
      return {
        ...target,
        signalSent: false,
        escalated: false,
        stillAlive: isPidAlive(target.pid),
        error: terminateError,
      };
    }
    if (yield* waitForPidExit(target.pid, terminateGraceMs)) {
      return {
        ...target,
        signalSent: true,
        escalated: false,
        stillAlive: false,
        error: null,
      };
    }

    const killError = signalPid(target.pid, "SIGKILL");
    if (killError !== null) {
      return {
        ...target,
        signalSent: true,
        escalated: true,
        stillAlive: isPidAlive(target.pid),
        error: killError,
      };
    }

    return {
      ...target,
      signalSent: true,
      escalated: true,
      stillAlive: !(yield* waitForPidExit(target.pid, killGraceMs)),
      error: null,
    };
  });

function formatTargetLine(target: CafeKillallProcessTarget): string {
  return `pid=${target.pid} ppid=${target.ppid} role=${target.role}`;
}

function formatResultLine(result: CafeKillallTerminationResult): string {
  const status = result.error
    ? `error=${result.error}`
    : result.stillAlive
      ? "still-alive"
      : result.escalated
        ? "killed"
        : result.signalSent
          ? "terminated"
          : "already-exited";
  return `${formatTargetLine(result)} status=${status}`;
}

function formatKillallOutput(input: {
  readonly dryRun: boolean;
  readonly targets: ReadonlyArray<CafeKillallProcessTarget>;
  readonly results: ReadonlyArray<CafeKillallTerminationResult>;
}): string {
  if (input.targets.length === 0) {
    return "No Cafe Code client/server processes found.";
  }

  if (input.dryRun) {
    return [
      `Cafe Code killall dry run: ${input.targets.length} process(es) would be terminated.`,
      ...input.targets.map(formatTargetLine),
    ].join("\n");
  }

  const failedCount = input.results.filter(
    (result) => result.error !== null || result.stillAlive,
  ).length;
  return [
    `Cafe Code killall targeted ${input.results.length} process(es); ${failedCount} failed or remained alive.`,
    ...input.results.map(formatResultLine),
  ].join("\n");
}

export const runKillallCommand = (flags: { readonly dryRun: boolean }) =>
  Effect.gen(function* () {
    const processes = yield* listCafeKillallProcesses();
    const targets = selectCafeKillallTargets(processes);
    const results = flags.dryRun
      ? []
      : yield* Effect.forEach(targets, (target) => terminateCafeKillallTarget(target), {
          concurrency: 1,
        });
    yield* Console.log(formatKillallOutput({ dryRun: flags.dryRun, targets, results }));
  });

const dryRunFlag = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Print matching Cafe Code processes without signaling them."),
  Flag.withDefault(false),
);

export const killallCommand = Command.make("killall", {
  dryRun: dryRunFlag,
}).pipe(
  Command.withDescription("Terminate running Cafe Code desktop, server, and provider processes."),
  Command.withHandler((flags) => runKillallCommand(flags)),
);
