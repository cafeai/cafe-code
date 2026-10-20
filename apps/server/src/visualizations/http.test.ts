// The fixture qualifies real native finish/close and socket-buffering behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
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
  VisualizationArtifactId,
  VisualizationRevisionId,
  VisualizationRequestId,
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
 * provider, profile, native host or database. Publication returns only a
 * synthetic transport receipt; it is not database, rendering or completion
 * evidence. Every other operation fails instead of gaining incidental access. */
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
  const publish = vi.fn<VisualizationArtifactService["publish"]>(() =>
    Effect.succeed(smallTransportReceipt),
  );
  const unexpected = Effect.die("Only synthetic publication is admitted by the HTTP fixture.");
  const refuseUnexpected = () => unexpected;
  const service: VisualizationArtifactService = {
    publish,
    publishMcpApp: refuseUnexpected,
    list: refuseUnexpected,
    details: refuseUnexpected,
    inline: refuseUnexpected,
    touchInlineFrame: refuseUnexpected,
    retireInlineFrame: refuseUnexpected,
    readInlineFrame: refuseUnexpected,
    inlineFrameDeadline: () => undefined,
    poster: refuseUnexpected,
    viewerTicket: refuseUnexpected,
    discardViewerTicket: refuseUnexpected,
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
  type HeldCompletion = {
    response: http.ServerResponse;
    complete: () => void;
  };
  let nextHold = 0;
  const completionHolds = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<HeldCompletion>>
  >();
  const prepareCompletionHold = () => {
    const id = String(++nextHold);
    const completion = Promise.withResolvers<HeldCompletion>();
    // Fixture cleanup may reject a hold before its client receives headers.
    // Observe that rejection immediately without swallowing the awaited result.
    void completion.promise.catch(() => {});
    completionHolds.set(id, completion);
    return { id, completion: completion.promise };
  };
  const server = http.createServer((incoming, outgoing) => {
    const id = incoming.headers["x-cafe-fixture-completion"];
    const hold = typeof id === "string" ? completionHolds.get(id) : undefined;
    if (hold && typeof id === "string") {
      // Control only the final native end on this fixture-owned response. All
      // routing, SDK framing, stream writes and client reads remain real. A
      // paused TCP client is not proof that Node still has pending output:
      // Windows can buffer the complete admitted body before that observation.
      const nativeEnd = outgoing.end;
      let captured = false;
      outgoing.end = ((...args: unknown[]) => {
        if (captured) throw new Error("Fixture response completion was requested twice.");
        captured = true;
        completionHolds.delete(id);
        let completed = false;
        hold.resolve({
          response: outgoing,
          complete: () => {
            if (completed || outgoing.destroyed) return;
            completed = true;
            outgoing.end = nativeEnd;
            Reflect.apply(nativeEnd, outgoing, args);
          },
        });
        return outgoing;
      }) as http.ServerResponse["end"];
      outgoing.once("close", () => {
        completionHolds.delete(id);
        hold.reject(new Error("Fixture response retired before completion could be held."));
      });
    }
    handler(incoming, outgoing);
  });
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
    publish,
    send,
    prepareCompletionHold,
    close: async () => {
      uninstall();
      for (const hold of completionHolds.values())
        hold.reject(new Error("Fixture response completion was retired."));
      completionHolds.clear();
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
    params: { name: "publish_visualization", arguments: smallGeneratedInput },
  }),
);
/** Drain the real bounded payload, then await the controlled native completion
 * boundary. No kernel socket-buffer size or client pause proves that boundary.
 * The opaque payload qualifies transport only, never native image rendering. */
