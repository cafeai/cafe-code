import type { ProviderDaemonClientConfig, ProviderDaemonHealth } from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import type { DesktopBackendManagerShape } from "../backend/DesktopBackendManager.ts";
import type {
  DesktopProviderDaemonManagerShape,
  DesktopProviderDaemonSnapshot,
} from "../backend/DesktopProviderDaemonManager.ts";
import { runProviderDaemonHealthWatchdog } from "./DesktopApp.ts";

const endpoint: ProviderDaemonClientConfig = {
  httpBaseUrl: "http://provider-daemon.local",
  transport: "ipc",
  socketPath: "/tmp/cafe-provider-daemon-test.sock",
  token: "provider-daemon-test-token-000000000000000000000000",
  leaseId: "provider-daemon-test-lease-00000000000000000000",
};

const healthyDaemon: ProviderDaemonHealth = {
  ok: true,
  mode: "provider-daemon",
  pid: process.pid,
  ppid: process.ppid,
  version: "0.0.0-test",
  protocolVersion: 1,
  runtimeBuildId: "test-runtime-build",
  startedAt: "2026-01-01T00:00:00.000Z",
  activeSessionCount: 0,
  configuredInstanceCount: 1,
  eventCursor: 0,
};

function daemonSnapshot(): DesktopProviderDaemonSnapshot {
  return {
    status: "running",
    pid: Option.some(process.pid),
    endpoint: Option.some(endpoint),
    adoptedExistingProcess: false,
    lastHealth: Option.none(),
    lastError: Option.some("connect ECONNREFUSED test socket"),
    markerPath: "/tmp/provider-daemon.json",
    credentialPath: "/tmp/provider-daemon-token.bin",
    runtimeBuildId: "test-runtime-build",
    lastEnsureRunningDurationMs: Option.none(),
    lastAdoptionDurationMs: Option.none(),
    lastSpawnDurationMs: Option.none(),
    lastHealthRefreshDurationMs: Option.none(),
    healthRefreshCount: 2,
    healthRefreshFailureCount: 2,
    recoveryCount: 0,
    lastRecoveryAt: Option.none(),
    lastRecoveryReason: Option.none(),
  };
}

describe("DesktopApp provider daemon watchdog", () => {
  it.effect("restarts the backend around a confirmed provider daemon replacement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const actions: string[] = [];
        let probeCount = 0;
        let recovered = false;
        const quitting = yield* Ref.make(false);

        const providerDaemonManager: DesktopProviderDaemonManagerShape = {
          ensureRunning: Effect.succeed(endpoint),
          recover: (reason) =>
            Effect.sync(() => {
              assert.include(reason, "consecutive health probes");
              actions.push("recover-daemon");
              recovered = true;
              return endpoint;
            }),
          currentConfig: Effect.succeed(Option.some(endpoint)),
          refreshHealth: Effect.sync(() => {
            probeCount += 1;
            return recovered ? Option.some(healthyDaemon) : Option.none();
          }),
          snapshot: Effect.sync(daemonSnapshot),
          stop: Effect.die("watchdog must use recover, not stop"),
        };
        const backendManager: DesktopBackendManagerShape = {
          start: Effect.sync(() => {
            actions.push("start-backend");
          }),
          stop: () =>
            Effect.sync(() => {
              actions.push("stop-backend");
            }),
          currentConfig: Effect.succeed(Option.none()),
          snapshot: Effect.succeed({
            desiredRunning: true,
            ready: true,
            activePid: Option.some(process.pid),
            restartAttempt: 0,
            restartScheduled: false,
          }),
        };

        const watchdog = yield* runProviderDaemonHealthWatchdog({
          backendManager,
          providerDaemonManager,
          quitting,
          checkInterval: Duration.millis(1),
          failureThreshold: 2,
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(1));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(1));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(watchdog);

        assert.isAtLeast(probeCount, 2);
        assert.deepStrictEqual(actions, ["stop-backend", "recover-daemon", "start-backend"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});
