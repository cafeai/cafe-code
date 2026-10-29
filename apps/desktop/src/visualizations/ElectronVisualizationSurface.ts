import * as Electron from "electron";
import { randomUUID } from "node:crypto";
import { visualizationFluidScript } from "@cafecode/shared/visualizationFluidRuntime";
import { GENERATED_VISUALIZATION_FONT_FAMILY_STYLE } from "@cafecode/shared/chatTypography";

import {
  VISUALIZATION_HOST_MAX_ASSET_BYTES,
  VISUALIZATION_HOST_RETIRE_MS,
  type VisualizationHostBounds,
  type VisualizationHostDocument,
  type VisualizationHostPresentation,
  type VisualizationHostDisplayMode,
  type VisualizationHostLayout,
} from "@cafecode/contracts/visualizationHost";
import {
  VISUALIZATION_CONTEXT_CHANNEL,
  VISUALIZATION_CSP,
  VISUALIZATION_PAGE_CHANNEL,
  VISUALIZATION_HEARTBEAT_CHANNEL,
  VISUALIZATION_INSTALLED_CHANNEL,
  VISUALIZATION_FRAME_CHANNEL,
  VISUALIZATION_SCHEME,
  admitVisualizationGeometry,
  hasVisualizationPresentationGeometry,
  type VisualizationGeometry,
  hasExclusiveVisualizationProcesses,
  isVisualizationMessage,
  rasterDimensions,
} from "./visualizationHostPolicy.ts";
import type { VisualizationSurfaceDiagnostics } from "./visualizationDiagnostics.ts";
import {
  PREVIEW_DEVICE_SCALE_FACTOR,
  admitVisualizationCapture,
  matchesVisualizationCapture,
} from "./visualizationCapturePolicy.ts";
import { GENERATED_VISUALIZATION_TOOLTIP_STYLE } from "./visualizationPresentation.ts";
import { GENERATED_VISUALIZATION_FONTS_READY_CHANNEL } from "./visualizationFontInstallation.ts";

// Retired ephemeral sessions remain denied without callbacks that retain a
// surface, source document, parent record or decoded image buffers.
const denyPermission: NonNullable<
  Parameters<Electron.Session["setPermissionRequestHandler"]>[0]
> = (_contents, _permission, callback) => callback(false);
const denyDisplay: NonNullable<Parameters<Electron.Session["setDisplayMediaRequestHandler"]>[0]> = (
  _request,
  callback,
) => callback({});
const denyCertificate: NonNullable<Parameters<Electron.Session["setCertificateVerifyProc"]>[0]> = (
  _request,
  callback,
) => callback(-2);
const denyDownload = (event: Electron.Event): void => event.preventDefault();
const refusePermission = () => false;
const denyNetwork: NonNullable<Parameters<Electron.WebRequest["onBeforeRequest"]>[0]> = (
  _details,
  callback,
) => callback({ cancel: true });

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
    clipBounds?: VisualizationHostBounds,
    focus?: boolean,
  ): boolean;
  suspend(suspended: boolean): boolean;
  hidePresentation?(bounds: VisualizationHostBounds, clipBounds?: VisualizationHostBounds): boolean;
  isPresentationHidden?(): boolean;
  focus?(): boolean;
  send(json: string): boolean;
  isCurrent(): boolean;
  retire(budgetMs?: number): Promise<boolean>;
  diagnostics?(): VisualizationSurfaceDiagnostics;
}
export interface VisualizationSurfaceOptions {
  readonly document: VisualizationHostDocument;
  readonly preloadPath: string;
  readonly window: Electron.BrowserWindow | null;
  readonly bounds: VisualizationHostBounds;
  readonly clipBounds?: VisualizationHostBounds;
  readonly onMessage: (json: string) => void;
  readonly onWheel?: (wheel: { deltaX: number; deltaY: number }) => void;
  readonly onLayout?: (layout: VisualizationHostLayout) => void;
  readonly onTrustedFocus?: () => void;
  readonly onOwnerFocused?: () => void;
  readonly onFocusDenied?: () => void;
  /** Trusted Host membership/absolute-startup reobservation, not page input. */
  readonly admitGeneratedSource?: () => boolean;
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
  private clippingView!: Electron.View;
  private window!: Electron.BrowserWindow;
  private readonly previewWindow: boolean;
  private readonly namespace: string;
  private readonly resources = new Map<string, Buffer>();
  private readonly options: Omit<
    VisualizationSurfaceOptions,
    | "document"
    | "onMessage"
    | "onWheel"
    | "onLayout"
    | "onRevoked"
    | "onTrustedFocus"
    | "onOwnerFocused"
    | "onFocusDenied"
    | "admitGeneratedSource"
  >;
  private sourceDocument: VisualizationHostDocument | undefined;
  // Construction is inert. Mark native startup only immediately before its
  // first allocation so a failed owner-geometry preflight owns no resources,
  // while a partial native attempt can never overwrite its cleanup handles.
  private nativeCreationStarted = false;
  private sessionOwned = false;
  private protocolRegistered = false;
  private callbacks:
    | Pick<
        VisualizationSurfaceOptions,
        | "onMessage"
        | "onWheel"
        | "onLayout"
        | "onRevoked"
        | "onTrustedFocus"
        | "onOwnerFocused"
        | "onFocusDenied"
        | "admitGeneratedSource"
      >
    | undefined;
  private rendererPid = 0;
  private rootToken = "";
  private admitted = false;
  private revoked = false;
  private suspended = false;
  private presentationHidden = false;
  private visibilityCommitted = false;
  private visibilityHintSent: VisualizationSurfaceDiagnostics["visibilityHintSent"] = "not-sent";
  private paintVisibilityHintSent: VisualizationSurfaceDiagnostics["visibilityHintSent"] =
    "not-sent";
  private focusAllowedUntil = 0;
  private focusOnResume = false;
  private wheelSequence = 0;
  private readonly layoutNonce = randomUUID();
  private layoutSequence = 0;
  private layoutOutputSequence = 0;
  private layoutMeasurement: { height: number; constrained: boolean } | undefined;
  private layoutOwnerZoom = 0;
  private layoutContextEpoch = 1;
  private layoutDisplayMode: VisualizationHostDisplayMode;
  private layoutInitialReceived = false;
  private layoutEpoch = 0;
  private layoutMessages = 0;
  private layoutHeight = 0;
  private layoutConstrained = false;
  private layoutPublications = 0;
  private layoutRefusals = 0;
  private layoutRefusal: VisualizationSurfaceDiagnostics["layoutRefusal"] = "none";
  private readonly ownerFocused = (): void => {
    this.focusAllowedUntil = 0;
    this.callbacks?.onOwnerFocused?.();
  };
  private readonly downloadDenied = (event: Electron.Event): void => {
    event.preventDefault();
    this.deny();
  };
  private focusEpoch = 0;
  private focusAttempts = 0;
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
  private geometry: VisualizationGeometry | null = null;
  private geometryOutcome: VisualizationSurfaceDiagnostics["geometryOutcome"] = "uncommitted";
  private installation: { resolve: () => void; reject: (error: Error) => void } | undefined;
  // One attempt per exact child also covers the generated-only CSS await,
  // before the installation response promise exists. No retry may reparse a
  // private source in the same admitted frame or race a second replacement.
  private sourceInstallationStarted = false;
  private sourceInstallationAcknowledged = false;
  private readonly fontInstallationNonce = randomUUID();
  private fontCommitGranted = false;
  private frameObservation:
    | { token: string; resolve: () => void; reject: (error: Error) => void }
    | undefined;

