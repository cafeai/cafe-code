// @effect-diagnostics nodeBuiltinImport:off
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  PROVIDER_DAEMON_HEALTH_PATH,
  PROVIDER_DAEMON_LEASES_PATH,
  ProviderDaemonBootstrap,
  ProviderDaemonHealth,
  ProviderDaemonLeaseRequest,
  ProviderDaemonLeaseResponse,
  ProviderDaemonMarker,
  type ProviderDaemonBootstrap as ProviderDaemonBootstrapValue,
  type ProviderDaemonClientConfig,
  type ProviderDaemonHealth as ProviderDaemonHealthValue,
  type ProviderDaemonLeaseResponse as ProviderDaemonLeaseResponseValue,
  type ProviderDaemonMarker as ProviderDaemonMarkerValue,
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { performance } from "node:perf_hooks";

import type { ServerConfigShape } from "../config.ts";

const PROVIDER_SUPERVISOR_READINESS_TIMEOUT_MS = 30_000;
const PROVIDER_SUPERVISOR_READINESS_INTERVAL_MS = 100;
export const PROVIDER_SUPERVISOR_PROTOCOL_VERSION = 1;

const PROVIDER_RUNTIME_ENV_NAMES = [
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
  "CAFE_CODE_TAILSCALE_SERVE",
  "CAFE_CODE_TAILSCALE_SERVE_PORT",
  "VITE_DEV_SERVER_URL",
] as const;

const encodeProviderDaemonBootstrapJson = Schema.encodeSync(
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

class ProviderSupervisorProcessError extends Data.TaggedError("ProviderSupervisorProcessError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `${this.operation}: ${detail}`;
  }
}

export interface ProviderSupervisorProcessSnapshot {
  readonly status: "adopted" | "spawned";
  readonly pid: number;
  readonly endpoint: {
    readonly httpBaseUrl: string;
    readonly transport: "tcp" | "ipc";
    readonly socketPath: string | null;
    readonly leaseId: string | null;
  };
  readonly markerPath: string;
  readonly credentialPath: string;
  readonly appVersion: string;
  readonly protocolVersion: number;
  readonly runtimeBuildId?: string;
  readonly adoptedExistingProcess: boolean;
  readonly durationMs: number;
  readonly health: ProviderDaemonHealthValue;
}

export interface ProviderSupervisorProcessHandle {
  readonly endpoint: ProviderDaemonClientConfig;
  readonly snapshot: ProviderSupervisorProcessSnapshot;
}

function supervisorMarkerPath(config: ServerConfigShape): string {
  return path.join(config.stateDir, "provider-supervisor.json");
}

function supervisorCredentialPath(config: ServerConfigShape): string {
  return path.join(config.secretsDir, "provider-supervisor-token");
}

function supervisorIpcDir(config: ServerConfigShape): string {
  return path.join(config.stateDir, "provider-supervisor-ipc");
}

