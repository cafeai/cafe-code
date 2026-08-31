// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as http from "node:http";

import type { ProviderDaemonClientConfig } from "@cafecode/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { requestProviderDaemonJson, streamProviderDaemonNdjson } from "./providerDaemonHttp.ts";

const servers: http.Server[] = [];

async function serve(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<{ readonly endpoint: ProviderDaemonClientConfig; readonly close: () => Promise<void> }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test HTTP server did not bind a TCP port");
  }
  return {
    endpoint: {
      httpBaseUrl: `http://127.0.0.1:${address.port}`,
      token: "provider-daemon-test-token-000000000000000000000000",
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("requestProviderDaemonJson", () => {
  it("uses a fresh socket for each short-lived JSON control request", async () => {
    const sockets: http.IncomingMessage["socket"][] = [];
    const fixture = await serve((request, response) => {
      sockets.push(request.socket);
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });

    await requestProviderDaemonJson(fixture.endpoint, "/rpc");
    await requestProviderDaemonJson(fixture.endpoint, "/rpc");

    expect(sockets).toHaveLength(2);
    expect(sockets[0]).not.toBe(sockets[1]);
  });

  it("rejects an oversized response before buffering it without bound", async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ value: "x".repeat(128) }));
    });

    await expect(
      requestProviderDaemonJson(fixture.endpoint, "/rpc", { maxResponseBytes: 64 }),
    ).rejects.toThrow("exceeds 64 bytes");
  });

  it("keeps split UTF-8 response bytes intact below the cap", async () => {
    const encoded = Buffer.from('{"text":"🙂"}', "utf8");
    const emojiStart = encoded.indexOf(Buffer.from("🙂", "utf8"));
    const fixture = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write(encoded.subarray(0, emojiStart + 2));
      response.end(encoded.subarray(emojiStart + 2));
    });

    const result = await requestProviderDaemonJson(fixture.endpoint, "/rpc", {
      maxResponseBytes: encoded.byteLength,
    });
    expect(result.body).toBe('{"text":"🙂"}');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5])(
    "rejects an invalid response cap before opening a connection: %s",
    async (maxResponseBytes) => {
      const fixture = await serve((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });

      await expect(
        requestProviderDaemonJson(fixture.endpoint, "/rpc", { maxResponseBytes }),
      ).rejects.toThrow("maxResponseBytes must be a positive finite safe integer");
    },
  );
});

describe("streamProviderDaemonNdjson", () => {
  it.each([
    { maxLineBytes: Number.NaN },
    { maxLineBytes: Number.POSITIVE_INFINITY },
    { maxPendingBytes: Number.NaN },
    { maxPendingBytes: Number.POSITIVE_INFINITY },
  ])("rejects invalid finite-buffer configuration: %j", async (invalidLimits) => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end('{"cursor":1}\n');
    });

    await expect(
      streamProviderDaemonNdjson(fixture.endpoint, "/events", {
        ...invalidLimits,
        onLine: () => {},
      }),
    ).rejects.toThrow("must be a positive finite safe integer");
  });

  it("serializes async record handling and preserves order", async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end('{"cursor":1}\n{"cursor":2}\n{"cursor":3}\n');
    });
    const seen: number[] = [];
    let activeHandlers = 0;
    let maxActiveHandlers = 0;

    await streamProviderDaemonNdjson(fixture.endpoint, "/events", {
      onLine: async (line) => {
        activeHandlers += 1;
        maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
        const cursor = Number.parseInt(line.match(/\d+/u)?.[0] ?? "0", 10);
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(cursor);
        activeHandlers -= 1;
      },
    });

    expect(seen).toEqual([1, 2, 3]);
    expect(maxActiveHandlers).toBe(1);
  });

  it("decodes UTF-8 safely when a character is split across chunks", async () => {
    const encoded = Buffer.from('{"text":"🙂"}\n', "utf8");
    const emojiStart = encoded.indexOf(Buffer.from("🙂", "utf8"));
    const fixture = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(encoded.subarray(0, emojiStart + 2));
      response.end(encoded.subarray(emojiStart + 2));
    });
    const seen: string[] = [];

    await streamProviderDaemonNdjson(fixture.endpoint, "/events", {
      onLine: (line) => {
        seen.push(line);
      },
    });

    expect(seen).toEqual(['{"text":"🙂"}']);
  });

  it("rejects a line before unbounded pending data can accumulate", async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${"x".repeat(65)}\n`);
    });

    await expect(
      streamProviderDaemonNdjson(fixture.endpoint, "/events", {
        maxLineBytes: 64,
        maxPendingBytes: 128,
        onLine: () => {},
      }),
    ).rejects.toThrow("exceeds 64 bytes");
  });

  it("yields to unrelated scheduler work during a complete-line burst", async () => {
    const fixture = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(
        Array.from({ length: 96 }, (_, index) => `{"cursor":${index + 1}}`).join("\n") + "\n",
      );
    });
    let schedulerProgress = false;
    let observedProgressBySecondBudget = false;
    setImmediate(() => {
      schedulerProgress = true;
    });

    await streamProviderDaemonNdjson(fixture.endpoint, "/events", {
      onLine: (line) => {
        if (line.includes('"cursor":33')) observedProgressBySecondBudget = schedulerProgress;
      },
    });

    expect(observedProgressBySecondBudget).toBe(true);
  });
});
