import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getUiLocale, subscribeUiLocale, uiText } from "@cafecode/shared/i18n";

import type {
  GlobalDictationAction,
  GlobalDictationActionResult,
  GlobalDictationEvent,
  GlobalDictationInsertionMethod,
  GlobalDictationSettingsState,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Notification,
  powerMonitor,
  screen,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopDebugServer from "../debug/DesktopDebugServer.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUiLocale from "../settings/DesktopUiLocale.ts";
import {
  DESKTOP_UI_LOCALE_CHANGED_CHANNEL,
  desktopUiLocaleArguments,
} from "../settings/DesktopUiLocaleBridge.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  trustAudioWebContents,
  untrustAudioWebContents,
} from "../window/TrustedAudioPermissionPolicy.ts";
import {
  createMacDictationTargetClient,
  type MacDictationTargetClient,
  type MacDictationTargetFailureReason,
} from "./MacDictationTarget.ts";
import { resolveMacDictationTargetPath } from "./MacDictationTargetPath.ts";
import { saveDictationDraft } from "./SaveDictationDraft.ts";

const maximumDraftBytes = 256 * 1024;
const hudWidth = 490;
const hudHeight = 278;
const reviewWidth = 490;
const reviewHeight = 510;
// A preload or renderer failure must not leave an invisible panel holding the
// user's original Accessibility target indefinitely.
const panelReadyTimeoutMs = 10_000;

type PanelPhase = "recording" | "finalizing" | "review";

interface PanelSession {
  readonly id: string;
  readonly window: BrowserWindow;
  readonly rendererUrl: URL;
  readonly target: MacDictationTargetClient;
  readonly insertionMethod: GlobalDictationInsertionMethod;
  insertAvailable: boolean;
  captureFailure: MacDictationTargetFailureReason | null;
  phase: PanelPhase;
  ready: boolean;
  pendingStop: boolean;
  closing: boolean;
  actionBusy: boolean;
  readyTimer: ReturnType<typeof setTimeout> | null;
  resolveReadiness: (ready: boolean) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedDraft(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumDraftBytes &&
    !value.includes("\u0000")
  );
}

function explainCaptureFailure(reason: MacDictationTargetFailureReason | null): string | undefined {
  if (reason === null) return undefined;
  if (reason === "accessibility_permission_required") {
    return uiText(
      "To enable Insert, allow Cafe Code Accessibility in macOS System Settings. You can still Copy or Save.",
    );
  }
  return uiText("Insert is unavailable for this field. You can still Copy or Save your draft.");
}

type RegistrationFeedback =
  | "shortcut-used"
  | "settings-write-failed"
  | "invalid-shortcut"
  | "shortcut-write-failed";
function registrationFeedbackForUi(feedback: RegistrationFeedback): string {
  switch (feedback) {
    case "shortcut-used":
      return uiText("That shortcut is already in use. Choose another shortcut.");
    case "settings-write-failed":
      return uiText("Cafe could not save the dictation setting.");
    case "invalid-shortcut":
      return uiText("Use Command–Shift with one supported key.");
    case "shortcut-write-failed":
      return uiText("Cafe could not save the shortcut.");
  }
}

function isTrustedMainSender(
  event: IpcMainInvokeEvent,
  panel: PanelSession | null,
  expectedUrl: URL,
  mainWebContents: WebContents | null,
): boolean {
  const sender = event.sender;
  const frame = event.senderFrame;
  if (
    sender !== mainWebContents ||
    !frame ||
    frame !== sender.mainFrame ||
    sender.isDestroyed() ||
    panel?.window.webContents === sender
  ) {
    return false;
  }
  const window = BrowserWindow.fromWebContents(sender);
  if (!window || window.isDestroyed()) return false;
  try {
    const url = new URL(frame.url);
    return (
      DesktopIpc.isTrustedDesktopIpcFrameUrl(frame.url, expectedUrl) &&
      url.origin === expectedUrl.origin &&
      url.pathname === expectedUrl.pathname &&
      url.searchParams.get("cafeDictationOverlay") !== "1"
    );
  } catch {
    return false;
  }
}

function isBoundPanelSender(
  event: IpcMainInvokeEvent,
  panel: PanelSession | null,
): panel is PanelSession {
  if (!panel || panel.window.isDestroyed() || event.sender !== panel.window.webContents) {
    return false;
  }
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const frameUrl = new URL(event.senderFrame.url);
    return (
      frameUrl.origin === panel.rendererUrl.origin &&
      frameUrl.pathname === panel.rendererUrl.pathname &&
      frameUrl.searchParams.get("cafeDictationOverlay") === "1" &&
      frameUrl.searchParams.get("sessionId") === panel.id
    );
  } catch {
    return false;
  }
}

