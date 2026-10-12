import * as http from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import {
  VisualizationGenerationId,
  VISUALIZATION_MAX_INPUT_JSON_BYTES,
} from "@cafecode/contracts/visualizations";
import { HttpServerRequest } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { VisualizationArtifacts } from "./service.ts";
import {
  installVisualizationSessionRuntime,
  type VisualizationSessionAuthority,
} from "./sessionRuntime.ts";
import type { VisualizationArtifactService } from "./store.ts";
import {
  boundVisualizationMcpResponse,
  visualizationMcpRequestCount,
  VISUALIZATION_MCP_MAX_RESPONSE_BYTES,
  VISUALIZATION_MCP_RESPONSE_MS,
} from "./mcpResponse.ts";
import {
  handleVisualizationMcpRequest,
  handleVisualizationDebugRequest,
  readVisualizationMcpBody,
} from "./http.ts";

function request(peer: string | undefined, authorization?: string, proxy = false) {
  return HttpServerRequest.fromWeb(
    new Request("http://localhost/mcp/visualizations", {
      method: "POST",
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(proxy ? { "x-cafe-code-https-proxy": "1" } : {}),
        "x-forwarded-for": "127.0.0.1",
      },
    }),
  ).modify({ remoteAddress: Option.fromUndefinedOr(peer) });
}
const handle = (value: ReturnType<typeof request>) =>
  Effect.runPromise(
    handleVisualizationMcpRequest.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, value),
      Effect.provideService(ServerConfig, {} as never),
    ),
  );

/** Exercise the actual loopback HTTP request and SDK tool envelope without a
 * provider, profile, native host or database. Only preview is enabled in this
 * isolated service; any unintended publication fails instead of claiming a
 * successful artifact. The synthetic PNG is transport data, not host evidence. */
async function generatedHttpFixture() {
  const token = "ab".repeat(32);
  const generation = VisualizationGenerationId.make("11111111-1111-4111-8111-111111111111");
  const authority: VisualizationSessionAuthority = {
    threadId: ThreadId.make("generated-http-fixture"),
    providerInstanceId: ProviderInstanceId.make("codex_work"),
    sessionGeneration: generation,
    runtimeGeneration: generation,
    tokenDigest: "cd".repeat(32),
    serverName: `cafe-visualizations-${"a".repeat(22)}`,
  };
  const preview = vi.fn<VisualizationArtifactService["preview"]>(() =>
    Effect.succeed({
      status: "ready" as const,
      png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      width: 640,
      height: 480,
      diagnostics: [],
    }),
  );
  const unexpected = Effect.die("Only preview is admitted by the isolated HTTP fixture.");
  const refuseUnexpected = () => unexpected;
  const service: VisualizationArtifactService = {
    preview,
    publish: refuseUnexpected,
    publishMcpApp: refuseUnexpected,
    list: refuseUnexpected,
    details: refuseUnexpected,
    poster: refuseUnexpected,
    viewerTicket: refuseUnexpected,
    readViewerTicket: refuseUnexpected,
    exportHtml: refuseUnexpected,
    sweep: unexpected,
    debug: refuseUnexpected,
    requireActiveSession: refuseUnexpected,
    readMcpAppSnapshot: refuseUnexpected,
  };
  const uninstall = installVisualizationSessionRuntime({
    bind: async () => undefined,
    close: async () => {},
    authorize: async (candidate) => {
      if (candidate !== token) throw new Error("Private synthetic authorization refused.");
      return authority;
    },
  });
  const scope = await Effect.runPromise(Scope.make());
  // Use the same native interpreter as production, including backpressure,
  // outgoing finish/close and exact request cancellation. A hand-written Web
  // response adapter would not qualify this lifetime boundary.
  const handler = await Effect.runPromise(
    NodeHttpServer.makeHandler(
      handleVisualizationMcpRequest.pipe(
        Effect.provideService(ServerConfig, {} as never),
        Effect.provideService(VisualizationArtifacts, service),
      ),
      { scope },
    ),
  );
  const server = http.createServer(handler);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    uninstall();
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing isolated HTTP address.");
  const send = (chunks: readonly Uint8Array[], completeBody = true) =>
    new Promise<{ status: number | undefined; text: string; connection: string | undefined }>(
      (resolve, reject) => {
        const client = http.request(
          `http://127.0.0.1:${address.port}/mcp/visualizations`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
          },
          (response) => {
            const bytes: Buffer[] = [];
            let length = 0;
            response.on("data", (chunk: Buffer) => {
              length += chunk.length;
              if (length > 8192) {
                response.destroy(new Error("Isolated response exceeds its fixture bound."));
                return;
              }
              bytes.push(chunk);
            });
            response.once("error", reject);
            response.once("end", () =>
              resolve({
                status: response.statusCode,
                text: Buffer.concat(bytes).toString("utf8"),
                connection: response.headers.connection,
              }),
            );
          },
        );
        client.once("error", reject);
        for (const chunk of chunks) client.write(chunk);
        if (completeBody) client.end();
      },
    );
  return {
    authority,
    preview,
    send,
    close: async () => {
      uninstall();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    },
    url: `http://127.0.0.1:${address.port}/mcp/visualizations`,
    token,
  };
}

