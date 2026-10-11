import type { ProviderDaemonClientConfig, ProviderDaemonLiveness } from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
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
import {
  fatalStartupCause,
  runProviderDaemonHealthWatchdog,
  runDesktopStartupUntilShutdown,
  startBackendAfterProviderDaemonReady,
} from "./DesktopApp.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopState from "./DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopStartupWindow from "../window/DesktopStartupWindow.ts";

const endpoint: ProviderDaemonClientConfig = {
  httpBaseUrl: "http://provider-daemon.local",
  transport: "ipc",
  socketPath: "/tmp/cafe-provider-daemon-test.sock",
  token: "provider-daemon-test-token-000000000000000000000000",
  leaseId: "provider-daemon-test-lease-00000000000000000000",
};

const liveDaemon: ProviderDaemonLiveness = {
  ok: true,
  mode: "provider-daemon",
  pid: process.pid,
  ppid: process.ppid,
  version: "0.0.0-test",
  protocolVersion: 1,
  runtimeBuildId: "test-runtime-build",
  startedAt: "2026-01-01T00:00:00.000Z",
  transport: "ipc",
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

/**
 * The first fenced recovery has definitely retired the old owner, but its new
 * child is not admitted yet. There is deliberately no active PID to observe.
 * Only another guarded ensure can reconcile the prepared replacement.
 */
function pendingWindowsRecoveryFixture(input?: {
  readonly healthyWhilePending?: boolean;
  readonly ensure?: () => Effect.Effect<ProviderDaemonClientConfig>;
}) {
  const actions: string[] = [];
  let retired = false;
  let probes = 0;
  let observations = 0;
  let ensureAttempts = 0;
  const providerDaemonManager: DesktopProviderDaemonManagerShape = {
    ensureRunning: Effect.suspend(() => {
      actions.push("ensure-prepared-owner");
      ensureAttempts += 1;
      if (input?.ensure) return input.ensure();
      // One infrastructure failure exercises the retry cooldown. No old
      // termination or original user input is replayed during either retry.
      return ensureAttempts === 1
        ? Effect.die(new Error("Prepared ownership observation unavailable"))
        : Effect.succeed(endpoint);
    }),
    recover: (_reason, expected) =>
      Effect.suspend(() => {
        assert.equal(expected, "retired-generation");
        assert.equal(retired, false, "the old recovery must never run twice");
        actions.push("recover-and-retire-owner");
        retired = true;
        return Effect.die(new Error("Replacement is prepared but not ready"));
      }),
    currentConfig: Effect.succeed(Option.none()),
    probeLiveness: Effect.sync(() => {
      probes += 1;
      return retired && input?.healthyWhilePending ? Option.some(liveDaemon) : Option.none();
    }),
    observeProcessOwnership: Effect.sync(() => {
      observations += 1;
      return retired
        ? { status: "unknown" as const }
        : { status: "exited" as const, ownershipId: "retired-generation" };
    }),
    refreshHealth: Effect.succeed(Option.none()),
    snapshot: Effect.sync(() =>
      retired
        ? { ...daemonSnapshot(), status: "error" as const, pid: Option.none() }
        : daemonSnapshot(),
    ),
    stop: Effect.die("pending recovery cannot use an unfenced stop"),
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
      ready: false,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    }),
  };
  return {
    actions,
    providerDaemonManager,
    backendManager,
    probes: () => probes,
    observations: () => observations,
  };
}

