import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { vi } from "vitest";
// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve } from "node:path";
import type { MacDictationTargetResult } from "./MacDictationTarget.ts";

const electronHarness = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    lifecycleHandlers: new Map<string, () => void>(),
    registerShortcut: vi.fn((_shortcut: string, _callback: () => void) => true),
    unregisterShortcut: vi.fn(),
    isShortcutRegistered: vi.fn((_shortcut: string) => true),
    loadUrlBehavior: null as null | ((url: string) => Promise<void>),
    fromWebContents: vi.fn(),
    windows: [] as Array<{
      readonly webContents: {
        readonly mainFrame: { url: string };
        readonly on: ReturnType<typeof vi.fn>;
        readonly send: ReturnType<typeof vi.fn>;
      };
      readonly loadURL: ReturnType<typeof vi.fn>;
      readonly isDestroyed: () => boolean;
      readonly isVisible: () => boolean;
      readonly hide: ReturnType<typeof vi.fn>;
      readonly show: ReturnType<typeof vi.fn>;
      readonly setBounds: ReturnType<typeof vi.fn>;
      readonly setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
    }>,
  };
});

const nativeHarness = vi.hoisted(() => ({
  capture: vi.fn(async (): Promise<MacDictationTargetResult> => ({ ok: true })),
  discard: vi.fn(async () => undefined),
  insert: vi.fn(async (_text: string): Promise<MacDictationTargetResult> => ({ ok: true })),
  dispose: vi.fn(),
  showSaveDialog: vi.fn(),
  showErrorBox: vi.fn(),
}));

vi.mock("./MacDictationTarget.ts", () => ({
  createMacDictationTargetClient: () => nativeHarness,
}));
vi.mock("./MacDictationTargetPath.ts", () => ({
  resolveMacDictationTargetPath: () => "/fake/mac-dictation-target",
}));

vi.mock("electron", () => {
  class FakeBrowserWindow {
    private destroyed = false;
    readonly webContents = {
      mainFrame: { url: "" },
      session: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() },
      isDestroyed: () => this.destroyed,
      send: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    readonly loadURL = vi.fn((url: string) => {
      this.webContents.mainFrame.url = url;
      return electronHarness.loadUrlBehavior?.(url) ?? Promise.resolve();
    });
    readonly on = vi.fn();
    readonly setAlwaysOnTop = vi.fn();
    readonly setVisibleOnAllWorkspaces = vi.fn();
    readonly showInactive = vi.fn(() => {
      this.visible = true;
    });
    readonly isVisible = vi.fn(() => this.visible);
    private visible = false;
    readonly setResizable = vi.fn();
    readonly setBounds = vi.fn();
    readonly show = vi.fn(() => {
      this.visible = true;
    });
    readonly hide = vi.fn(() => {
      this.visible = false;
    });
    readonly focus = vi.fn();
    readonly getBounds = vi.fn(() => ({ x: 0, y: 0, width: 500, height: 300 }));
    readonly isDestroyed = () => this.destroyed;
    readonly destroy = vi.fn(() => {
      this.destroyed = true;
      this.visible = false;
    });

    constructor() {
      electronHarness.windows.push(this);
    }

    static fromWebContents = electronHarness.fromWebContents;
  }

  return {
    app: {
      on: vi.fn((event: string, listener: () => void) => {
        electronHarness.lifecycleHandlers.set(event, listener);
      }),
      removeListener: vi.fn((event: string) => {
        electronHarness.lifecycleHandlers.delete(event);
      }),
    },
    BrowserWindow: FakeBrowserWindow,
    clipboard: { writeText: vi.fn() },
    dialog: {
      showSaveDialog: nativeHarness.showSaveDialog,
      showMessageBox: vi.fn(),
      showErrorBox: nativeHarness.showErrorBox,
    },
    globalShortcut: {
      register: electronHarness.registerShortcut,
      unregister: electronHarness.unregisterShortcut,
      isRegistered: electronHarness.isShortcutRegistered,
    },
    ipcMain: {
      handle: (channel: string, callback: (...args: unknown[]) => unknown) => {
        electronHarness.handlers.set(channel, callback);
      },
      removeHandler: (channel: string) => {
        electronHarness.handlers.delete(channel);
      },
    },
    Notification: class {
      static isSupported() {
        return false;
      }
    },
    powerMonitor: {
      on: vi.fn((event: string, listener: () => void) => {
        electronHarness.lifecycleHandlers.set(event, listener);
      }),
      removeListener: vi.fn((event: string) => {
        electronHarness.lifecycleHandlers.delete(event);
      }),
    },
    screen: {
      getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } })),
      getDisplayMatching: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } })),
      getCursorScreenPoint: vi.fn(() => ({ x: 100, y: 100 })),
    },
  };
});

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import { __desktopDebugServerTestApi as debugServer } from "../debug/DesktopDebugServer.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { installGlobalDictationCoordinator } from "./GlobalDictationCoordinator.ts";

