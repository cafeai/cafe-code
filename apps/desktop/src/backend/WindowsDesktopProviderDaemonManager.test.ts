import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderDaemonHealth } from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type {
  WindowsProviderRuntime,
  WindowsProviderRuntimeOptions,
  WindowsProviderRuntimeResult,
} from "@cafecode/shared/windowsProviderRuntime";
import { WindowsProviderRuntimeError } from "@cafecode/shared/windowsProviderRuntime";
import { dataProfileIdentity } from "@cafecode/shared/dataProfileIdentity";
import type { DesktopEnvironmentShape } from "../app/DesktopEnvironment.ts";
import * as DesktopDebugServer from "../debug/DesktopDebugServer.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import {
  makeWindowsDesktopProviderDaemonManager,
  type WindowsDesktopProviderDaemonDependencies,
} from "./WindowsDesktopProviderDaemonManager.ts";

const environment = {
  platform: "win32",
  dataProfile: "production",
  configuredBaseDir: "C:\\CafeTest",
  baseDir: "C:\\CafeTest",
  stateDir: "C:\\CafeTest\\userdata",
  providerDaemonMarkerPath: "C:\\CafeTest\\userdata\\provider-daemon.json",
  providerDaemonCredentialPath: "C:\\CafeTest\\userdata\\provider-daemon-token.bin",
  appVersion: "test-version",
  backendEntryPath: "C:\\CafeTest\\server.js",
  backendCwd: "C:\\CafeTest",
  otlpTracesUrl: Option.none(),
} as DesktopEnvironmentShape;
const generation = "12345678-1234-4234-8234-123456789012";
const identity = { pid: 41, creationTime100ns: "134192244880123456" };
const profile = {
  dataProfile: "production" as const,
  dataProfileId: dataProfileIdentity("production", environment.baseDir),
};
const result: WindowsProviderRuntimeResult = {
  adopted: true,
  ownershipId: generation,
  endpoint: {
    transport: "ipc",
    socketPath: "\\\\.\\pipe\\test",
    httpBaseUrl: "http://provider-daemon.local",
    token: "synthetic-lease-private-token-000000",
    leaseId: "test-lease-00000000000000000000",
  },
  rootEndpoint: {
    httpBaseUrl: "http://provider-daemon.local",
    token: "synthetic-root-private-token-000000",
  },
  marker: {
    ...profile,
    version: 2,
    mode: "provider-daemon",
    pid: 41,
    ppid: 1,
    protocolVersion: 1,
    httpBaseUrl: "http://provider-daemon.local",
    credentialPath: environment.providerDaemonCredentialPath,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    appVersion: "test-version",
    runtimeBuildId: "test-build",
    windowsOwnershipId: generation,
    windowsOwnershipState: "committed",
    windowsProcessIdentity: identity,
  },
  health: {
    ...profile,
    ok: true,
    mode: "provider-daemon",
    pid: 41,
    ppid: 1,
    version: "test-version",
    protocolVersion: 1,
    runtimeBuildId: "test-build",
    startedAt: "2026-09-27T00:00:00.000Z",
    activeSessionCount: 0,
    configuredInstanceCount: 0,
    eventCursor: 0,
    windowsOwnershipId: generation,
    windowsProcessIdentity: identity,
  },
};

const safeStorage = {
  isEncryptionAvailable: Effect.succeed(true),
  encryptString: (text: string) => Effect.succeed(Buffer.from(`encrypted:${text}`)),
  decryptString: (bytes: Uint8Array) =>
    Effect.succeed(
      Buffer.from(bytes)
        .toString()
        .replace(/^encrypted:/, ""),
    ),
};
const fixtureScopes: Scope.Closeable[] = [];
async function fixtureScope() {
  const scope = await Effect.runPromise(Scope.make());
  fixtureScopes.push(scope);
  return scope;
}
function runtimeFixture() {
  let current: WindowsProviderRuntimeResult | null = null;
  return {
    ensure: vi.fn(async () => {
      current = result;
      return result;
    }),
    observe: vi.fn<WindowsProviderRuntime["observe"]>(async () => ({
      status: "same-process",
      ownershipId: generation,
    })),
    recover: vi.fn(async (_expected?: string) => {
      current = result;
      return result;
    }),
    stop: vi.fn(async (_expected?: string) => {
      current = null;
    }),
    current: () => current,
  } satisfies WindowsProviderRuntime;
}
async function setup(runtime = runtimeFixture(), health = result.health) {
  let options!: WindowsProviderRuntimeOptions;
  const scope = await fixtureScope();
  const requestJson = vi.fn<NonNullable<WindowsDesktopProviderDaemonDependencies["requestJson"]>>(
    async () => ({
      statusCode: 200,
      body: JSON.stringify({ ...health, transport: "ipc" }),
    }),
  );
  const manager = await Effect.runPromise(
    makeWindowsDesktopProviderDaemonManager(environment, "test-build", {
      createRuntime: (input) => {
        options = input;
        return runtime;
      },
      requestJson,
    }).pipe(
      Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, safeStorage),
      Effect.provideService(Scope.Scope, scope),
    ),
  );
  return { manager, runtime, options, requestJson, scope };
}
afterEach(async () => {
  for (const scope of fixtureScopes.splice(0))
    await Effect.runPromise(Scope.close(scope, Exit.void));
  DesktopDebugServer.__desktopDebugServerTestApi.reset({ enabled: false });
});

