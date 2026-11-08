// @effect-diagnostics nodeBuiltinImport:off
// Explicit native TLS/browser boundary: owns only loopback listeners and fresh
// Chromium/Electron profiles. No provider, trust-store write or live API call.
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LookupFunction } from "node:net";
import { expect, it, type TestContext } from "vitest";
import {
  chromium,
  _electron,
  type Browser,
  type BrowserServer,
  type ElectronApplication,
  type Page,
} from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { startRelayServer } from "@cafecode/relay-server/server";
import { createIdentity, deriveIdentityId, sha256 } from "@cafecode/relay/crypto";
import { opaque, randomOpaque, unopaque } from "@cafecode/relay/bytes";
import { signNetwork, relayHttpEndpoint } from "@cafecode/relay/descriptor";
import { canonicalBytes } from "@cafecode/relay/protocol";
import { createInvitationUrl } from "@cafecode/relay/invitation";
import { connectNative } from "@cafecode/relay/nativeWire";
import { RelayHost } from "@cafecode/relay/host";
import { RelayError } from "@cafecode/relay/errors";
import { epochNow, Lifetime } from "@cafecode/relay/lifetime";
import { serveRelayedHttp } from "@cafecode/relay/http";
import type { RelaySession } from "@cafecode/relay/session";

const enabled = process.env.CAFE_RELAY_NATIVE_E2E === "1";
const hostname = "vps-692e150f.vps.ovh.net";
const localLookup: LookupFunction = (_host, options, callback) => {
  if (_host !== hostname) {
    callback(new Error("fixture-host-refused"), "", 4);
    return;
  }
  if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
  else callback(null, "127.0.0.1", 4);
};

