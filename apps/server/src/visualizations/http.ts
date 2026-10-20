import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
// Admission binds the actual outgoing Node response and its finish/close events.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { ServerResponse } from "node:http";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  VisualizationDetailsInput,
  VISUALIZATION_POSTER_PATH,
} from "@cafecode/contracts/visualizationApi";
import { ThreadId } from "@cafecode/contracts";
import { VISUALIZATION_MAX_INPUT_JSON_BYTES } from "@cafecode/contracts/visualizations";
import { decodeGeneratedVisualizationTransportJson } from "@cafecode/shared/visualizationJson";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { browserApiCorsHeaders } from "../httpCors.ts";
import { ServerConfig } from "../config.ts";
import { registerVisualizationTools } from "./mcp.ts";
import { VisualizationArtifacts } from "./service.ts";
import { makeVisualizationSessionService } from "./sessionRuntime.ts";
import { readMcpAppOwnerDiagnostics } from "../mcpApps/owner.ts";
import { acquireVisualizationMcpResponse, boundVisualizationMcpResponse } from "./mcpResponse.ts";
import { VisualizationTransportError } from "./transportError.ts";

const decodeTuple = Schema.decodeUnknownResult(VisualizationDetailsInput);
const decodeThread = Schema.decodeUnknownResult(ThreadId.check(Schema.isMaxLength(200)));
const count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
// Debug is a second disclosure boundary, even for trusted process counters.
const decodeLocalAppCounts = Schema.decodeUnknownResult(
  Schema.Struct({
    localOwners: count,
    localCaptures: count,
    localModelContexts: count,
    refusedCaptures: count,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
);
const privateHeaders = {
  ...browserApiCorsHeaders,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};
const observedLoopback = (request: HttpServerRequest.HttpServerRequest) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    Option.getOrElse(request.remoteAddress, () => ""),
  );

/** The stdio bridge's frame ceiling does not bound direct authenticated HTTP.
 * Count actual stream bytes before concatenation or SDK parsing, independently
 * of Content-Length. Finite chunks and an absolute body deadline also refuse
 * empty-chunk floods and slow producers. Received parser/UTF-8 errors never
 * retain source in a diagnostic cause. This validates transport, not authority. */
export const readVisualizationMcpBody = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
  stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Uint8Array[], length: 0 }),
      (state, chunk) =>
        state.length + chunk.byteLength > VISUALIZATION_MAX_INPUT_JSON_BYTES ||
        state.chunks.length >= 2048
          ? Effect.fail(
              new VisualizationTransportError({ message: "Invalid visualization request body." }),
            )
          : Effect.sync(() => {
              state.chunks.push(chunk);
              state.length += chunk.byteLength;
              return state;
            }),
    ),
    Effect.flatMap((collected) =>
      Effect.try({
        try: () => {
          const bytes = new Uint8Array(collected.length);
          let offset = 0;
          for (const chunk of collected.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (decodeGeneratedVisualizationTransportJson(text).status !== "decoded")
            throw new VisualizationTransportError({
              message: "Invalid visualization request body.",
            });
          return text;
        },
        catch: () =>
          new VisualizationTransportError({ message: "Invalid visualization request body." }),
      }),
    ),
    Effect.mapError(
      () => new VisualizationTransportError({ message: "Invalid visualization request body." }),
    ),
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(
          new VisualizationTransportError({ message: "Invalid visualization request body." }),
        ),
    }),
  );

export const handleVisualizationMcpRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers["x-cafe-code-https-proxy"] || !observedLoopback(request))
    return HttpServerResponse.empty({ status: 403 });
  const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return HttpServerResponse.empty({ status: 401 });
  const authority = yield* (yield* makeVisualizationSessionService)
    .authorize(token)
    .pipe(Effect.option);
  if (Option.isNone(authority)) return HttpServerResponse.empty({ status: 403 });
  const service = yield* Effect.serviceOption(VisualizationArtifacts);
  if (Option.isNone(service)) return HttpServerResponse.empty({ status: 503 });
  return yield* Effect.acquireUseRelease(
    Effect.suspend(() =>
      Effect.try({
        try: () => {
          const nativeResponse = NodeHttpServerRequest.toServerResponse(request);
          // Production uses the native Node HTTP interpreter. A Web-only peer
          // cannot fabricate its outgoing response lifecycle or reserve a lane.
          if (!(nativeResponse instanceof ServerResponse))
            throw new VisualizationTransportError({ message: "Visualization request failed." });
          const lease = acquireVisualizationMcpResponse(nativeResponse);
          if (!lease)
            throw new VisualizationTransportError({ message: "Visualization request failed." });
          return lease;
        },
        catch: () => new VisualizationTransportError({ message: "Visualization request failed." }),
      }),
    ),
    (lease) =>
      Effect.gen(function* () {
        const body = yield* readVisualizationMcpBody(request.stream).pipe(Effect.option);
        if (Option.isNone(body)) {
          lease.beginOutput();
          return HttpServerResponse.jsonUnsafe(
            { error: "Invalid visualization request body." },
            { status: 400, headers: privateHeaders },
          );
        }
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const admittedRequest = new Request(webRequest, { method: "POST", body: body.value });
        return yield* Effect.tryPromise({
          try: async () => {
            const transport = new WebStandardStreamableHTTPServerTransport({
              enableJsonResponse: true,
            });
            const server = new McpServer({ name: "Cafe chat visualizations", version: "1" });
            registerVisualizationTools(server, service.value, authority.value);
            try {
              await server.connect(transport);
              const response = await transport.handleRequest(admittedRequest);
              const outgoing = response.body
                ? HttpServerResponse.stream(
                    boundVisualizationMcpResponse(
                      Stream.fromReadableStream({
                        evaluate: () => response.body!,
                        onError: () =>
                          new VisualizationTransportError({
                            message: "Visualization response could not be delivered.",
                          }),
                      }),
                    ),
                    {
                      status: response.status,
                      headers: { ...Object.fromEntries(response.headers), ...privateHeaders },
                    },
                  )
                : HttpServerResponse.empty({ status: response.status, headers: privateHeaders });
              lease.beginOutput();
              return outgoing;
            } finally {
              await server.close().catch(() => undefined);
              await transport.close().catch(() => undefined);
            }
          },
          catch: () =>
            new VisualizationTransportError({ message: "Visualization request failed." }),
        });
      }).pipe(
        Effect.catch(() => {
          lease.beginOutput();
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: "Visualization request failed." },
              { status: 503, headers: privateHeaders },
            ),
          );
        }),
      ),
    (lease) => Effect.sync(lease.releaseUnlessTransferred),
  ).pipe(
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: "Visualization request failed." },
          // Saturation has not admitted or read this body. Retire that exact
          // HTTP connection instead of leaving an unowned slow upload alive.
          { status: 503, headers: { ...privateHeaders, connection: "close" } },
        ),
      ),
    ),
  );
});
export const visualizationMcpRouteLayer = HttpRouter.add(
  "POST",
  "/mcp/visualizations",
  handleVisualizationMcpRequest,
);

