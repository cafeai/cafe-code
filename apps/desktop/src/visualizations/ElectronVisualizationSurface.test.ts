import { describe, expect, it, vi } from "vitest";
import type * as Electron from "electron";
import { EventEmitter } from "node:events";
import { VISUALIZATION_FLUID_RUNTIME_SOURCE } from "@cafecode/shared/visualizationFluidRuntime";
import { GENERATED_VISUALIZATION_FONT_FAMILY_STYLE } from "@cafecode/shared/chatTypography";
import {
  cancelsPendingGeneratedFontInstall,
  GeneratedVisualizationFontCommit,
  installFontReadyGeneratedDocument,
} from "./visualizationFontInstallation.ts";
import {
  ElectronVisualizationSurface,
  type VisualizationSurfaceOptions,
} from "./ElectronVisualizationSurface.ts";
import { PREVIEW_DEVICE_SCALE_FACTOR } from "./visualizationCapturePolicy.ts";

const native = vi.hoisted(() => ({
  inventory: vi.fn(),
  display: vi.fn(),
  hasSwitch: vi.fn(() => false),
  partition: vi.fn(),
  createView: vi.fn(),
  createClip: vi.fn(),
  createWindow: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { commandLine: { hasSwitch: native.hasSwitch } },
  session: { fromPartition: native.partition },
  WebContentsView: function (_options: unknown) {
    return native.createView(_options);
  },
  View: function () {
    return native.createClip();
  },
  BrowserWindow: function (_options: unknown) {
    return native.createWindow(_options);
  },
  webContents: { getAllWebContents: native.inventory },
  screen: { getDisplayMatching: native.display },
}));

/** Exact synthetic native handles exercise production creation/retirement, not
 * a mocked createNativeSurface or inferred process exit. None launches Electron
 * or reads a profile. Each close emits the same handle's actual destroyed event. */
function startupFixture() {
  const contents = Object.assign(new EventEmitter(), {
    ipc: new EventEmitter(),
    isDestroyed: vi.fn(() => destroyed),
    close: vi.fn(() => {
      destroyed = true;
      contents.emit("destroyed");
    }),
    forcefullyCrashRenderer: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(async () => {
      throw new Error("synthetic bootstrap refusal");
    }),
    getZoomFactor: vi.fn(() => 1),
  });
  let destroyed = false;
  let windowDestroyed = false;
  let clipBounds = { x: 0, y: 0, width: 400, height: 200 };
  const clip = {
    setVisible: vi.fn(),
    setBounds: vi.fn((bounds: typeof clipBounds) => {
      clipBounds = bounds;
    }),
    getBounds: vi.fn(() => clipBounds),
    setBorderRadius: vi.fn(),
    addChildView: vi.fn(),
    removeChildView: vi.fn(),
  };
  const view = {
    webContents: contents,
    setVisible: vi.fn(),
    setBackgroundColor: vi.fn(),
    setBounds: vi.fn(),
  };
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: vi.fn(() => windowDestroyed),
    destroy: vi.fn(() => {
      windowDestroyed = true;
      window.emit("closed");
    }),
    getContentSize: vi.fn(() => [400, 200]),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  });
  const session = Object.assign(new EventEmitter(), {
    isPersistent: vi.fn(() => false),
    getPreloadScripts: vi.fn(() => []),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setCertificateVerifyProc: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
    protocol: { handle: vi.fn(), unhandle: vi.fn() },
    clearStorageData: vi.fn(async () => {}),
  });
  native.hasSwitch.mockReturnValue(false);
  native.partition.mockReturnValue(session);
  native.createView.mockReturnValue(view);
  native.createClip.mockReturnValue(clip);
  native.createWindow.mockReturnValue(window);
  native.partition.mockClear();
  native.createView.mockClear();
  native.createClip.mockClear();
  native.createWindow.mockClear();
  const create = (preview = false, clipHeight = 200) =>
    new ElectronVisualizationSurface({
      document: {
        kind: "generated",
        html: "<svg><rect width='10' height='10'/></svg>",
        assets: [],
        width: 400,
        height: 200,
        appearance: "light",
      },
      preloadPath: "unlaunched synthetic preload",
      window: preview ? null : (window as unknown as Electron.BrowserWindow),
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      clipBounds: { x: 0, y: 0, width: 400, height: clipHeight },
      onMessage: () => {},
      onRevoked: vi.fn(),
    });
  return { create, contents, clip, view, window, session };
}

