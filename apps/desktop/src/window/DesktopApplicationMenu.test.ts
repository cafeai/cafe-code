import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";
import { setUiLocale, uiText } from "@cafecode/shared/i18n";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "linux",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
  metadata: Effect.die("unexpected metadata read"),
  name: Effect.succeed("Cafe Code"),
  whenReady: Effect.void,
  quit: Effect.void,
  exit: () => Effect.void,
  requestSingleInstanceLock: Effect.succeed(true),
  relaunch: () => Effect.void,
  setPath: () => Effect.void,
  setName: () => Effect.void,
  setAboutPanelOptions: () => Effect.void,
  setAppUserModelId: () => Effect.void,
  setDesktopName: () => Effect.void,
  setDockIcon: () => Effect.void,
  appendCommandLineSwitch: () => Effect.void,
  on: () => Effect.void,
} satisfies ElectronApp.ElectronAppShape);

const electronDialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
  pickFolder: () => Effect.succeed(Option.none()),
  confirm: () => Effect.succeed(false),
  showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
  showErrorBox: () => Effect.void,
} satisfies ElectronDialog.ElectronDialogShape);

const desktopUpdatesLayer = Layer.succeed(DesktopUpdates.DesktopUpdates, {
  getState: Effect.die("unexpected getState"),
  emitState: Effect.void,
  disabledReason: Effect.succeed(Option.none()),
  configure: Effect.void,
  setChannel: () => Effect.die("unexpected setChannel"),
  check: () => Effect.die("unexpected check"),
  download: Effect.die("unexpected download"),
  install: Effect.die("unexpected install"),
} satisfies DesktopUpdates.DesktopUpdatesShape);

const makeDesktopWindowLayer = (selectedAction: Deferred.Deferred<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    handleBackendReady: Effect.void,
    dispatchMenuAction: (action) => Deferred.succeed(selectedAction, action).pipe(Effect.asVoid),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindowShape);

const makeElectronMenuLayer = (
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
) =>
  Layer.succeed(ElectronMenu.ElectronMenu, {
    setApplicationMenu: (template) =>
      Deferred.succeed(applicationMenuTemplate, template).pipe(Effect.asVoid),
    popupTemplate: () => Effect.void,
    showContextMenu: () => Effect.succeed(Option.none()),
  } satisfies ElectronMenu.ElectronMenuShape);