describe("DesktopApp provider daemon bootstrap credentials", () => {
  it.effect("delivers fatal Quit even after its shutdown request wakes startup cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shutdown = yield* DesktopLifecycle.DesktopShutdown;
        const quitting = yield* Ref.make(false);
        const backendReady = yield* Ref.make(false);
        const actions: string[] = [];
        const unexpected = () => Effect.die("fatal startup must not invoke other app APIs");
        const app: ElectronApp.ElectronAppShape = {
          metadata: unexpected(),
          name: unexpected(),
          whenReady: unexpected(),
          // Yield after the request so the competing branch actually wakes
          // and interrupts the fatal handler before the Quit is delivered.
          quit: Effect.yieldNow.pipe(
            Effect.andThen(Effect.sync(() => actions.push("quit"))),
            Effect.asVoid,
          ),
          exit: unexpected,
          requestSingleInstanceLock: unexpected(),
          relaunch: unexpected,
          setPath: unexpected,
          setName: unexpected,
          setAboutPanelOptions: unexpected,
          setAppUserModelId: unexpected,
          setDesktopName: unexpected,
          setDockIcon: unexpected,
          appendCommandLineSwitch: unexpected,
          on: unexpected,
        };
        const result = yield* runDesktopStartupUntilShutdown({
          startup: fatalStartupCause(
            "provider daemon",
            Cause.die(new Error("synthetic readiness failure")),
          ),
          awaitShutdown: shutdown.awaitRequest.pipe(
            Effect.tap(() => Effect.sync(() => actions.push("shutdown-observed"))),
          ),
        }).pipe(
          Effect.provideService(DesktopState.DesktopState, { backendReady, quitting }),
          Effect.provideService(ElectronApp.ElectronApp, app),
          Effect.provideService(ElectronDialog.ElectronDialog, {
            pickFolder: unexpected,
            confirm: unexpected,
            showMessageBox: unexpected,
            showErrorBox: (title) =>
              Effect.sync(() => {
                assert.equal(title, "Cafe Code failed to start");
                actions.push("fatal-dialog");
              }),
          }),
          Effect.provideService(DesktopStartupWindow.DesktopStartupWindow, {
            begin: unexpected(),
            update: unexpected,
            close: Effect.sync(() => {
              actions.push("close-startup");
            }),
          }),
        );
        assert.equal(result, "shutdown");
        assert.deepStrictEqual(actions, [
          "close-startup",
          "fatal-dialog",
          "shutdown-observed",
          "quit",
        ]);
        assert.equal(yield* Ref.get(quitting), true);
      }),
    ).pipe(Effect.provide(DesktopLifecycle.layerShutdown)),
  );

  it.effect("passes user cancellation through without fatal UI or a new Quit request", () =>
    Effect.gen(function* () {
      // Any access to these tripwire service fields becomes a defect, which
      // the exact interruption-only assertion below must reject. Cancellation
      // must not show fatal UI or deliver a second native Quit.
      const unusedService = <A>(name: string): A =>
        new Proxy(
          {},
          {
            get: () => {
              throw new Error(`Cancellation accessed ${name}`);
            },
          },
        ) as A;
      const result = yield* fatalStartupCause("provider daemon", Cause.interrupt(123)).pipe(
        Effect.provideService(
          DesktopState.DesktopState,
          unusedService<DesktopState.DesktopStateShape>("state"),
        ),
        Effect.provideService(
          ElectronApp.ElectronApp,
          unusedService<ElectronApp.ElectronAppShape>("app"),
        ),
        Effect.provideService(
          ElectronDialog.ElectronDialog,
          unusedService<ElectronDialog.ElectronDialogShape>("dialog"),
        ),
        Effect.exit,
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(Cause.hasInterruptsOnly(result.cause), true);
    }).pipe(Effect.provide(DesktopLifecycle.layerShutdown)),
  );

  it.effect("cancels startup readiness on Quit without starting a backend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const quitting = yield* Ref.make(false);
        const shutdown = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<ProviderDaemonClientConfig>();
        const cancelled = yield* Deferred.make<void>();
        let starts = 0;
        const run = yield* runDesktopStartupUntilShutdown({
          startup: startBackendAfterProviderDaemonReady({
            providerDaemonReady: Deferred.await(ready).pipe(
              Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
            ),
            startBackend: Effect.sync(() => {
              starts += 1;
            }),
            quitting,
          }),
          awaitShutdown: Deferred.await(shutdown),
        }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Ref.set(quitting, true);
        yield* Deferred.succeed(shutdown, undefined);
        assert.equal(yield* Fiber.join(run), "shutdown");
        yield* Deferred.await(cancelled);
        yield* Deferred.succeed(ready, endpoint);
        assert.equal(starts, 0);
      }),
    ),
  );

  it.effect(
    "starts the backend only with the final lease after a failed provisional daemon attempt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const quitting = yield* Ref.make(false);
          const finalReady = yield* Deferred.make<ProviderDaemonClientConfig>();
          // Model the real manager's publication order: attempt A exposes a root
          // endpoint, fails, and attempt B exposes a different root on the same
          // socket before its final authenticated lease becomes available.
          const firstRoot = { ...endpoint, token: "first-attempt-root-token", leaseId: undefined };
          const secondRoot = {
            ...endpoint,
            token: "second-attempt-root-token",
            leaseId: undefined,
          };
          const currentConfig = yield* Ref.make<ProviderDaemonClientConfig>(firstRoot);
          const bootstraps: ProviderDaemonClientConfig[] = [];
          const backendStart = Ref.get(currentConfig).pipe(
            Effect.tap((config) =>
              Effect.sync(() => {
                bootstraps.push(config);
              }),
            ),
            Effect.asVoid,
          );
          const startup = yield* startBackendAfterProviderDaemonReady({
            providerDaemonReady: Deferred.await(finalReady),
            startBackend: backendStart,
            quitting,
          }).pipe(Effect.forkChild);

          yield* Effect.yieldNow;
          assert.deepStrictEqual(bootstraps, []);
          yield* Ref.set(currentConfig, secondRoot);
          yield* Effect.yieldNow;
          assert.deepStrictEqual(bootstraps, []);

          yield* Ref.set(currentConfig, endpoint);
          yield* Deferred.succeed(finalReady, endpoint);
          assert.deepStrictEqual(yield* Fiber.join(startup), endpoint);
          assert.deepStrictEqual(bootstraps, [endpoint]);
          assert.equal(bootstraps[0]?.leaseId, endpoint.leaseId);
        }),
      ),
  );

  it.effect("does not start the backend when the final daemon attempt fails", () =>
    Effect.gen(function* () {
      const quitting = yield* Ref.make(false);
      let backendStarts = 0;
      const result = yield* startBackendAfterProviderDaemonReady({
        providerDaemonReady: Effect.die(new Error("Daemon readiness exhausted")),
        startBackend: Effect.sync(() => {
          backendStarts += 1;
        }),
        quitting,
      }).pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
      assert.equal(backendStarts, 0);
    }),
  );

  it.effect(
    "does not start a backend if shutdown was requested while daemon readiness was pending",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const quitting = yield* Ref.make(false);
          const finalReady = yield* Deferred.make<ProviderDaemonClientConfig>();
          let backendStarts = 0;
          const startup = yield* startBackendAfterProviderDaemonReady({
            providerDaemonReady: Deferred.await(finalReady),
            startBackend: Effect.sync(() => {
              backendStarts += 1;
            }),
            quitting,
          }).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Ref.set(quitting, true);
          yield* Deferred.succeed(finalReady, endpoint);
          yield* Fiber.join(startup);
          assert.equal(backendStarts, 0);
        }),
      ),
  );
});