function supervisorIpcSocketPath(config: ServerConfigShape): string {
  if (process.platform === "win32") {
    const suffix = crypto.createHash("sha256").update(config.baseDir).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\cafecode-provider-supervisor-${suffix}`;
  }
  return path.join(supervisorIpcDir(config), "provider-supervisor.sock");
}

function makeProviderSupervisorToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
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

const terminatePid = (pid: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (pid <= 0 || pid === process.pid || !isPidAlive(pid)) {
      return;
    }
    if (!signalPid(pid, "SIGTERM")) {
      return;
    }
    if (yield* waitForPidExit(pid, 750)) {
      return;
    }
    if (!signalPid(pid, "SIGKILL")) {
      return;
    }
    yield* waitForPidExit(pid, 750);
  });

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

function sanitizeEndpoint(
  endpoint: ProviderDaemonClientConfig,
  leaseId: string | undefined,
): ProviderSupervisorProcessSnapshot["endpoint"] {
  return {
    httpBaseUrl: endpoint.httpBaseUrl,
    transport: endpoint.transport ?? "tcp",
    socketPath: endpoint.socketPath ?? null,
    leaseId: leaseId ?? null,
  };
}

async function fetchProviderSupervisorHealth(
  endpoint: ProviderDaemonClientConfig,
): Promise<ProviderDaemonHealthValue> {
  const response = await requestProviderDaemonJson(endpoint, PROVIDER_DAEMON_HEALTH_PATH, {
    timeoutMs: 5_000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`provider supervisor health failed with HTTP ${response.statusCode}`);
  }
  const health = decodeProviderDaemonHealthJson(response.body);
  if (health.mode !== "provider-supervisor") {
    throw new Error(`provider supervisor endpoint reported mode ${health.mode}`);
  }
  return health;
}

async function issueProviderSupervisorLease(
  endpoint: ProviderDaemonClientConfig,
): Promise<ProviderDaemonLeaseResponseValue> {
  const response = await requestProviderDaemonJson(endpoint, PROVIDER_DAEMON_LEASES_PATH, {
    method: "POST",
    body: encodeProviderDaemonLeaseRequestJson({
      clientKind: "provider-daemon",
      capabilities: ["health", "events", "rpc", "lease"],
    }),
    timeoutMs: 5_000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`provider supervisor lease failed with HTTP ${response.statusCode}`);
  }
  return decodeProviderDaemonLeaseResponseJson(response.body);
}

const readMarker = (
  markerPath: string,
): Effect.Effect<Option.Option<ProviderDaemonMarkerValue>, never> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await fs.readFile(markerPath, "utf8");
      return raw;
    },
    catch: () => undefined,
  }).pipe(
    Effect.option,
    Effect.flatMap((raw) =>
      Option.isNone(raw)
        ? Effect.succeed(Option.none<ProviderDaemonMarkerValue>())
        : decodeProviderDaemonMarkerJson(raw.value).pipe(
            Effect.option,
            Effect.map((parsed) =>
              Option.isSome(parsed) ? Option.some(parsed.value) : Option.none(),
            ),
          ),
    ),
  );

const writeMarker = (input: {
  readonly markerPath: string;
  readonly marker: ProviderDaemonMarkerValue;
}): Effect.Effect<void, ProviderSupervisorProcessError> =>
  Effect.tryPromise({
    try: async () => {
      const temporaryPath = `${input.markerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(input.markerPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(temporaryPath, `${encodeProviderDaemonMarkerJson(input.marker)}\n`, {
        mode: 0o600,
      });
      await fs.rename(temporaryPath, input.markerPath);
      await fs.chmod(input.markerPath, 0o600);
    },
    catch: (cause) => new ProviderSupervisorProcessError({ operation: "write marker", cause }),
  });

const writeCredential = (input: {
  readonly credentialPath: string;
  readonly token: string;
}): Effect.Effect<void, ProviderSupervisorProcessError> =>
  Effect.tryPromise({
    try: async () => {
      const temporaryPath = `${input.credentialPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(input.credentialPath), { recursive: true, mode: 0o700 });
      await fs.chmod(path.dirname(input.credentialPath), 0o700);
      await fs.writeFile(temporaryPath, `${input.token}\n`, { mode: 0o600 });
      await fs.rename(temporaryPath, input.credentialPath);
      await fs.chmod(input.credentialPath, 0o600);
    },
    catch: (cause) => new ProviderSupervisorProcessError({ operation: "write credential", cause }),
  });

const readCredential = (credentialPath: string): Effect.Effect<Option.Option<string>, never> =>
  Effect.tryPromise({
    try: async () => (await fs.readFile(credentialPath, "utf8")).trim(),
    catch: () => undefined,
  }).pipe(
    Effect.option,
    Effect.map((token) =>
      Option.isSome(token) && token.value.length >= 32 ? Option.some(token.value) : Option.none(),
    ),
  );

const removeSupervisorFiles = (config: ServerConfigShape): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      await fs.rm(supervisorMarkerPath(config), { force: true });
      await fs.rm(supervisorCredentialPath(config), { force: true });
      if (process.platform !== "win32") {
        await fs.rm(supervisorIpcSocketPath(config), { force: true });
      }
    },
    catch: () => undefined,
  }).pipe(Effect.ignore);

const prepareSupervisorIpcPath = (
  config: ServerConfigShape,
): Effect.Effect<string, ProviderSupervisorProcessError> =>
  Effect.tryPromise({
    try: async () => {
      const socketPath = supervisorIpcSocketPath(config);
      if (process.platform !== "win32") {
        const ipcDir = supervisorIpcDir(config);
        await fs.mkdir(ipcDir, { recursive: true, mode: 0o700 });
        await fs.chmod(ipcDir, 0o700);
        await fs.rm(socketPath, { force: true });
      }
      return socketPath;
    },
    catch: (cause) => new ProviderSupervisorProcessError({ operation: "prepare ipc", cause }),
  });

const waitForSupervisorHealth = (
  endpoint: ProviderDaemonClientConfig,
): Effect.Effect<ProviderDaemonHealthValue, ProviderSupervisorProcessError> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    let lastError: unknown = undefined;
    while (
      (yield* Clock.currentTimeMillis) - startedAt <
      PROVIDER_SUPERVISOR_READINESS_TIMEOUT_MS
    ) {
      const healthResult = yield* Effect.tryPromise({
        try: () => fetchProviderSupervisorHealth(endpoint),
        catch: (cause) =>
          new ProviderSupervisorProcessError({ operation: "health readiness", cause }),
      }).pipe(Effect.result);
      if (healthResult._tag === "Success") {
        return healthResult.success;
      }
      lastError = healthResult.failure;
      yield* Effect.sleep(Duration.millis(PROVIDER_SUPERVISOR_READINESS_INTERVAL_MS));
    }
    return yield* new ProviderSupervisorProcessError({
      operation: "health readiness",
      cause: lastError ?? new Error("Provider supervisor did not become ready before timeout."),
    });
  });

function providerRuntimeChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const name of PROVIDER_RUNTIME_ENV_NAMES) {
    delete env[name];
  }
  return env;
}

const spawnDetachedSupervisor = (input: {
  readonly config: ServerConfigShape;
  readonly socketPath: string;
  readonly token: string;
  readonly runtimeBuildId?: string;
}): Effect.Effect<number, ProviderSupervisorProcessError> =>
  Effect.try({
    try: () => {
      const backendEntryPath = process.argv[1];
      if (backendEntryPath === undefined || backendEntryPath.length === 0) {
        throw new Error("Unable to determine provider supervisor backend entry path.");
      }
      const bootstrap = {
        mode: "provider-supervisor",
        transport: "ipc",
        socketPath: input.socketPath,
        cafeCodeHome: input.config.baseDir,
        token: input.token,
        ...(input.runtimeBuildId !== undefined ? { runtimeBuildId: input.runtimeBuildId } : {}),
        ...(input.config.otlpTracesUrl === undefined
          ? {}
          : { otlpTracesUrl: input.config.otlpTracesUrl }),
        ...(input.config.otlpMetricsUrl === undefined
          ? {}
          : { otlpMetricsUrl: input.config.otlpMetricsUrl }),
      } satisfies ProviderDaemonBootstrapValue;
      const bootstrapJson = encodeProviderDaemonBootstrapJson(bootstrap);
      const child = spawn(
        process.execPath,
        [backendEntryPath, "provider-supervisor", "--bootstrap-fd", "3"],
        {
          cwd: input.config.cwd,
          detached: true,
          env: providerRuntimeChildEnv(),
          stdio: ["ignore", "ignore", "ignore", "pipe"],
        },
      );
      const bootstrapStream = child.stdio[3];
      if (bootstrapStream === null || bootstrapStream === undefined) {
        child.kill("SIGTERM");
        throw new Error("Provider supervisor bootstrap fd was not available.");
      }
      (bootstrapStream as NodeJS.WritableStream).end(`${bootstrapJson}\n`);
      child.unref();
      if (child.pid === undefined) {
        throw new Error("Provider supervisor process did not expose a PID.");
      }
      return child.pid;
    },
    catch: (cause) => new ProviderSupervisorProcessError({ operation: "spawn supervisor", cause }),
  });

const adoptSupervisor = (input: {
  readonly config: ServerConfigShape;
  readonly marker: ProviderDaemonMarkerValue;
  readonly version: string;
  readonly runtimeBuildId?: string;
  readonly startedAtMs: number;
}): Effect.Effect<Option.Option<ProviderSupervisorProcessHandle>, ProviderSupervisorProcessError> =>
  Effect.gen(function* () {
    const marker = input.marker;
    const transport = marker.transport ?? "tcp";
    const hasValidEndpoint =
      transport === "ipc"
        ? typeof marker.socketPath === "string" && marker.socketPath.length > 0
        : isLoopbackEndpoint(marker.httpBaseUrl);
    if (marker.mode !== "provider-supervisor" || !hasValidEndpoint || !isPidAlive(marker.pid)) {
      yield* removeSupervisorFiles(input.config);
      return Option.none();
    }
    if (
      marker.appVersion !== input.version ||
      marker.protocolVersion !== PROVIDER_SUPERVISOR_PROTOCOL_VERSION ||
      marker.runtimeBuildId !== input.runtimeBuildId
    ) {
      yield* Effect.logWarning("provider supervisor marker is incompatible with provider daemon", {
        supervisorPid: marker.pid,
        markerAppVersion: marker.appVersion,
        providerDaemonAppVersion: input.version,
        markerProtocolVersion: marker.protocolVersion ?? null,
        expectedProtocolVersion: PROVIDER_SUPERVISOR_PROTOCOL_VERSION,
        markerRuntimeBuildId: marker.runtimeBuildId ?? null,
        expectedRuntimeBuildId: input.runtimeBuildId ?? null,
      });
      yield* terminatePid(marker.pid);
      yield* removeSupervisorFiles(input.config);
      return Option.none();
    }

    const token = yield* readCredential(
      marker.credentialPath ?? supervisorCredentialPath(input.config),
    );
    if (Option.isNone(token)) {
      yield* removeSupervisorFiles(input.config);
      return Option.none();
    }

    const rootEndpoint = markerEndpoint(marker, token.value);
    const health = yield* Effect.tryPromise({
      try: () => fetchProviderSupervisorHealth(rootEndpoint),
      catch: (cause) =>
        new ProviderSupervisorProcessError({ operation: "adopt supervisor health", cause }),
    }).pipe(Effect.option);
    if (
      Option.isNone(health) ||
      health.value.pid !== marker.pid ||
      health.value.version !== input.version ||
      health.value.protocolVersion !== PROVIDER_SUPERVISOR_PROTOCOL_VERSION ||
      health.value.runtimeBuildId !== input.runtimeBuildId
    ) {
      yield* terminatePid(marker.pid);
      yield* removeSupervisorFiles(input.config);
      return Option.none();
    }

    const lease = yield* Effect.tryPromise({
      try: () => issueProviderSupervisorLease(rootEndpoint),
      catch: (cause) =>
        new ProviderSupervisorProcessError({ operation: "adopt supervisor lease", cause }),
    });
    const endpoint: ProviderDaemonClientConfig = {
      ...rootEndpoint,
      token: lease.token,
      leaseId: lease.leaseId,
    };
    return Option.some({
      endpoint,
      snapshot: {
        status: "adopted",
        pid: marker.pid,
        endpoint: sanitizeEndpoint(endpoint, lease.leaseId),
        markerPath: supervisorMarkerPath(input.config),
        credentialPath: marker.credentialPath ?? supervisorCredentialPath(input.config),
        appVersion: marker.appVersion,
        protocolVersion: PROVIDER_SUPERVISOR_PROTOCOL_VERSION,
        ...(input.runtimeBuildId !== undefined ? { runtimeBuildId: input.runtimeBuildId } : {}),
        adoptedExistingProcess: true,
        durationMs: Math.round((performance.now() - input.startedAtMs) * 100) / 100,
        health: health.value,
      },
    });
  });

const spawnSupervisor = (input: {
  readonly config: ServerConfigShape;
  readonly version: string;
  readonly runtimeBuildId?: string;
  readonly startedAtMs: number;
}): Effect.Effect<ProviderSupervisorProcessHandle, ProviderSupervisorProcessError> =>
  Effect.gen(function* () {
    const socketPath = yield* prepareSupervisorIpcPath(input.config);
    const token = makeProviderSupervisorToken();
    const rootEndpoint: ProviderDaemonClientConfig = {
      httpBaseUrl: "http://provider-supervisor.local",
      transport: "ipc",
      socketPath,
      token,
    };
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* writeCredential({
      credentialPath: supervisorCredentialPath(input.config),
      token,
    });

    const pid = yield* spawnDetachedSupervisor({
      config: input.config,
      socketPath,
      token,
      ...(input.runtimeBuildId !== undefined ? { runtimeBuildId: input.runtimeBuildId } : {}),
    }).pipe(
      Effect.catch((error) =>
        removeSupervisorFiles(input.config).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );

    yield* writeMarker({
      markerPath: supervisorMarkerPath(input.config),
      marker: {
        version: 2,
        mode: "provider-supervisor",
        protocolVersion: PROVIDER_SUPERVISOR_PROTOCOL_VERSION,
        pid,
        ppid: process.pid,
        transport: "ipc",
        httpBaseUrl: rootEndpoint.httpBaseUrl,
        socketPath,
        credentialPath: supervisorCredentialPath(input.config),
        createdAt: now,
        updatedAt: now,
        appVersion: input.version,
        ...(input.runtimeBuildId !== undefined ? { runtimeBuildId: input.runtimeBuildId } : {}),
      },
    });

    const health = yield* waitForSupervisorHealth(rootEndpoint).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // The supervisor exited while startup was already failing.
          }
        }).pipe(
          Effect.andThen(removeSupervisorFiles(input.config)),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
    const lease = yield* Effect.tryPromise({
      try: () => issueProviderSupervisorLease(rootEndpoint),
      catch: (cause) =>
        new ProviderSupervisorProcessError({ operation: "spawn supervisor lease", cause }),
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // The supervisor exited while startup was already failing.
          }
        }).pipe(
          Effect.andThen(removeSupervisorFiles(input.config)),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
    const endpoint: ProviderDaemonClientConfig = {
      ...rootEndpoint,
      token: lease.token,
      leaseId: lease.leaseId,
    };
    return {
      endpoint,
      snapshot: {
        status: "spawned",
        pid,
        endpoint: sanitizeEndpoint(endpoint, lease.leaseId),
        markerPath: supervisorMarkerPath(input.config),
        credentialPath: supervisorCredentialPath(input.config),
        appVersion: input.version,
        protocolVersion: PROVIDER_SUPERVISOR_PROTOCOL_VERSION,
        ...(input.runtimeBuildId !== undefined ? { runtimeBuildId: input.runtimeBuildId } : {}),
        adoptedExistingProcess: false,
        durationMs: Math.round((performance.now() - input.startedAtMs) * 100) / 100,
        health,
      },
    };
  });

export const ensureProviderSupervisorProcess = (input: {
  readonly config: ServerConfigShape;
  readonly version: string;
  readonly runtimeBuildId?: string;
}): Effect.Effect<ProviderSupervisorProcessHandle, ProviderSupervisorProcessError> =>
  Effect.gen(function* () {
    const startedAtMs = performance.now();
    const marker = yield* readMarker(supervisorMarkerPath(input.config));
    if (Option.isSome(marker)) {
      const adopted = yield* adoptSupervisor({
        config: input.config,
        marker: marker.value,
        version: input.version,
        ...(input.runtimeBuildId !== undefined ? { runtimeBuildId: input.runtimeBuildId } : {}),
        startedAtMs,
      });
      if (Option.isSome(adopted)) {
        return adopted.value;
      }
    }

    return yield* spawnSupervisor({
      config: input.config,
      version: input.version,
      ...(input.runtimeBuildId !== undefined ? { runtimeBuildId: input.runtimeBuildId } : {}),
      startedAtMs,
    });
  });
