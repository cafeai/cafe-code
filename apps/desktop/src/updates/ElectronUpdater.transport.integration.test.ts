// Real updater metadata integration: no Electron app, provider, installer or
// external network is launched. Native IO below owns only this private fixture.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  Agent,
  createServer,
  request,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
// Exact native temporary-directory identity is needed before owned retirement.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync } from "node:fs";
// Native temp/path spelling must agree with the injected updater AppAdapter.
import { tmpdir } from "node:os";
// Native temp/path spelling must agree with the injected updater AppAdapter.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
// Native module resolution binds the executor to the updater's own dependency.
import { createRequire } from "node:module";
import * as Schema from "effect/Schema";
import type { AppAdapter } from "electron-updater/out/AppAdapter.js";
import { NsisUpdater } from "electron-updater/out/NsisUpdater.js";
import { expect, it, vi, type TestContext } from "vitest";

const basePath = "/cafeai/cafe-code/releases";
const nightlyVersion = "1.2.0-nightly.20261020.0";
const stableVersions = ["1.1.0", "1.0.0", "0.9.0"] as const;
type StableVersion = (typeof stableVersions)[number];
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
class UpdaterTransportFixtureError extends Error {
  constructor() {
    super("The owned updater transport fixture refused this operation.");
    this.name = "UpdaterTransportFixtureError";
  }
}
interface MetadataHttpExecutor {
  request(options: RequestOptions): Promise<string | null>;
}
type MetadataHttpExecutorConstructor = new () => MetadataHttpExecutor;

function loadUpdaterHttpExecutor(): MetadataHttpExecutorConstructor {
  // Resolve from electron-updater's own declared closure, not a transitive
  // packaging dependency that the desktop workspace does not declare.
  const fixtureRequire = createRequire(import.meta.url);
  const updaterRequire = createRequire(fixtureRequire.resolve("electron-updater/package.json"));
  const received: unknown = updaterRequire("builder-util-runtime/out/httpExecutor");
  if (received === null || typeof received !== "object" || Array.isArray(received)) {
    throw new UpdaterTransportFixtureError();
  }
  const exported = Object.getOwnPropertyDescriptor(received, "HttpExecutor");
  const candidate: unknown =
    exported !== undefined && Object.hasOwn(exported, "value") ? exported.value : undefined;
  if (typeof candidate !== "function") throw new UpdaterTransportFixtureError();
  const descriptor = Object.getOwnPropertyDescriptor(candidate, "prototype");
  const prototype: unknown =
    descriptor !== undefined && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  if (prototype === null || typeof prototype !== "object" || Array.isArray(prototype)) {
    throw new UpdaterTransportFixtureError();
  }
  // Admit only the finite real API this metadata fixture relies on. Descriptor
  // reads cannot invoke a substituted accessor, and no version is hard-coded.
  for (const method of ["request", "doApiRequest", "addErrorAndTimeoutHandlers"]) {
    const own = Object.getOwnPropertyDescriptor(prototype, method);
    const value: unknown = own !== undefined && Object.hasOwn(own, "value") ? own.value : undefined;
    if (typeof value !== "function") throw new UpdaterTransportFixtureError();
  }
  return candidate as MetadataHttpExecutorConstructor;
}
const RealHttpExecutor = loadUpdaterHttpExecutor();

interface TransportFixture {
  readonly feed: { stable: StableVersion; includeNightly: boolean; missingManifest: boolean };
  readonly requested: readonly string[];
  readonly served: readonly string[];
  readonly events: readonly string[];
  readonly errors: readonly Error[];
  readonly manifestPath: (version: string, channel: "latest" | "nightly") => string;
  readonly selectChannel: (channel: "latest" | "nightly") => void;
  readonly check: () => ReturnType<NsisUpdater["checkForUpdates"]>;
}

