import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
  type ServerSettings,
} from "@cafecode/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  CAFE_MCP_RESTART_DELAY_MS,
  makeCafeMcpServer,
  type CafeMcpDependencies,
} from "./CafeMcpServer.ts";

const now = "2026-08-12T12:00:00.000Z";
const projectId = ProjectId.make("project-one");
const threadId = ThreadId.make("thread-one");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");

const project: OrchestrationProject = {
  id: projectId,
  title: "Cafe Code",
  workspaceRoot: "/workspace/cafe-code",
  additionalWorkspaceRoots: [],
  defaultModelSelection: { instanceId, model: "gpt-5.6-sol" },
  scripts: [],
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

const thread: OrchestrationThread = {
  id: threadId,
  projectId,
  title: "MCP work",
  modelSelection: { instanceId, model: "gpt-5.6-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  messages: [
    {
      id: MessageId.make("message-one"),
      role: "user",
      text: "Inspect the MCP design.",
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
  goal: null,
};

const snapshot: OrchestrationReadModel = {
  snapshotSequence: 1,
  projects: [project],
  threads: [thread],
  updatedAt: now,
};

const threadShell: OrchestrationThreadShell = {
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  modelSelection: thread.modelSelection,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  latestTurn: thread.latestTurn,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  archivedAt: thread.archivedAt,
  deletedAt: thread.deletedAt,
  session: thread.session,
  latestUserMessageAt: now,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const provider: ServerProvider = {
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  availability: "available",
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

function makeDependencies(input?: {
  readonly settings?: ServerSettings;
  readonly dispatched?: Array<
    Parameters<CafeMcpDependencies["orchestrationEngine"]["dispatch"]>[0]
  >;
}): CafeMcpDependencies {
  const dispatched = input?.dispatched ?? [];
  const settings = input?.settings ?? DEFAULT_SERVER_SETTINGS;
  return {
    orchestrationEngine: {
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
    },
    projectionSnapshotQuery: {
      getSnapshot: () => Effect.succeed(snapshot),
      getShellSnapshot: () => Effect.succeed({ ...snapshot, threads: [threadShell] }),
      getArchivedShellSnapshot: () => Effect.succeed({ ...snapshot, threads: [] }),
      getDeletedShellSnapshot: () => Effect.succeed({ ...snapshot, threads: [] }),
      getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
        Effect.succeed(
          workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
        ),
      getProjectShellById: (requestedProjectId) =>
        Effect.succeed(requestedProjectId === projectId ? Option.some(project) : Option.none()),
      getThreadDetailById: (requestedThreadId) =>
        Effect.succeed(requestedThreadId === threadId ? Option.some(thread) : Option.none()),
      getThreadShellById: (requestedThreadId) =>
        Effect.succeed(requestedThreadId === threadId ? Option.some(threadShell) : Option.none()),
    },
    providerRegistry: {
      getProviders: Effect.succeed([provider]),
      refreshInstance: () => Effect.succeed([provider]),
    },
    providerService: {
      getInstanceInfo: () =>
        Effect.succeed({
          instanceId,
          driverKind: driver,
          displayName: undefined,
          enabled: true,
          continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
        }),
      listSessions: () => Effect.succeed([]),
      restartProviderRuntime: () =>
        Effect.succeed({
          instanceId,
          provider: driver,
          stoppedSessionCount: 0,
        }),
    },
    serverSettings: {
      getSettings: Effect.succeed(settings),
      updateSettings: () => Effect.succeed(settings),
    },
    startup: {
      enqueueCommand: (effect) => effect,
    },
    workspacePaths: {
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    },
  };
}

async function withClient<A>(
  dependencies: CafeMcpDependencies,
  run: (client: Client) => Promise<A>,
  options?: Parameters<typeof makeCafeMcpServer>[1],
): Promise<A> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = makeCafeMcpServer(dependencies, options);
  const client = new Client({ name: "cafe-mcp-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("Cafe Code MCP server", () => {
  it("advertises focused tools with accurate safety annotations", async () => {
    const tools = await withClient(makeDependencies(), (client) => client.listTools());

    expect(tools.tools.find((tool) => tool.name === "list_projects")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools.tools.find((tool) => tool.name === "delete_project")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "create_project",
        "create_thread",
        "send_message",
        "set_provider_settings",
        "restart_provider",
        "restart_provider_and_resume",
      ]),
    );
  });

  it("creates threads with project provider defaults and sends durable messages", async () => {
    const dispatched: Array<Parameters<CafeMcpDependencies["orchestrationEngine"]["dispatch"]>[0]> =
      [];
    await withClient(makeDependencies({ dispatched }), async (client) => {
      const created = await client.callTool({
        name: "create_thread",
        arguments: { projectId, title: "Controlled by MCP" },
      });
      expect(created.isError).not.toBe(true);

      const sent = await client.callTool({
        name: "send_message",
        arguments: { threadId, message: "Continue the implementation." },
      });
      expect(sent.isError).not.toBe(true);
    });

    expect(dispatched[0]).toMatchObject({
      type: "thread.create",
      projectId,
      title: "Controlled by MCP",
      modelSelection: { instanceId, model: "gpt-5.6-sol" },
    });
    expect(dispatched[1]).toMatchObject({
      type: "thread.turn.start",
      threadId,
      message: { role: "user", text: "Continue the implementation.", attachments: [] },
    });
  });

  it("redacts provider secrets from tool results", async () => {
    const secretSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver,
          config: { binaryPath: "/usr/bin/codex" },
          environment: [{ name: "OPENAI_API_KEY", value: "secret-value", sensitive: true }],
        },
      },
    };

    const result = await withClient(makeDependencies({ settings: secretSettings }), (client) =>
      client.callTool({
        name: "get_provider_settings",
        arguments: { instanceId },
      }),
    );
    expect(JSON.stringify(result.structuredContent)).not.toContain("secret-value");
    expect(result.structuredContent).toMatchObject({
      instanceId,
      settings: {
        environment: [{ name: "OPENAI_API_KEY", value: "", sensitive: true, valueRedacted: true }],
      },
    });
  });

  it("acknowledges self-restarts before scheduling provider teardown", async () => {
    const scheduled: Array<Effect.Effect<void, never, unknown>> = [];
    const result = await withClient(
      makeDependencies(),
      (client) =>
        client.callTool({
          name: "restart_provider_and_resume",
          arguments: { instanceId, resumeMessage: "Resume exactly where you stopped." },
        }),
      { scheduleRestart: (job) => scheduled.push(job) },
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      instanceId,
      scheduled: true,
      resumeActiveSessions: true,
      delayMs: CAFE_MCP_RESTART_DELAY_MS,
    });
    expect(scheduled).toHaveLength(1);
  });
});
