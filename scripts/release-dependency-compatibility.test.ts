// @effect-diagnostics nodeBuiltinImport:off
import { createRequire } from "node:module";
import type * as Http from "node:http";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

describe("release build dependency compatibility", () => {
  it("preserves the actual Electron downloader's proxy bootstrap and NO_PROXY after the agent upgrade", async () => {
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
    const proxyRequests: { url: string | undefined; host: string | undefined }[] = [];
    let originRequests = 0;
    const proxy = http.createServer((request, response) => {
      proxyRequests.push({ url: request.url, host: request.headers.host });
      response.setHeader("Connection", "close");
      response.end("fixture proxy");
    });
    const origin = http.createServer((_request, response) => {
      originRequests++;
      response.setHeader("Connection", "close");
      response.end("fixture origin");
    });
    const listen = (server: Http.Server) =>
      new Promise<URL>((accept, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          const address = server.address();
          if (!address || typeof address === "string")
            return reject(new Error("Missing fixture port."));
          accept(new URL(`http://127.0.0.1:${address.port}/artifact.zip`));
        });
      });
    const read = (url: URL) =>
      new Promise<string>((accept, reject) => {
        const request = http.get(url, { signal: AbortSignal.timeout(2_000) }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 64) request.destroy(new Error("Unexpected fixture response."));
          });
          response.once("error", reject);
          response.once("end", () => accept(body));
        });
        request.once("error", reject);
      });
    try {
      expect(originalController).toBeUndefined();
      const [proxyUrl, originUrl] = await Promise.all([listen(proxy), listen(origin)]);
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
      expect(await read(originUrl)).toBe("fixture proxy");
      expect(proxyRequests).toEqual([{ url: originUrl.href, host: originUrl.host }]);
      expect(originRequests).toBe(0);
      const controller = Reflect.get(globalThis, "GLOBAL_AGENT") as { NO_PROXY: string };
      controller.NO_PROXY = "127.0.0.1";
      expect(await read(originUrl)).toBe("fixture origin");
      expect(originRequests).toBe(1);
      expect(proxyRequests).toHaveLength(1);
    } finally {
      Object.assign(http, originalHttp);
      Object.assign(https, originalHttps);
      if (originalController) Object.defineProperty(globalThis, "GLOBAL_AGENT", originalController);
      else Reflect.deleteProperty(globalThis, "GLOBAL_AGENT");
      vi.unstubAllEnvs();
      await Promise.all(
        [proxy, origin].map(async (server) => {
          server.closeAllConnections();
          if (server.listening)
            await new Promise<void>((accept, reject) =>
              server.close((error) => (error ? reject(error) : accept())),
            );
        }),
      );
    }
  });
});