const rendererUrl = "http://127.0.0.1:5733/";

function makeSender(url = rendererUrl) {
  const mainFrame = { url };
  return {
    mainFrame,
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
  } as unknown as Electron.WebContents;
}

function eventFor(sender: Electron.WebContents, senderFrame = sender.mainFrame) {
  return { sender, senderFrame } as Electron.IpcMainInvokeEvent;
}

function handler(channel: string) {
  const callback = electronHarness.handlers.get(channel);
  assert.isDefined(callback, `Expected ${channel} to have an IPC handler`);
  return callback;
}

/**
 * Exercise the real coordinator's IPC handlers without opening a native
 * window or microphone. Each sender has a BrowserWindow and the same trusted
 * origin, so only the registered main-window identity can grant authority.
 */
function coordinatorTestLayer(
  mainWebContents: Electron.WebContents,
  trustWebContents: () => Effect.Effect<void> = () => Effect.void,
) {
  let settings: DesktopAppSettings.DesktopSettings = {
    ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
  };
  const desktopSettings = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
    get: Effect.sync(() => settings),
    setGlobalDictationEnabled: (enabled: boolean) =>
      Effect.sync(() => {
        settings = { ...settings, globalDictationEnabled: enabled };
        return { settings, changed: true };
      }),
    setGlobalDictationShortcut: (shortcut: string) =>
      Effect.sync(() => {
        settings = { ...settings, globalDictationShortcut: shortcut };
        return { settings, changed: true };
      }),
  } as unknown as DesktopAppSettings.DesktopAppSettingsShape);
  const mainWindow = { webContents: mainWebContents } as Electron.BrowserWindow;
  return Layer.mergeAll(
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      platform: "darwin",
      dataProfile: "production",
      configuredBaseDir: resolve("/repo"),
      isDevelopment: true,
      preloadPath: "/repo/apps/desktop/dist-electron/preload.cjs",
      devServerUrl: Option.some(new URL(rendererUrl)),
    } as DesktopEnvironment.DesktopEnvironmentShape),
    desktopSettings,
    Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
      backendConfig: Effect.succeed({ httpBaseUrl: new URL("http://127.0.0.1:3773/") }),
    } as DesktopServerExposure.DesktopServerExposureShape),
    Layer.succeed(DesktopIpc.DesktopIpc, {
      trustWebContents,
    } as unknown as DesktopIpc.DesktopIpcShape),
    Layer.succeed(ElectronWindow.ElectronWindow, {
      main: Effect.succeed(Option.some(mainWindow)),
    } as ElectronWindow.ElectronWindowShape),
  );
}