async function withTransport(
  context: TestContext,
  task: (fixture: TransportFixture) => Promise<void>,
): Promise<void> {
  const runtimeArch = process.env.TEST_UPDATER_ARCH ?? process.arch;
  if (!/^[a-z0-9-]{1,16}$/.test(runtimeArch)) throw new UpdaterTransportFixtureError();
  const root = mkdtempSync(join(tmpdir(), "cafe-updater-transport-"));
  const identity = lstatSync(root, { bigint: true });
  if (
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (identity.uid !== BigInt(process.getuid!()) || (identity.mode & 0o077n) !== 0n))
  )
    throw new UpdaterTransportFixtureError();
  let retired = false;
  let disposed: Promise<void> | undefined;
  let retiring: Promise<void> | undefined;
  let work: Promise<void> | undefined;
  let listening: Promise<void> | undefined;
  let updater: NsisUpdater | undefined;
  const agent = new Agent({ keepAlive: false, maxSockets: 2 });
  const clients = new Set<ClientRequest>();
  const closes = new Set<Promise<void>>();
  const requested: string[] = [];
  const served: string[] = [];
  const events: string[] = [];
  const errors: Error[] = [];
  let artifactAttempts = 0;
  const feed: TransportFixture["feed"] = {
    stable: "1.1.0",
    includeNightly: false,
    missingManifest: false,
  };
  const suffix =
    process.platform === "darwin"
      ? "-mac"
      : process.platform === "linux"
        ? "-linux" + (runtimeArch === "x64" ? "" : "-" + runtimeArch)
        : "";
  const manifestPath = (version: string, channel: "latest" | "nightly") =>
    basePath + "/download/v" + version + "/" + channel + suffix + ".yml";
  const manifests = new Map<string, string>();
  for (const version of [...stableVersions, nightlyVersion]) {
    for (const channel of ["latest", "nightly"] as const)
      manifests.set(manifestPath(version, channel), version);
  }
  const allowed = new Set([basePath + ".atom", basePath + "/latest", ...manifests.keys()]);
  const guards: Array<{
    mockRestore: () => void;
    readonly mock: { readonly calls: readonly unknown[] };
  }> = [];
  const nativeCalls = {
    quit: vi.fn(() => {
      throw new UpdaterTransportFixtureError();
    }),
    relaunch: vi.fn(() => {
      throw new UpdaterTransportFixtureError();
    }),
    onQuit: vi.fn((_handler: (code: number) => void) => {
      throw new UpdaterTransportFixtureError();
    }),
  };
  const server = createServer((incoming, response) => {
    const path = incoming.url ?? "";
    served.push(path);
    if (retired || incoming.method !== "GET" || !allowed.has(path) || served.length > 12) {
      response.writeHead(400).end();
      return;
    }
    let content: string;
    if (path === basePath + ".atom") {
      const versions = feed.includeNightly ? [nightlyVersion, feed.stable] : [feed.stable];
      content =
        '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">' +
        versions
          .map(
            (version) =>
              "<entry><title>v" +
              version +
              '</title><link href="https://github.com/cafeai/cafe-code/releases/tag/v' +
              version +
              '"/><content>No content.</content></entry>',
          )
          .join("") +
        "</feed>";
    } else if (path === basePath + "/latest") {
      content = encodeJson({ tag_name: "v" + feed.stable });
    } else {
      if (feed.missingManifest) {
        response.writeHead(404).end();
        return;
      }
      const version = manifests.get(path)!;
      // Metadata only. No artifact endpoint is served or checksum-byte claim made.
      content =
        "version: " +
        version +
        "\nfiles:\n  - url: Cafe-Code-" +
        version +
        ".exe\n    sha512: " +
        Buffer.alloc(64).toString("base64") +
        "\n    size: 1\n";
    }
    if (Buffer.byteLength(content) > 16 * 1024) throw new UpdaterTransportFixtureError();
    response.writeHead(200, { "content-length": Buffer.byteLength(content) }).end(content);
  });
  const retire = (): Promise<void> =>
    (retiring ??= (async () => {
      retired = true;
      // Wait for this exact owned bind attempt before closing it; a hard test
      // timeout cannot leave a subsequently listening server behind.
      await listening?.catch(() => undefined);
      for (const client of clients) client.destroy(new UpdaterTransportFixtureError());
      server.closeAllConnections();
      agent.destroy();
      await Promise.all([...closes]);
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    })());
  const dispose = (): Promise<void> =>
    (disposed ??= (async () => {
      await retire();
      updater?.removeAllListeners();
      for (const guard of guards) guard.mockRestore();
      const current = lstatSync(root, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      ) {
        throw new UpdaterTransportFixtureError();
      }
      const quarantine = mkdtempSync(join(tmpdir(), "cafe-updater-transport-retired-"));
      const owner = lstatSync(quarantine, { bigint: true });
      const moved = join(quarantine, "fixture");
      renameSync(root, moved);
      const transferred = lstatSync(moved, { bigint: true });
      const ownerNow = lstatSync(quarantine, { bigint: true });
      if (
        !transferred.isDirectory() ||
        transferred.isSymbolicLink() ||
        transferred.dev !== identity.dev ||
        transferred.ino !== identity.ino ||
        !ownerNow.isDirectory() ||
        ownerNow.isSymbolicLink() ||
        ownerNow.dev !== owner.dev ||
        ownerNow.ino !== owner.ino
      )
        throw new UpdaterTransportFixtureError();
      // Remove only the atomically transferred exact directory. A namespace
      // mismatch preserves evidence instead of deleting a replacement entry.
      rmSync(moved, { recursive: true });
      rmdirSync(quarantine);
    })());
  // Capture the actual case's owner before any await. Timeout retirement joins
  // its callback after aborting native requests, rather than relying on finally.
  context.onTestFinished(async () => {
    await retire();
    await work?.catch(() => undefined);
    await dispose();
  });

  try {
    const home = join(root, "home");
    const cache = join(root, "cache");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(cache, { mode: 0o700 });
    listening = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await listening;
    if (retired) throw new UpdaterTransportFixtureError();
    const address = server.address();
    if (address === null || typeof address === "string") throw new UpdaterTransportFixtureError();
    const port = address.port;

    class OwnedLoopbackExecutor extends RealHttpExecutor {
      createRequest(
        options: RequestOptions,
        callback: (response: IncomingMessage) => void,
      ): ClientRequest {
        const path = options.path ?? "";
        if (/\.exe(?:$|\?)/i.test(path)) artifactAttempts++;
        const headers = options.headers;
        if (
          retired ||
          options.protocol !== "https:" ||
          options.hostname !== "github.com" ||
          (options.port != null && String(options.port) !== "443") ||
          options.auth != null ||
          (options.method != null && options.method !== "GET") ||
          !allowed.has(path) ||
          Array.isArray(headers) ||
          Object.keys(headers ?? {}).some((name) =>
            /^(?:authorization|proxy-authorization|cookie)$/i.test(name),
          ) ||
          requested.length >= 12
        )
          throw new UpdaterTransportFixtureError();
        requested.push(path);
        // Supply only the native transport-origin factory required by the real
        // base executor. Its inherited request/error handling, GitHubProvider,
        // XML/YAML parsers and semver/event engine stay active. An explicit own
        // Agent and literal loopback route never consult a user proxy setting.
        const client = request(
          {
            protocol: "http:",
            hostname: "127.0.0.1",
            port,
            path,
            method: "GET",
            headers,
            agent,
          },
          callback,
        );
        clients.add(client);
        let closed!: Promise<void>;
        closed = new Promise<void>((resolve) => {
          client.once("close", () => {
            clients.delete(client);
            closes.delete(closed);
            resolve();
          });
        });
        closes.add(closed);
        // Exact native socket deadline, independent of Effect/test clocks and
        // the upstream executor's longer default request timeout.
        // @effect-diagnostics-next-line globalTimers:off
        const deadline = setTimeout(
          () => client.destroy(new UpdaterTransportFixtureError()),
          3_000,
        );
        client.once("close", () => clearTimeout(deadline));
        return client;
      }
    }

    const app: AppAdapter = {
      version: "1.0.0",
      name: "Cafe updater transport fixture",
      isPackaged: true,
      userDataPath: home,
      baseCachePath: cache,
      appUpdateConfigPath: join(root, "unused-app-update.yml"),
      whenReady: () => Promise.resolve(),
      ...nativeCalls,
    };
    // NsisUpdater has a public adapter constructor and does not load Electron
    // for metadata checks. No Windows installation/signature claim is made.
    updater = new NsisUpdater(undefined, app);
    updater.logger = null;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    const descriptor = Object.getOwnPropertyDescriptor(updater, "httpExecutor");
    expect(descriptor).toMatchObject({ value: null, writable: true });
    // Upstream deliberately omits this owned test seam from its .d.ts surface.
    // Replace only the existing plain own-data slot, not a production API.
    Object.defineProperty(updater, "httpExecutor", {
      ...descriptor,
      value: new OwnedLoopbackExecutor(),
    });
    guards.push(
      vi.spyOn(updater, "downloadUpdate").mockImplementation(() => {
        throw new UpdaterTransportFixtureError();
      }),
    );
    guards.push(
      vi.spyOn(updater, "quitAndInstall").mockImplementation(() => {
        throw new UpdaterTransportFixtureError();
      }),
    );
    updater.on("checking-for-update", () => events.push("checking"));
    updater.on("update-available", (info) => events.push("available:" + info.version));
    updater.on("update-not-available", (info) => events.push("unavailable:" + info.version));
    updater.on("error", (error) => {
      errors.push(error);
      events.push("error");
    });
    // The executor must exist before setFeedURL constructs the actual provider.
    updater.setFeedURL({ provider: "github", owner: "cafeai", repo: "cafe-code" });
    const ownedUpdater = updater;
    const selectChannel = (channel: "latest" | "nightly") => {
      if (retired) throw new UpdaterTransportFixtureError();
      ownedUpdater.channel = channel;
      ownedUpdater.allowPrerelease = channel === "nightly";
      // The real channel setter enables downgrades; production restores this.
      ownedUpdater.allowDowngrade = false;
    };
    selectChannel("latest");
    work = task({
      feed,
      requested,
      served,
      events,
      errors,
      manifestPath,
      selectChannel,
      check: async () => {
        if (retired) throw new UpdaterTransportFixtureError();
        const result = await ownedUpdater.checkForUpdates();
        if (retired) throw new UpdaterTransportFixtureError();
        return result;
      },
    });
    await work;
    expect(requested).toEqual(served);
    expect(artifactAttempts).toBe(0);
    for (const guard of guards) expect(guard).not.toHaveBeenCalled();
    for (const guard of Object.values(nativeCalls)) expect(guard).not.toHaveBeenCalled();
  } finally {
    await dispose();
  }
}

