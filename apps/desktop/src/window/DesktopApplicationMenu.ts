import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";
import { subscribeUiLocale, uiText } from "@cafecode/shared/i18n";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import { autoUpdateDisabledReasonForUi } from "../updates/updateEligibility.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export interface DesktopApplicationMenuShape {
  readonly configure: Effect.Effect<void>;
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  DesktopApplicationMenuShape
>()("cafecode/desktop/ApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog;

const { logInfo: logUpdaterInfo } = DesktopObservability.makeComponentLogger("desktop-updater");

const { logError: logMenuError } = DesktopObservability.makeComponentLogger("desktop-menu");

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action);
});

const checkForUpdatesFromMenu: Effect.Effect<
  void,
  never,
  DesktopUpdates.DesktopUpdates | ElectronDialog.ElectronDialog
> = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const result = yield* updates.check("menu");
  const updateState = result.state;

  if (updateState.status === "up-to-date") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: uiText("You''re up to date!"),
      message: uiText("Cafe Code {version} is currently the newest version available.", {
        version: updateState.currentVersion,
      }),
      buttons: [uiText("OK")],
    });
  } else if (updateState.status === "error") {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: uiText("Update check failed"),
      message: uiText("Could not check for updates."),
      detail: updateState.message ?? uiText("An unknown error occurred. Please try again later."),
      buttons: [uiText("OK")],
    });
  }
}).pipe(Effect.withSpan("desktop.menu.checkForUpdates"));

const handleCheckForUpdatesMenuClick: Effect.Effect<
  void,
  DesktopWindow.DesktopWindowError,
  DesktopUpdates.DesktopUpdates | ElectronDialog.ElectronDialog | DesktopWindow.DesktopWindow
> = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const disabledReason = yield* updates.disabledReason;
  if (Option.isSome(disabledReason)) {
    yield* logUpdaterInfo("manual update check requested, but updates are disabled", {
      disabledReason: disabledReason.value,
    });
    yield* electronDialog.showMessageBox({
      type: "info",
      title: uiText("Updates unavailable"),
      message: uiText("Automatic updates are not available right now."),
      detail: autoUpdateDisabledReasonForUi(disabledReason.value),
      buttons: [uiText("OK")],
    });
    return;
  }

  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.ensureMain;
  yield* checkForUpdatesFromMenu;
}).pipe(Effect.withSpan("desktop.menu.handleCheckForUpdatesClick"));

const make = Effect.gen(function* () {
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const updatesDisabledReason = yield* updates.disabledReason;
  const updatesMenuEnabled = Option.isNone(updatesDisabledReason);
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);
  let configured = false;

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) =>
          logMenuError("desktop menu action failed", {
            action,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    );
  };

  const configure = Effect.gen(function* () {
    const checkForUpdatesClick = () => {
      runMenuEffect("check-for-updates", handleCheckForUpdatesMenuClick);
    };
    const settingsClick = () => {
      runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
    };
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (environment.platform === "darwin") {
      template.push({
        label: environment.branding.baseName,
        submenu: [
          { role: "about", label: uiText("About {app}", { app: environment.branding.baseName }) },
          {
            label: uiText("Check for Updates..."),
            enabled: updatesMenuEnabled,
            click: checkForUpdatesClick,
          },
          { type: "separator" },
          {
            label: uiText("Settings..."),
            accelerator: "CmdOrCtrl+,",
            click: settingsClick,
          },
          { type: "separator" },
          { role: "services", label: uiText("Services") },
          { type: "separator" },
          { role: "hide", label: uiText("Hide {app}", { app: environment.branding.baseName }) },
          { role: "hideOthers", label: uiText("Hide Others") },
          { role: "unhide", label: uiText("Show All") },
          { type: "separator" },
          { role: "quit", label: uiText("Quit {app}", { app: environment.branding.baseName }) },
        ],
      });
    }

    template.push(
      {
        label: uiText("File"),
        submenu: [
          ...(environment.platform === "darwin"
            ? []
            : [
                {
                  label: uiText("Settings..."),
                  accelerator: "CmdOrCtrl+,",
                  click: settingsClick,
                },
                { type: "separator" as const },
              ]),
          {
            role: environment.platform === "darwin" ? "close" : "quit",
            label:
              environment.platform === "darwin"
                ? uiText("Close Window")
                : environment.platform === "win32"
                  ? uiText("Exit")
                  : uiText("Quit"),
          },
        ],
      },
      { role: "editMenu", label: uiText("Edit") },
      {
        label: uiText("View"),
        submenu: [
          { role: "reload", label: uiText("Reload") },
          { role: "forceReload", label: uiText("Force Reload") },
          { role: "toggleDevTools", label: uiText("Toggle Developer Tools") },
          { type: "separator" },
          { role: "resetZoom", label: uiText("Actual Size") },
          { role: "zoomIn", label: uiText("Zoom In"), accelerator: "CmdOrCtrl+=" },
          {
            role: "zoomIn",
            label: uiText("Zoom In"),
            accelerator: "CmdOrCtrl+Plus",
            visible: false,
          },
          { role: "zoomOut", label: uiText("Zoom Out") },
          { type: "separator" },
          { role: "togglefullscreen", label: uiText("Toggle Full Screen") },
        ],
      },
      { role: "windowMenu", label: uiText("Window") },
      {
        role: "help",
        label: uiText("Help"),
        submenu: [
          {
            label: uiText("Check for Updates..."),
            enabled: updatesMenuEnabled,
            click: checkForUpdatesClick,
          },
        ],
      },
    );

    yield* electronMenu.setApplicationMenu(template);
    configured = true;
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  // Locale changes rebuild labels only. Existing role/accelerator/action
  // identities stay canonical, and no menu appears before startup admission.
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      subscribeUiLocale(() => {
        if (configured) void runPromise(configure);
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );

  return DesktopApplicationMenu.of({
    configure,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
