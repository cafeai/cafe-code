import * as Electron from "electron";
import { randomUUID } from "node:crypto";
// Opt-in native fixture keeps its existing Electron-owned screenshot/result-file Promise lifecycle.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile, writeFile } from "node:fs/promises";
// Native path boundary: preserve host drive, namespace and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { DesktopVisualizationHost } from "./DesktopVisualizationHost.ts";
import { VISUALIZATION_FLUID_DIAGNOSTIC_COUNTER_MAX } from "@cafecode/shared/visualizationFluidRuntime";
import { ElectronVisualizationSurface } from "./ElectronVisualizationSurface.ts";
import { VISUALIZATION_SCHEME, VISUALIZATION_EVENT_CHANNEL } from "./visualizationHostPolicy.ts";
import {
  configureNativeVisualizationFixtureDriver,
  isSandboxedNativeFixtureDriver,
  nativeFixtureClippedCaptureObservation,
} from "./nativeVisualizationFixturePolicy.ts";
import {
  hasNativeFixtureClippedBlackContent,
  nativeFixtureClippedSampleOffsets,
} from "./nativeVisualizationFixturePixels.ts";
import type {
  VisualizationHostEvent,
  VisualizationHostPresentation,
  VisualizationHostDocument,
  VisualizationHostLayout,
} from "@cafecode/contracts/visualizationHost";

