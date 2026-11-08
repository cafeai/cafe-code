// The dependency under test owns native HTTP and filesystem operations. This
// fixture uses only loopback sockets and a filesystem-minted private cache.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
// The loopback server must own exact native response/socket close and body
// cancellation events from the real downloader, rather than a client mock.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as http from "node:http";
import type * as net from "node:net";
// Native reads verify the downloader's actual private cache and join its IO.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// The exact native cache/temp paths must reach the real dependency unchanged.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, type TestContext } from "vitest";

// Resolve the exact downloader used by Electron's install.js. Requiring the
// Electron entry point would itself install a runtime; package resolution does
// not load that entry point or select an unrelated hoisted @electron/get copy.
const runtimeRequire = createRequire(
  new URL("../packaging/desktop-runtime/package.json", import.meta.url),
);
const electronRequire = createRequire(runtimeRequire.resolve("electron/package.json"));
const getEntry = electronRequire.resolve("@electron/get");
const getRequire = createRequire(getEntry);
const sumchecker = getRequire("sumchecker") as {
  readonly ChecksumMismatchError: new (...args: never[]) => Error;
};
const artifactName = "electron-v43.8.4-win32-x64.zip";
const payload = Buffer.from("inert checksum-bound Electron download fixture\n");
const payloadSha = createHash("sha256").update(payload).digest("hex");

interface ArtifactOptions {
  readonly version: string;
  readonly artifactName: string;
  readonly platform: string;
  readonly arch: string;
  readonly cacheRoot: string;
  readonly tempDirectory: string;
  readonly checksums: Record<string, string>;
  readonly mirrorOptions: { readonly resolveAssetURL: () => Promise<string> };
  readonly downloadOptions: {
    readonly quiet: boolean;
    readonly signal: AbortSignal;
    readonly method?: string;
  };
}
interface ElectronGet {
  readonly downloadArtifact: (options: ArtifactOptions) => Promise<string>;
}
interface FixtureResponse {
  readonly status: number;
  readonly body?: Uint8Array;
  readonly holdBody?: boolean;
}
interface FixtureOwner {
  readonly cleanup: () => Promise<void>;
}
const owners = new Set<FixtureOwner>();

// onTestFinished runs after afterEach. Join the exact current owner here as
// well, so a timed-out native continuation cannot enter the following case.
afterEach(async () => {
  for (const owner of [...owners]) await owner.cleanup();
});