/** Explicit owner read; native IDs and selected tuples are never file paths. */
const handlePoster = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* ServerAuth;
  const session = yield* auth.authenticateHttpRequest(request);
  if (session.role !== "owner")
    return yield* new AuthError({ message: "Owner access required.", status: 403 });
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400, headers: privateHeaders });
  const parts = url.value.pathname.slice(VISUALIZATION_POSTER_PATH.length + 1).split("/");
  const tuple = decodeTuple({
    threadId: url.value.searchParams.get("threadId"),
    artifactId: parts[0],
    revisionId: parts[1],
  });
  if (parts.length !== 2 || Result.isFailure(tuple))
    return HttpServerResponse.empty({ status: 400, headers: privateHeaders });
  const artifacts = yield* Effect.serviceOption(VisualizationArtifacts);
  if (Option.isNone(artifacts))
    return HttpServerResponse.empty({ status: 503, headers: privateHeaders });
  const bytes = yield* artifacts.value.poster(tuple.success).pipe(Effect.option);
  // Reauthenticate a possibly revoked credential after asynchronous I/O.
  const current = yield* auth.authenticateHttpRequest(request);
  if (current.role !== "owner")
    return yield* new AuthError({ message: "Owner access required.", status: 403 });
  return Option.isSome(bytes)
    ? HttpServerResponse.uint8Array(bytes.value, {
        contentType: "image/png",
        headers: privateHeaders,
      })
    : HttpServerResponse.empty({ status: 404, headers: privateHeaders });
}).pipe(Effect.catchTag("AuthError", respondToAuthError));
/** Deliberately content-free diagnostics. Failed pending source remains private
 * and never gains claimed-reference read authority merely because it failed. */
export const handleVisualizationDebugRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig;
  if (
    config.logLevel !== "Debug" ||
    request.headers["x-cafe-code-https-proxy"] ||
    !observedLoopback(request)
  )
    return HttpServerResponse.empty({ status: 404, headers: privateHeaders });
  const auth = yield* ServerAuth;
  const session = yield* auth.authenticateHttpRequest(request);
  if (session.role !== "owner")
    return yield* new AuthError({ message: "Owner access required.", status: 403 });
  const url = HttpServerRequest.toURL(request);
  if (
    Option.isNone(url) ||
    url.value.searchParams.size !== 1 ||
    !url.value.searchParams.has("threadId")
  )
    return HttpServerResponse.empty({ status: 400, headers: privateHeaders });
  const thread = decodeThread(url.value.searchParams.get("threadId"));
  if (Result.isFailure(thread))
    return HttpServerResponse.empty({ status: 400, headers: privateHeaders });
  const artifacts = yield* Effect.serviceOption(VisualizationArtifacts);
  if (Option.isNone(artifacts))
    return HttpServerResponse.empty({ status: 503, headers: privateHeaders });
  const result = yield* artifacts.value.debug(thread.success).pipe(Effect.option);
  const current = yield* auth.authenticateHttpRequest(request);
  if (current.role !== "owner")
    return yield* new AuthError({ message: "Owner access required.", status: 403 });
  const localApps = decodeLocalAppCounts(readMcpAppOwnerDiagnostics());
  return Option.isSome(result)
    ? HttpServerResponse.jsonUnsafe(
        {
          ...result.value,
          ...(Result.isSuccess(localApps)
            ? { apps: { scope: "local-process", ...localApps.success } }
            : {}),
        },
        { headers: privateHeaders },
      )
    : HttpServerResponse.empty({ status: 404, headers: privateHeaders });
}).pipe(Effect.catchTag("AuthError", respondToAuthError));
export const visualizationPosterRouteLayer = Layer.mergeAll(
  HttpRouter.add("GET", `${VISUALIZATION_POSTER_PATH}/*`, handlePoster),
  HttpRouter.add("GET", "/api/visualizations/debug", handleVisualizationDebugRequest),
);
