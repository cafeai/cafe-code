// @effect-diagnostics nodeBuiltinImport:off
// Opt-in native boundary: owns only its preview, exact Chromium child and
// temporary profile. No provider, ambient credentials or trust-store changes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserServer } from "playwright";
import { preview, type PreviewServer } from "vite";
import type { TestContext } from "vitest";

export async function compiledRelayViewer(
  test: TestContext,
  hostname: string,
  tls: { key: string; cert: string },
  publicOrigin?: string,
) {
  let retired = false,
    server: PreviewServer | undefined,
    browserServer: BrowserServer | undefined,
    browser: Browser | undefined,
    directory: string | undefined,
    nativeClose: Promise<void> | undefined,
    removal: Promise<void> | undefined;
  const closes = new Map<object, () => Promise<void>>();
  const collect = () => {
    if (server && !closes.has(server)) {
      let job: Promise<void> | undefined;
      const owned = server;
      closes.set(owned, () => (job ??= owned.close()));
    }
    if (browserServer && !closes.has(browserServer)) {
      let job: Promise<void> | undefined;
      const owned = browserServer;
      closes.set(owned, () => (job ??= owned.close()));
    }
  };
  const retire = () => {
    retired = true;
    collect();
    for (const close of closes.values()) void close();
  };
  const close = async () => {
    retire();
    await Promise.all([...closes.values()].map((close) => close()));
    await nativeClose;
    if (directory) await (removal ??= rm(directory, { recursive: true, force: true }));
  };
  test.signal.addEventListener("abort", retire, { once: true });
  test.onTestFinished(close);
  const check = async () => {
    collect();
    if (retired) {
      await close();
      throw new Error("compiled-relay-fixture-retired");
    }
  };
  let origin = publicOrigin;
  if (!origin) {
    server = await preview({
      configFile: false,
      root: fileURLToPath(new URL("../../../web/", import.meta.url)),
      build: { outDir: "dist" },
      preview: { host: "127.0.0.1", port: 0, https: tls, allowedHosts: [hostname] },
    });
    await check();
    const address = server.httpServer.address();
    if (!address || typeof address === "string") throw new Error("compiled-relay-preview-address");
    origin = `https://${hostname}:${address.port}`;
  }
  directory = await mkdtemp(join(tmpdir(), "cafe-relay-application-"));
  await check();
  const env: Record<string, string> = {
    HOME: directory,
    CFFIXED_USER_HOME: directory,
    TMPDIR: directory,
    XDG_CONFIG_HOME: directory,
    XDG_CACHE_HOME: directory,
  };
  for (const key of [
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SystemRoot",
    "WINDIR",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  browserServer = await chromium.launchServer({
    env,
    headless: true,
    chromiumSandbox: true,
    args: publicOrigin
      ? ["--no-proxy-server"]
      : [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, "--no-proxy-server"],
  });
  const child = browserServer.process();
  nativeClose = new Promise((resolve) => child.once("close", () => resolve()));
  await check();
  browser = await chromium.connect(browserServer.wsEndpoint());
  await check();
  const context = await browser.newContext();
  await check();
  const page = await context.newPage();
  await check();
  page.setDefaultTimeout(10_000);
  let phase = "created",
    pageErrors = 0;
  test.signal.addEventListener(
    "abort",
    () => {
      process.stdout.write("compiled-viewer-retired: " + phase + "\n");
    },
    { once: true },
  );
  page.on("pageerror", () => {
    pageErrors++;
  });
  test.onTestFailed(() => {
    process.stdout.write(JSON.stringify({ phase: "compiled-viewer-" + phase, pageErrors }) + "\n");
  });
  return {
    origin,
    close,
    async qualify(invitation: string) {
      phase = "navigation";
      await page.goto(invitation);
      phase = "pair";
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      phase = "project";
      try {
        await page.getByRole("button", { name: "Skip", exact: true }).click();
        await page.getByText("Default Project", { exact: true }).first().waitFor();
      } catch (error) {
        const screenshot = process.env.CAFE_RELAY_APP_SCREENSHOT;
        if (screenshot) await page.screenshot({ path: screenshot, timeout: 5_000 });
        throw error;
      }
      phase = "thread";
      await page.getByText("Default Thread", { exact: true }).first().click();
      phase = "composer";
      await page.getByRole("textbox").first().waitFor();
      if (new URL(page.url()).hash !== "") throw new Error("compiled-relay-fragment-retained");
      const screenshot = process.env.CAFE_RELAY_APP_SCREENSHOT;
      if (screenshot) await page.screenshot({ path: screenshot, timeout: 5_000 });
      await check();
      phase = "opened";
    },
  };
}
