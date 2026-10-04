import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { registerSessionSchedulingTools } from "./mcp.ts";
import { ScheduledFollowups } from "./service.ts";
import { makeSchedulingSessionService } from "./sessionRuntime.ts";

/** Separate audience from owner-management MCP. No installer, owner session or
 * broad MCP toggle grants this authority. Only a locally connected, live
 * provider session can discover the narrow catalog; each actual operation is
 * additionally generation/account-fenced in its database transaction. */
export const handleSchedulingMcpRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // Cafe's HTTPS sibling deliberately proxies LAN traffic over loopback. Its
  // marker is a denial signal, never an authorization claim; spoofing it can
  // only deny a request, not obtain a local session capability.
  if (
    request.headers["x-cafe-code-https-proxy"] ||
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      Option.getOrElse(request.remoteAddress, () => ""),
    )
  )
    return HttpServerResponse.jsonUnsafe(
      { error: "Scheduling tools require a local connection." },
      { status: 403 },
    );
  const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token)
    return HttpServerResponse.jsonUnsafe(
      { error: "A scheduling session is required." },
      { status: 401 },
    );
  const sessionService = yield* makeSchedulingSessionService;
  const authority = yield* sessionService.authorize(token).pipe(Effect.option);
  if (Option.isNone(authority))
    return HttpServerResponse.jsonUnsafe(
      { error: "This scheduling session expired. Resume the Cafe chat to reconnect." },
      { status: 403 },
    );
  const service = yield* ScheduledFollowups;
  const webRequest = yield* HttpServerRequest.toWeb(request);
  return yield* Effect.tryPromise({
    try: async () => {
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const server = new McpServer({ name: "Cafe chat scheduling", version: "1" });
      registerSessionSchedulingTools(server, service, authority.value);
      try {
        await server.connect(transport);
        return HttpServerResponse.fromWeb(await transport.handleRequest(webRequest));
      } finally {
        await server.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }
    },
    // Never expose request bodies, capabilities, SQL or provider errors.
    catch: () => new Error("Scheduling request failed."),
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: "Scheduling request failed." }, { status: 503 }),
      ),
    ),
  );
});

export const schedulingMcpRouteLayer = HttpRouter.add(
  "POST",
  "/mcp/scheduling",
  handleSchedulingMcpRequest,
);
