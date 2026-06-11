// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import * as fs from "node:fs/promises";
import * as inspector from "node:inspector";
import * as path from "node:path";

import type { Profiler } from "node:inspector";

const STARTUP_PROFILE_ENABLED_ENV = "CAFE_CODE_STARTUP_PROFILE";
const STARTUP_PROFILE_DIR_ENV = "CAFE_CODE_STARTUP_PROFILE_DIR";
const STARTUP_PROFILE_STOP_FILE_ENV = "CAFE_CODE_STARTUP_PROFILE_STOP_FILE";
const STARTUP_PROFILE_TIMEOUT_MS_ENV = "CAFE_CODE_STARTUP_PROFILE_TIMEOUT_MS";
const STARTUP_PROFILE_ROLES_ENV = "CAFE_CODE_STARTUP_PROFILE_ROLES";
const STARTUP_PROFILE_INTERVAL_US_ENV = "CAFE_CODE_STARTUP_PROFILE_INTERVAL_US";

const DEFAULT_STARTUP_PROFILE_TIMEOUT_MS = 20_000;
const DEFAULT_STARTUP_PROFILE_INTERVAL_US = 1_000;
const STOP_FILE_POLL_INTERVAL_MS = 250;

export interface StartupCpuProfilerOptions {
  readonly role: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface StartupCpuProfilerController {
  readonly enabled: boolean;
  readonly role: string;
  readonly stop: (reason: string) => Promise<string | undefined>;
}

interface StartupProfileMetadata {
  readonly role: string;
  readonly pid: number;
  readonly ppid: number;
  readonly reason: string;
  readonly startedAt: string;
  readonly stoppedAt: string;
  readonly durationMs: number;
  readonly cwd: string;
  readonly execPath: string;
  readonly argv: readonly string[];
}

const disabledController: StartupCpuProfilerController = {
  enabled: false,
  role: "disabled",
  stop: async () => undefined,
};

let activeController: StartupCpuProfilerController | undefined;

function isEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function roleIsEnabled(role: string, rawRoles: string | undefined): boolean {
  if (rawRoles === undefined || rawRoles.trim().length === 0) return true;
  const roles = rawRoles
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return roles.length === 0 || roles.includes(role) || roles.includes("*");
}

function sanitizeFilePart(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function writeProfilerWarning(message: string, cause?: unknown): void {
  const detail =
    cause instanceof Error ? `: ${cause.message}` : cause === undefined ? "" : `: ${String(cause)}`;
  process.stderr.write(`[startup-profiler] ${message}${detail}\n`);
}

function postInspector(method: "Profiler.enable", session: inspector.Session): Promise<void>;
function postInspector(
  method: "Profiler.setSamplingInterval",
  session: inspector.Session,
  params: Profiler.SetSamplingIntervalParameterType,
): Promise<void>;
function postInspector(method: "Profiler.start", session: inspector.Session): Promise<void>;
function postInspector(
  method: "Profiler.stop",
  session: inspector.Session,
): Promise<Profiler.StopReturnType>;
function postInspector(
  method: "Profiler.enable" | "Profiler.setSamplingInterval" | "Profiler.start" | "Profiler.stop",
  session: inspector.Session,
  params?: Profiler.SetSamplingIntervalParameterType,
): Promise<void | Profiler.StopReturnType> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, result?: Profiler.StopReturnType) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };

    if (params === undefined) {
      session.post(method as "Profiler.enable", callback);
      return;
    }

    session.post(method as "Profiler.setSamplingInterval", params, callback);
  });
}

async function writeCpuProfile(input: {
  readonly directory: string;
  readonly role: string;
  readonly reason: string;
  readonly profile: Profiler.Profile;
  readonly startedAtMs: number;
  readonly startedAt: Date;
}): Promise<string> {
  const stoppedAt = new Date();
  const safeRole = sanitizeFilePart(input.role);
  const safeReason = sanitizeFilePart(input.reason);
  const baseName = `${safeRole}-${process.pid}-${timestampForFile(input.startedAt)}-${safeReason}`;
  const profilePath = path.join(input.directory, `${baseName}.cpuprofile`);
  const metadataPath = path.join(input.directory, `${baseName}.meta.json`);
  const metadata: StartupProfileMetadata = {
    role: input.role,
    pid: process.pid,
    ppid: process.ppid,
    reason: input.reason,
    startedAt: input.startedAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    durationMs: Math.round((Date.now() - input.startedAtMs) * 100) / 100,
    cwd: process.cwd(),
    execPath: process.execPath,
    argv: process.argv.slice(0, 8),
  };

  await fs.mkdir(input.directory, { recursive: true });
  await fs.writeFile(profilePath, JSON.stringify(input.profile), { mode: 0o600 });
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return profilePath;
}