async function fixture(test: TestContext, native: "chromium" | "electron") {
  const lifetime = new Lifetime();
  let server: Awaited<ReturnType<typeof startRelayServer>> | undefined,
    host: RelayHost | undefined,
    vite: ViteDevServer | undefined,
    browser: Browser | undefined,
    browserServer: BrowserServer | undefined,
    electron: ElectronApplication | undefined,
    directory: string | undefined;
  let retired = false;
  const closes = new Map<object, () => Promise<void>>();
  let nativeClose: Promise<void> | undefined, removal: Promise<void> | undefined;
  const register = (value: object | undefined, close: () => Promise<void>) => {
    if (value && !closes.has(value)) {
      let job: Promise<void> | undefined;
      closes.set(value, () => (job ??= close()));
    }
  };
  const collect = () => {
    if (browserServer) register(browserServer, () => browserServer!.close());
    else register(browser, () => browser!.close());
    register(electron, () => electron!.close());
    register(host, () => host!.close());
    register(server, () => server!.close());
    register(vite, () => vite!.close());
  };
  const retire = () => {
    retired = true;
    lifetime.retire();
    collect();
    for (const close of closes.values()) void close();
  };
  test.signal.addEventListener("abort", retire, { once: true });
  const close = async () => {
    retire();
    await Promise.all([...closes.values()].map((close) => close()));
    await nativeClose;
    await lifetime.close();
    if (directory) await (removal ??= rm(directory, { recursive: true, force: true }));
  };
  test.onTestFinished(close);
  const check = async () => {
    collect();
    if (retired) {
      await close();
      throw new Error("fixture-retired");
    }
  };
  const keyPath = process.env.CAFE_RELAY_TLS_KEY,
    certPath = process.env.CAFE_RELAY_TLS_CERT;
  if (!keyPath || !certPath) throw new Error("explicit-local-tls-fixture-required");
  const tls = { key: await readFile(keyPath, "utf8"), cert: await readFile(certPath, "utf8") };
  await check();
  const [root, node, admission, hostKey] = await Promise.all(
    Array.from({ length: 4 }, () => createIdentity()),
  );
  await check();
  const nodeId = deriveIdentityId("node", node!.publicKey),
    locator = randomOpaque(),
    capacity = randomOpaque(),
    secret = randomOpaque(),
    bearer = randomOpaque();
  let network = await signNetwork({
    root: root!,
    revision: 1,
    expiresAt: epochNow() + 3_600_000,
    nodes: [{ id: nodeId, publicKey: node!.publicKey, url: `wss://${hostname}:1/v1/relay` }],
  });
  await check();
  server = await startRelayServer({
    network,
    nodeId,
    host: "127.0.0.1",
    port: 0,
    tls,
    grants: [
      {
        locator,
        admissionPublicKey: admission!.publicKey,
        tokenDigest: opaque(sha256(unopaque(capacity, 32))),
      },
    ],
  });
  await check();
  network = await signNetwork({
    root: root!,
    revision: 2,
    expiresAt: epochNow() + 3_600_000,
    nodes: [
      { id: nodeId, publicKey: node!.publicKey, url: `wss://${hostname}:${server.port}/v1/relay` },
    ],
  });
  await server.updateNetwork(canonicalBytes(network));
  await check();
  const authOperations: string[] = [],
    sessions = new Set<RelaySession>();
  let pairedDevice: string | undefined,
    consumed = false;
  host = new RelayHost({
    network,
    identity: hostKey!,
    credentials: [{ nodeId, locator, token: capacity, admissionIdentity: admission! }],
    dial: (member, resources) => connectNative(member.url, resources, { lookup: localLookup }),
    measureLatency: async () => 1,
    handlers: {
      authenticate: async (input, device) => {
        if (input.environmentId !== "native-browser-fixture")
          throw new RelayError("ENVIRONMENT_MISMATCH");
        authOperations.push(input.operation);
        if (input.operation === "pair") {
          if (!input.secondFactor) throw new RelayError("SECOND_FACTOR_REQUIRED");
          if (consumed || input.credential !== secret || input.secondFactor !== "123456")
            throw new RelayError("AUTH_REJECTED");
          consumed = true;
          pairedDevice = device;
        } else if (
          input.operation !== "resume" ||
          input.credential !== bearer ||
          device !== pairedDevice
        )
          throw new RelayError("AUTH_REJECTED");
        return {
          environmentId: input.environmentId,
          bearerToken: bearer,
          role: "client",
          expiresAt: epochNow() + 3_600_000,
        };
      },
      open: async (stream, metadata) => {
        sessions.add(stream.owner);
        if (stream.kind === "rpc") {
          await stream.accept({ protocol: "ndjson" });
          for (;;) {
            const bytes = await stream.read();
            if (!bytes) break;
            await stream.write(bytes);
          }
          await stream.finish();
          return;
        }
        await serveRelayedHttp(stream, metadata, async (request) => {
          if (new URL(request.url).pathname === "/api/echo")
            return new Response(request.body, {
              headers: {
                "content-type": "application/octet-stream",
                "content-length": request.headers.get("content-length")!,
              },
            });
          return new Response("native-relay-http-canary", {
            headers: { "content-type": "text/plain" },
          });
        });
      },
    },
  });
  await host.start();
  await check();
  const rootPath = fileURLToPath(new URL("..", import.meta.url));
  vite = await createServer({
    configFile: resolve(rootPath, "vite.config.ts"),
    root: rootPath,
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      https: tls,
      hmr: false,
      allowedHosts: [hostname],
    },
    plugins: [
      {
        name: "private-relay-fixture",
        transformIndexHtml: {
          order: "post",
          handler: (html) =>
            html.replace(/<script type="module" src="\/@vite\/client"><\/script>/g, ""),
        },
        configureServer(value) {
          value.middlewares.use((req, _res, next) => {
            if (
              req.url?.split("?")[0] === "/relay/pair" ||
              req.url?.split("?")[0] === "/relay/connect" ||
              req.url === "/"
            )
              req.url = "/test/relay-fixture.html";
            next();
          });
        },
      },
    ],
  });
  await check();
  await vite.listen();
  await check();
  const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("fixture-listener-missing");
  const origin = `https://${hostname}:${address.port}`;
  const invitation = async (hostPublicKey = hostKey!.publicKey) => {
    const ticket = await host!.invitationTicket();
    return createInvitationUrl(
      origin,
      {
        version: 1,
        networkId: network.networkId,
        networkRootPublicKey: root!.publicKey,
        minimumRevision: network.revision,
        bootstrapUrls: [relayHttpEndpoint(network.nodes[0]!, "/v1/network")],
        hostPublicKey,
        environmentId: "native-browser-fixture",
        locator,
        nodeId,
        registrationId: ticket.registrationId,
        inviteTicket: ticket.token,
        pairingSecret: secret,
        expiresAt: epochNow() + 300_000,
      },
      epochNow(),
    );
  };
  const resolver = `MAP ${hostname} 127.0.0.1`;
  directory = await mkdtemp(join(tmpdir(), "cafe-relay-browser-"));
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
  let page: Page;
  if (native === "chromium") {
    browserServer = await chromium.launchServer({
      env,
      headless: true,
      args: [`--host-resolver-rules=${resolver}`, "--no-proxy-server"],
    });
    const child = browserServer.process();
    nativeClose = new Promise((resolve) => child.once("close", () => resolve()));
    await check();
    browser = await chromium.connect(browserServer.wsEndpoint());
    await check();
    const context = await browser.newContext();
    await check();
    page = await context.newPage();
    await check();
  } else {
    const main = join(directory, "main.cjs");
    await writeFile(
      main,
      `const {app,BrowserWindow}=require('electron'); app.setPath('userData', ${JSON.stringify(directory)}); app.commandLine.appendSwitch('host-resolver-rules', ${JSON.stringify(resolver)}); app.commandLine.appendSwitch('no-proxy-server'); app.whenReady().then(()=>{const w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});w.loadURL('about:blank');});app.on('window-all-closed',()=>app.quit());`,
    );
    const require = createRequire(new URL("../../desktop/package.json", import.meta.url));
    const executablePath: unknown = require("electron");
    if (typeof executablePath !== "string") throw new Error("electron-missing");
    electron = await _electron.launch({
      executablePath,
      args: [main, directory],
      env,
      timeout: 20_000,
    });
    const child = electron.process();
    nativeClose = new Promise((resolve) => child.once("close", () => resolve()));
    await check();
    page = await electron.firstWindow();
    await check();
  }
  return { page, invitation, host, server, authOperations, sessions, close, secret, bearer };
}

