// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as path from "node:path";

import {
  PROVIDER_DAEMON_HEALTH_PATH,
  PROVIDER_DAEMON_LEASES_PATH,
  PROVIDER_DAEMON_LIVENESS_PATH,
  ProviderDaemonBootstrap,
  ProviderDaemonHealth,
  ProviderDaemonLeaseRequest,
  ProviderDaemonLeaseResponse,
  ProviderDaemonLiveness,
  ProviderDaemonMarker,
  type ProviderDaemonClientConfig,
  type ProviderDaemonHealth as ProviderDaemonHealthValue,
  type ProviderDaemonLeaseResponse as ProviderDaemonLeaseResponseValue,
  type ProviderDaemonLiveness as ProviderDaemonLivenessValue,
  type ProviderDaemonMarker as ProviderDaemonMarkerValue,
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import { CAFE_CODE_SHELL_ENV_HYDRATED } from "@cafecode/shared/shell";
import {
  BACKEND_STARTUP_PROGRESS_FD,
  makeProviderDaemonStartupProgressTracker,
  type ProviderDaemonStartupProgress,
} from "@cafecode/shared/backendStartupProgress";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { performance } from "node:perf_hooks";

import * as DesktopDebugServer from "../debug/DesktopDebugServer.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { makeWindowsDesktopProviderDaemonManager } from "./WindowsDesktopProviderDaemonManager.ts";
import * as NetService from "@cafecode/shared/Net";
import {
  isPidAlive,
  matchesProviderRuntimeProcess,
  reapMatchingUnixProcesses,
  terminatePid as terminateDesktopPid,
  type DesktopProcessSnapshot,
} from "./DesktopProcessReaper.ts";

const PROVIDER_DAEMON_READINESS_TIMEOUT_MS = 30_000;
const PROVIDER_DAEMON_READINESS_INTERVAL_MS = 100;
const PROVIDER_DAEMON_PROTOCOL_VERSION = 1;
const PROVIDER_DAEMON_SPAWN_ATTEMPTS = 2;
// Each HTTP observation already has a five-second deadline. One retry absorbs
// a short SQLite/transport stall while keeping adoption below startup's budget.
const PROVIDER_DAEMON_ADOPTION_RETRY_DELAY_MS = 250;

const DESKTOP_PROVIDER_DAEMON_ENV_NAMES = [
  "CAFE_CODE_PORT",
  "CAFE_CODE_MODE",
  "CAFE_CODE_NO_BROWSER",
  "CAFE_CODE_HOST",
  "CAFE_CODE_DEV_URL",
  "CAFE_CODE_DESKTOP_DEV",
  "CAFE_CODE_DESKTOP_WS_URL",
  "CAFE_CODE_DESKTOP_LAN_ACCESS",
  "CAFE_CODE_DESKTOP_LAN_HOST",
  "CAFE_CODE_DESKTOP_HTTPS_ENDPOINTS",
  "VITE_DEV_SERVER_URL",
] as const;

const providerDaemonChildEnvPatch = (): Record<string, string | undefined> =>
  Object.fromEntries(DESKTOP_PROVIDER_DAEMON_ENV_NAMES.map((name) => [name, undefined] as const));

const encodeProviderDaemonBootstrapJson = Schema.encodeEffect(
  Schema.fromJsonString(ProviderDaemonBootstrap),
);
const encodeProviderDaemonMarkerJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonMarker),
);
const decodeProviderDaemonMarkerJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProviderDaemonMarker),
);
const encodeProviderDaemonLeaseRequestJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonLeaseRequest),
);
const decodeProviderDaemonLeaseResponseJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonLeaseResponse),
);
const decodeProviderDaemonHealthJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonHealth),
);
const decodeProviderDaemonLivenessJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonLiveness),
);

export interface DesktopProviderDaemonSnapshot {
  readonly status: "idle" | "starting" | "running" | "error";
  readonly pid: Option.Option<number>;
  readonly endpoint: Option.Option<ProviderDaemonClientConfig>;
  readonly adoptedExistingProcess: boolean;
  readonly lastHealth: Option.Option<ProviderDaemonHealthValue>;
  readonly lastError: Option.Option<string>;
  readonly markerPath: string;
  readonly credentialPath: string;
  readonly runtimeBuildId: string;
  readonly lastEnsureRunningDurationMs: Option.Option<number>;
  readonly lastAdoptionDurationMs: Option.Option<number>;
  readonly lastSpawnDurationMs: Option.Option<number>;
  readonly lastHealthRefreshDurationMs: Option.Option<number>;
  readonly healthRefreshCount: number;
  readonly healthRefreshFailureCount: number;
  readonly recoveryCount: number;
  readonly lastRecoveryAt: Option.Option<string>;
  readonly lastRecoveryReason: Option.Option<string>;
}

export interface DesktopProviderDaemonManagerShape {
  /** Bounded, content-free feedback from the current owned startup attempt. */
  readonly startupProgress?: Stream.Stream<ProviderDaemonStartupProgress>;
  /** Configure the main backend loopback port before daemon adoption/spawn. */
  readonly configureCafeMcpPort?: (port: number) => Effect.Effect<void>;
  readonly ensureRunning: Effect.Effect<ProviderDaemonClientConfig>;
  /**
   * Replace an unhealthy provider daemon and issue a fresh desktop lease.
   * Callers must restart the backend afterward because its lease capability is
   * immutable bootstrap data and is intentionally not shared through globals.
   */
  readonly recover: (
    reason: string,
    expectedOwnershipId?: string,
  ) => Effect.Effect<ProviderDaemonClientConfig>;
  /** Windows only: a PID can remain present after its original owner exits. */
  readonly observeProcessOwnership?: Effect.Effect<{
    readonly status: "same-process" | "different-process" | "exited" | "unknown";
    readonly ownershipId?: string;
  }>;
  readonly currentConfig: Effect.Effect<Option.Option<ProviderDaemonClientConfig>>;
  /**
   * Probe only authenticated process liveness. This path is deliberately
   * independent of provider adapters and SQLite so long-running workload
   * pressure cannot trigger destructive false-positive daemon recovery.
   */
  readonly probeLiveness: Effect.Effect<Option.Option<ProviderDaemonLivenessValue>>;
  readonly refreshHealth: Effect.Effect<Option.Option<ProviderDaemonHealthValue>>;
  readonly snapshot: Effect.Effect<DesktopProviderDaemonSnapshot>;
  readonly stop: Effect.Effect<void>;
}

export class DesktopProviderDaemonManager extends Context.Service<
  DesktopProviderDaemonManager,
  DesktopProviderDaemonManagerShape
>()("cafecode/desktop/ProviderDaemonManager") {}

class ProviderDaemonSpawnError extends Data.TaggedError("ProviderDaemonSpawnError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return this.cause instanceof Error
      ? this.cause.message
      : "Failed to spawn Cafe Code provider daemon.";
  }
}

