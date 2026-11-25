// Playwright/Vite boundary. The fixture owns two loopback browser origins and
// joins its native handles before relinquishing them.
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { expect, it } from "vitest";

declare global {
  interface Window {
    launchRelayViewerFixture?: (version: string, corrupt?: boolean) => Promise<void>;
  }
}

const launcher = `<!doctype html><html><body><script type="module">
import { openHostViewer } from "/src/environments/relay/viewerHost.ts";
import { canonicalBytes } from "/@fs/__RELAY_PROTOCOL__";
const encoder = new TextEncoder();
async function digest(input) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(bytes, x => x.toString(16).padStart(2,"0")).join("");
}
sessionStorage.setItem("other-host-credential", "only-the-launcher");
window.launchRelayViewerFixture = async (version, corrupt = false) => {
  const script = \`
    import { version } from "./version.js";
    const { relay, started } = window.parent.cafeRelayViewer;
    const reply = await relay.request("/api/fixture");
    const api = await reply.text();
    const rpc = await new Promise((resolve, reject) => {
      const ws = relay.socket(relay.wsBaseUrl + "ws");
      ws.onopen = () => ws.send("ping");
      ws.onmessage = e => { resolve(e.data); ws.close(); };
      ws.onerror = reject;
    });
    let launcherPrivate = false;
    try { void window.top.sessionStorage.getItem("other-host-credential"); }
    catch { launcherPrivate = true; }
    document.querySelector("main").textContent = [version, api, rpc, launcherPrivate].join("|");
    started();
  \`;
  const files = new Map([
    ["index.html", encoder.encode('<main></main><script type="module" src="/assets/main.js"></' + 'script>')],
    ["assets/main.js", encoder.encode(script)],
    ["assets/version.js", encoder.encode("export const version = " + JSON.stringify(version))],
  ]);
  const entries = await Promise.all([...files].map(async ([file, bytes]) => ({
    file, bytes: bytes.length, sha256: await digest(bytes),
  })));
  const manifest = canonicalBytes({version: 1, applicationVersion: "1.0.0", files: entries});
  const manifestPath = "/api/relay/viewer/v1/manifest";
  const prefix = "/api/relay/viewer/v1/asset/" + await digest(manifest) + "/";
  await openHostViewer({
    environmentId: "env-" + version,
    httpBaseUrl: "https://fixture.cafecode-relay.invalid/",
    wsBaseUrl: "wss://fixture.cafecode-relay.invalid/",
    close: async () => {},
    request: async (path) => {
      if (path === manifestPath) return new Response(manifest);
      if (path === "/api/fixture") return new Response("http-" + version);
      const file = path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
      let bytes = files.get(file);
      if (!bytes) return new Response(null, {status:404});
      if (corrupt && file === "assets/main.js") {
        bytes = bytes.slice();
        bytes[0] = bytes[0] ^ 1;
      }
      return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")), {
        headers: {"content-type":"application/gzip"},
      });
    },
    socket: () => {
      const socket = {
        send: msg => queueMicrotask(() => socket.onmessage?.(new MessageEvent("message", {data:msg + "-" + version}))),
        close: () => socket.onclose?.(new CloseEvent("close", {code:1000})),
      };
      queueMicrotask(() => socket.onopen?.(new Event("open")));
      return socket;
    },
  });
};
</script></body></html>`;

it("loads each host's exact renderer at a distinct browser origin and exposes only its app transport", async (test) => {
  let vite: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let retired = false;
  let closingVite: Promise<void> | undefined;
  let closingBrowser: Promise<void> | undefined;
  const close = async () => {
    retired = true;
    if (browser) closingBrowser ??= browser.close();
    if (vite) closingVite ??= vite.close();
    await Promise.allSettled([closingBrowser, closingVite]);
  };
  test.signal.addEventListener("abort", () => void close(), { once: true });
  test.onTestFinished(close);
  const check = async () => {
    if (retired) {
      await close();
      throw new Error("relay-viewer-fixture-retired");
    }
  };
  vite = await createServer({
    root: import.meta.dirname + "/..",
    server: { host: "127.0.0.1", port: 0, hmr: false, allowedHosts: [".localhost"] },
    plugins: [
      {
        name: "relay-viewer-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === "/_fixture/launcher") {
              res.setHeader("content-type", "text/html");
              res.end(
                launcher.replace(
                  "__RELAY_PROTOCOL__",
                  new URL("../../../packages/relay/src/protocol.ts", import.meta.url).pathname,
                ),
              );
              return;
            }
            if (req.url === "/_relay/frame") req.url = "/relay-frame.html";
            if (req.url === "/_relay/worker.js") {
              req.url = "/relay-viewer-sw.js";
              res.setHeader("service-worker-allowed", "/");
            }
            next();
          });
        },
      },
    ],
  });
  await check();
  await vite.listen();
  await check();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("relay-viewer-fixture-listener");
  browser = await chromium.launch({ chromiumSandbox: true });
  await check();
  const context = await browser.newContext();
  await check();
  const origins = new Set<string>();
  for (const version of ["one", "two"]) {
    const page = await context.newPage();
    await check();
    await page.goto(`http://localhost:${address.port}/_fixture/launcher`);
    await page.waitForFunction(() => typeof window.launchRelayViewerFixture === "function");
    await page.evaluate((version) => window.launchRelayViewerFixture!(version), version);
    await check();
    const outer = page.frameLocator("iframe");
    expect(await outer.frameLocator("iframe").locator("main").innerText()).toBe(
      [version, "http-" + version, "ping-" + version, "true"].join("|"),
    );
    const frameUrl = await page.locator("iframe").getAttribute("src");
    expect(frameUrl).toBeTruthy();
    origins.add(new URL(frameUrl!).origin);
    expect(await page.evaluate(() => sessionStorage.getItem("other-host-credential"))).toBe(
      "only-the-launcher",
    );
  }
  expect(origins.size).toBe(2);
  const corrupted = await context.newPage();
  await check();
  await corrupted.goto(`http://localhost:${address.port}/_fixture/launcher`);
  await corrupted.waitForFunction(() => typeof window.launchRelayViewerFixture === "function");
  expect(
    await corrupted.evaluate(async () => {
      try {
        await window.launchRelayViewerFixture!("changed", true);
        return "mounted";
      } catch {
        return "refused";
      }
    }),
  ).toBe("refused");
  await expect.poll(() => corrupted.locator("iframe").count()).toBe(0);
}, 60_000);
