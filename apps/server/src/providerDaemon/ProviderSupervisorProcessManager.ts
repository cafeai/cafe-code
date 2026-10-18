// @effect-diagnostics nodeBuiltinImport:off
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  PROVIDER_DAEMON_HEALTH_PATH,
  PROVIDER_DAEMON_LEASES_PATH,
  ProviderDaemonHealth,
  ProviderDaemonLeaseRequest,
  ProviderDaemonLeaseResponse,
  ProviderDaemonMarker,
  type ProviderDaemonClientConfig,
  type ProviderDaemonHealth as ProviderDaemonHealthValue,
  type ProviderDaemonLeaseResponse as ProviderDaemonLeaseResponseValue,
  type ProviderDaemonMarker as ProviderDaemonMarkerValue,
  type WindowsProcessIdentity,
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import { dataProfileIdentity } from "@cafecode/shared/dataProfileIdentity";
import {
  createWindowsProviderRuntime,
  spawnWindowsProviderRuntimeChild,
  WindowsProviderRuntimeError,
} from "@cafecode/shared/windowsProviderRuntime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { performance } from "node:perf_hooks";

import type { ServerConfigShape } from "../config.ts";

export const PROVIDER_SUPERVISOR_PROTOCOL_VERSION = 1;

const PROVIDER_RUNTIME_ENV_NAMES = [
  "CAFE_CODE_HOME",
  "CAFE_CODE_DATA_PROFILE",
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
  readonly windowsProcessIdentity?: WindowsProcessIdentity;
  readonly windowsOwnershipId?: string;
  readonly adoptedExistingProcess: boolean;
  readonly durationMs: number;
  readonly health: ProviderDaemonHealthValue;
}

export interface ProviderSupervisorProcessHandle {
  readonly endpoint: ProviderDaemonClientConfig;
  readonly snapshot: ProviderSupervisorProcessSnapshot;
}

