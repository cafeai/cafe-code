import * as Electron from "electron";
import { randomUUID } from "node:crypto";

import {
  VISUALIZATION_HOST_MAX_ASSET_BYTES,
  VISUALIZATION_HOST_RETIRE_MS,
  type VisualizationHostBounds,
  type VisualizationHostDocument,
  type VisualizationHostPresentation,
  type VisualizationHostDisplayMode,
} from "@cafecode/contracts/visualizationHost";
import {
  VISUALIZATION_CONTEXT_CHANNEL,
  VISUALIZATION_CSP,
  VISUALIZATION_PAGE_CHANNEL,
  VISUALIZATION_HEARTBEAT_CHANNEL,
  VISUALIZATION_INSTALLED_CHANNEL,
  VISUALIZATION_FRAME_CHANNEL,
  VISUALIZATION_SCHEME,
  clampVisualizationBounds,
  hasExclusiveVisualizationProcesses,
  isVisualizationMessage,
  rasterDimensions,
} from "./visualizationHostPolicy.ts";
import type { VisualizationSurfaceDiagnostics } from "./visualizationDiagnostics.ts";
import {
  admitVisualizationCapture,
  matchesVisualizationCapture,
} from "./visualizationCapturePolicy.ts";

export interface VisualizationSurface {
  readonly generation: string;
  initialize(): Promise<void>;
  installSource(): Promise<void>;
  capture(): Promise<{ png: Uint8Array; width: number; height: number }>;
  update(
    bounds: VisualizationHostBounds,
    appearance: "light" | "dark",
    presentation?: VisualizationHostPresentation,
    displayMode?: VisualizationHostDisplayMode,
  ): boolean;
  suspend(suspended: boolean): boolean;
  send(json: string): boolean;
  isCurrent(): boolean;
  retire(): Promise<boolean>;
  diagnostics?(): VisualizationSurfaceDiagnostics;
}
export interface VisualizationSurfaceOptions {
  readonly document: VisualizationHostDocument;
  readonly preloadPath: string;
  readonly window: Electron.BrowserWindow | null;
  readonly bounds: VisualizationHostBounds;
  readonly onMessage: (json: string) => void;
  readonly onRevoked: () => void;
  readonly presentation?: VisualizationHostPresentation;
  readonly displayMode?: VisualizationHostDisplayMode;
}

/**
 * This class owns the actual native view/session and retains its native objects.
 * It is never registered as an ordinary trusted Cafe IPC or audio WebContents.
 * The independent owner starts its deadline before creating this object. Native
 * main can therefore retire it even while source document.write never returns.
 */
export class ElectronVisualizationSurface implements VisualizationSurface {
  readonly generation = randomUUID();
  private session!: Electron.Session;
  private view!: Electron.WebContentsView;
  private window!: Electron.BrowserWindow;
  private readonly previewWindow: boolean;
  private readonly namespace: string;
  private readonly resources = new Map<string, Buffer>();
  private readonly options: VisualizationSurfaceOptions;
  private rendererPid = 0;
  private rootToken = "";
  private admitted = false;
  private revoked = false;
  private suspended = false;
  private visibilityCommitted = false;
  private requests = 0;
  private requestedBytes = 0;
  private messages = 0;
  private messageEpoch = 0;
  private sequence = 0;
  private retiring: Promise<boolean> | undefined;
  private gone = false;
  private destroyed = false;
  private lastHeartbeat = 0;
  private heartbeatSequence = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private phase: VisualizationSurfaceDiagnostics["phase"] = "uncreated";
  private rejection: VisualizationSurfaceDiagnostics["rejection"] = "none";
  private frameCount = 0;
  private rendererCount = 0;
  private exclusiveProcess = false;
  private assetBytes = 0;
  private captureOutcome: VisualizationSurfaceDiagnostics["captureOutcome"] = "not-attempted";
  private captureWidth = 0;
  private captureHeight = 0;
  private installation: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private frameObservation:
    | { token: string; resolve: () => void; reject: (error: Error) => void }
    | undefined;

  constructor(options: VisualizationSurfaceOptions) {
    this.options = options;
    this.namespace = `${VISUALIZATION_SCHEME}://${this.generation}`;
    this.previewWindow = options.window === null;
  }

