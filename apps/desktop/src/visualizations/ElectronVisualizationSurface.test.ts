import { describe, expect, it, vi } from "vitest";
import type * as Electron from "electron";
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
    webContents: { getZoomFactor: () => ownerZoom },
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
function captureFixture() {
  const { surface } = exclusive({ isDestroyed: () => true });
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
    getSize: () => ({ width: 1200, height: 800 }),
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
