// Native fixture owns exact child argv, stdio handles and retirement; keep that process boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
// Native fixture paths retain host drive, separator and namespace semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// Keep the real dev-tool servers out of this test runner's process. In
// particular, createVitest resolves an API token in OS user data even when no
// tests are run. Its entire home/config/temp namespace must belong to the
// fixture, not the developer or the outer runner. The child only imports the
// installed tools' public entry points and never starts a test or browser.
const qualificationSource = String.raw`
import assert from "node:assert/strict";
// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
// Native fixture retains exact loopback socket/response lifetime and bounded streaming controls.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
// Native fixture paths retain host drive, separator and namespace semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join, posix } from "node:path";

const entries = JSON.parse(process.argv[2]);
const { createServer: createViteServer, normalizePath, version: viteVersion } =
  await import(entries.vite);
const { createVitest, VitestPackageInstaller, version: vitestVersion } = await import(entries.vitest);
const { playwright } = await import(entries.playwright);
const fixtureRoot = realpathSync.native(process.cwd());
const servedRoot = join(fixtureRoot, "served");
mkdirSync(join(servedRoot, ".git"), { recursive: true });
writeFileSync(join(servedRoot, "package.json"), '{"private":true,"type":"module"}\n');
const allowedContents = "cafe-owned-allowed-control\n";
writeFileSync(join(servedRoot, "allowed.txt"), allowedContents);
const viteDeniedFiles = [".env", ".npmrc", ".git/config"];
const vitestDeniedFiles = [...viteDeniedFiles, ".vitest-secret-token"];
const deniedContents = vitestDeniedFiles.map((_, index) => "cafe-owned-denied-sentinel-" + index);
vitestDeniedFiles.forEach((file, index) => {
  writeFileSync(join(servedRoot, file), deniedContents[index]);
});
const outsideFile = join(fixtureRoot, "outside-allow.txt");
const outsideContents = "cafe-owned-outside-allow-sentinel";
writeFileSync(outsideFile, outsideContents);

// The child owns every OS-specific user-data root. Qualify the token Vitest
// actually publishes there, not an assumed fallback under node_modules. An
// adjacent benign file is explicitly allowed as a byte-for-byte HTTP control,
// so a refused token proves the deny rule rather than an outside-allow check.
const userDataRoot = process.platform === "win32"
  ? process.env.LOCALAPPDATA
  : process.platform === "darwin"
    ? join(homedir(), "Library/Application Support")
    : process.env.XDG_DATA_HOME;
assert.ok(userDataRoot);
const actualTokenPath = join(userDataRoot, "vitest", ".vitest-secret-token");
const tokenControlPath = join(dirname(actualTokenPath), "allowed-token-neighbor.txt");
let actualToken;

// This inert resolved module creates the precise root-relative-URL/absolute-ID
// collision from Vite's safeModulePaths regression. Import analysis must admit
// the actual resolved decoy, never the different outside-allow file whose path
// happens to equal its root-relative URL. Neither plugin hook reads that file.
const collisionPath = normalizePath(outsideFile).replace(/^[A-Z]:/i, "");
const decoyId = posix.join(normalizePath(servedRoot), collisionPath);
const decoySource = 'export const decoy = "cafe-owned-inert-decoy";';
writeFileSync(
  join(servedRoot, "entry.js"),
  'import { decoy } from "virtual:cafe-file-access-decoy"; export { decoy };\n',
);
const decoyPlugin = {
  name: "cafe-fixture-file-access-decoy",
  enforce: "pre",
  resolveId(id) {
    if (id === "virtual:cafe-file-access-decoy") return decoyId;
  },
  load(id) {
    if (id === decoyId) return decoySource;
  },
};

// Missing packages must fail this opt-in qualification, not prompt for an
// installation. The real public installed-package check is retained; no server
// plugin, deny list, request admission or Browser Mode implementation is mocked.
class InstalledPackagesOnly extends VitestPackageInstaller {
  async ensureInstalled(dependency, root) {
    assert.equal(this.isPackageExists(dependency, {
      paths: [root, entries.vitestDirectory],
    }), true, "qualification requires an already installed dependency: " + dependency);
    return true;
  }
}

let vite;
let vitest;
let rootHttp;
let viteDenied = 0;
let vitestDenied = 0;
const requestLimit = 64 * 1024;

async function request(base, path) {
  const response = await fetch(new URL(path, base), {
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
    headers: { Accept: "text/plain", Connection: "close" },
  });
  let length = 0;
  const chunks = [];
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        assert.ok(length <= requestLimit, "fixture HTTP response exceeded finite bound");
        chunks.push(Buffer.from(next.value));
      }
    } finally {
      await reader.cancel();
    }
  }
  return { status: response.status, body: Buffer.concat(chunks).toString("utf8") };
}

function baseUrl(httpServer) {
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  assert.ok(Number.isInteger(address.port) && address.port > 0);
  return "http://127.0.0.1:" + address.port;
}

async function assertAllowed(base, label) {
  const response = await request(base, "/allowed.txt");
  assert.equal(response.status, 200, label + " allowed control status");
  assert.equal(response.body, allowedContents, label + " allowed control bytes");
}

async function assertDenied(base, path, label, status = 403) {
  const response = await request(base, path);
  assert.equal(response.status, status, label + " refused " + path);
  for (const contents of [...deniedContents, outsideContents, ...(actualToken ? [actualToken] : [])]) {
    assert.ok(!response.body.includes(contents), label + " exposed a denied fixture sentinel");
  }
}

async function assertDefaultDeny(base, label, deniedFiles) {
  await assertAllowed(base, label);
  for (const file of deniedFiles) {
    // The ordinary static path detects Vitest replacing Vite's default deny
    // list with only its API-token entry. Raw and wasm-instance requests also
    // traverse the real transform admission rather than just static serving.
    for (const query of ["", "?raw", "?vite-wasm-instance"]) {
      await assertDenied(base, "/" + file + query, label);
      if (label === "vite") viteDenied++;
      else vitestDenied++;
    }
  }
  await assertAllowed(base, label + " after refusals");
}

async function assertActualTokenDeny(base, label) {
  const control = await request(base, "/@fs/" + normalizePath(tokenControlPath));
  assert.equal(control.status, 200, label + " actual token-directory allowed control");
  assert.equal(control.body, allowedContents, label + " actual token-directory control bytes");
  for (const query of ["", "?raw", "?vite-wasm-instance"]) {
    await assertDenied(base, "/@fs/" + normalizePath(actualTokenPath) + query, label + " actual API token");
    vitestDenied++;
  }
}

try {
  vite = await createViteServer({
    configFile: false,
    root: servedRoot,
    envFile: false,
    publicDir: false,
    cacheDir: join(fixtureRoot, "vite-cache"),
    logLevel: "error",
    clearScreen: false,
    plugins: [decoyPlugin],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: "127.0.0.1", port: 0, strictPort: true,
      watch: null, preTransformRequests: false,
      fs: { strict: true, allow: [servedRoot] },
    },
  });
  await vite.listen(0);
  const viteBase = baseUrl(vite.httpServer);
  await assertDefaultDeny(viteBase, "vite", viteDeniedFiles);
  const outsideRequest = "/@fs/" + normalizePath(outsideFile);
  await assertDenied(viteBase, outsideRequest + "?import&vite-wasm-instance", "vite wasm allow");
  viteDenied++;
  const transformed = await request(viteBase, "/entry.js");
  assert.equal(transformed.status, 200, "inert import-analysis control");
  assert.ok(transformed.body.includes("decoy"), "inert import was transformed");
  assert.ok(!transformed.body.includes("virtual:cafe-file-access-decoy"), "virtual import resolved");
  // This is a valid /@fs/ request on every host. Windows raw-FS middleware
  // strips the drive before serving from the child's current drive, so this
  // existing outside file must still be refused, not treated as absent.
  await assertDenied(viteBase, "/@fs/" + collisionPath, "vite URL/path collision");
  viteDenied++;
  await assertDenied(viteBase, outsideRequest, "vite actual outside allow");
  viteDenied++;
  await assertAllowed(viteBase, "vite after import analysis");
  await vite.close();
  vite = undefined;

  const browserOptions = () => ({
    enabled: true,
    headless: true,
    provider: playwright(),
    instances: [{ browser: "chromium" }],
  });
  vitest = await createVitest(
    { config: false, root: servedRoot, watch: false, run: true },
    {
      configFile: false, root: servedRoot, envFile: false, publicDir: false,
      cacheDir: join(fixtureRoot, "vitest-cache"),
      logLevel: "error", clearScreen: false,
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        host: "127.0.0.1", port: 0, strictPort: true,
        watch: null, preTransformRequests: false,
        fs: { strict: true, allow: [servedRoot, dirname(actualTokenPath)] },
      },
      test: {
        include: [], watch: false, fileParallelism: false, maxWorkers: 1,
        projects: [
          { test: { name: "shared", include: [] } },
          { test: { name: "browser-inline", include: [], browser: browserOptions() } },
          { test: {
            name: "browser-own", include: [], browser: browserOptions(),
            alias: { "cafe-fixture-never-imported": join(servedRoot, "allowed.txt") },
          } },
        ],
      },
    },
    { packageInstaller: new InstalledPackagesOnly() },
  );
  actualToken = readFileSync(actualTokenPath, "utf8").trim();
  assert.ok(actualToken.length > 0 && actualToken === vitest.config.api.token,
    "exact fixture-owned OS token was adopted by Vitest");
  writeFileSync(tokenControlPath, allowedContents);
  const shared = vitest.projects.find((project) => project.name === "shared");
  const browserProjects = vitest.projects.filter((project) => project.config.browser.enabled);
  assert.ok(shared, "root-sharing inline project exists");
  assert.ok(shared.vite === vitest.vite, "inline Node project actually shares root server");
  assert.equal(browserProjects.length, 2, "both declared Browser Mode projects exist");
  for (const project of browserProjects) {
    assert.ok(project.browser, "real Browser Mode server contribution was installed");
    assert.ok(project.browser.vite.httpServer, "Browser Mode owns a native HTTP server");
    assert.ok(project.browser.provider === undefined, "no browser provider was initialized");
    assert.deepEqual(project.config.include, [], "no test files can start provider prewarming");
  }
  assert.ok(
    browserProjects[0].browser.vite.httpServer !== browserProjects[1].browser.vite.httpServer,
    "Browser Mode projects own distinct native HTTP servers",
  );

  // Root/shared Node mode uses Vite's real middleware pipeline. Its HTTP wrapper
  // is owned by this fixture; Browser Mode owns two separate actual Vite HTTP
  // servers. No test starts, private runner method or fake provider is involved.
  rootHttp = createHttpServer((req, res) => {
    vitest.vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end("fixture not found");
    });
  });
  await new Promise((resolve, reject) => {
    rootHttp.once("error", reject);
    rootHttp.listen(0, "127.0.0.1", resolve);
  });
  await assertDefaultDeny(baseUrl(rootHttp), "vitest root/shared", vitestDeniedFiles);
  await assertActualTokenDeny(baseUrl(rootHttp), "vitest root/shared");
  for (const project of browserProjects) {
    // Use the actual public Browser Mode accessor. Its configureServer view is
    // not required to be reference-equal to the project's transform-server
    // facade; native HTTP ownership, not wrapper identity, binds these probes.
    const browserVite = project.browser.vite;
    await browserVite.listen(0);
    const browserBase = baseUrl(browserVite.httpServer);
    await assertDefaultDeny(browserBase, "vitest " + project.name, vitestDeniedFiles);
    await assertActualTokenDeny(browserBase, "vitest " + project.name);
    assert.ok(project.browser.provider === undefined, "HTTP serving did not start a browser");
  }
  assert.equal(readFileSync(outsideFile, "utf8"), outsideContents);
  process.stdout.write("CAFE_DEV_TOOL_BOUNDARY_OK " + JSON.stringify({
    vite: viteVersion, vitest: vitestVersion,
    browserProvider: entries.browserProviderVersion,
    viteDenied, vitestDenied, vitestHttpServers: 3,
  }) + "\n");
} finally {
  if (rootHttp?.listening) {
    rootHttp.closeAllConnections();
    await new Promise((resolve, reject) => rootHttp.close((error) => error ? reject(error) : resolve()));
  }
  if (vitest) await vitest.close();
  if (vite) await vite.close();
}
`;

