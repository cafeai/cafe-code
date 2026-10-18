import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";

import type * as Electron from "electron";
import type { ProviderDaemonHealth } from "@cafecode/contracts";

import * as DesktopProviderDaemonManager from "../backend/DesktopProviderDaemonManager.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import { createDesktopRestartRequest } from "./DesktopProfileControl.ts";
import { DesktopDataProfileStartup } from "./DesktopDataProfile.ts";
import {
  runDesktopStartupUntilShutdown,
  startBackendAfterProviderDaemonReady,
} from "./DesktopApp.ts";

type BeforeQuitListener = (event: Electron.Event) => void;
type SecondInstanceListener = (
  event: Electron.Event,
  argv: readonly string[],
  workingDirectory: string,
  additionalData?: Record<string, unknown>,
) => void;

function makeEvent() {
  let preventDefaultCount = 0;
  return {
    event: {
      preventDefault: () => {
        preventDefaultCount += 1;
      },
    } as Electron.Event,
    preventDefaultCount: () => preventDefaultCount,
  };
}

const flushMicrotasks = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* Effect.yieldNow;
});

function makeProviderDaemonHealth(activeSessionCount: number): ProviderDaemonHealth {
  return {
    ok: true,
    mode: "provider-daemon",
    pid: 12_345,
    ppid: process.pid,
    version: "0.0.0-test",
    startedAt: "1970-01-01T00:00:00.000Z",
    activeSessionCount,
    configuredInstanceCount: 2,
    eventCursor: 0,
  };
}

