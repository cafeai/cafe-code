import { uiText, subscribeUiLocale } from "@cafecode/shared/i18n";
import { BrowserWindow, Menu, nativeImage, Tray } from "electron";
import type { NativeControlActivity } from "@cafecode/contracts";
import * as IpcChannels from "../ipc/channels.ts";
import type { NativeControlVisibility as Visibility } from "./NativeControlHost.ts";
import { markAuxiliaryWindow, isLiveMainCandidate } from "../electron/ElectronWindow.ts";

export function activityLabel(activity: NativeControlActivity): string {
  if (activity.phase === "controlling" && activity.usingSystemPointer)
    return uiText("Using the real mouse");
  return {
    inactive: uiText("Computer use off"),
    idle: uiText("Computer use active · idle"),
    "reading-controls": uiText("Reading window controls"),
    capturing: uiText("Taking a screenshot"),
    controlling: uiText("Controlling"),
    stopping: uiText("Stopping computer use…"),
  }[activity.phase];
}
const providerLabel = (activity: NativeControlActivity) =>
  activity.provider === "codex"
    ? "Codex"
    : activity.provider === "claudeAgent"
      ? "Claude"
      : uiText("Cafe preview");
const document = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'"><title>Cafe computer-use indicator</title><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font:12px -apple-system,BlinkMacSystemFont,sans-serif;box-sizing:border-box}body{border:3px solid #5b52e8;border-radius:8px}#badge{position:absolute;top:3px;right:3px;max-width:calc(100% - 24px);box-sizing:border-box;padding:5px 9px;background:#24202f;color:white;border-radius:0 0 0 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.1px}@media(prefers-reduced-transparency:reduce){#badge{background:#24202f}}@media(prefers-contrast:more){body{border-color:#ad9eff}#badge{outline:1px solid white}}
</style></head><body><div id="badge" role="status"></div></body></html>`;

/** Electron owns both surfaces. The border is a sandboxed, nonactivating,
 * click-through panel, without preload or input IPC. Stop lives in the native
 * menu and Cafe, so no interactive overlay can steal the user's focus. */
export class NativeControlIndicators implements Visibility {
  private tray: Tray | undefined;
  private border: BrowserWindow | undefined;
  private loaded: Promise<void> | undefined;
  private current: NativeControlActivity | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly unsubscribeLocale: () => void;
  private readonly actions: {
    stop: (episode: string) => Promise<void>;
    refresh: (episode: string) => Promise<void>;
    inputPolicy: (policy: "background-only" | "foreground-allowed") => Promise<void>;
  };
  constructor(actions: NativeControlIndicators["actions"]) {
    this.actions = actions;
    this.unsubscribeLocale = subscribeUiLocale(() => {
      const activity = this.current;
      if (!activity?.episode || this.disposed) return;
      const job = this.queue.catch(() => {}).then(() => this.apply(activity));
      this.queue = job;
      void job.catch(() => this.failed(activity.episode));
    });
  }
  update(activity: NativeControlActivity): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Indicators are unavailable"));
    if (
      this.current &&
      this.current.generation === activity.generation &&
      this.current.sequence >= activity.sequence
    )
      return Promise.resolve();
    this.current = activity;
    const job = this.queue.catch(() => {}).then(() => this.apply(activity));
    this.queue = job;
    // A capture ACK must wait for a newer visible update too, when geometry or
    // Stop superseded this revision while the panel was loading.
    return job.then(async () => {
      if (this.queue !== job) await this.queue;
    });
  }
  private async apply(activity: NativeControlActivity): Promise<void> {
    if (this.current !== activity || this.disposed) return;
    if (activity.phase === "inactive") {
      this.retire();
      this.broadcast(activity);
      return;
    }
    if (!this.tray) {
      // Small monochrome Cafe pointer; a native template adapts to light/dark
      // menu bars. Text remains visible as well as the icon.
      const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_PNG, "base64"));
      icon.setTemplateImage(true);
      this.tray = new Tray(icon);
      this.tray.setTitle("Cafe");
    }
    if (this.tray.isDestroyed()) throw new Error("Menu indicator lost");
    const provider = providerLabel(activity);
    const label = activityLabel(activity);
    const target = activity.target
      ? uiText("{app} · {title}", { app: activity.target.app, title: activity.target.title })
      : uiText("Selecting target");
    const episode = activity.episode!;
    this.tray.setToolTip(
      uiText("{provider} · {activity}\n{target}", { provider, activity: label, target }),
    );
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: uiText("{provider} · {activity}", { provider, activity: label }), enabled: false },
        { label: target, enabled: false },
        ...((activity.target?.scope === "window" || activity.target?.scope === "browser") &&
        activity.target.visible === false
          ? [
              {
                label:
                  activity.target.visibilityReason === "occluded"
                    ? uiText("Target outline hidden behind overlapping windows")
                    : uiText("Target window is off screen"),
                enabled: false,
              },
            ]
          : []),
        {
          label:
            activity.provider === "human"
              ? uiText("Local permission preview; images stay in Cafe.")
              : uiText(
                  "Window images and controls can be supplied to the selected {provider} provider.",
                  { provider },
                ),
          enabled: false,
        },
        {
          label: uiText("Provider binding: {binding}", {
            binding: activity.providerInstanceId?.slice(0, 80) ?? uiText("Local preview"),
          }),
          enabled: false,
        },
        { type: "separator" },
        {
          label: uiText("Background input only"),
          type: "checkbox",
          checked: activity.inputPolicy === "background-only",
          enabled: activity.phase !== "stopping",
          click: () => {
            void this.actions
              .inputPolicy(
                activity.inputPolicy === "background-only"
                  ? "foreground-allowed"
                  : "background-only",
              )
              .catch(() => this.failed(episode));
          },
        },
        {
          label: uiText("Return to owning chat"),
          enabled: activity.provider !== "human",
          click: () => this.openChat(activity),
        },
        {
          label: uiText("Stop computer use"),
          enabled: activity.phase !== "stopping",
          click: () => {
            void this.actions.stop(episode).catch(() => this.failed(episode));
          },
        },
      ]),
    );
    if (!this.border) {
      const panel = new BrowserWindow({
        width: 100,
        height: 100,
        show: false,
        type: "panel",
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        focusable: false,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        title: "Cafe computer-use indicator",
        acceptFirstMouse: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false,
        },
      });
      this.border = panel;
      markAuxiliaryWindow(panel);
      panel.setIgnoreMouseEvents(true);
      // ScreenCaptureKit uses exact native window IDs returned with the capture
      // ACK, rather than relying on NSWindow sharing flags.
      panel.setAlwaysOnTop(true, "floating");
      panel.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
      panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      panel.webContents.on("will-navigate", (event) => event.preventDefault());
      panel.webContents.on("render-process-gone", () => this.failed(this.current?.episode));
      panel.on("closed", () => {
        if (this.border === panel) {
          this.border = undefined;
          this.failed(this.current?.episode);
        }
      });
      this.loaded = panel.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
    }
    await this.loaded;
    if (this.current !== activity || this.disposed) return;
    const border = this.border;
    if (!border || border.isDestroyed() || border.webContents.isDestroyed())
      throw new Error("Window indicator lost");
    const badge =
      activity.target?.scope === "display"
        ? uiText("{provider} · {activity} · whole main display", { provider, activity: label })
        : activity.target?.scope === "browser"
          ? uiText("{provider} · {activity} · connected tab", { provider, activity: label })
          : uiText("{provider} · {activity}", { provider, activity: label });
    await border.webContents.executeJavaScript(
      `document.getElementById("badge").textContent=${JSON.stringify(badge)};document.body.setAttribute("aria-label",${JSON.stringify(`${badge} · ${target}`)});`,
      false,
    );
    if (this.current !== activity || this.disposed) return;
    const b = activity.target?.bounds;
    if (
      activity.target?.visible &&
      b &&
      [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
      b.width >= 32 &&
      b.height >= 32 &&
      b.width <= 32768 &&
      b.height <= 32768
    ) {
      border.setBounds({
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.round(b.width),
        height: Math.round(b.height),
      });
      if (!border.isVisible()) border.showInactive();
    } else border.hide();
    this.broadcast(activity);
    this.scheduleRefresh(episode);
  }
  windowIds(): readonly number[] {
    if (!this.border || this.border.isDestroyed()) return [];
    const match = /^window:(\d+):\d+$/u.exec(this.border.getMediaSourceId());
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0)
      throw new Error("Indicator native window identity is unavailable");
    return [Number(match[1])];
  }
  private broadcast(activity: NativeControlActivity) {
    for (const window of BrowserWindow.getAllWindows())
      if (isLiveMainCandidate(window) && !window.webContents.isDestroyed()) {
        window.webContents.send(IpcChannels.NATIVE_CONTROL_ACTIVITY_CHANNEL, activity);
        if (activity.phase === "inactive")
          window.webContents.send(IpcChannels.NATIVE_CONTROL_CHANGED_CHANNEL);
      }
  }
  private scheduleRefresh(episode: string) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (
        this.current?.episode !== episode ||
        this.current.phase === "inactive" ||
        this.current.phase === "stopping" ||
        this.disposed
      )
        return;
      if (!this.tray || this.tray.isDestroyed() || !this.border || this.border.isDestroyed()) {
        this.failed(episode);
        return;
      }
      void this.actions.refresh(episode).then(
        () => {
          if (this.current?.episode === episode) this.scheduleRefresh(episode);
        },
        () => this.failed(episode),
      );
    }, 250);
  }
  private failed(episode: string | null | undefined) {
    if (episode && !this.disposed) void this.actions.stop(episode).catch(() => {});
  }
  private openChat(activity: NativeControlActivity) {
    if (this.current?.episode !== activity.episode || !activity.threadId) return;
    const window = BrowserWindow.getAllWindows().find(
      (w) => isLiveMainCandidate(w) && !w.webContents.isDestroyed(),
    );
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send(
      IpcChannels.MENU_ACTION_CHANNEL,
      `computer-use-chat:${activity.threadId}`,
    );
  }
  private retire() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const border = this.border;
    this.border = undefined;
    this.loaded = undefined;
    border?.destroy();
    this.tray?.destroy();
    this.tray = undefined;
  }
  async close(): Promise<void> {
    this.disposed = true;
    this.unsubscribeLocale();
    this.retire();
    await this.queue.catch(() => {});
  }
}

// Generated from a fixed 18x18 monochrome pointer bitmap; no remote resource.
const TRAY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAALUlEQVR4nGNgGArg/6A0iCqGUd0gig37Ty3DaGYQ2YaOGkRHg/AZPDgMIgoAAFURQMB4BQL7AAAAAElFTkSuQmCC";