describe("DesktopApplicationMenu", () => {
  it.effect(
    "rebuilds authored labels on a language switch without changing native roles or invoking actions",
    () =>
      Effect.gen(function* () {
        setUiLocale("en");
        const selectedAction = yield* Deferred.make<string>();
        const templates: (readonly Electron.MenuItemConstructorOptions[])[] = [];
        const layer = DesktopApplicationMenu.layer.pipe(
          Layer.provideMerge(
            Layer.succeed(ElectronMenu.ElectronMenu, {
              setApplicationMenu: (template) =>
                Effect.sync(() => {
                  templates.push(template);
                }),
              popupTemplate: () => Effect.void,
              showContextMenu: () => Effect.succeed(Option.none()),
            }),
          ),
          Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
          Layer.provideMerge(desktopUpdatesLayer),
          Layer.provideMerge(electronDialogLayer),
          Layer.provideMerge(electronAppLayer),
          Layer.provideMerge(
            DesktopEnvironment.layer(environmentInput).pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
            ),
          ),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
            setUiLocale("ja");
            assert.equal(templates.length, 0, "language must not reveal a menu before configure");
            yield* menu.configure;
            setUiLocale("ko");
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            assert.equal(templates.length, 2);
            for (const [index, locale] of ["ja", "ko"].entries()) {
              const template = templates[index]!;
              assert.equal(
                template.find((item) => item.role === "editMenu")?.label,
                uiText("Edit", undefined, undefined, locale as "ja" | "ko"),
              );
              assert.equal(template.find((item) => item.role === "editMenu")?.submenu, undefined);
              const file = template.find(
                (item) =>
                  item.label === uiText("File", undefined, undefined, locale as "ja" | "ko"),
              );
              assert.isArray(file?.submenu);
              const items = file!.submenu as Electron.MenuItemConstructorOptions[];
              assert.equal(
                items.find((item) => item.accelerator === "CmdOrCtrl+,")?.label,
                uiText("Settings...", undefined, undefined, locale as "ja" | "ko"),
              );
              assert.equal(
                items.find((item) => item.role === "quit")?.label,
                uiText("Quit", undefined, undefined, locale as "ja" | "ko"),
              );
            }
            assert.isFalse(yield* Deferred.isDone(selectedAction));
          }).pipe(Effect.provide(layer)),
        );
        const count = templates.length;
        setUiLocale("en");
        yield* Effect.yieldNow;
        assert.equal(
          templates.length,
          count,
          "retired scope must remove the native label observer",
        );
      }).pipe(Effect.ensuring(Effect.sync(() => setUiLocale("en")))),
  );
  for (const platform of ["darwin", "linux", "win32"] as const) {
    it.effect(`preserves ${platform} native role labels and zoom accelerators`, () =>
      Effect.gen(function* () {
        const selectedAction = yield* Deferred.make<string>();
        const applicationMenuTemplate =
          yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
        yield* Effect.gen(function* () {
          const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
          yield* menu.configure;
        }).pipe(
          Effect.provide(
            DesktopApplicationMenu.layer.pipe(
              Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
              Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
              Layer.provideMerge(desktopUpdatesLayer),
              Layer.provideMerge(electronDialogLayer),
              Layer.provideMerge(electronAppLayer),
              Layer.provideMerge(
                DesktopEnvironment.layer({ ...environmentInput, platform }).pipe(
                  Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
                ),
              ),
            ),
          ),
        );
        const template = yield* Deferred.await(applicationMenuTemplate);
        const fileSubmenu = template.find((item) => item.label === "File")?.submenu;
        assert.isArray(fileSubmenu);
        if (!Array.isArray(fileSubmenu)) throw new Error("Expected native File submenu.");
        const closing = fileSubmenu.find(
          (item) => item.role === (platform === "darwin" ? "close" : "quit"),
        );
        assert.equal(
          closing?.label,
          platform === "darwin" ? "Close Window" : platform === "win32" ? "Exit" : "Quit",
        );
        const viewSubmenu = template.find((item) => item.label === "View")?.submenu;
        assert.isArray(viewSubmenu);
        if (!Array.isArray(viewSubmenu)) throw new Error("Expected native View submenu.");
        assert.deepEqual(
          viewSubmenu
            .filter((item) => item.role === "zoomIn")
            .map((item) => ({
              label: item.label,
              accelerator: item.accelerator,
              visible: item.visible,
            })),
          [
            { label: "Zoom In", accelerator: "CmdOrCtrl+=", visible: undefined },
            { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", visible: false },
          ],
        );
        if (platform === "darwin") {
          const application = template[0]?.submenu;
          assert.isArray(application);
          if (!Array.isArray(application)) throw new Error("Expected native application submenu.");
          assert.equal(application.find((item) => item.role === "about")?.label, "About Cafe Code");
          assert.equal(application.find((item) => item.role === "hide")?.label, "Hide Cafe Code");
          assert.equal(application.find((item) => item.role === "quit")?.label, "Quit Cafe Code");
          assert.equal(application.find((item) => item.role === "services")?.submenu, undefined);
        }
        // The OS still creates Edit/Window child menus; localizing wrappers
        // does not replace native undo, spelling, focus or window management.
        assert.equal(template.find((item) => item.role === "editMenu")?.submenu, undefined);
        assert.equal(template.find((item) => item.role === "windowMenu")?.submenu, undefined);
      }),
    );
  }

  it.effect("installs the native menu and routes Settings through DesktopWindow", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* Effect.gen(function* () {
        const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
        yield* menu.configure;
      }).pipe(
        Effect.provide(
          DesktopApplicationMenu.layer.pipe(
            Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
            Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
            Layer.provideMerge(desktopUpdatesLayer),
            Layer.provideMerge(electronDialogLayer),
            Layer.provideMerge(electronAppLayer),
            Layer.provideMerge(
              DesktopEnvironment.layer(environmentInput).pipe(
                Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
              ),
            ),
          ),
        ),
      );

      const template = yield* Deferred.await(applicationMenuTemplate);
      // Explicit labels make authored role wrappers extractable while their
      // native action semantics and automatic OS submenus remain unchanged.
      for (const role of ["editMenu", "windowMenu", "help"] as const) {
        assert.isString(template.find((item) => item.role === role)?.label);
      }
      const fileMenu = template.find((item) => item.label === "File");
      assert.isDefined(fileMenu);
      if (!Array.isArray(fileMenu.submenu)) {
        throw new Error("Expected File menu submenu to be an array.");
      }
      const settingsItem = fileMenu.submenu.find((item) => item.label === "Settings...");
      assert.isDefined(settingsItem);
      assert.equal(settingsItem.accelerator, "CmdOrCtrl+,");
      assert.equal(fileMenu.submenu.find((item) => item.role === "quit")?.label, "Quit");
      const settingsClick = settingsItem.click;
      if (typeof settingsClick !== "function") {
        throw new Error("Expected Settings menu item to have a click handler.");
      }

      settingsClick({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "open-settings");
    }),
  );
});