async function downloadFixture(
  context: TestContext,
  responseFor: (requestNumber: number) => FixtureResponse,
  abortAfterBodyCancellation = false,
) {
  let retired = false,
    root: string | undefined,
    cleanupPromise: Promise<void> | undefined;
  const abort = new AbortController();
  const acquisitions = new Set<Promise<unknown>>(),
    reads = new Set<Promise<unknown>>();
  const sockets = new Set<net.Socket>(),
    nativeCloses = new Set<Promise<void>>();
  const requests: Array<{ readonly method: string | undefined }> = [];
  let cancelledResponses = 0;
  const assertActive = () => {
    if (retired || context.signal.aborted) throw new Error("Electron download fixture retired.");
  };
  const own = <A>(pending: Set<Promise<unknown>>, start: () => Promise<A>) => {
    assertActive();
    const operation = start();
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  };
  const closeReceipt = (emitter: net.Socket | http.ServerResponse) => {
    const closed = new Promise<void>((resolve) => emitter.once("close", resolve));
    nativeCloses.add(closed);
    void closed.then(() => nativeCloses.delete(closed));
  };
  const server = http.createServer((request, response) => {
    // Failed transports remain object-owned even when cancellation races a
    // response. Nothing here installs a global exception or fetch handler.
    request.on("error", () => request.destroy());
    response.on("error", () => response.destroy());
    closeReceipt(response);
    if (retired) {
      response.destroy();
      return;
    }
    requests.push({ method: request.method });
    const selected = responseFor(requests.length);
    response.once("close", () => {
      if (!response.writableFinished) {
        cancelledResponses += 1;
        // This real unfinished response can close only after the downloader
        // retires its body. Abort synchronously at that native boundary, before
        // any extra request is admitted; no sleep or timer inspection is used.
        if (abortAfterBodyCancellation && !retired) abort.abort();
      }
    });
    response.writeHead(selected.status, {
      "content-type": "application/octet-stream",
      connection: "close",
    });
    if (selected.holdBody) {
      response.flushHeaders();
      response.write("held gateway response");
    } else response.end(selected.body ?? payload);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    closeReceipt(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    if (retired) socket.destroy();
  });
  const retire = () => {
    retired = true;
    abort.abort();
    for (const socket of sockets) socket.destroy();
  };
  // Only these synthetic selectors are neutralized. URL resolution below is
  // always literal loopback; proxy bootstrap must not mutate the global fetch
  // dispatcher, and an ambient custom version must not disable checksum checks.
  const environmentKeys = [
    "ELECTRON_GET_USE_PROXY",
    "ELECTRON_CUSTOM_VERSION",
    "npm_config_electron_customversion",
    "npm_config_electron_custom_version",
    "NPM_CONFIG_ELECTRON_CUSTOM_VERSION",
    "npm_package_config_electron_customVersion",
    "npm_package_config_electron_custom_version",
  ];
  const environment = environmentKeys.map((key) => ({ key, value: process.env[key] }));
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    retire();
    cleanupPromise = (async () => {
      try {
        // A late successful bind still belongs to this owner. Start server
        // closure before joining downloads that may be awaiting that closure.
        while (acquisitions.size) await Promise.allSettled([...acquisitions]);
        const closed = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error && (!("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING"))
              reject(error);
            else resolve();
          });
          server.closeAllConnections();
        });
        while (reads.size || nativeCloses.size)
          await Promise.allSettled([...reads, ...nativeCloses]);
        await closed;
        if (root !== undefined) await rm(root, { recursive: true, force: true });
      } finally {
        for (const { key, value } of environment) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        context.signal.removeEventListener("abort", retire);
        owners.delete(owner);
      }
    })();
    return cleanupPromise;
  };
  const owner = { cleanup };
  owners.add(owner);
  // Install one owner before the FIRST async import, filesystem or listen
  // acquisition. The public timeout signal fences admission synchronously.
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(cleanup);
  if (context.signal.aborted) retire();
  for (const key of environmentKeys) delete process.env[key];
  const get = await own(
    acquisitions,
    () => import(pathToFileURL(getEntry).href) as Promise<ElectronGet>,
  );
  assertActive();
  const directory = await own(acquisitions, async () => {
    const created = await mkdtemp(join(tmpdir(), "cafecode-electron-download-"));
    root = created;
    return created;
  });
  const cacheRoot = join(directory, "cache"),
    tempDirectory = join(directory, "temp");
  await own(acquisitions, () => mkdir(cacheRoot));
  await own(acquisitions, () => mkdir(tempDirectory));
  const url = await own(
    acquisitions,
    () =>
      new Promise<string>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Missing native fixture address."));
            return;
          }
          resolve(`http://127.0.0.1:${address.port}/${artifactName}`);
        });
      }),
  );
  assertActive();
  return {
    requests,
    cancelledResponses: () => cancelledResponses,
    download: (method?: string) =>
      own(reads, () =>
        get.downloadArtifact({
          version: "43.8.4",
          artifactName: "electron",
          platform: "win32",
          arch: "x64",
          cacheRoot,
          tempDirectory,
          checksums: { [artifactName]: payloadSha },
          mirrorOptions: {
            resolveAssetURL: async () => {
              assertActive();
              return url;
            },
          },
          downloadOptions: {
            quiet: true,
            signal: abort.signal,
            ...(method === undefined ? {} : { method }),
          },
        }),
      ),
    read: (filename: string) => own(reads, () => readFile(filename)),
  };
}

describe("Electron-owned downloader transient HTTP recovery", () => {
  it.for([502, 503, 504])(
    "recovers HTTP %i twice, verifies exact bytes and reuses only validated cache",
    async (status, context) => {
      const fixture = await downloadFixture(context, (number) => ({
        status: number < 3 ? status : 200,
      }));
      const artifact = await fixture.download();
      expect(await fixture.read(artifact)).toEqual(payload);
      expect(fixture.requests).toEqual([{ method: "GET" }, { method: "GET" }, { method: "GET" }]);
      expect(await fixture.download()).toBe(artifact);
      expect(await fixture.read(artifact)).toEqual(payload);
      expect(fixture.requests).toHaveLength(3);
    },
  );

  it("exhausts exactly three transient responses without accepting an artifact", async (context) => {
    const fixture = await downloadFixture(context, () => ({ status: 504 }));
    await expect(fixture.download()).rejects.toMatchObject({
      name: "HTTPError",
      response: { status: 504 },
    });
    expect(fixture.requests).toHaveLength(3);
  });

  it.for([
    { status: 404, method: undefined },
    { status: 504, method: "POST" },
  ])(
    "does not retry a fatal status or non-idempotent request: %j",
    async ({ status, method }, context) => {
      const fixture = await downloadFixture(context, () => ({ status }));
      await expect(fixture.download(method)).rejects.toMatchObject({
        name: "HTTPError",
        response: { status },
      });
      expect(fixture.requests).toEqual([{ method: method ?? "GET" }]);
    },
  );

  it("refuses a corrupted successful response at the unchanged checksum boundary without retry", async (context) => {
    const fixture = await downloadFixture(context, () => ({
      status: 200,
      body: Buffer.from("corrupted fixture"),
    }));
    await expect(fixture.download()).rejects.toBeInstanceOf(sumchecker.ChecksumMismatchError);
    expect(fixture.requests).toEqual([{ method: "GET" }]);
  });

  it("joins real response-body cancellation and aborts backoff without another request", async (context) => {
    const fixture = await downloadFixture(context, () => ({ status: 504, holdBody: true }), true);
    await expect(fixture.download()).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.cancelledResponses()).toBe(1);
    expect(fixture.requests).toEqual([{ method: "GET" }]);
  });
});
