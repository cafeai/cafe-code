import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { respondToAuthError } from "../auth/http.ts";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";
import { makeCafeMcpServer } from "./CafeMcpServer.ts";

export const CAFE_MCP_PATH = "/mcp";

export const cafeMcpRouteLayer = HttpRouter.add(
  "POST",
  CAFE_MCP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    if (session.role !== "owner") {
      return yield* new AuthError({
        message: "Only owner sessions can use the Cafe Code MCP server.",
        status: 403,
      });
    }

    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const providerRegistry = yield* ProviderRegistry;
    const providerService = yield* ProviderService;
    const serverSettings = yield* ServerSettingsService;
    const startup = yield* ServerRuntimeStartup;
    const workspacePaths = yield* WorkspacePaths;
    const webRequest = yield* HttpServerRequest.toWeb(request);

    const webResponse = yield* Effect.tryPromise({
      try: async () => {
        // Stateless JSON responses are enough for Cafe's bounded control
        // tools and let each authenticated HTTP request own all MCP state.
        // No provider process or bearer token is retained after the response.
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        const mcpServer = makeCafeMcpServer({
          orchestrationEngine,
          projectionSnapshotQuery,
          providerRegistry,
          providerService,
          serverSettings,
          startup,
          workspacePaths,
        });
        try {
          await mcpServer.connect(transport);
          return await transport.handleRequest(webRequest);
        } finally {
          await mcpServer.close().catch(() => undefined);
          await transport.close().catch(() => undefined);
        }
      },
      catch: () =>
        new AuthError({
          message: "Cafe Code MCP request failed.",
          status: 500,
        }),
    });
    return HttpServerResponse.fromWeb(webResponse);
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);