describe("DesktopApp provider daemon watchdog", () => {
  for (const healthyWhilePending of [false, true]) {
    it.effect(
      `reconciles pending Windows replacement without repeating old recovery (healthy probe=${healthyWhilePending})`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const quitting = yield* Ref.make(false);
            const fixture = pendingWindowsRecoveryFixture({ healthyWhilePending });
            const watchdog = yield* runProviderDaemonHealthWatchdog({
              ...fixture,
              quitting,
              checkInterval: Duration.millis(1),
              isDaemonProcessAlive: () => {
                throw new Error("Windows retries must not use PID-only observations");
              },
            }).pipe(Effect.forkScoped);
            yield* Effect.yieldNow;
            yield* TestClock.adjust(Duration.millis(1));
            yield* Effect.yieldNow;
            assert.deepStrictEqual(fixture.actions, ["stop-backend", "recover-and-retire-owner"]);

            yield* TestClock.adjust(Duration.millis(1));
            yield* Effect.yieldNow;
            assert.deepStrictEqual(fixture.actions, [
              "stop-backend",
              "recover-and-retire-owner",
              "ensure-prepared-owner",
            ]);
            // The failed retry earns one complete cooldown tick. Even an
            // already healthy replacement cannot bypass the missing lease and
            // make the watchdog forget that the backend is still stopped.
            yield* TestClock.adjust(Duration.millis(1));
            yield* Effect.yieldNow;
            assert.equal(fixture.actions.length, 3);
            yield* TestClock.adjust(Duration.millis(1));
            yield* Effect.yieldNow;
            assert.deepStrictEqual(fixture.actions, [
              "stop-backend",
              "recover-and-retire-owner",
              "ensure-prepared-owner",
              "ensure-prepared-owner",
              "start-backend",
            ]);
            assert.equal(fixture.probes(), 1);
            assert.equal(fixture.observations(), 1);
            yield* Fiber.interrupt(watchdog);
          }).pipe(Effect.provide(TestClock.layer())),
        ),
    );
  }

  it.effect("does not retry pending Windows ownership recovery after quit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const quitting = yield* Ref.make(false);
        const fixture = pendingWindowsRecoveryFixture();
        const watchdog = yield* runProviderDaemonHealthWatchdog({
          ...fixture,
          quitting,
          checkInterval: Duration.millis(1),
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(1));
        yield* Effect.yieldNow;
        yield* Ref.set(quitting, true);
        yield* TestClock.adjust(Duration.millis(10));
        yield* Fiber.join(watchdog);
        assert.deepStrictEqual(fixture.actions, ["stop-backend", "recover-and-retire-owner"]);
        assert.equal(fixture.probes(), 1);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("does not restart the backend when quit arrives during pending Windows admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const quitting = yield* Ref.make(false);
        const admitted = yield* Deferred.make<ProviderDaemonClientConfig>();
        const admissionStarted = yield* Deferred.make<void>();
        const fixture = pendingWindowsRecoveryFixture({
          healthyWhilePending: true,
          ensure: () =>
            Deferred.succeed(admissionStarted, undefined).pipe(
              Effect.andThen(Deferred.await(admitted)),
            ),
        });
        const watchdog = yield* runProviderDaemonHealthWatchdog({
          ...fixture,
          quitting,
          checkInterval: Duration.millis(1),
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(1));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(1));
        yield* Deferred.await(admissionStarted);
        yield* Ref.set(quitting, true);
        yield* Deferred.succeed(admitted, endpoint);
        yield* Fiber.join(watchdog);
        assert.deepStrictEqual(fixture.actions, [
          "stop-backend",
          "recover-and-retire-owner",
          "ensure-prepared-owner",
        ]);
        assert.equal(fixture.probes(), 1);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  for (const status of ["same-process", "unknown", "different-process", "exited"] as const) {
    it.effect(
      `uses Windows ownership authority for ${status} without consulting PID existence`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const quitting = yield* Ref.make(false);
            const actions: string[] = [];
            let recovered = false;
            const providerDaemonManager: DesktopProviderDaemonManagerShape = {
              ensureRunning: Effect.succeed(endpoint),
              recover: (_reason, expected) =>
                Effect.sync(() => {
                  assert.equal(expected, "observed-generation");
                  actions.push("recover-daemon");
                  recovered = true;
                  return endpoint;
                }),
              currentConfig: Effect.succeed(Option.some(endpoint)),
              probeLiveness: Effect.sync(() =>
                recovered ? Option.some(liveDaemon) : Option.none(),
              ),
              observeProcessOwnership: Effect.sync(() => ({
                status,
                ownershipId: "observed-generation",
              })),
              refreshHealth: Effect.succeed(Option.none()),
              snapshot: Effect.sync(daemonSnapshot),
              stop: Effect.die("watchdog must not stop an unverified owner"),
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
              isDaemonProcessAlive: () => {
                throw new Error("PID-only observation is forbidden for Windows");
              },
            }).pipe(Effect.forkScoped);
            yield* Effect.yieldNow;
            yield* TestClock.adjust(Duration.millis(1));
            yield* Effect.yieldNow;
            yield* Fiber.interrupt(watchdog);
            assert.deepStrictEqual(
              actions,
              status === "exited" || status === "different-process"
                ? ["stop-backend", "recover-daemon", "start-backend"]
                : [],
            );
          }).pipe(Effect.provide(TestClock.layer())),
        ),
    );
  }

  it.effect("requires a Windows generation fence even when an injected observer reports exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const quitting = yield* Ref.make(false);
        let observations = 0;
        const providerDaemonManager: DesktopProviderDaemonManagerShape = {
          ensureRunning: Effect.succeed(endpoint),
          recover: () => Effect.die("unfenced recovery forbidden"),
          currentConfig: Effect.succeed(Option.some(endpoint)),
          probeLiveness: Effect.succeed(Option.none()),
          observeProcessOwnership: Effect.sync(() => {
            observations += 1;
            return { status: "exited" };
          }),
          refreshHealth: Effect.succeed(Option.none()),
          snapshot: Effect.sync(daemonSnapshot),
          stop: Effect.void,
        };
        const backendManager: DesktopBackendManagerShape = {
          start: Effect.die("unexpected restart"),
          stop: () => Effect.die("unexpected stop"),
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
          isDaemonProcessAlive: () => {
            throw new Error("forbidden PID fallback");
          },
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(1));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(watchdog);
        assert.equal(observations, 1);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("preserves a live daemon across sustained liveness probe failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const actions: string[] = [];
        let probeCount = 0;
        const quitting = yield* Ref.make(false);

        const providerDaemonManager: DesktopProviderDaemonManagerShape = {
          ensureRunning: Effect.succeed(endpoint),
          recover: () =>
            Effect.sync(() => {
              actions.push("recover-daemon");
              return endpoint;
            }),
          currentConfig: Effect.succeed(Option.some(endpoint)),
          probeLiveness: Effect.sync(() => {
            probeCount += 1;
            return Option.none();
          }),
          refreshHealth: Effect.succeed(Option.none()),
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
          warningThreshold: 2,
          isDaemonProcessAlive: () => true,
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(1));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(1));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(1));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(watchdog);

        assert.isAtLeast(probeCount, 3);
        assert.deepStrictEqual(actions, []);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("restarts the backend around a confirmed provider daemon exit", () =>
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
              assert.include(reason, `provider daemon process ${process.pid} exited`);
              actions.push("recover-daemon");
              recovered = true;
              return endpoint;
            }),
          currentConfig: Effect.succeed(Option.some(endpoint)),
          probeLiveness: Effect.sync(() => {
            probeCount += 1;
            return recovered ? Option.some(liveDaemon) : Option.none();
          }),
          refreshHealth: Effect.succeed(Option.none()),
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
          warningThreshold: 2,
          isDaemonProcessAlive: () => false,
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(1));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(watchdog);

        assert.isAtLeast(probeCount, 1);
        assert.deepStrictEqual(actions, ["stop-backend", "recover-daemon", "start-backend"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});
