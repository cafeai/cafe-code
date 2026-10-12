import { describe, expect, it, vi } from "vitest";
import type * as Electron from "electron";
import {
  ElectronVisualizationSurface,
  type VisualizationSurfaceOptions,
} from "./ElectronVisualizationSurface.ts";

const native = vi.hoisted(() => ({ inventory: vi.fn(), display: vi.fn() }));
vi.mock("electron", () => ({
  webContents: { getAllWebContents: native.inventory },
  screen: { getDisplayMatching: native.display },
}));

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
  const bounds = { x: 0, y: 0, width: 400, height: 200 };
  const visible = vi.fn();
  const contents = {
    getOSProcessId: () => 123,
    mainFrame: {
      url: `cafe-visualization://${surface.generation}/bootstrap`,
      frameToken: "fixture-visibility-frame",
      detached: false,
      isDestroyed: () => false,
    },
    loadURL: async () => {},
    setBackgroundThrottling: vi.fn(),
    send: (_channel: string, value: { kind: string }) => {
      if (value.kind !== "install") return;
      const installation = Reflect.get(surface, "installation") as { resolve(): void };
      Reflect.set(surface, "installation", undefined);
      installation.resolve();
    },
  };
  Reflect.set(surface, "view", {
    webContents: contents,
    setVisible: visible,
    getBounds: () => bounds,
    setBounds: vi.fn(),
  });
  Reflect.set(surface, "window", { getContentSize: () => [640, 480] });
  const internals = surface as unknown as {
    createNativeSurface(): void;
    processesAreExclusive(): boolean;
  };
  vi.spyOn(internals, "createNativeSurface").mockImplementation(() => {});
  vi.spyOn(internals, "processesAreExclusive").mockReturnValue(true);
  return { surface, visible, bounds, revoke: () => (current = false) };
}

describe("native visualization visibility commit", () => {
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
function captureFixture() {
  const { surface } = exclusive({ isDestroyed: () => true });
  vi.spyOn(surface, "isCurrent").mockReturnValue(true);
  let bounds = { x: 0, y: 0, width: 600, height: 400 };
  const normalized = {
    isEmpty: () => false,
    getSize: () => ({ width: 600, height: 400 }),
    toPNG: vi.fn(() => Buffer.from([1, 2, 3])),
  };
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 1200, height: 800 }),
    resize: vi.fn(() => normalized),
  };
  const capture = vi.fn(async () => image);
  Reflect.set(surface, "window", { getBounds: () => ({ x: 0, y: 0, width: 640, height: 480 }) });
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
    setBounds: (value: typeof bounds) => {
      bounds = value;
    },
  };
}

describe("native visualization capture ownership", () => {
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
