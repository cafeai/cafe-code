import * as Electron from "electron";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  VisualizationHostBounds,
  VisualizationHostEvent,
  VisualizationHostLayout,
  VisualizationHostPresentation,
} from "@cafecode/contracts/visualizationHost";
import { DesktopVisualizationHost } from "./DesktopVisualizationHost.ts";
import { VISUALIZATION_EVENT_CHANNEL, VISUALIZATION_SCHEME } from "./visualizationHostPolicy.ts";

/** Only fixture-authored classifications may be printed; an authored guest's
 * thrown error/source/stack never becomes a successful or failed native log. */
class NativeBarFailure extends Error {}

/** Fixed own-frame observations only. No live Cafe/provider/profile is read and
 * no production DOM diagnostic is introduced. A blocked guest cannot extend
 * the existing five-second observation or the wrapper's native child budget. */
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
        timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()));
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (value === true) return;
    if (performance.now() >= deadline)
      throw new NativeBarFailure(`Native bar fixture ${label} unavailable.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** Native input targets only this fixture's exact owned child. Fixed selectors
 * return finite viewport coordinates; no received path/HTML is made a selector. */
async function pointer(
  contents: Electron.WebContents,
  target: "five" | "ten" | "row",
  click: boolean,
): Promise<void> {
  const selector =
    target === "five" ? '[data-limit="5"]' : target === "ten" ? '[data-limit="10"]' : ".row";
  const position: unknown = await contents.executeJavaScript(
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.floor(r.left+r.width/2),y:Math.floor(r.top+r.height/2)}})()`,
  );
  if (position === null || typeof position !== "object")
    throw new NativeBarFailure("Native bar fixture input refused.");
  const { x, y } = position as { x: unknown; y: unknown };
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < 0 ||
    x >= 1600 ||
    y < 0 ||
    y >= 2000
  )
    throw new NativeBarFailure("Native bar fixture input refused.");
  contents.sendInputEvent({ type: "mouseMove", x, y });
  if (click) {
    contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  }
}