describe("GlobalDictationCoordinator IPC admission", () => {
  for (const cancellation of ["disable", "lock-screen", "suspend", "before-quit"] as const) {
    it(`revokes a pending capture on ${cancellation} before it can start a renderer`, async () => {
      debugServer.reset();
      electronHarness.handlers.clear();
      electronHarness.windows.length = 0;
      electronHarness.registerShortcut.mockClear();
      nativeHarness.capture.mockClear();
      nativeHarness.dispose.mockClear();
      nativeHarness.showErrorBox.mockClear();
      let finishCapture: (result: MacDictationTargetResult) => void = () => undefined;
      nativeHarness.capture.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishCapture = resolve;
          }),
      );
      const main = makeSender();
      electronHarness.fromWebContents.mockImplementation(() => ({ isDestroyed: () => false }));
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* installGlobalDictationCoordinator;
            yield* Effect.promise(async () => {
              const enable = handler(IpcChannels.SET_GLOBAL_DICTATION_ENABLED_CHANNEL);
              await enable(eventFor(main), true);
              electronHarness.registerShortcut.mock.calls[0]![1]();
              assert.equal(nativeHarness.capture.mock.calls.length, 1);
              assert.equal(electronHarness.windows.length, 0);
              if (cancellation === "disable") await enable(eventFor(main), false);
              else electronHarness.lifecycleHandlers.get(cancellation)!();
              assert.equal(nativeHarness.dispose.mock.calls.length, 1);
              finishCapture({ ok: true });
              // Let the cancelled async continuation settle without opening a
              // native window or waiting for the real helper's timeout.
              await new Promise<void>((resolve) => setImmediate(resolve));
              assert.equal(electronHarness.windows.length, 0);
              assert.equal(nativeHarness.showErrorBox.mock.calls.length, 0);
              assert.deepInclude(debugServer.buildCompactDebugSnapshot().globalDictationShortcut, {
                lastCaptureOutcome: "not_attempted",
                panelPhase: null,
              });
            });
          }).pipe(Effect.provide(coordinatorTestLayer(main))),
        ),
      );
    });
  }

  it("destroys a pending panel on lock and rejects late renderer trust completion", async () => {
    debugServer.reset();
    electronHarness.handlers.clear();
    electronHarness.windows.length = 0;
    electronHarness.registerShortcut.mockClear();
    nativeHarness.dispose.mockClear();
    let finishTrust: () => void = () => undefined;
    const trust = new Promise<void>((resolve) => {
      finishTrust = resolve;
    });
    const main = makeSender();
    electronHarness.fromWebContents.mockImplementation(() => ({ isDestroyed: () => false }));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* installGlobalDictationCoordinator;
          yield* Effect.promise(async () => {
            await handler(IpcChannels.SET_GLOBAL_DICTATION_ENABLED_CHANNEL)(eventFor(main), true);
            electronHarness.registerShortcut.mock.calls[0]![1]();
            await vi.waitFor(() => assert.equal(electronHarness.windows.length, 1));
            const panel = electronHarness.windows[0]!;
            assert.equal(panel.loadURL.mock.calls.length, 0);
            electronHarness.lifecycleHandlers.get("lock-screen")!();
            assert.isTrue(panel.isDestroyed());
            assert.equal(nativeHarness.dispose.mock.calls.length, 1);
            finishTrust();
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(panel.loadURL.mock.calls.length, 0);
            assert.deepInclude(debugServer.buildCompactDebugSnapshot().globalDictationShortcut, {
              panelPhase: null,
              panelVisible: false,
            });
          });
        }).pipe(Effect.provide(coordinatorTestLayer(main, () => Effect.promise(() => trust)))),
      ),
    );
  });

  it("keeps a retired insertion result out of a newer capture's diagnostics", async () => {
    debugServer.reset();
    electronHarness.handlers.clear();
    electronHarness.windows.length = 0;
    electronHarness.registerShortcut.mockClear();
    let finishInsert: (result: MacDictationTargetResult) => void = () => undefined;
    nativeHarness.insert.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishInsert = resolve;
        }),
    );
    const main = makeSender();
    electronHarness.fromWebContents.mockImplementation(() => ({ isDestroyed: () => false }));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* installGlobalDictationCoordinator;
          yield* Effect.promise(async () => {
            await handler(IpcChannels.SET_GLOBAL_DICTATION_ENABLED_CHANNEL)(eventFor(main), true);
            const shortcut = electronHarness.registerShortcut.mock.calls[0]![1];
            shortcut();
            await vi.waitFor(() => assert.equal(electronHarness.windows.length, 1));
            const panel = electronHarness.windows[0]!;
            const sender = eventFor(panel.webContents as unknown as Electron.WebContents);
            const sessionId = new URL(panel.webContents.mainFrame.url).searchParams.get(
              "sessionId",
            );
            const action = handler(IpcChannels.GLOBAL_DICTATION_ACTION_CHANNEL);
            await action(sender, { action: "ready", sessionId });
            await action(sender, { action: "review", sessionId });
            const oldInsert = action(sender, {
              action: "insert",
              sessionId,
              text: "private draft",
            });
            await action(sender, { action: "cancel", sessionId });
            shortcut();
            await vi.waitFor(() => assert.equal(electronHarness.windows.length, 2));
            finishInsert({ ok: false, reason: "target_changed", uncertain: false });
            await oldInsert;
            assert.isTrue(panel.isDestroyed());
            assert.deepInclude(debugServer.buildCompactDebugSnapshot().globalDictationShortcut, {
              lastCaptureOutcome: "succeeded",
              lastInsertOutcome: "not_attempted",
              lastInsertAt: null,
              lastInsertDurationMs: null,
              panelPhase: "recording",
            });
          });
        }).pipe(Effect.provide(coordinatorTestLayer(main))),
      ),
    );
  });

  for (const scenario of ["success", "changed", "uncertain", "cancelled"] as const) {
    it(`hands focus back once and handles ${scenario} without losing or reviving a draft`, async () => {
      debugServer.reset();
      electronHarness.handlers.clear();
      electronHarness.windows.length = 0;
      electronHarness.registerShortcut.mockClear();
      nativeHarness.insert.mockClear();
      nativeHarness.capture.mockResolvedValueOnce({
        ok: true,
        insertionMethod: scenario === "success" ? "paste" : "accessibility",
      });
      const main = makeSender();
      electronHarness.fromWebContents.mockImplementation(() => ({ isDestroyed: () => false }));
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* installGlobalDictationCoordinator;
            yield* Effect.promise(async () => {
              await handler(IpcChannels.SET_GLOBAL_DICTATION_ENABLED_CHANNEL)(eventFor(main), true);
              const callback = electronHarness.registerShortcut.mock.calls[0]![1];
              callback();
              await vi.waitFor(() => assert.equal(electronHarness.windows.length, 1));
              const panel = electronHarness.windows[0]!;
              const sender = eventFor(panel.webContents as unknown as Electron.WebContents);
              const sessionId = new URL(panel.webContents.mainFrame.url).searchParams.get(
                "sessionId",
              );
              const action = handler(IpcChannels.GLOBAL_DICTATION_ACTION_CHANNEL);
              await action(sender, { action: "ready", sessionId });
              const startEvent = panel.webContents.send.mock.calls.find(
                ([channel, payload]) =>
                  channel === IpcChannels.GLOBAL_DICTATION_EVENT_CHANNEL &&
                  payload.type === "start",
              );
              assert.isDefined(startEvent);
              assert.deepEqual(panel.webContents.send.mock.calls[0], [
                "cafe:ui-locale-changed",
                "en",
              ]);
              assert.deepInclude(startEvent![1], {
                type: "start",
                insertionMethod: scenario === "success" ? "paste" : "accessibility",
              });
              await action(sender, { action: "review", sessionId });
              assert.deepInclude(panel.setBounds.mock.calls[0]![0], { width: 490, height: 510 });
              assert.isTrue(panel.isVisible());
              let settle: (result: MacDictationTargetResult) => void = () => undefined;
              nativeHarness.insert.mockImplementationOnce(async () => {
                // Hide precedes native I/O, not just native acknowledgement.
                assert.isFalse(panel.isVisible());
                if (scenario === "uncertain") throw new Error("private native exception and text");
                return new Promise<MacDictationTargetResult>((resolve) => {
                  settle = resolve;
                });
              });
              const pending = action(sender, {
                action: "insert",
                sessionId,
                text: "private draft",
              });
              assert.isFalse(panel.isVisible());
              callback(); // Shortcut must not steal focus during the native write.
              assert.isFalse(panel.isVisible());
              assert.deepEqual(
                await action(sender, { action: "insert", sessionId, text: "private draft" }),
                { ok: false, reason: "invalid_input" },
              );
              if (scenario === "cancelled") {
                await action(sender, { action: "cancel", sessionId });
              }
              if (scenario !== "uncertain") {
                settle(
                  scenario === "success"
                    ? { ok: true }
                    : { ok: false, reason: "target_changed", uncertain: false },
                );
              }
              const result = await pending;
              assert.deepEqual(
                result,
                scenario === "success"
                  ? { ok: true }
                  : {
                      ok: false,
                      reason: scenario === "uncertain" ? "insertion_uncertain" : "target_changed",
                    },
              );
              assert.equal(nativeHarness.insert.mock.calls.length, 1);
              assert.equal(panel.hide.mock.calls.length, 1);
              assert.equal(panel.isDestroyed(), scenario === "success" || scenario === "cancelled");
              assert.equal(panel.isVisible(), scenario === "changed" || scenario === "uncertain");
              const snapshot = debugServer.buildCompactDebugSnapshot().globalDictationShortcut;
              assert.deepInclude(snapshot, {
                lastCaptureOutcome: "succeeded",
                lastInsertOutcome:
                  scenario === "success"
                    ? "succeeded"
                    : scenario === "uncertain"
                      ? "insertion_uncertain"
                      : "target_changed",
              });
              assert.isFalse(JSON.stringify(snapshot).includes("private"));
              if (!panel.isDestroyed()) {
                assert.deepEqual(
                  await action(sender, { action: "insert", sessionId, text: "private draft" }),
                  { ok: false, reason: "target_unavailable" },
                );
                assert.equal(nativeHarness.insert.mock.calls.length, 1);
              }
            });
          }).pipe(Effect.provide(coordinatorTestLayer(main))),
        ),
      );
    });
  }

  it("keeps Cafe in the Dock while diagnosing a delivered shortcut and panel readiness", async () => {
    debugServer.reset();
    electronHarness.handlers.clear();
    electronHarness.windows.length = 0;
    electronHarness.registerShortcut.mockClear();
    const main = makeSender();
    electronHarness.fromWebContents.mockImplementation(() => ({ isDestroyed: () => false }));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* installGlobalDictationCoordinator;
          yield* Effect.promise(async () => {
            await handler(IpcChannels.SET_GLOBAL_DICTATION_ENABLED_CHANNEL)(eventFor(main), true);
            const callback = electronHarness.registerShortcut.mock.calls[0]?.[1];
            if (!callback) throw new Error("Global shortcut callback was not registered");
            callback();
            await vi.waitFor(() => assert.equal(electronHarness.windows.length, 1));
            const initial = debugServer.buildCompactDebugSnapshot()
              .globalDictationShortcut as Record<string, unknown>;
            assert.deepInclude(initial, {
              enabled: true,
              registered: true,
              electronRegistered: true,
              registrationOutcome: "registered",
              invocationCount: 1,
              lastToggleOutcome: "panel_created",
              panelPhase: "recording",
              panelReady: false,
              panelVisible: false,
              panelLoadOutcome: "loaded",
              lastPanelReadyOutcome: "not_seen",
            });
            const panel = electronHarness.windows[0]!;
            // Fullscreen visibility must affect only the panel's collection
            // flags. Electron's default also hides the whole app from the Dock.
            assert.deepEqual(panel.setVisibleOnAllWorkspaces.mock.calls, [
              [true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
            ]);
            const sessionId = new URL(panel.webContents.mainFrame.url).searchParams.get(
              "sessionId",
            );
            assert.isString(sessionId);
            await handler(IpcChannels.GLOBAL_DICTATION_ACTION_CHANNEL)(
              eventFor(panel.webContents as unknown as Electron.WebContents),
              { action: "ready", sessionId },
            );
            const ready = debugServer.buildCompactDebugSnapshot().globalDictationShortcut as Record<
              string,
              unknown
            >;
            assert.deepInclude(ready, {
              invocationCount: 1,
              lastToggleOutcome: "opened",
              panelReady: true,
              panelVisible: true,
              lastPanelReadyOutcome: "accepted",
            });
          });
        }).pipe(Effect.provide(coordinatorTestLayer(main))),
      ),
    );
  });

  it("closes an invisible panel that never sends ready after a bounded deadline", async () => {
    debugServer.reset();
    electronHarness.handlers.clear();
    electronHarness.windows.length = 0;
    electronHarness.registerShortcut.mockClear();
    nativeHarness.showErrorBox.mockClear();
    electronHarness.loadUrlBehavior = () => new Promise<void>(() => undefined);
    const main = makeSender();
    electronHarness.fromWebContents.mockImplementation(() => ({ isDestroyed: () => false }));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* installGlobalDictationCoordinator;
          yield* Effect.promise(async () => {
            await handler(IpcChannels.SET_GLOBAL_DICTATION_ENABLED_CHANNEL)(eventFor(main), true);
            const callback = electronHarness.registerShortcut.mock.calls[0]?.[1];
            if (!callback) throw new Error("Global shortcut callback was not registered");
            vi.useFakeTimers();
            try {
              callback();
              await vi.advanceTimersByTimeAsync(0);
              assert.equal(electronHarness.windows.length, 1);
              const panel = electronHarness.windows[0]!;
              const preloadErrorListener = panel.webContents.on.mock.calls.find(
                (call: readonly unknown[]) => call[0] === "preload-error",
              )?.[1] as ((...args: unknown[]) => void) | undefined;
              if (!preloadErrorListener) throw new Error("Preload error listener was not bound");
              preloadErrorListener(
                {},
                "/private/preload-secret",
                new Error("private stack secret"),
              );
              await vi.advanceTimersByTimeAsync(10_000);
              assert.isTrue(panel.isDestroyed());
              assert.equal(nativeHarness.showErrorBox.mock.calls.length, 1);
              const diagnostics = debugServer.buildCompactDebugSnapshot()
                .globalDictationShortcut as Record<string, unknown>;
              assert.isFalse(JSON.stringify(diagnostics).includes("private"));
              assert.deepInclude(diagnostics, {
                invocationCount: 1,
                lastToggleOutcome: "open_failed",
                panelPhase: null,
                panelReady: false,
                panelVisible: false,
                panelLoadOutcome: "preload_failed",
                lastPanelReadyOutcome: "timeout",
              });
              // The first loadURL deliberately never resolves. Its deadline
              // must still release the startup gate for the next shortcut.
              callback();
              await vi.advanceTimersByTimeAsync(0);
              assert.equal(electronHarness.windows.length, 2);
              const secondPanel = electronHarness.windows[1]!;
              const secondSessionId = new URL(
                secondPanel.webContents.mainFrame.url,
              ).searchParams.get("sessionId");
              assert.isString(secondSessionId);
              const panelAction = handler(IpcChannels.GLOBAL_DICTATION_ACTION_CHANNEL);
              assert.deepEqual(
                await panelAction(
                  eventFor(secondPanel.webContents as unknown as Electron.WebContents),
                  { action: "ready", sessionId: secondSessionId },
                ),
                { ok: true },
              );
              await vi.advanceTimersByTimeAsync(0);
              assert.deepInclude(
                debugServer.buildCompactDebugSnapshot().globalDictationShortcut as Record<
                  string,
                  unknown
                >,
                { lastToggleOutcome: "opened", panelReady: true, panelVisible: true },
              );
              await panelAction(
                eventFor(secondPanel.webContents as unknown as Electron.WebContents),
                { action: "cancel", sessionId: secondSessionId },
              );
              callback();
              await vi.advanceTimersByTimeAsync(0);
              assert.equal(electronHarness.windows.length, 3);
            } finally {
              electronHarness.loadUrlBehavior = null;
              vi.useRealTimers();
            }
          });
        }).pipe(Effect.provide(coordinatorTestLayer(main))),
      ),
    );
  });

  it("reports a renderer crash before ready without exposing the native error", async () => {
    debugServer.reset();
    electronHarness.handlers.clear();
    electronHarness.windows.length = 0;
    electronHarness.registerShortcut.mockClear();
    nativeHarness.showErrorBox.mockClear();
    const main = makeSender();
    electronHarness.fromWebContents.mockImplementation(() => ({ isDestroyed: () => false }));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* installGlobalDictationCoordinator;
          yield* Effect.promise(async () => {
            await handler(IpcChannels.SET_GLOBAL_DICTATION_ENABLED_CHANNEL)(eventFor(main), true);
            const callback = electronHarness.registerShortcut.mock.calls[0]?.[1];
            if (!callback) throw new Error("Global shortcut callback was not registered");
            callback();
            await vi.waitFor(() => assert.equal(electronHarness.windows.length, 1));
            const panel = electronHarness.windows[0]!;
            const crashListener = panel.webContents.on.mock.calls.find(
              (call: readonly unknown[]) => call[0] === "render-process-gone",
            )?.[1] as ((...args: unknown[]) => void) | undefined;
            if (!crashListener) throw new Error("Renderer crash listener was not bound");
            crashListener({}, { reason: "private renderer crash secret" });
            assert.isTrue(panel.isDestroyed());
            assert.equal(nativeHarness.showErrorBox.mock.calls.length, 1);
            const diagnostics = debugServer.buildCompactDebugSnapshot()
              .globalDictationShortcut as Record<string, unknown>;
            assert.deepInclude(diagnostics, {
              lastToggleOutcome: "open_failed",
              panelLoadOutcome: "renderer_crashed",
              panelPhase: null,
              panelReady: false,
            });
            assert.isFalse(JSON.stringify(diagnostics).includes("private renderer crash secret"));
          });
        }).pipe(Effect.provide(coordinatorTestLayer(main))),
      ),
    );
  });

  it("rejects a same-origin non-main window and requires the exact composer lease token", async () => {
    electronHarness.handlers.clear();
    electronHarness.registerShortcut.mockClear();
    electronHarness.unregisterShortcut.mockClear();
    const main = makeSender();
    const otherWindow = makeSender();
    electronHarness.fromWebContents.mockImplementation(() => ({ isDestroyed: () => false }));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* installGlobalDictationCoordinator;
          yield* Effect.promise(async () => {
            const getSettings = handler(IpcChannels.GET_GLOBAL_DICTATION_SETTINGS_CHANNEL);
            const enable = handler(IpcChannels.SET_GLOBAL_DICTATION_ENABLED_CHANNEL);
            const setShortcut = handler(IpcChannels.SET_GLOBAL_DICTATION_SHORTCUT_CHANNEL);
            const claim = handler(IpcChannels.CLAIM_COMPOSER_DICTATION_CAPTURE_CHANNEL);
            const release = handler(IpcChannels.RELEASE_COMPOSER_DICTATION_CAPTURE_CHANNEL);

            const otherState = (await getSettings(eventFor(otherWindow))) as {
              enabled: boolean;
              error: string;
            };
            assert.isFalse(otherState.enabled);
            assert.equal(otherState.error, "Unavailable in this window.");
            await enable(eventFor(otherWindow), true);
            assert.equal(electronHarness.registerShortcut.mock.calls.length, 0);
            assert.isNull(await claim(eventFor(otherWindow)));
            assert.isNull(
              await claim(eventFor(main, { url: rendererUrl } as Electron.WebFrameMain)),
            );

            const enabledState = (await enable(eventFor(main), true)) as {
              enabled: boolean;
              registered: boolean;
            };
            assert.isTrue(enabledState.enabled);
            assert.isTrue(enabledState.registered);
            assert.deepEqual(electronHarness.registerShortcut.mock.calls[0]?.slice(0, 1), [
              "CommandOrControl+Shift+,",
            ]);

            await setShortcut(eventFor(otherWindow), "Command+Shift+D");
            assert.equal(electronHarness.registerShortcut.mock.calls.length, 1);
            const rejected = (await setShortcut(eventFor(main), "Command+Q")) as { error: string };
            assert.equal(rejected.error, "Use Command–Shift with one supported key.");
            assert.equal(electronHarness.registerShortcut.mock.calls.length, 1);
            const rebound = (await setShortcut(eventFor(main), "Command+Shift+D")) as {
              shortcut: string;
              registered: boolean;
            };
            assert.equal(rebound.shortcut, "CommandOrControl+Shift+D");
            assert.isTrue(rebound.registered);
            assert.deepEqual(electronHarness.registerShortcut.mock.calls[1]?.slice(0, 1), [
              "CommandOrControl+Shift+D",
            ]);
            assert.deepEqual(electronHarness.unregisterShortcut.mock.calls, [
              ["CommandOrControl+Shift+,"],
            ]);

            const firstLease = await claim(eventFor(main));
            assert.isString(firstLease);
            assert.isNull(await claim(eventFor(main)));
            await release(eventFor(main), "wrong-token");
            assert.isNull(await claim(eventFor(main)));
            await release(eventFor(otherWindow), firstLease);
            assert.isNull(await claim(eventFor(main)));
            await release(eventFor(main), firstLease);
            const secondLease = await claim(eventFor(main));
            assert.isString(secondLease);
            assert.notEqual(secondLease, firstLease);
          });
        }).pipe(Effect.provide(coordinatorTestLayer(main))),
      ),
    );

    assert.equal(electronHarness.handlers.size, 0);
    assert.deepEqual(electronHarness.unregisterShortcut.mock.calls, [
      ["CommandOrControl+Shift+,"],
      ["CommandOrControl+Shift+D"],
    ]);
  });

  it("keeps the native insert target after a cancelled or failed Save picker", async () => {
    electronHarness.handlers.clear();
    electronHarness.windows.length = 0;
    electronHarness.registerShortcut.mockClear();
    nativeHarness.capture.mockClear();
    nativeHarness.discard.mockClear();
    nativeHarness.showSaveDialog.mockReset();
    const main = makeSender();
    electronHarness.fromWebContents.mockImplementation(() => ({ isDestroyed: () => false }));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* installGlobalDictationCoordinator;
          yield* Effect.promise(async () => {
            const enable = handler(IpcChannels.SET_GLOBAL_DICTATION_ENABLED_CHANNEL);
            await enable(eventFor(main), true);
            const shortcutCallback = electronHarness.registerShortcut.mock.calls[0]?.[1];
            if (!shortcutCallback) throw new Error("Global shortcut callback was not registered");
            shortcutCallback();

            await vi.waitFor(() => {
              assert.equal(electronHarness.windows.length, 1);
              assert.isAbove(electronHarness.windows[0]?.loadURL.mock.calls.length ?? 0, 0);
            });
            const panel = electronHarness.windows[0]!;
            const panelSender = panel.webContents as unknown as Electron.WebContents;
            const sessionId = new URL(panel.webContents.mainFrame.url).searchParams.get(
              "sessionId",
            );
            assert.isString(sessionId);
            const action = handler(IpcChannels.GLOBAL_DICTATION_ACTION_CHANNEL);
            assert.deepEqual(await action(eventFor(panelSender), { action: "ready", sessionId }), {
              ok: true,
            });
            assert.deepEqual(await action(eventFor(panelSender), { action: "review", sessionId }), {
              ok: true,
            });

            nativeHarness.showSaveDialog.mockResolvedValueOnce({
              canceled: true,
              filePath: "/private/unsaved.txt",
            });
            assert.deepEqual(
              await action(eventFor(panelSender), {
                action: "save",
                sessionId,
                text: "private draft",
              }),
              { ok: false, reason: "cancelled" },
            );
            assert.equal(nativeHarness.discard.mock.calls.length, 0);

            nativeHarness.showSaveDialog.mockRejectedValueOnce(
              new Error("picker failed at /private/secret.txt"),
            );
            assert.deepEqual(
              await action(eventFor(panelSender), {
                action: "save",
                sessionId,
                text: "private draft",
              }),
              { ok: false, reason: "save_failed" },
            );
            assert.equal(nativeHarness.discard.mock.calls.length, 0);
          });
        }).pipe(Effect.provide(coordinatorTestLayer(main))),
      ),
    );
  });
});
