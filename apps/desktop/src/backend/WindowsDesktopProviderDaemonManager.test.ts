import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type {
  WindowsProviderRuntime,
  WindowsProviderRuntimeOptions,
  WindowsProviderRuntimeResult,
} from "@cafecode/shared/windowsProviderRuntime";
import { WindowsProviderRuntimeError } from "@cafecode/shared/windowsProviderRuntime";
import type { DesktopEnvironmentShape } from "../app/DesktopEnvironment.ts";
import * as DesktopDebugServer from "../debug/DesktopDebugServer.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { makeWindowsDesktopProviderDaemonManager } from "./WindowsDesktopProviderDaemonManager.ts";

const environment = {
  platform: "win32",
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
    observe: vi.fn(async () => ({ status: "same-process" as const, ownershipId: generation })),
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
  const requestJson = vi.fn(async () => ({
    statusCode: 200,
    body: JSON.stringify({ ...health, transport: "ipc" }),
  }));
  const manager = await Effect.runPromise(
    makeWindowsDesktopProviderDaemonManager(environment, "test-build", {
      createRuntime: (input) => {
        options = input;
        return runtime;
      },
      requestJson,
    }).pipe(
      Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, safeStorage),
      Effect.provideService(Scope.Scope, await fixtureScope()),
    ),
  );
  return { manager, runtime, options, requestJson };
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
});