describe("Windows desktop daemon authority adapter", () => {
  it("stops an upstream supervisor only through its separate authenticated generation and birth identity", async () => {
    const daemon = runtimeFixture();
    const supervisor = runtimeFixture();
    const configurations: WindowsProviderRuntimeOptions[] = [];
    await Effect.runPromise(
      makeWindowsDesktopProviderDaemonManager(environment, "test-build", {
        createRuntime: (input) => {
          configurations.push(input);
          return input.role === "provider-daemon" ? daemon : supervisor;
        },
      }).pipe(
        Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, safeStorage),
        Effect.provideService(Scope.Scope, await fixtureScope()),
      ),
    );
    await configurations[0]!.stopSupervisor!({ ownershipId: generation, identity });
    expect(configurations.map((input) => input.role)).toEqual([
      "provider-daemon",
      "provider-supervisor",
    ]);
    expect(supervisor.stop).toHaveBeenCalledWith(generation, identity);
    expect(supervisor.ensure).not.toHaveBeenCalled();
    expect(daemon.stop).not.toHaveBeenCalled();
    expect(configurations[1]!.markerPath).toContain("provider-supervisor.json");
    expect(configurations[1]!.legacyCredentialPath).toContain("provider-supervisor-token");
    expect(configurations[0]).toMatchObject(profile);
    expect(configurations[1]).toMatchObject(profile);
    expect(configurations[1]!.bootstrap).toMatchObject({
      dataProfile: environment.dataProfile,
      configuredCafeCodeHome: environment.configuredBaseDir,
      cafeCodeHome: environment.baseDir,
    });
    expect(
      await configurations[1]!.decodeCredential(
        Buffer.from("synthetic-supervisor-token\n").toString("base64"),
        false,
      ),
    ).toBe("synthetic-supervisor-token");
    await expect(configurations[1]!.decodeCredential("c3ludGhldGlj", true)).rejects.toThrow(
      "credential-unavailable",
    );
  });

  it("publishes only the admitted lease and preserves the encryption policy", async () => {
    const { manager, options } = await setup();
    expect(Option.isNone(await Effect.runPromise(manager.currentConfig))).toBe(true);
    await Effect.runPromise(manager.configureCafeMcpPort!(3773));
    expect(options.cafeMcpPort?.()).toBe(3773);
    const encoded = await options.encodeCredential("synthetic-secret");
    expect(encoded.encrypted).toBe(true);
    expect(await options.decodeCredential(encoded.base64, true)).toBe("synthetic-secret");
    expect(options.socketPath).toMatch(/^\\\\\.\\pipe\\cafecode-provider-daemon-/);
    expect(options).toMatchObject(profile);
    expect(options.bootstrap).toMatchObject({
      dataProfile: environment.dataProfile,
      configuredCafeCodeHome: environment.configuredBaseDir,
      cafeCodeHome: environment.baseDir,
    });
    expect(await Effect.runPromise(manager.ensureRunning)).toEqual(result.endpoint);
    expect(Option.getOrThrow(await Effect.runPromise(manager.currentConfig))).toEqual(
      result.endpoint,
    );
    expect((await Effect.runPromise(manager.snapshot)).status).toBe("running");
  });

  it("replays bounded sanitized migration progress and publishes terminal readiness", async () => {
    const { manager, options } = await setup();
    const latest = () => Effect.runPromise(Stream.runHead(manager.startupProgress!));
    options.onStartupProgress?.({ phase: "migrating", migrationId: 92 });
    expect(Option.getOrThrow(await latest())).toEqual({ phase: "migrating", migrationId: 92 });
    await Effect.runPromise(manager.ensureRunning);
    expect(Option.getOrThrow(await latest())).toEqual({ phase: "ready" });
  });

  it("publishes a fixed failure phase without exposing runtime error material", async () => {
    const { manager, runtime } = await setup();
    runtime.ensure.mockRejectedValueOnce(new Error("SECRET C:\\private\\auth.json"));
    await expect(Effect.runPromise(manager.ensureRunning)).rejects.toThrow(
      "ownership could not be verified",
    );
    expect(
      Option.getOrThrow(await Effect.runPromise(Stream.runHead(manager.startupProgress!))),
    ).toEqual({ phase: "failed" });
  });

  it("delegates observation and exact recovery/shutdown generation without exposing caller errors", async () => {
    const { manager, runtime } = await setup();
    await Effect.runPromise(manager.ensureRunning);
    expect(await Effect.runPromise(manager.observeProcessOwnership!)).toEqual({
      status: "same-process",
      ownershipId: generation,
    });
    await Effect.runPromise(
      manager.recover("private path and token must not be logged", generation),
    );
    expect(runtime.recover).toHaveBeenCalledWith(generation);
    expect(Option.getOrThrow((await Effect.runPromise(manager.snapshot)).lastRecoveryReason)).toBe(
      "verified Windows ownership recovery",
    );
    await Effect.runPromise(manager.stop);
    expect(runtime.stop).toHaveBeenCalledWith(generation);
    expect(Option.isNone(await Effect.runPromise(manager.currentConfig))).toBe(true);
  });

  it("does not clear the admitted endpoint when termination is uncertain", async () => {
    const { manager, runtime } = await setup();
    await Effect.runPromise(manager.ensureRunning);
    runtime.stop.mockRejectedValueOnce(new WindowsProviderRuntimeError("termination-uncertain"));
    await expect(Effect.runPromise(manager.stop)).rejects.toThrow("termination-uncertain");
    expect(Option.getOrThrow(await Effect.runPromise(manager.currentConfig))).toEqual(
      result.endpoint,
    );
  });

  it("refuses update preparation without an admitted native owner", async () => {
    const { manager, runtime, requestJson } = await setup();
    const before = await Effect.runPromise(manager.snapshot);
    await expect(Effect.runPromise(manager.prepareForUpdate!)).rejects.toThrow(
      "could not be safely prepared",
    );
    expect(await Effect.runPromise(manager.snapshot)).toEqual(before);
    expect(runtime.ensure).not.toHaveBeenCalled();
    expect(runtime.observe).not.toHaveBeenCalled();
    expect(runtime.recover).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("qualifies fresh health between two native observations without mutating its admitted owner", async () => {
    const { manager, runtime, requestJson } = await setup();
    await Effect.runPromise(manager.ensureRunning);
    const before = await Effect.runPromise(manager.snapshot);
    await Effect.runPromise(manager.prepareForUpdate!);
    expect(runtime.observe).toHaveBeenCalledTimes(2);
    expect(requestJson).toHaveBeenCalledExactlyOnceWith(
      result.endpoint,
      "/api/provider-daemon/health",
      expect.objectContaining({
        timeoutMs: 5_000,
        maxResponseBytes: 1_048_576,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(runtime.ensure).toHaveBeenCalledTimes(1);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.recover).not.toHaveBeenCalled();
    expect(runtime.current()).toBe(result);
    expect(await Effect.runPromise(manager.snapshot)).toEqual(before);
    expect(Option.getOrThrow(await Effect.runPromise(manager.currentConfig))).toEqual(
      result.endpoint,
    );
  });

  const changedHealth: ReadonlyArray<readonly [string, Partial<ProviderDaemonHealth>]> = [
    ["process", { pid: 42 }],
    ["mode", { mode: "provider-supervisor" }],
    ["version", { version: "private-old-version" }],
    ["protocol", { protocolVersion: 2 }],
    ["build", { runtimeBuildId: "private-old-build" }],
    ["profile", { dataProfile: "debug" }],
    ["profile root", { dataProfileId: dataProfileIdentity("production", "C:\\foreign") }],
    ["generation", { windowsOwnershipId: "00000000-0000-4000-8000-000000000000" }],
    [
      "birth identity",
      { windowsProcessIdentity: { ...identity, creationTime100ns: "134192244880123457" } },
    ],
    ["upstream owner", { upstreamSupervisor: { configured: true, reachable: true } }],
  ];
  it.each(changedHealth)(
    "refuses changed fresh %s proof without stopping or replacing its owner",
    async (_phase, patch) => {
      const { manager, runtime, requestJson } = await setup(undefined, {
        ...result.health,
        ...patch,
      });
      await Effect.runPromise(manager.ensureRunning);
      const before = await Effect.runPromise(manager.snapshot);
      const prepared = await Effect.runPromise(Effect.exit(manager.prepareForUpdate!));
      expect(Exit.isFailure(prepared)).toBe(true);
      if (Exit.isFailure(prepared)) {
        const message = Cause.pretty(prepared.cause);
        expect(message).toContain("could not be safely prepared");
        expect(message).not.toMatch(/private-old|synthetic-lease|C:\\\\foreign/);
      }
      expect(runtime.observe).toHaveBeenCalledTimes(1);
      expect(requestJson).toHaveBeenCalledTimes(1);
      expect(runtime.ensure).toHaveBeenCalledTimes(1);
      expect(runtime.stop).not.toHaveBeenCalled();
      expect(runtime.recover).not.toHaveBeenCalled();
      expect(runtime.current()).toBe(result);
      expect(await Effect.runPromise(manager.snapshot)).toEqual(before);
    },
  );

  it.each([
    ["before", "unknown"],
    ["after", "unknown"],
    ["before", "changed-generation"],
    ["after", "changed-generation"],
  ] as const)(
    "refuses %s-health %s native ownership without mutation",
    async (phase, observation) => {
      const { manager, runtime, requestJson } = await setup();
      await Effect.runPromise(manager.ensureRunning);
      const before = await Effect.runPromise(manager.snapshot);
      if (phase === "after")
        runtime.observe.mockResolvedValueOnce({ status: "same-process", ownershipId: generation });
      runtime.observe.mockResolvedValueOnce(
        observation === "unknown"
          ? { status: "unknown" }
          : { status: "same-process", ownershipId: "00000000-0000-4000-8000-000000000000" },
      );
      await expect(Effect.runPromise(manager.prepareForUpdate!)).rejects.toThrow(
        "could not be safely prepared",
      );
      expect(runtime.observe).toHaveBeenCalledTimes(phase === "before" ? 1 : 2);
      expect(requestJson).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
      expect(runtime.ensure).toHaveBeenCalledTimes(1);
      expect(runtime.stop).not.toHaveBeenCalled();
      expect(runtime.recover).not.toHaveBeenCalled();
      expect(await Effect.runPromise(manager.snapshot)).toEqual(before);
    },
  );

  it("preserves interruption and retires its exact held health request before returning", async () => {
    const { manager, runtime, requestJson, scope } = await setup();
    await Effect.runPromise(manager.ensureRunning);
    const before = await Effect.runPromise(manager.snapshot);
    const entered = await Effect.runPromise(Deferred.make<void>());
    const aborted = await Effect.runPromise(Deferred.make<void>());
    let abortCount = 0;
    let retireRequest = () => {};
    // Install exact fixture cleanup before admission, so even a hard test
    // timeout cannot leave the synthetic request or its signal listener alive.
    await Effect.runPromise(
      Scope.addFinalizer(
        scope,
        Effect.sync(() => retireRequest()),
      ),
    );
    requestJson.mockImplementationOnce(
      (_endpoint, _path, options) =>
        new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) {
            reject(new Error("Missing fixture-owned request signal"));
            return;
          }
          let retired = false;
          const retire = () => {
            if (retired) return;
            retired = true;
            signal.removeEventListener("abort", onAbort);
            reject(new Error("Private fixture request retired"));
          };
          const onAbort = () => {
            abortCount += 1;
            retire();
            Effect.runSync(Deferred.succeed(aborted, undefined));
          };
          retireRequest = retire;
          signal.addEventListener("abort", onAbort, { once: true });
          // A Deferred resumes its observers synchronously. Let this Promise
          // executor return before allowing the verifier to interrupt: Effect
          // installs the exact request's abort finalizer after try returns.
          // This is a registration handshake, not a timer or another attempt.
          queueMicrotask(() => {
            if (!retired) Effect.runSync(Deferred.succeed(entered, undefined));
          });
          if (signal.aborted) onAbort();
        }),
    );
    // All Deferred waits belong to this captured fixture scope as well as the
    // preflight fiber; afterEach can retire both if an earlier guard regresses.
    const verification = await Effect.runPromise(
      Effect.gen(function* () {
        const attempted = yield* manager.prepareForUpdate!.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(attempted);
        const prepared = yield* Fiber.await(attempted);
        expect(Exit.isFailure(prepared)).toBe(true);
        if (Exit.isFailure(prepared)) expect(Cause.hasInterrupts(prepared.cause)).toBe(true);
        // Only the actual AbortSignal callback completes this receipt; the scope's
        // fallback retirement cannot manufacture a successful abort observation.
        yield* Deferred.await(aborted);
      }).pipe(Effect.forkScoped, Effect.provideService(Scope.Scope, scope)),
    );
    await Effect.runPromise(Fiber.join(verification));
    expect(abortCount).toBe(1);
    expect(runtime.observe).toHaveBeenCalledTimes(1);
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(runtime.ensure).toHaveBeenCalledTimes(1);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.recover).not.toHaveBeenCalled();
    expect(runtime.current()).toBe(result);
    expect(await Effect.runPromise(manager.snapshot)).toEqual(before);
  });

  it("sanitizes unknown adapter errors and never grants PID authority after a probe failure", async () => {
    const { manager, runtime } = await setup();
    runtime.ensure.mockRejectedValueOnce(new Error("SECRET C:\\private\\auth.json"));
    await expect(Effect.runPromise(manager.ensureRunning)).rejects.toThrow(
      "ownership could not be verified",
    );
    expect(Option.getOrThrow((await Effect.runPromise(manager.snapshot)).lastError)).not.toMatch(
      /SECRET|auth\.json/,
    );
    runtime.observe.mockRejectedValueOnce(new Error("private diagnostic"));
    expect(await Effect.runPromise(manager.observeProcessOwnership!)).toEqual({
      status: "unknown",
    });
  });

  it("preserves legacy guidance while rejecting authenticated liveness from another generation", async () => {
    const { manager, runtime } = await setup(undefined, {
      ...result.health,
      windowsOwnershipId: "00000000-0000-4000-8000-000000000000",
    });
    runtime.ensure.mockRejectedValueOnce(
      new WindowsProviderRuntimeError("legacy-identity-unknown"),
    );
    await expect(Effect.runPromise(manager.ensureRunning)).rejects.toThrow(
      "guided legacy recovery",
    );
    await Effect.runPromise(manager.ensureRunning);
    expect(Option.isNone(await Effect.runPromise(manager.probeLiveness))).toBe(true);
    expect(Option.isNone(await Effect.runPromise(manager.refreshHealth))).toBe(true);
    expect((await Effect.runPromise(manager.snapshot)).healthRefreshFailureCount).toBe(1);
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("uses cheap authenticated health without invoking the native observer", async () => {
    const { manager, runtime, requestJson } = await setup();
    await Effect.runPromise(manager.ensureRunning);
    expect(Option.isSome(await Effect.runPromise(manager.probeLiveness))).toBe(true);
    expect(Option.isSome(await Effect.runPromise(manager.refreshHealth))).toBe(true);
    expect(runtime.observe).not.toHaveBeenCalled();
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it.each(["omitted", "foreign-profile", "foreign-root"] as const)(
    "does not publish an admitted lease with %s native profile proof",
    async (phase) => {
      const { manager, runtime } = await setup();
      const receipt =
        phase === "omitted"
          ? { dataProfile: undefined, dataProfileId: undefined }
          : phase === "foreign-profile"
            ? { dataProfile: "debug" as const, dataProfileId: profile.dataProfileId }
            : {
                dataProfile: profile.dataProfile,
                dataProfileId: dataProfileIdentity("production", "C:\\foreign"),
              };
      runtime.ensure.mockResolvedValueOnce({ ...result, health: { ...result.health, ...receipt } });
      await expect(Effect.runPromise(manager.ensureRunning)).rejects.toThrow("profile-mismatch");
      expect(Option.isNone(await Effect.runPromise(manager.currentConfig))).toBe(true);
      expect(runtime.stop).not.toHaveBeenCalled();
      expect(runtime.recover).not.toHaveBeenCalled();
    },
  );

  it.each(["omitted", "foreign-profile", "foreign-root"] as const)(
    "refuses %s later health without discarding the exact admitted owner",
    async (phase) => {
      const receipt =
        phase === "omitted"
          ? { dataProfile: undefined, dataProfileId: undefined }
          : phase === "foreign-profile"
            ? { dataProfile: "debug" as const, dataProfileId: profile.dataProfileId }
            : {
                dataProfile: profile.dataProfile,
                dataProfileId: dataProfileIdentity("production", "C:\\foreign"),
              };
      const { manager, runtime } = await setup(undefined, { ...result.health, ...receipt });
      await Effect.runPromise(manager.ensureRunning);
      expect(Option.isNone(await Effect.runPromise(manager.probeLiveness))).toBe(true);
      expect(Option.isNone(await Effect.runPromise(manager.refreshHealth))).toBe(true);
      expect(Option.getOrThrow(await Effect.runPromise(manager.currentConfig))).toEqual(
        result.endpoint,
      );
      expect(runtime.stop).not.toHaveBeenCalled();
      expect(runtime.recover).not.toHaveBeenCalled();
      expect(runtime.observe).not.toHaveBeenCalled();
    },
  );
});
