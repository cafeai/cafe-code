import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeDesktopService } from "./service.ts";
import { makeDesktopMcpServer } from "./mcp.ts";

/** Desktop capabilities have a distinct audience and are never owner sessions. */
export const handleDesktopMcpRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // This is a local computer-control capability. Forwarded headers and
  // remote Cafe owner sessions never establish a local peer identity.
  if (
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      Option.getOrElse(request.remoteAddress, () => ""),
    )
  )
    return HttpServerResponse.jsonUnsafe(
      { error: "Desktop Control requires a local connection." },
      { status: 403 },
    );
  const settings = yield* ServerSettingsService;
  const flags = yield* settings.getSettings;
  if (
    process.platform !== "linux" ||
    !flags.virtualDesktopsEnabled ||
    !flags.desktopControlMcpEnabled
  )
    return HttpServerResponse.jsonUnsafe(
      { error: "Desktop Control is disabled." },
      { status: 403 },
    );
  const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token)
    return HttpServerResponse.jsonUnsafe(
      { error: "A desktop session capability is required." },
      { status: 401 },
    );
  const service = yield* makeDesktopService;
  const authorized = yield* service.request({ operation: "authorize", token }).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
  if (!authorized)
    return HttpServerResponse.jsonUnsafe({ error: "Desktop session expired." }, { status: 403 });
  const webRequest = yield* HttpServerRequest.toWeb(request);
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      const server = makeDesktopMcpServer((name, args, extraSignal) =>
        Effect.runPromise(service.request({ operation: "tool", token, name, args }), {
          signal: AbortSignal.any([signal, extraSignal]),
        }),
      );
      try {
        await server.connect(transport);
        return HttpServerResponse.fromWeb(await transport.handleRequest(webRequest));
      } finally {
        await server.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }
    },
    catch: () => new Error("Desktop MCP request failed."),
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: "Desktop request failed." }, { status: 503 }),
      ),
    ),
  );
});
export const desktopMcpRouteLayer = HttpRouter.add("POST", "/mcp/desktop", handleDesktopMcpRequest);