const heldGeneratedResponse = (fixture: Awaited<ReturnType<typeof generatedHttpFixture>>) => {
  const hold = fixture.prepareCompletionHold();
  return new Promise<{
    client: http.ClientRequest;
    response: http.IncomingMessage;
    nativeResponse: http.ServerResponse;
    complete: () => void;
  }>((resolve, reject) => {
    const client = http.request(
      fixture.url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-cafe-fixture-completion": hold.id,
        },
      },
      (response) => {
        let receivedBytes = 0;
        response.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > VISUALIZATION_MCP_MAX_RESPONSE_BYTES)
            response.destroy(new Error("Fixture response exceeds the admitted transport bound."));
        });
        // These are deliberately retired fixture-owned sockets. Their opaque
        // native cancellation errors are not provider diagnostics or test data.
        response.on("error", () => {});
        void hold.completion
          .then(({ response: nativeResponse, complete }) => {
            expect(nativeResponse.writableFinished).toBe(false);
            expect(nativeResponse.destroyed).toBe(false);
            resolve({ client, response, nativeResponse, complete });
          }, reject)
          .catch(reject);
      },
    );
    client.once("error", reject);
    client.end(smallGeneratedRequest);
  });
};
const smallTransportReceipt = {
  version: 1 as const,
  purpose: "cafe-visualization-receipt" as const,
  invocationId: "11111111-1111-4111-8111-111111111111",
  proof: "e".repeat(64),
  reference: {
    version: 1 as const,
    purpose: "generated-visualization" as const,
    artifactId: VisualizationArtifactId.make("11111111-1111-4111-8111-111111111111"),
    revisionId: VisualizationRevisionId.make("22222222-2222-4222-8222-222222222222"),
    title: "Synthetic chart",
    width: 640,
    height: 480,
  },
  requestId: VisualizationRequestId.make("11111111-1111-4111-8111-111111111111"),
  inputSha256: "a".repeat(64),
  sessionGeneration: VisualizationGenerationId.make("11111111-1111-4111-8111-111111111111"),
  serverName: `cafe-visualizations-${"a".repeat(22)}`,
  toolName: "publish_visualization" as const,
} satisfies Effect.Success<ReturnType<VisualizationArtifactService["publish"]>>;
const largeTransportReceipt = {
  ...smallTransportReceipt,
  // The MCP envelope repeats a receipt in text and structured content. This
  // deliberately oversized opaque synthetic field exercises bounded native
  // delivery, not receipt validity, artifact ownership or chart execution.
  proof: "A".repeat(5 * 1024 * 1024),
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
        params: { name: "publish_visualization", arguments: input },
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
        result: {
          content: [{ type: "text" }],
          structuredContent: { visualizationReceipt: smallTransportReceipt },
        },
      });
      expect(fixture.publish).toHaveBeenCalledExactlyOnceWith(fixture.authority, input);
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
      expect(fixture.publish).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.close();
    }
  });
  it("holds four native response leases until downstream completion and refuses a fifth without dispatch", async () => {
    const fixture = await generatedHttpFixture();
    const held: Awaited<ReturnType<typeof heldGeneratedResponse>>[] = [];
    try {
      fixture.publish.mockReturnValue(Effect.succeed(largeTransportReceipt));
      for (let index = 0; index < 4; index++) {
        const connection = await heldGeneratedResponse(fixture);
        expect(connection.response.statusCode).toBe(200);
        held.push(connection);
      }
      expect(visualizationMcpRequestCount()).toBe(4);
      // Leave the fifth body incomplete: saturation must refuse before parsing
      // or waiting for a producer, and close only that unadmitted connection.
      const refused = await fixture.send([new TextEncoder().encode("{")], false);
      expect(refused.status).toBe(503);
      expect(refused.connection).toBe("close");
      expect(refused.text).toBe('{"error":"Visualization request failed."}');
      expect(fixture.publish).toHaveBeenCalledTimes(4);

      held[0]!.response.destroy();
      held[0]!.client.destroy();
      await vi.waitFor(() => expect(visualizationMcpRequestCount()).toBe(3));
      fixture.publish.mockReturnValueOnce(Effect.succeed(smallTransportReceipt));
      expect((await fixture.send([smallGeneratedRequest])).status).toBe(200);
      await vi.waitFor(() => expect(visualizationMcpRequestCount()).toBe(3));
      expect(fixture.publish).toHaveBeenCalledTimes(5);
    } finally {
      for (const connection of held) {
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
  it("releases a held response only when its exact native finish completes", async () => {
    const fixture = await generatedHttpFixture();
    let held: Awaited<ReturnType<typeof heldGeneratedResponse>> | undefined;
    try {
      held = await heldGeneratedResponse(fixture);
      expect(visualizationMcpRequestCount()).toBe(1);
      const ended = new Promise<void>((resolve) => held!.response.once("end", resolve));
      held.complete();
      await ended;
      expect(held.nativeResponse.writableFinished).toBe(true);
      expect(visualizationMcpRequestCount()).toBe(0);
      expect(fixture.publish).toHaveBeenCalledExactlyOnceWith(
        fixture.authority,
        smallGeneratedInput,
      );
    } finally {
      held?.response.destroy();
      held?.client.destroy();
      await fixture.close();
    }
  });
  it("retires only the stalled response at an absolute output deadline despite later received bytes", async () => {
    const fixture = await generatedHttpFixture();
    let held: Awaited<ReturnType<typeof heldGeneratedResponse>> | undefined;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fixture.publish.mockReturnValue(Effect.succeed(largeTransportReceipt));
      held = await heldGeneratedResponse(fixture);
      expect(visualizationMcpRequestCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(VISUALIZATION_MCP_RESPONSE_MS - 1);
      expect(visualizationMcpRequestCount()).toBe(1);
      const response = held.response;
      const received = new Promise<void>((resolve) =>
        response.once("data", () => {
          response.pause();
          resolve();
        }),
      );
      // This bounded trailing JSON whitespace travels through the real native
      // response and client after handoff. It must not renew the fixed deadline.
      held.nativeResponse.write(" ");
      await received;
      expect(visualizationMcpRequestCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(visualizationMcpRequestCount()).toBe(0);
      expect(fixture.publish).toHaveBeenCalledExactlyOnceWith(
        fixture.authority,
        smallGeneratedInput,
      );
    } finally {
      vi.useRealTimers();
      held?.response.destroy();
      held?.client.destroy();
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