/** Uncertain child exit is a terminal defect, never an automatic spawn retry. */
export class ProviderDaemonTerminationUnconfirmedError extends Data.TaggedError(
  "ProviderDaemonTerminationUnconfirmedError",
)<{}> {
  override get message() {
    return "Provider daemon exit could not be confirmed; its process and recovery files were preserved. Retry connection.";
  }
}

/**
 * Bound waiting for the actual child exit event, not merely sending a signal.
 * Effect's forceKillAfter wraps signal delivery before its exit wait; it cannot
 * bound a Node child trapped inside synchronous SQLite. Only this exact handle
 * is used, and an uncertain result never authorizes marker cleanup/replacement.
 */
export const stopOwnedProviderDaemonChild = Effect.fn("desktop.providerDaemon.stopOwnedChild")(
  function* (handle: ChildProcessSpawner.ChildProcessHandle): Effect.fn.Return<boolean> {
    const exited = handle.isRunning.pipe(
      Effect.map((running) => !running),
      // A failed observation cannot authorize recovery-file cleanup.
      Effect.catch(() => Effect.succeed(false)),
    );
    if (yield* exited) return true;
    yield* handle
      .kill({ killSignal: "SIGTERM" })
      .pipe(Effect.ignore, Effect.timeoutOption(Duration.seconds(15)));
    if (yield* exited) return true;
    yield* handle
      .kill({ killSignal: "SIGKILL" })
      .pipe(Effect.ignore, Effect.timeoutOption(Duration.seconds(3)));
    return yield* exited;
  },
);

class ProviderDaemonIoError extends Data.TaggedError("ProviderDaemonIoError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return this.cause instanceof Error
      ? `${this.operation}: ${this.cause.message}`
      : `${this.operation}: ${String(this.cause)}`;
  }
}

class ProviderDaemonHealthError extends Data.TaggedError("ProviderDaemonHealthError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

/** Marker contents and filesystem failures may contain paths or capabilities. */
class ProviderDaemonMarkerInspectionError extends Data.TaggedError(
  "ProviderDaemonMarkerInspectionError",
)<{}> {
  override get message() {
    return "Existing provider daemon marker inspection was inconclusive; its files and any running process were preserved. Retry connection.";
  }
}

interface ProviderDaemonState {
  readonly status: "idle" | "starting" | "running" | "error";
  readonly pid: Option.Option<number>;
  readonly endpoint: Option.Option<ProviderDaemonClientConfig>;
  readonly adoptedExistingProcess: boolean;
  readonly terminate: Option.Option<Effect.Effect<void>>;
  /** Retain direct-child exit evidence after a failed startup; never adopt a PID as this handle. */
  readonly ownedChild: Option.Option<ChildProcessSpawner.ChildProcessHandle>;
  readonly lastHealth: Option.Option<ProviderDaemonHealthValue>;
  /** The last successful rich-health observation, independent of liveness publications. */
  readonly lastHealthObservedAt: Option.Option<string>;
  readonly lastError: Option.Option<string>;
  readonly lastEnsureRunningDurationMs: Option.Option<number>;
  readonly lastAdoptionDurationMs: Option.Option<number>;
  readonly lastSpawnDurationMs: Option.Option<number>;
  readonly lastHealthRefreshDurationMs: Option.Option<number>;
  readonly healthRefreshCount: number;
  readonly healthRefreshFailureCount: number;
  readonly recoveryCount: number;
  readonly lastRecoveryAt: Option.Option<string>;
  readonly lastRecoveryReason: Option.Option<string>;
}

const initialState: ProviderDaemonState = {
  status: "idle",
  pid: Option.none(),
  endpoint: Option.none(),
  adoptedExistingProcess: false,
  terminate: Option.none(),
  ownedChild: Option.none(),
  lastHealth: Option.none(),
  lastHealthObservedAt: Option.none(),
  lastError: Option.none(),
  lastEnsureRunningDurationMs: Option.none(),
  lastAdoptionDurationMs: Option.none(),
  lastSpawnDurationMs: Option.none(),
  lastHealthRefreshDurationMs: Option.none(),
  healthRefreshCount: 0,
  healthRefreshFailureCount: 0,
  recoveryCount: 0,
  lastRecoveryAt: Option.none(),
  lastRecoveryReason: Option.none(),
};

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger(
  "desktop-provider-daemon-manager",
);

function isLoopbackEndpoint(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

function makeProviderDaemonToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

const terminateExternalPid = (pid: number): Effect.Effect<void> =>
  terminateDesktopPid({
    pid,
    ppid: 0,
    command: "provider daemon process",
  }).pipe(Effect.asVoid);

const computeProviderDaemonRuntimeBuildId = (
  environment: DesktopEnvironment.DesktopEnvironmentShape,
): Effect.Effect<string, ProviderDaemonSpawnError> =>
  Effect.tryPromise({
    try: async () => {
      const backendBundle = await fs.readFile(environment.backendEntryPath);
      return crypto
        .createHash("sha256")
        .update("cafecode-provider-runtime-v1\0")
        .update(environment.appVersion)
        .update("\0")
        .update(environment.backendEntryPath)
        .update("\0")
        .update(backendBundle)
        .digest("hex");
    },
    catch: (cause) =>
      new ProviderDaemonIoError({ operation: "compute provider daemon runtime build id", cause }),
  }).pipe(Effect.mapError((cause) => new ProviderDaemonSpawnError({ cause })));

function providerDaemonIpcSocketPath(
  environment: DesktopEnvironment.DesktopEnvironmentShape,
): string {
  if (environment.platform === "win32") {
    const suffix = crypto
      .createHash("sha256")
      .update(environment.baseDir)
      .digest("hex")
      .slice(0, 24);
    return `\\\\.\\pipe\\cafecode-provider-daemon-${suffix}`;
  }
  return path.join(environment.providerDaemonIpcDir, "provider-daemon.sock");
}

const prepareProviderDaemonIpcPath = (
  environment: DesktopEnvironment.DesktopEnvironmentShape,
  socketPath: string,
): Effect.Effect<void, ProviderDaemonSpawnError> =>
  Effect.tryPromise({
    try: async () => {
      if (environment.platform === "win32") {
        return;
      }
      await fs.mkdir(environment.providerDaemonIpcDir, { recursive: true, mode: 0o700 });
      await fs.chmod(environment.providerDaemonIpcDir, 0o700);
      await fs.rm(socketPath, { force: true });
    },
    catch: (cause) =>
      new ProviderDaemonIoError({ operation: "prepare provider daemon ipc path", cause }),
  }).pipe(Effect.mapError((cause) => new ProviderDaemonSpawnError({ cause })));

function markerEndpoint(
  marker: ProviderDaemonMarkerValue,
  token: string,
): ProviderDaemonClientConfig {
  return {
    httpBaseUrl: marker.httpBaseUrl,
    transport: marker.transport,
    ...(marker.socketPath !== undefined ? { socketPath: marker.socketPath } : {}),
    token,
  };
}

async function fetchProviderDaemonHealth(
  endpoint: ProviderDaemonClientConfig,
): Promise<ProviderDaemonHealthValue> {
  const response = await requestProviderDaemonJson(endpoint, PROVIDER_DAEMON_HEALTH_PATH, {
    timeoutMs: 5_000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`provider daemon health failed with HTTP ${response.statusCode}`);
  }
  return decodeProviderDaemonHealthJson(response.body);
}

async function fetchProviderDaemonLiveness(
  endpoint: ProviderDaemonClientConfig,
): Promise<ProviderDaemonLivenessValue> {
  const response = await requestProviderDaemonJson(endpoint, PROVIDER_DAEMON_LIVENESS_PATH, {
    timeoutMs: 5_000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`provider daemon liveness failed with HTTP ${response.statusCode}`);
  }
  return decodeProviderDaemonLivenessJson(response.body);
}

async function issueProviderDaemonLease(
  endpoint: ProviderDaemonClientConfig,
): Promise<ProviderDaemonLeaseResponseValue> {
  const response = await requestProviderDaemonJson(endpoint, PROVIDER_DAEMON_LEASES_PATH, {
    method: "POST",
    body: encodeProviderDaemonLeaseRequestJson({
      clientKind: "desktop-main",
      capabilities: ["health", "events", "rpc"],
    }),
    timeoutMs: 5_000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`provider daemon lease failed with HTTP ${response.statusCode}`);
  }
  return decodeProviderDaemonLeaseResponseJson(response.body);
}

const readMarker = (
  markerPath: string,
): Effect.Effect<
  Option.Option<ProviderDaemonMarkerValue>,
  ProviderDaemonMarkerInspectionError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    // Only a conclusive absence permits a fresh spawn. Read/decode failure of
    // an observed marker is not evidence that its daemon exited: falling through
    // would unlink its IPC socket and eventually reap its still-running PID.
    const exists = yield* fileSystem
      .exists(markerPath)
      .pipe(Effect.mapError(() => new ProviderDaemonMarkerInspectionError()));
    if (!exists) {
      return Option.none();
    }
    const raw = yield* fileSystem
      .readFileString(markerPath)
      .pipe(Effect.mapError(() => new ProviderDaemonMarkerInspectionError()));
    return yield* decodeProviderDaemonMarkerJson(raw).pipe(
      Effect.map(Option.some),
      Effect.mapError(() => new ProviderDaemonMarkerInspectionError()),
    );
  });