const smallGeneratedInput = {
  version: 1,
  purpose: "generated-visualization",
  requestId: "11111111-1111-4111-8111-111111111111",
  source: "<main>Isolated HTTP response lifetime</main>",
  title: "Synthetic HTTP response lifetime",
  assets: [],
  appearance: "dark",
};
const smallGeneratedRequest = new TextEncoder().encode(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "preview_visualization", arguments: smallGeneratedInput },
  }),
);
/** Pause a real client after headers so the native server encounters downstream
 * backpressure. The large fixture payload is only an opaque HTTP transport
 * value; this test neither decodes it nor qualifies native image rendering. */
const pausedGeneratedResponse = (fixture: Awaited<ReturnType<typeof generatedHttpFixture>>) =>
  new Promise<{ client: http.ClientRequest; response: http.IncomingMessage }>((resolve, reject) => {
    const client = http.request(
      fixture.url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
      },
      (response) => {
        response.pause();
        // These are deliberately retired fixture-owned sockets. Their opaque
        // native cancellation errors are not provider diagnostics or test data.
        response.on("error", () => {});
        resolve({ client, response });
      },
    );
    client.once("error", reject);
    client.end(smallGeneratedRequest);
  });
const largeTransportPreview = {
  status: "ready" as const,
  // Equal to the admitted maximum PNG's encoded size, without introducing a
  // renderer or claiming this transport-only fixture is an actual image.
  png: "A".repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4),
  width: 640,
  height: 480,
  diagnostics: [],
};

