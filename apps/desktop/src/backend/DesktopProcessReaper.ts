// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";

import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export interface DesktopProcessSnapshot {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

export interface DesktopProcessTerminationResult extends DesktopProcessSnapshot {
  readonly signalSent: boolean;
  readonly escalated: boolean;
  readonly stillAlive: boolean;
  readonly error: string | null;
}

const PS_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_TERMINATE_GRACE_MS = 750;
const DEFAULT_KILL_GRACE_MS = 750;

class DesktopProcessReaperError extends Data.TaggedError("DesktopProcessReaperError")<{
  readonly cause: unknown;
}> {}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function parseUnixProcessList(output: string): ReadonlyArray<DesktopProcessSnapshot> {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
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

export const listUnixProcesses = Effect.tryPromise({
  try: () =>
    new Promise<ReadonlyArray<DesktopProcessSnapshot>>((resolve, reject) => {
      execFile(
        "ps",
        ["-axo", "pid=,ppid=,command="],
        { maxBuffer: PS_MAX_BUFFER_BYTES },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(parseUnixProcessList(stdout));
        },
      );
    }),
  catch: (cause) => new DesktopProcessReaperError({ cause }),
}).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<DesktopProcessSnapshot>)));

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProviderRuntimeCommand(command: string, backendEntryPath: string): boolean {
  return (
    command.includes(backendEntryPath) &&
    /\sprovider-(?:daemon|supervisor)(?:\s|$)/.test(command) &&
    command.includes("--bootstrap-fd")
  );
}

function isDesktopBackendCommand(command: string, backendEntryPath: string): boolean {
  return (
    command.includes(backendEntryPath) &&
    command.includes("--bootstrap-fd") &&
    !isProviderRuntimeCommand(command, backendEntryPath)
  );
}

export function matchesProviderRuntimeProcess(
  processSnapshot: DesktopProcessSnapshot,
  backendEntryPath: string,
): boolean {
  return isProviderRuntimeCommand(processSnapshot.command, backendEntryPath);
}

export function matchesDesktopBackendProcess(
  processSnapshot: DesktopProcessSnapshot,
  backendEntryPath: string,
): boolean {
  return isDesktopBackendCommand(processSnapshot.command, backendEntryPath);
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

export const terminatePid = (
  processSnapshot: DesktopProcessSnapshot,
  options: {
    readonly terminateGraceMs?: number;
    readonly killGraceMs?: number;
  } = {},
): Effect.Effect<DesktopProcessTerminationResult> =>
  Effect.gen(function* () {
    const terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    if (processSnapshot.pid <= 0 || processSnapshot.pid === process.pid) {
      return {
        ...processSnapshot,
        signalSent: false,
        escalated: false,
        stillAlive: isPidAlive(processSnapshot.pid),
        error: null,
      };
    }
    if (!isPidAlive(processSnapshot.pid)) {
      return {
        ...processSnapshot,
        signalSent: false,
        escalated: false,
        stillAlive: false,
        error: null,
      };
    }

    const terminateError = signalPid(processSnapshot.pid, "SIGTERM");
    if (terminateError !== null) {
      return {
        ...processSnapshot,
        signalSent: false,
        escalated: false,
        stillAlive: isPidAlive(processSnapshot.pid),
        error: terminateError,
      };
    }
    if (yield* waitForPidExit(processSnapshot.pid, terminateGraceMs)) {
      return {
        ...processSnapshot,
        signalSent: true,
        escalated: false,
        stillAlive: false,
        error: null,
      };
    }

    const killError = signalPid(processSnapshot.pid, "SIGKILL");
    if (killError !== null) {
      return {
        ...processSnapshot,
        signalSent: true,
        escalated: true,
        stillAlive: isPidAlive(processSnapshot.pid),
        error: killError,
      };
    }

    return {
      ...processSnapshot,
      signalSent: true,
      escalated: true,
      stillAlive: !(yield* waitForPidExit(processSnapshot.pid, killGraceMs)),
      error: null,
    };
  });

export const reapMatchingUnixProcesses = (input: {
  readonly keepPids: ReadonlySet<number>;
  readonly matches: (processSnapshot: DesktopProcessSnapshot) => boolean;
}): Effect.Effect<ReadonlyArray<DesktopProcessTerminationResult>> =>
  Effect.gen(function* () {
    if (process.platform === "win32") {
      return [];
    }
    const processes = yield* listUnixProcesses;
    const staleProcesses = processes.filter(
      (processSnapshot) =>
        processSnapshot.pid !== process.pid &&
        !input.keepPids.has(processSnapshot.pid) &&
        input.matches(processSnapshot),
    );
    return yield* Effect.forEach(
      staleProcesses,
      (processSnapshot) => terminatePid(processSnapshot),
      {
        concurrency: 1,
      },
    );
  });