const writeMarker = (input: {
  readonly markerPath: string;
  readonly marker: ProviderDaemonMarkerValue;
}): Effect.Effect<void, ProviderDaemonSpawnError> =>
  Effect.tryPromise({
    try: async () => {
      const temporaryPath = `${input.markerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(input.markerPath), { recursive: true });
      await fs.writeFile(temporaryPath, `${encodeProviderDaemonMarkerJson(input.marker)}\n`, {
        mode: 0o600,
      });
      await fs.rename(temporaryPath, input.markerPath);
      await fs.chmod(input.markerPath, 0o600);
    },
    catch: (cause) =>
      new ProviderDaemonIoError({ operation: "write provider daemon marker", cause }),
  }).pipe(Effect.mapError((cause) => new ProviderDaemonSpawnError({ cause })));

// Persists the provider daemon token. Encryption is best-effort: the token is
// an ephemeral, random, loopback-scoped secret already protected by the file's
// 0600 mode, so when OS keyring encryption is unavailable (headless sessions,
// locked or competing keyrings, minimal window managers) we degrade to a
// plaintext file rather than fail startup. Returns whether the token was
// encrypted so the marker can record how to read it back.
const writeCredential = (input: {
  readonly credentialPath: string;
  readonly token: string;
}): Effect.Effect<boolean, ProviderDaemonSpawnError, ElectronSafeStorage.ElectronSafeStorage> =>
  Effect.gen(function* () {
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const available = yield* safeStorage.isEncryptionAvailable.pipe(
      Effect.orElseSucceed(() => false),
    );
    let encryptedBytes = Option.none<Uint8Array>();
    if (available) {
      encryptedBytes = yield* safeStorage.encryptString(input.token).pipe(Effect.option);
    }
    const encrypted = Option.isSome(encryptedBytes);
    if (!encrypted) {
      yield* logWarning(
        "os keyring encryption unavailable; storing provider daemon credential unencrypted (file mode 0600)",
        { credentialPath: input.credentialPath, encryptionAvailable: available },
      );
    }
    const payload = Option.match(encryptedBytes, {
      onNone: () => Buffer.from(input.token, "utf8"),
      onSome: (bytes) => Buffer.from(bytes),
    });
    yield* Effect.tryPromise({
      try: async () => {
        const temporaryPath = `${input.credentialPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await fs.mkdir(path.dirname(input.credentialPath), { recursive: true });
        await fs.writeFile(temporaryPath, payload, { mode: 0o600 });
        await fs.rename(temporaryPath, input.credentialPath);
        await fs.chmod(input.credentialPath, 0o600);
      },
      catch: (cause) =>
        new ProviderDaemonIoError({ operation: "write provider daemon credential", cause }),
    }).pipe(Effect.mapError((cause) => new ProviderDaemonSpawnError({ cause })));
    return encrypted;
  });

// Reads the provider daemon token written by `writeCredential`. `encrypted`
// reflects the marker's `credentialEncrypted` flag; a mismatch (or a genuine
// decrypt failure) resolves to `None`, which the caller treats as inconclusive
// and preserves the live owner rather than replacing its credential/process.
const readCredential = (
  credentialPath: string,
  encrypted: boolean,
): Effect.Effect<Option.Option<string>, never, ElectronSafeStorage.ElectronSafeStorage> =>
  Effect.gen(function* () {
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const raw = yield* Effect.tryPromise({
      try: () => fs.readFile(credentialPath),
      catch: (cause) =>
        new ProviderDaemonIoError({ operation: "read provider daemon credential", cause }),
    }).pipe(Effect.option);
    if (Option.isNone(raw)) {
      return Option.none();
    }
    if (!encrypted) {
      return Option.some(raw.value.toString("utf8"));
    }
    return yield* safeStorage.decryptString(raw.value).pipe(Effect.option);
  });

const removeMarker = (markerPath: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => fs.rm(markerPath, { force: true }),
    catch: (cause) =>
      new ProviderDaemonIoError({ operation: "remove provider daemon marker", cause }),
  }).pipe(Effect.ignore);

const removeCredential = (credentialPath: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => fs.rm(credentialPath, { force: true }),
    catch: (cause) =>
      new ProviderDaemonIoError({ operation: "remove provider daemon credential", cause }),
  }).pipe(Effect.ignore);