function makeLifecycleHarness(options?: {
  readonly activeProviderSessionCount?: number;
  readonly providerDaemonDialogResponse?: number;
  readonly backendReady?: boolean;
  readonly daemonHealthRead?: Effect.Effect<Option.Option<ProviderDaemonHealth>>;
  readonly dataProfile?: "production" | "debug";
  readonly stateDir?: string;
  readonly pendingEarlyRestart?: boolean;
}) {
  let beforeQuitListener: BeforeQuitListener | undefined;
  let secondInstanceListener: SecondInstanceListener | undefined;
  let activateCount = 0;
  let quitCount = 0;
  let shutdownOverlayCount = 0;
  let providerDaemonStopCount = 0;
  let providerDaemonDialogCount = 0;
  let relaunchCount = 0;
  let earlyCaptureFinishCount = 0;
  const exitCodes: number[] = [];

  return Effect.gen(function* () {
    const overlaySent = yield* Deferred.make<void>();
    const relaunched = yield* Deferred.make<void>();

    const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
      metadata: Effect.die("unexpected metadata"),
      name: Effect.succeed("Cafe Code"),
      whenReady: Effect.void,
      quit: Effect.sync(() => {
        quitCount += 1;
      }),
      exit: (code) =>
        Effect.sync(() => {
          exitCodes.push(code);
        }),
      requestSingleInstanceLock: Effect.succeed(true),
      relaunch: () =>
        Effect.gen(function* () {
          relaunchCount += 1;
          yield* Deferred.succeed(relaunched, undefined);
        }),
      setPath: () => Effect.void,
      setName: () => Effect.void,
      setAboutPanelOptions: () => Effect.void,
      setAppUserModelId: () => Effect.void,
      setDesktopName: () => Effect.void,
      setDockIcon: () => Effect.void,
      appendCommandLineSwitch: () => Effect.void,
      on: (eventName, listener) =>
        Effect.sync(() => {
          if (eventName === "before-quit") {
            beforeQuitListener = listener as unknown as BeforeQuitListener;
          } else if (eventName === "second-instance") {
            secondInstanceListener = listener as unknown as SecondInstanceListener;
          }
        }),
    } satisfies ElectronApp.ElectronAppShape);

    const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
      create: () => Effect.die("unexpected create"),
      main: Effect.succeed(Option.none()),
      currentMainOrFirst: Effect.succeed(Option.none()),
      focusedMainOrFirst: Effect.succeed(Option.none()),
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      reveal: () => Effect.void,
      sendAll: (channel, action) =>
        Effect.gen(function* () {
          if (
            channel === IpcChannels.MENU_ACTION_CHANNEL &&
            action === "desktop-shutdown-started"
          ) {
            shutdownOverlayCount += 1;
            yield* Deferred.succeed(overlaySent, void 0);
          }
        }),
      destroyAll: Effect.void,
      syncAllAppearance: () => Effect.void,
    } satisfies ElectronWindow.ElectronWindowShape);

    const electronDialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
      pickFolder: () => Effect.die("unexpected pickFolder"),
      confirm: () => Effect.die("unexpected confirm"),
      showMessageBox: () =>
        Effect.sync(() => {
          providerDaemonDialogCount += 1;
          return {
            response: options?.providerDaemonDialogResponse ?? 0,
            checkboxChecked: false,
          };
        }),
      showErrorBox: () => Effect.void,
    } satisfies ElectronDialog.ElectronDialogShape);

    const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
      shouldUseDarkColors: Effect.succeed(false),
      setSource: () => Effect.void,
      onUpdated: () => Effect.void,
    } satisfies ElectronTheme.ElectronThemeShape);

    const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
      createMain: Effect.die("unexpected createMain"),
      ensureMain: Effect.die("unexpected ensureMain"),
      revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
      activate: Effect.sync(() => {
        activateCount += 1;
      }),
      createMainIfBackendReady: Effect.void,
      handleBackendReady: Effect.void,
      dispatchMenuAction: () => Effect.void,
      syncAppearance: Effect.void,
    } satisfies DesktopWindow.DesktopWindowShape);

    const desktopEnvironmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      platform: "darwin",
      isDevelopment: false,
      dataProfile: options?.dataProfile ?? "debug",
      configuredBaseDir: "/synthetic/cafe",
      stateDir: options?.stateDir ?? "/synthetic/cafe/.debug/userdata",
    } as DesktopEnvironment.DesktopEnvironmentShape);

    const providerDaemonLayer = Layer.succeed(
      DesktopProviderDaemonManager.DesktopProviderDaemonManager,
      {
        ensureRunning: Effect.die("unexpected ensureRunning"),
        recover: () => Effect.die("unexpected recover"),
        currentConfig: Effect.succeed(Option.none()),
        probeLiveness: Effect.succeed(Option.none()),
        refreshHealth:
          options?.daemonHealthRead ??
          Effect.succeed(
            Option.some(makeProviderDaemonHealth(options?.activeProviderSessionCount ?? 0)),
          ),
        snapshot: Effect.die("unexpected snapshot"),
        stop: Effect.sync(() => {
          providerDaemonStopCount += 1;
        }),
      } satisfies DesktopProviderDaemonManager.DesktopProviderDaemonManagerShape,
    );

    const layer = Layer.mergeAll(
      DesktopLifecycle.layer,
      DesktopLifecycle.layerShutdown,
      Layer.effect(
        DesktopState.DesktopState,
        Effect.all({
          backendReady: Ref.make(options?.backendReady ?? true),
          quitting: Ref.make(false),
        }),
      ),
      desktopEnvironmentLayer,
      desktopWindowLayer,
      providerDaemonLayer,
      electronAppLayer,
      electronDialogLayer,
      electronThemeLayer,
      electronWindowLayer,
      options?.pendingEarlyRestart === undefined
        ? Layer.empty
        : Layer.succeed(DesktopDataProfileStartup, {
            finishEarlyCapture: () => {
              earlyCaptureFinishCount += 1;
              return options.pendingEarlyRestart === true;
            },
          }),
      TestClock.layer(),
    );

    return {
      layer,
      overlaySent,
      relaunched,
      getBeforeQuitListener: () => beforeQuitListener,
      getSecondInstanceListener: () => secondInstanceListener,
      getActivateCount: () => activateCount,
      getQuitCount: () => quitCount,
      getShutdownOverlayCount: () => shutdownOverlayCount,
      getProviderDaemonStopCount: () => providerDaemonStopCount,
      getProviderDaemonDialogCount: () => providerDaemonDialogCount,
      getRelaunchCount: () => relaunchCount,
      getExitCodes: () => [...exitCodes],
      getEarlyCaptureFinishCount: () => earlyCaptureFinishCount,
    };
  });
}

