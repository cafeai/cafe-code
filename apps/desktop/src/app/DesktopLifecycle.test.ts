import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

type BeforeQuitListener = (event: Electron.Event) => void;

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

function makeLifecycleHarness() {
  let beforeQuitListener: BeforeQuitListener | undefined;
  let quitCount = 0;
  let shutdownOverlayCount = 0;

  return Effect.gen(function* () {
    const overlaySent = yield* Deferred.make<void>();

    const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
      metadata: Effect.die("unexpected metadata"),
      name: Effect.succeed("Cafe Code"),
      whenReady: Effect.void,
      quit: Effect.sync(() => {
        quitCount += 1;
      }),
      exit: () => Effect.void,
      relaunch: () => Effect.void,
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

    const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
      shouldUseDarkColors: Effect.succeed(false),
      setSource: () => Effect.void,
      onUpdated: () => Effect.void,
    } satisfies ElectronTheme.ElectronThemeShape);

    const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
      createMain: Effect.die("unexpected createMain"),
      ensureMain: Effect.die("unexpected ensureMain"),
      revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
      activate: Effect.void,
      createMainIfBackendReady: Effect.void,
      handleBackendReady: Effect.void,
      dispatchMenuAction: () => Effect.void,
      syncAppearance: Effect.void,
    } satisfies DesktopWindow.DesktopWindowShape);

    const desktopEnvironmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      platform: "darwin",
      isDevelopment: false,
    } as DesktopEnvironment.DesktopEnvironmentShape);

    const layer = Layer.mergeAll(
      DesktopLifecycle.layer,
      DesktopLifecycle.layerShutdown,
      DesktopState.layer,
      desktopEnvironmentLayer,
      desktopWindowLayer,
      electronAppLayer,
      electronThemeLayer,
      electronWindowLayer,
      TestClock.layer(),
    );

    return {
      layer,
      overlaySent,
      getBeforeQuitListener: () => beforeQuitListener,
      getQuitCount: () => quitCount,
      getShutdownOverlayCount: () => shutdownOverlayCount,
    };
  });
}

describe("DesktopLifecycle", () => {
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
});
