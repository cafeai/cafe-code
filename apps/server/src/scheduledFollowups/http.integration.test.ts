import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProviderInstanceId, ScheduledFollowupError, ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";
import { ServerConfig } from "../config.ts";
import { readBridgeConnection } from "../mcp/localBridge.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { handleSchedulingMcpRequest } from "./http.ts";
import { ScheduledFollowups, type ScheduledFollowupsShape } from "./service.ts";
import {
  installSchedulingSessionRuntime,
  makeSchedulingSessionRuntime,
  requireSchedulingSessionAuthority,
  type SchedulingSessionAuthority,
  type SchedulingSessionBinding,
  type SchedulingSessionBroker,
} from "./sessionRuntime.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Real SDK client and stateless HTTP server transports, real private capability
 * publication and migrated SQLite fences. Fetch delivers Web Requests directly
 * to the handler: no native server, provider, owner auth, configuration files or
 * network credentials are needed to exercise the production HTTP boundary. */
async function harness() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cafe-scheduling-http-")));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const bridgeSource = path.join(root, "fixture.mjs");
  await fs.writeFile(bridgeSource, "// Synthetic bridge fixture; never executed.\n");
  const effects = ManagedRuntime.make(SqlitePersistenceMemory);
  cleanups.push(() => effects.dispose());
  const sql = await effects.runPromise(Effect.service(SqlClient.SqlClient));
  const runtime = await effects.runPromise(
    makeSchedulingSessionRuntime({ bridgeSource, mcpPort: 12345 }),
  );
  cleanups.push(runtime.close);
  const uninstall = installSchedulingSessionRuntime(runtime);
  cleanups.push(async () => uninstall());
  const calls: Array<{ threadId: ThreadId; account: ProviderInstanceId }> = [];
  const service: ScheduledFollowupsShape = {
    list: (input, authority) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (!authority || authority.threadId !== input.threadId)
              return yield* new ScheduledFollowupError({
                message: "Missing synthetic session binding.",
              });
            yield* requireSchedulingSessionAuthority(sql, authority);
            calls.push({ threadId: input.threadId, account: authority.providerInstanceId });
            return { schedules: [], backendOnline: true as const };
          }),
        )
        .pipe(
          Effect.mapError(
            () => new ScheduledFollowupError({ message: "Synthetic scheduling access denied." }),
          ),
        ),
    save: () => Effect.die("This HTTP fixture does not submit scheduled work."),
    setStatus: () => Effect.die("This HTTP fixture does not change scheduled work."),
    runNow: () => Effect.die("Internal MCP must not run schedules."),
    history: () => Effect.die("Internal MCP does not expose history."),
    notification: () => Effect.die("HTTP discovery cannot emit notifications."),
    tick: Effect.die("HTTP discovery cannot run the scheduler."),
    start: () => Effect.die("HTTP discovery cannot start the scheduler."),
  };
  const fetchRequest: typeof fetch = async (input, init) => {
    const request = HttpServerRequest.fromWeb(new Request(input, init)).modify({
      remoteAddress: Option.some("127.0.0.1"),
    });
    const response = await effects.runPromise(
      handleSchedulingMcpRequest.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        // Only providerDaemon/providerSupervisor are read; omitted fields select
        // the directly installed runtime. No ServerAuth layer is supplied.
        Effect.provideService(ServerConfig, {} as never),
        Effect.provideService(ScheduledFollowups, service),
      ),
    );
    return HttpServerResponse.toWeb(response);
  };
  const raw = async (token: string) =>
    fetchRequest("http://127.0.0.1:12345/mcp/scheduling", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
  const connect = async (binding: SchedulingSessionBinding) => {
    const { token } = await readBridgeConnection(binding.launch.args[1]!, "cafe-scheduling");
    const client = new Client({ name: "isolated-http-client", version: "1" });
    cleanups.push(() => client.close());
    const transport = new StreamableHTTPClientTransport(
      new URL("http://127.0.0.1:12345/mcp/scheduling"),
      {
        fetch: fetchRequest,
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      },
    );
    // SDK 1.29 models the sessionId getter as string|undefined and its shared
    // Transport interface as optional string; runtime semantics are identical.
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    return { client, token };
  };
  const bind = (input: Parameters<SchedulingSessionBroker["bind"]>[0]) => runtime.bind(input);
  return { bind, connect, raw, runtime, calls, sql, effects };
}