  constructor(options: VisualizationSurfaceOptions) {
    const {
      document,
      onMessage,
      onWheel,
      onLayout,
      onRevoked,
      onTrustedFocus,
      onOwnerFocused,
      onFocusDenied,
      admitGeneratedSource,
      ...configuration
    } = options;
    this.options = configuration;
    this.layoutDisplayMode = options.displayMode ?? "inline";
    this.sourceDocument = document;
    this.callbacks = {
      onMessage,
      onRevoked,
      ...(onWheel ? { onWheel } : {}),
      ...(onLayout ? { onLayout } : {}),
      ...(onTrustedFocus ? { onTrustedFocus } : {}),
      ...(onOwnerFocused ? { onOwnerFocused } : {}),
      ...(onFocusDenied ? { onFocusDenied } : {}),
      ...(admitGeneratedSource ? { admitGeneratedSource } : {}),
    };
    this.namespace = `${VISUALIZATION_SCHEME}://${this.generation}`;
    this.previewWindow = options.window === null;
  }

  private createNativeSurface(): void {
    if (this.revoked || this.nativeCreationStarted)
      throw new Error("Visualization execution was refused.");
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
    const document = this.sourceDocument;
    if (!document) throw new Error("Visualization execution was refused.");
    if (options.window) {
      this.window = options.window;
      // Automatic cards can reach startup with only a tiny positive visible
      // crop. Refuse that unsafe mask before allocating an ephemeral session or
      // child; a refusal must not poison otherwise healthy preview admission.
      if (!this.readGeometry(options.bounds, options.clipBounds))
        throw new Error("Visualization bounds were refused.");
    }
    this.nativeCreationStarted = true;
    this.session = Electron.session.fromPartition(`visualization-${this.generation}`, {
      cache: false,
    });
    if (this.session.isPersistent() || this.session.getPreloadScripts().length !== 0)
      throw new Error("Visualization execution is unavailable.");
    // Never clear storage from a session which failed this ownership admission,
    // even if native unexpectedly returned a persistent or preload-bearing one.
    this.sessionOwned = true;
    this.window =
      options.window ??
      new Electron.BrowserWindow({
        show: false,
        // The admitted viewport is a content DIP contract. Native window chrome
        // must not silently subtract its caption height from a saved poster.
        useContentSize: true,
        width: document.width,
        height: document.height,
        webPreferences: {
          session: this.session,
          javascript: false,
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          devTools: false,
        },
      });
    if (!this.readGeometry(options.bounds, options.clipBounds))
      throw new Error("Visualization bounds were refused.");
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
        offscreen: this.previewWindow ? { deviceScaleFactor: PREVIEW_DEVICE_SCALE_FACTOR } : false,
      },
    });
    // Every subsequent native setter/allocation can throw. Observe this exact
    // newly owned child before touching visibility, masking or parent views so
    // partial startup can still prove destruction without adopting another PID.
    this.installNativeLifecycle();
    this.view.setVisible(false);
    this.assertStartupUnrevoked();
    // The wrapper retains themed defaults; explicit transparent author CSS may
    // reveal the host without the native view's usual opaque white backing.
    if (document.kind === "generated") this.view.setBackgroundColor("#00000000");
    this.assertStartupUnrevoked();
    // A native child sits above Cafe's DOM, so CSS overflow is not its clip.
    // Use a native parent mask without resizing the child document to whatever
    // sliver of its card currently remains inside the timeline's scroll area.
    this.clippingView = new Electron.View();
    this.assertStartupUnrevoked();
    this.clippingView.setVisible(false);
    this.assertStartupUnrevoked();
    this.window.contentView.addChildView(this.clippingView);
    this.assertStartupUnrevoked();
    if (!this.applyGeometry(options.bounds, options.clipBounds, true))
      throw new Error("Visualization bounds were refused.");
    this.assertStartupUnrevoked();
    this.clippingView.addChildView(this.view);
    this.assertStartupUnrevoked();
    this.installNativePolicy();
    this.assertStartupUnrevoked();
    this.phase = "bootstrap";
  }

  /** Native setters can synchronously emit lifecycle events. A revocation may
   * retire this exact child reentrantly, so later startup must not allocate a
   * new mask, reattach pixels or publish bootstrap after that terminal boundary. */
  private assertStartupUnrevoked(): void {
    if (this.revoked) throw new Error("Visualization execution was refused.");
  }

  private deny = (): void => {
    if (this.revoked) return;
    if (this.rejection === "none") this.rejection = "native-policy";
    this.cancelPendingGeneratedInstallation();
    this.revoked = true;
    this.hideNativePresentation();
    this.notifyVisibility();
    this.callbacks?.onRevoked();
  };

  /** Terminal refusal reaches only this exact pending generated bootstrap. A
   * quarantine may intentionally retain its live process when exclusivity is
   * uncertain; cancellation does not need or grant permission to crash it. */
  private cancelPendingGeneratedInstallation(): void {
    if (
      this.sourceDocument?.kind !== "generated" ||
      !this.sourceInstallationStarted ||
      this.sourceInstallationAcknowledged ||
      !this.admitted ||
      !this.view
    )
      return;
    try {
      const contents = this.view.webContents;
      const frame = contents.mainFrame;
      if (
        contents.isDestroyed() ||
        !Number.isSafeInteger(this.rendererPid) ||
        this.rendererPid <= 0 ||
        contents.getOSProcessId() !== this.rendererPid ||
        frame.osProcessId !== this.rendererPid ||
        frame.frameToken !== this.rootToken ||
        frame.detached ||
        frame.isDestroyed()
      )
        return;
      contents.send(VISUALIZATION_CONTEXT_CHANNEL, { kind: "cancel-install" });
    } catch {
      // Unknown frame identity remains a refusal, never permission to deliver
      // source or force-close another process. Existing quarantine owns it.
    }
  }
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

  /** Exact native observations remain installed through partial policy setup.
   * A successful close request is never itself evidence of child destruction. */
  private installNativeLifecycle(): void {
    const contents = this.view.webContents;
    contents.on("render-process-gone", () => {
      this.gone = true;
      if (!this.retiring) {
        if (this.rejection === "none") this.rejection = "renderer-exit";
        this.deny();
      }
    });
    contents.once("destroyed", () => {
      this.destroyed = true;
      if (!this.retiring) this.deny();
    });
  }

  /** Native hiding failure cannot skip the independent exact-child teardown.
   * It grants no visibility, process authority or permission to resume source. */
  private hideNativePresentation(): void {
    try {
      this.view?.setVisible(false);
    } catch {
      /* Retirement still needs positive native destruction. */
    }
    try {
      this.clippingView?.setVisible(false);
    } catch {
      /* Retain the original refusal while observing exact-child teardown. */
    }
  }

  private installNativePolicy(): void {
    let protocolAttempted = false;
    try {
      const contents = this.view.webContents;
      contents.ipc.on(GENERATED_VISUALIZATION_FONTS_READY_CHANNEL, (event, raw: unknown) => {
        this.receiveGeneratedFontReadiness(event.senderFrame, raw);
      });
      this.assertStartupUnrevoked();
      contents.ipc.on(VISUALIZATION_INSTALLED_CHANNEL, (event, succeeded: unknown) => {
        this.receiveInstallationAcknowledgement(event.senderFrame, succeeded);
      });
      this.assertStartupUnrevoked();
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
      this.assertStartupUnrevoked();
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
      this.assertStartupUnrevoked();
      this.session.setPermissionRequestHandler(denyPermission);
      this.assertStartupUnrevoked();
      this.session.setPermissionCheckHandler(refusePermission);
      this.assertStartupUnrevoked();
      this.session.setDevicePermissionHandler(refusePermission);
      this.assertStartupUnrevoked();
      this.session.setDisplayMediaRequestHandler(denyDisplay);
      this.assertStartupUnrevoked();
      this.session.on("will-download", this.downloadDenied);
      this.assertStartupUnrevoked();
      this.session.setCertificateVerifyProc(denyCertificate);
      this.assertStartupUnrevoked();
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
      this.assertStartupUnrevoked();
      // The exact fresh session/scheme belongs only to this surface. Record the
      // attempted registration before the native call: a synchronous revocation
      // can retire us inside that call, or it can throw after partially binding.
      // Both paths still require cleanup of this exact scheme, not a new owner.
      protocolAttempted = true;
      this.protocolRegistered = true;
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
      this.assertStartupUnrevoked();
      contents.setWindowOpenHandler(() => {
        this.deny();
        return { action: "deny" };
      });
      this.assertStartupUnrevoked();
      contents.on("will-frame-navigate", (event) => {
        event.preventDefault();
        if (this.rejection === "none") this.rejection = "page-navigation";
        this.deny();
      });
      this.assertStartupUnrevoked();
      contents.on("will-redirect", (event) => {
        event.preventDefault();
        this.deny();
      });
      this.assertStartupUnrevoked();
      contents.on("will-attach-webview", (event) => {
        event.preventDefault();
        this.deny();
      });
      this.assertStartupUnrevoked();
      contents.on("login", (event, _details, _authInfo, callback) => {
        event.preventDefault();
        callback();
        this.deny();
      });
      this.assertStartupUnrevoked();
      contents.on("frame-created", () => {
        if (this.admitted) {
          if (this.rejection === "none") this.rejection = "child-frame";
          this.deny();
        }
      });
      this.assertStartupUnrevoked();
      contents.on("before-mouse-event", (_event, input) => {
        if (
          input.type === "mouseDown" &&
          this.visibilityCommitted &&
          !this.suspended &&
          !this.revoked
        ) {
          this.focusAllowedUntil = performance.now() + 500;
          this.callbacks?.onTrustedFocus?.();
        }
      });
      this.assertStartupUnrevoked();
      contents.on("blur", () => {
        this.focusAllowedUntil = 0;
      });
      this.assertStartupUnrevoked();
      contents.on("focus", () => {
        // Generated autofocus/window.focus is not a user interaction. Never
        // activate an app/window; restore only the already focused exact Cafe
        // owner when source attempted to take keyboard focus without native input.
        if (
          this.sourceDocument?.kind === "generated" &&
          !this.previewWindow &&
          performance.now() > this.focusAllowedUntil &&
          !this.window.isDestroyed() &&
          this.window.isFocused() &&
          !this.window.webContents.isDestroyed()
        ) {
          const now = performance.now();
          if (now - this.focusEpoch >= 1000) {
            this.focusEpoch = now;
            this.focusAttempts = 0;
          }
          this.callbacks?.onFocusDenied?.();
          if (++this.focusAttempts > 2) this.deny();
        }
      });
      this.assertStartupUnrevoked();
      contents.ipc.on("cafe-visualization:wheel", (event, raw: unknown) => {
        if (
          this.sourceDocument?.kind !== "generated" ||
          this.previewWindow ||
          event.senderFrame !== contents.mainFrame ||
          !this.isCurrent() ||
          typeof raw !== "object" ||
          raw === null
        )
          return;
        const value = raw as { sequence?: unknown; deltaX?: unknown; deltaY?: unknown };
        if (
          Object.keys(value).length !== 3 ||
          value.sequence !== this.wheelSequence + 1 ||
          typeof value.deltaX !== "number" ||
          typeof value.deltaY !== "number" ||
          !Number.isFinite(value.deltaX) ||
          !Number.isFinite(value.deltaY) ||
          Math.abs(value.deltaX) > 2048 ||
          Math.abs(value.deltaY) > 2048
        ) {
          this.deny();
          return;
        }
        this.wheelSequence += 1;
        const now = performance.now();
        if (now - this.messageEpoch >= 1000) {
          this.messageEpoch = now;
          this.messages = 0;
        }
        if (++this.messages > 30) return;
        if (!this.visibilityCommitted || this.suspended) return;
        this.callbacks?.onWheel?.({ deltaX: value.deltaX, deltaY: value.deltaY });
      });
      this.assertStartupUnrevoked();
      contents.ipc.on("cafe-visualization:layout", (event, raw: unknown) => {
        this.receiveLayout(event.senderFrame, raw);
      });
      this.assertStartupUnrevoked();
      contents.on("did-start-navigation", (event) => {
        if (this.admitted && !event.isSameDocument) this.deny();
      });
      this.assertStartupUnrevoked();
      contents.ipc.on(VISUALIZATION_PAGE_CHANNEL, (event, raw: unknown) => {
        if (
          !this.isCurrent() ||
          this.sourceDocument?.kind !== "mcp-app" ||
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
        this.callbacks?.onMessage(message.json);
      });
      this.assertStartupUnrevoked();
      this.window.once("closed", this.ownerWindowRevoked);
      this.assertStartupUnrevoked();
      this.window.on("hide", this.ownerWindowRevoked);
      this.assertStartupUnrevoked();
      this.window.on("minimize", this.ownerWindowRevoked);
      this.assertStartupUnrevoked();
      this.window.webContents.on("did-start-navigation", this.ownerNavigationRevoked);
      this.assertStartupUnrevoked();
      this.window.webContents.on("render-process-gone", this.ownerNavigationRevoked);
      this.assertStartupUnrevoked();
      this.window.webContents.on("focus", this.ownerFocused);
      this.assertStartupUnrevoked();
    } finally {
      // Retirement can finish reentrantly inside a native registration call.
      // Its cached promise cannot undo a registration which completes later;
      // explicitly remove only our own late session/owner closures here.
      if (this.revoked) this.rollbackLateNativePolicy(protocolAttempted);
    }
  }

  private rollbackLateNativePolicy(protocolAttempted: boolean): void {
    if (this.sessionOwned) {
      if (protocolAttempted || this.protocolRegistered) {
        try {
          this.session.protocol.unhandle(VISUALIZATION_SCHEME);
          this.protocolRegistered = false;
        } catch {
          /* Revoked source/cleared resources remain unavailable on this exact scheme. */
        }
      }
      try {
        this.session.webRequest.onBeforeRequest(denyNetwork);
      } catch {
        /* This retired unique partition cannot be reused for new source. */
      }
      try {
        this.session.removeListener("will-download", this.downloadDenied);
      } catch {
        /* Native failure grants neither a new viewer nor a source reference. */
      }
    }
    this.removeOwnerObservers();
  }

  /** Loaded bytes cannot authorize private parsing. Reobserve the exact pending
   * native owner at this one-shot point even when a terminal cancel is queued
   * or was not delivered. This is an authorization point, not a claim of atomic
   * cross-process cessation after an already issued native commit. */
  private receiveGeneratedFontReadiness(sender: Electron.WebFrameMain | null, raw: unknown): void {
    if (
      this.revoked ||
      this.fontCommitGranted ||
      !this.installation ||
      !this.sourceInstallationStarted ||
      this.sourceInstallationAcknowledged ||
      this.sourceDocument?.kind !== "generated" ||
      !this.isCurrent() ||
      sender === null ||
      sender !== this.view.webContents.mainFrame ||
      sender.frameToken !== this.rootToken ||
      sender.osProcessId !== this.rendererPid ||
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 1 ||
      Reflect.get(raw, "nonce") !== this.fontInstallationNonce
    )
      return;
    // A timer callback can be delayed by main-loop load. It is cleanup, never
    // permission to authorize source after the Host's original absolute budget
    // or preparing reservation has disappeared. Keep the record closure among
    // cleared callbacks, not the retained source/configuration object.
    try {
      if (this.callbacks?.admitGeneratedSource?.() !== true) return;
    } catch {
      return;
    }
    this.fontCommitGranted = true;
    try {
      this.view.webContents.send(VISUALIZATION_CONTEXT_CHANNEL, {
        kind: "commit-install",
        nonce: this.fontInstallationNonce,
      });
    } catch {
      this.deny();
    }
  }

  private receiveInstallationAcknowledgement(
    sender: Electron.WebFrameMain | null,
    succeeded: unknown,
  ): void {
    const pending = this.installation;
    if (!pending || sender !== this.view.webContents.mainFrame || !this.isCurrent()) return;
    this.installation = undefined;
    if (
      succeeded === true &&
      (this.sourceDocument?.kind !== "generated" || this.fontCommitGranted)
    ) {
      this.sourceInstallationAcknowledged = true;
      pending.resolve();
    } else pending.reject(new Error("Visualization execution was refused."));
  }

  /** Exact isolated frame data is still adversarial presentation. It cannot
   * choose a lease, extend execution, inspect a sibling or grant Apps authority. */
  private receiveLayout(senderFrame: Electron.WebFrameMain | null, raw: unknown): void {
    const refuse = (reason: VisualizationSurfaceDiagnostics["layoutRefusal"]) => {
      this.layoutRefusal = reason;
      this.layoutRefusals = Math.min(100000, this.layoutRefusals + 1);
    };
    if (this.sourceDocument?.kind !== "generated" || this.previewWindow || !this.isCurrent()) {
      refuse("owner");
      return;
    }
    if (senderFrame !== this.view.webContents.mainFrame) {
      refuse("frame");
      return;
    }
    if (typeof raw !== "object" || raw === null) {
      refuse("invalid");
      return;
    }
    const value = raw as {
      nonce?: unknown;
      sequence?: unknown;
      height?: unknown;
      constrained?: unknown;
      contextEpoch?: unknown;
    };
    let keys = 0;
    for (const key in value) {
      if (
        !Object.hasOwn(value, key) ||
        !["nonce", "sequence", "height", "constrained", "contextEpoch"].includes(key) ||
        ++keys > 5
      ) {
        refuse("invalid");
        return;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        refuse("invalid");
        return;
      }
    }
    if (
      keys !== 5 ||
      value.nonce !== this.layoutNonce ||
      !Number.isSafeInteger(value.sequence) ||
      (value.sequence as number) < 1 ||
      (value.sequence as number) > 100000 ||
      !Number.isSafeInteger(value.height) ||
      (value.height as number) < 80 ||
      (value.height as number) > 2000 ||
      typeof value.constrained !== "boolean"
    ) {
      refuse("invalid");
      return;
    }
    // Native mode context fences queued measurements across expand/collapse.
    // This is private isolated-preload metadata, never a page-selected mode.
    if (value.contextEpoch !== this.layoutContextEpoch || this.layoutDisplayMode !== "inline") {
      refuse("geometry");
      return;
    }
    if (value.sequence !== this.layoutSequence + 1) {
      refuse("invalid");
      return;
    }
    // Consume only this exact context's valid sequence, including flood or
    // hidden refusals. An old mode's queued event cannot strand the new epoch.
    const initial = !this.layoutInitialReceived;
    this.layoutInitialReceived = true;
    this.layoutSequence += 1;
    const now = performance.now();
    if (now - this.layoutEpoch >= 1000) {
      this.layoutEpoch = now;
      this.layoutMessages = 0;
    }
    if (++this.layoutMessages > 4) {
      refuse("rate");
      return;
    }
    if (
      this.suspended ||
      (!initial && (!this.visibilityCommitted || this.observedVisibility() !== "visible"))
    ) {
      refuse("visibility");
      return;
    }
    let zoom: number;
    try {
      zoom = this.window.webContents.getZoomFactor();
    } catch {
      refuse("geometry");
      return;
    }
    if (!Number.isFinite(zoom) || zoom <= 0) {
      refuse("geometry");
      return;
    }
    this.layoutMeasurement = { height: value.height as number, constrained: value.constrained };
    this.publishLayout(zoom);
  }

  /** Remap only the already admitted private scalar. Owner zoom is not guest
   * source authority, and does not require another DOM measurement to change.
   * The publication sequence is separate from the isolated-frame input sequence
   * so a native zoom-only update cannot replay or consume a guest message. */
  private publishLayout(zoom: number): void {
    const measurement = this.layoutMeasurement;
    if (!measurement || this.layoutOutputSequence >= 100000 || !Number.isFinite(zoom) || zoom <= 0)
      return;
    // Guest CSS is native DIP at its independent zoom. Map the extent back to
    // the trusted owner page's CSS units without changing guest zoom or growing
    // the existing 2,000-DIP viewport/capture cap at owner zoom above one.
    const maximum = Math.min(2000, Math.floor(2000 / zoom));
    if (maximum < 80) {
      this.layoutRefusal = "geometry";
      this.layoutRefusals = Math.min(100000, this.layoutRefusals + 1);
      return;
    }
    const natural = Math.ceil(measurement.height / zoom);
    this.layoutHeight = Math.max(80, Math.min(maximum, natural));
    this.layoutConstrained = measurement.constrained || natural > maximum;
    this.layoutOwnerZoom = zoom;
    this.layoutPublications = Math.min(100000, this.layoutPublications + 1);
    this.layoutRefusal = "none";
    this.callbacks?.onLayout?.({
      height: this.layoutHeight,
      constrained: this.layoutConstrained,
      sequence: ++this.layoutOutputSequence,
    });
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
    for (const asset of this.sourceDocument!.assets) {
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
    this.assertStartupUnrevoked();
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
    // Native lifecycle timer: retain callback ownership, cancellation and ref/unref semantics.
    // @effect-diagnostics-next-line globalTimers:off
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
    if (!this.isCurrent() || this.installation || this.sourceInstallationStarted)
      throw new Error("Visualization execution was refused.");
    this.sourceInstallationStarted = true;
    // The isolated preload owns document.open/write and restores its relay
    // before parsing source. Main-world source receives no native bridge or
    // eval interpolation. The response-header CSP remains the native policy.
    const document = this.sourceDocument;
    if (!document) throw new Error("Visualization execution was refused.");
    if (document.kind === "generated") {
      // This is a fixed family-only policy, never received CSS. User origin
      // gives ordinary chart text the same chat family even when its immutable
      // author source declared font-family !important; code stays monospace.
      // Keep both sides of this await bound to the original native owner/frame
      // and the host's existing absolute startup/watchdog fences.
      await this.view.webContents.insertCSS(GENERATED_VISUALIZATION_FONT_FAMILY_STYLE, {
        cssOrigin: "user",
      });
      if (!this.isCurrent()) throw new Error("Visualization execution was refused.");
    }
    const dark = document.appearance === "dark";
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
      '" data-cafe-visible="false' +
      '" data-cafe-reduced-motion="' +
      String(presentation?.reducedMotion ?? false) +
      (document.kind === "generated" && !this.previewWindow
        ? '" data-cafe-presentation-visible="false'
        : "") +
      '"><meta charset="utf-8"><style>:root{color-scheme:' +
      document.appearance +
      ";--background:" +
      (dark ? "#18181b" : "#fff") +
      ";--foreground:" +
      (dark ? "#eee" : "#18181b") +
      ";" +
      colors +
      "--cafe-interface-scale:" +
      String(presentation?.scale ?? 1) +
      "}html,body{margin:0;" +
      (document.kind === "generated" ? "min-height:0;" : "min-height:100%;") +
      "background:var(--background);color:var(--foreground)}html[data-cafe-reduced-motion=true] *{animation-duration:.001ms!important;transition-duration:.001ms!important}" +
      (document.kind === "generated" ? GENERATED_VISUALIZATION_TOOLTIP_STYLE : "") +
      (document.kind === "generated" ? GENERATED_VISUALIZATION_FONT_FAMILY_STYLE : "") +
      "</style>" +
      // The fixed ordinary-page helper has no bridge/configuration authority.
      // Only generated documents receive it; unmarked source allocates no GL.
      visualizationFluidScript(document.kind) +
      document.html;
    await new Promise<void>((resolve, reject) => {
      this.installation = { resolve, reject };
      this.view.webContents.send(VISUALIZATION_CONTEXT_CHANNEL, {
        kind: "install",
        html: source,
        documentKind: document.kind,
        ...(document.kind === "generated" ? { fontInstallNonce: this.fontInstallationNonce } : {}),
        preview: this.previewWindow,
        ...(document.kind === "generated" && !this.previewWindow
          ? { layoutNonce: this.layoutNonce, layoutContextEpoch: this.layoutContextEpoch }
          : {}),
        appearance: document.appearance,
        containerDimensions: {
          width: this.view.getBounds().width,
          height: this.view.getBounds().height,
        },
        displayMode: this.options.displayMode ?? "inline",
        ...(this.options.presentation ? { presentation: this.options.presentation } : {}),
      });
    });
    if (!this.isCurrent()) throw new Error("Visualization execution was refused.");
    if (this.previewWindow) {
      this.view.setVisible(true);
      this.clippingView.setVisible(true);
    }
    this.phase = "active";
    this.notifyVisibility();
  }

  update(
    bounds: VisualizationHostBounds,
    appearance: "light" | "dark",
    presentation?: VisualizationHostPresentation,
    displayMode?: VisualizationHostDisplayMode,
    clipBounds?: VisualizationHostBounds,
    focus = false,
  ): boolean {
    if (!this.isCurrent()) return false;
    if (this.sourceDocument?.kind === "generated" && !this.previewWindow) {
      try {
        const size = this.window.getContentSize();
        const zoom = this.window.webContents.getZoomFactor();
        const windowSize = [size[0]!, size[1]!] as const;
        // Only a policy-proven positive sub-mask crop reaches retention.
        // Never reinterpret a native setBounds failure/exception as this case.
        if (
          !admitVisualizationGeometry(bounds, clipBounds, windowSize, zoom) &&
          hasVisualizationPresentationGeometry(bounds, clipBounds, windowSize, zoom)
        )
          return this.hidePresentation(bounds, clipBounds);
      } catch {
        return false;
      }
    }
    if (!this.applyGeometry(bounds, clipBounds)) return false;
    this.presentationHidden = false;
    if (displayMode && displayMode !== this.layoutDisplayMode) {
      if (this.layoutContextEpoch >= 100000) return false;
      this.layoutDisplayMode = displayMode;
      this.layoutContextEpoch += 1;
      this.layoutSequence = 0;
    }
    const viewport = this.geometry!.viewport;
    this.view.webContents.send(VISUALIZATION_CONTEXT_CHANNEL, {
      kind: "presentation",
      appearance,
      containerDimensions: { width: viewport.width, height: viewport.height },
      ...(displayMode ? { displayMode } : {}),
      layoutContextEpoch: this.layoutContextEpoch,
      ...(presentation ? { presentation } : {}),
    });
    // Host.update calls this only for its exact active native document/window
    // after trusted UI acknowledgement. A consent resume cannot manufacture
    // that first visibility commit, nor expose a currently suspended document.
    this.visibilityCommitted = true;
    this.view.setVisible(!this.suspended);
    this.clippingView.setVisible(!this.suspended);
    this.notifyVisibility();
    // A zoom-only owner update can leave natural guest layout unchanged; the
    // preload intentionally deduplicates that unchanged DOM measurement. Publish
    // its new owner-CSS mapping only after exact geometry/visibility admission.
    if (
      !this.suspended &&
      this.layoutDisplayMode === "inline" &&
      this.observedVisibility() === "visible" &&
      this.geometry!.ownerZoom !== this.layoutOwnerZoom
    )
      this.publishLayout(this.geometry!.ownerZoom);
    this.focusOnResume = focus;
    if (focus && !this.suspended && !this.previewWindow && this.window.isFocused()) {
      this.focus();
      this.focusOnResume = false;
    }
    return true;
  }

  suspend(suspended: boolean): boolean {
    if (!this.isCurrent()) return false;
    this.suspended = suspended;
    this.view.setVisible(!suspended && !this.presentationHidden && this.visibilityCommitted);
    this.clippingView.setVisible(
      !suspended && !this.presentationHidden && this.visibilityCommitted,
    );
    this.notifyVisibility();
    if (
      !suspended &&
      !this.presentationHidden &&
      this.focusOnResume &&
      this.visibilityCommitted &&
      this.window.isFocused()
    ) {
      this.focus();
      this.focusOnResume = false;
    }
    return true;
  }
  /** Hide pixels for a generated menu/tiny positive crop without renewing
   * authority, replacing the document or installing unsafe mask dimensions.
   * This cooperative animation hint is not an arbitrary-JavaScript freeze. */
  hidePresentation(bounds: VisualizationHostBounds, clipBounds?: VisualizationHostBounds): boolean {
    if (!this.isCurrent() || this.previewWindow || this.sourceDocument?.kind !== "generated")
      return false;
    try {
      const size = this.window.getContentSize();
      if (
        !hasVisualizationPresentationGeometry(
          bounds,
          clipBounds,
          [size[0]!, size[1]!],
          this.window.webContents.getZoomFactor(),
        )
      )
        return false;
      // This is the same exact positive geometry commit as ordinary update,
      // but not a native pixel exposure. An older author sees its still-in-view
      // viewport stay logically visible while the bundled paint helper pauses.
      this.visibilityCommitted = true;
      this.presentationHidden = true;
      this.view.setVisible(false);
      this.clippingView.setVisible(false);
      this.notifyVisibility();
      return true;
    } catch {
      return false;
    }
  }
  isPresentationHidden(): boolean {
    return this.presentationHidden;
  }
  /** Presentation only. Native flags/views are authoritative even when source
   * ignores this signal; it cannot grant actions or extend an execution lease. */
  private notifyVisibility(): void {
    try {
      if (!this.view || this.view.webContents.isDestroyed()) return;
      const painted = this.observedVisibility() === "visible";
      const generatedViewer = this.sourceDocument?.kind === "generated" && !this.previewWindow;
      // Native hiding for a qualified positive tiny crop/menu is presentation,
      // not logical offscreen loss. Never derive authority from the page's
      // writable dataset: exact native ownership and owner visibility decide.
      const visible =
        painted ||
        (generatedViewer &&
          this.presentationHidden &&
          this.visibilityCommitted &&
          !this.revoked &&
          !this.suspended &&
          !this.window.isDestroyed() &&
          this.window.isVisible() &&
          !this.window.isMinimized());
      if ((visible || painted) && !this.isCurrent()) return;
      const hint = visible ? "visible" : "hidden";
      // Generated geometry updates commonly repeat while the timeline scrolls.
      // Re-publishing an unchanged hint would replay an authored entrance, but
      // external Apps retain their original context notification semantics.
      if (this.sourceDocument?.kind !== "generated" || hint !== this.visibilityHintSent) {
        this.view.webContents.send(VISUALIZATION_CONTEXT_CHANNEL, { kind: "visibility", visible });
        this.visibilityHintSent = hint;
      }
      const paintHint = painted ? "visible" : "hidden";
      if (generatedViewer && paintHint !== this.paintVisibilityHintSent) {
        // Separate generated-only paint cue avoids replaying the author's
        // logical visibility observer. It pauses only cooperative bundled work;
        // hidden native layers/input/capture/focus remain independently denied.
        this.view.webContents.send(VISUALIZATION_CONTEXT_CHANNEL, {
          kind: "presentation-visibility",
          visible: painted,
        });
        this.paintVisibilityHintSent = paintHint;
      }
    } catch {
      /* Unknown native state never manufactures a visible hint. */
    }
  }
  private observedVisibility(): VisualizationSurfaceDiagnostics["nativeVisibility"] {
    if (
      !this.view ||
      this.previewWindow ||
      this.revoked ||
      this.suspended ||
      !this.visibilityCommitted
    )
      return "hidden";
    try {
      return this.view.webContents.isDestroyed() ||
        this.window.isDestroyed() ||
        !this.window.isVisible() ||
        this.window.isMinimized() ||
        !this.view.getVisible() ||
        !this.clippingView.getVisible()
        ? "hidden"
        : "visible";
    } catch {
      return "unknown";
    }
  }

  private applyGeometry(
    bounds: VisualizationHostBounds,
    clipBounds?: VisualizationHostBounds,
    initialize = false,
  ): boolean {
    try {
      const admitted = this.readGeometry(bounds, clipBounds);
      if (!admitted) {
        this.geometryOutcome = "refused";
        return false;
      }
      this.clippingView.setBounds(admitted.clip);
      if (initialize) {
        // The documented zero-duration bounds option materializes a compositor
        // layer, even at the same bounds. A positive-radius mask on that layer
        // also clips native child layers. Radius zero clears the path; Electron
        // also clears it below 32x32, which admission deliberately refuses.
        // No animation, extra WebContents, guest zoom or engine is introduced.
        this.clippingView.setBounds(admitted.clip, { animate: { duration: 0 } });
        this.clippingView.setBorderRadius(1);
      }
      const actual = this.clippingView.getBounds();
      if (
        actual.x !== admitted.clip.x ||
        actual.y !== admitted.clip.y ||
        actual.width !== admitted.clip.width ||
        actual.height !== admitted.clip.height
      ) {
        this.geometryOutcome = "refused";
        return false;
      }
      this.view.setBounds(admitted.child);
      this.geometry = admitted;
      this.geometryOutcome = admitted.clipping;
      return true;
    } catch {
      this.geometryOutcome = "refused";
      return false;
    }
  }

  /** Reobserve the exact owner for both allocation preflight and the later mask
   * commit. The preflight snapshot is never cached as permission to install a
   * stale native crop after owner size/zoom changes. */
  private readGeometry(
    bounds: VisualizationHostBounds,
    clipBounds?: VisualizationHostBounds,
  ): VisualizationGeometry | null {
    try {
      if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
        this.geometryOutcome = "refused";
        return null;
      }
      const size = this.window.getContentSize();
      const admitted = admitVisualizationGeometry(
        bounds,
        clipBounds,
        [size[0]!, size[1]!],
        this.window.webContents.getZoomFactor(),
      );
      if (!admitted) this.geometryOutcome = "refused";
      return admitted;
    } catch {
      this.geometryOutcome = "refused";
      return null;
    }
  }

  /** Exact trusted shell interaction, never a broad Tab or source DOM claim. */
  focus(): boolean {
    if (
      !this.isCurrent() ||
      this.suspended ||
      !this.visibilityCommitted ||
      this.previewWindow ||
      !this.view.getVisible() ||
      !this.window.isFocused()
    )
      return false;
    this.focusAllowedUntil = performance.now() + 500;
    this.callbacks?.onTrustedFocus?.();
    this.view.webContents.focus();
    return true;
  }

  send(json: string): boolean {
    if (
      !this.isCurrent() ||
      this.suspended ||
      this.sourceDocument?.kind !== "mcp-app" ||
      !isVisualizationMessage(json)
    )
      return false;
    this.view.webContents.send(VISUALIZATION_CONTEXT_CHANNEL, { kind: "message", json });
    return true;
  }

  async capture(): Promise<{ png: Uint8Array; width: number; height: number }> {
    if (!this.isCurrent() || this.suspended || this.presentationHidden)
      throw new Error("Visualization capture was refused.");
    if (this.frameObservation) throw new Error("Visualization capture was refused.");
    // Ordered private IPC places this barrier after replay/presentation. Two
    // real frame callbacks yield their synchronous DOM changes before capture;
    // only capturePage's actual pixels qualify the poster, never the callback.
    await new Promise<void>((resolve, reject) => {
      const token = randomUUID();
      this.frameObservation = { token, resolve, reject };
      this.view.webContents.send(VISUALIZATION_CONTEXT_CHANNEL, { kind: "frame", token });
    });
    if (!this.isCurrent() || this.suspended || this.presentationHidden)
      throw new Error("Visualization capture was refused.");
    this.captureOutcome = "native-error";
    const bounds = this.view.getBounds();
    const zoom = this.window.webContents.getZoomFactor();
    if (!this.geometry || zoom !== this.geometry.ownerZoom)
      throw new Error("Visualization capture was refused.");
    const display = Electron.screen.getDisplayMatching(this.window.getBounds());
    // Keep the original owner-display/resource admission even for a preview:
    // its independent fixed offscreen scale cannot excuse unknown native
    // display metadata or exceed the existing physical-work envelope.
    const displayTuple = admitVisualizationCapture(
      bounds.width,
      bounds.height,
      display.scaleFactor,
    );
    if (!displayTuple) throw new Error("Visualization capture was refused.");
    // Electron 43's native CapturePage uses the view's configured device scale.
    // A private preview is explicitly configured at 1x above; visible viewers
    // retain the original display-DPR tuple and every surrounding owner guard.
    const tuple = this.previewWindow
      ? admitVisualizationCapture(bounds.width, bounds.height, PREVIEW_DEVICE_SCALE_FACTOR)
      : displayTuple;
    if (!tuple) throw new Error("Visualization capture was refused.");
    const image = await this.view.webContents.capturePage(
      { x: 0, y: 0, width: bounds.width, height: bounds.height },
      { stayHidden: true, stayAwake: true },
    );
    if (image.isEmpty()) this.captureOutcome = "empty";
    if (!this.isCurrent() || this.suspended || this.presentationHidden || image.isEmpty())
      throw new Error("Visualization capture was refused.");
    const size = image.getSize();
    const currentBounds = this.view.getBounds();
    const currentDisplay = Electron.screen.getDisplayMatching(this.window.getBounds());
    if (
      !matchesVisualizationCapture(tuple, size) ||
      currentDisplay.id !== display.id ||
      currentDisplay.scaleFactor !== displayTuple.dpr ||
      this.window.webContents.getZoomFactor() !== zoom ||
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

  retire(budgetMs = VISUALIZATION_HOST_RETIRE_MS): Promise<boolean> {
    if (this.retiring) return this.retiring;
    this.cancelPendingGeneratedInstallation();
    this.revoked = true;
    this.installation?.reject(new Error("Visualization execution was refused."));
    this.installation = undefined;
    this.frameObservation?.reject(new Error("Visualization capture was refused."));
    this.frameObservation = undefined;
    this.phase = "retiring";
    if (this.watchdog) clearInterval(this.watchdog);
    if (!this.view) {
      try {
        if (this.previewWindow && this.window && !this.window.isDestroyed()) this.window.destroy();
      } catch {
        /* A destroy request alone is not private-window retirement evidence. */
      }
      const retired = this.privateWindowRetired();
      this.retiring = Promise.resolve(retired);
      if (retired) this.clearRetiredResources();
      this.phase = retired ? "retired" : "quarantined";
      return this.retiring;
    }
    this.hideNativePresentation();
    this.notifyVisibility();
    const contents = this.view.webContents;
    const needsRendererExit = this.rendererPid > 0;
    this.retiring = new Promise<boolean>((resolve) => {
      const end =
        performance.now() +
        (Number.isFinite(budgetMs)
          ? Math.max(0, Math.min(VISUALIZATION_HOST_RETIRE_MS, budgetMs))
          : 0);
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
        if (this.destroyed && (!needsRendererExit || this.gone) && this.privateWindowRetired()) {
          finish(true);
          return;
        }
        if (performance.now() >= end) {
          finish(false);
          return;
        }
        // Native lifecycle timer: retain callback ownership, cancellation and ref/unref semantics.
        // @effect-diagnostics-next-line globalTimers:off
        setTimeout(tick, 10);
      };
      const finish = (retired: boolean) => {
        this.phase = retired ? "retired" : "quarantined";
        if (retired) this.clearRetiredResources();
        this.removeOwnerObservers();
        resolve(retired);
      };
      try {
        this.clippingView?.removeChildView(this.view);
      } catch {
        /* A failed detach cannot suppress an independent exact close request. */
      }
      try {
        if (this.clippingView) this.window.contentView.removeChildView(this.clippingView);
      } catch {
        /* The exact child's observed destruction still owns completion. */
      }
      try {
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
      } catch {
        /* Native uncertainty is reported by the finite observation below. */
      }
      try {
        if (this.previewWindow && !this.window.isDestroyed()) this.window.destroy();
      } catch {
        /* Keep a failed private-window destroy inconclusive, not successful. */
      }
      tick();
    });
    return this.retiring;
  }

  /** Only the allocated private preview window belongs to this surface. An
   * ordinary Cafe owner must remain alive and must never be destroyed here. */
  private privateWindowRetired(): boolean {
    if (!this.previewWindow || !this.window) return true;
    try {
      return this.window.isDestroyed();
    } catch {
      return false;
    }
  }

  /** Cleanup follows positive exact-native teardown, including session-only
   * and no-view startup. The admitted ephemeral partition is never reused; a
   * clear failure cannot authorize later source or touch an ordinary profile. */
  private clearRetiredResources(): void {
    this.resources.clear();
    this.sourceDocument = undefined;
    this.callbacks = undefined;
    if (!this.sessionOwned) return;
    if (this.protocolRegistered) {
      try {
        this.session.protocol.unhandle(VISUALIZATION_SCHEME);
        this.protocolRegistered = false;
      } catch {
        /* Retired source/resources stay unavailable even if native unregister fails. */
      }
    }
    try {
      this.session.webRequest.onBeforeRequest(denyNetwork);
    } catch {
      /* This unique retired partition cannot gain another execution owner. */
    }
    try {
      this.session.removeListener("will-download", this.downloadDenied);
      this.session.on("will-download", denyDownload);
    } catch {
      /* No live owned WebContents remains after successful native teardown. */
    }
    try {
      void this.session.clearStorageData().catch(() => undefined);
    } catch {
      /* Never replace original destruction evidence with storage-cleanup failure. */
    }
  }

  private removeOwnerObservers(): void {
    try {
      this.window.removeListener("closed", this.ownerWindowRevoked);
      this.window.removeListener("hide", this.ownerWindowRevoked);
      this.window.removeListener("minimize", this.ownerWindowRevoked);
      if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
        this.window.webContents.removeListener("did-start-navigation", this.ownerNavigationRevoked);
        this.window.webContents.removeListener("render-process-gone", this.ownerNavigationRevoked);
        this.window.webContents.removeListener("focus", this.ownerFocused);
      }
    } catch {
      /* Failed observer removal grants neither native ownership nor source authority. */
    }
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
      geometryOutcome: this.geometryOutcome,
      viewportWidth: this.geometry?.viewport.width ?? 0,
      viewportHeight: this.geometry?.viewport.height ?? 0,
      clipWidth: this.geometry?.clip.width ?? 0,
      clipHeight: this.geometry?.clip.height ?? 0,
      ownerZoom: this.geometry?.ownerZoom ?? 0,
      nativeVisibility: this.observedVisibility(),
      visibilityHintSent: this.visibilityHintSent,
      visibilityCommitted: this.visibilityCommitted,
      layoutHeight: this.layoutHeight,
      layoutConstrained: this.layoutConstrained,
      layoutSequence: this.layoutOutputSequence,
      layoutPublications: this.layoutPublications,
      layoutRefusals: this.layoutRefusals,
      layoutRefusal: this.layoutRefusal,
    };
  }
}