describe("DesktopLifecycle", () => {
  it.effect("cancels pending readiness without deadlocking on a migration-owned health lock", () =>
    Effect.gen(function* () {
      let healthReads = 0;
      let startupCancelled = false;
      let backendStarts = 0;
      const lifecycleMutex = yield* Semaphore.make(1);
      const ownsStartupLock = yield* Deferred.make<void>();
      const harness = yield* makeLifecycleHarness({
        backendReady: false,
        activeProviderSessionCount: 2,
        daemonHealthRead: Effect.sync(() => {
          healthReads += 1;
        }).pipe(
          Effect.andThen(
            lifecycleMutex.withPermits(1)(Effect.succeed(Option.some(makeProviderDaemonHealth(2)))),
          ),
        ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const shutdown = yield* DesktopLifecycle.DesktopShutdown;
          const state = yield* DesktopState.DesktopState;
          yield* lifecycle.register;
          const startup = yield* runDesktopStartupUntilShutdown({
            startup: startBackendAfterProviderDaemonReady({
              providerDaemonReady: lifecycleMutex.withPermits(1)(
                Deferred.succeed(ownsStartupLock, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Effect.sync(() => {
                      startupCancelled = true;
                    }),
                  ),
                ),
              ),
              startBackend: Effect.sync(() => {
                backendStarts += 1;
              }),
              quitting: state.quitting,
            }),
            awaitShutdown: shutdown.awaitRequest,
          }).pipe(Effect.ensuring(shutdown.markComplete), Effect.forkChild);
          yield* Deferred.await(ownsStartupLock);
          const beforeQuit = harness.getBeforeQuitListener();
          assert.isDefined(beforeQuit);
          const quitEvent = makeEvent();
          beforeQuit!(quitEvent.event);
          yield* shutdown.awaitRequest;
          assert.equal(yield* Fiber.join(startup), "shutdown");
          assert.equal(startupCancelled, true);
          assert.equal(backendStarts, 0);
          assert.equal(healthReads, 0, "Quit must not request the lock held by startup");
          assert.equal(
            (yield* lifecycleMutex.withPermitsIfAvailable(1)(Effect.void))._tag,
            "Some",
            "startup cancellation must release its exact lifecycle lock",
          );
          assert.equal(harness.getProviderDaemonDialogCount(), 0);
          assert.equal(harness.getProviderDaemonStopCount(), 0);
          yield* TestClock.adjust(DesktopLifecycle.DESKTOP_SHUTDOWN_OVERLAY_MINIMUM_DWELL);
          yield* flushMicrotasks;
          assert.equal(harness.getQuitCount(), 1);
        }),
      ).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps the shutdown overlay visible for the minimum dwell before quitting", () =>
    Effect.gen(function* () {
      const harness = yield* makeLifecycleHarness();

      yield* Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        const shutdown = yield* DesktopLifecycle.DesktopShutdown;
        yield* lifecycle.register;

        const beforeQuit = harness.getBeforeQuitListener();
        assert.isDefined(beforeQuit);
        if (!beforeQuit) {
          throw new Error("before-quit listener was not registered.");
        }
        const quitEvent = makeEvent();
        beforeQuit(quitEvent.event);

        yield* Deferred.await(harness.overlaySent);
        assert.equal(quitEvent.preventDefaultCount(), 1);
        assert.equal(harness.getShutdownOverlayCount(), 1);
        assert.equal(harness.getProviderDaemonDialogCount(), 0);

        yield* shutdown.markComplete;
        yield* TestClock.adjust(Duration.millis(2_999));
        yield* flushMicrotasks;
        assert.equal(harness.getQuitCount(), 0);

        yield* TestClock.adjust(Duration.millis(1));
        yield* flushMicrotasks;
        assert.equal(harness.getQuitCount(), 1);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }),
  );

  it.effect("ignores duplicate quit requests while shutdown is already in progress", () =>
    Effect.gen(function* () {
      const harness = yield* makeLifecycleHarness();

      yield* Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        const shutdown = yield* DesktopLifecycle.DesktopShutdown;
        yield* lifecycle.register;

        const beforeQuit = harness.getBeforeQuitListener();
        assert.isDefined(beforeQuit);
        if (!beforeQuit) {
          throw new Error("before-quit listener was not registered.");
        }
        const firstEvent = makeEvent();
        const secondEvent = makeEvent();

        beforeQuit(firstEvent.event);
        beforeQuit(secondEvent.event);

        yield* Deferred.await(harness.overlaySent);
        yield* flushMicrotasks;
        assert.equal(firstEvent.preventDefaultCount(), 1);
        assert.equal(secondEvent.preventDefaultCount(), 1);
        assert.equal(harness.getShutdownOverlayCount(), 1);

        yield* shutdown.markComplete;
        yield* TestClock.adjust(DesktopLifecycle.DESKTOP_SHUTDOWN_OVERLAY_MINIMUM_DWELL);
        yield* flushMicrotasks;
        assert.equal(harness.getQuitCount(), 1);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }),
  );

  it.effect("activates the existing window when a second desktop instance starts", () =>
    Effect.gen(function* () {
      const harness = yield* makeLifecycleHarness();

      yield* Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        yield* lifecycle.register;

        const secondInstance = harness.getSecondInstanceListener();
        assert.isDefined(secondInstance);
        if (!secondInstance) {
          throw new Error("second-instance listener was not registered.");
        }

        secondInstance({} as Electron.Event, ["Cafe Code"], "/repo", { source: "test" });
        yield* flushMicrotasks;

        assert.equal(harness.getActivateCount(), 1);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }),
  );

  it.effect("lets only the exact native profile owner perform one graceful relaunch", () =>
    Effect.gen(function* () {
      const harness = yield* makeLifecycleHarness();
      yield* Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        const shutdown = yield* DesktopLifecycle.DesktopShutdown;
        yield* lifecycle.register;
        const secondInstance = harness.getSecondInstanceListener();
        if (!secondInstance) throw new Error("second-instance listener was not registered.");
        const request = createDesktopRestartRequest({
          dataProfile: "debug",
          stateDir: "/synthetic/cafe/.debug/userdata",
        });
        secondInstance(
          {} as Electron.Event,
          ["Cafe Code", "--cafe-restart-existing"],
          "/repo",
          request,
        );
        secondInstance(
          {} as Electron.Event,
          ["Cafe Code", "--cafe-restart-existing"],
          "/repo",
          request,
        );
        yield* shutdown.awaitRequest;
        assert.equal(harness.getRelaunchCount(), 0);
        assert.deepEqual(harness.getExitCodes(), []);
        // Relaunch is owned by the existing lifecycle shutdown completion,
        // never a timer or the external helper's belief that a PID has exited.
        yield* shutdown.markComplete;
        yield* Deferred.await(harness.relaunched);
        yield* flushMicrotasks;
        assert.equal(harness.getRelaunchCount(), 1);
        assert.deepEqual(harness.getExitCodes(), [0]);
        assert.equal(harness.getActivateCount(), 0);
        assert.equal(harness.getProviderDaemonStopCount(), 0);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }),
  );

  it.effect("does not stop Production for a Debug request or an unproved argv flag", () =>
    Effect.gen(function* () {
      const harness = yield* makeLifecycleHarness({
        dataProfile: "production",
        stateDir: "/synthetic/cafe/userdata",
      });
      yield* Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        const state = yield* DesktopState.DesktopState;
        yield* lifecycle.register;
        const secondInstance = harness.getSecondInstanceListener();
        if (!secondInstance) throw new Error("second-instance listener was not registered.");
        secondInstance(
          {} as Electron.Event,
          ["Cafe Code", "--cafe-restart-existing"],
          "/repo",
          createDesktopRestartRequest({
            dataProfile: "debug",
            stateDir: "/synthetic/cafe/.debug/userdata",
          }),
        );
        secondInstance(
          {} as Electron.Event,
          ["Cafe Code", "--cafe-restart-existing"],
          "/repo",
          undefined,
        );
        secondInstance(
          {} as Electron.Event,
          ["Cafe Code"],
          "/repo",
          createDesktopRestartRequest({
            dataProfile: "production",
            stateDir: "/synthetic/another/userdata",
          }),
        );
        yield* flushMicrotasks;
        assert.equal(harness.getActivateCount(), 3);
        assert.equal(harness.getRelaunchCount(), 0);
        assert.deepEqual(harness.getExitCodes(), []);
        assert.equal(yield* Ref.get(state.quitting), false);
        assert.equal(harness.getProviderDaemonStopCount(), 0);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }),
  );

  it.effect("drains an admitted startup request after the permanent receiver is registered", () =>
    Effect.gen(function* () {
      const harness = yield* makeLifecycleHarness({ pendingEarlyRestart: true });
      yield* Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        const shutdown = yield* DesktopLifecycle.DesktopShutdown;
        yield* lifecycle.register;
        assert.isDefined(harness.getSecondInstanceListener());
        assert.equal(harness.getEarlyCaptureFinishCount(), 1);
        yield* shutdown.awaitRequest;
        assert.equal(harness.getRelaunchCount(), 0);
        yield* shutdown.markComplete;
        yield* Deferred.await(harness.relaunched);
        yield* flushMicrotasks;
        assert.equal(harness.getRelaunchCount(), 1);
        assert.equal(harness.getActivateCount(), 0);
        assert.deepEqual(harness.getExitCodes(), [0]);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }),
  );

  it.effect("stops the provider daemon when active sessions exist and the user chooses stop", () =>
    Effect.gen(function* () {
      const harness = yield* makeLifecycleHarness({
        activeProviderSessionCount: 2,
        providerDaemonDialogResponse: 1,
      });

      yield* Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        const shutdown = yield* DesktopLifecycle.DesktopShutdown;
        yield* lifecycle.register;

        const beforeQuit = harness.getBeforeQuitListener();
        assert.isDefined(beforeQuit);
        if (!beforeQuit) {
          throw new Error("before-quit listener was not registered.");
        }

        const quitEvent = makeEvent();
        beforeQuit(quitEvent.event);

        yield* Deferred.await(harness.overlaySent);
        assert.equal(quitEvent.preventDefaultCount(), 1);
        assert.equal(harness.getProviderDaemonDialogCount(), 1);

        yield* shutdown.markComplete;
        yield* TestClock.adjust(DesktopLifecycle.DESKTOP_SHUTDOWN_OVERLAY_MINIMUM_DWELL);
        yield* flushMicrotasks;
        assert.equal(harness.getProviderDaemonStopCount(), 1);
        assert.equal(harness.getQuitCount(), 1);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }),
  );

  it.effect("cancels quit when active provider sessions exist and the user cancels", () =>
    Effect.gen(function* () {
      const harness = yield* makeLifecycleHarness({
        activeProviderSessionCount: 1,
        providerDaemonDialogResponse: 2,
      });

      yield* Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        yield* lifecycle.register;

        const beforeQuit = harness.getBeforeQuitListener();
        assert.isDefined(beforeQuit);
        if (!beforeQuit) {
          throw new Error("before-quit listener was not registered.");
        }

        const quitEvent = makeEvent();
        beforeQuit(quitEvent.event);
        yield* flushMicrotasks;

        assert.equal(quitEvent.preventDefaultCount(), 1);
        assert.equal(harness.getProviderDaemonDialogCount(), 1);
        assert.equal(harness.getShutdownOverlayCount(), 0);
        assert.equal(harness.getProviderDaemonStopCount(), 0);
        assert.equal(harness.getQuitCount(), 0);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }),
  );
});