/** Injection keeps native process creation/ownership out of default unit tests. */
export interface ProviderSupervisorProcessDependencies {
  readonly platform?: NodeJS.Platform;
  readonly createWindowsRuntime?: typeof createWindowsProviderRuntime;
  readonly spawnWindowsChild?: typeof spawnWindowsProviderRuntimeChild;
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

function supervisorIpcSocketPath(config: ServerConfigShape, platform = process.platform): string {
  if (platform === "win32") {
    const suffix = crypto.createHash("sha256").update(config.baseDir).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\cafecode-provider-supervisor-${suffix}`;
  }
  return path.join(supervisorIpcDir(config), "provider-supervisor.sock");
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
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
): Effect.Effect<Option.Option<ProviderDaemonMarkerValue>, ProviderSupervisorProcessError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await fs.readFile(markerPath, "utf8");
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
            return undefined;
          throw cause;
        }
      },
      catch: () =>
        new ProviderSupervisorProcessError({
          operation: "inspect supervisor marker",
          cause: "Ownership could not be inspected; all existing state was preserved.",
        }),
    });
    if (raw === undefined) return Option.none();
    const marker = yield* decodeProviderDaemonMarkerJson(raw).pipe(
      Effect.mapError(
        () =>
          new ProviderSupervisorProcessError({
            operation: "inspect supervisor marker",
            cause: "Ownership could not be decoded; all existing state was preserved.",
          }),
      ),
    );
    return Option.some(marker);
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

function providerRuntimeChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const name of PROVIDER_RUNTIME_ENV_NAMES) {
    delete env[name];
  }
  return env;
}

const ensureWindowsProviderSupervisorProcess = (
  input: {
    readonly config: ServerConfigShape;
    readonly version: string;
    readonly runtimeBuildId?: string;
  },
  dependencies: ProviderSupervisorProcessDependencies,
): Effect.Effect<ProviderSupervisorProcessHandle, ProviderSupervisorProcessError> =>
  Effect.tryPromise({
    try: async () => {
      const startedAtMs = performance.now();
      const socketPath = supervisorIpcSocketPath(input.config, "win32");
      // Construct first: its synchronous profile/namespace admission must reject
      // malformed bootstrap intent before even creating candidate directories.
      const runtime = (dependencies.createWindowsRuntime ?? createWindowsProviderRuntime)({
        role: "provider-supervisor",
        markerPath: supervisorMarkerPath(input.config),
        legacyCredentialPath: supervisorCredentialPath(input.config),
        socketPath,
        appVersion: input.version,
        protocolVersion: PROVIDER_SUPERVISOR_PROTOCOL_VERSION,
        ...(input.runtimeBuildId === undefined ? {} : { runtimeBuildId: input.runtimeBuildId }),
        ...(input.config.dataProfile === undefined
          ? {}
          : {
              dataProfile: input.config.dataProfile,
              dataProfileId: dataProfileIdentity(input.config.dataProfile, input.config.baseDir),
            }),
        bootstrap: {
          cafeCodeHome: input.config.baseDir,
          ...(input.config.dataProfile === undefined
            ? {}
            : {
                dataProfile: input.config.dataProfile,
                configuredCafeCodeHome: input.config.configuredBaseDir,
              }),
          ...(input.config.otlpTracesUrl === undefined
            ? {}
            : { otlpTracesUrl: input.config.otlpTracesUrl }),
          ...(input.config.otlpMetricsUrl === undefined
            ? {}
            : { otlpMetricsUrl: input.config.otlpMetricsUrl }),
        },
        encodeCredential: async (token) => ({
          base64: Buffer.from(`${token}\n`, "utf8").toString("base64"),
          encrypted: false,
        }),
        decodeCredential: async (base64, encrypted) => {
          // Server-owned supervisor tokens are already private plaintext files;
          // the backend cannot decrypt Electron safeStorage credentials. Never
          // reinterpret ciphertext as a token or rotate it on decode failure.
          if (encrypted) throw new Error("Supervisor credential format unavailable.");
          return Buffer.from(base64, "base64").toString("utf8").trim();
        },
        spawn: (bootstrap) => {
          const entrypoint = process.argv[1];
          if (!entrypoint)
            return Promise.reject(new Error("Provider supervisor entrypoint unavailable."));
          // Shared direct-child admission has no PID-based kill or automatic
          // scope finalizer; bootstrap failure retains its prepared generation.
          return (dependencies.spawnWindowsChild ?? spawnWindowsProviderRuntimeChild)({
            executable: process.execPath,
            entrypoint,
            cwd: input.config.cwd,
            env: providerRuntimeChildEnv(),
            bootstrap,
          });
        },
        // Use the shared Windows controller's bounded health/lease transport:
        // it enforces an absolute deadline and response byte cap. The legacy
        // POSIX helpers below have socket-idle timeouts only; injecting them
        // here could let a dribbling peer outlive the native guard deadline.
      });
      // The helper additionally validates/pins native ancestry before any
      // ownership-file operation; directory creation alone grants no authority.
      await fs.mkdir(input.config.stateDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(input.config.secretsDir, { recursive: true, mode: 0o700 });
      const result = await runtime.ensure();
      if (input.config.dataProfile !== undefined) {
        const expectedId = dataProfileIdentity(input.config.dataProfile, input.config.baseDir);
        if (
          result.marker.dataProfile !== input.config.dataProfile ||
          result.marker.dataProfileId !== expectedId ||
          result.health.dataProfile !== input.config.dataProfile ||
          result.health.dataProfileId !== expectedId
        ) {
          throw new WindowsProviderRuntimeError("profile-mismatch");
        }
      }
      return {
        endpoint: result.endpoint,
        snapshot: {
          status: result.adopted ? "adopted" : "spawned",
          pid: result.marker.pid,
          endpoint: sanitizeEndpoint(result.endpoint, result.endpoint.leaseId),
          markerPath: supervisorMarkerPath(input.config),
          credentialPath: result.marker.credentialPath ?? supervisorCredentialPath(input.config),
          appVersion: result.marker.appVersion,
          protocolVersion: PROVIDER_SUPERVISOR_PROTOCOL_VERSION,
          ...(input.runtimeBuildId === undefined ? {} : { runtimeBuildId: input.runtimeBuildId }),
          adoptedExistingProcess: result.adopted,
          ...(result.marker.windowsProcessIdentity === undefined
            ? {}
            : { windowsProcessIdentity: result.marker.windowsProcessIdentity }),
          ...(result.marker.windowsOwnershipId === undefined
            ? {}
            : { windowsOwnershipId: result.marker.windowsOwnershipId }),
          durationMs: Math.round((performance.now() - startedAtMs) * 100) / 100,
          health: result.health,
        },
      };
    },
    // Shared/native failures may carry private transport or credential material.
    // Uncertainty must preserve ownership and never fall into POSIX cleanup.
    catch: (error) =>
      new ProviderSupervisorProcessError({
        operation: "Windows supervisor ownership",
        cause:
          error instanceof WindowsProviderRuntimeError
            ? new WindowsProviderRuntimeError(error.reason).message
            : "Provider supervisor ownership could not be verified. Existing processes and ownership records were preserved.",
      }),
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
    const refuse = (phase: string) =>
      new ProviderSupervisorProcessError({
        operation: "adopt supervisor",
        cause: `Existing supervisor ${phase} could not be qualified; its process and recovery files were preserved.`,
      });
    const profile = input.config.dataProfile;
    const profileId =
      profile === undefined ? undefined : dataProfileIdentity(profile, input.config.baseDir);
    if (
      profile === undefined ||
      marker.dataProfile !== profile ||
      marker.dataProfileId !== profileId ||
      marker.mode !== "provider-supervisor"
    )
      return yield* refuse("profile");
    const transport = marker.transport ?? "tcp";
    const hasValidEndpoint =
      transport === "ipc"
        ? typeof marker.socketPath === "string" && marker.socketPath.length > 0
        : isLoopbackEndpoint(marker.httpBaseUrl);
    if (
      !hasValidEndpoint ||
      (transport === "ipc" && marker.socketPath !== supervisorIpcSocketPath(input.config)) ||
      (marker.credentialPath ?? supervisorCredentialPath(input.config)) !==
        supervisorCredentialPath(input.config)
    )
      return yield* refuse("namespace");
    if (!isPidAlive(marker.pid)) return yield* refuse("native liveness");
    if (
      marker.appVersion !== input.version ||
      marker.protocolVersion !== PROVIDER_SUPERVISOR_PROTOCOL_VERSION ||
      marker.runtimeBuildId !== input.runtimeBuildId
    ) {
      return yield* refuse("compatibility");
    }

    const token = yield* readCredential(
      marker.credentialPath ?? supervisorCredentialPath(input.config),
    );
    if (Option.isNone(token)) {
      return yield* refuse("credential");
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
      health.value.runtimeBuildId !== input.runtimeBuildId ||
      health.value.dataProfile !== profile ||
      health.value.dataProfileId !== profileId
    ) {
      return yield* refuse("authenticated profile/health");
    }

    const lease = yield* Effect.tryPromise({
      try: () => issueProviderSupervisorLease(rootEndpoint),
      catch: () => refuse("lease"),
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

export const ensureProviderSupervisorProcess = (
  input: {
    readonly config: ServerConfigShape;
    readonly version: string;
    readonly runtimeBuildId?: string;
  },
  dependencies: ProviderSupervisorProcessDependencies = {},
): Effect.Effect<ProviderSupervisorProcessHandle, ProviderSupervisorProcessError> =>
  Effect.gen(function* () {
    // This early boundary is intentional: none of the legacy error-to-absence,
    // unlink, process.kill, or detached-child failure cleanup may execute on
    // Windows. Its existing native guard retains sole ownership authority.
    if ((dependencies.platform ?? process.platform) === "win32") {
      return yield* ensureWindowsProviderSupervisorProcess(input, dependencies);
    }
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

    // Automatic supervisor handoff is already disabled by CLI policy. Its old
    // POSIX spawn returned only a PID and could leave an unmarked live writer
    // after publication failure. Do not expose that latent fallback through a
    // profile change: a fresh POSIX supervisor requires a separately qualified
    // durable native-handle handoff, not a guessed PID or a new retry budget.
    return yield* new ProviderSupervisorProcessError({
      operation: "POSIX supervisor capability",
      cause:
        "Fresh provider supervisor handoff is not supported on this host. No process or ownership files were created; use the existing provider daemon path.",
    });
  });
