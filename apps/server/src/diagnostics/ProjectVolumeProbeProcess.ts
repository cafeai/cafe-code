// @effect-diagnostics nodeBuiltinImport:off globalTimers:off

import { spawn, type ChildProcess } from "node:child_process";

import type { ProjectVolumeCounters, ProjectVolumeReader } from "./ProjectVolumeTelemetry.ts";

const MAX_PROBE_OUTPUT_BYTES = 4_096;
const MAX_PROBE_TIMEOUT_MS = 60_000;
const PARENT_KILL_GRACE_MS = 2_000;
const SHUTDOWN_CLOSE_GRACE_MS = 1_000;
const PROBE_FAILURE_MESSAGE = "Project-volume probe failed.";
const ALLOWED_ENVIRONMENT_NAMES = new Set([
  "appdir",
  "appimage",
  // Packaged AppImage/macOS helpers may need their loader search path.
  "dyld_fallback_library_path",
  "dyld_library_path",
  "ld_library_path",
  "path",
  "systemroot",
  "temp",
  "tmp",
  "tmpdir",
  "windir",
]);

// The authoritative workspace root is supplied over stdin rather than argv so
// it is not exposed in process listings. The helper emits counters only; raw
// filesystem errors and the workspace path never cross back to the server.
//
// statfs runs asynchronously in the isolated process. Its libuv filesystem
// pool is not shared with the server, while the child-owned deadline remains
// able to terminate the helper even if the parent disappears.
const PROJECT_VOLUME_PROBE_SCRIPT = String.raw`
const fs = require("node:fs");
let deadline;
try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.workspaceRoot !== "string" ||
    input.workspaceRoot.length === 0 ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0
  ) {
    throw new Error("invalid input");
  }
  deadline = setTimeout(() => process.exit(1), input.timeoutMs);
  fs.promises.statfs(input.workspaceRoot, { bigint: true }).then(
    (stats) => {
      clearTimeout(deadline);
      process.stdout.write(JSON.stringify([
        stats.bsize.toString(),
        stats.blocks.toString(),
        stats.bfree.toString(),
        stats.bavail.toString()
      ]));
    },
    () => {
      clearTimeout(deadline);
      process.exitCode = 1;
    }
  );
} catch {
  if (deadline !== undefined) clearTimeout(deadline);
  process.exitCode = 1;
}
`;

export interface ProjectVolumeProbeProcessShape extends ProjectVolumeReader {
  readonly close: () => Promise<void>;
}

interface ProjectVolumeProbeProcessTestOptions {
  /** Test-only script override for exercising process lifecycle behavior. */
  readonly probeScript?: string;
  /** Test-only shutdown deadline override. */
  readonly shutdownCloseGraceMs?: number;
  /** Test-only parent fallback grace override. */
  readonly parentKillGraceMs?: number;
  /** Test-only kill override for exercising an unresponsive child. */
  readonly killProcess?: (child: ChildProcess) => boolean;
}

export function buildProjectVolumeProbeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && ALLOWED_ENVIRONMENT_NAMES.has(name.toLowerCase())) {
      environment[name] = value;
    }
  }
  // `process.execPath` is Electron in packaged desktop builds. This flag makes
  // that executable run the fixed helper as Node on every target platform.
  environment.ELECTRON_RUN_AS_NODE = "1";
  return environment;
}

function probeFailure(): Error {
  return new Error(PROBE_FAILURE_MESSAGE);
}

function parseProbeOutput(output: string): ProjectVolumeCounters {
  const parsed: unknown = JSON.parse(output);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed.some((value) => typeof value !== "string" || !/^\d+$/.test(value))
  ) {
    throw probeFailure();
  }
  return {
    blockSize: BigInt(parsed[0] as string),
    blocks: BigInt(parsed[1] as string),
    freeBlocks: BigInt(parsed[2] as string),
    availableBlocks: BigInt(parsed[3] as string),
  };
}

/**
 * Create a bounded owner for disposable project-volume helper processes.
 *
 * Each read gets its own process so a blocked network/mapped volume cannot
 * consume the server's shared libuv filesystem pool. Admission is released
 * only by the child's `close` event. `close()` requests termination for every
 * still-live helper during service shutdown, but returns after its bounded
 * shutdown grace even if the OS has not released an uninterruptible child.
 */