it("keeps Vite and multi-project Vitest Browser Mode file denials on real HTTP servers", () => {
  // The provider is deliberately resolved from the workspace that declares it.
  // The server fixture adds no implicit dependency or package installation.
  const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
  const browserProviderPackage = webRequire.resolve("@vitest/browser-playwright/package.json");
  const browserProviderVersion: unknown = webRequire(browserProviderPackage).version;
  const imports = {
    vite: import.meta.resolve("vite"),
    vitest: import.meta.resolve("vitest/node"),
    vitestDirectory: fileURLToPath(new URL(".", import.meta.resolve("vitest/package.json"))),
    playwright: pathToFileURL(webRequire.resolve("@vitest/browser-playwright")).href,
    browserProviderVersion,
  };
  // Windows runner TEMP can contain an 8.3 alias such as RUNNER~1. Vite
  // deliberately refuses short-name paths even inside fs.allow. Resolve our
  // freshly owned directory through the OS before deriving any fixture roots,
  // so the allowed controls exercise canonical paths without weakening that
  // denial or changing the real servers' admission rules.
  const fixtureTemp = realpathSync.native(
    mkdtempSync(join(tmpdir(), "cafe-dev-tool-file-access-")),
  );
  const fixtureScript = join(fixtureTemp, "qualify.mjs");
  const fixtureEnvironment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: fixtureTemp,
    USERPROFILE: fixtureTemp,
    APPDATA: join(fixtureTemp, "appdata"),
    LOCALAPPDATA: join(fixtureTemp, "localappdata"),
    XDG_DATA_HOME: join(fixtureTemp, "xdg-data"),
    XDG_CONFIG_HOME: join(fixtureTemp, "xdg-config"),
    TMPDIR: fixtureTemp,
    TEMP: fixtureTemp,
    TMP: fixtureTemp,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "WINDIR", "COMSPEC"]) {
      const value = process.env[name];
      if (value !== undefined) fixtureEnvironment[name] = value;
    }
  }

  try {
    writeFileSync(fixtureScript, qualificationSource);
    const child = spawnSync(process.execPath, [fixtureScript, JSON.stringify(imports)], {
      cwd: fixtureTemp,
      env: fixtureEnvironment,
      shell: false,
      encoding: "utf8",
      timeout: 45_000,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
    });
    expect(child.error, child.stdout + child.stderr).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    const receiptLine = child.stdout
      .split("\n")
      .find((line) => line.startsWith("CAFE_DEV_TOOL_BOUNDARY_OK "));
    expect(receiptLine).toBeDefined();
    expect(JSON.parse(receiptLine!.slice("CAFE_DEV_TOOL_BOUNDARY_OK ".length))).toEqual({
      vite: "8.3.3",
      vitest: "5.0.5",
      browserProvider: "5.0.5",
      viteDenied: 12,
      vitestDenied: 45,
      vitestHttpServers: 3,
    });
  } finally {
    // The bounded exact child has exited (or was killed by spawnSync) before any
    // removal. This path was freshly minted here; no shared home/cache is used.
    rmSync(fixtureTemp, { recursive: true, force: true });
  }
});