describe("automatic scheduling MCP HTTP integration", () => {
  it.each([
    { provider: "codex" as const, account: "codex" },
    { provider: "codex" as const, account: "codex_work" },
    { provider: "claudeAgent" as const, account: "claude_private" },
    { provider: "grok" as const, account: "grok" },
  ])(
    "discovers and binds tools for $account without installer or owner authentication",
    async ({ provider, account }) => {
      const h = await harness();
      const identity = {
        threadId: ThreadId.make(`chat-${account}`),
        providerInstanceId: ProviderInstanceId.make(account),
        provider,
      };
      const binding = await h.bind(identity);
      const { client, token } = await h.connect(binding);
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name).toSorted()).toEqual([
        "list_scheduled_followups",
        "pause_scheduled_followup",
        "request_scheduled_followup",
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.properties).not.toHaveProperty("threadId");
        expect(tool.inputSchema.properties).not.toHaveProperty("providerInstanceId");
        expect(tool.inputSchema.properties).not.toHaveProperty("token");
      }
      // Pending initialization may read the catalog, but not even a schedule list.
      expect(
        (await client.callTool({ name: "list_scheduled_followups", arguments: {} })).isError,
      ).toBe(true);
      expect(h.calls).toEqual([]);
      await binding.activate();
      expect(
        (await client.callTool({ name: "list_scheduled_followups", arguments: {} })).isError,
      ).not.toBe(true);
      expect(h.calls).toEqual([
        { threadId: identity.threadId, account: identity.providerInstanceId },
      ]);
      expect(
        (
          await client.callTool({
            name: "list_scheduled_followups",
            arguments: { threadId: "foreign-chat" },
          })
        ).isError,
      ).toBe(true);
      expect(h.calls).toHaveLength(1);
      const unknown = await client.callTool({ name: "resume_scheduled_followup", arguments: {} });
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unknown)).not.toContain(token);
      await binding.dispose();
      const revoked = await h.raw(token);
      expect(revoked.status).toBe(403);
      expect(await revoked.text()).not.toContain(token);
    },
  );

  it("rejects foreign and retired HTTP tokens while preserving simultaneous account bindings", async () => {
    const h = await harness();
    const personalIdentity = {
      threadId: ThreadId.make("personal-chat"),
      providerInstanceId: ProviderInstanceId.make("codex_personal"),
      provider: "codex" as const,
    };
    const personal = await h.bind(personalIdentity);
    await personal.activate();
    const p = await h.connect(personal);
    const work = await h.bind({
      threadId: ThreadId.make("work-chat"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      provider: "codex",
    });
    await work.activate();
    const w = await h.connect(work);
    await p.client.callTool({ name: "list_scheduled_followups", arguments: {} });
    await w.client.callTool({ name: "list_scheduled_followups", arguments: {} });
    expect(h.calls.map((call) => call.account)).toEqual(["codex_personal", "codex_work"]);
    for (const token of ["f".repeat(64), "owner-session-token", "g".repeat(64)]) {
      const response = await h.raw(token);
      expect(response.status).toBe(token === "f".repeat(64) ? 403 : 401);
      expect(await response.text()).not.toContain(token);
    }
    const replacement = await h.bind(personalIdentity);
    const newPersonal = await h.connect(replacement);
    await personal.dispose();
    await replacement.activate();
    const old = await h.raw(p.token);
    expect(old.status).toBe(403);
    await old.arrayBuffer();
    await newPersonal.client.callTool({ name: "list_scheduled_followups", arguments: {} });
    await w.client.callTool({ name: "list_scheduled_followups", arguments: {} });
    expect(h.calls.slice(-2).map((call) => call.account)).toEqual(["codex_personal", "codex_work"]);
    // A valid header authenticated earlier still cannot bypass a later SQL
    // retirement; the same HTTP transport exposes only the sanitized error.
    const claims: SchedulingSessionAuthority = await h.runtime.authorize(newPersonal.token);
    await h.effects.runPromise(
      h.sql`UPDATE scheduling_session_capabilities SET active = 0 WHERE session_generation = ${claims.sessionGeneration}`,
    );
    const rejected = await newPersonal.client.callTool({
      name: "list_scheduled_followups",
      arguments: {},
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).not.toContain(newPersonal.token);
  });
});
