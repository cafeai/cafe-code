// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as path from "node:path";

import {
  PROVIDER_DAEMON_HEALTH_PATH,
  PROVIDER_DAEMON_LEASES_PATH,
  ProviderDaemonBootstrap,
  ProviderDaemonHealth,
  ProviderDaemonLeaseRequest,
  ProviderDaemonLeaseResponse,
  ProviderDaemonMarker,
  type ProviderDaemonClientConfig,
  type ProviderDaemonHealth as ProviderDaemonHealthValue,
  type ProviderDaemonLeaseResponse as ProviderDaemonLeaseResponseValue,
  type ProviderDaemonMarker as ProviderDaemonMarkerValue,
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import { CAFE_CODE_SHELL_ENV_HYDRATED } from "@cafecode/shared/shell";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { performance } from "node:perf_hooks";

import * as DesktopDebugServer from "../debug/DesktopDebugServer.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
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
}

export interface DesktopProviderDaemonManagerShape {
  readonly ensureRunning: Effect.Effect<ProviderDaemonClientConfig>;
  readonly currentConfig: Effect.Effect<Option.Option<ProviderDaemonClientConfig>>;
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

interface ProviderDaemonState {
  readonly status: "idle" | "starting" | "running" | "error";
  readonly pid: Option.Option<number>;
  readonly endpoint: Option.Option<ProviderDaemonClientConfig>;
  readonly adoptedExistingProcess: boolean;
  readonly terminate: Option.Option<Effect.Effect<void>>;
  readonly lastHealth: Option.Option<ProviderDaemonHealthValue>;
  readonly lastError: Option.Option<string>;
  readonly lastEnsureRunningDurationMs: Option.Option<number>;
  readonly lastAdoptionDurationMs: Option.Option<number>;
  readonly lastSpawnDurationMs: Option.Option<number>;
  readonly lastHealthRefreshDurationMs: Option.Option<number>;
  readonly healthRefreshCount: number;
  readonly healthRefreshFailureCount: number;
}

const initialState: ProviderDaemonState = {
  status: "idle",
  pid: Option.none(),
  endpoint: Option.none(),
  adoptedExistingProcess: false,
  terminate: Option.none(),
  lastHealth: Option.none(),
  lastError: Option.none(),
  lastEnsureRunningDurationMs: Option.none(),
  lastAdoptionDurationMs: Option.none(),
  lastSpawnDurationMs: Option.none(),
  lastHealthRefreshDurationMs: Option.none(),
  healthRefreshCount: 0,
  healthRefreshFailureCount: 0,
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
): Effect.Effect<Option.Option<ProviderDaemonMarkerValue>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem.exists(markerPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return Option.none();
    }
    const raw = yield* fileSystem.readFileString(markerPath).pipe(Effect.option);
    if (Option.isNone(raw)) {
      return Option.none();
    }
    const parsed = yield* decodeProviderDaemonMarkerJson(raw.value).pipe(Effect.option);
    return parsed;
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

const writeEncryptedCredential = (input: {
  readonly credentialPath: string;
  readonly token: string;
}): Effect.Effect<void, ProviderDaemonSpawnError, ElectronSafeStorage.ElectronSafeStorage> =>
  Effect.gen(function* () {
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const available = yield* safeStorage.isEncryptionAvailable.pipe(
      Effect.mapError((cause) => new ProviderDaemonSpawnError({ cause })),
    );
    if (!available) {
      return yield* new ProviderDaemonSpawnError({
        cause: new Error("Electron safeStorage encryption is unavailable."),
      });
    }
    const encrypted = yield* safeStorage
      .encryptString(input.token)
      .pipe(Effect.mapError((cause) => new ProviderDaemonSpawnError({ cause })));
    yield* Effect.tryPromise({
      try: async () => {
        const temporaryPath = `${input.credentialPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await fs.mkdir(path.dirname(input.credentialPath), { recursive: true });
        await fs.writeFile(temporaryPath, Buffer.from(encrypted), { mode: 0o600 });
        await fs.rename(temporaryPath, input.credentialPath);
        await fs.chmod(input.credentialPath, 0o600);
      },
      catch: (cause) =>
        new ProviderDaemonIoError({ operation: "write provider daemon credential", cause }),
    }).pipe(Effect.mapError((cause) => new ProviderDaemonSpawnError({ cause })));
  });

const readEncryptedCredential = (
  credentialPath: string,
): Effect.Effect<Option.Option<string>, never, ElectronSafeStorage.ElectronSafeStorage> =>
  Effect.gen(function* () {
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const encrypted = yield* Effect.tryPromise({
      try: () => fs.readFile(credentialPath),
      catch: (cause) =>
        new ProviderDaemonIoError({ operation: "read provider daemon credential", cause }),
    }).pipe(Effect.option);
    if (Option.isNone(encrypted)) {
      return Option.none();
    }
    return yield* safeStorage.decryptString(encrypted.value).pipe(Effect.option);
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

const waitForHealth = (
  endpoint: ProviderDaemonClientConfig,
): Effect.Effect<ProviderDaemonHealthValue, ProviderDaemonSpawnError> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    let lastError: unknown = undefined;
    while ((yield* Clock.currentTimeMillis) - startedAt < PROVIDER_DAEMON_READINESS_TIMEOUT_MS) {
      const healthResult = yield* Effect.tryPromise({
        try: () => fetchProviderDaemonHealth(endpoint),
        catch: (cause) => new ProviderDaemonHealthError({ cause }),
      }).pipe(Effect.result);
      if (healthResult._tag === "Success") {
        return healthResult.success;
      }
      lastError = healthResult.failure;
      yield* Effect.sleep(Duration.millis(PROVIDER_DAEMON_READINESS_INTERVAL_MS));
    }
    return yield* new ProviderDaemonSpawnError({
      cause: lastError ?? new Error("Provider daemon did not become ready before timeout."),
    });
  });

const makeDesktopProviderDaemonManager = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  yield* NetService.NetService;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const daemonScope = yield* Scope.make();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const state = yield* Ref.make(initialState);
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
      },
    });
  });

  const snapshot = Ref.get(state).pipe(
    Effect.map(
      (current): DesktopProviderDaemonSnapshot => ({
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
      }),
    ),
  );

  const adoptMarker = (
    marker: ProviderDaemonMarkerValue,
  ): Effect.Effect<Option.Option<ProviderDaemonClientConfig>> =>
    Effect.gen(function* () {
      const adoptionStartedAtMs = performance.now();
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
      const token = yield* readEncryptedCredential(credentialPath).pipe(
        Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, safeStorage),
      );
      if (Option.isNone(token)) {
        yield* removeMarker(environment.providerDaemonMarkerPath);
        yield* removeCredential(credentialPath);
        return Option.none();
      }
      const rootEndpoint = markerEndpoint(marker, token.value);
      const health = yield* Effect.tryPromise({
        try: () => fetchProviderDaemonHealth(rootEndpoint),
        catch: (cause) => new ProviderDaemonHealthError({ cause }),
      }).pipe(Effect.option);
      if (
        Option.isNone(health) ||
        health.value.pid !== marker.pid ||
        health.value.mode !== "provider-daemon" ||
        health.value.version !== environment.appVersion ||
        health.value.protocolVersion !== PROVIDER_DAEMON_PROTOCOL_VERSION ||
        health.value.runtimeBuildId !== runtimeBuildId ||
        marker.appVersion !== environment.appVersion ||
        marker.protocolVersion !== PROVIDER_DAEMON_PROTOCOL_VERSION ||
        marker.runtimeBuildId !== runtimeBuildId
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

      const lease = yield* Effect.tryPromise({
        try: () => issueProviderDaemonLease(rootEndpoint),
        catch: (cause) => new ProviderDaemonHealthError({ cause }),
      }).pipe(Effect.option);
      if (Option.isNone(lease)) {
        yield* removeMarker(environment.providerDaemonMarkerPath);
        return Option.none();
      }
      const endpoint: ProviderDaemonClientConfig = {
        ...rootEndpoint,
        token: lease.value.token,
        leaseId: lease.value.leaseId,
      };

      yield* Ref.set(state, {
        status: "running",
        pid: Option.some(marker.pid),
        endpoint: Option.some(endpoint),
        adoptedExistingProcess: true,
        terminate: Option.some(terminateExternalPid(marker.pid)),
        lastHealth: Option.some(health.value),
        lastError: Option.none(),
        lastEnsureRunningDurationMs: Option.none(),
        lastAdoptionDurationMs: Option.some(
          Math.round((performance.now() - adoptionStartedAtMs) * 100) / 100,
        ),
        lastSpawnDurationMs: Option.none(),
        lastHealthRefreshDurationMs: Option.none(),
        healthRefreshCount: 0,
        healthRefreshFailureCount: 0,
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
    const rootEndpoint: ProviderDaemonClientConfig = {
      httpBaseUrl: "http://provider-daemon.local",
      transport: "ipc",
      socketPath,
      token,
    };
    const now = DateTime.formatIso(yield* DateTime.now);
    const bootstrap = {
      mode: "provider-daemon",
      transport: "ipc",
      socketPath,
      cafeCodeHome: environment.baseDir,
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
        stdout: "ignore",
        stderr: "ignore",
        killSignal: "SIGTERM",
        additionalFds: {
          fd3: {
            type: "input",
            stream: Stream.encodeText(Stream.make(`${bootstrapJson}\n`)),
          },
        },
      },
    );
    const handle = yield* spawner.spawn(command).pipe(
      Effect.mapError((cause) => new ProviderDaemonSpawnError({ cause })),
      Scope.provide(daemonScope),
    );
    yield* handle.unref.pipe(Effect.ignore);
    yield* writeEncryptedCredential({
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
      createdAt: now,
      updatedAt: now,
      appVersion: environment.appVersion,
      runtimeBuildId,
    };
    yield* writeMarker({ markerPath: environment.providerDaemonMarkerPath, marker });
    yield* Ref.set(state, {
      status: "starting",
      pid: Option.some(handle.pid),
      endpoint: Option.some(rootEndpoint),
      adoptedExistingProcess: false,
      terminate: Option.some(terminateExternalPid(handle.pid)),
      lastHealth: Option.none(),
      lastError: Option.none(),
      lastEnsureRunningDurationMs: Option.none(),
      lastAdoptionDurationMs: Option.none(),
      lastSpawnDurationMs: Option.none(),
      lastHealthRefreshDurationMs: Option.none(),
      healthRefreshCount: 0,
      healthRefreshFailureCount: 0,
    });
    yield* publishDebugSnapshot;

    const health = yield* waitForHealth(rootEndpoint).pipe(
      Effect.catch((error) =>
        handle
          .kill()
          .pipe(
            Effect.ignore,
            Effect.andThen(removeMarker(environment.providerDaemonMarkerPath)),
            Effect.andThen(removeCredential(environment.providerDaemonCredentialPath)),
            Effect.andThen(Effect.fail(error)),
          ),
      ),
    );
    const lease = yield* Effect.tryPromise({
      try: () => issueProviderDaemonLease(rootEndpoint),
      catch: (cause) => new ProviderDaemonHealthError({ cause }),
    }).pipe(
      Effect.mapError((cause) => new ProviderDaemonSpawnError({ cause })),
      Effect.catch((error) =>
        handle
          .kill()
          .pipe(
            Effect.ignore,
            Effect.andThen(removeMarker(environment.providerDaemonMarkerPath)),
            Effect.andThen(removeCredential(environment.providerDaemonCredentialPath)),
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
      lastSpawnDurationMs: Option.some(
        Math.round((performance.now() - spawnStartedAtMs) * 100) / 100,
      ),
    }));
    yield* publishDebugSnapshot;
    yield* logInfo("started provider daemon", {
      pid: handle.pid,
      endpoint: endpoint.httpBaseUrl,
      transport: endpoint.transport,
      runtimeBuildId,
    });
    yield* reapStaleProviderRuntimeProcesses([handle.pid, health.upstreamSupervisor?.pid]);
    return endpoint;
  });

  const ensureRunning = Effect.gen(function* () {
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

    const marker = yield* readMarker(environment.providerDaemonMarkerPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
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

  const currentConfig = Ref.get(state).pipe(Effect.map((current) => current.endpoint));

  const refreshHealth: Effect.Effect<Option.Option<ProviderDaemonHealthValue>> = Effect.gen(
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

      yield* Ref.update(state, (latest) => ({
        ...latest,
        status: "running" as const,
        lastHealth: Option.some(healthResult.success),
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

  const stop = Effect.gen(function* () {
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
    if (environment.platform !== "win32") {
      yield* Effect.tryPromise({
        try: () => fs.rm(providerDaemonIpcSocketPath(environment), { force: true }),
        catch: (cause) =>
          new ProviderDaemonIoError({ operation: "remove provider daemon ipc socket", cause }),
      }).pipe(Effect.ignore);
    }
    yield* reapStaleProviderRuntimeProcesses([]);
    yield* Ref.set(state, initialState);
    yield* publishDebugSnapshot;
  });

  const refreshRuntimeContext = yield* Effect.context<never>();
  const runRefreshHealth = Effect.runPromiseWith(refreshRuntimeContext);
  yield* DesktopDebugServer.setProviderDaemonDebugSnapshotRefresher(() =>
    runRefreshHealth(refreshHealth.pipe(Effect.asVoid)),
  );
  yield* publishDebugSnapshot;

  return {
    ensureRunning,
    currentConfig,
    refreshHealth,
    snapshot,
    stop,
  } satisfies DesktopProviderDaemonManagerShape;
});

export const layer = Layer.effect(DesktopProviderDaemonManager, makeDesktopProviderDaemonManager);