export function startStartupCpuProfiler(
  options: StartupCpuProfilerOptions,
): StartupCpuProfilerController {
  if (activeController !== undefined) {
    return activeController;
  }

  const env = options.env ?? process.env;
  const role = options.role;
  const directory = env[STARTUP_PROFILE_DIR_ENV];
  if (
    !isEnabled(env[STARTUP_PROFILE_ENABLED_ENV]) ||
    directory === undefined ||
    directory.trim().length === 0 ||
    !roleIsEnabled(role, env[STARTUP_PROFILE_ROLES_ENV])
  ) {
    activeController = {
      ...disabledController,
      role,
    };
    return activeController;
  }

  const session = new inspector.Session();
  const startedAt = new Date();
  const startedAtMs = Date.now();
  const intervalUs = parsePositiveInteger(
    env[STARTUP_PROFILE_INTERVAL_US_ENV],
    DEFAULT_STARTUP_PROFILE_INTERVAL_US,
  );
  const timeoutMs = parsePositiveInteger(
    env[STARTUP_PROFILE_TIMEOUT_MS_ENV],
    DEFAULT_STARTUP_PROFILE_TIMEOUT_MS,
  );

  let stopTimer: NodeJS.Timeout | undefined;
  let stopFilePoller: NodeJS.Timeout | undefined;
  let started = false;
  let stopPromise: Promise<string | undefined> | undefined;

  const startPromise = (async () => {
    await fs.mkdir(directory, { recursive: true });
    session.connect();
    await postInspector("Profiler.enable", session);
    await postInspector("Profiler.setSamplingInterval", session, { interval: intervalUs });
    await postInspector("Profiler.start", session);
    started = true;
  })().catch((cause) => {
    writeProfilerWarning(`failed to start CPU profiler for ${role}`, cause);
  });

  const cleanup = () => {
    if (stopTimer !== undefined) {
      clearTimeout(stopTimer);
      stopTimer = undefined;
    }
    if (stopFilePoller !== undefined) {
      clearInterval(stopFilePoller);
      stopFilePoller = undefined;
    }
  };

  const stop = (reason: string): Promise<string | undefined> => {
    if (stopPromise !== undefined) return stopPromise;

    stopPromise = (async () => {
      cleanup();
      await startPromise;
      if (!started) return undefined;

      try {
        const result = await postInspector("Profiler.stop", session);
        const profilePath = await writeCpuProfile({
          directory,
          role,
          reason,
          profile: result.profile,
          startedAtMs,
          startedAt,
        });
        process.stderr.write(`[startup-profiler] wrote ${role} CPU profile to ${profilePath}\n`);
        return profilePath;
      } catch (cause) {
        writeProfilerWarning(`failed to stop CPU profiler for ${role}`, cause);
        return undefined;
      } finally {
        try {
          session.disconnect();
        } catch {
          // The inspector session may already be closed during process shutdown.
        }
      }
    })();

    return stopPromise;
  };

  stopTimer = setTimeout(() => {
    void stop(`timeout-${timeoutMs}ms`);
  }, timeoutMs);
  stopTimer.unref();

  const stopFile = env[STARTUP_PROFILE_STOP_FILE_ENV];
  if (stopFile !== undefined && stopFile.trim().length > 0) {
    stopFilePoller = setInterval(() => {
      void fs
        .access(stopFile)
        .then(() => stop("stop-file"))
        .catch(() => undefined);
    }, STOP_FILE_POLL_INTERVAL_MS);
    stopFilePoller.unref();
  }

  activeController = {
    enabled: true,
    role,
    stop,
  };
  return activeController;
}

export function stopStartupCpuProfiler(reason: string): Promise<string | undefined> {
  return (activeController ?? disabledController).stop(reason);
}
