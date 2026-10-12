import * as Electron from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DesktopVisualizationHost } from "./DesktopVisualizationHost.ts";
import { VISUALIZATION_SCHEME, VISUALIZATION_EVENT_CHANNEL } from "./visualizationHostPolicy.ts";
import type {
  VisualizationHostEvent,
  VisualizationHostPresentation,
} from "@cafecode/contracts/visualizationHost";

/** Bounded fixture observation only; production adds no polling or transcript. */
async function observed(predicate: () => boolean): Promise<void> {
  const until = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= until) throw new Error("Native fixture observation unavailable.");
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
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([
      contents.executeJavaScript(expression),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, until - performance.now()));
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (ready === true) return;
    if (performance.now() >= until)
      throw new Error(`Native fixture ${classification} delivery unavailable.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
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
  Electron.app.setPath("userData", join(directory, "profile"));
  Electron.app.setPath("sessionData", join(directory, "session"));
  Electron.protocol.registerSchemesAsPrivileged([
    { scheme: VISUALIZATION_SCHEME, privileges: { standard: true, secure: true } },
  ]);
  await Electron.app.whenReady();
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
  const host = new DesktopVisualizationHost({
    stateDirectory: directory,
    preloadPath: join(directory, "visualizationPreload.cjs"),
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
    if (
      appPreview.status !== "ready" ||
      appPreview.width !== 400 ||
      appPreview.height !== 200 ||
      !hasFixtureColor(Buffer.from(appPreview.png, "base64"), 0, 0, 0)
    )
      throw new Error(`Native App replay pixels missing: ${JSON.stringify(host.diagnostics())}`);
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
    const pendingView = window.contentView.children.find(
      (child): child is Electron.WebContentsView =>
        child instanceof Electron.WebContentsView &&
        child.webContents.getURL() ===
          `${VISUALIZATION_SCHEME}://${pendingIdentity?.documentGeneration}/bootstrap`,
    );
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
      window.contentView.children.includes(pendingView)
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
    const view = window.contentView.children.find(
      (child): child is Electron.WebContentsView =>
        child instanceof Electron.WebContentsView &&
        child.webContents.getURL() ===
          `${VISUALIZATION_SCHEME}://${inspected.documentGeneration}/bootstrap`,
    );
    if (!view || view.getVisible())
      throw new Error("Native open exposed source before trusted visibility commit.");
    // Qualification must outlive the3s watchdog: a short successful open does
    // not establish private pulse survival across document.open replacement.
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
    contents.focus();
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
    if (
      (await host.retire(window, state.leaseId)).state !== "retired" ||
      host.inspect(ticket, state.leaseId) !== null
    )
      throw new Error("Native retirement unproven.");
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
      `${JSON.stringify({ electron: process.versions.electron, electronNode: process.versions.node, electronAbi: process.versions.modules, platform: process.platform, arch: process.arch, preview: "passed", appPreviewReplay: "passed", viewer: "passed", visibilityCommit: "passed", nativeInput: "passed", semanticAccessibility: "passed", sameDocument: "passed", capture: "passed", retirement: "passed", ownerHide: "passed", appTransport: "passed", context: "passed", csp: "passed", consent: "passed", watchdog: "passed" })}\n`,
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