  private createNativeSurface(): void {
    if (this.revoked) throw new Error("Visualization execution was refused.");
    // Unsafe global Chromium modes invalidate per-view isolation. Do not try to
    // repair them or run private bytes under an application-wide override.
    if (
      [
        "single-process",
        "no-sandbox",
        "disable-web-security",
        "disable-site-isolation-trials",
      ].some((flag) => Electron.app.commandLine.hasSwitch(flag))
    )
      throw new Error("Visualization execution was refused.");
    const options = this.options;
    this.session = Electron.session.fromPartition(`visualization-${this.generation}`, {
      cache: false,
    });
    if (this.session.isPersistent() || this.session.getPreloadScripts().length !== 0)
      throw new Error("Visualization execution is unavailable.");
    this.window =
      options.window ??
      new Electron.BrowserWindow({
        show: false,
        // The admitted viewport is a content DIP contract. Native window chrome
        // must not silently subtract its caption height from a saved poster.
        useContentSize: true,
        width: options.document.width,
        height: options.document.height,
        webPreferences: {
          session: this.session,
          javascript: false,
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          devTools: false,
        },
      });
    this.view = new Electron.WebContentsView({
      webPreferences: {
        session: this.session,
        preload: options.preloadPath,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        plugins: false,
        spellcheck: false,
        devTools: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
        // Source may initialize while hidden, but never owns visibility. The
        // trusted exact-lease update is the viewer's separate exposure commit.
        // Preview is independently offscreen.
        backgroundThrottling: !this.previewWindow,
        offscreen: this.previewWindow,
      },
    });
    this.view.setVisible(false);
    this.window.contentView.addChildView(this.view);
    const ownerSize = this.window.getContentSize();
    const clipped = clampVisualizationBounds(options.bounds, [ownerSize[0]!, ownerSize[1]!]);
    if (!clipped) throw new Error("Visualization bounds were refused.");
    this.view.setBounds(clipped);
    this.installNativePolicy();
    this.phase = "bootstrap";
  }

  private deny = (): void => {
    if (this.revoked) return;
    if (this.rejection === "none") this.rejection = "native-policy";
    this.revoked = true;
    this.view.setVisible(false);
    this.options.onRevoked();
  };
  private ownerWindowRevoked = (): void => {
    // Owned teardown may close a private preview window after revocation. Do
    // not relabel that intentional cleanup as the cause of a prior retirement.
    if (this.revoked) return;
    if (this.rejection === "none") this.rejection = "owner-window";
    this.deny();
  };
  private ownerNavigationRevoked = (): void => {
    if (this.rejection === "none") this.rejection = "owner-navigation";
    this.deny();
  };

