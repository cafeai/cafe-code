import { ServerResponse } from "node:http";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { boundedWebRequest, respondToHttpBodyError } from "../httpBody.ts";
import { glideExecutionResponses, glideControlResponses } from "./mcpResponse.ts";
import { createGlideMcpServer } from "./mcp.ts";
import { cellResultSchema } from "./protocol.ts";
import { makeGlideService } from "./sessionRuntime.ts";

export const handleGlideMcpRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (
    request.headers["x-cafe-code-https-proxy"] ||
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      Option.getOrElse(request.remoteAddress, () => ""),
    )
  )
    return HttpServerResponse.empty({ status: 403 });
  const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return HttpServerResponse.empty({ status: 401 });
  const operation = yield* makeGlideService;
  const authorized = yield* Effect.tryPromise({
    try: () => operation({ kind: "catalog", token }),
    catch: () => new Error("Glide session expired."),
  }).pipe(Effect.option);
  if (Option.isNone(authorized)) return HttpServerResponse.empty({ status: 403 });
  const incoming = yield* boundedWebRequest(request);
  const prepared = yield* Effect.tryPromise({
    try: async () => {
      const text = await incoming.text();
      const envelope: unknown = JSON.parse(text);
      const message =
        typeof envelope === "object" && envelope !== null
          ? (envelope as Record<string, unknown>)
          : undefined;
      const params =
        typeof message?.params === "object" && message.params !== null
          ? (message.params as Record<string, unknown>)
          : undefined;
      const execution =
        Array.isArray(envelope) ||
        (message?.method === "tools/call" && params?.name !== "js_reset");
      return {
        webRequest: new Request(incoming, { method: "POST", body: text }),
        responses: execution ? glideExecutionResponses : glideControlResponses,
      };
    },
    catch: () => new Error("Invalid Glide envelope."),
  }).pipe(Effect.option);
  if (Option.isNone(prepared)) return HttpServerResponse.empty({ status: 400 });
  const { webRequest, responses } = prepared.value;
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const response = NodeHttpServerRequest.toServerResponse(request);
        if (!(response instanceof ServerResponse))
          throw new Error("Native HTTP response required.");
        return responses.acquire(response);
      },
      catch: () => new Error("Glide unavailable."),
    }),
    (lease) =>
      Effect.gen(function* () {
        return yield* Effect.tryPromise({
          try: async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({
              enableJsonResponse: true,
            });
            const controller = new AbortController();
            const response = NodeHttpServerRequest.toServerResponse(request);
            const abort = () => {
              if (!response.writableFinished) controller.abort();
            };
            response.once("close", abort);
            if (response.destroyed) controller.abort();
            const server = createGlideMcpServer(
              {
                execute: async (input, signal) =>
                  cellResultSchema.parse(
                    await operation(
                      { kind: "execute", token, input },
                      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
                    ),
                  ),
                reset: async () => {
                  await operation({ kind: "reset", token }, controller.signal);
                },
              },
              "background",
              true,
            );
            try {
              await server.connect(transport);
              const outgoing = await transport.handleRequest(webRequest);
              lease.beginOutput();
              return outgoing.body
                ? HttpServerResponse.stream(
                    responses.bound(
                      Stream.fromReadableStream({
                        evaluate: () => outgoing.body!,
                        onError: () => new Error("Glide response failed."),
                      }),
                    ),
                    {
                      status: outgoing.status,
                      headers: {
                        ...Object.fromEntries(outgoing.headers),
                        "cache-control": "no-store",
                      },
                    },
                  )
                : HttpServerResponse.empty({ status: outgoing.status });
            } finally {
              response.off("close", abort);
              await server.close().catch(() => undefined);
              await transport.close().catch(() => undefined);
            }
          },
          catch: () => new Error("Glide request failed."),
        });
      }).pipe(
        Effect.catch(() => {
          lease.beginOutput();
          return Effect.succeed(HttpServerResponse.empty({ status: 503 }));
        }),
      ),
    (lease) => Effect.sync(lease.releaseUnlessTransferred),
  ).pipe(
    Effect.catch(() =>
      Effect.succeed(HttpServerResponse.empty({ status: 503, headers: { connection: "close" } })),
    ),
  );
}).pipe(Effect.catchTag("HttpBodyError", respondToHttpBodyError));
export const glideMcpRouteLayer = HttpRouter.add("POST", "/mcp/glide", handleGlideMcpRequest);
