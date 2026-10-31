import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@cafecode/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it, type TestContext } from "vitest";

import { ServerAuthLive } from "../auth/Layers/ServerAuth.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { ServerConfig } from "../config.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceTest } from "../persistence/Sqlite.test.fixture.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "../provider/Services/ProviderRegistry.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { ScheduledFollowups, type ScheduledFollowupsShape } from "../scheduledFollowups/service.ts";
import { ServerRuntimeStartup, type ServerRuntimeStartupShape } from "../serverRuntimeStartup.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../serverSettings.ts";
import { WorkspacePaths, type WorkspacePathsShape } from "../workspace/Services/WorkspacePaths.ts";
import type { CafeMcpDependencies } from "./CafeMcpServer.ts";
import { cafeMcpRouteLayer } from "./http.ts";

const threadId = ThreadId.make("http-launch-chat");
const otherThreadId = ThreadId.make("http-other-chat");
const instanceId = ProviderInstanceId.make("codex_http");
const launchNonce = "b1173a3e-8ad6-4707-8bca-7e4682a7d7be";
const now = "2026-10-31T00:00:00.000Z";

function shell(id: ThreadId): OrchestrationThreadShell {
  return {
    id,
    projectId: null,
    title: "PRIVATE_HTTP_THREAD_TITLE",
    modelSelection: { instanceId, model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    session: {
      threadId: id,
      providerInstanceId: instanceId,
      providerName: "codex",
      status: "ready",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const dependencies = {
  orchestrationEngine: { dispatch: () => Effect.die("Usage must not submit work.") },
  projectionSnapshotQuery: {
    getSnapshot: () => Effect.die("Usage must not load a transcript snapshot."),
    getShellSnapshot: () => Effect.die("Usage must not scan all chats."),
    getArchivedShellSnapshot: () => Effect.die("Usage must not scan archives."),
    getDeletedShellSnapshot: () => Effect.die("Usage must not scan deleted chats."),
    getActiveProjectByWorkspaceRoot: () => Effect.die("Usage must not inspect a workspace."),
    getProjectShellById: () => Effect.die("Usage must not inspect a project."),
    getThreadDetailById: () => Effect.die("Usage must not load messages."),
    getThreadShellById: (id: ThreadId) =>
      Effect.succeed(
        id === threadId || id === otherThreadId ? Option.some(shell(id)) : Option.none(),
      ),
    getThreadContextWindowActivity: () => Effect.succeed(Option.none()),
  },
  providerRegistry: {
    getProviders: Effect.succeed([]),
    refreshInstance: () => Effect.die("Usage must not refresh a provider."),
  },
  providerService: {
    getInstanceInfo: () => Effect.die("Usage must not resolve a native provider."),
    listSessions: () => Effect.die("Usage must not read native sessions."),
    restartProviderRuntime: () => Effect.die("Usage must not restart a provider."),
  },
  serverSettings: {
    getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, mcpEnabled: true }),
    updateSettings: () => Effect.die("Usage must not update settings."),
  },
  startup: { enqueueCommand: () => Effect.die("Usage must not enqueue work.") },
  workspacePaths: { normalizeWorkspaceRoot: () => Effect.die("Usage must not resolve files.") },
} satisfies CafeMcpDependencies;

/** Real signed credentials and production owner authentication, real MCP SDK
 * client/server HTTP transports. The fetch adapter routes Web Requests directly
 * through the production router: no listening socket, provider, real profile,
 * credential source, or command is opened. SQLite/config/secret layers are
 * the existing isolated test fixtures and are finalized by their owned runtime.
 */
async function harness(context: TestContext) {
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "cafe-management-http-test-",
  });
  const runtime = ManagedRuntime.make(
    ServerAuthLive.pipe(
      Layer.provide(SqlitePersistenceTest),
      Layer.provide(ServerSecretStoreLive),
      Layer.provide(configLayer),
      Layer.provide(NodeServices.layer),
    ),
  );
  const app = HttpRouter.toWebHandler(cafeMcpRouteLayer, { disableLogger: true });
  const clients = new Set<Client>();
  const requests = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  let retired = false;
  let closing: Promise<void> | undefined;
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => undefined);
    return work;
  };
  const close = (): Promise<void> => {
    retired = true;
    closing ??= (async () => {
      for (const request of requests) request.abort();
      const first = await Promise.allSettled([...clients].map((client) => client.close()));
      const routes = await Promise.allSettled([app.dispose()]);
      await Promise.allSettled([...pending]);
      const last = await Promise.allSettled([...clients].map((client) => client.close()));
      // Finish the exact authenticated HTTP/client operations before closing
      // their synthetic credential database and secret-store ownership.
      const services = await Promise.allSettled([runtime.dispose()]);
      context.signal.removeEventListener("abort", retire);
      if (
        [...first, ...routes, ...last, ...services].some((result) => result.status === "rejected")
      ) {
        throw new Error("HTTP MCP fixture cleanup failed.");
      }
    })();
    return closing;
  };
  const retire = (): void => {
    void close().catch(() => undefined);
  };
  // Register retirement before the first asynchronous layer/client acquisition.
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(close);
  const assertLive = (): void => {
    if (retired || context.signal.aborted) throw new Error("HTTP MCP fixture retired.");
  };
  assertLive();
  const auth = await track(
    runtime.runPromise(Effect.service(ServerAuth), { signal: context.signal }),
  );
  assertLive();
  const issuer = await track(
    runtime.runPromise(Effect.service(SessionCredentialService), { signal: context.signal }),
  );
  assertLive();
  // Narrow service fixtures intentionally refuse unrelated operations. The
  // real router still selects every service and authenticates the actual token.
  const services = Context.make(ServerAuth, auth).pipe(
    Context.add(
      OrchestrationEngineService,
      dependencies.orchestrationEngine as OrchestrationEngineShape,
    ),
    Context.add(
      ProjectionSnapshotQuery,
      dependencies.projectionSnapshotQuery as ProjectionSnapshotQueryShape,
    ),
    Context.add(ProviderRegistry, dependencies.providerRegistry as ProviderRegistryShape),
    Context.add(ProviderService, dependencies.providerService as ProviderServiceShape),
    Context.add(ServerSettingsService, dependencies.serverSettings as ServerSettingsShape),
    Context.add(ServerRuntimeStartup, dependencies.startup as ServerRuntimeStartupShape),
    Context.add(WorkspacePaths, dependencies.workspacePaths as WorkspacePathsShape),
    Context.add(ScheduledFollowups, {} as ScheduledFollowupsShape),
  );
  const fetchRequest: typeof fetch = async (input, init) => {
    assertLive();
    const controller = new AbortController();
    requests.add(controller);
    const incoming = new Request(input, init);
    const signal = AbortSignal.any([incoming.signal, controller.signal]);
    try {
      return await track(app.handler(new Request(incoming, { signal }), services));
    } finally {
      requests.delete(controller);
    }
  };
  const connect = async (token: string, browserCookie?: string) => {
    assertLive();
    const client = new Client({ name: "synthetic-management-http-client", version: "1" });
    clients.add(client);
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: fetchRequest,
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`,
          ...(browserCookie ? { cookie: `${issuer.cookieName}=${browserCookie}` } : {}),
          "x-cafe-thread-id": otherThreadId,
          "x-cafe-provider-instance-id": "forged-instance",
        },
      },
    });
    await track(client.connect(transport as Parameters<Client["connect"]>[0]));
    assertLive();
    return client;
  };
  const issue = (input: Parameters<typeof issuer.issue>[0]) => {
    assertLive();
    return track(runtime.runPromise(issuer.issue(input), { signal: context.signal }));
  };
  const revoke = (id: Parameters<typeof issuer.revoke>[0]) =>
    track(runtime.runPromise(issuer.revoke(id), { signal: context.signal }));
  const raw = (token: string) =>
    fetchRequest("http://localhost/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "get_thread_usage",
          arguments: {},
        },
      }),
    });
  const call = (client: Client, input: Parameters<Client["callTool"]>[0]) =>
    track(client.callTool(input));
  const text = (response: Response) => track(response.text());
  return { issue, revoke, connect, raw, call, text, close };
}

describe("management usage HTTP ownership", () => {
  it("uses only signed launch context, requires explicit manual targets and rechecks revocation per request", async (context) => {
    const h = await harness(context);
    try {
      const launched = await h.issue({
        subject: "provider:cafe-management:synthetic",
        role: "owner",
        method: "bearer-session-token",
        managementLaunchContext: { threadId, providerInstanceId: instanceId, launchNonce },
      });
      // An identical signed subject is deliberately insufficient without the
      // actual internal claim. A valid competing browser cookie must also not
      // replace the bearer identity selected by the management HTTP endpoint.
      const manual = await h.issue({
        subject: "provider:cafe-management:synthetic",
        role: "owner",
        method: "bearer-session-token",
      });
      const browser = await h.issue({
        subject: "browser-owner",
        role: "owner",
        method: "browser-session-cookie",
      });
      const client = await h.connect(launched.token, browser.token);
      const current = await h.call(client, { name: "get_thread_usage", arguments: {} });
      expect(current.isError).not.toBe(true);
      expect(current.structuredContent).toMatchObject({
        threadId,
        target: {
          selection: "authenticated-launch",
          scope: "cafe-thread",
          launchMatchesSession: true,
        },
      });
      expect(JSON.stringify(current)).not.toContain(launchNonce);
      expect(JSON.stringify(current)).not.toContain(launched.token);
      expect(JSON.stringify(current)).not.toContain("PRIVATE_HTTP_THREAD_TITLE");

      const manualClient = await h.connect(manual.token, browser.token);
      expect(
        (await h.call(manualClient, { name: "get_thread_usage", arguments: {} })).isError,
      ).toBe(true);
      const explicit = await h.call(manualClient, {
        name: "get_thread_usage",
        arguments: { threadId: otherThreadId },
      });
      expect(explicit.isError).not.toBe(true);
      expect(explicit.structuredContent).toMatchObject({
        threadId: otherThreadId,
        target: { selection: "explicit", scope: "cafe-thread", launchMatchesSession: null },
      });

      await h.revoke(launched.sessionId);
      const revoked = await h.raw(launched.token);
      expect(revoked.status).toBe(401);
      expect(await h.text(revoked)).not.toContain(launched.token);
      const stillManual = await h.call(manualClient, {
        name: "get_thread_usage",
        arguments: { threadId },
      });
      expect(stillManual.isError).not.toBe(true);
      expect(stillManual.structuredContent).toMatchObject({
        threadId,
        target: { selection: "explicit" },
      });
    } finally {
      await h.close();
    }
  });
});