it("detects a newer release through actual GitHub feed parsing without downloading", async (context) => {
  await withTransport(context, async ({ check, requested, events, errors, manifestPath }) => {
    const result = await check();
    expect(result).toMatchObject({
      isUpdateAvailable: true,
      updateInfo: { version: "1.1.0", tag: "v1.1.0" },
      downloadPromise: null,
    });
    expect(requested).toEqual([
      basePath + ".atom",
      basePath + "/latest",
      manifestPath("1.1.0", "latest"),
    ]);
    expect(events).toEqual(["checking", "available:1.1.0"]);
    expect(errors).toEqual([]);
  });
});

it("does not advertise same-version or older releases when downgrade is disallowed", async (context) => {
  await withTransport(context, async ({ feed, check, requested, events, errors, manifestPath }) => {
    feed.stable = "1.0.0";
    expect(await check()).toMatchObject({
      isUpdateAvailable: false,
      updateInfo: { version: "1.0.0" },
    });
    feed.stable = "0.9.0";
    expect(await check()).toMatchObject({
      isUpdateAvailable: false,
      updateInfo: { version: "0.9.0" },
    });
    expect(requested).toEqual([
      basePath + ".atom",
      basePath + "/latest",
      manifestPath("1.0.0", "latest"),
      basePath + ".atom",
      basePath + "/latest",
      manifestPath("0.9.0", "latest"),
    ]);
    expect(events).toEqual(["checking", "unavailable:1.0.0", "checking", "unavailable:0.9.0"]);
    expect(errors).toEqual([]);
  });
});

