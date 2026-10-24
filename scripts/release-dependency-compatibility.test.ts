// @effect-diagnostics nodeBuiltinImport:off
import { createRequire } from "node:module";
import type * as Http from "node:http";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

describe("release build dependency compatibility", () => {
  it("preserves the actual Electron downloader's proxy bootstrap and NO_PROXY after the agent upgrade", async (context) => {
    // The bootstrap deliberately patches Node's HTTP modules. This file uses
    // the existing isolated Vitest worker and restores those exact module
    // functions/agents before retiring its two loopback-only fixture servers.
    const http = require("node:http") as typeof import("node:http");
    const https = require("node:https") as typeof import("node:https");
    const originalHttp = { get: http.get, request: http.request, globalAgent: http.globalAgent };
    const originalHttps = {
      get: https.get,
      request: https.request,
      globalAgent: https.globalAgent,
    };
    const originalController = Object.getOwnPropertyDescriptor(globalThis, "GLOBAL_AGENT");
    let retired = false;
    let cleanupPromise: Promise<void> | undefined;
    const fixtureAbort = new AbortController();
    const listening = new Set<Promise<unknown>>();
    const reading = new Set<Promise<unknown>>();
    const requestCloses = new Set<Promise<void>>();
    const requests = new Set<Http.ClientRequest>();
    const sockets = new Set<import("node:net").Socket>();
    const assertActive = () => {
      if (retired || context.signal.aborted) throw new Error("Synthetic proxy fixture retired.");
    };
    const own = <A>(pending: Set<Promise<unknown>>, start: () => Promise<A>): Promise<A> => {
      assertActive();
      const promise = start();
      pending.add(promise);
      // Track the original result without returning a replacement or an
      // unhandled finally promise. Cleanup never joins its own body/finalizer.
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    };
    const proxyRequests: { url: string | undefined; host: string | undefined }[] = [];
    let originRequests = 0;
    const proxy = http.createServer((request, response) => {
      if (retired) {
        response.destroy();
        return;
      }
      proxyRequests.push({ url: request.url, host: request.headers.host });
      response.setHeader("Connection", "close");
      response.end("fixture proxy");
    });
    const origin = http.createServer((_request, response) => {
      if (retired) {
        response.destroy();
        return;
      }
      originRequests++;
      response.setHeader("Connection", "close");
      response.end("fixture origin");
    });
    const servers = [proxy, origin];
    for (const server of servers) {
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        // A previously admitted connection may arrive during retirement. It
        // gains no response/count authority and remains this server's owner.
        if (retired) socket.destroy();
      });
    }
    const retire = () => {
      retired = true; // Fence all future listen/read and post-await mutations.
      fixtureAbort.abort();
      for (const request of requests) request.destroy();
      for (const socket of sockets) socket.destroy();
    };
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      retire();
      cleanupPromise = (async () => {
        try {
          // These are only the two original loopback listen acquisitions, not
          // HTTP responses or the test body. Join them before closing so a
          // late successful bind cannot escape an earlier not-listening check.
          await Promise.allSettled([...listening]);
          const closing = servers.map(async (server) => {
            server.closeAllConnections();
            if (server.listening)
              await new Promise<void>((accept, reject) =>
                server.close((error) => (error ? reject(error) : accept())),
              );
          });
          // Initiate server shutdown before joining reads: a response awaiting
          // server closure must not form a cleanup/response dependency cycle.
          const closed = Promise.allSettled(closing);
          while (reading.size || requestCloses.size)
            await Promise.allSettled([...reading, ...requestCloses]);
          for (const result of await closed) if (result.status === "rejected") throw result.reason;
        } finally {
          // Restore shared native modules/environment only after every
          // admitted operation has drained, before the next fixture may run.
          Object.assign(http, originalHttp);
          Object.assign(https, originalHttps);
          if (originalController)
            Object.defineProperty(globalThis, "GLOBAL_AGENT", originalController);
          else Reflect.deleteProperty(globalThis, "GLOBAL_AGENT");
          vi.unstubAllEnvs();
          context.signal.removeEventListener("abort", retire);
        }
      })();
      return cleanupPromise;
    };
    // Hard timeout does not await an ordinary async body's finally. Register
    // this exact owner before the first listen await and share its close join.
    context.signal.addEventListener("abort", retire, { once: true });
    context.onTestFinished(cleanup);
    if (context.signal.aborted) retire();
    const listen = (server: Http.Server) =>
      own(
        listening,
        () =>
          new Promise<URL>((accept, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              server.removeListener("error", reject);
              const address = server.address();
              if (!address || typeof address === "string")
                return reject(new Error("Missing fixture port."));
              accept(new URL(`http://127.0.0.1:${address.port}/artifact.zip`));
            });
          }),
      );
    const read = (url: URL) =>
      own(
        reading,
        () =>
          new Promise<string>((accept, reject) => {
            const request = http.get(
              url,
              { signal: AbortSignal.any([AbortSignal.timeout(2_000), fixtureAbort.signal]) },
              (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                  body += chunk;
                  if (body.length > 64) request.destroy(new Error("Unexpected fixture response."));
                });
                response.once("error", reject);
                response.once("end", () => accept(body));
              },
            );
            requests.add(request);
            const closed = new Promise<void>((acceptClose) => {
              request.once("close", () => {
                requests.delete(request);
                acceptClose();
              });
            });
            requestCloses.add(closed);
            void closed.then(() => requestCloses.delete(closed));
            request.once("error", reject);
          }),
      );
    let failed = false;
    try {
      assertActive();
      expect(originalController).toBeUndefined();
      const [proxyUrl, originUrl] = await Promise.all([listen(proxy), listen(origin)]);
      assertActive();
      // Never let invoking-shell proxy values choose a fixture destination.
      for (const key of Object.keys(process.env)) {
        if (/^(GLOBAL_AGENT_|ELECTRON_GET_USE_PROXY$)/i.test(key)) vi.stubEnv(key, undefined);
      }
      vi.stubEnv("GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE", "GLOBAL_AGENT_");
      vi.stubEnv("GLOBAL_AGENT_HTTP_PROXY", proxyUrl.origin);
      vi.stubEnv("GLOBAL_AGENT_HTTPS_PROXY", proxyUrl.origin);
      vi.stubEnv("GLOBAL_AGENT_NO_PROXY", "");
      vi.stubEnv("ELECTRON_GET_USE_PROXY", "");
      // Resolve from the real builder consumer, including its nested dependency
      // placement. A separately imported replacement would not qualify it.
      const builderRequire = createRequire(require.resolve("app-builder-lib"));
      const downloader = builderRequire("@electron/get") as { initializeProxy(): void };
      downloader.initializeProxy();
      const ownedHttpAgent = http.globalAgent;
      const ownedHttpsAgent = https.globalAgent;
      expect(ownedHttpAgent).not.toBe(originalHttp.globalAgent);
      expect(ownedHttpsAgent).not.toBe(originalHttps.globalAgent);
      const proxyBody = await read(originUrl);
      assertActive();
      expect(proxyBody).toBe("fixture proxy");
      expect(proxyRequests).toEqual([{ url: originUrl.href, host: originUrl.host }]);
      expect(originRequests).toBe(0);
      const controller = Reflect.get(globalThis, "GLOBAL_AGENT") as { NO_PROXY: string };
      controller.NO_PROXY = "127.0.0.1";
      const originBody = await read(originUrl);
      assertActive();
      expect(originBody).toBe("fixture origin");
      expect(originRequests).toBe(1);
      expect(proxyRequests).toHaveLength(1);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Do not replace an original native/assertion failure with a secondary
      // teardown error. The same registered completion owner still reports a
      // rejected cleanup, and both paths join the exact same shutdown promise.
      if (failed) await Promise.allSettled([cleanup()]);
      else await cleanup();
    }
  });
});
