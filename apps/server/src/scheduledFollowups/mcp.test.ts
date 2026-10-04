import {
  ProviderInstanceId,
  ThreadId,
  ScheduledFollowupError,
  type ScheduledFollowupRecord,
} from "@cafecode/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { registerScheduledFollowupTools, registerSessionSchedulingTools } from "./mcp.ts";
import type { SchedulingSessionAuthority } from "./sessionRuntime.ts";
import type { ScheduledFollowupsShape } from "./service.ts";

const input = {
  threadId: "scheduled-chat",
  name: "Check build",
  prompt: "Report changed build results.",
  recurrence: {
    kind: "interval",
    anchorAt: "2026-10-04T12:00:00.000Z",
    everyMinutes: 5,
    timeZone: "Asia/Tokyo",
  },
};

/** Exercise the real MCP wire schema, not a hand-invoked callback or provider. */
async function withClient<A>(
  test: (client: Client, service: ScheduledFollowupsShape) => Promise<A>,
  authority?: SchedulingSessionAuthority,
) {
  const service: ScheduledFollowupsShape = {
    save: vi.fn(() => Effect.succeed({ state: "pending_confirmation" } as ScheduledFollowupRecord)),
    list: vi.fn(() => Effect.succeed({ schedules: [], backendOnline: true as const })),
    setStatus: vi.fn(() => Effect.succeed({ state: "paused" } as ScheduledFollowupRecord)),
    runNow: vi.fn(() => Effect.die("MCP must not run schedules")),
    history: vi.fn(() => Effect.succeed({ runs: [], nextCursor: null })),
    notification: () => Effect.succeed({ notify: true }),
    tick: Effect.void,
    start: () => Effect.void,
  };
  const server = new McpServer({ name: "scheduled-fixture", version: "1" });
  if (authority) registerSessionSchedulingTools(server, service, authority);
  else registerScheduledFollowupTools(server, service);
  const client = new Client({ name: "owner-fixture", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await test(client, service);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("scheduled follow-up MCP authority", () => {
  it("exposes only propose, read and pause, never enable, run or report by public ID", async () =>
    withClient(async (client) => {
      const listing = await client.listTools();
      expect(listing.tools.map((tool) => tool.name).sort()).toEqual([
        "list_scheduled_followups",
        "pause_scheduled_followup",
        "request_scheduled_followup",
      ]);
      const response = await client.callTool({
        name: "report_scheduled_followup",
        arguments: { runId: "anything" },
      });
      expect(response.isError).toBe(true);
    }));
  it("always creates an agent proposal with conservative defaults", async () =>
    withClient(async (client, service) => {
      const response = await client.callTool({
        name: "request_scheduled_followup",
        arguments: input,
      });
      expect(response.isError).not.toBe(true);
      expect(service.save).toHaveBeenCalledExactlyOnceWith(
        {
          ...input,
          modelSelection: null,
          notificationPolicy: "changes-and-errors",
          endAt: null,
          maxRuns: null,
          allowAutoFinish: false,
        },
        "agent",
      );
      expect(service.runNow).not.toHaveBeenCalled();
    }));
  it("pins edit proposals to the exact owner-visible revision", async () =>
    withClient(async (client, service) => {
      const id = "be14727c-10a8-4f44-aa16-44f2b1cd4dbe";
      const response = await client.callTool({
        name: "request_scheduled_followup",
        arguments: { ...input, id, expectedRevision: 7 },
      });
      expect(response.isError).not.toBe(true);
      expect(service.save).toHaveBeenCalledWith(
        expect.objectContaining({ id, expectedRevision: 7 }),
        "agent",
      );
    }));
  it.each([
    { ...input, recurrence: { ...input.recurrence, everyMinutes: 0 } },
    { ...input, recurrence: { ...input.recurrence, timeZone: "not/a-zone" } },
    { ...input, id: "be14727c-10a8-4f44-aa16-44f2b1cd4dbe" },
    { ...input, prompt: "x".repeat(16001) },
  ])("rejects invalid or unbounded wire input before service mutation", async (invalid) =>
    withClient(async (client, service) => {
      const response = await client.callTool({
        name: "request_scheduled_followup",
        arguments: invalid,
      });
      expect(response.isError).toBe(true);
      expect(service.save).not.toHaveBeenCalled();
    }),
  );
  it("pauses only the exact requested chat, schedule and revision", async () =>
    withClient(async (client, service) => {
      const pause = {
        threadId: input.threadId,
        id: "be14727c-10a8-4f44-aa16-44f2b1cd4dbe",
        expectedRevision: 4,
      };
      await client.callTool({ name: "pause_scheduled_followup", arguments: pause });
      expect(service.setStatus).toHaveBeenCalledExactlyOnceWith({ ...pause, state: "paused" });
    }));
  it("does not expose provider/SQL errors or prompt contents on failures", async () =>
    withClient(async (client, service) => {
      vi.mocked(service.save).mockReturnValue(
        Effect.fail(new ScheduledFollowupError({ message: "private credential and prompt" })),
      );
      const response = await client.callTool({
        name: "request_scheduled_followup",
        arguments: input,
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).not.toContain("private credential");
      expect(JSON.stringify(response)).toContain("Review the schedule in Tasks");
    }));
});

const authority: SchedulingSessionAuthority = {
  threadId: ThreadId.make("session-chat"),
  providerInstanceId: ProviderInstanceId.make("second-codex-account"),
  sessionGeneration: "157f122c-77a1-4976-ab77-57bf3c6b6408",
  tokenDigest: "a".repeat(64),
};
const { threadId: _ownerThreadId, ...sessionInput } = input;
describe("automatic session scheduling MCP", () => {
  it("requires no chat/account arguments and binds all three tools to exact session authority", async () =>
    withClient(async (client, service) => {
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "list_scheduled_followups",
        "pause_scheduled_followup",
        "request_scheduled_followup",
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.inputSchema.properties).not.toHaveProperty("threadId");
        expect(tool.inputSchema.properties).not.toHaveProperty("providerInstanceId");
      }
      expect(
        (await client.callTool({ name: "request_scheduled_followup", arguments: sessionInput }))
          .isError,
      ).not.toBe(true);
      expect(service.save).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ threadId: authority.threadId, modelSelection: null }),
        "agent",
        authority,
      );
      await client.callTool({ name: "list_scheduled_followups", arguments: {} });
      expect(service.list).toHaveBeenCalledExactlyOnceWith(
        { threadId: authority.threadId },
        authority,
      );
      const pause = { id: "be14727c-10a8-4f44-aa16-44f2b1cd4dbe", expectedRevision: 2 };
      await client.callTool({ name: "pause_scheduled_followup", arguments: pause });
      expect(service.setStatus).toHaveBeenCalledExactlyOnceWith(
        { ...pause, threadId: authority.threadId, state: "paused" },
        authority,
      );
      expect(service.runNow).not.toHaveBeenCalled();
      expect(JSON.stringify(tools)).not.toContain(authority.tokenDigest);
    }, authority));
  it.each(["threadId", "providerInstanceId", "modelSelection", "state", "sessionGeneration"])(
    "rejects a model-supplied %s instead of silently redirecting it",
    async (field) =>
      withClient(async (client, service) => {
        expect(
          (
            await client.callTool({
              name: "request_scheduled_followup",
              arguments: { ...sessionInput, [field]: "foreign" },
            })
          ).isError,
        ).toBe(true);
        expect(
          (
            await client.callTool({
              name: "list_scheduled_followups",
              arguments: { [field]: "foreign" },
            })
          ).isError,
        ).toBe(true);
        expect(
          (
            await client.callTool({
              name: "pause_scheduled_followup",
              arguments: {
                id: "be14727c-10a8-4f44-aa16-44f2b1cd4dbe",
                expectedRevision: 2,
                [field]: "foreign",
              },
            })
          ).isError,
        ).toBe(true);
        expect(service.save).not.toHaveBeenCalled();
        expect(service.list).not.toHaveBeenCalled();
        expect(service.setStatus).not.toHaveBeenCalled();
      }, authority),
  );
  it("does not disclose retired-session details or SQL failures", async () =>
    withClient(async (client, service) => {
      vi.mocked(service.list).mockReturnValue(
        Effect.fail(new ScheduledFollowupError({ message: "private token or SQL" })),
      );
      const response = await client.callTool({ name: "list_scheduled_followups", arguments: {} });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).not.toContain("private token");
    }, authority));
});
