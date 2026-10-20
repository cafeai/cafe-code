import * as DateTime from "effect/DateTime";
// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  PROVIDER_DAEMON_HEALTH_PATH,
  PROVIDER_DAEMON_LIVENESS_PATH,
  ProviderDaemonHealth,
  ProviderDaemonLiveness,
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import { dataProfileIdentity } from "@cafecode/shared/dataProfileIdentity";
import type { ProviderDaemonStartupProgress } from "@cafecode/shared/backendStartupProgress";
import { CAFE_CODE_SHELL_ENV_HYDRATED } from "@cafecode/shared/shell";
import {
  createWindowsProviderRuntime,
  spawnWindowsProviderRuntimeChild,
  WindowsProviderRuntimeError,
  type WindowsProviderRuntime,
  type WindowsProviderRuntimeOptions,
  type WindowsProviderRuntimeResult,
} from "@cafecode/shared/windowsProviderRuntime";
import * as Data from "effect/Data";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { DesktopEnvironmentShape } from "../app/DesktopEnvironment.ts";
import * as DesktopDebugServer from "../debug/DesktopDebugServer.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import type {
  DesktopProviderDaemonManagerShape,
  DesktopProviderDaemonSnapshot,
} from "./DesktopProviderDaemonManager.ts";

const unavailable =
  "Windows provider daemon ownership could not be verified; existing processes and recovery evidence were preserved. Retry connection.";
/** Preserve the existing sanitized native message, never the received cause. */
class WindowsDesktopProviderDaemonError extends Data.TaggedError(
  "WindowsDesktopProviderDaemonError",
)<{
  readonly message: string;
}> {
  constructor(input: { readonly message: string }) {
    super(input);
    // The finite tag gives Effect a typed channel without changing existing
    // native error-name presentation or the sanitized message.
    this.name = "Error";
  }
}
const decodeHealth = Schema.decodeUnknownSync(ProviderDaemonHealth);
const decodeHealthJson = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderDaemonHealth));
const decodeLiveness = Schema.decodeUnknownSync(ProviderDaemonLiveness);

/** Update preflight never exports a native/transport error or its private input. */
class WindowsProviderDaemonUpdatePreparationError extends Data.TaggedError(
  "WindowsProviderDaemonUpdatePreparationError",
)<{}> {
  override get message() {
    return "The provider daemon could not be safely prepared for this update. Its process and recovery files were preserved. Keep Cafe Code open and stop the owning runtime explicitly before retrying the update.";
  }
}

// Never trust a response from a different owner or profile. Native generation
// and birth identity remain independent proof; neither substitutes for the
// exact actual-opening profile receipt required by this desktop adapter.
const matches = (
  result: WindowsProviderRuntimeResult,
  health: ProviderDaemonLiveness | ProviderDaemonHealth,
  profile: { readonly dataProfile: "production" | "debug"; readonly dataProfileId: string },
) =>
  result.marker.dataProfile === profile.dataProfile &&
  result.marker.dataProfileId === profile.dataProfileId &&
  health.dataProfile === profile.dataProfile &&
  health.dataProfileId === profile.dataProfileId &&
  health.pid === result.marker.pid &&
  health.mode === "provider-daemon" &&
  (result.marker.windowsOwnershipId === undefined ||
    (health.windowsOwnershipId === result.marker.windowsOwnershipId &&
      health.windowsProcessIdentity?.pid === result.marker.windowsProcessIdentity?.pid &&
      health.windowsProcessIdentity?.creationTime100ns ===
        result.marker.windowsProcessIdentity?.creationTime100ns));

/** Injectable boundary: ordinary tests never launch PowerShell or live providers. */
export interface WindowsDesktopProviderDaemonDependencies {
  readonly createRuntime?: typeof createWindowsProviderRuntime;
  readonly requestJson?: typeof requestProviderDaemonJson;
}