const removeProviderDaemonIpcSocket = (
  environment: DesktopEnvironment.DesktopEnvironmentShape,
): Effect.Effect<void> => {
  if (environment.platform === "win32") {
    return Effect.void;
  }

  return Effect.tryPromise({
    try: () => fs.rm(providerDaemonIpcSocketPath(environment), { force: true }),
    catch: (cause) =>
      new ProviderDaemonIoError({ operation: "remove provider daemon ipc socket", cause }),
  }).pipe(Effect.ignore);
};

export const waitForOwnedProviderDaemonHealth = (
  endpoint: ProviderDaemonClientConfig,
  progress: ReturnType<typeof makeProviderDaemonStartupProgressTracker>,
  elapsedMs: Effect.Effect<number>,
  handle: ChildProcessSpawner.ChildProcessHandle,
  fetchHealth: typeof fetchProviderDaemonHealth = fetchProviderDaemonHealth,
): Effect.Effect<ProviderDaemonHealthValue, ProviderDaemonSpawnError> =>
  Effect.gen(function* () {
    let lastError: unknown = undefined;
    while ((yield* elapsedMs) < progress.deadlineMs) {
      if (!(yield* handle.isRunning.pipe(Effect.orElseSucceed(() => true)))) break;
      const remainingMs = Math.max(0, progress.deadlineMs - (yield* elapsedMs));
      const healthResult = yield* Effect.tryPromise({
        try: () => fetchHealth(endpoint),
        catch: (cause) => new ProviderDaemonHealthError({ cause }),
      }).pipe(
        Effect.timeout(Duration.millis(remainingMs)),
        Effect.mapError((cause) => new ProviderDaemonHealthError({ cause })),
        Effect.result,
      );
      if (healthResult._tag === "Success" && (yield* elapsedMs) < progress.deadlineMs) {
        return healthResult.success;
      }
      if (healthResult._tag === "Failure") lastError = healthResult.failure;
      if ((yield* elapsedMs) >= progress.deadlineMs) break;
      yield* Effect.sleep(Duration.millis(PROVIDER_DAEMON_READINESS_INTERVAL_MS));
    }
    return yield* new ProviderDaemonSpawnError({
      cause: lastError ?? new Error("Provider daemon did not become ready before timeout."),
    });
  });