for (const native of ["chromium", "electron"] as const)
  it.runIf(enabled)(
    `${native}: qualifies pinned Noise, explicit pairing, wrapped persistence, reconnect, RPC and HTTP over validated TLS`,
    async (test) => {
      const f = await fixture(test, native);
      let leaked = false;
      test.onTestFailed(() => {
        process.stdout.write(
          JSON.stringify({ phase: "native-browser-relay", authCalls: f.authOperations.length }) +
            "\n",
        );
      });
      f.page.on("request", (request) => {
        const url = request.url();
        if (url.includes(f.secret) || url.includes(f.bearer)) leaked = true;
      });
      await f.page.goto(await f.invitation());
      await f.page.getByRole("button", { name: "Connect", exact: true }).waitFor();
      expect(new URL(f.page.url()).hash).toBe("");
      const screenshotDirectory = process.env.CAFE_RELAY_SCREENSHOTS;
      if (screenshotDirectory && native === "chromium") {
        await mkdir(screenshotDirectory, { recursive: true, mode: 0o700 });
        await f.page.setViewportSize({ width: 390, height: 844 });
        await f.page.emulateMedia({ reducedMotion: "reduce" });
        for (const dark of [false, true])
          for (const scale of [80, 130]) {
            await f.page.evaluate(
              ({ dark, scale }) => window.relayQualification.appearance(dark, scale),
              { dark, scale },
            );
            await f.page.screenshot({
              path: join(screenshotDirectory, (dark ? "dark" : "light") + "-" + scale + ".png"),
            });
          }
      }

      await f.page.getByRole("button", { name: "Connect", exact: true }).click();
      await f.page.getByRole("status").waitFor();
      expect(await f.page.getByRole("status").textContent()).toContain("Enter an authenticator");
      await f.page.getByRole("textbox").fill("123456");
      await f.page.getByRole("button", { name: "Connect", exact: true }).click();
      await f.page.getByText("Paired", { exact: true }).waitFor();
      const actual = await f.page.evaluate(() => window.relayQualification.exercise());
      expect(actual).toEqual({
        text: "native-relay-http-canary",
        length: 524_309,
        equal: true,
        rpc: true,
      });
      for (const session of f.sessions) session.retire();
      // Observe this exact viewer channel's retirement before starting a new
      // read. Mid-flight HTTP failures remain incomplete and are never replayed.
      await f.page.waitForFunction(() => window.relayQualification.retired());
      expect(await f.page.evaluate(() => window.relayQualification.read())).toBe(
        "native-relay-http-canary",
      );
      await f.page.reload();
      await f.page.getByRole("button", { name: "Connect", exact: true }).click();
      await f.page.getByText("Paired", { exact: true }).waitFor();
      expect(f.authOperations).toEqual(["pair", "pair", "resume", "resume"]);
      const stored = await f.page.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("cafe-relay-viewers");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(new Error("store"));
        });
        try {
          return await new Promise<unknown>((resolve, reject) => {
            const tx = database.transaction("targets"),
              request = tx.objectStore("targets").getAll();
            tx.oncomplete = () => resolve(request.result);
            tx.onerror = () => reject(new Error("store"));
          });
        } finally {
          database.close();
        }
      });
      expect(JSON.stringify(stored)).not.toContain(f.bearer);
      expect(JSON.stringify(stored)).not.toContain(f.secret);
      expect(leaked).toBe(false);
      expect(
        Array.isArray(stored) &&
          stored.length === 1 &&
          typeof stored[0] === "object" &&
          stored[0] !== null &&
          !["bearerToken", "tickets", "devicePrivateKey", "ciphertext", "iv"].some(
            (key) => key in stored[0],
          ),
      ).toBe(true);
      const id = await f.page.evaluate(() => sessionStorage.getItem("cafe-relay-active")!);
      await f.page.evaluate(() => sessionStorage.clear());
      await f.page.goto(new URL("/relay/connect", f.page.url()).href);
      await f.page.getByRole("combobox").getByText(id.slice(0, 12), { exact: true }).waitFor();
      await f.page.getByRole("button", { name: "Connect", exact: true }).click();
      await f.page.getByRole("status").waitFor();
      expect(await f.page.getByRole("status").textContent()).toContain("fresh invitation");
      expect(f.authOperations).toEqual(["pair", "pair", "resume", "resume"]);

      await f.close();
      expect(f.server.stats()).toMatchObject({ owners: 0, pendingBytes: 0, nativeSockets: 0 });
      // A fresh fixture ensures the negative reaches Noise rather than merely
      // exhausts this IP's anonymous admission allowance from the positive flow.
      const rejected = await fixture(test, native),
        substituted = await createIdentity();
      await rejected.page.goto(await rejected.invitation(substituted.publicKey));
      await rejected.page.getByRole("textbox").fill("123456");
      await rejected.page.getByRole("button", { name: "Connect", exact: true }).click();
      await rejected.page.getByRole("status").waitFor();
      expect(await rejected.page.getByRole("status").textContent()).toContain("fresh invitation");
      expect(rejected.authOperations).toEqual([]);
      expect(rejected.server.stats().tickets).toBe(0);
      await rejected.close();
    },
    60_000,
  );