/** Bounded fixture observation only; production adds no polling or transcript. */
async function observed(predicate: () => boolean): Promise<void> {
  const until = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= until) throw new Error("Native fixture observation unavailable.");
    // Native-host fixture: preserve its existing wall-clock budget and callback cleanup.
    // @effect-diagnostics-next-line globalTimers:off
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** Fixed synthetic DOM reads observe native event delivery, never fake it. */
async function observedNativeDom(
  contents: Electron.WebContents,
  expression: string,
  classification: string,
): Promise<void> {
  const until = performance.now() + 5_000;
  let fluidDiagnostic = "";
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([
      contents.executeJavaScript(expression),
      new Promise<false>((resolve) => {
        // Native-host fixture: preserve its existing wall-clock budget and callback cleanup.
        // @effect-diagnostics-next-line globalTimers:off
        timer = setTimeout(() => resolve(false), Math.max(0, until - performance.now()));
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (ready === true) return;
    if (
      [
        "actual fluid static resources",
        "sustained swirl midpoint",
        "representative chart fluid",
      ].includes(classification) &&
      ready &&
      typeof ready === "object"
    ) {
      const value = ready as Record<string, unknown>;
      if (value.fluidReady === true) return;
      const finite = (key: string, max: number) =>
        typeof value[key] === "number" &&
        Number.isInteger(value[key]) &&
        (value[key] as number) >= 0 &&
        (value[key] as number) <= max
          ? value[key]
          : null;
      const flag = (key: string) => (typeof value[key] === "boolean" ? value[key] : null);
      const scalar = (key: string, max: number) =>
        typeof value[key] === "number" &&
        Number.isFinite(value[key]) &&
        (value[key] as number) >= 0 &&
        (value[key] as number) <= max
          ? value[key]
          : null;
      const state =
        typeof value.state === "string" &&
        [
          "running",
          "waiting",
          "paused",
          "static",
          "idle",
          "context-lost",
          "unsupported",
          "disposed",
        ].includes(value.state)
          ? value.state
          : "unknown";
      fluidDiagnostic = JSON.stringify({
        state,
        frames: finite("frames", VISUALIZATION_FLUID_DIAGNOSTIC_COUNTER_MAX),
        textures: finite("textures", 8),
        programs: finite("programs", 10),
        buffers: finite("buffers", 2),
        textureBytes: finite("textureBytes", 16 * 1024 * 1024),
        canvasWidth: finite("canvasWidth", 512),
        canvasHeight: finite("canvasHeight", 512),
        raf: flag("raf"),
        nativeVisible: flag("nativeVisible"),
        nativeReduced: flag("nativeReduced"),
        documentHidden: flag("documentHidden"),
        rejectedWidth: scalar("rejectedWidth", 4000),
        rejectedHeight: scalar("rejectedHeight", 4000),
        rejectedDpr: scalar("rejectedDpr", 16),
      });
    }
    if (performance.now() >= until) {
      if (fluidDiagnostic) process.stderr.write(`Native fixture fluid state: ${fluidDiagnostic}\n`);
      throw new Error(`Native fixture ${classification} delivery unavailable.`);
    }
    // Native-host fixture: preserve its existing wall-clock budget and callback cleanup.
    // @effect-diagnostics-next-line globalTimers:off
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** The first hidden-bootstrap extent can precede final width layout. Consume
 * the latest exact native scalar matching this fixed chart's natural root,
 * instead of treating root-scroll fit in a too-large viewport as tightness. */
async function settledChartLayout(
  contents: Electron.WebContents,
  latest: () => VisualizationHostLayout | undefined,
): Promise<VisualizationHostLayout> {
  const until = performance.now() + 5_000;
  while (true) {
    const before = latest();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const extent: unknown = await Promise.race([
      contents.executeJavaScript(
        "(()=>{const body=document.body,unit=document.querySelector('.unit'),padding=Number.parseFloat(getComputedStyle(body).paddingBottom)||0;return Math.ceil(unit.getBoundingClientRect().bottom-body.getBoundingClientRect().top+padding)})()",
      ),
      new Promise<undefined>((resolve) => {
        // Native-host fixture: preserve its existing wall-clock budget and callback cleanup.
        // @effect-diagnostics-next-line globalTimers:off
        timer = setTimeout(() => resolve(undefined), Math.max(0, until - performance.now()));
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    const after = latest();
    if (
      before &&
      after &&
      before.sequence === after.sequence &&
      typeof extent === "number" &&
      Number.isSafeInteger(extent) &&
      after.height === extent &&
      after.height > 180 &&
      after.height < 700 &&
      !after.constrained
    )
      return after;
    if (performance.now() >= until) throw new Error("Native settled chart extent unavailable.");
    // Native-host fixture: preserve its existing wall-clock budget and callback cleanup.
    // @effect-diagnostics-next-line globalTimers:off
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function scalar(record: Record<string, unknown>, key: string, max: number, min = 0) {
  return typeof record[key] === "number" &&
    Number.isFinite(record[key]) &&
    (record[key] as number) >= min &&
    (record[key] as number) <= max
    ? record[key]
    : null;
}

/** One bounded synthetic snapshot at a known chart boundary. This is not a
 * production diagnostic or trusted page lifecycle proof. Never retain text,
 * source, identifiers, selectors supplied by a page, or a DOM/node dump. */
async function chartSnapshot(
  contents: Electron.WebContents,
  boundary: "selected" | "applied" | "capture" | "color",
  native: {
    selectedHeight: number;
    selectedSequence: number;
    latestHeight: number;
    latestSequence: number;
    ownerZoom: number;
    nativeWidth: number;
    nativeHeight: number;
  },
): Promise<void> {
  const raw: unknown = await contents.executeJavaScript(`(()=>{
    const body=document.body,unit=document.querySelector('.unit'),foot=document.querySelector('.foot'),canvas=document.querySelector('canvas[data-cafe-fluid]');
    const bodyRect=body.getBoundingClientRect(),unitRect=unit.getBoundingClientRect(),footRect=foot.getBoundingClientRect(),canvasRect=canvas.getBoundingClientRect();
    const padding=Number.parseFloat(getComputedStyle(body).paddingBottom)||0;
    let rootNodes=0,elementExtent=0,textExtent=0,node=body.firstChild;
    for(;node&&rootNodes<128;node=node.nextSibling){rootNodes++;let bottom,margin=0;
      if(node.nodeType===1){const style=getComputedStyle(node);if(style.display==='none'||style.position==='fixed'||style.position==='absolute')continue;bottom=node.getBoundingClientRect().bottom;margin=Number.parseFloat(style.marginBottom)||0;elementExtent=Math.max(elementExtent,bottom-bodyRect.top+Math.max(0,margin));}
      else if(node.nodeType===3){const range=document.createRange();range.selectNodeContents(node);bottom=range.getBoundingClientRect().bottom;textExtent=Math.max(textExtent,bottom-bodyRect.top);} }
    return {innerWidth,innerHeight,rootScrollHeight:document.scrollingElement.scrollHeight,bodyTop:bodyRect.top,bodyHeight:bodyRect.height,bodyBottom:bodyRect.bottom,paddingBottom:padding,unitHeight:unitRect.height,unitBottom:unitRect.bottom,footerBottom:footRect.bottom,rootNodes,rootLimited:node!==null,elementExtent,textExtent,naturalHeight:Math.ceil(Math.max(elementExtent,textExtent)+padding),canvasCSSWidth:canvasRect.width,canvasCSSHeight:canvasRect.height,canvasWidth:canvas.width,canvasHeight:canvas.height,state:canvas.dataset.cafeFluidState,frames:Number(canvas.dataset.cafeFluidFrames),textures:Number(canvas.dataset.cafeFluidTextures),programs:Number(canvas.dataset.cafeFluidPrograms),buffers:Number(canvas.dataset.cafeFluidBuffers),textureBytes:Number(canvas.dataset.cafeFluidTextureBytes),raf:canvas.dataset.cafeFluidRaf==='true',nativeVisible:document.documentElement.dataset.cafeVisible==='true',nativeReduced:document.documentElement.dataset.cafeReducedMotion==='true',documentHidden:document.hidden};
  })()`);
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const flag = (key: string) => (typeof value[key] === "boolean" ? value[key] : null);
  const state =
    typeof value.state === "string" &&
    [
      "running",
      "waiting",
      "paused",
      "static",
      "idle",
      "context-lost",
      "unsupported",
      "disposed",
    ].includes(value.state)
      ? value.state
      : "unknown";
  const snapshot = {
    boundary,
    selectedHeight: scalar(native, "selectedHeight", 2000),
    selectedSequence: scalar(native, "selectedSequence", 100000),
    latestHeight: scalar(native, "latestHeight", 2000),
    latestSequence: scalar(native, "latestSequence", 100000),
    ownerZoom: scalar(native, "ownerZoom", 16),
    nativeWidth: scalar(native, "nativeWidth", 1600),
    nativeHeight: scalar(native, "nativeHeight", 2000),
    innerWidth: scalar(value, "innerWidth", 2000),
    innerHeight: scalar(value, "innerHeight", 2000),
    rootScrollHeight: scalar(value, "rootScrollHeight", 4000),
    bodyTop: scalar(value, "bodyTop", 4000, -4000),
    bodyHeight: scalar(value, "bodyHeight", 4000),
    bodyBottom: scalar(value, "bodyBottom", 4000, -4000),
    paddingBottom: scalar(value, "paddingBottom", 4000),
    unitHeight: scalar(value, "unitHeight", 4000),
    unitBottom: scalar(value, "unitBottom", 4000, -4000),
    footerBottom: scalar(value, "footerBottom", 4000, -4000),
    rootNodes: scalar(value, "rootNodes", 128),
    rootLimited: flag("rootLimited"),
    elementExtent: scalar(value, "elementExtent", 4000),
    textExtent: scalar(value, "textExtent", 4000),
    naturalHeight: scalar(value, "naturalHeight", 4000),
    canvasCSSWidth: scalar(value, "canvasCSSWidth", 1600),
    canvasCSSHeight: scalar(value, "canvasCSSHeight", 2000),
    canvasWidth: scalar(value, "canvasWidth", 512),
    canvasHeight: scalar(value, "canvasHeight", 512),
    state,
    frames: scalar(value, "frames", VISUALIZATION_FLUID_DIAGNOSTIC_COUNTER_MAX),
    textures: scalar(value, "textures", 8),
    programs: scalar(value, "programs", 10),
    buffers: scalar(value, "buffers", 2),
    textureBytes: scalar(value, "textureBytes", 16 * 1024 * 1024),
    raf: flag("raf"),
    nativeVisible: flag("nativeVisible"),
    nativeReduced: flag("nativeReduced"),
    documentHidden: flag("documentHidden"),
  };
  process.stderr.write(`Native fixture chart snapshot: ${JSON.stringify(snapshot)}\n`);
}

const presentation: VisualizationHostPresentation = {
  locale: "en",
  reducedMotion: false,
  scale: 1,
  colors: {
    background: "#ffffff",
    foreground: "#18181b",
    muted: "#555555",
    accent: "#3355ff",
    accentForeground: "#ffffff",
    chart1: "#111111",
    chart2: "#222222",
    chart3: "#333333",
    chart4: "#444444",
    chart5: "#555555",
    chart6: "#666666",
  },
};

/** Inspect actual encoded capture pixels, not only a PNG header or DOM claim. */
function hasFixtureColor(png: Uint8Array, red: number, green: number, blue: number): boolean {
  const image = Electron.nativeImage.createFromBuffer(Buffer.from(png));
  if (image.isEmpty()) return false;
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const offset = ((size.height - 10) * size.width + size.width - 10) * 4;
  return (
    bitmap[offset] === blue &&
    bitmap[offset + 1] === green &&
    bitmap[offset + 2] === red &&
    bitmap[offset + 3] === 255
  );
}

/** The deliberate scrolling case includes a native legacy scrollbar on some
 * hosts. Keep its exact viewport and compare independently known page-content
 * points, never the scrollbar gutter or a requested DOM colour alone. */
function hasClippedFixtureContent(png: Uint8Array): boolean {
  const image = Electron.nativeImage.createFromBuffer(Buffer.from(png));
  if (image.isEmpty()) return false;
  const size = image.getSize();
  return hasNativeFixtureClippedBlackContent(image.toBitmap(), size.width, size.height);
}
/** Colour variation is read from real native PNG samples, not a source claim. */
function hasFixtureSwirl(png: Uint8Array): boolean {
  const image = Electron.nativeImage.createFromBuffer(Buffer.from(png));
  if (image.isEmpty()) return false;
  const size = image.getSize(),
    bitmap = image.toBitmap();
  // The real fluid has dark negative space, unlike an all-screen polar shader.
  // Bound actual capture samples and require many vivid, spatially different
  // pixels; caption/veil text alone cannot satisfy this decoration assertion.
  const colors: number[][] = [];
  for (let y = 2; y < 10; y++)
    for (let x = 1; x < 20; x++) {
      const offset =
        (Math.floor((size.height * y) / 10) * size.width + Math.floor((size.width * x) / 20)) * 4;
      const color = [
        bitmap[offset]!,
        bitmap[offset + 1]!,
        bitmap[offset + 2]!,
        bitmap[offset + 3]!,
      ];
      if (
        color[3] === 255 &&
        Math.max(...color.slice(0, 3)) - Math.min(...color.slice(0, 3)) > 20 &&
        Math.max(...color.slice(0, 3)) > 60
      )
        colors.push(color);
    }
  return (
    colors.length > 20 &&
    Math.max(...colors.map((color) => color[0]!)) - Math.min(...colors.map((color) => color[0]!)) >
      20
  );
}

/** Fixed phase markers preserve timeout evidence without source/event data. */
function phase(value: string): void {
  process.stderr.write(`Native fixture phase: ${value}\n`);
}

// Independently authored SDK-equivalent fixture waits for both exact private
// replay notifications. Its colored poster is impossible before initialization.
const previewAppSource = `<script>
let input=false;
window.addEventListener('message',event=>{
 if(event.source!==window.parent || !event.data || event.data.jsonrpc!=='2.0') return;
 if(event.data.id===1&&event.data.result) window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');
 if(event.data.method==='ui/notifications/tool-input') input=event.data.params.arguments.exact==='private input';
 if(event.data.method==='ui/notifications/tool-result'&&input&&event.data.params.content[0].text==='private result') {
  document.body.style.background='#000000'; document.body.style.color='#ffffff'; document.body.style.minHeight='100vh';
  document.body.textContent='Replayed poster';
 }
});
window.parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appCapabilities:{},appInfo:{name:'fixture',version:'1'}}},'*');
</script>`;

// The actual supplied licensed fluid runtime is bundled by the generated-only
// production wrapper. This fixture contributes only its single marker, local
// frosted veil, readable chart text and an unprivileged context-loss trigger.
// No approximation, copied second solver or native authority is exposed here.
const webglSource = `<style>html,body{height:100%;background:#04070f!important}canvas{position:fixed;inset:0;display:block;width:100%;height:100%}#veil{position:fixed;inset:0;pointer-events:none;background:linear-gradient(120deg,rgba(255,255,255,.18),rgba(240,242,255,.06))}#caption{position:fixed;left:12px;top:12px;color:#fff;font:600 14px system-ui;pointer-events:none}#fallback{position:fixed;bottom:12px;left:12px;color:#fff;margin:0;font:12px system-ui}</style>
<canvas data-cafe-fluid aria-hidden="true"></canvas><div id="veil" aria-hidden="true"></div><span id="caption">Chart accent</span><p id="fallback">Fluid chart background</p><script>
window.fixtureLoseContext=()=>{const canvas=document.querySelector('canvas[data-cafe-fluid]');const gl=canvas.getContext('webgl2')||canvas.getContext('webgl');gl?.getExtension('WEBGL_lose_context')?.loseContext();};
</script>`;

/** Only this fixture's known native view hierarchy is inspected, never user
 * windows, desktop thumbnails, screen recording or ordinary Cafe UI. */
function fixtureView(
  window: Electron.BrowserWindow,
  generation: string,
): Electron.WebContentsView | undefined {
  return window.contentView.children
    .flatMap((child) => [child, ...child.children])
    .find(
      (child): child is Electron.WebContentsView =>
        child instanceof Electron.WebContentsView &&
        child.webContents.getURL() === `${VISUALIZATION_SCHEME}://${generation}/bootstrap`,
    );
}

// This is the official transport's relevant source===parent/JSON-RPC listener
// behavior, independently authored for the fixture. No SDK is installed. A real
// self-posted request must be consumed across worlds before this listener; only
// native synthetic replies and initialized host-context updates may reach it.
const appSource = `<h1>Native App</h1><input aria-label="Fixture text" value="text selection"><script>
let selfRequestsSeen=0;
window.addEventListener('message',event=>{
 if(event.source!==window.parent || !event.data || event.data.jsonrpc!=='2.0') return;
 if(event.data.method==='ui/initialize') selfRequestsSeen++;
 if(event.data.id===1 && event.data.result) {
  const context=event.data.result.hostContext;
  let workerDenied=false,connectDenied=false;
  const policy=new Promise(resolve=>{
   document.addEventListener('securitypolicyviolation',event=>{
    if(event.effectiveDirective==='worker-src') workerDenied=true;
    if(event.effectiveDirective==='connect-src') connectDenied=true;
    if(workerDenied&&connectDenied) resolve(true);
   });
   setTimeout(()=>resolve(false),500);
  });
  try {new Worker(URL.createObjectURL(new Blob(['postMessage(1)'],{type:'text/javascript'})))} catch {}
  fetch('https://127.0.0.1:1/fixture-network-refusal').catch(()=>{});
  policy.then(()=>{
   window.parent.postMessage({jsonrpc:'2.0',method:'fixture/report',params:{selfRequestsSeen,context,workerDenied,connectDenied,
    requireAbsent:typeof require==='undefined',bridgeAbsent:typeof window.desktopBridge==='undefined',
    accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()}},'*');
  });
 }
 if(event.data.method==='ui/notifications/host-context-changed') window.parent.postMessage({jsonrpc:'2.0',method:'fixture/context',params:event.data.params},'*');
});
window.dispatchEvent(new MessageEvent('message',{source:window.parent,data:{jsonrpc:'2.0',method:'fixture/forged'}}));
window.parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appCapabilities:{},appInfo:{name:'fixture',version:'1'}}},'*');
</script>`;

// Never open Electron's default modal error dialog in an isolated automation
// fixture. It could keep a synthetic process alive after its parent times out.
process.on("uncaughtException", (error: Error) => {
  process.stderr.write(`Native fixture exception: ${error.message}\n`);
  Electron.app.exit(1);
});

/** Explicit synthetic native fixture, bundled only by its opt-in test. */
async function qualify(): Promise<void> {
  const directory = process.argv[2];
  if (!directory) throw new Error("Isolated fixture directory is required.");
  const softwareDriver = configureNativeVisualizationFixtureDriver(
    Electron.app,
    process.platform,
    "comprehensive",
  );
  Electron.app.setPath("userData", join(directory, "profile"));
  Electron.app.setPath("sessionData", join(directory, "session"));
  Electron.protocol.registerSchemesAsPrivileged([
    { scheme: VISUALIZATION_SCHEME, privileges: { standard: true, secure: true } },
  ]);
  await Electron.app.whenReady();
  if (softwareDriver && !isSandboxedNativeFixtureDriver(await Electron.app.getGPUInfo("complete")))
    throw new Error("Native fixture sandboxed graphics mode unavailable.");
  const graphics = softwareDriver ? "sandboxed-swiftshader" : "native-default";
  // Use one supported synthetic-app activation policy before constructing any
  // windows. Unlike legacy repeated DockHide/TransformProcessType transitions,
  // accessory explicitly permits visible, programmatically activated windows
  // without a Dock icon. This never changes production or OS settings.
  if (process.platform === "darwin") Electron.app.setActivationPolicy("accessory");
  const window = new Electron.BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: {
      javascript: false,
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
    },
  });
  const layoutEvents: VisualizationHostEvent[] = [];
  const layoutNativeSend = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel: string, ...args: unknown[]) => {
    if (channel === VISUALIZATION_EVENT_CHANNEL) {
      const event = args[0] as VisualizationHostEvent;
      if (event.state === "layout" && layoutEvents.length < 128) layoutEvents.push(event);
    }
    layoutNativeSend(channel, ...args);
  };
  // Native macOS occlusion can emit `hide` even while isVisible() remains
  // true. Keep only this synthetic owner at the ordinary floating level so
  // unrelated foreground windows do not invalidate the compositing fixture.
  // This is a normal focusable window, not an OS policy or production change.
  // Real hide/minimize observations below remain authoritative: never restore
  // an active owner in response to those events, and still qualify deliberate
  // owner.hide() retirement at the end of the fixture.
  if (process.platform === "darwin") {
    window.setAlwaysOnTop(true, "floating");
    if (!window.isAlwaysOnTop()) throw new Error("Native fixture compositing owner unavailable.");
  }
  // Fixed, capped lifecycle observations distinguish our exact JS requests
  // from native/OS visibility events without stacks, source or private IDs.
  // Observation never restores/ignores an active owner's real hide event.
  let lifecycleCount = 0;
  const lifecycle = (
    label:
      | "owner-native-hide"
      | "owner-native-show"
      | "owner-native-minimize"
      | "owner-native-closed"
      | "owner-native-focus"
      | "owner-native-blur"
      | "owner-js-hide"
      | "owner-js-show"
      | "app-js-hide"
      | "app-native-active"
      | "app-native-inactive",
  ): void => {
    if (lifecycleCount === 64) return;
    lifecycleCount += 1;
    const destroyed = window.isDestroyed();
    process.stderr.write(
      `Native fixture lifecycle: ${JSON.stringify({
        label,
        appHidden: process.platform === "darwin" && Electron.app.isHidden(),
        appActive: process.platform === "darwin" && Electron.app.isActive(),
        ownerVisible: !destroyed && window.isVisible(),
        ownerMinimized: !destroyed && window.isMinimized(),
        ownerDestroyed: destroyed,
      })}\n`,
    );
  };
  const hideOwner = window.hide.bind(window);
  window.hide = () => {
    lifecycle("owner-js-hide");
    hideOwner();
  };
  const showOwner = window.show.bind(window);
  window.show = () => {
    lifecycle("owner-js-show");
    showOwner();
  };
  if (process.platform === "darwin") {
    const hideApp = Electron.app.hide.bind(Electron.app);
    Electron.app.hide = () => {
      lifecycle("app-js-hide");
      hideApp();
    };
    Electron.app.on("did-become-active", () => lifecycle("app-native-active"));
    Electron.app.on("did-resign-active", () => lifecycle("app-native-inactive"));
  }
  window.on("hide", () => lifecycle("owner-native-hide"));
  window.on("show", () => lifecycle("owner-native-show"));
  window.on("minimize", () => lifecycle("owner-native-minimize"));
  window.on("closed", () => lifecycle("owner-native-closed"));
  window.on("focus", () => lifecycle("owner-native-focus"));
  window.on("blur", () => lifecycle("owner-native-blur"));
  await window.loadURL("data:text/html,<html><body>isolated owner</body></html>");
  // Normal accessible native views require a genuinely composited owner. This
  // is the fixture's own window only, never the running Cafe window or profile.
  window.show();
  Electron.app.focus({ steal: true });
  window.focus();
  await observed(() => window.isFocused());
  let poolViewerPids: number[] = [];
  let poolPreviewPid = 0;
  let poolFluidPreview = false;
  let refuseNextMaskAttachment = false;
  // One fixture-owned reference supplies generation-bound failure evidence.
  // Host.diagnostics().native can intentionally describe the last retirement;
  // it is not evidence about a currently active capture. No map or native
  // ownership capability is exposed or retained beyond this bounded fixture.
  let latestViewerSurface: ElectronVisualizationSurface | undefined;
  const host = new DesktopVisualizationHost({
    stateDirectory: directory,
    preloadPath: join(directory, "visualizationPreload.cjs"),
    // Use the production surface unchanged. The private capture wrapper reads
    // only the exact newly created fixture generation while four known viewers
    // are live, proving the fifth renderer is actually distinct before pixels.
    createSurface: (options) => {
      const surface = new ElectronVisualizationSurface(options);
      if (options.window === window) latestViewerSurface = surface;
      if (options.window === window && refuseNextMaskAttachment) {
        refuseNextMaskAttachment = false;
        const initialize = surface.initialize.bind(surface);
        surface.initialize = async () => {
          // Scope a single controlled failure to this fixture's exact native
          // parent, after real child allocation and before bootstrap/source.
          // The production lifecycle/retirement methods remain unchanged.
          const parent = window.contentView;
          const add = parent.addChildView;
          parent.addChildView = () => {
            throw new Error("Native synthetic mask attachment refusal.");
          };
          try {
            await initialize();
          } finally {
            parent.addChildView = add;
          }
        };
      }
      if (options.window === null) {
        const capture = surface.capture.bind(surface);
        surface.capture = async () => {
          const contents = Electron.webContents
            .getAllWebContents()
            .find(
              (value) =>
                value.getURL() === `${VISUALIZATION_SCHEME}://${surface.generation}/bootstrap`,
            );
          // Before any fluid poster, observe the exact fixed helper's solved
          // state/resources on this synthetic source, not merely fallback CSS.
          if (options.document.html.includes("data-cafe-fluid")) {
            if (!contents) throw new Error("Native fluid preview owner missing.");
            await observedNativeDom(
              contents,
              "(()=>{const c=document.querySelector('canvas[data-cafe-fluid]');return c?.dataset.cafeFluidTextures==='8'&&c.dataset.cafeFluidFrames==='12'&&c.dataset.cafeFluidRaf==='false'})()",
              "actual fluid static preview",
            );
          }
          if (poolViewerPids.length === 4) {
            const pid = contents?.getOSProcessId() ?? 0;
            if (
              !contents ||
              pid <= 0 ||
              poolViewerPids.includes(pid) ||
              contents.mainFrame.framesInSubtree.length !== 1 ||
              !surface.diagnostics().exclusiveProcess
            )
              throw new Error("Native fifth preview renderer is not exclusive.");
            poolPreviewPid = pid;
            if (options.document.html.includes("data-cafe-fluid")) {
              poolFluidPreview =
                (await contents.executeJavaScript(
                  "(()=>{const c=document.querySelector('canvas[data-cafe-fluid]');return c?.dataset.cafeFluidTextures==='8'&&c.dataset.cafeFluidFrames==='12'&&c.dataset.cafeFluidRaf==='false'})()",
                )) === true;
            }
          }
          // Observe only this exact fixture generation's original native call.
          // Missing/unavailable observations remain null, never evidence that
          // capturePage was not called. No error object or received page value
          // is inspected, and the original production capture still runs once.
          const captureObservation: {
            called: boolean | null;
            resolved: boolean | null;
            rejected: boolean | null;
            rectWidth: number | null;
            rectHeight: number | null;
            imageWidth: number | null;
            imageHeight: number | null;
            offscreen: boolean | null;
            ownerDpr: number | null;
          } = {
            called: null,
            resolved: null,
            rejected: null,
            rectWidth: null,
            rectHeight: null,
            imageWidth: null,
            imageHeight: null,
            offscreen: null,
            ownerDpr: null,
          };
          const dimension = (value: unknown): number | null =>
            typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value >= 0 &&
            value <= 16_000
              ? value
              : null;
          let originalDescriptor: PropertyDescriptor | undefined;
          let recorder: Electron.WebContents["capturePage"] | undefined;
          if (contents) {
            try {
              originalDescriptor = Object.getOwnPropertyDescriptor(contents, "capturePage");
              const original = contents.capturePage;
              recorder = async function (this: Electron.WebContents, ...args) {
                captureObservation.called = true;
                captureObservation.rectWidth = dimension(args[0]?.width);
                captureObservation.rectHeight = dimension(args[0]?.height);
                let image: Electron.NativeImage;
                try {
                  image = await original.apply(this, args);
                  captureObservation.resolved = true;
                } catch (error) {
                  captureObservation.rejected = true;
                  throw error;
                }
                try {
                  const size = image.getSize();
                  captureObservation.imageWidth = dimension(size.width);
                  captureObservation.imageHeight = dimension(size.height);
                } catch {
                  // Observing dimensions cannot change the original outcome.
                }
                return image;
              };
              Object.defineProperty(contents, "capturePage", {
                ...(originalDescriptor && "value" in originalDescriptor
                  ? originalDescriptor
                  : { configurable: true, enumerable: false, writable: true }),
                value: recorder,
              });
              captureObservation.called = false;
              captureObservation.resolved = false;
              captureObservation.rejected = false;
              captureObservation.offscreen = contents.isOffscreen();
              const ownerWindow = Electron.BrowserWindow.fromWebContents(contents);
              if (ownerWindow) {
                const dpr = Electron.screen.getDisplayMatching(ownerWindow.getBounds()).scaleFactor;
                if (Number.isFinite(dpr) && dpr >= 0.5 && dpr <= 4)
                  captureObservation.ownerDpr = dpr;
              }
            } catch {
              // Diagnostic setup is observational only; it does not replace or
              // authorize another capture, window or generation.
            }
          }
          let captureFailed = false;
          try {
            const captured = await capture();
            if (options.document.kind === "mcp-app" && options.document.html === previewAppSource) {
              // Inspect only the immutable result of the original capture. A
              // later diagnostic DOM read cannot heal or replace these pixels.
              try {
                if (!hasFixtureColor(captured.png, 0, 0, 0)) {
                  try {
                    if (captured.png.byteLength <= 1_048_576)
                      await writeFile(
                        join(directory, "native-app-preview-failed.png"),
                        captured.png,
                        {
                          flag: "wx",
                          mode: 0o600,
                        },
                      );
                  } catch {
                    // Exact synthetic evidence retention is secondary only.
                  }
                  let dom: Record<string, boolean | number | null> | null = null;
                  if (contents) {
                    try {
                      // One fixed synchronous read in this exact authored App,
                      // after its failed PNG exists. No wait, source text,
                      // message payload or replacement capture is introduced.
                      const observed: unknown = await contents.executeJavaScript(
                        "(()=>{const b=document.body;return {bodyExists:!!b,authoredTextMatches:b?.textContent==='Replayed poster',bodyComputedBlack:!!b&&getComputedStyle(b).backgroundColor==='rgb(0, 0, 0)',clientWidth:b?.clientWidth??0,clientHeight:b?.clientHeight??0,scrollWidth:b?.scrollWidth??0,scrollHeight:b?.scrollHeight??0,innerWidth,innerHeight}})()",
                      );
                      if (
                        observed !== null &&
                        typeof observed === "object" &&
                        !Array.isArray(observed)
                      ) {
                        const flags = [
                          "bodyExists",
                          "authoredTextMatches",
                          "bodyComputedBlack",
                        ] as const;
                        const sizes = [
                          "clientWidth",
                          "clientHeight",
                          "scrollWidth",
                          "scrollHeight",
                          "innerWidth",
                          "innerHeight",
                        ] as const;
                        if (
                          Object.keys(observed).length === flags.length + sizes.length &&
                          flags.every((key) => typeof Reflect.get(observed, key) === "boolean") &&
                          sizes.every((key) => dimension(Reflect.get(observed, key)) !== null)
                        )
                          dom = Object.fromEntries<boolean | number | null>([
                            ...flags.map(
                              (key) => [key, Reflect.get(observed, key) === true] as const,
                            ),
                            ...sizes.map(
                              (key) => [key, dimension(Reflect.get(observed, key))] as const,
                            ),
                          ]);
                      }
                    } catch {
                      // Retired/unavailable native observations stay unknown.
                    }
                  }
                  process.stderr.write(
                    `Native fixture App preview pixels: ${JSON.stringify({ width: dimension(captured.width), height: dimension(captured.height), blackSample: false, dom })}\n`,
                  );
                }
              } catch {
                // Diagnostics never replace the original capture outcome.
              }
            }
            return captured;
          } catch (error) {
            captureFailed = true;
            throw error;
          } finally {
            try {
              if (
                contents &&
                recorder &&
                Object.getOwnPropertyDescriptor(contents, "capturePage")?.value === recorder
              ) {
                if (originalDescriptor)
                  Object.defineProperty(contents, "capturePage", originalDescriptor);
                else Reflect.deleteProperty(contents, "capturePage");
              }
            } catch {
              // A diagnostic restoration failure must preserve the original
              // capture result. This exact native child is still host-owned.
            }
            if (captureFailed) {
              try {
                process.stderr.write(
                  `Native fixture preview capture: ${JSON.stringify(captureObservation)}\n`,
                );
              } catch {
                // Emit at most one finite record and preserve the first error.
              }
            }
          }
        };
      }
      return surface;
    },
  });
  await host.listen(false);
  const owner = {
    environmentId: "isolated-native-fixture",
    threadId: "synthetic-thread",
    operationId: randomUUID(),
  };
  const document = {
    kind: "generated" as const,
    html: '<div style="position:fixed;inset:0;background:#000000;color:#ffffff"><h1>Native preview</h1><button>Accessible DOM</button><input id="native-input" aria-label="Native fixture input"></div>',
    assets: [],
    width: 400,
    height: 200,
    appearance: "light" as const,
  };
  try {
    // One refused automatic crop must not disable unrelated previews. First
    // refuse below the unchanged native32-DIP minimum without child allocation;
    // then exercise a real allocated child's early native setup failure.
    const cropTicket = "1".repeat(64);
    if (host.prepare({ ticket: cropTicket, owner, document }).status !== "ready")
      throw new Error("Native initial crop preparation refused.");
    const crop = await host.open(window, {
      ticket: cropTicket,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      clipBounds: { x: 0, y: 0, width: 400, height: 31 },
      appearance: "light",
    });
    if (
      crop.state !== "blocked" ||
      !host.capabilities().available ||
      host.diagnostics().activeCount !== 0 ||
      window.isDestroyed()
    )
      throw new Error("Native refused initial crop quarantined a healthy host.");
    const partialTicket = "2".repeat(64);
    refuseNextMaskAttachment = true;
    if (host.prepare({ ticket: partialTicket, owner, document }).status !== "ready")
      throw new Error("Native partial startup preparation refused.");
    const partial = await host.open(window, {
      ticket: partialTicket,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      appearance: "light",
    });
    if (
      partial.state !== "blocked" ||
      !host.capabilities().available ||
      host.diagnostics().activeCount !== 0 ||
      host.diagnostics().native?.phase !== "retired" ||
      host.diagnostics().native?.destroyed !== true ||
      window.isDestroyed()
    )
      throw new Error("Native partial startup destruction was inconclusive.");
    const minimal = await host.preview(owner, {
      ...document,
      html: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#000000"/></svg>',
    });
    if (
      minimal.status !== "ready" ||
      minimal.width !== 400 ||
      minimal.height !== 200 ||
      !hasFixtureColor(Buffer.from(minimal.png, "base64"), 0, 0, 0) ||
      !host.capabilities().available
    )
      throw new Error("Native minimal SVG preview after refused startup unavailable.");
    phase("native-partial-startup-same-host-preview");
    const preview = await host.preview(owner, document);
    if (preview.status !== "ready")
      throw new Error(
        `Native preview gate: ${preview.reason}/${JSON.stringify(host.diagnostics())}`,
      );
    if (
      preview.width !== 400 ||
      preview.height !== 200 ||
      !hasFixtureColor(Buffer.from(preview.png, "base64"), 0, 0, 0)
    )
      throw new Error("Native preview pixels missing.");
    phase("generated-preview-pixels");
    const appPreview = await host.preview(
      owner,
      { ...document, kind: "mcp-app", html: previewAppSource },
      {
        originalInputJson: '{"exact":"private input"}',
        originalResultJson: '{"content":[{"type":"text","text":"private result"}]}',
      },
    );
    const appPreviewBlack =
      appPreview.status === "ready" &&
      hasFixtureColor(Buffer.from(appPreview.png, "base64"), 0, 0, 0);
    if (
      appPreview.status !== "ready" ||
      appPreview.width !== 400 ||
      appPreview.height !== 200 ||
      !appPreviewBlack
    ) {
      const reason =
        appPreview.status === "blocked" &&
        [
          "unavailable",
          "invalid",
          "expired",
          "busy",
          "owner-revoked",
          "timeout",
          "capture-failed",
          "resource-denied",
          "retirement-uncertain",
        ].includes(appPreview.reason)
          ? appPreview.reason
          : null;
      try {
        process.stderr.write(
          `Native fixture App preview result: ${JSON.stringify({ status: appPreview.status === "ready" ? "ready" : "blocked", reason, width: appPreview.status === "ready" ? appPreview.width : null, height: appPreview.status === "ready" ? appPreview.height : null, blackSample: appPreviewBlack })}\n`,
        );
      } catch {
        // Preserve the original pixel/result assertion below.
      }
      throw new Error(`Native App replay pixels missing: ${JSON.stringify(host.diagnostics())}`);
    }
    phase("app-preview-replay-pixels");
    // Model a trusted owner revocation while the UI has not committed an open
    // acknowledgement. Actual native View visibility must remain false, and a
    // late same-lease update must not reconstruct/reveal a retired document.
    const pendingTicket = "e".repeat(64);
    if (host.prepare({ ticket: pendingTicket, owner, document }).status !== "ready")
      throw new Error("Native pending visibility preparation refused.");
    const pending = await host.open(window, {
      ticket: pendingTicket,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      appearance: "light",
    });
    const pendingIdentity = host.inspect(pendingTicket, pending.leaseId);
    const pendingView = pendingIdentity
      ? fixtureView(window, pendingIdentity.documentGeneration)
      : undefined;
    if (pending.state !== "active" || !pendingView || pendingView.getVisible())
      throw new Error("Native pending open exposed source before visibility commit.");
    if ((await host.retire(window, pending.leaseId)).state !== "retired")
      throw new Error("Native pending visibility retirement unproven.");
    if (
      (
        await host.update(window, {
          leaseId: pending.leaseId,
          bounds: { x: 0, y: 0, width: 400, height: 200 },
          visible: true,
          appearance: "light",
        })
      ).state !== "blocked" ||
      window.contentView.children.some((child) => child.children.includes(pendingView))
    )
      throw new Error("Native revoked pending open accepted delayed visibility.");
    phase("uncommitted-viewer-retired");
    // Preview windows and exact native retirement precede the viewer case.
    // Re-establish the owned synthetic owner's visible/focused precondition
    // before admitting another document. Do not restore a window while a live
    // viewer is being observed: a real subsequent hide must still retire it.
    window.show();
    Electron.app.focus({ steal: true });
    window.focus();
    await observed(() => window.isVisible() && window.isFocused() && !window.isMinimized());
    const ticket = "a".repeat(64);
    if (host.prepare({ ticket, owner, document }).status !== "ready")
      throw new Error("Native preparation refused.");
    const state = await host.open(window, {
      ticket,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      appearance: "light",
    });
    if (state.state !== "active")
      throw new Error(`Native viewer gate: ${state.state}/${state.reason}`);
    const inspected = host.inspect(ticket, state.leaseId);
    if (!inspected) throw new Error("Native identity unavailable.");
    const view = fixtureView(window, inspected.documentGeneration);
    if (!view || view.getVisible())
      throw new Error("Native open exposed source before trusted visibility commit.");
    // Qualification must outlive the3s watchdog: a short successful open does
    // not establish private pulse survival across document.open replacement.
    // Native-host fixture: preserve its existing wall-clock budget and callback cleanup.
    // @effect-diagnostics-next-line globalTimers:off
    await new Promise<void>((resolve) => setTimeout(resolve, 3_500));
    if (!host.inspect(ticket, state.leaseId))
      throw new Error("Native normal-document heartbeat unavailable.");
    phase("normal-document-watchdog-liveness");
    const visible = await host.update(window, {
      leaseId: state.leaseId,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      visible: true,
      appearance: "light",
    });
    if (
      visible.state !== "active" ||
      !view.getVisible() ||
      host.inspect(ticket, state.leaseId)?.documentGeneration !== inspected.documentGeneration
    )
      throw new Error("Native exact visibility commit changed or failed to expose its document.");
    phase("native-exact-visibility-committed");
    const contents = Electron.webContents
      .getAllWebContents()
      .find(
        (candidate) =>
          candidate.getURL() ===
          `${VISUALIZATION_SCHEME}://${inspected.documentGeneration}/bootstrap`,
      );
    if (!contents) throw new Error("Native fixture renderer missing.");
    // A sub-mask positive crop is still geometrically intersecting. Preserve
    // this exact document while hiding both native layers, and prove ordinary
    // page execution/heartbeat was not replaced with a debugger freeze. This
    // synthetic marker/counter is never accepted as production ownership.
    await contents.executeJavaScript(
      "(()=>{window.__nativeRetainedMarker='same-visible-document';window.__nativeRetainedTicks=0;window.__nativeRetainedTimer=setInterval(()=>{window.__nativeRetainedTicks=Math.min(1000000,window.__nativeRetainedTicks+1)},25)})()",
    );
    const tiny = await host.update(window, {
      leaseId: state.leaseId,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      clipBounds: { x: 0, y: 0, width: 400, height: 20 },
      visible: true,
      appearance: "light",
    });
    if (
      tiny.state !== "active" ||
      view.getVisible() ||
      host.inspect(ticket, state.leaseId)?.documentGeneration !== inspected.documentGeneration ||
      host.focus(window, state.leaseId) ||
      (await host.capture(window, state.leaseId)) !== null
    )
      throw new Error("Native tiny positive crop did not retain hidden exact ownership.");
    await observedNativeDom(
      contents,
      "window.__nativeRetainedMarker==='same-visible-document'&&window.__nativeRetainedTicks>=2&&!document.hidden&&document.documentElement.dataset.cafeVisible==='true'&&document.documentElement.dataset.cafePresentationVisible==='false'",
      "retained hidden document progress",
    );
    const restored = await host.update(window, {
      leaseId: state.leaseId,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      visible: true,
      appearance: "light",
    });
    if (
      restored.state !== "active" ||
      !view.getVisible() ||
      host.inspect(ticket, state.leaseId)?.documentGeneration !== inspected.documentGeneration
    )
      throw new Error("Native tiny crop restore replaced its exact document.");
    await observedNativeDom(
      contents,
      "window.__nativeRetainedMarker==='same-visible-document'&&!document.hidden&&document.documentElement.dataset.cafeVisible==='true'&&document.documentElement.dataset.cafePresentationVisible==='true'",
      "retained document visible restore",
    );
    const hiddenMenu = await host.update(window, {
      leaseId: state.leaseId,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      visible: true,
      presentationHidden: true,
      appearance: "light",
    });
    if (hiddenMenu.state !== "active" || view.getVisible())
      throw new Error("Native generated menu presentation hide refused.");
    await observedNativeDom(
      contents,
      "window.__nativeRetainedMarker==='same-visible-document'&&!document.hidden&&document.documentElement.dataset.cafeVisible==='true'&&document.documentElement.dataset.cafePresentationVisible==='false'",
      "retained menu presentation hide",
    );
    const menuReturn = await host.update(window, {
      leaseId: state.leaseId,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      visible: true,
      presentationHidden: false,
      appearance: "light",
    });
    if (
      menuReturn.state !== "active" ||
      !view.getVisible() ||
      state.expiresAtMs !== null ||
      host.inspect(ticket, state.leaseId)?.documentGeneration !== inspected.documentGeneration
    )
      throw new Error("Native generated menu return changed its visibility-owned document.");
    await contents.executeJavaScript("clearInterval(window.__nativeRetainedTimer)");
    phase("native-generated-tinycrop-menu-same-document");
    // These controls act only on this exact freshly admitted synthetic native
    // view. They are fixture APIs, never production source/renderer capability.
    // The heartbeat observation intentionally waits without retaining global
    // foreground ownership. Request focus once at this explicit input boundary,
    // not on blur/hide events; a retired or invisible document cannot reach it.
    // Keep actual native focus and delivered-input assertions authoritative.
    Electron.app.focus({ steal: true });
    window.focus();
    await observed(() => window.isFocused());
    if (
      host.inspect(ticket, state.leaseId)?.documentGeneration !== inspected.documentGeneration ||
      !view.getVisible()
    )
      throw new Error("Native fixture input owner was revoked.");
    if (!window.isFocused()) throw new Error("Native fixture owner lost focus.");
    // The exact shell keyboard-entry method targets only this native lease,
    // not every guest when the composer receives a Tab key.
    if (!host.focus(window, state.leaseId)) throw new Error("Native exact keyboard entry refused.");
    await observed(() => contents.isFocused());
    phase("native-view-focused");
    const inputBounds = (await contents.executeJavaScript(
      "(()=>{const r=document.getElementById('native-input').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()",
    )) as { x: number; y: number };
    contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...inputBounds });
    contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...inputBounds });
    await observedNativeDom(
      contents,
      "document.activeElement===document.getElementById('native-input')",
      "pointer focus",
    );
    contents.sendInputEvent({ type: "char", keyCode: "Z" });
    await observedNativeDom(
      contents,
      "document.getElementById('native-input').value==='Z'",
      "native character",
    );
    phase("native-character-delivered");
    await contents.insertText("日本語 🐈 Café");
    await observedNativeDom(
      contents,
      "document.getElementById('native-input').value==='Z日本語 🐈 Café'",
      "Unicode commit",
    );
    phase("unicode-committed");
    // Arrow-selection exercises the native input route, without relying on an
    // application menu's platform-specific Select All accelerator dispatch.
    for (let index = 0; index < "Z日本語 🐈 Café".length; index += 1) {
      contents.sendInputEvent({ type: "keyDown", keyCode: "Left", modifiers: ["shift"] });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Left", modifiers: ["shift"] });
    }
    await observedNativeDom(
      contents,
      "(()=>{const i=document.getElementById('native-input');return i.selectionStart===0&&i.selectionEnd===i.value.length})()",
      "keyboard selection",
    );
    phase("native-keyboard-selection");
    const input = (await contents.executeJavaScript(
      "(()=>{const i=document.getElementById('native-input');return {value:i.value,start:i.selectionStart,end:i.selectionEnd,focused:document.activeElement===i}})()",
    )) as { value: string; start: number; end: number; focused: boolean };
    if (
      !contents.isFocused() ||
      !input.focused ||
      input.value !== "Z日本語 🐈 Café" ||
      input.start !== 0 ||
      input.end !== input.value.length
    )
      throw new Error(
        `Native keyboard/Unicode selection unavailable: ${JSON.stringify({ nativeFocused: contents.isFocused(), ...input })}`,
      );
    // Chromium's actual accessibility tree proves semantic controls, not OS
    // screen-reader delivery or an installed IME's composition behavior.
    contents.debugger.attach("1.3");
    try {
      const tree = (await contents.debugger.sendCommand("Accessibility.getFullAXTree")) as {
        nodes: readonly { role?: { value?: unknown }; name?: { value?: unknown } }[];
      };
      if (
        !tree.nodes.some(
          (node) => node.role?.value === "textbox" && node.name?.value === "Native fixture input",
        ) ||
        !tree.nodes.some(
          (node) => node.role?.value === "button" && node.name?.value === "Accessible DOM",
        )
      )
        throw new Error("Native semantic accessibility unavailable.");
    } finally {
      contents.debugger.detach();
    }
    phase("semantic-accessibility");
    const expanded = await host.update(window, {
      leaseId: state.leaseId,
      bounds: { x: 0, y: 0, width: 600, height: 400 },
      visible: true,
      appearance: "dark",
    });
    if (
      expanded.state !== "active" ||
      host.inspect(ticket, state.leaseId)?.documentGeneration !== inspected.documentGeneration
    )
      throw new Error("Native identity changed during expansion.");
    const capture = await host.capture(window, state.leaseId);
    // Invariant black avoids comparing chromatic display-transformed native
    // output to the sRGB offscreen fixture while retaining real pixel evidence.
    if (
      !capture ||
      capture.width !== 600 ||
      capture.height !== 400 ||
      !hasFixtureColor(capture.png, 0, 0, 0)
    ) {
      const image = capture
        ? Electron.nativeImage.createFromBuffer(Buffer.from(capture.png))
        : null;
      const size = image?.getSize();
      const bitmap = image?.toBitmap();
      const offset = size ? ((size.height - 10) * size.width + size.width - 10) * 4 : 0;
      throw new Error(
        `Native capture unavailable: ${JSON.stringify({ size, pixel: bitmap?.subarray(offset, offset + 4).toString("hex"), diagnostics: host.diagnostics() })}`,
      );
    }
    phase("viewer-capture-pixels");
    // A native capture of the guest qualifies unchanged full page pixels/state,
    // not the window compositor's parent mask. The supported parent/child View
    // observations below separately qualify actual geometry and ownership.
    const clippingView = window.contentView.children.find((child) => child.children.includes(view));
    if (!clippingView) throw new Error("Native clipping parent absent.");
    const viewport = { x: 20, y: -100, width: 600, height: 400 };
    const clipBounds = { x: 20, y: 40, width: 500, height: 200 };
    await contents.executeJavaScript(
      "window.fixtureViewportState={count:7};document.body.style.minHeight='1200px';window.scrollTo(0,123)",
    );
    await observedNativeDom(contents, "scrollY===123", "full viewport scroll state");
    const rendererPid = contents.getOSProcessId();
    for (const zoom of [0.8, 1.3]) {
      window.webContents.setZoomFactor(zoom);
      const changed = await host.update(window, {
        leaseId: state.leaseId,
        bounds: viewport,
        clipBounds,
        visible: true,
        appearance: "dark",
      });
      if (changed.state !== "active") throw new Error("Native zoom geometry refused.");
      const child = view.getBounds(),
        parent = clippingView.getBounds();
      const ownerSize = window.getContentSize();
      await observedNativeDom(
        contents,
        `innerWidth===${Math.round(600 * zoom)}&&innerHeight===${Math.round(400 * zoom)}`,
        "native zoom viewport",
      );
      const actual = (await contents.executeJavaScript(
        "({width:innerWidth,height:innerHeight,count:window.fixtureViewportState.count,scroll:scrollY})",
      )) as { width: number; height: number; count: number; scroll: number };
      if (
        parent.x !== Math.ceil(20 * zoom) ||
        parent.y !== Math.ceil(40 * zoom) ||
        parent.width !== Math.min(ownerSize[0]!, Math.floor(520 * zoom)) - parent.x ||
        parent.height !== Math.min(ownerSize[1]!, Math.floor(240 * zoom)) - parent.y ||
        child.x !== Math.floor(20 * zoom) - parent.x ||
        child.y !== Math.floor(-100 * zoom) - parent.y ||
        child.width !== Math.round(600 * zoom) ||
        child.height !== Math.round(400 * zoom) ||
        actual.width !== child.width ||
        actual.height !== child.height ||
        actual.count !== 7 ||
        actual.scroll !== 123 ||
        contents.getOSProcessId() !== rendererPid ||
        host.inspect(ticket, state.leaseId)?.documentGeneration !== inspected.documentGeneration
      )
        throw new Error("Native full viewport or exact clipped document changed.");
      const fullCapture = await host.capture(window, state.leaseId);
      if (
        !fullCapture ||
        fullCapture.width !== child.width ||
        fullCapture.height !== child.height ||
        !hasClippedFixtureContent(fullCapture.png)
      ) {
        // Electron 43.8.4 CapturePage requests the child DIP rectangle, scales
        // its temporary bitmap by the native view's device scale factor, and
        // wraps that bitmap as a 1x NativeImage. The production surface independently
        // preflights that tuple and normalizes it to the same child DIP width/
        // height before PNG encoding. These assertions therefore keep their
        // exact units. No latest-Electron DIP-image semantics are substituted.
        // The old Linux failure did not reveal which clause failed: preserve a
        // fixed finite tuple (and any real PNG) without guessing a cause or
        // relaxing dimensions, opaque invariant-black RGBA, or ownership.
        // https://github.com/electron/electron/blob/v43.8.4/shell/browser/api/electron_api_web_contents.cc
        const image = fullCapture
          ? Electron.nativeImage.createFromBuffer(Buffer.from(fullCapture.png))
          : null;
        const size = image && !image.isEmpty() ? image.getSize() : undefined;
        const bitmap = size ? image!.toBitmap() : undefined;
        const offset = size
          ? (nativeFixtureClippedSampleOffsets(size.width, size.height)?.[0] ?? -1)
          : -1;
        const observation = nativeFixtureClippedCaptureObservation({
          ownerZoom: zoom,
          displayDpr: Electron.screen.getDisplayMatching(window.getBounds()).scaleFactor,
          expectedWidth: child.width,
          expectedHeight: child.height,
          capturePresent: fullCapture !== null,
          reportedWidth: fullCapture?.width,
          reportedHeight: fullCapture?.height,
          encodedWidth: size?.width,
          encodedHeight: size?.height,
          sampleBgra:
            bitmap && offset >= 0 && offset + 4 <= bitmap.length
              ? Array.from(bitmap.subarray(offset, offset + 4))
              : undefined,
          captureOutcome:
            latestViewerSurface?.generation === inspected.documentGeneration
              ? latestViewerSurface.diagnostics().captureOutcome
              : undefined,
        });
        process.stderr.write(`Native fixture clipped capture: ${JSON.stringify(observation)}\n`);
        if (fullCapture) {
          try {
            await writeFile(join(directory, "native-clipped-capture-failed.png"), fullCapture.png, {
              flag: "wx",
              mode: 0o600,
            });
          } catch {
            // Retaining a secondary image must not replace the primary exact
            // assertion failure or disclose an arbitrary filesystem error.
            process.stderr.write("Native fixture clipped capture retention: refused\n");
          }
        }
        throw new Error("Native full clipped viewport capture unavailable.");
      }
    }
    window.webContents.setZoomFactor(1);
    phase("native-clipped-full-viewport-zoom");
    if (
      (await host.retire(window, state.leaseId)).state !== "retired" ||
      host.inspect(ticket, state.leaseId) !== null
    )
      throw new Error("Native retirement unproven.");
    const shaderPreview = await host.preview(
      { ...owner, operationId: randomUUID() },
      { ...document, html: webglSource },
    );
    if (shaderPreview.status === "ready")
      await writeFile(
        join(directory, "native-fluid-preview.png"),
        Buffer.from(shaderPreview.png, "base64"),
        { flag: "wx", mode: 0o600 },
      );
    if (
      shaderPreview.status !== "ready" ||
      !hasFixtureSwirl(Buffer.from(shaderPreview.png, "base64"))
    )
      throw new Error("Native finite WebGL preview pixels unavailable.");
    const shaderTicket = "f".repeat(64);
    if (
      host.prepare({
        ticket: shaderTicket,
        owner: { ...owner, operationId: randomUUID() },
        document: { ...document, html: webglSource },
      }).status !== "ready"
    )
      throw new Error("Native shader preparation refused.");
    const shader = await host.open(window, {
      ticket: shaderTicket,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      appearance: "light",
      presentation: { ...presentation, reducedMotion: true },
    });
    const shaderIdentity = host.inspect(shaderTicket, shader.leaseId);
    const shaderView = shaderIdentity
      ? fixtureView(window, shaderIdentity.documentGeneration)
      : undefined;
    if (shader.state !== "active" || !shaderView)
      throw new Error("Native shader admission refused.");
    // Viewer admission is deliberately hidden until its exact acknowledged
    // lease receives trusted visible geometry. The fixture must exercise that
    // production visibility commit, not capture an uncommitted hidden view.
    const shaderCommitted = await host.update(window, {
      leaseId: shader.leaseId,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      visible: true,
      appearance: "light",
      presentation: { ...presentation, reducedMotion: true },
    });
    if (
      shaderCommitted.state !== "active" ||
      host.inspect(shaderTicket, shader.leaseId)?.documentGeneration !==
        shaderIdentity!.documentGeneration ||
      !shaderView.getVisible()
    )
      throw new Error("Native shader visibility commit refused.");
    const shaderContents = shaderView.webContents;
    await observedNativeDom(
      shaderContents,
      "(()=>{const c=document.querySelector('canvas[data-cafe-fluid]');return {fluidReady:c.dataset.cafeFluidFrames==='12'&&c.dataset.cafeFluidState==='static'&&c.dataset.cafeFluidRaf==='false'&&c.dataset.cafeFluidTextures==='8'&&c.dataset.cafeFluidPrograms==='10'&&c.dataset.cafeFluidBuffers==='2'&&Number(c.dataset.cafeFluidTextureBytes)<=16*1024*1024&&Math.max(c.width,c.height)<=512,state:c.dataset.cafeFluidState,frames:Number(c.dataset.cafeFluidFrames),textures:Number(c.dataset.cafeFluidTextures),programs:Number(c.dataset.cafeFluidPrograms),buffers:Number(c.dataset.cafeFluidBuffers),textureBytes:Number(c.dataset.cafeFluidTextureBytes),canvasWidth:c.width,canvasHeight:c.height,raf:c.dataset.cafeFluidRaf==='true',nativeVisible:document.documentElement.dataset.cafeVisible==='true',nativeReduced:document.documentElement.dataset.cafeReducedMotion==='true',documentHidden:document.hidden,rejectedWidth:Number(c.dataset.cafeFluidRejectedWidth),rejectedHeight:Number(c.dataset.cafeFluidRejectedHeight),rejectedDpr:Number(c.dataset.cafeFluidRejectedDpr)}})()",
      "actual fluid static resources",
    );
    const shaderCapture = await host.capture(window, shader.leaseId);
    if (shaderCapture)
      await writeFile(join(directory, "native-fluid-viewer.png"), shaderCapture.png, {
        flag: "wx",
        mode: 0o600,
      });
    if (!shaderCapture || !hasFixtureSwirl(shaderCapture.png))
      throw new Error("Native finite WebGL capture pixels unavailable.");
    await host.update(window, {
      leaseId: shader.leaseId,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      visible: true,
      appearance: "light",
      presentation: { ...presentation, reducedMotion: false },
    });
    await observedNativeDom(
      shaderContents,
      "Number(document.querySelector('canvas[data-cafe-fluid]').dataset.cafeFluidFrames)>=18",
      "finite swirl motion",
    );
    if (!host.beginTransition(window, shader.leaseId))
      throw new Error("Native swirl offscreen transition refused.");
    await observedNativeDom(
      shaderContents,
      "(()=>{const c=document.querySelector('canvas[data-cafe-fluid]');return document.documentElement.dataset.cafeVisible==='false'&&c.dataset.cafeFluidState==='paused'&&c.dataset.cafeFluidRaf==='false'})()",
      "offscreen swirl stop",
    );
    await host.update(window, {
      leaseId: shader.leaseId,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      visible: true,
      appearance: "light",
      presentation: { ...presentation, reducedMotion: false },
    });
    await observedNativeDom(
      shaderContents,
      "Number(document.querySelector('canvas[data-cafe-fluid]').dataset.cafeFluidFrames)>=96",
      "actual fluid sustained first checkpoint",
    );
    // Thirty fps is a ceiling, not a minimum throughput promise. Each unchanged
    // five-second observation adds at most eighty steps; the final beyond-360
    // pixel/pointer proof and whole-child deadline remain mandatory.
    await observedNativeDom(
      shaderContents,
      "Number(document.querySelector('canvas[data-cafe-fluid]').dataset.cafeFluidFrames)>=176",
      "actual fluid sustained second checkpoint",
    );
    await observedNativeDom(
      shaderContents,
      "(()=>{const c=document.querySelector('canvas[data-cafe-fluid]');return {fluidReady:Number(c.dataset.cafeFluidFrames)>=240,state:c.dataset.cafeFluidState,frames:Number(c.dataset.cafeFluidFrames),textures:Number(c.dataset.cafeFluidTextures),programs:Number(c.dataset.cafeFluidPrograms),buffers:Number(c.dataset.cafeFluidBuffers),textureBytes:Number(c.dataset.cafeFluidTextureBytes),canvasWidth:c.width,canvasHeight:c.height,raf:c.dataset.cafeFluidRaf==='true',nativeVisible:document.documentElement.dataset.cafeVisible==='true',nativeReduced:document.documentElement.dataset.cafeReducedMotion==='true',documentHidden:document.hidden}})()",
      "sustained swirl midpoint",
    );
    await observedNativeDom(
      shaderContents,
      "Number(document.querySelector('canvas[data-cafe-fluid]').dataset.cafeFluidFrames)>=300",
      "actual fluid sustained fourth checkpoint",
    );
    await observedNativeDom(
      shaderContents,
      "(()=>{const c=document.querySelector('canvas[data-cafe-fluid]');return Number(c.dataset.cafeFluidFrames)>360&&c.dataset.cafeFluidState==='running'&&c.dataset.cafeFluidRaf==='true'})()",
      "sustained swirl beyond old frame allowance",
    );
    for (let interaction = 0; interaction < 8; interaction++) {
      shaderContents.sendInputEvent({
        type: "mouseMove",
        x: 30 + interaction * 12,
        y: 70 + interaction * 3,
      });
      await observedNativeDom(
        shaderContents,
        `Number(document.querySelector('canvas[data-cafe-fluid]').dataset.cafeFluidPointerInputs)>=${interaction + 1}`,
        "sustained passive trusted pointer",
      );
    }
    const settledCapture = await host.capture(window, shader.leaseId);
    if (
      !settledCapture ||
      !hasFixtureSwirl(settledCapture.png) ||
      Buffer.from(settledCapture.png).equals(Buffer.from(shaderCapture!.png)) ||
      (await shaderContents.executeJavaScript(
        "Number(document.querySelector('canvas[data-cafe-fluid]').dataset.cafeFluidFrames)",
      )) <= 360
    )
      throw new Error("Native sustained swirl pixels unavailable.");
    await shaderContents.executeJavaScript("window.fixtureLoseContext()");
    await observedNativeDom(
      shaderContents,
      "(()=>{const fallback=document.getElementById('fallback'),canvas=document.querySelector('canvas[data-cafe-fluid]'),rect=fallback.getBoundingClientRect(),style=getComputedStyle(fallback);return canvas.dataset.cafeFluidState==='context-lost'&&canvas.dataset.cafeFluidRaf==='false'&&canvas.dataset.cafeFluidTextureBytes==='0'&&canvas.dataset.cafeFluidTextures==='0'&&canvas.dataset.cafeFluidPrograms==='0'&&canvas.dataset.cafeFluidBuffers==='0'&&style.display!=='none'&&style.visibility==='visible'&&rect.width>0&&rect.height>0&&rect.top>=0&&rect.bottom<=innerHeight})()",
      "context-loss fallback",
    );
    if ((await host.retire(window, shader.leaseId)).state !== "retired")
      throw new Error("Native shader retirement unproven.");
    phase("native-bounded-webgl-context-loss-retired");
    // A checked-in explicit derivative of the supplied chart is copied into
    // this fixture's private namespace. The original and immutable artifacts
    // are not read, rewritten or published by the native execution path.
    const naturalHtml = await readFile(join(directory, "natural-chart.html"), "utf8");
    if (Buffer.byteLength(naturalHtml) > 32 * 1024)
      throw new Error("Natural chart fixture refused.");
    const naturalTicket = randomUUID().replaceAll("-", "").repeat(2);
    if (
      host.prepare({ ticket: naturalTicket, owner, document: { ...document, html: naturalHtml } })
        .status !== "ready"
    )
      throw new Error("Native natural chart preparation refused.");
    const natural = await host.open(window, {
      ticket: naturalTicket,
      bounds: { x: 0, y: 0, width: 600, height: 180 },
      appearance: "light",
      presentation: { ...presentation, reducedMotion: true },
    });
    const naturalIdentity = host.inspect(naturalTicket, natural.leaseId);
    const naturalView = naturalIdentity
      ? fixtureView(window, naturalIdentity.documentGeneration)
      : undefined;
    if (natural.state !== "active" || !naturalView)
      throw new Error("Native natural chart admission refused.");
    await host.update(window, {
      leaseId: natural.leaseId,
      bounds: { x: 0, y: 0, width: 600, height: 180 },
      visible: true,
      appearance: "light",
      presentation: { ...presentation, reducedMotion: true },
    });
    await observed(() =>
      layoutEvents.some(
        (event) =>
          event.leaseId === natural.leaseId &&
          event.layout &&
          event.layout.height > 180 &&
          event.layout.height < 700 &&
          !event.layout.constrained,
      ),
    );
    let naturalLayout = layoutEvents.findLast(
      (event) => event.leaseId === natural.leaseId,
    )!.layout!;
    const snapshotChart = async (boundary: "selected" | "applied" | "capture" | "color") => {
      const latest = layoutEvents.findLast((event) => event.leaseId === natural.leaseId)!.layout!;
      const bounds = naturalView.getBounds();
      await chartSnapshot(naturalView.webContents, boundary, {
        selectedHeight: naturalLayout.height,
        selectedSequence: naturalLayout.sequence,
        latestHeight: latest.height,
        latestSequence: latest.sequence,
        ownerZoom: window.webContents.getZoomFactor(),
        nativeWidth: bounds.width,
        nativeHeight: bounds.height,
      });
    };
    await snapshotChart("selected");
    naturalLayout = await settledChartLayout(
      naturalView.webContents,
      () => layoutEvents.findLast((event) => event.leaseId === natural.leaseId)?.layout,
    );
    await host.update(window, {
      leaseId: natural.leaseId,
      bounds: { x: 0, y: 0, width: 600, height: naturalLayout.height },
      visible: true,
      appearance: "light",
    });
    await observedNativeDom(
      naturalView.webContents,
      "(()=>{const root=document.scrollingElement,unit=document.querySelector('.unit').getBoundingClientRect(),foot=document.querySelector('.foot').getBoundingClientRect();return root.scrollHeight<=innerHeight+1&&foot.bottom<=innerHeight+1&&unit.bottom<=innerHeight&&innerHeight-unit.bottom<=1})()",
      "natural chart root flow",
    );
    await snapshotChart("applied");
    if (
      host.inspect(naturalTicket, natural.leaseId)?.documentGeneration !==
      naturalIdentity!.documentGeneration
    )
      throw new Error("Native natural chart document changed.");
    await snapshotChart("capture");
    const naturalCapture = await host.capture(window, natural.leaseId);
    if (!naturalCapture) throw new Error("Native natural chart capture unavailable.");
    await writeFile(join(directory, "native-inline-chart.png"), naturalCapture.png, {
      flag: "wx",
      mode: 0o600,
    });
    // Keep the original monochrome/reduced-motion sample separate. A finite
    // representative theme does not rewrite this exact derivative's source,
    // change its lease/geometry, or imply readiness from another guest canvas.
    const chartPresentation: VisualizationHostPresentation = {
      ...presentation,
      reducedMotion: true,
      colors: {
        background: "#15171c",
        foreground: "#e8edf5",
        muted: "#94a3b8",
        accent: "#619cff",
        accentForeground: "#15171c",
        chart1: "#22d3ee",
        chart2: "#619cff",
        chart3: "#ae88ff",
        chart4: "#ec4899",
        chart5: "#38bdf8",
        chart6: "#a78bfa",
      },
    };
    await host.update(window, {
      leaseId: natural.leaseId,
      bounds: { x: 0, y: 0, width: 600, height: naturalLayout.height },
      visible: true,
      appearance: "dark",
      presentation: chartPresentation,
    });
    await observedNativeDom(
      naturalView.webContents,
      `(()=>{const c=document.querySelector('canvas[data-cafe-fluid]'),r=c.getBoundingClientRect(),d=c.dataset,frames=Number(d.cafeFluidFrames),scale=Math.min(devicePixelRatio,512/Math.max(r.width,r.height));return {fluidReady:d.cafeFluidState==='static'&&frames>=12&&frames<=96&&frames%12===0&&Number(d.cafeFluidTextures)===8&&Number(d.cafeFluidPrograms)===10&&Number(d.cafeFluidBuffers)===2&&d.cafeFluidRaf==='false'&&r.width>0&&r.height>0&&c.width===Math.max(1,Math.floor(r.width*scale))&&c.height===Math.max(1,Math.floor(r.height*scale)), state:d.cafeFluidState,frames,textures:Number(d.cafeFluidTextures),programs:Number(d.cafeFluidPrograms),buffers:Number(d.cafeFluidBuffers),textureBytes:Number(d.cafeFluidTextureBytes),canvasWidth:c.width,canvasHeight:c.height,raf:d.cafeFluidRaf==='true',nativeVisible:document.documentElement.dataset.cafeVisible==='true',nativeReduced:document.documentElement.dataset.cafeReducedMotion==='true',documentHidden:document.hidden}})()`,
      "representative chart fluid",
    );
    await snapshotChart("color");
    const colorCapture = await host.capture(window, natural.leaseId);
    if (!colorCapture) throw new Error("Native representative chart capture unavailable.");
    await writeFile(join(directory, "native-inline-chart-color.png"), colorCapture.png, {
      flag: "wx",
      mode: 0o600,
    });
    // Qualify the same authored chart's normal presentation independently of
    // its reduced-motion image. Do not fake media, replace source, reset its
    // consumed frames, or borrow progress from another native fluid context.
    const motionStart: unknown = await naturalView.webContents.executeJavaScript(
      "Number(document.querySelector('canvas[data-cafe-fluid]').dataset.cafeFluidFrames)",
    );
    if (
      !Number.isSafeInteger(motionStart) ||
      (motionStart as number) < 12 ||
      (motionStart as number) > VISUALIZATION_FLUID_DIAGNOSTIC_COUNTER_MAX - 6
    )
      throw new Error("Native chart motion allowance unavailable.");
    await host.update(window, {
      leaseId: natural.leaseId,
      bounds: { x: 0, y: 0, width: 600, height: naturalLayout.height },
      visible: true,
      appearance: "dark",
      presentation: { ...chartPresentation, reducedMotion: false },
    });
    await observedNativeDom(
      naturalView.webContents,
      `(()=>{const c=document.querySelector('canvas[data-cafe-fluid]'),d=c.dataset;return d.cafeFluidState==='running'&&d.cafeFluidRaf==='true'&&Number(d.cafeFluidFrames)>=${(motionStart as number) + 6}&&getComputedStyle(c).filter==='blur(9px)'&&document.documentElement.dataset.cafeVisible==='true'&&document.documentElement.dataset.cafeReducedMotion==='false'&&!document.hidden})()`,
      "normal chart own fluid motion and frost",
    );
    const motionCapture = await host.capture(window, natural.leaseId);
    if (
      !motionCapture ||
      motionCapture.width !== colorCapture.width ||
      motionCapture.height !== colorCapture.height ||
      Buffer.from(motionCapture.png).equals(Buffer.from(colorCapture.png))
    )
      throw new Error("Native normal chart pixels unavailable.");
    await writeFile(join(directory, "native-inline-chart-motion.png"), motionCapture.png, {
      flag: "wx",
      mode: 0o600,
    });
    await host.update(window, {
      leaseId: natural.leaseId,
      bounds: { x: 0, y: 0, width: 600, height: naturalLayout.height },
      visible: true,
      appearance: "dark",
      presentation: chartPresentation,
    });
    await observedNativeDom(
      naturalView.webContents,
      "(()=>{const d=document.querySelector('canvas[data-cafe-fluid]').dataset;return d.cafeFluidState==='static'&&d.cafeFluidRaf==='false'&&document.documentElement.dataset.cafeReducedMotion==='true'})()",
      "normal chart reduced-motion restoration",
    );
    if (
      host.inspect(naturalTicket, natural.leaseId)?.documentGeneration !==
      naturalIdentity!.documentGeneration
    )
      throw new Error("Native normal chart document changed.");
    phase("native-generated-normal-motion-frost-capture");
    await host.update(window, {
      leaseId: natural.leaseId,
      bounds: { x: 0, y: 0, width: 320, height: naturalLayout.height },
      visible: true,
      appearance: "dark",
    });
    await observed(() =>
      layoutEvents.some(
        (event) =>
          event.leaseId === natural.leaseId &&
          event.layout &&
          event.layout.sequence > naturalLayout.sequence &&
          event.layout.height !== naturalLayout.height,
      ),
    );
    const narrowLayout = await settledChartLayout(
      naturalView.webContents,
      () => layoutEvents.findLast((event) => event.leaseId === natural.leaseId)?.layout,
    );
    await host.update(window, {
      leaseId: natural.leaseId,
      bounds: { x: 0, y: 0, width: 320, height: narrowLayout.height },
      visible: true,
      appearance: "dark",
    });
    await observedNativeDom(
      naturalView.webContents,
      "(()=>{const unit=document.querySelector('.unit').getBoundingClientRect();return document.scrollingElement.scrollHeight<=innerHeight+1&&unit.bottom<=innerHeight&&innerHeight-unit.bottom<=1})()",
      "narrow natural chart root flow",
    );
    if ((await host.retire(window, natural.leaseId)).state !== "retired")
      throw new Error("Native natural chart retirement unproven.");
    phase("native-generated-natural-height-same-document");
    const transparent = await host.preview(
      { ...owner, operationId: randomUUID() },
      {
        ...document,
        html: "<style>html,body{background:transparent!important}</style><p>Transparent fragment</p>",
      },
    );
    if (transparent.status !== "ready")
      throw new Error("Native transparent fragment preview unavailable.");
    const transparentImage = Electron.nativeImage.createFromBuffer(
      Buffer.from(transparent.png, "base64"),
    );
    const transparentSize = transparentImage.getSize(),
      transparentBitmap = transparentImage.toBitmap();
    if (
      transparentImage.isEmpty() ||
      transparentBitmap[
        ((transparentSize.height - 10) * transparentSize.width + transparentSize.width - 10) * 4 + 3
      ] !== 0
    )
      throw new Error("Native generated transparent backing unavailable.");
    phase("native-generated-transparent-capture");
    // Four source-bearing viewers and one independent preview use actual
    // distinct renderer identities. Auto source cannot take composer focus;
    // only a real trusted native edge-wheel can request bounded chat scrolling.
    const poolHtml = `<style>html,body{height:100%;background:#000!important;color:#fff}canvas{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}input,.inner{position:relative}.inner{height:60px;overflow:auto}.long{height:300px}</style><canvas data-cafe-fluid aria-hidden="true"></canvas><input id="pool-input" autofocus><div class="inner"><div class="long">Internal scroll</div></div><script>window.fixtureCount=7;window.focus();window.fixtureStall=()=>{while(true){}};addEventListener('wheel',event=>{document.body.dataset.wheelTrusted=String(event.isTrusted);document.body.dataset.wheelDelta=String(event.deltaY)},{capture:true})</script>`;
    const poolInputs: {
      ticket: string;
      owner: typeof owner;
      document: VisualizationHostDocument;
    }[] = Array.from({ length: 4 }, () => ({
      ticket: randomUUID().replaceAll("-", "").repeat(2),
      owner: { ...owner, operationId: randomUUID() },
      document: {
        ...document,
        kind: "generated" as const,
        html: poolHtml,
      },
    }));
    for (const input of poolInputs)
      if (host.prepare(input).status !== "ready")
        throw new Error("Native pool preparation refused.");
    Electron.app.focus({ steal: true });
    window.focus();
    await observed(() => window.isFocused());
    window.webContents.focus();
    await observed(() => window.webContents.isFocused());
    const poolStates = await Promise.all(
      poolInputs.map((input, index) =>
        host.open(window, {
          ticket: input.ticket,
          bounds: { x: (index % 2) * 300, y: Math.floor(index / 2) * 180, width: 300, height: 180 },
          appearance: "light",
          presentation,
        }),
      ),
    );
    const poolViews = poolStates.map((state, index) => {
      const identity = host.inspect(poolInputs[index]!.ticket, state.leaseId);
      const view = identity ? fixtureView(window, identity.documentGeneration) : undefined;
      if (state.state !== "active" || !view)
        throw new Error("Native pool viewer admission refused.");
      return view;
    });
    const focusEvidence = () =>
      JSON.stringify({
        ownerWindowFocused: window.isFocused(),
        ownerRootFocused: window.webContents.isFocused(),
        appActive: Electron.app.isActive(),
        guestFocused: poolViews.map((view) => view.webContents.isFocused()),
      });
    if (!window.webContents.isFocused())
      throw new Error(`Automatic native chart stole composer focus: ${focusEvidence()}`);
    for (let index = 0; index < 4; index += 1) {
      const update = await host.update(window, {
        leaseId: poolStates[index]!.leaseId,
        bounds: { x: (index % 2) * 300, y: Math.floor(index / 2) * 180, width: 300, height: 180 },
        visible: true,
        appearance: "light",
      });
      if (update.state !== "active" || !poolViews[index]!.getVisible())
        throw new Error("Native pool visible commit refused.");
    }
    if (!window.webContents.isFocused())
      throw new Error(`Automatic native chart commit stole composer focus: ${focusEvidence()}`);
    poolViewerPids = poolViews.map((view) => view.webContents.getOSProcessId());
    for (const view of poolViews)
      await observedNativeDom(
        view.webContents,
        `(()=>{const c=document.querySelector('canvas[data-cafe-fluid]');return c.dataset.cafeFluidTextures==='8'&&Number(c.dataset.cafeFluidFrames)>=12&&Number(c.dataset.cafeFluidFrames)<=${VISUALIZATION_FLUID_DIAGNOSTIC_COUNTER_MAX}&&Number(c.dataset.cafeFluidTextureBytes)<=16*1024*1024})()`,
        "four actual fluid contexts",
      );
    if (
      poolViewerPids.some((pid) => pid <= 0) ||
      new Set(poolViewerPids).size !== 4 ||
      host.capacity().viewerCount !== 4
    )
      throw new Error("Native pool renderers are not separately owned.");
    const fifth = { ...poolInputs[0]!, ticket: randomUUID().replaceAll("-", "").repeat(2) };
    if (
      host.prepare(fifth).status !== "ready" ||
      (
        await host.open(window, {
          ticket: fifth.ticket,
          bounds: { x: 0, y: 0, width: 300, height: 180 },
          appearance: "light",
        })
      ).reason !== "busy"
    )
      throw new Error("Native fifth viewer was not refused.");
    const parallelPreview = await host.preview({ ...owner, operationId: randomUUID() }, document);
    if (
      parallelPreview.status !== "ready" ||
      poolPreviewPid <= 0 ||
      !hasFixtureColor(Buffer.from(parallelPreview.png, "base64"), 0, 0, 0) ||
      poolViews.some((view, index) => view.webContents.getOSProcessId() !== poolViewerPids[index])
    )
      throw new Error("Native preview did not preserve four exclusive viewers.");
    const fifthFluid = await host.preview(
      { ...owner, operationId: randomUUID() },
      { ...document, html: webglSource },
    );
    if (
      fifthFluid.status !== "ready" ||
      !poolFluidPreview ||
      !hasFixtureSwirl(Buffer.from(fifthFluid.png, "base64")) ||
      poolViews.some((view, index) => view.webContents.getOSProcessId() !== poolViewerPids[index])
    )
      throw new Error("Native fifth fluid preview did not preserve four helper contexts.");
    poolViewerPids = [];
    host.discardPrepared(fifth.ticket);
    phase("native-four-viewers-fifth-preview-autofocus");
    // Manual App admission is separate from automatic generated focus proof.
    // It consumes an existing viewer slot, never a fifth viewer/sixth source.
    if ((await host.retire(window, poolStates[3]!.leaseId)).state !== "retired")
      throw new Error("Native generated slot retirement refused.");
    poolInputs[3] = {
      ...poolInputs[3]!,
      ticket: randomUUID().replaceAll("-", "").repeat(2),
      document: { ...document, kind: "mcp-app", html: "<p>Manual App slot</p>" },
    };
    if (host.prepare(poolInputs[3]).status !== "ready")
      throw new Error("Native manual App slot preparation refused.");
    poolStates[3] = await host.open(window, {
      ticket: poolInputs[3].ticket,
      bounds: { x: 300, y: 180, width: 300, height: 180 },
      appearance: "light",
    });
    const manualIdentity = host.inspect(poolInputs[3].ticket, poolStates[3].leaseId);
    const manualView = manualIdentity
      ? fixtureView(window, manualIdentity.documentGeneration)
      : undefined;
    if (poolStates[3].state !== "active" || !manualView)
      throw new Error("Native manual App slot admission refused.");
    poolViews[3] = manualView;
    if (
      (
        await host.update(window, {
          leaseId: poolStates[3].leaseId,
          bounds: { x: 300, y: 180, width: 300, height: 180 },
          visible: true,
          appearance: "light",
        })
      ).state !== "active"
    )
      throw new Error("Native manual App visibility commit refused.");
    const wheelEvents: VisualizationHostEvent[] = [];
    const nativeSend = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel: string, ...args: unknown[]) => {
      if (channel === VISUALIZATION_EVENT_CHANNEL) {
        const event = args[0] as VisualizationHostEvent;
        if (event.state === "wheel" && wheelEvents.length < 8) wheelEvents.push(event);
      }
      nativeSend(channel, ...args);
    };
    const wheelContents = poolViews[1]!.webContents;
    wheelContents.sendInputEvent({
      type: "mouseWheel",
      x: 270,
      y: 150,
      deltaY: -60,
      canScroll: true,
      hasPreciseScrollingDeltas: true,
    });
    await observed(() => wheelEvents.length === 1);
    const delta = (await wheelContents.executeJavaScript(
      "({trusted:document.body.dataset.wheelTrusted,delta:Number(document.body.dataset.wheelDelta)})",
    )) as { trusted: string; delta: number };
    if (
      wheelEvents[0]?.leaseId !== poolStates[1]!.leaseId ||
      delta.trusted !== "true" ||
      wheelEvents[0].wheel?.deltaY !== delta.delta ||
      !Number.isFinite(delta.delta)
    )
      throw new Error("Native wheel handoff lost its exact trusted gesture.");
    const inner = (await wheelContents.executeJavaScript(
      "(()=>{const r=document.querySelector('.inner').getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+20)}})()",
    )) as { x: number; y: number };
    wheelContents.sendInputEvent({
      type: "mouseWheel",
      ...inner,
      deltaY: -60,
      canScroll: true,
      hasPreciseScrollingDeltas: true,
    });
    await observedNativeDom(
      wheelContents,
      "document.querySelector('.inner').scrollTop>0",
      "local inner wheel",
    );
    wheelContents.sendInputEvent({
      type: "mouseWheel",
      x: 270,
      y: 150,
      deltaY: -60,
      modifiers: ["alt"],
      canScroll: true,
      hasPreciseScrollingDeltas: true,
    });
    await wheelContents.executeJavaScript(
      "dispatchEvent(new WheelEvent('wheel',{deltaY:60,cancelable:true}))",
    );
    if (wheelEvents.length !== 1) throw new Error("Modified or synthetic wheel escaped its guest.");
    window.webContents.send = nativeSend;
    phase("native-trusted-wheel-inner-scroll-modified-refusal");
    void poolViews[2]!.webContents
      .executeJavaScript("window.fixtureStall()")
      .catch(() => undefined);
    await observed(
      () =>
        host.inspect(poolInputs[2]!.ticket, poolStates[2]!.leaseId) === null &&
        host.capacity().viewerCount === 3,
    );
    for (const index of [0, 1, 3])
      if (!host.inspect(poolInputs[index]!.ticket, poolStates[index]!.leaseId))
        throw new Error("Hostile native chart retired a healthy sibling.");
    const secondApp = { ...poolInputs[3]!, ticket: randomUUID().replaceAll("-", "").repeat(2) };
    if (
      host.prepare(secondApp).status !== "ready" ||
      (
        await host.open(window, {
          ticket: secondApp.ticket,
          bounds: { x: 0, y: 0, width: 300, height: 180 },
          appearance: "light",
        })
      ).reason !== "busy"
    )
      throw new Error("Native pool admitted a second manual App.");
    host.discardPrepared(secondApp.ticket);
    const yielded = await host.yield(window, poolStates[1]!.leaseId);
    if (yielded.state !== "retired" || !yielded.continuation)
      throw new Error("Native exact continuation was unavailable.");
    if (
      (await host.retire(window, poolStates[3]!.leaseId)).state !== "retired" ||
      !host.beginTransition(window, poolStates[0]!.leaseId) ||
      poolViews[0]!.getVisible()
    )
      throw new Error("Native expansion did not hide old inline pixels.");
    const selectedPid = poolViews[0]!.webContents.getOSProcessId();
    if (
      (
        await host.update(window, {
          leaseId: poolStates[0]!.leaseId,
          bounds: { x: 0, y: 0, width: 600, height: 400 },
          visible: true,
          appearance: "light",
          displayMode: "fullscreen",
        })
      ).state !== "active" ||
      poolViews[0]!.webContents.getOSProcessId() !== selectedPid ||
      !poolViews[0]!.getVisible() ||
      (await poolViews[0]!.webContents.executeJavaScript("window.fixtureCount")) !== 7
    )
      throw new Error("Native selected expansion lost its exact DOM.");
    const resumedInput = { ...poolInputs[1]!, ticket: randomUUID().replaceAll("-", "").repeat(2) };
    if (host.prepare(resumedInput).status !== "ready")
      throw new Error("Native continuation preparation refused.");
    const resumed = await host.open(window, {
      ticket: resumedInput.ticket,
      bounds: { x: 0, y: 0, width: 300, height: 180 },
      appearance: "light",
      continuation: yielded.continuation,
    });
    if (
      resumed.state !== "active" ||
      resumed.expiresAtMs !== poolStates[1]!.expiresAtMs ||
      resumed.leaseId === poolStates[1]!.leaseId
    )
      throw new Error("Native continuation renewed its original deadline.");
    const retiredPool = await Promise.all([
      host.retire(window, poolStates[0]!.leaseId),
      host.retire(window, resumed.leaseId),
    ]);
    if (
      retiredPool.some((value) => value.state !== "retired") ||
      !host.capabilities().available ||
      host.capacity().viewerCount !== 0
    )
      throw new Error("Native simultaneous sibling retirement was inconclusive.");
    phase("native-hostile-sibling-continuation-expansion-retired");
    // Independent watchdog cases precede intentional owner loss. Reusing a
    // deliberately hidden owner would couple CPU qualification to restoration
    // of native window/application visibility rather than the execution host.
    // A controlled CPU-only loop runs in the exact isolated fixture renderer.
    // It allocates no bomb and cannot block the main-owned heartbeat watchdog.
    const loopTicket = "c".repeat(64);
    if (
      host.prepare({
        ticket: loopTicket,
        owner: { ...owner, operationId: randomUUID() },
        document: { ...document, html: "<script>while(true){}</script>" },
      }).status !== "ready"
    )
      throw new Error("Native watchdog preparation refused.");
    const loop = await host.open(window, {
      ticket: loopTicket,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      appearance: "light",
    });
    const startupRetirement = host.diagnostics().native;
    if (
      loop.state !== "blocked" ||
      !startupRetirement?.heartbeatMissed ||
      !startupRetirement?.gone ||
      !startupRetirement.destroyed ||
      !host.capabilities().available
    )
      throw new Error(
        `Native blocked-startup retirement unproven: ${JSON.stringify(host.diagnostics())}`,
      );
    phase("startup-watchdog-retired");
    // Qualify an already admitted CPU stall independently of source startup.
    const activeLoopTicket = "d".repeat(64);
    if (
      host.prepare({
        ticket: activeLoopTicket,
        owner: { ...owner, operationId: randomUUID() },
        document: {
          ...document,
          kind: "mcp-app",
          html: "<p>Admitted before stall</p><script>window.addEventListener('message',event=>{if(event.source===window.parent&&event.data?.method==='fixture/stall'){while(true){}}})</script>",
        },
      }).status !== "ready"
    )
      throw new Error("Native active watchdog preparation refused.");
    const activeLoop = await host.open(window, {
      ticket: activeLoopTicket,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      appearance: "light",
    });
    if (activeLoop.state !== "active")
      throw new Error(
        `Native active watchdog admission refused: ${JSON.stringify(host.diagnostics())}`,
      );
    if (!host.send(window, activeLoop.leaseId, '{"jsonrpc":"2.0","method":"fixture/stall"}'))
      throw new Error("Native controlled stall delivery refused.");
    await observed(
      () =>
        host.diagnostics().activeCount === 0 &&
        host.inspect(activeLoopTicket, activeLoop.leaseId) === null,
    );
    const watchdog = host.diagnostics().native;
    if (!watchdog?.heartbeatMissed || !watchdog.gone || !watchdog.destroyed)
      throw new Error(`Native watchdog retirement unproven: ${JSON.stringify(host.diagnostics())}`);
    phase("active-watchdog-retired");
    const reports: { method: string; params?: Record<string, unknown> }[] = [];
    let initializeCount = 0;
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel: string, ...args: unknown[]) => {
      if (channel !== VISUALIZATION_EVENT_CHANNEL) {
        send(channel, ...args);
        return;
      }
      const event = args[0] as VisualizationHostEvent;
      if (event.state !== "message" || !event.json) return;
      const message = JSON.parse(event.json) as {
        method: string;
        params?: Record<string, unknown>;
      };
      if (message.method === "ui/initialize") {
        initializeCount += 1;
        if (
          !host.send(
            window,
            event.leaseId,
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2026-01-26",
                hostInfo: { name: "fixture", version: "1" },
                capabilities: {},
                hostContext: {
                  displayMode: "inline",
                  availableDisplayModes: ["inline", "fullscreen"],
                },
              },
            }),
          )
        )
          throw new Error("Native fixture initialization response refused.");
      } else if (reports.length < 8) reports.push(message);
      else throw new Error("Native fixture report bound exceeded.");
    };
    const appTicket = "b".repeat(64);
    const appOwner = { ...owner, operationId: randomUUID() };
    if (
      host.prepare({
        ticket: appTicket,
        owner: appOwner,
        document: { ...document, kind: "mcp-app", html: appSource },
      }).status !== "ready"
    )
      throw new Error("Native App preparation refused.");
    const app = await host.open(window, {
      ticket: appTicket,
      bounds: { x: 0, y: 0, width: 400, height: 200 },
      appearance: "light",
      presentation,
      displayMode: "inline",
    });
    if (app.state !== "active") throw new Error("Native App admission refused.");
    await observed(() => reports.some((report) => report.method === "fixture/report"));
    const report = reports.find((value) => value.method === "fixture/report")!.params!;
    if (
      initializeCount !== 1 ||
      report.selfRequestsSeen !== 0 ||
      report.workerDenied !== true ||
      report.connectDenied !== true ||
      report.requireAbsent !== true ||
      report.bridgeAbsent !== true ||
      report.accent !== "#3355ff" ||
      reports.some((value) => value.method === "fixture/forged")
    )
      throw new Error(
        `Native SDK transport or persisted CSP failed: ${JSON.stringify({ initializeCount, selfRequestsSeen: report.selfRequestsSeen, workerDenied: report.workerDenied, connectDenied: report.connectDenied, requireAbsent: report.requireAbsent, bridgeAbsent: report.bridgeAbsent, accent: report.accent, forged: reports.some((value) => value.method === "fixture/forged") })}`,
      );
    const context = report.context as Record<string, unknown>;
    if (
      context.theme !== "light" ||
      context.locale !== "en" ||
      context.displayMode !== "inline" ||
      context.reducedMotion !== false ||
      JSON.stringify(context.containerDimensions) !== JSON.stringify({ width: 400, height: 200 })
    )
      throw new Error("Native initialization context missing.");
    const appGeneration = host.inspect(appTicket, app.leaseId)!.documentGeneration;
    await host.update(window, {
      leaseId: app.leaseId,
      bounds: { x: 0, y: 0, width: 600, height: 400 },
      visible: true,
      appearance: "dark",
      presentation: { ...presentation, locale: "ja", reducedMotion: true, scale: 1.25 },
      displayMode: "fullscreen",
    });
    await observed(() => reports.some((value) => value.method === "fixture/context"));
    const changed = reports.find((value) => value.method === "fixture/context")!.params!;
    if (
      changed.theme !== "dark" ||
      changed.locale !== "ja" ||
      changed.reducedMotion !== true ||
      changed.scale !== 1.25 ||
      changed.displayMode !== "fullscreen" ||
      host.inspect(appTicket, app.leaseId)?.documentGeneration !== appGeneration
    )
      throw new Error("Native standard context update failed.");
    const firstConsent = randomUUID();
    const secondConsent = randomUUID();
    if (
      !host.suspend(window, app.leaseId, true, firstConsent) ||
      host.send(window, app.leaseId, '{"jsonrpc":"2.0","method":"fixture/hidden"}') ||
      !host.suspend(window, app.leaseId, false, firstConsent) ||
      !host.suspend(window, app.leaseId, true, secondConsent) ||
      !host.suspend(window, app.leaseId, false, secondConsent) ||
      host.suspend(window, app.leaseId, true, firstConsent)
    )
      throw new Error("Native consent ownership failed.");
    // Deliberately hide only this owned synthetic window. Dock invisibility must
    // not weaken production's BrowserWindow hide retirement and exact evidence.
    window.hide();
    await observed(() => host.diagnostics().activeCount === 0);
    const hiddenRetirement = host.diagnostics().native;
    if (
      host.inspect(appTicket, app.leaseId) !== null ||
      hiddenRetirement?.rejection !== "owner-window" ||
      !hiddenRetirement.gone ||
      !hiddenRetirement.destroyed ||
      !host.capabilities().available
    )
      throw new Error("Native owner-hide retirement unproven.");
    phase("app-sdk-context-csp-consent-owner-hide-retired");
    window.webContents.send = send;
    process.stdout.write(
      `${JSON.stringify({ electron: process.versions.electron, electronNode: process.versions.node, electronAbi: process.versions.modules, platform: process.platform, arch: process.arch, graphics, partialStartupRecovery: "passed", preview: "passed", appPreviewReplay: "passed", viewer: "passed", visibilityCommit: "passed", nativeInput: "passed", semanticAccessibility: "passed", sameDocument: "passed", capture: "passed", clippingGeometry: "passed", ownerZoom: "passed", boundedWebGL: "passed", sustainedFluid: "passed", naturalHeight: "passed", normalMotionChart: "passed", viewerPool: "passed", automaticFocus: "passed", wheelHandoff: "passed", continuation: "passed", retirement: "passed", ownerHide: "passed", appTransport: "passed", context: "passed", csp: "passed", consent: "passed", watchdog: "passed" })}\n`,
    );
  } catch (error) {
    process.stderr.write(`Native fixture owned status: ${JSON.stringify(host.diagnostics())}\n`);
    throw error;
  } finally {
    await host.close();
    window.destroy();
  }
}

void qualify().then(
  () => Electron.app.exit(0),
  (error: unknown) => {
    // Only this synthetic fixture's fixed classifications reach test stderr.
    process.stderr.write(`${error instanceof Error ? error.message : "Native fixture failed."}\n`);
    Electron.app.exit(1);
  },
);