const makeDesktopProviderDaemonManager = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  // Keep the established POSIX process groups, file permissions and cleanup
  // untouched. Windows ownership must never fall through to a PID-only kill or
  // the Effect spawner's process-tree finalizer after identity becomes unknown.
  if (environment.platform === "win32") {
    const runtimeBuildId = yield* computeProviderDaemonRuntimeBuildId(environment);
    return yield* makeWindowsDesktopProviderDaemonManager(environment, runtimeBuildId);
  }
  const fileSystem = yield* FileSystem.FileSystem;
  yield* NetService.NetService;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const daemonScope = yield* Scope.make();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const state = yield* Ref.make(initialState);
  const cafeMcpPortRef = yield* Ref.make<number | undefined>(undefined);
  const lifecycleMutex = yield* Semaphore.make(1);
  const startupUpdates = yield* PubSub.sliding<ProviderDaemonStartupProgress>({
    capacity: 8,
    replay: 1,
  });
  yield* Effect.addFinalizer(() => PubSub.shutdown(startupUpdates));
  const runtimeBuildId = yield* computeProviderDaemonRuntimeBuildId(environment);

  const reapStaleProviderRuntimeProcesses = (
    keepPids: ReadonlyArray<number | undefined>,
  ): Effect.Effect<void> => {
    const keepPidSet = new Set(
      keepPids.filter((pid): pid is number => pid !== undefined && pid > 0),
    );
    return reapMatchingUnixProcesses({
      keepPids: keepPidSet,
      matches: (processSnapshot: DesktopProcessSnapshot) =>
        matchesProviderRuntimeProcess(processSnapshot, environment.backendEntryPath),
    }).pipe(
      Effect.flatMap((results) =>
        Effect.forEach(
          results,
          (result) =>
            logWarning("reaped stale provider runtime process", {
              pid: result.pid,
              ppid: result.ppid,
              signalSent: result.signalSent,
              escalated: result.escalated,
              stillAlive: result.stillAlive,
              ...(result.error !== null ? { error: result.error } : {}),
            }),
          { concurrency: 1 },
        ),
      ),
      Effect.asVoid,
    );
  };

  const publishDebugSnapshot = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    yield* DesktopDebugServer.publishProviderDaemonDebugSnapshot({
      status: current.status,
      pid: Option.getOrNull(current.pid),
      endpoint: Option.match(current.endpoint, {
        onNone: () => null,
        onSome: (endpoint) => ({
          httpBaseUrl: endpoint.httpBaseUrl,
          transport: endpoint.transport ?? "tcp",
          socketPath: endpoint.socketPath ?? null,
          leaseId: endpoint.leaseId ?? null,
        }),
      }),
      adoptedExistingProcess: current.adoptedExistingProcess,
      lastHealth: Option.getOrNull(current.lastHealth),
      lastHealthObservedAt: Option.getOrNull(current.lastHealthObservedAt),
      lastError: Option.getOrNull(current.lastError),
      markerPath: environment.providerDaemonMarkerPath,
      credentialPath: environment.providerDaemonCredentialPath,
      runtimeBuildId,
      performance: {
        lastEnsureRunningDurationMs: Option.getOrNull(current.lastEnsureRunningDurationMs),
        lastAdoptionDurationMs: Option.getOrNull(current.lastAdoptionDurationMs),
        lastSpawnDurationMs: Option.getOrNull(current.lastSpawnDurationMs),
        lastHealthRefreshDurationMs: Option.getOrNull(current.lastHealthRefreshDurationMs),
        healthRefreshCount: current.healthRefreshCount,
        healthRefreshFailureCount: current.healthRefreshFailureCount,
        recoveryCount: current.recoveryCount,
        lastRecoveryAt: Option.getOrNull(current.lastRecoveryAt),
        lastRecoveryReason: Option.getOrNull(current.lastRecoveryReason),
      },
    });
  });

  const snapshot = Ref.get(state).pipe(
    Effect.map((current): DesktopProviderDaemonSnapshot => ({
      status: current.status,
      pid: current.pid,
      endpoint: current.endpoint,
      adoptedExistingProcess: current.adoptedExistingProcess,
      lastHealth: current.lastHealth,
      lastError: current.lastError,
      markerPath: environment.providerDaemonMarkerPath,
      credentialPath: environment.providerDaemonCredentialPath,
      runtimeBuildId,
      lastEnsureRunningDurationMs: current.lastEnsureRunningDurationMs,
      lastAdoptionDurationMs: current.lastAdoptionDurationMs,
      lastSpawnDurationMs: current.lastSpawnDurationMs,
      lastHealthRefreshDurationMs: current.lastHealthRefreshDurationMs,
      healthRefreshCount: current.healthRefreshCount,
      healthRefreshFailureCount: current.healthRefreshFailureCount,
      recoveryCount: current.recoveryCount,
      lastRecoveryAt: current.lastRecoveryAt,
      lastRecoveryReason: current.lastRecoveryReason,
    })),
  );

  const adoptMarker = (
    marker: ProviderDaemonMarkerValue,
  ): Effect.Effect<Option.Option<ProviderDaemonClientConfig>> =>
    Effect.gen(function* () {
      const adoptionStartedAtMs = performance.now();
      const preserveInconclusiveOwner = (phase: "credential" | "health" | "lease") =>
        Effect.gen(function* () {
          // A live PID plus an unreadable response is not evidence that this
          // daemon is obsolete. Keep its marker/credential and do not fall
          // through to spawn's process reaper. A later ensureRunning retries
          // adoption of the exact same identity, without replaying any prompt.
          const message = `Existing provider daemon ${phase} observation was inconclusive; its running process was preserved. Retry connection.`;
          yield* Ref.update(state, (current) => ({
            ...current,
            status: "error" as const,
            pid: Option.some(marker.pid),
            lastError: Option.some(message),
          }));
          yield* publishDebugSnapshot;
          yield* logWarning("provider daemon adoption deferred", { phase });
          return yield* Effect.die(new Error(message));
        });
      const observeForAdoption = <A>(read: () => Promise<A>) =>
        Effect.tryPromise({
          try: read,
          catch: (cause) => new ProviderDaemonHealthError({ cause }),
        }).pipe(
          Effect.retry({
            times: 1,
            schedule: Schedule.spaced(PROVIDER_DAEMON_ADOPTION_RETRY_DELAY_MS),
          }),
          Effect.option,
        );
      const cafeMcpPort = yield* Ref.get(cafeMcpPortRef);
      const transport = marker.transport ?? "tcp";
      const socketPath = marker.socketPath;
      const credentialPath = marker.credentialPath ?? environment.providerDaemonCredentialPath;
      const hasValidEndpoint =
        transport === "ipc"
          ? typeof socketPath === "string" && socketPath.length > 0
          : isLoopbackEndpoint(marker.httpBaseUrl);
      if (
        (marker.mode ?? "provider-daemon") !== "provider-daemon" ||
        !hasValidEndpoint ||
        !isPidAlive(marker.pid)
      ) {
        yield* removeMarker(environment.providerDaemonMarkerPath);
        return Option.none();
      }
      const token = yield* readCredential(credentialPath, marker.credentialEncrypted ?? true).pipe(
        Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, safeStorage),
      );
      if (Option.isNone(token)) {
        return yield* preserveInconclusiveOwner("credential");
      }
      const rootEndpoint = markerEndpoint(marker, token.value);
      const health = yield* observeForAdoption(() => fetchProviderDaemonHealth(rootEndpoint));
      const healthObservedAt = DateTime.formatIso(yield* DateTime.now);
      if (Option.isNone(health)) {
        return yield* preserveInconclusiveOwner("health");
      }
      if (
        health.value.pid !== marker.pid ||
        health.value.mode !== "provider-daemon" ||
        health.value.version !== environment.appVersion ||
        health.value.protocolVersion !== PROVIDER_DAEMON_PROTOCOL_VERSION ||
        health.value.runtimeBuildId !== runtimeBuildId ||
        marker.appVersion !== environment.appVersion ||
        marker.protocolVersion !== PROVIDER_DAEMON_PROTOCOL_VERSION ||
        marker.runtimeBuildId !== runtimeBuildId ||
        (cafeMcpPort !== undefined && marker.cafeMcpPort !== cafeMcpPort)
      ) {
        if (Option.isSome(health)) {
          const supervisorPid = health.value.upstreamSupervisor?.pid;
          if (supervisorPid !== undefined && supervisorPid !== marker.pid) {
            yield* terminateExternalPid(supervisorPid);
          }
        }
        yield* terminateExternalPid(marker.pid);
        yield* removeMarker(environment.providerDaemonMarkerPath);
        return Option.none();
      }

      const lease = yield* observeForAdoption(() => issueProviderDaemonLease(rootEndpoint));
      if (Option.isNone(lease)) {
        return yield* preserveInconclusiveOwner("lease");
      }
      const endpoint: ProviderDaemonClientConfig = {
        ...rootEndpoint,
        token: lease.value.token,
        leaseId: lease.value.leaseId,
      };
      const previous = yield* Ref.get(state);

      yield* Ref.set(state, {
        status: "running",
        pid: Option.some(marker.pid),
        endpoint: Option.some(endpoint),
        adoptedExistingProcess: true,
        terminate: Option.some(terminateExternalPid(marker.pid)),
        ownedChild: Option.none(),
        lastHealth: Option.some(health.value),
        lastHealthObservedAt: Option.some(healthObservedAt),
        lastError: Option.none(),
        lastEnsureRunningDurationMs: Option.none(),
        lastAdoptionDurationMs: Option.some(
          Math.round((performance.now() - adoptionStartedAtMs) * 100) / 100,
        ),
        lastSpawnDurationMs: Option.none(),
        lastHealthRefreshDurationMs: Option.none(),
        healthRefreshCount: 0,
        healthRefreshFailureCount: 0,
        recoveryCount: previous.recoveryCount,
        lastRecoveryAt: previous.lastRecoveryAt,
        lastRecoveryReason: previous.lastRecoveryReason,
      });
      yield* publishDebugSnapshot;
      yield* logInfo("adopted existing provider daemon", {
        pid: marker.pid,
        endpoint: marker.httpBaseUrl,
        transport,
        runtimeBuildId,
      });
      yield* reapStaleProviderRuntimeProcesses([marker.pid, health.value.upstreamSupervisor?.pid]);
      return Option.some(endpoint);
    });

  const spawnDaemon = Effect.gen(function* () {
    const spawnStartedAtMs = performance.now();
    const socketPath = providerDaemonIpcSocketPath(environment);
    yield* prepareProviderDaemonIpcPath(environment, socketPath);
    const token = makeProviderDaemonToken();
    const cafeMcpPort = yield* Ref.get(cafeMcpPortRef);
    const rootEndpoint: ProviderDaemonClientConfig = {
      httpBaseUrl: "http://provider-daemon.local",
      transport: "ipc",
      socketPath,
      token,
    };
    const now = DateTime.formatIso(yield* DateTime.now);
    const bootstrap = {
      mode: "provider-daemon",
      startupProgressFd: BACKEND_STARTUP_PROGRESS_FD,
      transport: "ipc",
      socketPath,
      cafeCodeHome: environment.baseDir,
      ...(cafeMcpPort !== undefined ? { cafeMcpPort } : {}),
      token,
      runtimeBuildId,
      ...Option.match(environment.otlpTracesUrl, {
        onNone: () => ({}),
        onSome: (otlpTracesUrl) => ({ otlpTracesUrl }),
      }),
    } satisfies ProviderDaemonBootstrap;
    const bootstrapJson = yield* encodeProviderDaemonBootstrapJson(bootstrap);
    const command = ChildProcess.make(
      process.execPath,
      [environment.backendEntryPath, "provider-daemon", "--bootstrap-fd", "3"],
      {
        cwd: environment.backendCwd,
        env: {
          ...providerDaemonChildEnvPatch(),
          ELECTRON_RUN_AS_NODE: "1",
          [CAFE_CODE_SHELL_ENV_HYDRATED]: "1",
        },
        extendEnv: true,
        stdin: "ignore",
        // The daemon is intentionally allowed to outlive Electron. Parent-owned
        // stdout/stderr pipes close when the desktop restarts and can terminate a
        // still-healthy detached daemon with EPIPE on its next log write. The
        // daemon owns durable trace/provider logs, so its inherited stdio must be
        // detached from the desktop lifetime as well.
        stdout: "ignore",
        stderr: "ignore",
        killSignal: "SIGTERM",
        additionalFds: {
          fd3: {
            type: "input",
            stream: Stream.encodeText(Stream.make(`${bootstrapJson}\n`)),
          },
          // Detached stdout/stderr stay ignored. Only this exact child pipe
          // supplies startup evidence; its reader belongs to this attempt.
          fd4: { type: "output" },
        },
      },
    );
    const spawnedAtNanos = yield* Clock.currentTimeNanos;
    const elapsedMs = Clock.currentTimeNanos.pipe(
      Effect.map((value) => Number(value - spawnedAtNanos) / 1_000_000),
    );
    const feedback: ProviderDaemonStartupProgress[] = [];
    const progress = makeProviderDaemonStartupProgressTracker(
      PROVIDER_DAEMON_READINESS_TIMEOUT_MS,
      (update) => feedback.push(update),
    );
    const flushFeedback = Effect.suspend(() =>
      Effect.forEach(feedback.splice(0), (update) => PubSub.publish(startupUpdates, update)).pipe(
        Effect.asVoid,
      ),
    );
    // A quit may interrupt readiness, but never the fresh child-to-recovery
    // handoff. The persistent daemon scope deliberately does not reap a child
    // when this attempt closes: complete its exact reservation and durable
    // publication first, or perform bounded exact-handle retirement on an I/O
    // failure. This fence never applies to adoption or the long readiness wait.
    const { handle, retireOwnedChild } = yield* Effect.gen(function* () {
      const handle = yield* spawner.spawn(command).pipe(
        Effect.mapError((cause) => new ProviderDaemonSpawnError({ cause })),
        Scope.provide(daemonScope),
      );
      progress.start();
      yield* flushFeedback;
      yield* handle.getOutputFd(BACKEND_STARTUP_PROGRESS_FD).pipe(
        Stream.runForEach((bytes) =>
          Effect.gen(function* () {
            progress.push(bytes, yield* elapsedMs);
            yield* flushFeedback;
          }),
        ),
        Effect.catchCause(() =>
          Effect.sync(() => progress.invalidate()).pipe(Effect.andThen(flushFeedback)),
        ),
        Effect.ensuring(Effect.sync(() => progress.end()).pipe(Effect.andThen(flushFeedback))),
        // The reader is an attempt resource, not part of the publication fence.
        // Its finalization must remain interruptible even during a pending quit.
        Effect.interruptible,
        Effect.forkScoped,
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          progress.finish("failed");
          // Retry attempts do not publish a terminal UI failure; ensureRunning
          // owns that event after its bounded typed-error retries are exhausted.
          feedback.length = 0;
        }),
      );
      const retireOwnedChild = Effect.gen(function* () {
        if (!(yield* stopOwnedProviderDaemonChild(handle))) {
          const error = new ProviderDaemonTerminationUnconfirmedError();
          yield* Ref.update(state, (current) => ({
            ...current,
            status: "error" as const,
            lastError: Option.some(error.message),
          }));
          yield* publishDebugSnapshot;
          // A defect deliberately bypasses spawnDaemon's typed-error retry.
          // Preserve the marker, credential and namespace if exit is uncertain.
          return yield* Effect.die(error);
        }
      });
      yield* handle.unref.pipe(Effect.ignore);
      // Reserve this exact child before publishing either recovery file. A
      // partial credential/marker failure is not permission to lose the handle
      // and retry a second detached runtime over the still-live first child.
      const previous = yield* Ref.get(state);
      yield* Ref.set(state, {
        status: "starting",
        pid: Option.some(handle.pid),
        endpoint: Option.some(rootEndpoint),
        adoptedExistingProcess: false,
        terminate: Option.some(retireOwnedChild),
        ownedChild: Option.some(handle),
        lastHealth: Option.none(),
        lastHealthObservedAt: Option.none(),
        lastError: Option.none(),
        lastEnsureRunningDurationMs: Option.none(),
        lastAdoptionDurationMs: Option.none(),
        lastSpawnDurationMs: Option.none(),
        lastHealthRefreshDurationMs: Option.none(),
        healthRefreshCount: 0,
        healthRefreshFailureCount: 0,
        recoveryCount: previous.recoveryCount,
        lastRecoveryAt: previous.lastRecoveryAt,
        lastRecoveryReason: previous.lastRecoveryReason,
      });
      yield* publishDebugSnapshot;

      yield* Effect.gen(function* () {
        const credentialEncrypted = yield* writeCredential({
          credentialPath: environment.providerDaemonCredentialPath,
          token,
        }).pipe(Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, safeStorage));
        const marker: ProviderDaemonMarkerValue = {
          version: 2,
          mode: "provider-daemon",
          protocolVersion: PROVIDER_DAEMON_PROTOCOL_VERSION,
          pid: handle.pid,
          ppid: process.pid,
          transport: "ipc",
          httpBaseUrl: rootEndpoint.httpBaseUrl,
          socketPath,
          credentialPath: environment.providerDaemonCredentialPath,
          credentialEncrypted,
          createdAt: now,
          updatedAt: now,
          appVersion: environment.appVersion,
          runtimeBuildId,
          ...(cafeMcpPort !== undefined ? { cafeMcpPort } : {}),
        };
        yield* writeMarker({ markerPath: environment.providerDaemonMarkerPath, marker });
      }).pipe(
        Effect.catch((error) =>
          retireOwnedChild.pipe(
            Effect.andThen(removeMarker(environment.providerDaemonMarkerPath)),
            Effect.andThen(removeCredential(environment.providerDaemonCredentialPath)),
            Effect.andThen(removeProviderDaemonIpcSocket(environment)),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
      return { handle, retireOwnedChild };
    }).pipe(Effect.uninterruptible);

    const health = yield* waitForOwnedProviderDaemonHealth(
      rootEndpoint,
      progress,
      elapsedMs,
      handle,
    ).pipe(
      Effect.catch((error) =>
        retireOwnedChild.pipe(
          Effect.andThen(removeMarker(environment.providerDaemonMarkerPath)),
          Effect.andThen(removeCredential(environment.providerDaemonCredentialPath)),
          Effect.andThen(removeProviderDaemonIpcSocket(environment)),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
    const healthObservedAt = DateTime.formatIso(yield* DateTime.now);
    const lease = yield* Effect.tryPromise({
      try: () => issueProviderDaemonLease(rootEndpoint),
      catch: (cause) => new ProviderDaemonHealthError({ cause }),
    }).pipe(
      Effect.mapError((cause) => new ProviderDaemonSpawnError({ cause })),
      Effect.catch((error) =>
        retireOwnedChild.pipe(
          Effect.andThen(removeMarker(environment.providerDaemonMarkerPath)),
          Effect.andThen(removeCredential(environment.providerDaemonCredentialPath)),
          Effect.andThen(removeProviderDaemonIpcSocket(environment)),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
    const endpoint: ProviderDaemonClientConfig = {
      ...rootEndpoint,
      token: lease.token,
      leaseId: lease.leaseId,
    };
    yield* Ref.update(state, (current) => ({
      ...current,
      endpoint: Option.some(endpoint),
      status: "running" as const,
      lastHealth: Option.some(health),
      lastHealthObservedAt: Option.some(healthObservedAt),
      lastSpawnDurationMs: Option.some(
        Math.round((performance.now() - spawnStartedAtMs) * 100) / 100,
      ),
    }));
    yield* publishDebugSnapshot;
    progress.finish("ready");
    yield* flushFeedback;
    yield* logInfo("started provider daemon", {
      pid: handle.pid,
      endpoint: endpoint.httpBaseUrl,
      transport: endpoint.transport,
      runtimeBuildId,
    });
    yield* reapStaleProviderRuntimeProcesses([handle.pid, health.upstreamSupervisor?.pid]);
    return endpoint;
  }).pipe(Effect.scoped);

  const ensureRunningUnlocked = Effect.gen(function* () {
    const ensureStartedAtMs = performance.now();
    const current = yield* Ref.get(state);
    if (current.status === "running" && Option.isSome(current.endpoint)) {
      yield* Ref.update(state, (latest) => ({
        ...latest,
        lastEnsureRunningDurationMs: Option.some(
          Math.round((performance.now() - ensureStartedAtMs) * 100) / 100,
        ),
      }));
      yield* publishDebugSnapshot;
      return current.endpoint.value;
    }

    if (Option.isSome(current.ownedChild)) {
      const stillOwned = yield* current.ownedChild.value.isRunning.pipe(
        Effect.orElseSucceed(() => true),
      );
      if (stillOwned) {
        // A second ensure must not turn the previous inconclusive retirement
        // into a missing/stale-marker spawn. Only a later actual child exit or
        // a new desktop's authenticated adoption can resolve this reservation.
        return yield* Effect.die(new ProviderDaemonTerminationUnconfirmedError());
      }
    }

    const marker = yield* readMarker(environment.providerDaemonMarkerPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.catch((error) =>
        Ref.update(state, (latest) => ({
          ...latest,
          status: "error" as const,
          lastError: Option.some(error.message),
        })).pipe(
          Effect.andThen(publishDebugSnapshot),
          Effect.andThen(logWarning("provider daemon adoption deferred", { phase: "marker" })),
          // Keep this outside spawnDaemon's retry block. Retrying or replacing
          // a provider process cannot repair an inconclusive marker observation.
          Effect.andThen(Effect.die(error)),
        ),
      ),
    );
    if (Option.isSome(marker)) {
      const adopted = yield* adoptMarker(marker.value);
      if (Option.isSome(adopted)) {
        yield* Ref.update(state, (latest) => ({
          ...latest,
          lastEnsureRunningDurationMs: Option.some(
            Math.round((performance.now() - ensureStartedAtMs) * 100) / 100,
          ),
        }));
        yield* publishDebugSnapshot;
        return adopted.value;
      }
    }

    const endpoint = yield* spawnDaemon.pipe(
      Effect.retry({ times: PROVIDER_DAEMON_SPAWN_ATTEMPTS - 1 }),
      Effect.catch((error) =>
        Ref.update(state, (latest) => ({
          ...latest,
          status: "error" as const,
          lastError: Option.some(error.message),
        })).pipe(
          Effect.andThen(publishDebugSnapshot),
          Effect.andThen(logWarning("failed to start provider daemon", { error: error.message })),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
      Effect.orDie,
    );
    yield* Ref.update(state, (latest) => ({
      ...latest,
      lastEnsureRunningDurationMs: Option.some(
        Math.round((performance.now() - ensureStartedAtMs) * 100) / 100,
      ),
    }));
    yield* publishDebugSnapshot;
    return endpoint;
  });
  const ensureRunning = Effect.gen(function* () {
    if ((yield* Ref.get(state)).status !== "running") {
      yield* PubSub.publish(startupUpdates, { phase: "starting" });
    }
    return yield* lifecycleMutex.withPermits(1)(ensureRunningUnlocked);
  }).pipe(
    Effect.tap(() => PubSub.publish(startupUpdates, { phase: "ready" })),
    Effect.tapCause(() => PubSub.publish(startupUpdates, { phase: "failed" })),
  );

  const currentConfig = Ref.get(state).pipe(Effect.map((current) => current.endpoint));

  const probeLivenessUnlocked: Effect.Effect<Option.Option<ProviderDaemonLivenessValue>> =
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const endpoint = Option.getOrUndefined(current.endpoint);
      if (endpoint === undefined) {
        return Option.none<ProviderDaemonLivenessValue>();
      }

      const refreshStartedAtMs = performance.now();
      const livenessResult = yield* Effect.tryPromise({
        try: async () => {
          const liveness = await fetchProviderDaemonLiveness(endpoint);
          const expectedPid = Option.getOrUndefined(current.pid);
          if (expectedPid !== undefined && liveness.pid !== expectedPid) {
            throw new Error(
              `provider daemon liveness PID mismatch: expected ${expectedPid}, received ${liveness.pid}`,
            );
          }
          if (liveness.runtimeBuildId !== undefined && liveness.runtimeBuildId !== runtimeBuildId) {
            throw new Error("provider daemon liveness runtime build mismatch");
          }
          return liveness;
        },
        catch: (cause) => new ProviderDaemonHealthError({ cause }),
      }).pipe(Effect.result);

      const durationMs = Math.round((performance.now() - refreshStartedAtMs) * 100) / 100;
      if (livenessResult._tag === "Failure") {
        yield* Ref.update(state, (latest) => ({
          ...latest,
          lastError: Option.some(livenessResult.failure.message),
          lastHealthRefreshDurationMs: Option.some(durationMs),
          healthRefreshCount: latest.healthRefreshCount + 1,
          healthRefreshFailureCount: latest.healthRefreshFailureCount + 1,
        }));
        yield* publishDebugSnapshot;
        yield* logWarning("provider daemon liveness probe failed", {
          error: livenessResult.failure.message,
        });
        return Option.none<ProviderDaemonLivenessValue>();
      }

      yield* Ref.update(state, (latest) => ({
        ...latest,
        status: "running" as const,
        lastError: Option.none(),
        lastHealthRefreshDurationMs: Option.some(durationMs),
        healthRefreshCount: latest.healthRefreshCount + 1,
      }));
      yield* publishDebugSnapshot;
      return Option.some(livenessResult.success);
    });
  const probeLiveness = lifecycleMutex.withPermits(1)(probeLivenessUnlocked);

  const refreshHealthUnlocked: Effect.Effect<Option.Option<ProviderDaemonHealthValue>> = Effect.gen(
    function* () {
      const current = yield* Ref.get(state);
      const endpoint = Option.getOrUndefined(current.endpoint);
      if (endpoint === undefined) {
        return Option.none<ProviderDaemonHealthValue>();
      }

      const refreshStartedAtMs = performance.now();
      const healthResult = yield* Effect.tryPromise({
        try: () => fetchProviderDaemonHealth(endpoint),
        catch: (cause) => new ProviderDaemonHealthError({ cause }),
      }).pipe(Effect.result);

      if (healthResult._tag === "Failure") {
        yield* Ref.update(state, (latest) => ({
          ...latest,
          lastError: Option.some(healthResult.failure.message),
          lastHealthRefreshDurationMs: Option.some(
            Math.round((performance.now() - refreshStartedAtMs) * 100) / 100,
          ),
          healthRefreshCount: latest.healthRefreshCount + 1,
          healthRefreshFailureCount: latest.healthRefreshFailureCount + 1,
        }));
        yield* publishDebugSnapshot;
        yield* logWarning("provider daemon health refresh failed", {
          error: healthResult.failure.message,
        });
        return Option.none<ProviderDaemonHealthValue>();
      }

      // Only a completed rich-health response refreshes this timestamp. The
      // watchdog republishes the manager snapshot every five seconds after
      // liveness probes, which says nothing about the age of cached RPC,
      // session, or event-journal diagnostics.
      const healthObservedAt = DateTime.formatIso(yield* DateTime.now);
      yield* Ref.update(state, (latest) => ({
        ...latest,
        status: "running" as const,
        lastHealth: Option.some(healthResult.success),
        lastHealthObservedAt: Option.some(healthObservedAt),
        lastError: Option.none(),
        lastHealthRefreshDurationMs: Option.some(
          Math.round((performance.now() - refreshStartedAtMs) * 100) / 100,
        ),
        healthRefreshCount: latest.healthRefreshCount + 1,
      }));
      yield* publishDebugSnapshot;
      return Option.some(healthResult.success);
    },
  );
  const refreshHealth = lifecycleMutex.withPermits(1)(refreshHealthUnlocked);

  const stopUnlocked = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const endpoint = Option.getOrUndefined(current.endpoint);
    const latestHealth =
      Option.getOrUndefined(current.lastHealth) ??
      (endpoint === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () => fetchProviderDaemonHealth(endpoint),
            catch: (cause) => new ProviderDaemonHealthError({ cause }),
          }).pipe(Effect.option, Effect.map(Option.getOrUndefined)));
    const supervisorPid = latestHealth?.upstreamSupervisor?.pid;
    if (supervisorPid !== undefined && supervisorPid !== Option.getOrUndefined(current.pid)) {
      yield* terminateExternalPid(supervisorPid);
    }
    yield* Option.match(current.terminate, {
      onNone: () => Effect.void,
      onSome: (terminate) => terminate,
    });
    yield* removeMarker(environment.providerDaemonMarkerPath);
    yield* removeCredential(environment.providerDaemonCredentialPath);
    yield* removeProviderDaemonIpcSocket(environment);
    yield* reapStaleProviderRuntimeProcesses([]);
    yield* Ref.set(state, initialState);
    yield* publishDebugSnapshot;
  });
  const stop = lifecycleMutex.withPermits(1)(stopUnlocked);

  const recover = (reason: string): Effect.Effect<ProviderDaemonClientConfig> =>
    lifecycleMutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const normalizedReason = reason.replace(/\s+/g, " ").trim().slice(0, 256);
        const recoveryAt = DateTime.formatIso(yield* DateTime.now);
        const supervisorPid = Option.getOrUndefined(current.lastHealth)?.upstreamSupervisor?.pid;

        // A replacement daemon has a new root token and issues a new lease. Tear
        // down every stale process and private credential before spawning so a
        // reused PID, socket file, or credential cannot be mistaken for the new
        // authenticated runtime.
        if (supervisorPid !== undefined && supervisorPid !== Option.getOrUndefined(current.pid)) {
          yield* terminateExternalPid(supervisorPid);
        }
        yield* Option.match(current.terminate, {
          onNone: () => Effect.void,
          onSome: (terminate) => terminate,
        });
        yield* removeMarker(environment.providerDaemonMarkerPath);
        yield* removeCredential(environment.providerDaemonCredentialPath);
        yield* removeProviderDaemonIpcSocket(environment);
        yield* reapStaleProviderRuntimeProcesses([]);
        yield* Ref.set(state, {
          ...initialState,
          recoveryCount: current.recoveryCount + 1,
          lastRecoveryAt: Option.some(recoveryAt),
          lastRecoveryReason: Option.some(
            normalizedReason.length > 0 ? normalizedReason : "provider daemon became unhealthy",
          ),
        });
        yield* publishDebugSnapshot;
        yield* logWarning("replacing unhealthy provider daemon", {
          previousPid: Option.getOrNull(current.pid),
          recoveryCount: current.recoveryCount + 1,
          reason: normalizedReason,
        });
        return yield* ensureRunningUnlocked;
      }),
    );

  const refreshRuntimeContext = yield* Effect.context<never>();
  const runRefreshHealth = Effect.runPromiseWith(refreshRuntimeContext);
  yield* DesktopDebugServer.setProviderDaemonDebugSnapshotRefresher(() =>
    runRefreshHealth(refreshHealth.pipe(Effect.asVoid)),
  );
  yield* publishDebugSnapshot;

  return {
    startupProgress: Stream.fromPubSub(startupUpdates),
    configureCafeMcpPort: (port) =>
      Number.isInteger(port) && port > 0 && port <= 65_535
        ? Ref.set(cafeMcpPortRef, port)
        : Effect.die(new Error("Invalid Cafe MCP backend port.")),
    ensureRunning,
    recover,
    currentConfig,
    probeLiveness,
    refreshHealth,
    snapshot,
    stop,
  } satisfies DesktopProviderDaemonManagerShape;
});

export const layer = Layer.effect(DesktopProviderDaemonManager, makeDesktopProviderDaemonManager);