describe("private visualization HTTP audience", () => {
  it("admits exact UTF-8 JSON across chunks without changing private source", async () => {
    const text = JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { source: "🌸" } });
    const bytes = new TextEncoder().encode(text);
    expect(
      await Effect.runPromise(
        readVisualizationMcpBody(Stream.make(bytes.slice(0, 3), bytes.slice(3))),
      ),
    ).toBe(text);
  });
  it("delivers a large fragmented generated tool input exactly and rejects invalid bodies before dispatch", async () => {
    const fixture = await generatedHttpFixture();
    try {
      const input = {
        version: 1,
        purpose: "generated-visualization",
        requestId: "11111111-1111-4111-8111-111111111111",
        source: `<main>${'🌸"\\'.repeat(35_000)}</main>`,
        title: "Synthetic generated HTTP input",
        assets: Array.from({ length: 16 }, (_, index) => ({
          assetId: `asset-${index}`,
          attachmentId: "11111111-1111-4111-8111-111111111111",
        })),
        appearance: "dark",
        viewport: { width: 640, height: 480 },
      };
      const text = JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "preview_visualization", arguments: input },
      });
      const bytes = new TextEncoder().encode(text);
      expect(bytes.length).toBeGreaterThan(128 * 1024);
      const unicodeOffset = bytes.indexOf(0xf0);
      expect(unicodeOffset).toBeGreaterThan(0);
      // Break a four-byte Unicode scalar across the real client's writes and
      // separately through the reader's stream, independent of TCP coalescing.
      const chunks = [
        bytes.slice(0, unicodeOffset + 1),
        bytes.slice(unicodeOffset + 1, unicodeOffset + 3),
        bytes.slice(unicodeOffset + 3),
      ];
      expect(await Effect.runPromise(readVisualizationMcpBody(Stream.fromIterable(chunks)))).toBe(
        text,
      );
      const admitted = await fixture.send(chunks);
      expect(admitted.status).toBe(200);
      expect(JSON.parse(admitted.text)).toMatchObject({
        jsonrpc: "2.0",
        id: 7,
        result: { content: [{ type: "text" }, { type: "image", mimeType: "image/png" }] },
      });
      expect(fixture.preview).toHaveBeenCalledExactlyOnceWith(fixture.authority, input);
      for (const invalid of [
        new Uint8Array([0xff]),
        new TextEncoder().encode('{"source":"PRIVATE HTTP MARKER"'),
      ]) {
        const refused = await fixture.send([invalid]);
        expect(refused.status).toBe(400);
        expect(refused.text).toBe('{"error":"Invalid visualization request body."}');
        expect(refused.text).not.toContain("PRIVATE");
      }
      // Native incoming-stream cancellation may close the exact oversized
      // request's socket before a 400 can be sent. Either way no SDK dispatch
      // or retained response remains; this is not a successful JSON reply.
      await expect(
        fixture.send([new Uint8Array(VISUALIZATION_MAX_INPUT_JSON_BYTES + 1)]),
      ).rejects.toThrow();
      expect(fixture.preview).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.close();
    }
  });
  it("holds four native response leases until downstream completion and refuses a fifth without dispatch", async () => {
    const fixture = await generatedHttpFixture();
    const paused: Awaited<ReturnType<typeof pausedGeneratedResponse>>[] = [];
    try {
      fixture.preview.mockReturnValue(Effect.succeed(largeTransportPreview));
      for (let index = 0; index < 4; index++) {
        const connection = await pausedGeneratedResponse(fixture);
        expect(connection.response.statusCode).toBe(200);
        paused.push(connection);
      }
      expect(visualizationMcpRequestCount()).toBe(4);
      // Leave the fifth body incomplete: saturation must refuse before parsing
      // or waiting for a producer, and close only that unadmitted connection.
      const refused = await fixture.send([new TextEncoder().encode("{")], false);
      expect(refused.status).toBe(503);
      expect(refused.connection).toBe("close");
      expect(refused.text).toBe('{"error":"Visualization request failed."}');
      expect(fixture.preview).toHaveBeenCalledTimes(4);

      paused[0]!.response.destroy();
      paused[0]!.client.destroy();
      await vi.waitFor(() => expect(visualizationMcpRequestCount()).toBe(3));
      fixture.preview.mockReturnValueOnce(
        Effect.succeed({ ...largeTransportPreview, png: "c3ludGhldGlj" }),
      );
      expect((await fixture.send([smallGeneratedRequest])).status).toBe(200);
      await vi.waitFor(() => expect(visualizationMcpRequestCount()).toBe(3));
      expect(fixture.preview).toHaveBeenCalledTimes(5);
    } finally {
      for (const connection of paused) {
        connection.response.destroy();
        connection.client.destroy();
      }
      await fixture.close();
    }
    // server.close completes before queued ServerResponse "close" callbacks on
    // some hosts. Observe the actual response retirement, not just its socket
    // removal from the server's connection inventory.
    await vi.waitFor(() => expect(visualizationMcpRequestCount()).toBe(0));
  });
  it("retires only the stalled response at an absolute output deadline despite later received bytes", async () => {
    const fixture = await generatedHttpFixture();
    let paused: Awaited<ReturnType<typeof pausedGeneratedResponse>> | undefined;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fixture.preview.mockReturnValue(Effect.succeed(largeTransportPreview));
      paused = await pausedGeneratedResponse(fixture);
      expect(visualizationMcpRequestCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(VISUALIZATION_MCP_RESPONSE_MS - 1);
      expect(visualizationMcpRequestCount()).toBe(1);
      const response = paused.response;
      const received = new Promise<void>((resolve) =>
        response.once("data", () => {
          response.pause();
          resolve();
        }),
      );
      response.resume();
      await received;
      expect(visualizationMcpRequestCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(visualizationMcpRequestCount()).toBe(0);
      expect(fixture.preview).toHaveBeenCalledExactlyOnceWith(
        fixture.authority,
        smallGeneratedInput,
      );
    } finally {
      vi.useRealTimers();
      paused?.response.destroy();
      paused?.client.destroy();
      await fixture.close();
    }
  });
  it("bounds outgoing bytes/chunks and discards private stream errors without accumulating buffers", async () => {
    let consumedTail = false;
    const overflow = Stream.make(new Uint8Array(VISUALIZATION_MCP_MAX_RESPONSE_BYTES + 1)).pipe(
      Stream.concat(
        Stream.fromEffect(
          Effect.sync(() => {
            consumedTail = true;
            return new Uint8Array();
          }),
        ),
      ),
    );
    for (const stream of [
      overflow,
      Stream.fromIterable(Array.from({ length: 2049 }, () => new Uint8Array())),
      Stream.fail(new Error("PRIVATE RESPONSE MARKER")),
    ])
      await expect(
        Effect.runPromise(boundVisualizationMcpResponse(stream).pipe(Stream.runDrain)),
      ).rejects.toThrow("Visualization response could not be delivered.");
    expect(consumedTail).toBe(false);
    const bytes = new Uint8Array([1, 2, 3]);
    expect(
      await Effect.runPromise(
        boundVisualizationMcpResponse(Stream.make(bytes)).pipe(Stream.runCollect),
      ),
    ).toEqual([bytes]);
  });
  it("refuses actual-byte overflow before consuming the remaining body", async () => {
    let consumedTail = false;
    const stream = Stream.make(new Uint8Array(VISUALIZATION_MAX_INPUT_JSON_BYTES + 1)).pipe(
      Stream.concat(
        Stream.fromEffect(
          Effect.sync(() => {
            consumedTail = true;
            return new Uint8Array();
          }),
        ),
      ),
    );
    await expect(Effect.runPromise(readVisualizationMcpBody(stream))).rejects.toThrow(
      "Invalid visualization request body.",
    );
    expect(consumedTail).toBe(false);
  });
  it.each([
    new Uint8Array([0xff]),
    new TextEncoder().encode('{"source":"private-marker"'),
    new TextEncoder().encode("[".repeat(25) + "0" + "]".repeat(25)),
  ])("rejects malformed transport without echoing received bytes", async (bytes) => {
    await expect(Effect.runPromise(readVisualizationMcpBody(Stream.make(bytes)))).rejects.toThrow(
      "Invalid visualization request body.",
    );
  });
  it("bounds zero-byte chunks independently of body bytes", async () => {
    await expect(
      Effect.runPromise(
        readVisualizationMcpBody(
          Stream.fromIterable(Array.from({ length: 2049 }, () => new Uint8Array())),
        ),
      ),
    ).rejects.toThrow("Invalid visualization request body.");
  });
  it.each([undefined, "203.0.113.9", "192.168.1.4", "::ffff:192.168.1.4"])(
    "rejects nonlocal %s despite forwarded headers",
    async (peer) => {
      expect((await handle(request(peer, `Bearer ${"a".repeat(64)}`))).status).toBe(403);
    },
  );
  it("refuses the HTTPS sibling even when its observed socket is local", async () => {
    expect((await handle(request("127.0.0.1", `Bearer ${"a".repeat(64)}`, true))).status).toBe(403);
  });
  it.each([
    undefined,
    "Bearer owner-session",
    `Bearer ${"A".repeat(64)}`,
    `Basic ${"a".repeat(64)}`,
  ])("rejects absent or wrong-audience credentials %s", async (authorization) => {
    expect((await handle(request("127.0.0.1", authorization))).status).toBe(401);
  });
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "refuses unknown session capabilities from %s",
    async (peer) => {
      expect((await handle(request(peer, `Bearer ${"a".repeat(64)}`))).status).toBe(403);
    },
  );
  it("does not expose content-free debug counts without explicit debug mode", async () => {
    const result = await Effect.runPromise(
      handleVisualizationDebugRequest.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request("127.0.0.1")),
        Effect.provideService(ServerConfig, { logLevel: "Error" } as never),
        Effect.provideService(ServerAuth, {
          authenticateHttpRequest: () =>
            Effect.fail(new AuthError({ message: "Fixture denies authentication.", status: 401 })),
        } as never),
      ),
    );
    expect(result.status).toBe(404);
  });
});