function makeProjectVolumeProbeProcessWithOptions(
  options: ProjectVolumeProbeProcessTestOptions = {},
): ProjectVolumeProbeProcessShape {
  const children = new Set<ChildProcess>();
  const childClosed = new Map<ChildProcess, Promise<void>>();
  const shutdownCloseGraceMs =
    options.shutdownCloseGraceMs !== undefined &&
    Number.isSafeInteger(options.shutdownCloseGraceMs) &&
    options.shutdownCloseGraceMs > 0
      ? options.shutdownCloseGraceMs
      : SHUTDOWN_CLOSE_GRACE_MS;
  const parentKillGraceMs =
    options.parentKillGraceMs !== undefined &&
    Number.isSafeInteger(options.parentKillGraceMs) &&
    options.parentKillGraceMs > 0 &&
    options.parentKillGraceMs <= MAX_PROBE_TIMEOUT_MS
      ? options.parentKillGraceMs
      : PARENT_KILL_GRACE_MS;
  const killProcess = options.killProcess ?? ((child: ChildProcess) => child.kill("SIGKILL"));
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const requestKill = (child: ChildProcess): boolean => {
    try {
      return killProcess(child);
    } catch {
      return false;
    }
  };

  const read: ProjectVolumeProbeProcessShape["read"] = (workspaceRoot, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (
        closed ||
        typeof workspaceRoot !== "string" ||
        workspaceRoot.length === 0 ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > MAX_PROBE_TIMEOUT_MS
      ) {
        reject(probeFailure());
        return;
      }

      let child: ChildProcess;
      try {
        child = spawn(
          process.execPath,
          ["--eval", options.probeScript ?? PROJECT_VOLUME_PROBE_SCRIPT],
          {
            env: buildProjectVolumeProbeEnvironment(process.env),
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          },
        );
      } catch {
        reject(probeFailure());
        return;
      }
      let output = "";
      let failed = false;
      let settled = false;
      let parentKillDeadline: ReturnType<typeof setTimeout> | undefined;
      let signalClosed: (() => void) | undefined;
      children.add(child);
      childClosed.set(
        child,
        new Promise<void>((resolveClosed) => {
          signalClosed = resolveClosed;
        }),
      );

      const settle = (result: { readonly ok: true } | { readonly ok: false }) => {
        if (settled) return;
        settled = true;
        if (parentKillDeadline !== undefined) {
          clearTimeout(parentKillDeadline);
        }
        children.delete(child);
        childClosed.delete(child);
        signalClosed?.();
        if (!result.ok) {
          reject(probeFailure());
          return;
        }
        try {
          resolve(parseProbeOutput(output));
        } catch {
          reject(probeFailure());
        }
      };

      // Register process lifecycle handlers before touching stdio. Node can
      // return a ChildProcess with null streams for EMFILE/ENFILE and emit its
      // spawn error on the next tick.
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (exitCode) => {
        settle({ ok: !failed && exitCode === 0 });
      });

      if (!child.stdin || !child.stdout || !child.stderr) {
        failed = true;
        requestKill(child);
        return;
      }

      // The child owns the functional timeout. This later parent deadline is
      // a cold-start-tolerant kill fallback; the promise still settles
      // exclusively on close.
      parentKillDeadline = setTimeout(() => {
        failed = true;
        requestKill(child);
      }, timeoutMs + parentKillGraceMs);

      try {
        child.stderr.on("error", () => {
          failed = true;
          requestKill(child);
        });
        child.stderr.resume();
        child.stdout.on("error", () => {
          failed = true;
          requestKill(child);
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (failed) return;
          output += chunk;
          if (Buffer.byteLength(output, "utf8") > MAX_PROBE_OUTPUT_BYTES) {
            failed = true;
            requestKill(child);
          }
        });
        child.stdin.on("error", () => {
          failed = true;
          requestKill(child);
        });
        child.stdin.end(JSON.stringify({ workspaceRoot, timeoutMs }), "utf8");
      } catch {
        failed = true;
        requestKill(child);
      }
    });

  const close = () => {
    if (closePromise) {
      return closePromise;
    }
    closed = true;
    closePromise = (async () => {
      const pendingClose = [...children].map(
        (child) => childClosed.get(child) ?? Promise.resolve(),
      );
      for (const child of children) {
        requestKill(child);
      }
      if (pendingClose.length === 0) {
        return;
      }
      let shutdownDeadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(pendingClose).finally(() => {
          if (shutdownDeadline !== undefined) {
            clearTimeout(shutdownDeadline);
          }
        }),
        new Promise<void>((resolve) => {
          shutdownDeadline = setTimeout(resolve, shutdownCloseGraceMs);
        }),
      ]);
    })();
    return closePromise;
  };

  return { read, close };
}

export function makeProjectVolumeProbeProcess(): ProjectVolumeProbeProcessShape {
  return makeProjectVolumeProbeProcessWithOptions();
}

/**
 * Test-only process seam. Production callers cannot supply an alternate
 * script or kill implementation through `makeProjectVolumeProbeProcess`.
 */
export function makeProjectVolumeProbeProcessForTest(
  options: ProjectVolumeProbeProcessTestOptions,
): ProjectVolumeProbeProcessShape {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Project-volume probe test overrides are unavailable.");
  }
  return makeProjectVolumeProbeProcessWithOptions(options);
}
