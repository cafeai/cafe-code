import { createHash, randomUUID } from "node:crypto";
import type * as Electron from "electron";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import type { ProviderDaemonStartupProgress } from "@cafecode/shared/backendStartupProgress";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import {
  createDesktopStartupDocument,
  DESKTOP_STARTUP_STYLE,
  type DesktopStartupPhase,
} from "@cafecode/shared/desktopStartupDocument";

export const DESKTOP_STARTUP_WINDOW_DELAY = Duration.millis(250);
const styleSha256 = createHash("sha256").update(DESKTOP_STARTUP_STYLE).digest("base64");
const { logWarning } = DesktopObservability.makeComponentLogger("desktop-startup-window");

export interface DesktopStartupWindowShape {
  readonly begin: Effect.Effect<void, never, Scope.Scope>;
  readonly update: (progress: ProviderDaemonStartupProgress) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export class DesktopStartupWindow extends Context.Service<
  DesktopStartupWindow,
  DesktopStartupWindowShape
>()("cafecode/desktop/StartupWindow") {}

/** Only main-owned observations can call these methods; this page has no IPC. */
export const makeDesktopStartupWindow = Effect.fn("desktop.startupWindow.make")(function* (input: {
  readonly create: ElectronWindow.ElectronWindowShape["create"];
  readonly appearance: Effect.Effect<{ readonly dark: boolean; readonly scalePercent: number }>;
  readonly onThemeUpdated: ElectronTheme.ElectronThemeShape["onUpdated"];
  readonly requestQuit: Effect.Effect<void>;
  readonly quitting: Ref.Ref<boolean>;
}) {
  let phase: DesktopStartupPhase = "starting";
  let window: Electron.BrowserWindow | undefined;
  let delayFiber: Fiber.Fiber<void> | undefined;
  let begun = false;
  let closed = false;
  let quitPending = false;
  let documentUrl = "";
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);

  const render = (target: Electron.BrowserWindow) => {
    if (closed || window !== target || target.isDestroyed()) return;
    const nextUrl = `data:text/html;charset=utf-8,${encodeURIComponent(createDesktopStartupDocument(phase, styleSha256))}`;
    if (nextUrl === documentUrl) return;
    documentUrl = nextUrl;
    // Reloads contain only the finite trusted phase copy. Do not execute JS in
    // this auxiliary renderer just to update one status line.
    void target.loadURL(nextUrl).catch(() => {
      if (!closed && window === target && !target.isDestroyed()) {
        void runPromise(logWarning("startup status document could not be displayed"));
      }
    });
  };

  const disposeWindow = () => {
    const target = window;
    window = undefined;
    documentUrl = "";
    // Set the role/lifetime fence before destroy dispatches its close events.
    // Replacing this view with the real main window must never request Quit.
    if (target && !target.isDestroyed()) target.destroy();
  };

  const close = Effect.gen(function* () {
    closed = true;
    disposeWindow();
    const fiber = delayFiber;
    delayFiber = undefined;
    if (fiber) yield* Fiber.interrupt(fiber);
  });
  yield* Effect.addFinalizer(() => close);

  yield* input.onThemeUpdated(() => {
    void runPromise(
      Effect.gen(function* () {
        const target = window;
        if (!target || closed || target.isDestroyed()) return;
        const appearance = yield* input.appearance;
        if (closed || window !== target || target.isDestroyed()) return;
        target.setBackgroundColor(appearance.dark ? "#161616" : "#f9f9f9");
        // The inert CSS media query follows nativeTheme. No provider state or
        // page capabilities are involved in appearance synchronization.
      }),
    );
  });

  const begin = Effect.gen(function* () {
    if (begun || closed || (yield* Ref.get(input.quitting))) return;
    begun = true;
    delayFiber = yield* Effect.gen(function* () {
      yield* Effect.sleep(DESKTOP_STARTUP_WINDOW_DELAY);
      if (closed || (yield* Ref.get(input.quitting))) return;
      const appearance = yield* input.appearance;
      if (closed || (yield* Ref.get(input.quitting))) return;
      const target = yield* input.create({
        width: 440,
        height: 230,
        minWidth: 320,
        minHeight: 220,
        show: false,
        resizable: true,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        title: "Cafe Code",
        backgroundColor: appearance.dark ? "#161616" : "#f9f9f9",
        webPreferences: {
          // An ephemeral session avoids sharing ordinary provider permissions,
          // storage or network hooks. Never supply a preload or trustWebContents.
          partition: `cafe-startup-${randomUUID()}`,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          javascript: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          spellcheck: false,
          devTools: false,
        },
      });
      ElectronWindow.markAuxiliaryWindow(target);
      if (closed || (yield* Ref.get(input.quitting))) {
        target.destroy();
        return;
      }
      window = target;
      target.setMenu(null);
      target.webContents.session.setPermissionRequestHandler((_contents, _permission, done) =>
        done(false),
      );
      target.webContents.session.setPermissionCheckHandler(() => false);
      target.webContents.session.on("will-download", (event) => event.preventDefault());
      target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      target.webContents.on("will-navigate", (event) => event.preventDefault());
      target.webContents.on("will-frame-navigate", (event) => event.preventDefault());
      const scalePercent = Number.isFinite(appearance.scalePercent)
        ? Math.max(80, Math.min(130, appearance.scalePercent))
        : 100;
      target.webContents.setZoomFactor(scalePercent / 100);
      target.on("close", (event) => {
        if (closed || window !== target) return;
        event.preventDefault();
        if (quitPending) return;
        quitPending = true;
        // Preserve the existing provider-session leave-running/cancel policy.
        // The main process, not this page, owns every shutdown decision.
        void runPromise(input.requestQuit)
          .catch(() => runPromise(logWarning("startup status quit request unavailable")))
          .finally(() => {
            quitPending = false;
          });
      });
      target.once("ready-to-show", () => {
        if (!closed && window === target && !target.isDestroyed()) target.show();
      });
      render(target);
    }).pipe(
      Effect.catchCause(() =>
        logWarning("startup status window unavailable; continuing normal startup"),
      ),
      Effect.forkScoped,
    );
  });

  return DesktopStartupWindow.of({
    begin,
    update: (progress) =>
      Effect.sync(() => {
        if (closed) return;
        if (progress.phase === "failed") {
          closed = true;
          disposeWindow();
          return;
        }
        phase = progress.phase;
        if (window) render(window);
      }),
    close,
  });
});

export const layer = Layer.effect(
  DesktopStartupWindow,
  Effect.gen(function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const electronApp = yield* ElectronApp.ElectronApp;
    const state = yield* DesktopState.DesktopState;
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    return yield* makeDesktopStartupWindow({
      create: electronWindow.create,
      appearance: Effect.gen(function* () {
        const settings = yield* clientSettings.get;
        return {
          dark: yield* electronTheme.shouldUseDarkColors,
          scalePercent: Option.isSome(settings) ? settings.value.interfaceScalePercent : 100,
        };
      }),
      onThemeUpdated: electronTheme.onUpdated,
      requestQuit: electronApp.quit,
      quitting: state.quitting,
    });
  }),
);