  private installNativePolicy(): void {
    const contents = this.view.webContents;
    contents.ipc.on(VISUALIZATION_INSTALLED_CHANNEL, (event, succeeded: unknown) => {
      const pending = this.installation;
      if (!pending || event.senderFrame !== contents.mainFrame || !this.isCurrent()) return;
      this.installation = undefined;
      if (succeeded === true) pending.resolve();
      else pending.reject(new Error("Visualization execution was refused."));
    });
    contents.ipc.on(VISUALIZATION_FRAME_CHANNEL, (event, token: unknown) => {
      const pending = this.frameObservation;
      if (
        !pending ||
        token !== pending.token ||
        event.senderFrame !== contents.mainFrame ||
        !this.isCurrent()
      )
        return;
      this.frameObservation = undefined;
      pending.resolve();
    });
    contents.ipc.on(VISUALIZATION_HEARTBEAT_CHANNEL, (event, sequence: unknown) => {
      if (
        event.senderFrame !== contents.mainFrame ||
        !Number.isSafeInteger(sequence) ||
        sequence !== this.heartbeatSequence + 1
      ) {
        if (this.rejection === "none")
          this.rejection =
            event.senderFrame !== contents.mainFrame ? "heartbeat-frame" : "heartbeat-sequence";
        this.deny();
        return;
      }
      this.heartbeatSequence = sequence as number;
      this.lastHeartbeat = performance.now();
    });
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.setDevicePermissionHandler(() => false);
    this.session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    this.session.on("will-download", (event) => {
      event.preventDefault();
      this.deny();
    });
    this.session.setCertificateVerifyProc((_request, callback) => callback(-2));
    this.session.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url;
      const bootstrap = url === `${this.namespace}/bootstrap` && !this.admitted;
      const asset =
        url.startsWith(`${this.namespace}/asset/`) && this.resources.has(url) && this.admitted;
      const own = details.webContentsId === contents.id;
      const allowed = !this.revoked && own && (bootstrap || asset) && ++this.requests <= 256;
      callback({ cancel: !allowed });
      if (!allowed && !this.revoked) {
        this.rejection = "resource-request";
        this.deny();
      }
    });
    this.session.protocol.handle(VISUALIZATION_SCHEME, (request) => {
      if (this.revoked || request.method !== "GET") return new Response(null, { status: 403 });
      let bytes: Buffer;
      let mime = "text/html; charset=utf-8";
      const csp = VISUALIZATION_CSP;
      if (request.url === `${this.namespace}/bootstrap` && !this.admitted) {
        // Admit this sole inert native top-frame process before source reaches
        // its isolated preload loader. No iframe/OOPIF is granted.
        bytes = Buffer.from(
          "<!doctype html><html><head><meta charset=utf-8></head><body></body></html>",
        );
      } else {
        const resource = this.resources.get(request.url);
        if (!this.admitted || !resource) return new Response(null, { status: 403 });
        bytes = resource;
        mime = "image/png";
      }
      this.requestedBytes += bytes.length;
      if (this.requestedBytes > 24 * 1024 * 1024) {
        this.deny();
        return new Response(null, { status: 403 });
      }
      return new Response(new Uint8Array(bytes).buffer, {
        headers: {
          "Content-Type": mime,
          "Content-Security-Policy": csp,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Permissions-Policy":
            "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), fullscreen=()",
        },
      });
    });
    contents.setWindowOpenHandler(() => {
      this.deny();
      return { action: "deny" };
    });
    contents.on("will-frame-navigate", (event) => {
      event.preventDefault();
      if (this.rejection === "none") this.rejection = "page-navigation";
      this.deny();
    });
    contents.on("will-redirect", (event) => {
      event.preventDefault();
      this.deny();
    });
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
      this.deny();
    });
    contents.on("login", (event, _details, _authInfo, callback) => {
      event.preventDefault();
      callback();
      this.deny();
    });
    contents.on("frame-created", () => {
      if (this.admitted) {
        if (this.rejection === "none") this.rejection = "child-frame";
        this.deny();
      }
    });
    contents.on("did-start-navigation", (event) => {
      if (this.admitted && !event.isSameDocument) this.deny();
    });
    contents.on("render-process-gone", () => {
      this.gone = true;
      if (!this.retiring) {
        if (this.rejection === "none") this.rejection = "renderer-exit";
        this.deny();
      }
    });
    contents.on("destroyed", () => {
      this.destroyed = true;
      if (!this.retiring) this.deny();
    });
    contents.ipc.on(VISUALIZATION_PAGE_CHANNEL, (event, raw: unknown) => {
      if (
        !this.isCurrent() ||
        this.options.document.kind !== "mcp-app" ||
        event.senderFrame !== contents.mainFrame ||
        typeof raw !== "object" ||
        raw === null
      )
        return;
      const message = raw as { sequence?: unknown; json?: unknown };
      if (message.sequence !== this.sequence + 1 || !isVisualizationMessage(message.json)) {
        this.deny();
        return;
      }
      const now = performance.now();
      if (now - this.messageEpoch >= 1000) {
        this.messageEpoch = now;
        this.messages = 0;
      }
      if (++this.messages > 30) {
        this.deny();
        return;
      }
      this.sequence += 1;
      if (this.suspended) return;
      this.options.onMessage(message.json);
    });
    this.window.once("closed", this.ownerWindowRevoked);
    this.window.on("hide", this.ownerWindowRevoked);
    this.window.on("minimize", this.ownerWindowRevoked);
    this.window.webContents.on("did-start-navigation", this.ownerNavigationRevoked);
    this.window.webContents.on("render-process-gone", this.ownerNavigationRevoked);
  }

  private processesAreExclusive(retirement = false): boolean {
    this.exclusiveProcess = false;
    try {
      const contents = this.view.webContents;
      const frames = contents.mainFrame.framesInSubtree;
      if (frames.length === 0 || frames.length > 1024) return false;
      const own = [...new Set(frames.map((frame) => frame.osProcessId))];
      this.frameCount = frames.length;
      this.rendererCount = own.length;
      // ForcefullyCrashRenderer targets this native main renderer. No additional
      // renderer is admitted. Retirement may include an already-denied same-PID
      // frame, but never an OOPIF or any other WebContents' process.
      if (own.length !== 1 || (!retirement && frames.length !== 1)) {
        this.exclusiveProcess = false;
        return false;
      }
      // A renderer restart is not the admitted generation. Even exclusive new
      // PIDs must not be adopted as evidence for crashing/retiring the original.
      if (
        retirement &&
        this.rendererPid > 0 &&
        (own[0] !== this.rendererPid ||
          contents.getOSProcessId() !== this.rendererPid ||
          contents.mainFrame.frameToken !== this.rootToken)
      )
        return false;
      const others = Electron.webContents
        .getAllWebContents()
        .filter(
          (other) =>
            other !== contents && (!this.previewWindow || other !== this.window.webContents),
        );
      const otherPids: number[] = [];
      for (const other of others) {
        if (other.isDestroyed()) continue;
        // A live owner's unreadable inventory is uncertainty, never an empty
        // process set. Zero is admitted only when native reports this complete
        // WebContents inventory has not started any renderer at all.
        const primaryPid = other.getOSProcessId();
        const frames = other.mainFrame.framesInSubtree;
        if (frames.length === 0 || frames.length > 1024) return false;
        const pids = frames.map((frame) => frame.osProcessId);
        if (primaryPid === 0 && pids.every((pid) => pid === 0)) continue;
        if (
          !Number.isSafeInteger(primaryPid) ||
          primaryPid <= 0 ||
          pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
        )
          return false;
        otherPids.push(primaryPid, ...pids);
      }
      this.exclusiveProcess = hasExclusiveVisualizationProcesses(own, otherPids);
      return this.exclusiveProcess;
    } catch {
      this.exclusiveProcess = false;
      return false;
    }
  }

  async initialize(): Promise<void> {
    this.createNativeSurface();
    let assetBytes = 0;
    let pixels = 0;
    for (const asset of this.options.document.assets) {
      const bytes = Buffer.from(asset.base64, "base64");
      if (
        bytes.toString("base64") !== asset.base64 ||
        this.resources.has(`${this.namespace}/asset/${asset.id}`)
      )
        throw new Error("Visualization assets were refused.");
      const dimensions = rasterDimensions(bytes, asset.mime);
      if (!dimensions || (pixels += dimensions.width * dimensions.height) > 16_000_000)
        throw new Error("Visualization assets were refused.");
      const image = Electron.nativeImage.createFromBuffer(bytes);
      const size = image.getSize();
      if (image.isEmpty() || size.width !== dimensions.width || size.height !== dimensions.height)
        throw new Error("Visualization assets were refused.");
      const png = image.toPNG();
      if ((assetBytes += png.length) > VISUALIZATION_HOST_MAX_ASSET_BYTES)
        throw new Error("Visualization assets were refused.");
      this.resources.set(`${this.namespace}/asset/${asset.id}`, png);
    }
    this.assetBytes = assetBytes;
    await this.view.webContents.loadURL(`${this.namespace}/bootstrap`);
    if (this.revoked || !this.processesAreExclusive()) {
      if (!this.revoked) this.rejection = "renderer-separation";
      throw new Error("Visualization execution was refused.");
    }
    const contents = this.view.webContents;
    if (
      contents.mainFrame.url !== `${this.namespace}/bootstrap` ||
      contents.mainFrame.detached ||
      contents.mainFrame.isDestroyed()
    ) {
      this.rejection = "child-frame";
      throw new Error("Visualization execution was refused.");
    }
    this.rendererPid = contents.getOSProcessId();
    this.rootToken = contents.mainFrame.frameToken;
    this.admitted = true;
    this.phase = "admitted";
    // Startup retains its separate 20-second total budget. Once this exact
    // process is admitted, main observes private fixed-preload pulses. Main can
    // crash that owned process while page JavaScript blocks; this is not a claim
    // of survival when Electron main/native code or the entire system stalls.
    this.lastHeartbeat = performance.now();
    this.watchdog = setInterval(() => {
      if (!this.revoked && performance.now() - this.lastHeartbeat > 3_000) {
        this.rejection = "heartbeat-missed";
        this.deny();
      }
    }, 500);
    if (!this.previewWindow) {
      // A delayed open acknowledgement can race a trusted approval overlay.
      // Keep even the inert bootstrap hidden, and permit bounded hidden source
      // initialization without using exposure as a compositor/startup signal.
      // Only a later authenticated exact-lease geometry update may reveal it.
      this.view.webContents.setBackgroundThrottling(false);
    }
  }

  isCurrent(): boolean {
    try {
      return (
        this.admitted &&
        !this.revoked &&
        !this.destroyed &&
        !this.gone &&
        !this.window.isDestroyed() &&
        !this.view.webContents.isDestroyed() &&
        this.view.webContents.getOSProcessId() === this.rendererPid &&
        this.view.webContents.mainFrame.frameToken === this.rootToken &&
        !this.view.webContents.mainFrame.detached &&
        this.view.webContents.mainFrame.osProcessId === this.rendererPid &&
        this.processesAreExclusive()
      );
    } catch {
      return false;
    }
  }

  async installSource(): Promise<void> {
    if (!this.isCurrent() || this.installation)
      throw new Error("Visualization execution was refused.");
    // The isolated preload owns document.open/write and restores its relay
    // before parsing source. Main-world source receives no native bridge or
    // eval interpolation. The response-header CSP remains the native policy.
    const dark = this.options.document.appearance === "dark";
    const presentation = this.options.presentation;
    const names = {
      background: "--background",
      foreground: "--foreground",
      muted: "--muted-foreground",
      accent: "--accent",
      accentForeground: "--accent-foreground",
      chart1: "--chart-1",
      chart2: "--chart-2",
      chart3: "--chart-3",
      chart4: "--chart-4",
      chart5: "--chart-5",
      chart6: "--chart-6",
    } as const;
    const colors = presentation
      ? (Object.keys(names) as (keyof typeof names)[])
          .map((key) => `${names[key]}:${presentation.colors[key]};`)
          .join("")
      : "";
    // Every interpolated scalar passed the strict native input schema; no source
    // attribute, CSS selector or URL becomes trusted wrapper markup. Install the
    // initial theme before inline App code runs, rather than only notifying later.
    const source =
      '<!doctype html><html lang="' +
      (presentation?.locale ?? "en") +
      '" data-cafe-reduced-motion="' +
      String(presentation?.reducedMotion ?? false) +
      '"><meta charset="utf-8"><style>:root{color-scheme:' +
      this.options.document.appearance +
      ";--background:" +
      (dark ? "#18181b" : "#fff") +
      ";--foreground:" +
      (dark ? "#eee" : "#18181b") +
      ";" +
      colors +
      "--cafe-interface-scale:" +
      String(presentation?.scale ?? 1) +
      "}html,body{margin:0;min-height:100%;background:var(--background);color:var(--foreground)}html[data-cafe-reduced-motion=true] *{animation-duration:.001ms!important;transition-duration:.001ms!important}</style>" +
      this.options.document.html;
    await new Promise<void>((resolve, reject) => {
      this.installation = { resolve, reject };
      this.view.webContents.send(VISUALIZATION_CONTEXT_CHANNEL, {
        kind: "install",
        html: source,
        documentKind: this.options.document.kind,
        preview: this.previewWindow,
        appearance: this.options.document.appearance,
        containerDimensions: {
          width: this.view.getBounds().width,
          height: this.view.getBounds().height,
        },
        displayMode: this.options.displayMode ?? "inline",
        ...(this.options.presentation ? { presentation: this.options.presentation } : {}),
      });
    });
    if (!this.isCurrent()) throw new Error("Visualization execution was refused.");
    if (this.previewWindow) this.view.setVisible(true);
    this.phase = "active";
  }

  update(
    bounds: VisualizationHostBounds,
    appearance: "light" | "dark",
    presentation?: VisualizationHostPresentation,
    displayMode?: VisualizationHostDisplayMode,
  ): boolean {
    if (!this.isCurrent()) return false;
    const size = this.window.getContentSize();
    const clipped = clampVisualizationBounds(bounds, [size[0]!, size[1]!]);
    if (!clipped) return false;
    this.view.setBounds(clipped);
    this.view.webContents.send(VISUALIZATION_CONTEXT_CHANNEL, {
      kind: "presentation",
      appearance,
      containerDimensions: { width: clipped.width, height: clipped.height },
      ...(displayMode ? { displayMode } : {}),
      ...(presentation ? { presentation } : {}),
    });
    // Host.update calls this only for its exact active native document/window
    // after trusted UI acknowledgement. A consent resume cannot manufacture
    // that first visibility commit, nor expose a currently suspended document.
    this.visibilityCommitted = true;
    this.view.setVisible(!this.suspended);
    return true;
  }

  suspend(suspended: boolean): boolean {
    if (!this.isCurrent()) return false;
    this.suspended = suspended;
    this.view.setVisible(!suspended && this.visibilityCommitted);
    return true;
  }

  send(json: string): boolean {
    if (
      !this.isCurrent() ||
      this.suspended ||
      this.options.document.kind !== "mcp-app" ||
      !isVisualizationMessage(json)
    )
      return false;
    this.view.webContents.send(VISUALIZATION_CONTEXT_CHANNEL, { kind: "message", json });
    return true;
  }

  async capture(): Promise<{ png: Uint8Array; width: number; height: number }> {
    if (!this.isCurrent() || this.suspended) throw new Error("Visualization capture was refused.");
    if (this.frameObservation) throw new Error("Visualization capture was refused.");
    // Ordered private IPC places this barrier after replay/presentation. Two
    // real frame callbacks yield their synchronous DOM changes before capture;
    // only capturePage's actual pixels qualify the poster, never the callback.
    await new Promise<void>((resolve, reject) => {
      const token = randomUUID();
      this.frameObservation = { token, resolve, reject };
      this.view.webContents.send(VISUALIZATION_CONTEXT_CHANNEL, { kind: "frame", token });
    });
    if (!this.isCurrent() || this.suspended) throw new Error("Visualization capture was refused.");
    this.captureOutcome = "native-error";
    const bounds = this.view.getBounds();
    const display = Electron.screen.getDisplayMatching(this.window.getBounds());
    const tuple = admitVisualizationCapture(bounds.width, bounds.height, display.scaleFactor);
    if (!tuple) throw new Error("Visualization capture was refused.");
    const image = await this.view.webContents.capturePage(
      { x: 0, y: 0, width: bounds.width, height: bounds.height },
      { stayHidden: true, stayAwake: true },
    );
    if (image.isEmpty()) this.captureOutcome = "empty";
    if (!this.isCurrent() || this.suspended || image.isEmpty())
      throw new Error("Visualization capture was refused.");
    const size = image.getSize();
    const currentBounds = this.view.getBounds();
    const currentDisplay = Electron.screen.getDisplayMatching(this.window.getBounds());
    if (
      !matchesVisualizationCapture(tuple, size) ||
      currentDisplay.id !== display.id ||
      currentDisplay.scaleFactor !== tuple.dpr ||
      currentBounds.x !== bounds.x ||
      currentBounds.y !== bounds.y ||
      currentBounds.width !== bounds.width ||
      currentBounds.height !== bounds.height
    )
      throw new Error("Visualization capture was refused.");
    // Normalize the separately bounded physical raster to the exact semantic
    // viewport. Never mutate guest zoom, native display flags or its UI bounds.
    const normalized = image.resize({ width: tuple.width, height: tuple.height, quality: "good" });
    const normalizedSize = normalized.getSize();
    if (
      normalized.isEmpty() ||
      normalizedSize.width !== tuple.width ||
      normalizedSize.height !== tuple.height
    )
      throw new Error("Visualization capture was refused.");
    this.captureWidth = tuple.width;
    this.captureHeight = tuple.height;
    this.captureOutcome = "encoding-error";
    const png = normalized.toPNG({ scaleFactor: 1 });
    if (png.length > 16 * 1024 * 1024) throw new Error("Visualization capture was refused.");
    this.captureOutcome = "ready";
    return { png: new Uint8Array(png), width: tuple.width, height: tuple.height };
  }

  retire(): Promise<boolean> {
    if (this.retiring) return this.retiring;
    this.revoked = true;
    this.installation?.reject(new Error("Visualization execution was refused."));
    this.installation = undefined;
    this.frameObservation?.reject(new Error("Visualization capture was refused."));
    this.frameObservation = undefined;
    this.phase = "retiring";
    if (this.watchdog) clearInterval(this.watchdog);
    if (!this.view) {
      if (this.previewWindow && this.window && !this.window.isDestroyed()) this.window.destroy();
      this.retiring = Promise.resolve(true);
      this.phase = "retired";
      return this.retiring;
    }
    this.view.setVisible(false);
    const contents = this.view.webContents;
    const needsRendererExit = this.rendererPid > 0;
    this.retiring = new Promise<boolean>((resolve) => {
      const end = performance.now() + VISUALIZATION_HOST_RETIRE_MS;
      let closeRequested = false;
      const tick = () => {
        if (!closeRequested && (!needsRendererExit || this.gone)) {
          closeRequested = true;
          try {
            if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
          } catch {
            /* Observe destruction rather than infer it from a close call. */
          }
        }
        if (this.destroyed && (!needsRendererExit || this.gone)) {
          finish(true);
          return;
        }
        if (performance.now() >= end) {
          finish(false);
          return;
        }
        setTimeout(tick, 10);
      };
      const finish = (retired: boolean) => {
        this.phase = retired ? "retired" : "quarantined";
        if (retired) {
          this.resources.clear();
          this.session.protocol.unhandle(VISUALIZATION_SCHEME);
          // Clearing this fresh in-memory session cannot clear ordinary app data.
          void this.session.clearStorageData().catch(() => undefined);
        }
        this.window.removeListener("closed", this.ownerWindowRevoked);
        this.window.removeListener("hide", this.ownerWindowRevoked);
        this.window.removeListener("minimize", this.ownerWindowRevoked);
        if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
          this.window.webContents.removeListener(
            "did-start-navigation",
            this.ownerNavigationRevoked,
          );
          this.window.webContents.removeListener(
            "render-process-gone",
            this.ownerNavigationRevoked,
          );
        }
        resolve(retired);
      };
      try {
        this.window.contentView.removeChildView(this.view);
        if (!contents.isDestroyed()) {
          // Never crash a renderer that became shared. A missing proof leaves
          // this slot quarantined, not permission to terminate Cafe's UI.
          if (needsRendererExit && this.processesAreExclusive(true))
            contents.forcefullyCrashRenderer();
          if (!needsRendererExit) {
            closeRequested = true;
            contents.close({ waitForBeforeUnload: false });
          }
        }
        if (this.previewWindow && !this.window.isDestroyed()) this.window.destroy();
      } catch {
        /* Native uncertainty is reported by the finite observation below. */
      }
      tick();
    });
    return this.retiring;
  }

  diagnostics(): VisualizationSurfaceDiagnostics {
    return {
      phase: this.phase,
      rejection: this.rejection,
      exclusiveProcess: this.exclusiveProcess,
      frameCount: this.frameCount,
      rendererCount: this.rendererCount,
      gone: this.gone,
      destroyed: this.destroyed,
      watchdogArmed: this.watchdog !== undefined && !this.revoked,
      heartbeatMissed: this.rejection === "heartbeat-missed",
      assetBytes: this.resources.size === 0 ? 0 : this.assetBytes,
      requestCount: this.requests,
      servedBytes: this.requestedBytes,
      captureOutcome: this.captureOutcome,
      captureWidth: this.captureWidth,
      captureHeight: this.captureHeight,
    };
  }
}