describe("native visualization partial startup retirement", () => {
  it("requests the fixed native scale only for private offscreen previews", async () => {
    for (const preview of [false, true]) {
      const f = startupFixture();
      const surface = f.create(preview);
      try {
        await expect(surface.initialize()).rejects.toThrow("synthetic bootstrap refusal");
        expect(native.createView).toHaveBeenCalledWith({
          webPreferences: expect.objectContaining({
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            offscreen: preview ? { deviceScaleFactor: PREVIEW_DEVICE_SCALE_FACTOR } : false,
          }),
        });
      } finally {
        expect(await surface.retire(0)).toBe(true);
      }
    }
  });

  it("refuses a sub-minimum initial mask before allocating a session or child", async () => {
    const f = startupFixture(),
      surface = f.create(false, 31);
    await expect(surface.initialize()).rejects.toThrow("Visualization bounds were refused.");
    expect(native.partition).not.toHaveBeenCalled();
    expect(native.createView).not.toHaveBeenCalled();
    expect(native.createClip).not.toHaveBeenCalled();
    expect(await surface.retire(0)).toBe(true);
    expect(f.contents.close).not.toHaveBeenCalled();
    expect(f.window.destroy).not.toHaveBeenCalled();
  });

  it.each([
    "child-visibility",
    "clip-creation",
    "mask-bounds",
    "mask-attachment",
    "policy-handler",
  ] as const)(
    "observes exact child destruction after a %s failure without quarantining the healthy owner",
    async (boundary) => {
      const f = startupFixture(),
        surface = f.create();
      const refuse = () => {
        throw new Error("synthetic partial setup refusal");
      };
      if (boundary === "child-visibility") f.view.setVisible.mockImplementationOnce(refuse);
      if (boundary === "clip-creation") native.createClip.mockImplementationOnce(refuse);
      if (boundary === "mask-bounds") f.clip.setBounds.mockImplementationOnce(refuse);
      if (boundary === "mask-attachment")
        f.window.contentView.addChildView.mockImplementationOnce(refuse);
      if (boundary === "policy-handler")
        f.session.setPermissionRequestHandler.mockImplementationOnce(refuse);
      await expect(surface.initialize()).rejects.toThrow();
      expect(await surface.retire(0)).toBe(true);
      expect(surface.diagnostics()).toMatchObject({ phase: "retired", destroyed: true });
      expect(f.contents.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false });
      expect(f.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
      expect(f.window.destroy).not.toHaveBeenCalled();
      expect(f.session.clearStorageData).toHaveBeenCalledOnce();
      expect(Reflect.get(surface, "sourceDocument")).toBeUndefined();
      expect(Reflect.get(surface, "callbacks")).toBeUndefined();
    },
  );

  it("still closes the exact child when native detachment throws", async () => {
    const f = startupFixture(),
      surface = f.create();
    await expect(surface.initialize()).rejects.toThrow("synthetic bootstrap refusal");
    f.clip.removeChildView.mockImplementationOnce(() => {
      throw new Error("synthetic detach refusal");
    });
    expect(await surface.retire(0)).toBe(true);
    expect(f.contents.close).toHaveBeenCalledOnce();
    expect(f.window.destroy).not.toHaveBeenCalled();
  });

  it("clears only a qualified private session and preview window when child allocation fails", async () => {
    const f = startupFixture(),
      surface = f.create(true);
    native.createView.mockImplementationOnce(() => {
      throw new Error("synthetic allocation refusal");
    });
    await expect(surface.initialize()).rejects.toThrow("synthetic allocation refusal");
    expect(await surface.retire(0)).toBe(true);
    expect(f.window.destroy).toHaveBeenCalledOnce();
    expect(f.session.clearStorageData).toHaveBeenCalledOnce();
    expect(f.contents.close).not.toHaveBeenCalled();
  });

  it("does not claim a private preview window retired when its exact native destroy failed", async () => {
    const f = startupFixture(),
      surface = f.create(true);
    native.createView.mockImplementationOnce(() => {
      throw new Error("synthetic allocation refusal");
    });
    await expect(surface.initialize()).rejects.toThrow("synthetic allocation refusal");
    f.window.destroy.mockImplementationOnce(() => {
      throw new Error("synthetic native destroy refusal");
    });
    expect(await surface.retire(0)).toBe(false);
    expect(surface.diagnostics().phase).toBe("quarantined");
    expect(f.session.clearStorageData).not.toHaveBeenCalled();
    expect(Reflect.get(surface, "sourceDocument")).toBeDefined();
  });

  it("does not clear storage in a refused persistent session", async () => {
    const f = startupFixture(),
      surface = f.create(true);
    f.session.isPersistent.mockReturnValue(true);
    await expect(surface.initialize()).rejects.toThrow("Visualization execution is unavailable.");
    expect(await surface.retire(0)).toBe(true);
    expect(f.session.clearStorageData).not.toHaveBeenCalled();
    expect(native.createWindow).not.toHaveBeenCalled();
  });

  it("quarantines an unobserved child close rather than treating a request as destruction", async () => {
    const f = startupFixture(),
      surface = f.create();
    f.clip.setBounds.mockImplementationOnce(() => {
      throw new Error("synthetic partial setup refusal");
    });
    await expect(surface.initialize()).rejects.toThrow();
    f.contents.close.mockImplementation(() => {});
    expect(await surface.retire(0)).toBe(false);
    expect(surface.diagnostics()).toMatchObject({ phase: "quarantined", destroyed: false });
    expect(f.session.clearStorageData).not.toHaveBeenCalled();
    expect(Reflect.get(surface, "sourceDocument")).toBeDefined();
    expect(f.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
  });

  it("never crashes or closes an admitted renderer without current exclusive-process proof", async () => {
    const f = startupFixture(),
      surface = f.create();
    await expect(surface.initialize()).rejects.toThrow("synthetic bootstrap refusal");
    Reflect.set(surface, "rendererPid", 123);
    const internals = surface as unknown as { processesAreExclusive(retirement: boolean): boolean };
    const exclusive = vi.spyOn(internals, "processesAreExclusive").mockReturnValue(false);
    expect(await surface.retire(0)).toBe(false);
    expect(exclusive).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.contents.close).not.toHaveBeenCalled();
    expect(f.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    expect(f.session.clearStorageData).not.toHaveBeenCalled();
    expect(surface.diagnostics().phase).toBe("quarantined");
  });

  it("never allocates another child when initialize repeats or cancellation wins first", async () => {
    const f = startupFixture(),
      surface = f.create();
    await expect(surface.initialize()).rejects.toThrow("synthetic bootstrap refusal");
    await expect(surface.initialize()).rejects.toThrow("Visualization execution was refused.");
    expect(native.createView).toHaveBeenCalledOnce();
    expect(await surface.retire(0)).toBe(true);
    const cancelled = f.create();
    expect(await cancelled.retire(0)).toBe(true);
    await expect(cancelled.initialize()).rejects.toThrow("Visualization execution was refused.");
    expect(native.createView).toHaveBeenCalledOnce();
  });

  it("stops startup when exact child destruction reentrantly retires its first native setter", async () => {
    const f = startupFixture(),
      surface = f.create();
    const callbacks = Reflect.get(surface, "callbacks");
    let retirement: Promise<boolean> | undefined;
    Reflect.set(callbacks, "onRevoked", () => {
      retirement = surface.retire(0);
    });
    f.view.setVisible.mockImplementationOnce(() => {
      f.contents.close();
    });
    await expect(surface.initialize()).rejects.toThrow("Visualization execution was refused.");
    expect(await retirement).toBe(true);
    expect(native.createClip).not.toHaveBeenCalled();
    expect(f.window.contentView.addChildView).not.toHaveBeenCalled();
    expect(f.contents.loadURL).not.toHaveBeenCalled();
    expect(surface.diagnostics()).toMatchObject({ phase: "retired", destroyed: true });
    expect(Reflect.get(surface, "sourceDocument")).toBeUndefined();
    expect(f.window.destroy).not.toHaveBeenCalled();
  });

  it("cannot register protocol or owner observers after a policy setter reentrantly retires its exact child", async () => {
    const f = startupFixture(),
      surface = f.create();
    const callbacks = Reflect.get(surface, "callbacks");
    let retirement: Promise<boolean> | undefined;
    Reflect.set(callbacks, "onRevoked", () => {
      retirement = surface.retire(0);
    });
    f.session.setPermissionRequestHandler.mockImplementationOnce(() => {
      f.contents.close();
    });
    await expect(surface.initialize()).rejects.toThrow("Visualization execution was refused.");
    expect(await retirement).toBe(true);
    expect(f.session.protocol.handle).not.toHaveBeenCalled();
    expect(f.session.setPermissionCheckHandler).not.toHaveBeenCalled();
    expect(f.window.listenerCount("closed")).toBe(0);
    expect(f.window.listenerCount("hide")).toBe(0);
    expect(f.window.listenerCount("minimize")).toBe(0);
    expect(f.contents.listenerCount("did-start-navigation")).toBe(0);
    expect(f.contents.listenerCount("focus")).toBe(0);
    expect(f.contents.loadURL).not.toHaveBeenCalled();
    expect(surface.diagnostics()).toMatchObject({ phase: "retired", destroyed: true });
    expect(Reflect.get(surface, "sourceDocument")).toBeUndefined();
    expect(Reflect.get(surface, "callbacks")).toBeUndefined();
    expect(f.window.destroy).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rolls back a protocol registration which completes after reentrant retirement (native throw: %s)",
    async (throws) => {
      const f = startupFixture(),
        surface = f.create();
      let registered = false;
      const callbacks = Reflect.get(surface, "callbacks");
      let retirement: Promise<boolean> | undefined;
      Reflect.set(callbacks, "onRevoked", () => {
        retirement = surface.retire(0);
      });
      f.session.protocol.unhandle.mockImplementation(() => {
        registered = false;
      });
      f.session.protocol.handle.mockImplementationOnce(() => {
        // The call is still in flight when exact teardown runs. Finish its
        // owned registration afterwards to prove late rollback, not a guessed
        // success from the retirement promise or an unrelated protocol owner.
        f.contents.close();
        registered = true;
        if (throws) throw new Error("synthetic post-registration refusal");
      });
      await expect(surface.initialize()).rejects.toThrow();
      expect(await retirement).toBe(true);
      expect(registered).toBe(false);
      expect(f.session.protocol.unhandle).toHaveBeenCalledTimes(2);
      expect(Reflect.get(surface, "protocolRegistered")).toBe(false);
      expect(f.window.listenerCount("closed")).toBe(0);
      expect(f.window.listenerCount("hide")).toBe(0);
      expect(f.contents.loadURL).not.toHaveBeenCalled();
      expect(surface.diagnostics()).toMatchObject({ phase: "retired", destroyed: true });
      expect(f.session.clearStorageData).toHaveBeenCalledOnce();
    },
  );

  it("removes an exact owner observer which finishes registering after reentrant retirement", async () => {
    const f = startupFixture(),
      surface = f.create();
    const callbacks = Reflect.get(surface, "callbacks");
    let retirement: Promise<boolean> | undefined;
    Reflect.set(callbacks, "onRevoked", () => {
      retirement = surface.retire(0);
    });
    const on = f.window.on;
    let destroyedDuringHide = false;
    vi.spyOn(f.window, "on").mockImplementation((event, listener) => {
      if (event === "hide" && !destroyedDuringHide) {
        destroyedDuringHide = true;
        f.contents.close();
      }
      return on.call(f.window, event, listener);
    });
    await expect(surface.initialize()).rejects.toThrow("Visualization execution was refused.");
    expect(await retirement).toBe(true);
    expect(destroyedDuringHide).toBe(true);
    for (const event of ["closed", "hide", "minimize"])
      expect(f.window.listenerCount(event)).toBe(0);
    expect(f.contents.loadURL).not.toHaveBeenCalled();
    expect(f.session.clearStorageData).toHaveBeenCalledOnce();
    expect(surface.diagnostics()).toMatchObject({ phase: "retired", destroyed: true });
  });
});

function exclusive(peer: object) {
  const source = {
    document: {
      kind: "generated",
      html: "<p>inert test</p>",
      assets: [],
      width: 400,
      height: 200,
      appearance: "light",
    },
    preloadPath: "unlaunched-test",
    window: {} as Electron.BrowserWindow,
    bounds: { x: 0, y: 0, width: 400, height: 200 },
    onMessage: () => {},
    onRevoked: () => {},
  } satisfies VisualizationSurfaceOptions;
  const surface = new ElectronVisualizationSurface(source);
  const own = {
    getOSProcessId: () => 123,
    mainFrame: { frameToken: "fixture-frame", framesInSubtree: [{ osProcessId: 123 }] },
  };
  Reflect.set(surface, "view", { webContents: own });
  native.inventory.mockReturnValue([own, peer]);
  const inspect = surface as unknown as { processesAreExclusive(retirement?: boolean): boolean };
  return {
    surface,
    own,
    inspect: (retirement = false) => inspect.processesAreExclusive(retirement),
  };
}

describe("native visualization peer inventory", () => {
  it("binds natural layout to exact nonce/frame/sequence and finite native-visible owner geometry", () => {
    const onLayout = vi.fn(),
      frame = {} as Electron.WebFrameMain;
    let zoom = 1.3;
    const surface = new ElectronVisualizationSurface({
      document: {
        kind: "generated",
        html: "<section>Natural content</section>",
        assets: [],
        width: 400,
        height: 200,
        appearance: "light",
      },
      preloadPath: "unlaunched",
      window: {} as Electron.BrowserWindow,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      onLayout,
      onMessage: () => {},
      onRevoked: () => {},
    });
    Reflect.set(surface, "isCurrent", () => true);
    Reflect.set(surface, "view", { webContents: { mainFrame: frame } });
    Reflect.set(surface, "window", { webContents: { getZoomFactor: () => zoom } });
    Reflect.set(surface, "visibilityCommitted", true);
    Reflect.set(surface, "observedVisibility", () => "visible");
    const receive = (raw: unknown, sender = frame) =>
      (
        surface as unknown as { receiveLayout(frame: Electron.WebFrameMain, raw: unknown): void }
      ).receiveLayout(sender, raw);
    const nonce = Reflect.get(surface, "layoutNonce");
    const value = { nonce, contextEpoch: 1, sequence: 1, height: 420, constrained: false };
    receive({ ...value, nonce: "foreign" });
    receive(value, {} as Electron.WebFrameMain);
    receive({ ...value, height: Infinity });
    receive({ ...value, sequence: 2 });
    expect(onLayout).not.toHaveBeenCalled();
    receive(value);
    expect(onLayout).toHaveBeenLastCalledWith({ height: 324, constrained: false, sequence: 1 });
    receive(value);
    expect(onLayout).toHaveBeenCalledOnce();
    receive({ ...value, sequence: 2, height: 2000 });
    expect(onLayout).toHaveBeenLastCalledWith({ height: 1538, constrained: true, sequence: 2 });
    zoom = 0.8;
    receive({ ...value, sequence: 3 });
    expect(onLayout).toHaveBeenLastCalledWith({ height: 525, constrained: false, sequence: 3 });
    Reflect.set(surface, "observedVisibility", () => "hidden");
    receive({ ...value, sequence: 4 });
    expect(onLayout).toHaveBeenCalledTimes(3);
    Reflect.set(surface, "observedVisibility", () => "visible");
    for (let sequence = 5; sequence < 10; sequence++) receive({ ...value, sequence });
    expect(onLayout).toHaveBeenCalledTimes(3);
    expect(surface.diagnostics()).toMatchObject({
      layoutHeight: 525,
      layoutConstrained: false,
      layoutSequence: 3,
      layoutPublications: 3,
      layoutRefusal: "rate",
    });
    Reflect.set(surface, "sourceDocument", { kind: "mcp-app" });
    receive({ ...value, sequence: 10 });
    expect(onLayout).toHaveBeenCalledTimes(3);
    expect(surface.diagnostics().layoutRefusal).toBe("owner");
  });
  it.each(["generated", "mcp-app"] as const)(
    "assembles the fixed library only before generated source, not %s authority",
    async (kind) => {
      // This isolated assembly fixture does not qualify native admission or GPU
      // execution. Exact source/privacy/process gates retain their own tests.
      const html = "<canvas data-cafe-fluid></canvas><p>Immutable source sentinel</p>";
      const surface = new ElectronVisualizationSurface({
        document: { kind, html, assets: [], width: 400, height: 200, appearance: "light" },
        preloadPath: "unlaunched-test",
        window: {} as Electron.BrowserWindow,
        bounds: { x: 0, y: 0, width: 400, height: 200 },
        onMessage: () => {},
        onRevoked: () => {},
      });
      let installed = "";
      Reflect.set(surface, "isCurrent", () => true);
      Reflect.set(surface, "view", {
        getBounds: () => ({ width: 400, height: 200 }),
        webContents: {
          insertCSS: vi.fn(async () => "fixed-test-style"),
          send: (_channel: string, payload: { html: string }) => {
            installed = payload.html;
            (Reflect.get(surface, "installation") as { resolve: () => void }).resolve();
          },
        },
      });
      await surface.installSource();
      expect(installed.endsWith(html)).toBe(true);
      expect(installed.includes(VISUALIZATION_FLUID_RUNTIME_SOURCE)).toBe(kind === "generated");
      expect(installed).toContain('data-cafe-visible="false"');
      expect(installed).toContain('data-cafe-reduced-motion="false"');
      expect(installed.includes(GENERATED_VISUALIZATION_FONT_FAMILY_STYLE)).toBe(
        kind === "generated",
      );
      const contents = Reflect.get(surface, "view").webContents;
      expect(contents.insertCSS).toHaveBeenCalledTimes(kind === "generated" ? 1 : 0);
      if (kind === "generated")
        expect(contents.insertCSS).toHaveBeenCalledExactlyOnceWith(
          GENERATED_VISUALIZATION_FONT_FAMILY_STYLE,
          { cssOrigin: "user" },
        );
    },
  );
  it("fences generated fixed-style readiness against retirement and a concurrent source replacement", async () => {
    const f = visibilityFixture();
    let resolve!: (key: string) => void;
    const ready = new Promise<string>((value) => (resolve = value));
    const contents = Reflect.get(f.surface, "view").webContents;
    contents.insertCSS = vi.fn(() => ready);
    const pending = f.surface.installSource();
    await expect(f.surface.installSource()).rejects.toThrow("Visualization execution was refused.");
    f.revoke();
    resolve("fixed-style");
    await expect(pending).rejects.toThrow("Visualization execution was refused.");
    expect(f.sent.filter((value) => value.kind === "install")).toHaveLength(0);
    expect(contents.insertCSS).toHaveBeenCalledOnce();
  });
  it("never parses source when fixed generated user-style installation fails", async () => {
    const f = visibilityFixture();
    const contents = Reflect.get(f.surface, "view").webContents;
    contents.insertCSS = vi.fn(async () => {
      throw new Error("fixed native style refused");
    });
    await expect(f.surface.installSource()).rejects.toThrow("fixed native style refused");
    expect(f.sent.filter((value) => value.kind === "install")).toHaveLength(0);
    await expect(f.surface.installSource()).rejects.toThrow("Visualization execution was refused.");
  });
  it("drops private source/callback references when an inert never-created owner retires", async () => {
    const source = {
      kind: "generated",
      html: "private source sentinel",
      assets: [],
      width: 400,
      height: 200,
      appearance: "light",
    } as const;
    const surface = new ElectronVisualizationSurface({
      document: { ...source, assets: [] },
      preloadPath: "inert",
      window: {} as Electron.BrowserWindow,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      onMessage: () => {},
      onRevoked: () => {},
    });
    expect(Reflect.get(surface, "sourceDocument")).toMatchObject({ html: source.html });
    expect(await surface.retire()).toBe(true);
    expect(Reflect.get(surface, "sourceDocument")).toBeUndefined();
    expect(Reflect.get(surface, "callbacks")).toBeUndefined();
    expect(Reflect.get(surface, "options")).not.toHaveProperty("document");
  });
  it("refuses an unreadable live peer rather than infer an empty inventory", () => {
    const peer = {
      isDestroyed: () => false,
      getOSProcessId: () => 456,
      get mainFrame(): never {
        throw new Error("unknown native inventory");
      },
    };
    expect(exclusive(peer).inspect()).toBe(false);
    expect(
      exclusive({
        isDestroyed: () => false,
        getOSProcessId: () => {
          throw new Error("unknown process");
        },
      }).inspect(),
    ).toBe(false);
  });
  it("omits only positive destroyed or complete native not-started evidence", () => {
    expect(
      exclusive({
        isDestroyed: () => true,
        get mainFrame(): never {
          throw new Error("destroyed");
        },
      }).inspect(),
    ).toBe(true);
    expect(
      exclusive({
        isDestroyed: () => false,
        getOSProcessId: () => 0,
        mainFrame: { framesInSubtree: [{ osProcessId: 0 }] },
      }).inspect(),
    ).toBe(true);
    for (const processId of [0, -1, NaN, 1.5]) {
      expect(
        exclusive({
          isDestroyed: () => false,
          getOSProcessId: () => 456,
          mainFrame: { framesInSubtree: [{ osProcessId: processId }] },
        }).inspect(),
      ).toBe(false);
    }
  });
  it("never leaves successful exclusivity diagnostics after a later unknown peer", () => {
    let pid = 456;
    const peer = {
      isDestroyed: () => false,
      getOSProcessId: () => pid,
      mainFrame: { framesInSubtree: [{ osProcessId: 456 }] },
    };
    const value = exclusive(peer);
    expect(value.inspect()).toBe(true);
    expect(value.surface.diagnostics().exclusiveProcess).toBe(true);
    pid = 0;
    expect(value.inspect()).toBe(false);
    expect(value.surface.diagnostics().exclusiveProcess).toBe(false);
  });
  it("refuses an exclusive replacement renderer or frame as retirement authority", () => {
    const value = exclusive({ isDestroyed: () => true });
    Reflect.set(value.surface, "rendererPid", 123);
    Reflect.set(value.surface, "rootToken", "fixture-frame");
    expect(value.inspect(true)).toBe(true);
    value.own.mainFrame.frameToken = "replacement";
    expect(value.inspect(true)).toBe(false);
    value.own.mainFrame.frameToken = "fixture-frame";
    value.own.mainFrame.framesInSubtree[0]!.osProcessId = 124;
    expect(value.inspect(true)).toBe(false);
  });
});

/** The native visibility API is separate from source/process admission. These
 * doubles retain that ordering; the opt-in fixture observes the actual View. */
function visibilityFixture(preview = false) {
  const { surface } = exclusive({ isDestroyed: () => true });
  Reflect.set(surface, "previewWindow", preview);
  let current = true;
  vi.spyOn(surface, "isCurrent").mockImplementation(() => current);
  let bounds = { x: 0, y: 0, width: 400, height: 200 };
  let clip = bounds;
  let showing = false;
  const onLayout = vi.fn();
  const callbacks = Reflect.get(surface, "callbacks") as object;
  Reflect.set(callbacks, "onLayout", onLayout);
  const visible = vi.fn((value: boolean) => {
    showing = value;
  });
  const sent: { kind: string; html?: string; visible?: boolean }[] = [];
  const setClipBounds = vi.fn((value: typeof bounds) => {
    clip = value;
  });
  const borderRadius = vi.fn();
  const childBounds = vi.fn((value: typeof bounds) => {
    bounds = value;
  });
  let ownerZoom = 1;
  const contents = {
    isDestroyed: () => false,
    getOSProcessId: () => 123,
    mainFrame: {
      url: `cafe-visualization://${surface.generation}/bootstrap`,
      frameToken: "fixture-visibility-frame",
      osProcessId: 123,
      detached: false,
      isDestroyed: () => false,
    },
    loadURL: async () => {},
    insertCSS: vi.fn(async () => "fixed-visibility-style"),
    setBackgroundThrottling: vi.fn(),
    send: (_channel: string, value: { kind: string; html?: string; visible?: boolean }) => {
      sent.push(value);
      if (value.kind !== "install") return;
      const installation = Reflect.get(surface, "installation") as { resolve(): void };
      Reflect.set(surface, "installation", undefined);
      installation.resolve();
    },
  };
  Reflect.set(surface, "view", {
    webContents: contents,
    setVisible: visible,
    getVisible: () => showing,
    getBounds: () => bounds,
    setBounds: childBounds,
  });
  Reflect.set(surface, "clippingView", {
    setVisible: vi.fn(),
    getVisible: () => showing,
    setBounds: setClipBounds,
    getBounds: () => clip,
    setBorderRadius: borderRadius,
  });
  Reflect.set(surface, "window", {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentSize: () => [640, 480],
    webContents: { getZoomFactor: () => ownerZoom, isDestroyed: () => false },
  });
  const internals = surface as unknown as {
    createNativeSurface(): void;
    processesAreExclusive(): boolean;
  };
  vi.spyOn(internals, "createNativeSurface").mockImplementation(() => {});
  vi.spyOn(internals, "processesAreExclusive").mockReturnValue(true);
  return {
    surface,
    onLayout,
    receiveLayout: (value: unknown) =>
      (surface as unknown as { receiveLayout(frame: unknown, value: unknown): void }).receiveLayout(
        contents.mainFrame,
        value,
      ),
    visible,
    sent,
    bounds,
    setClipBounds,
    borderRadius,
    childBounds,
    setZoom: (value: number) => {
      ownerZoom = value;
    },
    initializeMask: (full: typeof bounds, visibleClip: typeof bounds) =>
      (
        surface as unknown as {
          applyGeometry(full: typeof bounds, clip: typeof bounds, initialize: boolean): boolean;
        }
      ).applyGeometry(full, visibleClip, true),
    revoke: () => (current = false),
  };
}

describe("native visualization visibility commit", () => {
  it("never grants font-ready parsing after native revocation or uncertain currentness even without delivered cancellation", async () => {
    for (const revoked of [true, false]) {
      const f = visibilityFixture(),
        contents = Reflect.get(f.surface, "view").webContents;
      Reflect.set(f.surface, "admitted", true);
      Reflect.set(f.surface, "rendererPid", 123);
      Reflect.set(f.surface, "rootToken", contents.mainFrame.frameToken);
      Reflect.set(f.surface, "sourceInstallationStarted", true);
      Reflect.set(f.surface, "installation", { resolve: vi.fn(), reject: vi.fn() });
      Reflect.set(f.surface, "revoked", revoked);
      if (!revoked) f.revoke();
      const nonce = Reflect.get(f.surface, "fontInstallationNonce");
      const gate = new GeneratedVisualizationFontCommit(nonce),
        replace = vi.fn(),
        refuse = vi.fn();
      let current = true;
      const operation = installFontReadyGeneratedDocument(
        async () => [],
        () => current,
        () =>
          gate.request((value) =>
            Reflect.get(f.surface, "receiveGeneratedFontReadiness").call(
              f.surface,
              contents.mainFrame,
              { nonce: value },
            ),
          ),
        replace,
        refuse,
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(f.sent.filter((value) => value.kind === "commit-install")).toHaveLength(0);
      expect(replace).not.toHaveBeenCalled();
      // No cancel delivery was needed for the native refusal. End this inert
      // fixture-owned waiter only after proving zero parsing/readmission.
      current = false;
      gate.cancel();
      await operation;
      expect(replace).not.toHaveBeenCalled();
      expect(refuse).not.toHaveBeenCalled();
    }
  });
  it("grants one pending generated font commit only for the exact nonce/current PID/frame", () => {
    const f = visibilityFixture(),
      contents = Reflect.get(f.surface, "view").webContents;
    Reflect.set(f.surface, "admitted", true);
    Reflect.set(f.surface, "rendererPid", 123);
    Reflect.set(f.surface, "rootToken", contents.mainFrame.frameToken);
    Reflect.set(f.surface, "sourceInstallationStarted", true);
    const callbacks = Reflect.get(f.surface, "callbacks");
    const admission = vi.fn(() => true);
    Reflect.set(callbacks, "admitGeneratedSource", admission);
    const pending = { resolve: vi.fn(), reject: vi.fn() };
    Reflect.set(f.surface, "installation", pending);
    const nonce = Reflect.get(f.surface, "fontInstallationNonce");
    const ready = (raw: unknown, sender: unknown = contents.mainFrame) =>
      Reflect.get(f.surface, "receiveGeneratedFontReadiness").call(f.surface, sender, raw);
    for (const raw of [null, [], { nonce: "foreign" }, { nonce, source: "private" }]) ready(raw);
    ready({ nonce }, null);
    ready({ nonce }, {});
    contents.mainFrame.osProcessId = 999;
    ready({ nonce });
    contents.mainFrame.osProcessId = 123;
    contents.mainFrame.frameToken = "foreign";
    ready({ nonce });
    contents.mainFrame.frameToken = "fixture-visibility-frame";
    Reflect.set(f.surface, "sourceDocument", { kind: "mcp-app" });
    ready({ nonce });
    Reflect.set(f.surface, "sourceDocument", { kind: "generated" });
    Reflect.set(f.surface, "installation", undefined);
    ready({ nonce });
    Reflect.set(f.surface, "installation", pending);
    Reflect.set(f.surface, "sourceInstallationAcknowledged", true);
    ready({ nonce });
    Reflect.set(f.surface, "sourceInstallationAcknowledged", false);
    Reflect.set(callbacks, "admitGeneratedSource", undefined);
    ready({ nonce });
    Reflect.set(callbacks, "admitGeneratedSource", () => false);
    ready({ nonce });
    Reflect.set(callbacks, "admitGeneratedSource", () => {
      throw new Error("uncertain owner");
    });
    ready({ nonce });
    Reflect.set(callbacks, "admitGeneratedSource", admission);
    expect(f.sent).toHaveLength(0);
    ready({ nonce });
    ready({ nonce });
    expect(f.sent).toEqual([{ kind: "commit-install", nonce }]);
    expect(admission).toHaveBeenCalledOnce();
    expect(pending.resolve).not.toHaveBeenCalled();
  });
  it("requires the generated one-shot commit before successful source ACK without changing Apps", () => {
    for (const kind of ["generated", "mcp-app"] as const) {
      for (const granted of [false, true]) {
        const f = visibilityFixture(),
          contents = Reflect.get(f.surface, "view").webContents;
        Reflect.set(f.surface, "sourceDocument", { kind });
        Reflect.set(f.surface, "fontCommitGranted", granted);
        const pending = { resolve: vi.fn(), reject: vi.fn() };
        Reflect.set(f.surface, "installation", pending);
        const acknowledge = Reflect.get(f.surface, "receiveInstallationAcknowledgement");
        acknowledge.call(f.surface, {}, true);
        expect(pending.resolve).not.toHaveBeenCalled();
        expect(pending.reject).not.toHaveBeenCalled();
        acknowledge.call(f.surface, contents.mainFrame, true);
        const permitted = kind === "mcp-app" || granted;
        expect(pending.resolve).toHaveBeenCalledTimes(permitted ? 1 : 0);
        expect(pending.reject).toHaveBeenCalledTimes(permitted ? 0 : 1);
        expect(Reflect.get(f.surface, "sourceInstallationAcknowledged")).toBe(permitted);
        acknowledge.call(f.surface, contents.mainFrame, true);
        expect(pending.resolve).toHaveBeenCalledTimes(permitted ? 1 : 0);
      }
    }
  });
  it("terminally cancels late generated readiness even when uncertain native retirement retains the live child", async () => {
    const f = visibilityFixture();
    const view = Reflect.get(f.surface, "view"),
      contents = view.webContents;
    const clipping = Reflect.get(f.surface, "clippingView"),
      window = Reflect.get(f.surface, "window");
    clipping.removeChildView = vi.fn();
    window.contentView = { removeChildView: vi.fn() };
    window.removeListener = vi.fn();
    window.webContents.isDestroyed = () => false;
    window.webContents.removeListener = vi.fn();
    contents.forcefullyCrashRenderer = vi.fn();
    contents.close = vi.fn();
    Reflect.set(f.surface, "admitted", true);
    Reflect.set(f.surface, "rendererPid", 123);
    Reflect.set(f.surface, "rootToken", contents.mainFrame.frameToken);
    Reflect.set(f.surface, "processesAreExclusive", () => false);
    let resolve!: (faces: readonly FontFace[]) => void;
    const fonts = new Promise<readonly FontFace[]>((ready) => (resolve = ready));
    let cancelled = false,
      pendingReadiness: Promise<void> | undefined;
    const replace = vi.fn(),
      refuse = vi.fn();
    contents.send = (_channel: string, raw: { kind: string }) => {
      f.sent.push(raw);
      if (raw.kind === "install")
        pendingReadiness = installFontReadyGeneratedDocument(
          () => fonts,
          () => !cancelled,
          async () => true,
          replace,
          refuse,
        );
      else if (cancelsPendingGeneratedFontInstall(raw, pendingReadiness !== undefined))
        cancelled = true;
    };
    const installation = f.surface.installSource();
    const refused = expect(installation).rejects.toThrow("Visualization execution was refused.");
    await Promise.resolve();
    expect(pendingReadiness).toBeDefined();
    expect(await f.surface.retire(0)).toBe(false);
    await refused;
    expect(f.surface.diagnostics()).toMatchObject({
      phase: "quarantined",
      gone: false,
      destroyed: false,
    });
    expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    expect(contents.close).not.toHaveBeenCalled();
    expect(f.sent.filter((value) => value.kind === "cancel-install")).toEqual([
      { kind: "cancel-install" },
    ]);
    resolve([]);
    await pendingReadiness;
    expect(replace).not.toHaveBeenCalled();
    expect(refuse).not.toHaveBeenCalled();
  });
  it("sends pending cancellation only to the exact generated frame, never Apps, replacements or acknowledged source", () => {
    const f = visibilityFixture(),
      contents = Reflect.get(f.surface, "view").webContents;
    Reflect.set(f.surface, "admitted", true);
    Reflect.set(f.surface, "rendererPid", 123);
    Reflect.set(f.surface, "rootToken", contents.mainFrame.frameToken);
    Reflect.set(f.surface, "sourceInstallationStarted", true);
    const cancel = () =>
      Reflect.get(f.surface, "cancelPendingGeneratedInstallation").call(f.surface);
    contents.mainFrame.frameToken = "replacement";
    cancel();
    expect(f.sent).toHaveLength(0);
    contents.mainFrame.frameToken = "fixture-visibility-frame";
    Reflect.set(f.surface, "sourceDocument", { kind: "mcp-app" });
    cancel();
    expect(f.sent).toHaveLength(0);
    Reflect.set(f.surface, "sourceDocument", { kind: "generated" });
    Reflect.set(f.surface, "sourceInstallationAcknowledged", true);
    cancel();
    expect(f.sent).toHaveLength(0);
    Reflect.set(f.surface, "sourceInstallationAcknowledged", false);
    cancel();
    expect(f.sent).toEqual([{ kind: "cancel-install" }]);
  });
  it("refuses a layout delivered after paint hide and admits only its fresh continuing resume sequence", () => {
    const f = visibilityFixture();
    expect(f.surface.update(f.bounds, "light")).toBe(true);
    const nonce = Reflect.get(f.surface, "layoutNonce");
    const initial = { nonce, contextEpoch: 1, sequence: 1, height: 420, constrained: false };
    f.receiveLayout(initial);
    expect(f.onLayout).toHaveBeenLastCalledWith({ height: 420, constrained: false, sequence: 1 });
    expect(f.surface.hidePresentation(f.bounds)).toBe(true);
    f.receiveLayout({ ...initial, sequence: 2, height: 450 });
    expect(f.onLayout).toHaveBeenCalledOnce();
    expect(f.surface.diagnostics().layoutRefusal).toBe("visibility");
    expect(f.surface.update(f.bounds, "light")).toBe(true);
    f.receiveLayout({ ...initial, sequence: 2, height: 450 });
    expect(f.onLayout).toHaveBeenCalledOnce();
    expect(f.surface.diagnostics().layoutRefusal).toBe("invalid");
    f.receiveLayout({ ...initial, sequence: 3, height: 450 });
    expect(f.onLayout).toHaveBeenLastCalledWith({ height: 450, constrained: false, sequence: 2 });
    expect(f.onLayout).toHaveBeenCalledTimes(2);
  });
  it("publishes initial and changed generated visibility without replaying unchanged partial geometry", async () => {
    const f = visibilityFixture();
    await f.surface.installSource();
    const hints = () => f.sent.filter((value) => value.kind === "visibility");
    const paintHints = () => f.sent.filter((value) => value.kind === "presentation-visibility");
    expect(hints()).toEqual([{ kind: "visibility", visible: false }]);
    expect(paintHints()).toEqual([{ kind: "presentation-visibility", visible: false }]);
    for (let height = 40; height <= 200; height += 20)
      expect(
        f.surface.update(f.bounds, "light", undefined, "inline", { ...f.bounds, height }),
      ).toBe(true);
    expect(hints()).toEqual([
      { kind: "visibility", visible: false },
      { kind: "visibility", visible: true },
    ]);
    expect(f.surface.hidePresentation(f.bounds)).toBe(true);
    expect(f.surface.hidePresentation(f.bounds)).toBe(true);
    expect(f.surface.update(f.bounds, "light")).toBe(true);
    expect(hints().map((value) => value.visible)).toEqual([false, true]);
    expect(paintHints().map((value) => value.visible)).toEqual([false, true, false, true]);
    // A real suspension/transition is not a qualified positive presentation
    // hide. Retain its original logical false/true semantics for the author.
    expect(f.surface.suspend(true)).toBe(true);
    expect(f.surface.suspend(false)).toBe(true);
    expect(hints().map((value) => value.visible)).toEqual([false, true, false, true]);
    // Apps have separate SDK/manual consent semantics, unchanged by generated
    // entrance de-duplication, even for repeated ordinary geometry updates.
    Reflect.set(f.surface, "sourceDocument", { kind: "mcp-app" });
    const paintCount = paintHints().length;
    expect(f.surface.update(f.bounds, "light")).toBe(true);
    expect(f.surface.update(f.bounds, "light")).toBe(true);
    expect(
      hints()
        .slice(-2)
        .map((value) => value.visible),
    ).toEqual([true, true]);
    expect(paintHints()).toHaveLength(paintCount);
  });
  it("hides a tiny positive generated crop without installing an unmasked slice or replacing the document", () => {
    const f = visibilityFixture();
    expect(f.surface.update(f.bounds, "dark")).toBe(true);
    const generation = f.surface.generation;
    f.setClipBounds.mockClear();
    f.childBounds.mockClear();
    expect(
      f.surface.update(f.bounds, "dark", undefined, "inline", { ...f.bounds, height: 20 }),
    ).toBe(true);
    expect(f.surface.isPresentationHidden()).toBe(true);
    expect(f.sent.at(-1)).toEqual({ kind: "presentation-visibility", visible: false });
    expect(f.sent.filter((value) => value.kind === "visibility").at(-1)).toEqual({
      kind: "visibility",
      visible: true,
    });
    expect(f.setClipBounds).not.toHaveBeenCalled();
    expect(f.childBounds).not.toHaveBeenCalled();
    expect(f.surface.suspend(false)).toBe(true);
    expect(f.visible).toHaveBeenLastCalledWith(false);
    expect(f.surface.update(f.bounds, "light")).toBe(true);
    expect(f.surface.isPresentationHidden()).toBe(false);
    expect(f.surface.generation).toBe(generation);
    expect(f.sent.at(-1)).toEqual({ kind: "presentation-visibility", visible: true });
    expect(f.surface.hidePresentation({ ...f.bounds, x: 700 })).toBe(false);
    f.revoke();
    expect(f.surface.hidePresentation(f.bounds)).toBe(false);
    const preview = visibilityFixture(true);
    expect(preview.surface.hidePresentation(preview.bounds)).toBe(false);
  });
  it("commits only exact positive generated logical geometry on a first hidden presentation", async () => {
    const f = visibilityFixture();
    await f.surface.installSource();
    expect(f.surface.hidePresentation({ ...f.bounds, x: 700 })).toBe(false);
    expect(f.surface.diagnostics().visibilityCommitted).toBe(false);
    expect(f.surface.hidePresentation(f.bounds, { ...f.bounds, height: 20 })).toBe(true);
    expect(f.surface.diagnostics()).toMatchObject({
      visibilityCommitted: true,
      nativeVisibility: "hidden",
      visibilityHintSent: "visible",
    });
    expect(f.sent.filter((value) => value.kind === "visibility")).toEqual([
      { kind: "visibility", visible: false },
      { kind: "visibility", visible: true },
    ]);
    expect(f.sent.filter((value) => value.kind === "presentation-visibility")).toEqual([
      { kind: "presentation-visibility", visible: false },
    ]);
    expect(f.visible).not.toHaveBeenCalledWith(true);
  });
  it("does not reinterpret a native geometry exception as a retain-hidden positive crop", () => {
    const f = visibilityFixture();
    f.setClipBounds.mockImplementation(() => {
      throw new Error("opaque native bounds failure");
    });
    expect(f.surface.update(f.bounds, "dark")).toBe(false);
    expect(f.surface.isPresentationHidden()).toBe(false);
    expect(f.visible).not.toHaveBeenCalledWith(true);
  });
  it("remaps admitted natural height on owner zoom alone without guest sequence or document renewal", () => {
    const f = visibilityFixture();
    f.setZoom(0.8);
    f.surface.update(f.bounds, "light");
    const nonce = Reflect.get(f.surface, "layoutNonce");
    f.receiveLayout({ nonce, contextEpoch: 1, sequence: 1, height: 420, constrained: false });
    expect(f.onLayout).toHaveBeenLastCalledWith({ height: 525, constrained: false, sequence: 1 });
    f.setZoom(1.3);
    expect(f.surface.update(f.bounds, "light")).toBe(true);
    expect(f.onLayout).toHaveBeenLastCalledWith({ height: 324, constrained: false, sequence: 2 });
    f.surface.update(f.bounds, "dark");
    expect(f.onLayout).toHaveBeenCalledTimes(2);
    f.receiveLayout({ nonce, contextEpoch: 1, sequence: 2, height: 430, constrained: false });
    expect(f.onLayout).toHaveBeenLastCalledWith({ height: 331, constrained: false, sequence: 3 });
    f.revoke();
    f.setZoom(0.8);
    expect(f.surface.update(f.bounds, "light")).toBe(false);
    expect(f.onLayout).toHaveBeenCalledTimes(3);
  });
  it("refuses delayed fullscreen layout without consuming the fresh inline context sequence", () => {
    const f = visibilityFixture();
    f.surface.update(f.bounds, "light");
    const nonce = Reflect.get(f.surface, "layoutNonce");
    f.receiveLayout({ nonce, contextEpoch: 1, sequence: 1, height: 420, constrained: false });
    f.surface.update(f.bounds, "light", undefined, "fullscreen");
    f.receiveLayout({ nonce, contextEpoch: 2, sequence: 1, height: 1900, constrained: false });
    expect(f.onLayout).toHaveBeenCalledOnce();
    f.surface.update(f.bounds, "light", undefined, "inline");
    f.receiveLayout({ nonce, contextEpoch: 2, sequence: 1, height: 1900, constrained: false });
    expect(f.onLayout).toHaveBeenCalledOnce();
    f.receiveLayout({ nonce, contextEpoch: 3, sequence: 1, height: 430, constrained: false });
    expect(f.onLayout).toHaveBeenLastCalledWith({ height: 430, constrained: false, sequence: 2 });
    f.receiveLayout({ nonce, contextEpoch: 3, sequence: 1, height: 430, constrained: false });
    expect(f.onLayout).toHaveBeenCalledTimes(2);
  });
  it("provides synchronous initial false and exact native visibility without claiming previews visible", async () => {
    const value = visibilityFixture();
    await value.surface.installSource();
    expect(value.sent.find((message) => message.kind === "install")?.html).toContain(
      'data-cafe-visible="false"',
    );
    expect(value.sent.find((message) => message.kind === "install")?.html).toContain(
      'data-cafe-presentation-visible="false"',
    );
    expect(value.sent.at(-1)).toEqual({ kind: "presentation-visibility", visible: false });
    value.surface.update({ x: 0, y: 0, width: 400, height: 200 }, "light");
    expect(value.sent.at(-1)).toEqual({ kind: "presentation-visibility", visible: true });
    expect(value.surface.diagnostics()).toMatchObject({
      nativeVisibility: "visible",
      visibilityHintSent: "visible",
      visibilityCommitted: true,
    });
    value.surface.suspend(true);
    expect(value.sent.at(-1)).toEqual({ kind: "presentation-visibility", visible: false });
    expect(value.surface.diagnostics()).toMatchObject({
      nativeVisibility: "hidden",
      visibilityHintSent: "hidden",
      visibilityCommitted: true,
    });
    value.revoke();
    expect(value.surface.suspend(false)).toBe(false);
    expect(value.sent.at(-1)).toEqual({ kind: "presentation-visibility", visible: false });
    expect(value.sent.filter((message) => message.kind === "visibility").at(-1)).toEqual({
      kind: "visibility",
      visible: false,
    });
    const preview = visibilityFixture(true);
    await preview.surface.installSource();
    expect(preview.visible).toHaveBeenLastCalledWith(true);
    expect(preview.sent.at(-1)).toEqual({ kind: "visibility", visible: false });
  });
  it("materializes the supported mask layer once and preserves full child viewport on later clipping", () => {
    const value = visibilityFixture();
    const full = { x: 20, y: -100, width: 400, height: 400 };
    const clip = { x: 20, y: 40, width: 300, height: 200 };
    expect(value.initializeMask(full, clip)).toBe(true);
    expect(value.setClipBounds).toHaveBeenLastCalledWith(clip, { animate: { duration: 0 } });
    expect(value.borderRadius).toHaveBeenCalledExactlyOnceWith(1);
    expect(value.childBounds).toHaveBeenLastCalledWith({ x: 0, y: -140, width: 400, height: 400 });
    expect(
      value.surface.update(full, "light", undefined, undefined, { ...clip, height: 100 }),
    ).toBe(true);
    expect(value.setClipBounds).toHaveBeenLastCalledWith({ ...clip, height: 100 });
    expect(value.childBounds).toHaveBeenLastCalledWith({ x: 0, y: -140, width: 400, height: 400 });
    expect(value.borderRadius).toHaveBeenCalledTimes(1);
    expect(value.surface.diagnostics()).toMatchObject({
      geometryOutcome: "partial",
      viewportWidth: 400,
      viewportHeight: 400,
      clipWidth: 300,
      clipHeight: 100,
      ownerZoom: 1,
    });
    value.setZoom(1.3);
    expect(value.surface.update(full, "light", undefined, undefined, clip)).toBe(true);
    expect(value.childBounds).toHaveBeenLastCalledWith({ x: 0, y: -182, width: 520, height: 520 });
    expect(value.surface.diagnostics().ownerZoom).toBe(1.3);
  });
  it("never commits exposure for a tiny cleared-mask slice or unknown owner zoom", () => {
    const value = visibilityFixture();
    expect(
      value.surface.update(value.bounds, "light", undefined, undefined, {
        ...value.bounds,
        height: 31,
      }),
    ).toBe(true);
    expect(value.surface.isPresentationHidden()).toBe(true);
    value.setZoom(NaN);
    expect(value.surface.update(value.bounds, "light")).toBe(false);
    expect(value.visible).not.toHaveBeenCalledWith(true);
    expect(value.surface.diagnostics().geometryOutcome).toBe("refused");
  });
  it("keeps native bootstrap and installed source hidden until trusted geometry commits exposure", async () => {
    vi.useFakeTimers();
    try {
      const value = visibilityFixture();
      await value.surface.initialize();
      await value.surface.installSource();
      expect(value.visible).not.toHaveBeenCalledWith(true);
      expect(value.surface.suspend(true)).toBe(true);
      expect(value.surface.suspend(false)).toBe(true);
      expect(value.visible).not.toHaveBeenCalledWith(true);
      expect(value.surface.update(value.bounds, "light")).toBe(true);
      expect(value.visible).toHaveBeenLastCalledWith(true);
      expect(value.surface.suspend(true)).toBe(true);
      expect(value.surface.update(value.bounds, "dark")).toBe(true);
      expect(value.visible).toHaveBeenLastCalledWith(false);
      expect(value.surface.suspend(false)).toBe(true);
      expect(value.visible).toHaveBeenLastCalledWith(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it("cannot reveal a revoked uncommitted document through a delayed geometry or resume", async () => {
    vi.useFakeTimers();
    try {
      const value = visibilityFixture();
      await value.surface.initialize();
      await value.surface.installSource();
      value.revoke();
      expect(value.surface.update(value.bounds, "light")).toBe(false);
      expect(value.surface.suspend(false)).toBe(false);
      expect(value.visible).not.toHaveBeenCalledWith(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it("preserves the separate private offscreen preview exposure", async () => {
    vi.useFakeTimers();
    try {
      const value = visibilityFixture(true);
      await value.surface.initialize();
      expect(value.visible).not.toHaveBeenCalledWith(true);
      await value.surface.installSource();
      expect(value.visible).toHaveBeenLastCalledWith(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

/** Pure native API doubles prove refusal ordering and immutable tuple binding.
 * Actual native pixels/DPR remain qualified by the isolated Electron fixture. */
function captureFixture(preview = false) {
  // Select the real constructor role, rather than changing a private boolean
  // after construction and accidentally qualifying another viewer fixture.
  const surface = new ElectronVisualizationSurface({
    document: {
      kind: "generated",
      html: "<p>inert capture fixture</p>",
      assets: [],
      width: 600,
      height: 400,
      appearance: "light",
    },
    preloadPath: "unlaunched capture preload",
    window: preview ? null : ({} as Electron.BrowserWindow),
    bounds: { x: 0, y: 0, width: 600, height: 400 },
    onMessage: () => {},
    onRevoked: () => {},
  });
  vi.spyOn(surface, "isCurrent").mockReturnValue(true);
  let bounds = { x: 0, y: 0, width: 600, height: 400 };
  let ownerZoom = 1;
  const normalized = {
    isEmpty: () => false,
    getSize: () => ({ width: 600, height: 400 }),
    toPNG: vi.fn(() => Buffer.from([1, 2, 3])),
  };
  const image = {
    isEmpty: () => false,
    getSize: () => (preview ? { width: 600, height: 400 } : { width: 1200, height: 800 }),
    resize: vi.fn(() => normalized),
  };
  const capture = vi.fn(async () => image);
  Reflect.set(surface, "window", {
    getBounds: () => ({ x: 0, y: 0, width: 640, height: 480 }),
    webContents: { getZoomFactor: () => ownerZoom },
  });
  Reflect.set(surface, "geometry", {
    viewport: bounds,
    clip: bounds,
    child: bounds,
    ownerZoom: 1,
    clipping: "full",
  });
  Reflect.set(surface, "view", {
    getBounds: () => bounds,
    webContents: {
      capturePage: capture,
      send: () => {
        const observation = Reflect.get(surface, "frameObservation") as { resolve(): void };
        Reflect.set(surface, "frameObservation", undefined);
        observation.resolve();
      },
    },
  });
  native.display.mockReturnValue({ id: 5, scaleFactor: 2 });
  return {
    surface,
    capture,
    image,
    normalized,
    setZoom: (value: number) => {
      ownerZoom = value;
    },
    setBounds: (value: typeof bounds) => {
      bounds = value;
    },
  };
}

describe("native visualization capture ownership", () => {
  it("accepts the exact 1x private preview raster on a 2x owner display", async () => {
    const value = captureFixture(true);
    await expect(value.surface.capture()).resolves.toEqual({
      png: new Uint8Array([1, 2, 3]),
      width: 600,
      height: 400,
    });
    expect(value.capture).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 600, height: 400 },
      { stayHidden: true, stayAwake: true },
    );
    expect(value.image.resize).toHaveBeenCalledWith({ width: 600, height: 400, quality: "good" });
    expect(value.normalized.toPNG).toHaveBeenCalledWith({ scaleFactor: 1 });

    const wrong = captureFixture(true);
    wrong.image.getSize = () => ({ width: 1200, height: 800 });
    await expect(wrong.surface.capture()).rejects.toThrow("refused");
    expect(wrong.capture).toHaveBeenCalledOnce();
    expect(wrong.image.resize).not.toHaveBeenCalled();
    expect(wrong.normalized.toPNG).not.toHaveBeenCalled();
  });

  it("retains owner-display metadata and physical-work admission for private previews", async () => {
    const missing = captureFixture(true);
    native.display.mockReturnValue({ id: 5, scaleFactor: undefined });
    await expect(missing.surface.capture()).rejects.toThrow("refused");
    expect(missing.capture).not.toHaveBeenCalled();

    const excessive = captureFixture(true);
    excessive.setBounds({ x: 0, y: 0, width: 1600, height: 2000 });
    native.display.mockReturnValue({ id: 5, scaleFactor: 3 });
    await expect(excessive.surface.capture()).rejects.toThrow("refused");
    expect(excessive.capture).not.toHaveBeenCalled();
  });

  it("refuses preview owner display, DPR, zoom and bounds drift before encoding", async () => {
    for (const replacement of [
      { id: 6, scaleFactor: 2 },
      { id: 5, scaleFactor: 1 },
    ]) {
      const value = captureFixture(true);
      native.display
        .mockReturnValueOnce({ id: 5, scaleFactor: 2 })
        .mockReturnValueOnce(replacement);
      await expect(value.surface.capture()).rejects.toThrow("refused");
      expect(value.image.resize).not.toHaveBeenCalled();
      expect(value.normalized.toPNG).not.toHaveBeenCalled();
    }

    const before = captureFixture(true);
    before.setZoom(1.3);
    await expect(before.surface.capture()).rejects.toThrow("refused");
    expect(before.capture).not.toHaveBeenCalled();

    const zoom = captureFixture(true);
    zoom.capture.mockImplementationOnce(async () => {
      zoom.setZoom(0.8);
      return zoom.image;
    });
    await expect(zoom.surface.capture()).rejects.toThrow("refused");
    expect(zoom.image.resize).not.toHaveBeenCalled();
    expect(zoom.normalized.toPNG).not.toHaveBeenCalled();

    const bounds = captureFixture(true);
    bounds.capture.mockImplementationOnce(async () => {
      bounds.setBounds({ x: 1, y: 0, width: 600, height: 400 });
      return bounds.image;
    });
    await expect(bounds.surface.capture()).rejects.toThrow("refused");
    expect(bounds.image.resize).not.toHaveBeenCalled();
    expect(bounds.normalized.toPNG).not.toHaveBeenCalled();
  });

  it("refuses owner zoom drift before capture and around its asynchronous result", async () => {
    const before = captureFixture();
    before.setZoom(1.3);
    await expect(before.surface.capture()).rejects.toThrow("Visualization capture was refused.");
    expect(before.capture).not.toHaveBeenCalled();
    const during = captureFixture();
    during.capture.mockImplementationOnce(async () => {
      during.setZoom(0.8);
      return during.image;
    });
    await expect(during.surface.capture()).rejects.toThrow("Visualization capture was refused.");
    expect(during.normalized.toPNG).not.toHaveBeenCalled();
  });
  it("preflights actual DPR before capture and normalizes only its exact native tuple", async () => {
    const value = captureFixture();
    await expect(value.surface.capture()).resolves.toEqual({
      png: new Uint8Array([1, 2, 3]),
      width: 600,
      height: 400,
    });
    expect(value.capture).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 600, height: 400 },
      { stayHidden: true, stayAwake: true },
    );
    expect(value.image.resize).toHaveBeenCalledWith({ width: 600, height: 400, quality: "good" });
    expect(value.normalized.toPNG).toHaveBeenCalledWith({ scaleFactor: 1 });
    const refused = captureFixture();
    native.display.mockReturnValue({ id: 5, scaleFactor: undefined });
    await expect(refused.surface.capture()).rejects.toThrow("refused");
    expect(refused.capture).not.toHaveBeenCalled();
  });
  it("refuses native display/DPR and view-bound replacement before encoding", async () => {
    for (const replacement of [
      { id: 6, scaleFactor: 2 },
      { id: 5, scaleFactor: 1 },
    ]) {
      const value = captureFixture();
      native.display
        .mockReturnValueOnce({ id: 5, scaleFactor: 2 })
        .mockReturnValueOnce(replacement);
      await expect(value.surface.capture()).rejects.toThrow("refused");
      expect(value.image.resize).not.toHaveBeenCalled();
      expect(value.normalized.toPNG).not.toHaveBeenCalled();
    }
    const value = captureFixture();
    value.capture.mockImplementationOnce(async () => {
      value.setBounds({ x: 1, y: 0, width: 600, height: 400 });
      return value.image;
    });
    await expect(value.surface.capture()).rejects.toThrow("refused");
    expect(value.image.resize).not.toHaveBeenCalled();
  });
  it("refuses mismatched or excessive actual native raster without encoding", async () => {
    const value = captureFixture();
    value.image.getSize = () => ({ width: 600, height: 400 });
    await expect(value.surface.capture()).rejects.toThrow("refused");
    expect(value.image.resize).not.toHaveBeenCalled();
    const excessive = captureFixture();
    excessive.setBounds({ x: 0, y: 0, width: 1600, height: 2000 });
    native.display.mockReturnValue({ id: 5, scaleFactor: 3 });
    await expect(excessive.surface.capture()).rejects.toThrow("refused");
    expect(excessive.capture).not.toHaveBeenCalled();
  });
});