/**
 * Thin Electron adapter around the shared Windows authority model. The shared
 * controller owns child admission, interprocess fencing and native termination;
 * this adapter owns SafeStorage and the existing desktop/debug Effect surface.
 * It is constructed only by the explicit Windows branch in the desktop layer.
 */
export const makeWindowsDesktopProviderDaemonManager = Effect.fn(function* (
  environment: DesktopEnvironmentShape,
  runtimeBuildId: string,
  dependencies: WindowsDesktopProviderDaemonDependencies = {},
) {
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const profile = {
    dataProfile: environment.dataProfile,
    dataProfileId: dataProfileIdentity(environment.dataProfile, environment.baseDir),
  };
  const mutex = yield* Semaphore.make(1);
  // A single sanitized replay frame lets the inert startup window attach after
  // spawning. Sliding capacity bounds observers without delaying ownership.
  const startupUpdates = yield* PubSub.sliding<ProviderDaemonStartupProgress>({
    capacity: 8,
    replay: 1,
  });
  yield* Effect.addFinalizer(() => PubSub.shutdown(startupUpdates));
  let cafeMcpPort: number | undefined;
  const requestJson = dependencies.requestJson ?? requestProviderDaemonJson;
  const initial: DesktopProviderDaemonSnapshot = {
    status: "idle",
    pid: Option.none(),
    endpoint: Option.none(),
    adoptedExistingProcess: false,
    lastHealth: Option.none(),
    lastError: Option.none(),
    markerPath: environment.providerDaemonMarkerPath,
    credentialPath: environment.providerDaemonCredentialPath,
    runtimeBuildId,
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
  const state = yield* Ref.make(initial);
  let lastHealthObservedAt: string | null = null;
  const createRuntime = dependencies.createRuntime ?? createWindowsProviderRuntime;
  let supervisorRuntime: WindowsProviderRuntime | undefined;
  const runtimeOptions: WindowsProviderRuntimeOptions = {
    role: "provider-daemon",
    markerPath: environment.providerDaemonMarkerPath,
    legacyCredentialPath: environment.providerDaemonCredentialPath,
    socketPath: `\\\\.\\pipe\\cafecode-provider-daemon-${createHash("sha256").update(environment.baseDir).digest("hex").slice(0, 24)}`,
    appVersion: environment.appVersion,
    protocolVersion: 1,
    runtimeBuildId,
    ...profile,
    cafeMcpPort: () => cafeMcpPort,
    bootstrap: {
      cafeCodeHome: environment.baseDir,
      configuredCafeCodeHome: environment.configuredBaseDir,
      dataProfile: environment.dataProfile,
      ...Option.match(environment.otlpTracesUrl, {
        onNone: () => ({}),
        onSome: (otlpTracesUrl) => ({ otlpTracesUrl }),
      }),
    },
    encodeCredential: async (token) => {
      // Preserve the existing desktop encryption policy. The native helper
      // receives opaque bytes over stdin and never places them in argv/logs.
      const canEncrypt = await run(
        safeStorage.isEncryptionAvailable.pipe(Effect.orElseSucceed(() => false)),
      );
      if (canEncrypt) {
        const encrypted = await run(safeStorage.encryptString(token).pipe(Effect.option));
        if (Option.isSome(encrypted))
          return { base64: Buffer.from(encrypted.value).toString("base64"), encrypted: true };
      }
      return { base64: Buffer.from(token, "utf8").toString("base64"), encrypted: false };
    },
    decodeCredential: async (base64, encrypted) => {
      const bytes = Buffer.from(base64, "base64");
      return encrypted ? run(safeStorage.decryptString(bytes)) : bytes.toString("utf8");
    },
    onStartupProgress: (progress) => {
      Effect.runSync(PubSub.publish(startupUpdates, progress));
    },
    spawn: (bootstrap, startupProgress) => {
      const childEnvironment = { ...process.env };
      for (const name of [
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
      ])
        delete childEnvironment[name];
      return spawnWindowsProviderRuntimeChild({
        executable: process.execPath,
        entrypoint: environment.backendEntryPath,
        cwd: environment.backendCwd,
        env: {
          ...childEnvironment,
          ELECTRON_RUN_AS_NODE: "1",
          [CAFE_CODE_SHELL_ENV_HYDRATED]: "1",
        },
        bootstrap,
        ...(startupProgress === undefined ? {} : { startupProgress }),
      });
    },
    stopSupervisor: async (owner) => {
      // The detached daemon CLI always resolves its own data beneath userdata,
      // independently of Electron's development settings directory. Do not use
      // an upstream PID/path from health to locate or kill the other role.
      // The shared controller releases the daemon guard before this callback
      // and rechecks its exact revision afterward, preventing cross-role locks.
      supervisorRuntime ??= createRuntime({
        ...runtimeOptions,
        role: "provider-supervisor",
        markerPath: path.join(environment.baseDir, "userdata", "provider-supervisor.json"),
        legacyCredentialPath: path.join(
          environment.baseDir,
          "userdata",
          "secrets",
          "provider-supervisor-token",
        ),
        socketPath: `\\\\.\\pipe\\cafecode-provider-supervisor-${createHash("sha256").update(environment.baseDir).digest("hex").slice(0, 24)}`,
        cafeMcpPort: () => undefined,
        encodeCredential: async (token) => ({
          base64: Buffer.from(token, "utf8").toString("base64"),
          encrypted: false,
        }),
        decodeCredential: async (base64, encrypted) => {
          // Standalone supervisors never use Electron's keyring. Unexpected
          // encryption metadata is uncertainty, not permission to rotate it.
          if (encrypted) throw new WindowsProviderRuntimeError("credential-unavailable");
          // The standalone supervisor persists the token as a text line.
          // Its newline is not part of the HTTP bearer credential.
          return Buffer.from(base64, "base64").toString("utf8").trim();
        },
      });
      // stop does not spawn an absent supervisor. Both the authenticated
      // generation and native birth identity are rechecked under its own guard.
      await supervisorRuntime.stop(owner.ownershipId, owner.identity);
    },
  };
  const runtime = createRuntime(runtimeOptions);

  const publish = Effect.gen(function* () {
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
      lastHealthObservedAt,
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
  const failure = (error: unknown) =>
    new WindowsDesktopProviderDaemonError({
      message: error instanceof WindowsProviderRuntimeError ? error.message : unavailable,
    });
  const admit = (result: WindowsProviderRuntimeResult, elapsed: number) =>
    Effect.gen(function* () {
      lastHealthObservedAt = DateTime.formatIso(DateTime.nowUnsafe());
      yield* Ref.update(state, (current) => ({
        ...current,
        status: "running" as const,
        pid: Option.some(result.marker.pid),
        endpoint: Option.some(result.endpoint),
        adoptedExistingProcess: result.adopted,
        lastHealth: Option.some(result.health),
        lastError: Option.none(),
        lastEnsureRunningDurationMs: Option.some(elapsed),
        ...(result.adopted
          ? { lastAdoptionDurationMs: Option.some(elapsed) }
          : { lastSpawnDurationMs: Option.some(elapsed) }),
      }));
      yield* publish;
      yield* PubSub.publish(startupUpdates, { phase: "ready" });
      return result.endpoint;
    });
  const lifecycle = (action: () => Promise<WindowsProviderRuntimeResult>) =>
    mutex
      .withPermits(1)(
        Effect.gen(function* () {
          const started = performance.now();
          yield* Ref.update(state, (current) => ({ ...current, status: "starting" as const }));
          yield* PubSub.publish(startupUpdates, { phase: "starting" });
          yield* publish;
          const result = yield* Effect.tryPromise({
            try: async () => {
              const admitted = await action();
              if (!matches(admitted, admitted.health, profile))
                throw new WindowsProviderRuntimeError("profile-mismatch");
              return admitted;
            },
            catch: failure,
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* Ref.update(state, (current) => ({
                  ...current,
                  status: "error" as const,
                  lastError: Option.some(error.message),
                }));
                yield* publish;
                yield* PubSub.publish(startupUpdates, { phase: "failed" });
                return yield* Effect.die(error);
              }),
            ),
          );
          return yield* admit(result, Math.round(performance.now() - started));
        }),
      )
      .pipe(Effect.uninterruptible);
  const ensureRunning = lifecycle(() => runtime.ensure());

  const probeLiveness = Effect.tryPromise({
    try: async () => {
      const current = runtime.current();
      if (!current) return Option.none<ProviderDaemonLiveness>();
      const response = await requestJson(current.endpoint, PROVIDER_DAEMON_LIVENESS_PATH, {
        timeoutMs: 3_000,
        // The socket timeout is idle-based; a slowly trickling peer must not
        // hold up the watchdog indefinitely without a complete identity reply.
        signal: AbortSignal.timeout(3_000),
        maxResponseBytes: 8_192,
      });
      if (response.statusCode !== 200) return Option.none<ProviderDaemonLiveness>();
      const health = decodeLiveness(JSON.parse(response.body));
      return runtime.current() === current && matches(current, health, profile)
        ? Option.some(health)
        : Option.none<ProviderDaemonLiveness>();
    },
    catch: failure,
  }).pipe(Effect.orElseSucceed(() => Option.none<ProviderDaemonLiveness>()));
  const refreshHealth = mutex.withPermits(1)(
    Effect.gen(function* () {
      const started = performance.now();
      const current = runtime.current();
      if (!current) return Option.none<ProviderDaemonHealth>();
      const result = yield* Effect.tryPromise({
        try: async () => {
          const response = await requestJson(current.endpoint, PROVIDER_DAEMON_HEALTH_PATH, {
            timeoutMs: 5_000,
            signal: AbortSignal.timeout(5_000),
            maxResponseBytes: 1_048_576,
          });
          if (response.statusCode !== 200)
            throw new WindowsDesktopProviderDaemonError({ message: unavailable });
          const health = decodeHealth(JSON.parse(response.body));
          if (!matches(current, health, profile))
            throw new WindowsDesktopProviderDaemonError({ message: unavailable });
          return health;
        },
        catch: failure,
      }).pipe(Effect.option);
      if (Option.isSome(result)) lastHealthObservedAt = DateTime.formatIso(DateTime.nowUnsafe());
      yield* Ref.update(state, (latest) => ({
        ...latest,
        lastHealth: Option.isSome(result) ? result : latest.lastHealth,
        lastError: Option.isSome(result) ? Option.none() : Option.some(unavailable),
        healthRefreshCount: latest.healthRefreshCount + 1,
        healthRefreshFailureCount:
          latest.healthRefreshFailureCount + (Option.isSome(result) ? 0 : 1),
        lastHealthRefreshDurationMs: Option.some(Math.round(performance.now() - started)),
      }));
      yield* publish;
      return result;
    }),
  );

  const recover: DesktopProviderDaemonManagerShape["recover"] = (_reason, expectedOwnershipId) =>
    lifecycle(async () => {
      // Diagnostics intentionally use a fixed reason. Callers may otherwise pass
      // raw network errors containing paths or private response bodies.
      const result = await runtime.recover(expectedOwnershipId);
      await run(
        Ref.update(state, (current) => ({
          ...current,
          recoveryCount: current.recoveryCount + 1,
          lastRecoveryAt: Option.some(DateTime.formatIso(DateTime.nowUnsafe())),
          lastRecoveryReason: Option.some("verified Windows ownership recovery"),
        })),
      );
      return result;
    });
  const prepareForUpdate = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const current = runtime.current();
        const expectedPort = cafeMcpPort;
        if (
          current === null ||
          current.marker.mode !== "provider-daemon" ||
          current.marker.windowsProcessIdentity === undefined ||
          current.marker.appVersion !== environment.appVersion ||
          current.marker.protocolVersion !== 1 ||
          current.marker.runtimeBuildId !== runtimeBuildId ||
          (expectedPort !== undefined && current.marker.cafeMcpPort !== expectedPort) ||
          current.health.upstreamSupervisor !== undefined
        ) {
          return yield* Effect.die(new WindowsProviderDaemonUpdatePreparationError());
        }
        const before = yield* Effect.tryPromise({
          try: () => runtime.observe(),
          catch: () => new WindowsProviderDaemonUpdatePreparationError(),
        });
        if (before.status !== "same-process" || before.ownershipId !== current.ownershipId) {
          return yield* Effect.die(new WindowsProviderDaemonUpdatePreparationError());
        }
        const health = yield* Effect.tryPromise({
          try: async (signal) => {
            const response = await requestJson(current.endpoint, PROVIDER_DAEMON_HEALTH_PATH, {
              timeoutMs: 5_000,
              signal,
              maxResponseBytes: 1_048_576,
            });
            if (response.statusCode !== 200)
              throw new WindowsProviderDaemonUpdatePreparationError();
            return decodeHealthJson(response.body);
          },
          catch: () => new WindowsProviderDaemonUpdatePreparationError(),
        });
        if (
          !matches(current, health, profile) ||
          health.version !== environment.appVersion ||
          health.protocolVersion !== 1 ||
          health.runtimeBuildId !== runtimeBuildId ||
          health.upstreamSupervisor !== undefined
        ) {
          return yield* Effect.die(new WindowsProviderDaemonUpdatePreparationError());
        }
        const after = yield* Effect.tryPromise({
          try: () => runtime.observe(),
          catch: () => new WindowsProviderDaemonUpdatePreparationError(),
        });
        if (
          after.status !== "same-process" ||
          after.ownershipId !== current.ownershipId ||
          runtime.current() !== current ||
          cafeMcpPort !== expectedPort
        ) {
          return yield* Effect.die(new WindowsProviderDaemonUpdatePreparationError());
        }
        // Native observation is read-only. Do not call ensure/recover/stop,
        // publish a new lease, or clear state here. The existing guarded Stop
        // independently re-admits its generation and confirms native exit.
      }),
    )
    .pipe(
      Effect.timeout(Duration.seconds(5)),
      Effect.orDie,
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.die(new WindowsProviderDaemonUpdatePreparationError()),
      ),
    );
  const stop = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => runtime.stop(runtime.current()?.ownershipId),
          catch: failure,
        }).pipe(Effect.orDie);
        lastHealthObservedAt = null;
        yield* Ref.set(state, initial);
        yield* publish;
      }),
    )
    .pipe(Effect.uninterruptible);
  yield* DesktopDebugServer.setProviderDaemonDebugSnapshotRefresher(() =>
    run(refreshHealth.pipe(Effect.asVoid)),
  );
  yield* publish;
  return {
    configureCafeMcpPort: (port) =>
      Number.isInteger(port) && port > 0 && port <= 65_535
        ? Effect.sync(() => {
            cafeMcpPort = port;
          })
        : Effect.die(new Error("Invalid Cafe MCP backend port.")),
    ensureRunning,
    prepareForUpdate,
    startupProgress: Stream.fromPubSub(startupUpdates),
    recover,
    currentConfig: Ref.get(state).pipe(Effect.map((current) => current.endpoint)),
    observeProcessOwnership: Effect.tryPromise({
      try: () => runtime.observe(),
      catch: failure,
    }).pipe(Effect.orElseSucceed(() => ({ status: "unknown" as const }))),
    probeLiveness,
    refreshHealth,
    snapshot: Ref.get(state),
    stop,
  } satisfies DesktopProviderDaemonManagerShape;
});
