import { beforeEach, expect, it, vi } from "vitest";
import type { NativeControlActivity } from "@cafecode/contracts";
import { setUiLocale } from "@cafecode/shared/i18n";
const mocks = vi.hoisted(() => ({
  panels: [] as any[],
  trays: [] as any[],
  menu: [] as any[],
  main: {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
    isMinimized: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  },
}));
vi.mock("electron", () => {
  class Panel {
    isVisible = () => false;
    getMediaSourceId = () => "window:42:0";
    options: any;
    constructor(options: any) {
      this.options = options;
      mocks.panels.push(this);
    }
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => {}),
    };
    setIgnoreMouseEvents = vi.fn();
    setContentProtection = vi.fn();
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    on = vi.fn();
    loadURL = vi.fn(async () => {});
    setBounds = vi.fn();
    showInactive = vi.fn();
    hide = vi.fn();
    destroy = vi.fn();
    isDestroyed = () => false;
    static getAllWindows() {
      return [mocks.main, ...mocks.panels];
    }
  }
  class Tray {
    constructor() {
      mocks.trays.push(this);
    }
    setTitle = vi.fn();
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    destroy = vi.fn();
    isDestroyed = () => false;
  }
  return {
    BrowserWindow: Panel,
    Tray,
    nativeImage: { createFromBuffer: () => ({ setTemplateImage: vi.fn() }) },
    Menu: {
      buildFromTemplate: (menu: any[]) => {
        mocks.menu = menu;
        return menu;
      },
    },
  };
});
vi.mock("../electron/ElectronWindow.ts", () => ({
  markAuxiliaryWindow: vi.fn(),
  isLiveMainCandidate: (w: unknown) => w === mocks.main,
}));
import { NativeControlIndicators } from "./NativeControlVisibility.ts";
const activity: NativeControlActivity = {
  version: 1,
  generation: "host",
  sequence: 1,
  episode: "episode",
  threadId: "chat" as NativeControlActivity["threadId"],
  provider: "codex",
  providerInstanceId: "account",
  phase: "capturing",
  inputPolicy: "foreground-allowed",
  inputRoute: "pid",
  usingSystemPointer: false,
  lastCaptureAt: null,
  target: {
    scope: "window",
    app: "Fixture",
    title: "Fixture",
    pid: 1,
    windowId: 2,
    visible: true,
    bounds: { x: -300, y: 50, width: 200, height: 100 },
  },
};
beforeEach(() => {
  setUiLocale("en");
  mocks.panels.length = 0;
  mocks.trays.length = 0;
  mocks.menu = [];
  vi.clearAllMocks();
});
it("updates native copy on a language change while preserving exact Stop ownership", async () => {
  const actions = {
    stop: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    inputPolicy: vi.fn(async () => {}),
  };
  const indicators = new NativeControlIndicators(actions);
  try {
    await indicators.update(activity);
    setUiLocale("ja");
    await vi.waitFor(() => {
      expect(mocks.menu.some((item) => item.label === "コンピューター操作を停止")).toBe(true);
    });
    mocks.menu.find((item) => item.label === "コンピューター操作を停止").click();
    expect(actions.stop).toHaveBeenCalledExactlyOnceWith("episode");
    expect(mocks.panels).toHaveLength(1);
    expect(actions.inputPolicy).not.toHaveBeenCalled();
  } finally {
    await indicators.close();
    setUiLocale("en");
  }
});
it("shows a nonactivating excluded panel, keeps the menu while idle, and fences stale updates", async () => {
  const actions = {
    stop: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    inputPolicy: vi.fn(async () => {}),
  };
  const indicators = new NativeControlIndicators(actions);
  try {
    await indicators.update(activity);
    const panel = mocks.panels[0];
    expect(panel.options).toMatchObject({
      type: "panel",
      focusable: false,
      show: false,
      webPreferences: { nodeIntegration: false, sandbox: true },
    });
    expect(panel.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(panel.setContentProtection).not.toHaveBeenCalled();
    expect(panel.setBounds).toHaveBeenCalledWith({ x: -300, y: 50, width: 200, height: 100 });
    expect(panel.showInactive).toHaveBeenCalledOnce();
    await indicators.update({
      ...activity,
      sequence: 2,
      phase: "idle",
      target: { ...activity.target!, visible: false },
    });
    expect(panel.hide).toHaveBeenCalledOnce();
    expect(mocks.trays).toHaveLength(1);
    await indicators.update(activity);
    expect(panel.showInactive).toHaveBeenCalledOnce();
    mocks.menu.find((item) => item.label === "Stop computer use").click();
    expect(actions.stop).toHaveBeenCalledWith("episode");
    await indicators.update({
      ...activity,
      sequence: 3,
      phase: "inactive",
      episode: null,
      target: null,
    });
    expect(panel.destroy).toHaveBeenCalledOnce();
    expect(mocks.trays[0].destroy).toHaveBeenCalledOnce();
  } finally {
    await indicators.close();
  }
});
it("uses the selected provider and display scope without claiming delivery", async () => {
  const indicators = new NativeControlIndicators({
    stop: async () => {},
    refresh: async () => {},
    inputPolicy: async () => {},
  });
  try {
    await indicators.update({
      ...activity,
      provider: "claudeAgent",
      target: {
        scope: "display",
        app: "Main display",
        title: "Whole main display",
        visible: true,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
    });
    const menuText = mocks.menu.map((item) => item.label).join(" ");
    expect(menuText).toContain("Claude");
    expect(menuText).toContain("Whole main display");
    expect(menuText).toContain("can be supplied");
    expect(menuText).not.toMatch(/confirmed|uploaded|recording/iu);
    expect(mocks.panels[0].webContents.executeJavaScript.mock.calls[0][0]).toContain(
      "whole main display",
    );
  } finally {
    await indicators.close();
  }
});