it("selects nightly versus stable paths from a mixed real release feed", async (context) => {
  await withTransport(
    context,
    async ({ feed, selectChannel, check, requested, events, errors, manifestPath }) => {
      feed.includeNightly = true;
      selectChannel("nightly");
      expect(await check()).toMatchObject({
        isUpdateAvailable: true,
        updateInfo: { version: nightlyVersion, tag: "v" + nightlyVersion },
        downloadPromise: null,
      });
      selectChannel("latest");
      expect(await check()).toMatchObject({
        isUpdateAvailable: true,
        updateInfo: { version: "1.1.0", tag: "v1.1.0" },
        downloadPromise: null,
      });
      expect(requested).toEqual([
        basePath + ".atom",
        manifestPath(nightlyVersion, "nightly"),
        basePath + ".atom",
        basePath + "/latest",
        manifestPath("1.1.0", "latest"),
      ]);
      expect(events).toEqual([
        "checking",
        "available:" + nightlyVersion,
        "checking",
        "available:1.1.0",
      ]);
      expect(errors).toEqual([]);
    },
  );
});

it("reports a real missing-manifest error and performs a fresh successful check after repair", async (context) => {
  await withTransport(context, async ({ feed, check, requested, events, errors, manifestPath }) => {
    feed.missingManifest = true;
    await expect(check()).rejects.toMatchObject({ code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" });
    expect(events).toEqual(["checking", "error"]);
    expect(errors).toHaveLength(1);
    feed.missingManifest = false;
    expect(await check()).toMatchObject({
      isUpdateAvailable: true,
      updateInfo: { version: "1.1.0" },
      downloadPromise: null,
    });
    expect(requested).toEqual([
      basePath + ".atom",
      basePath + "/latest",
      manifestPath("1.1.0", "latest"),
      basePath + ".atom",
      basePath + "/latest",
      manifestPath("1.1.0", "latest"),
    ]);
    expect(events).toEqual(["checking", "error", "checking", "available:1.1.0"]);
    expect(errors).toHaveLength(1);
  });
});
