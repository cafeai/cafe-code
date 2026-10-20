import * as Electron from "electron";
import { randomUUID } from "node:crypto";
// Opt-in native fixture keeps its existing Electron-owned screenshot/result-file Promise lifecycle.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { writeFile } from "node:fs/promises";
// Native path boundary: preserve host drive, namespace and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { CHAT_MONO_FONT_FAMILY, CHAT_SANS_FONT_FAMILY } from "@cafecode/shared/chatTypography";
import type {
  VisualizationHostBounds,
  VisualizationHostEvent,
} from "@cafecode/contracts/visualizationHost";
import { DesktopVisualizationHost } from "./DesktopVisualizationHost.ts";
import { ElectronVisualizationSurface } from "./ElectronVisualizationSurface.ts";
import {
  configureNativeVisualizationFixtureDriver,
  isSandboxedNativeFixtureDriver,
} from "./nativeVisualizationFixturePolicy.ts";
import { NativeFixtureRetirementRecorder } from "./nativeVisualizationFixtureRetirement.ts";
import {
  VISUALIZATION_CSP,
  VISUALIZATION_EVENT_CHANNEL,
  VISUALIZATION_SCHEME,
} from "./visualizationHostPolicy.ts";

/** Only this fixed synthetic qualification may execute scalar own-frame probes.
 * Arbitrary guest errors, source text and profile paths remain out of reports. */
class NativeFontFailure extends Error {}