function notifyComposerBusy(): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: uiText("Cafe Dictation"),
    body: uiText("Finish the dictation in Cafe before starting global dictation."),
  }).show();
}

/**
 * All global shortcut and native target authority stays in Electron main.
 * Renderer events carry only sanitized state, and each mutating IPC is bound
 * to the exact auxiliary webContents/main frame/session id. The panel uses a
 * restricted preload and can never request generic key presses or AX reads.
 */
export const installGlobalDictationCoordinator = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const exposure = yield* DesktopServerExposure.DesktopServerExposure;
  const desktopIpc = yield* DesktopIpc.DesktopIpc;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const locale = yield* Effect.serviceOption(DesktopUiLocale.DesktopUiLocale);
  const systemLocale = Option.isSome(locale) ? yield* locale.value.systemLocale : "en";
  const context = yield* Effect.context<
    | DesktopAppSettings.DesktopAppSettings
    | DesktopServerExposure.DesktopServerExposure
    | DesktopIpc.DesktopIpc
    | ElectronWindow.ElectronWindow
  >();
  const runPromise = Effect.runPromiseWith(context);

  yield* Effect.acquireRelease(
    Effect.promise(async () => {
      let active: PanelSession | null = null;
      let starting = false;
      let startupRevision = 0;
      let pendingStartupTarget: MacDictationTargetClient | null = null;
      let pendingStartupWindow: BrowserWindow | null = null;
      let latestCaptureId: string | null = null;
      let registeredShortcut: string | null = null;
      let registrationError: RegistrationFeedback | null = null;
      let composerOwner: { webContents: WebContents; leaseId: string } | null = null;
      let disposed = false;
      const unsubscribeLocale = subscribeUiLocale(() => {
        const target = active?.window ?? pendingStartupWindow;
        if (!disposed && target && !target.isDestroyed()) {
          target.webContents.send(DESKTOP_UI_LOCALE_CHANGED_CHANNEL, getUiLocale());
        }
      });
      let shortcutEnabled = false;
      let configuredShortcut = DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.globalDictationShortcut;
      let registrationOutcome: DesktopDebugServer.GlobalDictationShortcutDebugSnapshot["registrationOutcome"] =
        "not_attempted";
      let registrationCheckedAt: string | null = null;
      let invocationCount = 0;
      let lastInvokedAt: string | null = null;
      let lastToggleOutcome: DesktopDebugServer.GlobalDictationShortcutDebugSnapshot["lastToggleOutcome"] =
        "not_invoked";
      let lastToggleAt: string | null = null;
      let panelLoadOutcome: DesktopDebugServer.GlobalDictationShortcutDebugSnapshot["panelLoadOutcome"] =
        "not_started";
      let lastPanelReadyOutcome: DesktopDebugServer.GlobalDictationShortcutDebugSnapshot["lastPanelReadyOutcome"] =
        "not_seen";
      let lastPanelReadyAt: string | null = null;
      let lastCaptureOutcome: DesktopDebugServer.GlobalDictationTargetDebugOutcome =
        "not_attempted";
      let lastCaptureAt: string | null = null;
      let lastCaptureDurationMs: number | null = null;
      let lastInsertOutcome: DesktopDebugServer.GlobalDictationTargetDebugOutcome = "not_attempted";
      let lastInsertAt: string | null = null;
      let lastInsertDurationMs: number | null = null;
      const publishShortcutDebug = (): void => {
        let electronRegistered: boolean | null = null;
        try {
          electronRegistered = registeredShortcut
            ? globalShortcut.isRegistered(registeredShortcut)
            : false;
        } catch {
          // A failed Electron status probe is unknown, not proof of registration.
        }
        DesktopDebugServer.publishGlobalDictationShortcutDebugSnapshot({
          enabled: shortcutEnabled,
          shortcut: configuredShortcut,
          registered: registeredShortcut === configuredShortcut,
          electronRegistered,
          registrationOutcome,
          registrationCheckedAt,
          invocationCount,
          lastInvokedAt,
          lastToggleOutcome,
          lastToggleAt,
          panelPhase: active?.phase ?? null,
          panelReady: active?.ready ?? false,
          panelVisible:
            active !== null && !active.window.isDestroyed() && active.window.isVisible(),
          panelLoadOutcome,
          lastPanelReadyOutcome,
          lastPanelReadyAt,
          lastCaptureOutcome,
          lastCaptureAt,
          lastCaptureDurationMs,
          lastInsertOutcome,
          lastInsertAt,
          lastInsertDurationMs,
        });
      };
      const noteRegistration = (
        outcome: DesktopDebugServer.GlobalDictationShortcutDebugSnapshot["registrationOutcome"],
      ): void => {
        registrationOutcome = outcome;
        registrationCheckedAt = new Date().toISOString();
        publishShortcutDebug();
      };
      const noteToggle = (
        outcome: DesktopDebugServer.GlobalDictationShortcutDebugSnapshot["lastToggleOutcome"],
      ): void => {
        lastToggleOutcome = outcome;
        lastToggleAt = new Date().toISOString();
        publishShortcutDebug();
      };
      const markPanelLoaded = (): void => {
        // Electron may emit preload-error while loadURL still resolves. Keep
        // that more useful category instead of overwriting it with "loaded".
        if (panelLoadOutcome === "loading") panelLoadOutcome = "loaded";
        publishShortcutDebug();
      };
      const markPanelNavigationFailed = (): void => {
        if (panelLoadOutcome !== "preload_failed") panelLoadOutcome = "navigation_failed";
        publishShortcutDebug();
      };
      const notifyPanelFailure = (): void => {
        const message = uiText(
          "The dictation window did not open. Restart Cafe Code and try again.",
        );
        if (Notification.isSupported()) {
          new Notification({ title: uiText("Cafe Dictation"), body: message }).show();
        } else {
          dialog.showErrorBox(uiText("Cafe Dictation"), message);
        }
      };
      const backend = await runPromise(exposure.backendConfig);
      const mainRendererUrl = environment.isDevelopment
        ? Option.getOrElse(environment.devServerUrl, () => backend.httpBaseUrl)
        : backend.httpBaseUrl;

      const admitMainSender = async (event: IpcMainInvokeEvent): Promise<boolean> => {
        const registeredMain = await runPromise(electronWindow.main);
        return isTrustedMainSender(
          event,
          active,
          mainRendererUrl,
          Option.isSome(registeredMain) ? registeredMain.value.webContents : null,
        );
      };

      const sendPanel = (panel: PanelSession, event: GlobalDictationEvent): void => {
        if (!panel.window.isDestroyed() && !panel.window.webContents.isDestroyed()) {
          panel.window.webContents.send(IpcChannels.GLOBAL_DICTATION_EVENT_CHANNEL, event);
        }
      };

      const closePanel = (panel: PanelSession): void => {
        if (active !== panel) return;
        active = null;
        panel.closing = true;
        if (panel.readyTimer !== null) {
          clearTimeout(panel.readyTimer);
          panel.readyTimer = null;
        }
        // Settle createPanel even if Electron's loadURL never returns. A
        // closed hidden panel must not hold the shortcut startup gate.
        panel.resolveReadiness(false);
        panel.target.dispose();
        if (!panel.window.isDestroyed()) {
          untrustAudioWebContents(panel.window.webContents);
          panel.window.destroy();
        }
        publishShortcutDebug();
      };

      const cancelPendingStartup = (): void => {
        // Capture and renderer trust setup both yield before active owns the
        // panel. Revoke that earlier authority too: lock/disable/quit must not
        // let a late helper result start a new microphone session afterward.
        const wasStarting = starting;
        startupRevision += 1;
        starting = false;
        pendingStartupTarget?.dispose();
        pendingStartupTarget = null;
        if (pendingStartupWindow && !pendingStartupWindow.isDestroyed()) {
          pendingStartupWindow.destroy();
        }
        pendingStartupWindow = null;
        if (wasStarting) noteToggle("superseded");
      };

      const readSettingsState = async (): Promise<GlobalDictationSettingsState> => {
        const current = await runPromise(settings.get);
        return {
          enabled: environment.platform === "darwin" && current.globalDictationEnabled,
          shortcut: current.globalDictationShortcut,
          registered: registeredShortcut === current.globalDictationShortcut,
          error:
            environment.platform === "darwin"
              ? registrationError === null
                ? null
                : registrationFeedbackForUi(registrationError)
              : uiText("Global dictation is currently available on macOS only."),
        };
      };

      const register = (shortcut: string): boolean => {
        try {
          return globalShortcut.register(shortcut, () => {
            invocationCount += 1;
            lastInvokedAt = new Date().toISOString();
            publishShortcutDebug();
            void toggleGlobal();
          });
        } catch {
          return false;
        }
      };

      const setEnabled = async (enabled: boolean): Promise<GlobalDictationSettingsState> => {
        if (environment.platform !== "darwin") return readSettingsState();
        const current = await runPromise(settings.get);
        configuredShortcut = current.globalDictationShortcut;
        shortcutEnabled = current.globalDictationEnabled;
        if (enabled && (!current.globalDictationEnabled || !registeredShortcut)) {
          if (!register(current.globalDictationShortcut)) {
            registrationError = "shortcut-used";
            noteRegistration("rejected");
            return readSettingsState();
          }
          try {
            await runPromise(settings.setGlobalDictationEnabled(true));
            registeredShortcut = current.globalDictationShortcut;
            shortcutEnabled = true;
            registrationError = null;
            noteRegistration("registered");
          } catch {
            globalShortcut.unregister(current.globalDictationShortcut);
            registrationError = "settings-write-failed";
            noteRegistration("settings_write_failed");
          }
        } else if (!enabled && current.globalDictationEnabled) {
          try {
            await runPromise(settings.setGlobalDictationEnabled(false));
            if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
            registeredShortcut = null;
            shortcutEnabled = false;
            registrationError = null;
            cancelPendingStartup();
            if (active) closePanel(active);
            noteRegistration("disabled");
          } catch {
            registrationError = "settings-write-failed";
            noteRegistration("settings_write_failed");
          }
        }
        return readSettingsState();
      };

      const setShortcut = async (raw: string): Promise<GlobalDictationSettingsState> => {
        if (environment.platform !== "darwin") return readSettingsState();
        const shortcut = DesktopAppSettings.normalizeGlobalDictationShortcut(raw);
        if (!shortcut) {
          registrationError = "invalid-shortcut";
          return readSettingsState();
        }
        const current = await runPromise(settings.get);
        shortcutEnabled = current.globalDictationEnabled;
        if (shortcut === current.globalDictationShortcut) return readSettingsState();
        const shouldRegister = current.globalDictationEnabled;
        if (shouldRegister && !register(shortcut)) {
          registrationError = "shortcut-used";
          noteRegistration("rejected");
          return readSettingsState();
        }
        try {
          await runPromise(settings.setGlobalDictationShortcut(shortcut));
          if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
          registeredShortcut = shouldRegister ? shortcut : null;
          configuredShortcut = shortcut;
          registrationError = null;
          noteRegistration(shouldRegister ? "registered" : "disabled");
        } catch {
          if (shouldRegister) globalShortcut.unregister(shortcut);
          registrationError = "shortcut-write-failed";
          noteRegistration("settings_write_failed");
        }
        return readSettingsState();
      };

      const createPanel = async (
        id: string,
        target: MacDictationTargetClient,
        captureFailure: MacDictationTargetFailureReason | null,
        insertionMethod: GlobalDictationInsertionMethod,
        isCurrentStartup: () => boolean,
      ): Promise<PanelSession | null> => {
        if (!isCurrentStartup()) return null;
        const rendererUrl = new URL(mainRendererUrl.href);
        rendererUrl.searchParams.set("cafeDictationOverlay", "1");
        rendererUrl.searchParams.set("sessionId", id);
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const width = Math.min(hudWidth, display.workArea.width - 24);
        const height = Math.min(hudHeight, display.workArea.height - 24);
        const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
        const y = Math.round(
          display.workArea.y + Math.min(100, (display.workArea.height - height) / 5),
        );
        const panel = new BrowserWindow({
          x,
          y,
          width,
          height,
          minWidth: Math.min(400, width),
          minHeight: Math.min(220, height),
          show: false,
          frame: false,
          transparent: true,
          vibrancy: "hud",
          visualEffectState: "active",
          type: "panel",
          resizable: false,
          movable: true,
          skipTaskbar: true,
          fullscreenable: false,
          alwaysOnTop: true,
          backgroundColor: "#00000000",
          webPreferences: {
            additionalArguments: desktopUiLocaleArguments(systemLocale, getUiLocale()),
            preload: join(dirname(environment.preloadPath), "globalDictationPreload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        pendingStartupWindow = panel;
        ElectronWindow.markAuxiliaryWindow(panel);
        panel.setAlwaysOnTop(true, "floating");
        // Electron's default fullscreen-workspace transformation calls DockHide
        // for the entire process, not just this auxiliary window. Cafe remains
        // a regular foreground app even while its nonactivating NSPanel joins
        // other Spaces. Keep the per-window collection flags without changing
        // the application's activation policy or hiding its Dock icon.
        // https://github.com/electron/electron/blob/v42.5.1/shell/browser/native_window_mac.mm
        panel.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
        panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        panel.webContents.on("will-navigate", (event, destination) => {
          if (destination !== rendererUrl.href) event.preventDefault();
        });
        panel.webContents.on("will-redirect", (event, destination, _inPlace, isMainFrame) => {
          if (isMainFrame && destination !== rendererUrl.href) event.preventDefault();
        });
        try {
          await runPromise(
            desktopIpc.trustWebContents(panel.webContents, { url: rendererUrl, role: "dictation" }),
          );
          if (!isCurrentStartup() || panel.isDestroyed()) {
            if (!panel.isDestroyed()) panel.destroy();
            return null;
          }
          trustAudioWebContents(panel.webContents, rendererUrl);
        } catch {
          // A trust setup failure precedes active-session ownership. Destroy
          // this otherwise invisible BrowserWindow before propagating a fixed
          // failure to the shortcut handler.
          if (!panel.isDestroyed()) panel.destroy();
          if (!isCurrentStartup()) return null;
          throw new Error("Dictation panel could not initialize.");
        } finally {
          if (pendingStartupWindow === panel) pendingStartupWindow = null;
        }
        let resolveReadiness: (ready: boolean) => void = () => undefined;
        const readiness = new Promise<boolean>((resolve) => {
          resolveReadiness = resolve;
        });
        const session: PanelSession = {
          id,
          window: panel,
          rendererUrl,
          target,
          insertionMethod,
          insertAvailable: captureFailure === null,
          captureFailure,
          phase: "recording",
          ready: false,
          pendingStop: false,
          closing: false,
          actionBusy: false,
          readyTimer: null,
          resolveReadiness,
        };
        // The renderer's ready IPC can arrive before loadURL resolves. Bind
        // the session now so the first (and only) ready is not dropped.
        active = session;
        if (pendingStartupTarget === target) pendingStartupTarget = null;
        panelLoadOutcome = "loading";
        lastPanelReadyOutcome = "not_seen";
        lastPanelReadyAt = null;
        panel.webContents.on("preload-error", () => {
          if (active !== session || session.ready) return;
          // Never publish Electron's raw preload error: its stack can include
          // local paths, rendered source, or a privileged URL.
          panelLoadOutcome = "preload_failed";
          publishShortcutDebug();
        });
        panel.webContents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
          if (active !== session || session.ready || !isMainFrame) return;
          markPanelNavigationFailed();
        });
        session.readyTimer = setTimeout(() => {
          if (active !== session || session.ready) return;
          lastPanelReadyOutcome = "timeout";
          lastPanelReadyAt = new Date().toISOString();
          noteToggle("open_failed");
          closePanel(session);
          notifyPanelFailure();
        }, panelReadyTimeoutMs);
        publishShortcutDebug();
        panel.on("close", (event) => {
          if (session.closing || session.phase !== "review") return;
          event.preventDefault();
          void dialog
            .showMessageBox(panel, {
              type: "question",
              title: uiText("Discard dictation draft?"),
              message: uiText("Discard the editable draft? It has not been saved automatically."),
              buttons: [uiText("Keep editing"), uiText("Discard")],
              defaultId: 0,
              cancelId: 0,
            })
            .then(({ response }) => {
              if (response === 1) closePanel(session);
            });
        });
        panel.on("closed", () => closePanel(session));
        panel.webContents.on("render-process-gone", () => {
          if (active !== session) return;
          const failedBeforeReady = !session.ready;
          if (failedBeforeReady) {
            panelLoadOutcome = "renderer_crashed";
            noteToggle("open_failed");
          }
          closePanel(session);
          if (failedBeforeReady) {
            notifyPanelFailure();
          }
        });
        try {
          await Promise.race([
            panel.loadURL(rendererUrl.href).then(() => {
              if (active === session) markPanelLoaded();
            }),
            readiness,
          ]);
        } catch {
          // The ready deadline may have closed the session while loadURL was
          // still pending. It already issued one fixed user-visible failure.
          if (active !== session) return session;
          markPanelNavigationFailed();
          closePanel(session);
          throw new Error("Dictation panel could not load.");
        }
        if (active !== session) return session;
        return session;
      };

      const toggleGlobal = async (): Promise<void> => {
        if (disposed || !shortcutEnabled || environment.platform !== "darwin") {
          noteToggle("ignored");
          return;
        }
        if (active) {
          if (active.phase === "recording") {
            active.phase = "finalizing";
            if (active.ready) sendPanel(active, { type: "stop", sessionId: active.id });
            else active.pendingStop = true;
            noteToggle("stopped");
          } else if (
            active.phase === "review" &&
            !active.actionBusy &&
            !active.window.isDestroyed()
          ) {
            active.window.show();
            active.window.focus();
            noteToggle("review_shown");
          } else {
            noteToggle("ignored");
          }
          return;
        }
        if (starting) {
          noteToggle("already_starting");
          return;
        }
        if (composerOwner && !composerOwner.webContents.isDestroyed()) {
          notifyComposerBusy();
          noteToggle("composer_busy");
          return;
        }
        starting = true;
        const revision = ++startupRevision;
        const id = randomUUID();
        latestCaptureId = id;
        const isCurrentStartup = (): boolean =>
          !disposed && shortcutEnabled && startupRevision === revision;
        noteToggle("opening");
        let target: MacDictationTargetClient | null = null;
        try {
          const executablePath = resolveMacDictationTargetPath(environment);
          if (!executablePath) {
            noteToggle("helper_unavailable");
            return;
          }
          target = createMacDictationTargetClient({ executablePath });
          pendingStartupTarget = target;
          const captureStarted = performance.now();
          const captured = await target.capture();
          if (!isCurrentStartup()) {
            target.dispose();
            return;
          }
          lastCaptureOutcome = captured.ok ? "succeeded" : captured.reason;
          lastCaptureAt = new Date().toISOString();
          lastCaptureDurationMs = Math.round(performance.now() - captureStarted);
          lastInsertOutcome = "not_attempted";
          lastInsertAt = null;
          lastInsertDurationMs = null;
          publishShortcutDebug();
          if (disposed || active || (composerOwner && !composerOwner.webContents.isDestroyed())) {
            target.dispose();
            noteToggle("superseded");
            return;
          }
          const session = await createPanel(
            id,
            target,
            captured.ok ? null : captured.reason,
            captured.ok ? (captured.insertionMethod ?? "accessibility") : "accessibility",
            isCurrentStartup,
          );
          if (!session) return;
          if (disposed) closePanel(session);
          else if (!session.ready && active === session) noteToggle("panel_created");
        } catch {
          target?.dispose();
          if (!isCurrentStartup()) return;
          // Only a fixed operational notification leaves main. Never include
          // native output, target metadata, file paths or a transcript.
          noteToggle("open_failed");
          notifyPanelFailure();
        } finally {
          if (startupRevision === revision && pendingStartupTarget === target) {
            pendingStartupTarget = null;
          }
          // A cancelled startup may settle after a newer one began. Its
          // finally block must not release the newer startup's admission gate.
          if (startupRevision === revision) starting = false;
        }
      };

      const panelAction = async (
        event: IpcMainInvokeEvent,
        raw: unknown,
      ): Promise<GlobalDictationActionResult> => {
        const panel = active;
        if (!isBoundPanelSender(event, panel) || !isPlainObject(raw)) {
          return { ok: false, reason: "unavailable" };
        }
        const action = raw as Partial<GlobalDictationAction>;
        if (action.sessionId !== panel.id || typeof action.action !== "string") {
          return { ok: false, reason: "unavailable" };
        }
        if (action.action === "ready") {
          if (panel.ready) {
            lastPanelReadyOutcome = "reload_rejected";
            lastPanelReadyAt = new Date().toISOString();
            publishShortcutDebug();
            closePanel(panel); // A reload lost the private unsaved draft authority.
            return { ok: false, reason: "unavailable" };
          }
          panel.ready = true;
          if (panel.readyTimer !== null) {
            clearTimeout(panel.readyTimer);
            panel.readyTimer = null;
          }
          lastPanelReadyOutcome = "accepted";
          lastPanelReadyAt = new Date().toISOString();
          panel.window.showInactive();
          noteToggle("opened");
          panel.resolveReadiness(true);
          // Ready proves the restricted renderer installed its listeners.
          // Reconcile any finite language change since BrowserWindow creation
          // before delivering the existing session-start event.
          panel.window.webContents.send(DESKTOP_UI_LOCALE_CHANGED_CHANNEL, getUiLocale());
          const captureGuidance = explainCaptureFailure(panel.captureFailure);
          sendPanel(panel, {
            type: "start",
            sessionId: panel.id,
            insertAvailable: panel.insertAvailable,
            insertionMethod: panel.insertionMethod,
            ...(panel.captureFailure === null
              ? {}
              : {
                  guidance:
                    panel.captureFailure === "accessibility_permission_required"
                      ? "accessibility_permission_required"
                      : "target_unavailable",
                }),
            ...(captureGuidance === undefined ? {} : { reason: captureGuidance }),
          });
          if (panel.pendingStop) sendPanel(panel, { type: "stop", sessionId: panel.id });
          return { ok: true };
        }
        if (action.action === "stop") {
          if (panel.phase !== "recording") return { ok: false, reason: "unavailable" };
          panel.phase = "finalizing";
          publishShortcutDebug();
          sendPanel(panel, { type: "stop", sessionId: panel.id });
          return { ok: true };
        }
        if (action.action === "review") {
          if (panel.phase !== "finalizing" && panel.phase !== "recording")
            return { ok: false, reason: "unavailable" };
          panel.phase = "review";
          publishShortcutDebug();
          const display = screen.getDisplayMatching(panel.window.getBounds());
          const width = Math.min(reviewWidth, display.workArea.width - 24);
          const height = Math.min(reviewHeight, display.workArea.height - 24);
          panel.window.setResizable(true);
          panel.window.setBounds({
            x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
            y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
            width,
            height,
          });
          panel.window.show();
          panel.window.focus();
          return { ok: true };
        }
        if (action.action === "cancel") {
          closePanel(panel);
          return { ok: true };
        }
        if (panel.phase !== "review" || panel.actionBusy || !isBoundedDraft(action.text)) {
          return { ok: false, reason: "invalid_input" };
        }
        panel.actionBusy = true;
        try {
          if (action.action === "copy") {
            clipboard.writeText(action.text);
            await panel.target.discard();
            panel.insertAvailable = false;
            sendPanel(panel, { type: "review", sessionId: panel.id, insertAvailable: false });
            return { ok: true };
          }
          if (action.action === "save") {
            const result = await saveDictationDraft({
              text: action.text,
              chooseDestination: () =>
                dialog.showSaveDialog(panel.window, {
                  title: uiText("Save dictation text"),
                  defaultPath: "dictation.txt",
                  filters: [{ name: uiText("Text"), extensions: ["txt"] }],
                }),
              isCurrent: () => active === panel && !disposed,
            });
            if (result !== "saved")
              return { ok: false, reason: result === "cancelled" ? "cancelled" : "save_failed" };
            await panel.target.discard();
            panel.insertAvailable = false;
            sendPanel(panel, { type: "review", sessionId: panel.id, insertAvailable: false });
            return { ok: true };
          }
          if (action.action === "insert") {
            if (!panel.insertAvailable) return { ok: false, reason: "target_unavailable" };
            panel.insertAvailable = false; // consume authority before external I/O
            const insertStarted = performance.now();
            // A focusable floating panel must stop owning focus before the
            // native helper restores the retained app/window/field. Merely
            // activating an app is insufficient, especially when the original
            // editor is another Cafe window. Hide, never destroy: a definite
            // refusal or uncertain write must leave the editable draft intact.
            let outcome: DesktopDebugServer.GlobalDictationTargetDebugOutcome =
              "insertion_uncertain";
            try {
              panel.window.hide();
              publishShortcutDebug();
              const result = await panel.target.insert(action.text);
              outcome = result.ok
                ? "succeeded"
                : result.uncertain
                  ? "insertion_uncertain"
                  : result.reason;
            } catch {
              // Once authority has been consumed we cannot establish that an
              // unexpected IPC/native failure preceded the external write.
              // Never replay it or expose arbitrary native exception text.
              panel.target.dispose();
            } finally {
              // Retain the last result after a close, but never attribute an
              // old panel's completion to a newer recording's diagnostics.
              if (latestCaptureId === panel.id) {
                lastInsertOutcome = outcome;
                lastInsertAt = new Date().toISOString();
                lastInsertDurationMs = Math.round(performance.now() - insertStarted);
                publishShortcutDebug();
              }
            }
            if (outcome === "succeeded") {
              closePanel(panel);
              return { ok: true };
            }
            // Cancel, Quit, sleep, or renderer loss may retire this panel while
            // native I/O settles. A late result must never reopen an old draft
            // or steal focus from a newer recording session.
            if (active === panel && !disposed && !panel.window.isDestroyed()) {
              panel.window.show();
              panel.window.focus();
              sendPanel(panel, { type: "review", sessionId: panel.id, insertAvailable: false });
              publishShortcutDebug();
            }
            return { ok: false, reason: outcome };
          }
          return { ok: false, reason: "unavailable" };
        } finally {
          panel.actionBusy = false;
        }
      };

      const getSettings = async (event: IpcMainInvokeEvent) =>
        (await admitMainSender(event))
          ? readSettingsState()
          : Promise.resolve({
              enabled: false,
              shortcut: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.globalDictationShortcut,
              registered: false,
              error: uiText("Unavailable in this window."),
            });
      ipcMain.handle(IpcChannels.GET_GLOBAL_DICTATION_SETTINGS_CHANNEL, getSettings);
      ipcMain.handle(
        IpcChannels.SET_GLOBAL_DICTATION_ENABLED_CHANNEL,
        async (event, enabled: unknown) =>
          (await admitMainSender(event)) && typeof enabled === "boolean"
            ? setEnabled(enabled)
            : readSettingsState(),
      );
      ipcMain.handle(
        IpcChannels.SET_GLOBAL_DICTATION_SHORTCUT_CHANNEL,
        async (event, shortcut: unknown) =>
          (await admitMainSender(event)) && typeof shortcut === "string"
            ? setShortcut(shortcut)
            : readSettingsState(),
      );
      ipcMain.handle(IpcChannels.CLAIM_COMPOSER_DICTATION_CAPTURE_CHANNEL, async (event) => {
        if (!(await admitMainSender(event)) || active || starting) return null;
        if (composerOwner && !composerOwner.webContents.isDestroyed()) return null;
        const leaseId = randomUUID();
        composerOwner = { webContents: event.sender, leaseId };
        event.sender.once("destroyed", () => {
          if (composerOwner?.leaseId === leaseId) composerOwner = null;
        });
        return leaseId;
      });
      ipcMain.handle(
        IpcChannels.RELEASE_COMPOSER_DICTATION_CAPTURE_CHANNEL,
        async (event, leaseId: unknown) => {
          if (
            typeof leaseId === "string" &&
            composerOwner?.webContents === event.sender &&
            composerOwner.leaseId === leaseId &&
            (await admitMainSender(event))
          )
            composerOwner = null;
        },
      );
      ipcMain.handle(IpcChannels.GLOBAL_DICTATION_ACTION_CHANNEL, panelAction);

      const stopForLock = () => {
        cancelPendingStartup();
        if (active) closePanel(active);
      };
      powerMonitor.on("suspend", stopForLock);
      powerMonitor.on("lock-screen", stopForLock);
      app.on("before-quit", stopForLock);

      if (environment.platform === "darwin") {
        const initial = await runPromise(settings.get);
        configuredShortcut = initial.globalDictationShortcut;
        shortcutEnabled = initial.globalDictationEnabled;
        if (initial.globalDictationEnabled) {
          if (register(initial.globalDictationShortcut)) {
            registeredShortcut = initial.globalDictationShortcut;
            noteRegistration("registered");
          } else {
            registrationError = "shortcut-used";
            noteRegistration("rejected");
          }
        } else {
          noteRegistration("disabled");
        }
      } else {
        noteRegistration("unsupported");
      }

      return () => {
        disposed = true;
        unsubscribeLocale();
        cancelPendingStartup();
        if (active) closePanel(active);
        if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
        registeredShortcut = null;
        shortcutEnabled = false;
        noteRegistration("disabled");
        composerOwner = null;
        powerMonitor.removeListener("suspend", stopForLock);
        powerMonitor.removeListener("lock-screen", stopForLock);
        app.removeListener("before-quit", stopForLock);
        for (const channel of [
          IpcChannels.GET_GLOBAL_DICTATION_SETTINGS_CHANNEL,
          IpcChannels.SET_GLOBAL_DICTATION_ENABLED_CHANNEL,
          IpcChannels.SET_GLOBAL_DICTATION_SHORTCUT_CHANNEL,
          IpcChannels.CLAIM_COMPOSER_DICTATION_CAPTURE_CHANNEL,
          IpcChannels.RELEASE_COMPOSER_DICTATION_CAPTURE_CHANNEL,
          IpcChannels.GLOBAL_DICTATION_ACTION_CHANNEL,
        ])
          ipcMain.removeHandler(channel);
      };
    }),
    (dispose) => Effect.sync(dispose),
  );
});