const presentation: VisualizationHostPresentation = {
  locale: "en",
  reducedMotion: false,
  scale: 1,
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

const marksSettled =
  "(()=>{const m=[...document.querySelectorAll('.fill')];return m.length>0&&m.every(value=>value.style.transform===''&&getComputedStyle(value).transform==='none')})()";
const horizontalAndVerticalFit =
  "(()=>{const root=document.scrollingElement,unit=document.querySelector('.unit').getBoundingClientRect();return root.scrollWidth<=innerWidth+1&&root.scrollHeight<=innerHeight+1&&unit.left>=0&&unit.right<=innerWidth+1&&unit.bottom<=innerHeight&&innerHeight-unit.bottom<=1&&[...document.querySelectorAll('.row')].every(value=>{const r=value.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})})()";

process.on("uncaughtException", () => {
  process.stderr.write("Native bar fixture exception.\n");
  Electron.app.exit(1);
});

/** Separate native replay keeps the original comprehensive fixture's deadlines
 * intact. Default bytes are synthetic; exact local source arrives only through
 * the opt-in wrapper's admitted private copy, never a runtime DB discovery. */
async function qualify(): Promise<void> {
  const directory = process.argv[2];
  if (!directory) throw new NativeBarFailure("Native bar fixture directory refused.");
  Electron.app.setPath("userData", join(directory, "profile"));
  Electron.app.setPath("sessionData", join(directory, "session"));
  Electron.protocol.registerSchemesAsPrivileged([
    { scheme: VISUALIZATION_SCHEME, privileges: { standard: true, secure: true } },
  ]);
  await Electron.app.whenReady();
  if (process.platform === "darwin") Electron.app.setActivationPolicy("accessory");
  const window = new Electron.BrowserWindow({
    show: false,
    width: 680,
    height: 1000,
    webPreferences: {
      javascript: false,
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
    },
  });
  if (process.platform === "darwin") window.setAlwaysOnTop(true, "floating");
  await window.loadURL("data:text/html,<html><body>isolated bar owner</body></html>");
  window.show();
  Electron.app.focus({ steal: true });
  window.focus();
  const layouts: VisualizationHostEvent[] = [];
  const send = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) => {
    const value = args[0] as VisualizationHostEvent;
    if (channel === VISUALIZATION_EVENT_CHANNEL && value.state === "layout" && layouts.length < 64)
      layouts.push(value);
    send(channel, ...args);
  };
  const host = new DesktopVisualizationHost({
    stateDirectory: directory,
    preloadPath: join(directory, "visualizationPreload.cjs"),
  });
  await host.listen(false);
  const ticket = randomUUID().replaceAll("-", "").repeat(2);
  const owner = {
    environmentId: "isolated-native-bars",
    threadId: "synthetic-bars",
    operationId: randomUUID(),
  };
  const html = await readFile(join(directory, "bar-chart.html"), "utf8");
  if (Buffer.byteLength(html) > 32 * 1024)
    throw new NativeBarFailure("Native bar fixture source refused.");
  let bounds: VisualizationHostBounds = { x: 0, y: 0, width: 600, height: 180 };
  try {
    if (
      host.prepare({
        ticket,
        owner,
        document: {
          kind: "generated",
          html,
          assets: [],
          width: 600,
          height: 530,
          appearance: "dark",
        },
      }).status !== "ready"
    )
      throw new NativeBarFailure("Native bar fixture prepare refused.");
    const state = await host.open(window, { ticket, bounds, appearance: "dark", presentation });
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
    if (state.state !== "active" || state.expiresAtMs !== null || !identity || !contents)
      throw new NativeBarFailure("Native bar fixture admission refused.");
    // Qualify real normal-motion animation, not a synthetic media override or
    // a vacuous settled/reduced-motion observation. Production still respects
    // native reduced motion; this opt-in case reports an honest refusal there.
    await observe(
      contents,
      "matchMedia('(prefers-reduced-motion:reduce)').matches===false",
      "normal native motion",
    );
    const current = () =>
      host.inspect(ticket, state.leaseId)?.documentGeneration === identity.documentGeneration;
    const update = async (clipBounds?: VisualizationHostBounds, presentationHidden?: boolean) => {
      const result = await host.update(window, {
        leaseId: state.leaseId,
        bounds,
        ...(clipBounds ? { clipBounds } : {}),
        ...(presentationHidden !== undefined ? { presentationHidden } : {}),
        visible: true,
        appearance: "dark",
        presentation,
      });
      if (result.state !== "active" || !current())
        throw new NativeBarFailure("Native bar fixture exact update refused.");
    };
    await update();
    const settleLayout = async (): Promise<VisualizationHostLayout> => {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        const candidate = layouts.findLast((value) => value.leaseId === state.leaseId)?.layout;
        const extent: unknown = await contents.executeJavaScript(
          "(()=>{const body=document.body,unit=document.querySelector('.unit'),padding=Number.parseFloat(getComputedStyle(body).paddingBottom)||0;return Math.ceil(unit.getBoundingClientRect().bottom-body.getBoundingClientRect().top+padding)})()",
        );
        const latest = layouts.findLast((value) => value.leaseId === state.leaseId)?.layout;
        if (
          candidate &&
          latest?.sequence === candidate.sequence &&
          candidate.height === extent &&
          candidate.height > 180 &&
          candidate.height <= 2000 &&
          !candidate.constrained
        )
          return candidate;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      throw new NativeBarFailure("Native bar fixture natural extent unavailable.");
    };
    const fit = async (width: number): Promise<number> => {
      bounds = { ...bounds, x: 0, y: 0, width };
      await update();
      const layout = await settleLayout();
      bounds = { ...bounds, height: layout.height };
      await update();
      await observe(contents, horizontalAndVerticalFit, "full natural viewport fit");
      return layout.height;
    };
    const save = async (name: string) => {
      const capture = await host.capture(window, state.leaseId);
      if (!capture || capture.width !== bounds.width || capture.height !== bounds.height)
        throw new NativeBarFailure("Native bar fixture exact capture unavailable.");
      await writeFile(join(directory, name), capture.png, { flag: "wx", mode: 0o600 });
    };
    const topFiveHeight = await fit(600);
    await observe(contents, "document.querySelectorAll('.fill').length===5", "top five controls");
    await observe(contents, marksSettled, "top five entrance settlement");
    await save("native-bar-top5.png");
    if (!host.focus(window, state.leaseId))
      throw new NativeBarFailure("Native bar fixture focus refused.");
    await pointer(contents, "row", false);
    await observe(
      contents,
      "(()=>{const t=document.querySelector('[role=tooltip]'),s=getComputedStyle(t);return !t.hidden&&s.backgroundColor==='rgb(21, 23, 28)'&&s.color==='rgb(232, 237, 245)'})()",
      "dark semantic tooltip",
    );
    await pointer(contents, "ten", true);
    await observe(
      contents,
      "document.querySelectorAll('.fill').length===10",
      "top ten native click",
    );
    await observe(
      contents,
      "[...document.querySelectorAll('.fill')].some(value=>value.style.transform.startsWith('scaleX('))",
      "top ten finite entrance motion",
    );
    const topTenHeight = await fit(600);
    if (topTenHeight <= topFiveHeight + 100)
      throw new NativeBarFailure("Native bar fixture full top-ten extent unavailable.");
    await observe(contents, marksSettled, "top ten entrance settlement");
    await save("native-bar-top10.png");
    // Observe the author's own settled mark, without replacing source or its
    // visibility listeners. Any replay during ordinary positive clipping writes
    // a scale below one and increments this fixed scalar observer.
    await contents.executeJavaScript(
      "(()=>{const mark=document.querySelector('.fill');window.fixtureBarObservation={mark,resets:0};window.fixtureBarObserver=new MutationObserver(()=>{if(mark.style.transform!=='')window.fixtureBarObservation.resets++});window.fixtureBarObserver.observe(mark,{attributes:true,attributeFilter:['style']})})()",
    );
    for (let index = 0; index < 8; index++) {
      bounds = { ...bounds, y: -20 * (index + 1) };
      await update({ x: 0, y: 0, width: bounds.width, height: 200 });
      await contents.executeJavaScript(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      await observe(
        contents,
        "window.fixtureBarObservation.resets===0&&window.fixtureBarObservation.mark===document.querySelector('.fill')",
        "unchanged partial entrance",
      );
    }
    bounds = { ...bounds, y: 0 };
    await observe(
      contents,
      "(()=>{const c=document.querySelector('canvas[data-cafe-fluid]');return !document.hidden&&document.documentElement.dataset.cafePresentationVisible==='true'&&c.dataset.cafeFluidState==='running'&&c.dataset.cafeFluidRaf==='true'&&Number(c.dataset.cafeFluidFrames)>=12})()",
      "live bundled paint before menu",
    );
    await update(undefined, true);
    if (
      host.inspect(ticket, state.leaseId)?.state !== "suspended" ||
      host.focus(window, state.leaseId) ||
      (await host.capture(window, state.leaseId))
    )
      throw new NativeBarFailure("Native bar fixture hidden menu exposure refused.");
    await observe(
      contents,
      "(()=>{const c=document.querySelector('canvas[data-cafe-fluid]');return !document.hidden&&document.documentElement.dataset.cafeVisible==='true'&&document.documentElement.dataset.cafePresentationVisible==='false'&&c.dataset.cafeFluidState==='paused'&&c.dataset.cafeFluidRaf==='false'&&window.fixtureBarObservation.resets===0&&window.fixtureBarObservation.mark===document.querySelector('.fill')})()",
      "same menu-hidden document",
    );
    await contents.executeJavaScript(
      "(()=>{window.fixtureBarObservation.paintFrames=Number(document.querySelector('canvas[data-cafe-fluid]').dataset.cafeFluidFrames);return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()",
    );
    await observe(
      contents,
      "Number(document.querySelector('canvas[data-cafe-fluid]').dataset.cafeFluidFrames)===window.fixtureBarObservation.paintFrames&&window.fixtureBarObservation.resets===0",
      "menu paint pause without author entrance reset",
    );
    await update(undefined, false);
    await observe(
      contents,
      "(()=>{const c=document.querySelector('canvas[data-cafe-fluid]');return !document.hidden&&document.documentElement.dataset.cafeVisible==='true'&&document.documentElement.dataset.cafePresentationVisible==='true'&&c.dataset.cafeFluidState==='running'&&c.dataset.cafeFluidRaf==='true'&&Number(c.dataset.cafeFluidFrames)>window.fixtureBarObservation.paintFrames&&window.fixtureBarObservation.resets===0&&window.fixtureBarObservation.mark===document.querySelector('.fill')})()",
      "menu paint resume without author entrance reset",
    );
    await observe(contents, marksSettled, "unchanged menu return settlement");
    await update({ ...bounds, height: 20 });
    if (
      host.inspect(ticket, state.leaseId)?.state !== "suspended" ||
      (await host.capture(window, state.leaseId))
    )
      throw new NativeBarFailure("Native bar fixture tiny crop exposure refused.");
    await observe(
      contents,
      "(()=>{const c=document.querySelector('canvas[data-cafe-fluid]');return !document.hidden&&document.documentElement.dataset.cafeVisible==='true'&&document.documentElement.dataset.cafePresentationVisible==='false'&&c.dataset.cafeFluidState==='paused'&&c.dataset.cafeFluidRaf==='false'&&window.fixtureBarObservation.resets===0&&window.fixtureBarObservation.mark===document.querySelector('.fill')})()",
      "same tiny crop document",
    );
    await contents.executeJavaScript(
      "(()=>{window.fixtureBarObservation.paintFrames=Number(document.querySelector('canvas[data-cafe-fluid]').dataset.cafeFluidFrames);return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()",
    );
    await observe(
      contents,
      "Number(document.querySelector('canvas[data-cafe-fluid]').dataset.cafeFluidFrames)===window.fixtureBarObservation.paintFrames&&window.fixtureBarObservation.resets===0",
      "tiny crop paint pause without author entrance reset",
    );
    await update();
    await observe(
      contents,
      "(()=>{const c=document.querySelector('canvas[data-cafe-fluid]');return !document.hidden&&document.documentElement.dataset.cafeVisible==='true'&&document.documentElement.dataset.cafePresentationVisible==='true'&&c.dataset.cafeFluidState==='running'&&c.dataset.cafeFluidRaf==='true'&&Number(c.dataset.cafeFluidFrames)>window.fixtureBarObservation.paintFrames&&window.fixtureBarObservation.resets===0&&window.fixtureBarObservation.mark===document.querySelector('.fill')})()",
      "tiny crop paint resume without author entrance reset",
    );
    await observe(contents, marksSettled, "unchanged crop return settlement");
    const narrowHeight = await fit(320);
    if (narrowHeight <= topTenHeight)
      throw new NativeBarFailure("Native bar fixture responsive extent unavailable.");
    await save("native-bar-narrow.png");
    await pointer(contents, "five", true);
    await observe(
      contents,
      "document.querySelectorAll('.fill').length===5",
      "narrow top five native click",
    );
    await fit(320);
    if (!current() || state.expiresAtMs !== null)
      throw new NativeBarFailure("Native bar fixture source identity changed.");
    if (
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
      throw new NativeBarFailure("Native bar fixture offscreen retirement unavailable.");
    const native = host.diagnostics().native;
    if (!native?.gone || !native.destroyed)
      throw new NativeBarFailure("Native bar fixture exact exit unavailable.");
    process.stdout.write(
      `${JSON.stringify({ electron: process.versions.electron, electronNode: process.versions.node, electronAbi: process.versions.modules, platform: process.platform, arch: process.arch, bars: "passed", naturalHeight: "passed", horizontalFit: "passed", darkTooltip: "passed", partialContinuity: "passed", menuContinuity: "passed", tinyCropContinuity: "passed", offscreenRetirement: "passed", topFiveHeight, topTenHeight, narrowHeight, genuineVisibilityReplay: "authored" })}\n`,
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
      `${error instanceof NativeBarFailure ? error.message : "Native bar fixture qualification unavailable."}\n`,
    );
    Electron.app.exit(1);
  },
);