async function observe(
  contents: Electron.WebContents,
  expression: string,
  label: string,
): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const value = await Promise.race([
      contents.executeJavaScript(expression),
      new Promise<false>((resolve) => {
        // Native-host fixture: preserve its existing wall-clock budget and callback cleanup.
        // @effect-diagnostics-next-line globalTimers:off
        timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()));
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (value === true) return;
    if (performance.now() >= deadline)
      throw new NativeFontFailure(`Native font fixture ${label} unavailable.`);
    // Native-host fixture: preserve its existing wall-clock budget and callback cleanup.
    // @effect-diagnostics-next-line globalTimers:off
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

// Independently authored local source exercises a deliberate important-family
// conflict without changing authored weight/style/size or relying on a system
// DM Sans installation. The script records the loaded font set at parse time,
// before any later host observation could conceal a document.open reset.
const source = `<style>
body{font:18px serif!important}.unit{box-sizing:border-box;width:100%;padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:14px;background:#15171c;color:#e8edf5}
h1{font:italic 575 22px serif!important;margin:0}p{font:normal 450 18px serif!important;margin:0;min-width:0;overflow-wrap:anywhere}
button{font:italic 620 17px serif!important;padding:8px}svg{display:block;width:100%;height:44px;grid-column:1/-1}
#axis{font:italic 575 19px serif!important}code{font:normal 400 13px serif!important}code span{font-family:serif!important}
@media(max-width:580px){.unit{grid-template-columns:1fr}}
</style><section class="unit"><h1 id="heading">Cafe chart typography Ā</h1><button id="control">Native chart control Ā</button><p id="copy">A colorful chart uses the actual chat font. Extended Latin Ā and normal text retain their authored metrics and fit this natural responsive unit.</p><code id="code"><span id="code-child">const glyph = "Ā";</span></code><svg viewBox="0 0 600 44"><text id="axis" x="0" y="28">Variable chart axis Ā</text></svg></section><script>
window.fixtureTypographyAtParse={faces:[...document.fonts].map(face=>({family:face.family,status:face.status,style:face.style,weight:face.weight,range:face.unicodeRange})),family:getComputedStyle(document.getElementById('axis')).fontFamily};
</script>`;

const generatedProof = `(()=>{
 const parsed=window.fixtureTypographyAtParse;
 const faces=[...document.fonts];
 if(!parsed||parsed.faces.length!==4||faces.length!==4||!parsed.faces.every(face=>face.family==='DM Sans Variable'&&face.status==='loaded')||!faces.every(face=>face.family==='DM Sans Variable'&&face.status==='loaded'&&face.weight==='100 1000'))return false;
 const canonical=value=>{const probe=document.createElement('span');probe.style.setProperty('font-family',value,'important');probe.style.display='none';document.head.append(probe);try{return getComputedStyle(probe).fontFamily;}finally{probe.remove();}};
 const sans=canonical(${JSON.stringify(CHAT_SANS_FONT_FAMILY)}),mono=canonical(${JSON.stringify(CHAT_MONO_FONT_FAMILY)});
 const covers=(face,code)=>{const parts=face.unicodeRange.split(',');return parts.length<=32&&parts.some(part=>{const match=/^U\\+([A-Fa-f0-9]{1,6})(?:-([A-Fa-f0-9]{1,6}))?$/.exec(part.trim());return match&&code>=parseInt(match[1],16)&&code<=parseInt(match[2]||match[1],16);});};
 if(parsed.family!==sans)return false;
 for(const id of ['heading','control','copy','axis'])if(getComputedStyle(document.getElementById(id)).fontFamily!==sans)return false;
 for(const id of ['code','code-child'])if(getComputedStyle(document.getElementById(id)).fontFamily!==mono)return false;
 for(const [id,size,weight,style] of [['heading','22px','575','italic'],['control','17px','620','italic'],['copy','18px','450','normal'],['axis','19px','575','italic'],['code','13px','400','normal']]){const s=getComputedStyle(document.getElementById(id));if(s.fontSize!==size||s.fontWeight!==weight||s.fontStyle!==style)return false;}
 return Promise.all([['normal','A'],['normal','Ā'],['italic','A'],['italic','Ā']].map(async([style,text])=>{const loaded=await document.fonts.load(style+' 450 20px "DM Sans Variable"',text);return loaded.length===1&&loaded[0].family==='DM Sans Variable'&&loaded[0].status==='loaded'&&loaded[0].style===style&&loaded[0].weight==='100 1000'&&faces.includes(loaded[0])&&covers(loaded[0],text.codePointAt(0));})).then(result=>result.every(Boolean));
})()`;
const appProof =
  "(()=>{const p=window.fixtureTypographyAtParse;return p?.faces.length===0&&[...document.fonts].length===0&&p.family==='serif'&&getComputedStyle(document.getElementById('axis')).fontFamily==='serif'&&getComputedStyle(document.getElementById('code-child')).fontFamily==='serif'})()";
// An external App preview must complete the same SDK-equivalent handshake as
// the existing isolated App fixture. The typography source above stays exact;
// this appended protocol-only suffix grants no action or font capability.
const appInitialization = `<script>
window.addEventListener('message',event=>{
 if(event.source!==window.parent||!event.data||event.data.jsonrpc!=='2.0')return;
 if(event.data.id===1&&event.data.result)window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');
});
window.parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appCapabilities:{},appInfo:{name:'typography-fixture',version:'1'}}},'*');
</script>`;
const fitProof =
  "(()=>{const root=document.scrollingElement,unit=document.querySelector('.unit').getBoundingClientRect();return root.scrollWidth<=innerWidth+1&&root.scrollHeight<=innerHeight+1&&unit.left===0&&unit.right<=innerWidth+1&&unit.bottom<=innerHeight&&innerHeight-unit.bottom<=1})()";

process.on("uncaughtException", () => {
  process.stderr.write("Native font fixture exception.\n");
  Electron.app.exit(1);
});

async function qualify(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || !VISUALIZATION_CSP.includes("font-src 'none'"))
    throw new NativeFontFailure("Native font fixture policy refused.");
  const softwareDriver = configureNativeVisualizationFixtureDriver(
    Electron.app,
    process.platform,
    "font",
  );
  Electron.app.setPath("userData", join(directory, "profile"));
  Electron.app.setPath("sessionData", join(directory, "session"));
  Electron.protocol.registerSchemesAsPrivileged([
    { scheme: VISUALIZATION_SCHEME, privileges: { standard: true, secure: true } },
  ]);
  await Electron.app.whenReady();
  if (softwareDriver && !isSandboxedNativeFixtureDriver(await Electron.app.getGPUInfo("complete")))
    throw new NativeFontFailure("Native font fixture sandboxed graphics mode unavailable.");
  const graphics = softwareDriver ? "sandboxed-swiftshader" : "native-default";
  if (process.platform === "darwin") Electron.app.setActivationPolicy("accessory");
  const window = new Electron.BrowserWindow({
    show: false,
    width: 720,
    height: 900,
    webPreferences: {
      javascript: false,
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
    },
  });
  await window.loadURL("data:text/html,<html><body>isolated typography owner</body></html>");
  window.show();
  const layouts: VisualizationHostEvent[] = [];
  const send = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) => {
    const value = args[0] as VisualizationHostEvent;
    if (channel === VISUALIZATION_EVENT_CHANNEL && value.state === "layout" && layouts.length < 32)
      layouts.push(value);
    send(channel, ...args);
  };
  let generatedPreview = false,
    appPreview = false;
  const retirement = new NativeFixtureRetirementRecorder(process.platform, 3);
  const host = new DesktopVisualizationHost({
    stateDirectory: directory,
    preloadPath: join(directory, "visualizationPreload.cjs"),
    createSurface: (options) => {
      const surface = new ElectronVisualizationSurface(options);
      retirement.observe(surface, () =>
        Electron.webContents
          .getAllWebContents()
          .find(
            (contents) =>
              contents.getURL() === `${VISUALIZATION_SCHEME}://${surface.generation}/bootstrap`,
          ),
      );
      const install = surface.installSource.bind(surface);
      surface.installSource = async () => {
        try {
          await install();
        } catch (error) {
          // The host intentionally converts a child installation exception to
          // a fixed refusal. Preserve this synthetic phase classification first
          // so a fundamental binary-font/CSP failure cannot be lost there.
          process.stderr.write("Native font fixture native source installation refused.\n");
          throw error;
        }
        const contents = Electron.webContents
          .getAllWebContents()
          .find(
            (value) =>
              value.getURL() === `${VISUALIZATION_SCHEME}://${surface.generation}/bootstrap`,
          );
        if (!contents) throw new NativeFontFailure("Native font fixture exact child unavailable.");
        try {
          await observe(
            contents,
            options.document.kind === "generated" ? generatedProof : appProof,
            options.document.kind === "generated"
              ? "loaded binary faces and persistent policy"
              : "App font exclusion",
          );
        } catch (error) {
          process.stderr.write(
            options.document.kind === "generated"
              ? "Native font fixture loaded binary face/policy proof refused.\n"
              : "Native font fixture App exclusion proof refused.\n",
          );
          throw error;
        }
        if (options.window === null) {
          if (options.document.kind === "generated") generatedPreview = true;
          else appPreview = true;
        }
      };
      return surface;
    },
  });
  await host.listen(false);
  const owner = {
    environmentId: "isolated-font-fixture",
    threadId: "synthetic-fonts",
    operationId: randomUUID(),
  };
  const document = {
    kind: "generated" as const,
    html: source,
    assets: [],
    width: 600,
    height: 360,
    appearance: "dark" as const,
  };
  try {
    const preview = await host.preview(owner, document);
    if (preview.status !== "ready" || !generatedPreview)
      throw new NativeFontFailure("Native font fixture generated preview refused.");
    await writeFile(
      join(directory, "native-font-preview.png"),
      Buffer.from(preview.png, "base64"),
      { flag: "wx", mode: 0o600 },
    );
    const app = await host.preview(
      owner,
      { ...document, kind: "mcp-app", html: source + appInitialization },
      { originalInputJson: "{}", originalResultJson: '{"content":[]}' },
    );
    if (app.status !== "ready" || !appPreview)
      throw new NativeFontFailure("Native font fixture App preview refused.");
    const ticket = randomUUID().replaceAll("-", "").repeat(2);
    if (host.prepare({ ticket, owner, document }).status !== "ready")
      throw new NativeFontFailure("Native font fixture prepare refused.");
    let bounds: VisualizationHostBounds = { x: 0, y: 0, width: 600, height: 80 };
    const state = await host.open(window, { ticket, bounds, appearance: "dark" });
    const identity = host.inspect(ticket, state.leaseId);
    const contents = identity
      ? Electron.webContents
          .getAllWebContents()
          .find(
            (value) =>
              value.getURL() ===
              `${VISUALIZATION_SCHEME}://${identity.documentGeneration}/bootstrap`,
          )
      : undefined;
    if (state.state !== "active" || state.expiresAtMs !== null || !contents || !identity)
      throw new NativeFontFailure("Native font fixture viewer refused.");
    const fit = async (width: number): Promise<number> => {
      bounds = { ...bounds, width, height: 80 };
      if (
        (
          await host.update(window, {
            leaseId: state.leaseId,
            bounds,
            visible: true,
            appearance: "dark",
          })
        ).state !== "active"
      )
        throw new NativeFontFailure("Native font fixture geometry refused.");
      const deadline = performance.now() + 5_000;
      let height = 0;
      while (performance.now() < deadline) {
        const event = layouts.findLast((value) => value.leaseId === state.leaseId),
          extent: unknown = await contents.executeJavaScript(
            "Math.ceil(document.querySelector('.unit').getBoundingClientRect().bottom-document.body.getBoundingClientRect().top)",
          );
        if (
          event?.state === "layout" &&
          event.layout &&
          !event.layout.constrained &&
          event.layout.height === extent
        ) {
          height = event.layout.height;
          break;
        }
        // Native-host fixture: preserve its existing wall-clock budget and callback cleanup.
        // @effect-diagnostics-next-line globalTimers:off
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (!Number.isSafeInteger(height) || height < 80 || height > 2000)
        throw new NativeFontFailure("Native font fixture natural layout unavailable.");
      bounds = { ...bounds, height };
      if (
        (
          await host.update(window, {
            leaseId: state.leaseId,
            bounds,
            visible: true,
            appearance: "dark",
          })
        ).state !== "active"
      )
        throw new NativeFontFailure("Native font fixture fitted geometry refused.");
      await observe(contents, fitProof, "natural full-width font fit");
      await observe(contents, generatedProof, "same loaded font set after resize");
      return height;
    };
    const fullHeight = await fit(600),
      narrowHeight = await fit(320);
    if (narrowHeight <= fullHeight)
      throw new NativeFontFailure("Native font fixture responsive extent unavailable.");
    const capture = await host.capture(window, state.leaseId);
    if (!capture || capture.width !== 320 || capture.height !== narrowHeight)
      throw new NativeFontFailure("Native font fixture font-ready capture refused.");
    await writeFile(join(directory, "native-font-viewer.png"), capture.png, {
      flag: "wx",
      mode: 0o600,
    });
    if (
      host.inspect(ticket, state.leaseId)?.documentGeneration !== identity.documentGeneration ||
      (
        await host.update(window, {
          leaseId: state.leaseId,
          bounds,
          visible: false,
          appearance: "dark",
        })
      ).state !== "retired" ||
      host.inspect(ticket, state.leaseId) !== null
    )
      throw new NativeFontFailure("Native font fixture exact retirement unavailable.");
    const native = host.diagnostics().native;
    if (!native?.gone || !native.destroyed)
      throw new NativeFontFailure("Native font fixture exact exit unavailable.");
    const retirementCrashPids = retirement.pids();
    if (retirementCrashPids.length !== (process.platform === "linux" ? 3 : 0))
      throw new NativeFontFailure("Native font fixture owned retirement witness unavailable.");
    process.stdout.write(
      `${JSON.stringify({ electron: process.versions.electron, electronNode: process.versions.node, electronAbi: process.versions.modules, platform: process.platform, arch: process.arch, graphics, retirementCrashPids, binaryFaces: "passed", parseReady: "passed", userOriginPolicy: "passed", authoredMetrics: "passed", semanticMono: "passed", generatedPreview: "passed", appExclusion: "passed", naturalFit: "passed", fontReadyCapture: "passed", retirement: "passed", fullHeight, narrowHeight })}\n`,
    );
  } finally {
    await host.close();
    window.destroy();
  }
}

void qualify().then(
  () => Electron.app.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof NativeFontFailure ? error.message : "Native font fixture qualification unavailable."}\n`,
    );
    Electron.app.exit(1);
  },
);
