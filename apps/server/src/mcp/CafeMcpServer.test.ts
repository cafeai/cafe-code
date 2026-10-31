import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ServerProvider,
  type ServerSettings,
} from "@cafecode/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "@effect/vitest";
import type { TestContext } from "vitest";
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
  readonly threads?: ReadonlyArray<OrchestrationThread>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly contexts?: ReadonlyMap<ThreadId, OrchestrationThreadActivity>;
  readonly dispatched?: Array<
    Parameters<CafeMcpDependencies["orchestrationEngine"]["dispatch"]>[0]
  >;
}): CafeMcpDependencies {
  const dispatched = input?.dispatched ?? [];
  const settings = input?.settings ?? DEFAULT_SERVER_SETTINGS;
  const threads = input?.threads ?? [thread];
  const providers = input?.providers ?? [provider];
  const shell = (value: OrchestrationThread): OrchestrationThreadShell => ({
    ...threadShell,
    id: value.id,
    projectId: value.projectId,
    title: value.title,
    modelSelection: value.modelSelection,
    latestTurn: value.latestTurn,
    session: value.session,
  });
  return {
    orchestrationEngine: {
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
    },
    projectionSnapshotQuery: {
      getSnapshot: () => Effect.succeed({ ...snapshot, threads }),
      getShellSnapshot: () => Effect.succeed({ ...snapshot, threads: threads.map(shell) }),
      getArchivedShellSnapshot: () => Effect.succeed({ ...snapshot, threads: [] }),
      getDeletedShellSnapshot: () => Effect.succeed({ ...snapshot, threads: [] }),
      getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
        Effect.succeed(
          workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
        ),
      getProjectShellById: (requestedProjectId) =>
        Effect.succeed(requestedProjectId === projectId ? Option.some(project) : Option.none()),
      getThreadDetailById: (requestedThreadId) =>
        Effect.succeed(
          Option.fromUndefinedOr(threads.find((value) => value.id === requestedThreadId)),
        ),
      getThreadShellById: (requestedThreadId) =>
        Effect.succeed(
          Option.map(
            Option.fromUndefinedOr(threads.find((value) => value.id === requestedThreadId)),
            shell,
          ),
        ),
      getThreadContextWindowActivity: (requestedThreadId) =>
        Effect.succeed(Option.fromUndefinedOr(input?.contexts?.get(requestedThreadId))),
    },
    providerRegistry: {
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
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
  context: TestContext,
  dependencies: CafeMcpDependencies,
  run: (client: Client) => Promise<A>,
  options?: Parameters<typeof makeCafeMcpServer>[1],
): Promise<A> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = makeCafeMcpServer(dependencies, options);
  const client = new Client({ name: "cafe-mcp-test", version: "1.0.0" });
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
      const first = await Promise.allSettled([client.close(), server.close()]);
      await Promise.allSettled([...pending]);
      // A connection may have completed after retirement's first close.
      const last = await Promise.allSettled([client.close(), server.close()]);
      context.signal.removeEventListener("abort", retire);
      if ([...first, ...last].some((result) => result.status === "rejected")) {
        throw new Error("MCP fixture cleanup failed.");
      }
    })();
    return closing;
  };
  const retire = (): void => {
    void close().catch(() => undefined);
  };
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(close);
  const assertLive = (): void => {
    if (retired || context.signal.aborted) throw new Error("MCP fixture retired.");
  };
  try {
    assertLive();
    await track(server.connect(serverTransport));
    assertLive();
    await track(client.connect(clientTransport));
    assertLive();
    return await track(run(client));
  } finally {
    await close();
  }
}

const actualInstanceId = ProviderInstanceId.make("codex_actual");
const selectedInstanceId = ProviderInstanceId.make("codex_next");
const secondThreadId = ThreadId.make("thread-two");
const launchNonce = "c3939e16-8c99-4eea-a496-06496baf0324";

function usageThread(id: ThreadId = threadId): OrchestrationThread {
  return {
    ...thread,
    id,
    title: "PRIVATE_THREAD_TITLE",
    modelSelection: { instanceId: selectedInstanceId, model: "next-turn-model" },
    session: {
      threadId: id,
      providerInstanceId: actualInstanceId,
      providerName: "codex",
      status: "running",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "PRIVATE_PROVIDER_ERROR",
      updatedAt: now,
    },
  };
}

function contextActivity(usedTokens: number): OrchestrationThreadActivity {
  return {
    id: EventId.make("context-observation"),
    tone: "info",
    kind: "context-window.updated",
    summary: "PRIVATE_ACTIVITY_SUMMARY",
    turnId: null,
    createdAt: now,
    payload: {
      usedTokens,
      maxTokens: 800_000,
      totalProcessedTokens: 1_200_000,
      compactsAutomatically: true,
      autoCompactTokenLimit: 720_000,
      privateHistoryCursor: "PRIVATE_NATIVE_CURSOR",
      rawProviderText: "PRIVATE_ACTIVITY_PAYLOAD",
    },
  };
}

const usageProvider: ServerProvider = {
  ...provider,
  instanceId: actualInstanceId,
  auth: {
    status: "authenticated",
    email: "PRIVATE_ACCOUNT_EMAIL@example.invalid",
    label: "PRIVATE_ACCOUNT_LABEL",
  },
  message: "PRIVATE_PROVIDER_MESSAGE",
  accountRateLimits: {
    checkedAt: now,
    rateLimitResetCredits: { availableCount: 3 },
    rateLimits: {
      limitId: "codex",
      limitName: "Codex plan",
      normalModelSlug: "gpt-6.1-sol",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_793_300_400 },
      secondary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_793_900_000 },
      credits: { hasCredits: true, unlimited: false, balance: "123.00" },
    },
  },
};

/** A successful usage read must remain possible while every consequential or
 * provider-opening path refuses. These guards protect public read-only behavior,
 * not an internal count/order of metadata method calls. */
function passiveDependencies(input: Parameters<typeof makeDependencies>[0]): CafeMcpDependencies {
  const dependencies = makeDependencies(input);
  return {
    ...dependencies,
    projectionSnapshotQuery: {
      ...dependencies.projectionSnapshotQuery,
      getThreadDetailById: () => Effect.die("Usage must not load a transcript."),
    },
    providerRegistry: {
      ...dependencies.providerRegistry,
      refreshInstance: () => Effect.die("Usage must not refresh a provider."),
    },
    providerService: {
      ...dependencies.providerService,
      getInstanceInfo: () => Effect.die("Usage must not resolve a native provider."),
      listSessions: () => Effect.die("Usage must not touch native session ownership."),
      restartProviderRuntime: () => Effect.die("Usage must not restart a provider."),
    },
    startup: { enqueueCommand: () => Effect.die("Usage must not enqueue work.") },
  };
}

describe("Cafe Code MCP server", () => {
  it("advertises focused tools with accurate safety annotations", async (context) => {
    const tools = await withClient(context, makeDependencies(), (client) => client.listTools());

    expect(tools.tools.find((tool) => tool.name === "list_projects")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools.tools.find((tool) => tool.name === "get_thread_usage")?.annotations).toMatchObject(
      {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    );
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
    // Cafe's owner credential must not discover the separate desktop catalog.
    expect(tools.tools.some((tool) => tool.name.startsWith("desktop_"))).toBe(false);
  });

  it.for([
    { limit: 0, expectedIds: [] },
    { limit: 1, expectedIds: ["bounded-message-21"] },
    {
      limit: undefined,
      expectedIds: Array.from({ length: 20 }, (_, index) => `bounded-message-${index + 2}`),
    },
  ])(
    "bounds get_thread message output for limit $limit",
    async ({ limit, expectedIds }, context) => {
      const messages = Array.from({ length: 21 }, (_, index) => ({
        ...thread.messages[0]!,
        id: MessageId.make(`bounded-message-${index + 1}`),
        text: `PRIVATE_BODY_${index + 1}_END`,
      }));
      const result = await withClient(
        context,
        makeDependencies({ threads: [{ ...thread, messages }] }),
        (client) =>
          client.callTool({
            name: "get_thread",
            arguments: { threadId, ...(limit === undefined ? {} : { messageLimit: limit }) },
          }),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        messages: expectedIds.map((id) => ({ id })),
      });
      for (const message of messages) {
        if (!expectedIds.includes(message.id))
          expect(JSON.stringify(result)).not.toContain(message.text);
      }
    },
  );

  it("reads only metadata for its authenticated launch chat using the actual session account", async (context) => {
    const dispatched: Array<Parameters<CafeMcpDependencies["orchestrationEngine"]["dispatch"]>[0]> =
      [];
    const result = await withClient(
      context,
      passiveDependencies({
        threads: [usageThread()],
        providers: [
          {
            ...usageProvider,
            instanceId: selectedInstanceId,
            accountRateLimits: {
              checkedAt: now,
              rateLimits: { primary: { usedPercent: 99 } },
            },
          },
          usageProvider,
        ],
        contexts: new Map([[threadId, contextActivity(240_000)]]),
        dispatched,
      }),
      (client) => client.callTool({ name: "get_thread_usage", arguments: {} }),
      { managementLaunchContext: { threadId, providerInstanceId: actualInstanceId, launchNonce } },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      threadId,
      target: {
        selection: "authenticated-launch",
        scope: "cafe-thread",
        launchMatchesSession: true,
      },
      provider: { instanceId: actualInstanceId, driver: "codex", source: "session" },
      context: {
        status: "reported",
        scope: "cafe-thread",
        observedAt: now,
        ownerAttribution: "not-recorded",
        usedTokens: 240_000,
        maxTokens: 800_000,
        remainingTokens: 560_000,
        usedPercent: 30,
        totalProcessedTokens: 1_200_000,
        compactsAutomatically: true,
        autoCompactTokenLimit: 720_000,
      },
      quota: {
        status: "reported",
        scope: "provider-account",
        providerInstanceId: actualInstanceId,
        checkedAt: now,
        limits: [
          {
            limitId: "codex",
            limitName: "Codex plan",
            normalModelSlug: "gpt-6.1-sol",
            primary: {
              usedPercent: 25,
              remainingPercent: 75,
              windowDurationMins: 300,
              resetsAtEpochSeconds: 1_793_300_400,
            },
            secondary: {
              usedPercent: 10,
              remainingPercent: 90,
              windowDurationMins: 10_080,
              resetsAtEpochSeconds: 1_793_900_000,
            },
            credits: { hasCredits: true, unlimited: false, balance: "123.00" },
          },
        ],
        availableResetCount: 3,
        truncated: false,
      },
    });
    for (const secret of [
      "Inspect the MCP design.",
      "PRIVATE_THREAD_TITLE",
      "PRIVATE_PROVIDER_ERROR",
      "PRIVATE_ACTIVITY_SUMMARY",
      "PRIVATE_NATIVE_CURSOR",
      "PRIVATE_ACTIVITY_PAYLOAD",
      "PRIVATE_ACCOUNT_EMAIL",
      "PRIVATE_ACCOUNT_LABEL",
      "PRIVATE_PROVIDER_MESSAGE",
      launchNonce,
    ])
      expect(JSON.stringify(result)).not.toContain(secret);
    expect(dispatched).toEqual([]);
  });

  it("requires an explicit thread for manual connections and preserves distinct context with account-shared quota", async (context) => {
    await withClient(
      context,
      passiveDependencies({
        threads: [usageThread(), usageThread(secondThreadId)],
        providers: [usageProvider],
        contexts: new Map([
          [threadId, contextActivity(240_000)],
          [secondThreadId, contextActivity(100_000)],
        ]),
      }),
      async (client) => {
        expect((await client.callTool({ name: "get_thread_usage", arguments: {} })).isError).toBe(
          true,
        );
        for (const [id, usedTokens] of [
          [threadId, 240_000],
          [secondThreadId, 100_000],
        ] as const) {
          const result = await client.callTool({
            name: "get_thread_usage",
            arguments: { threadId: id },
          });
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toMatchObject({
            threadId: id,
            target: { selection: "explicit", scope: "cafe-thread", launchMatchesSession: null },
            context: { usedTokens, ownerAttribution: "not-recorded", observedAt: now },
            quota: {
              scope: "provider-account",
              providerInstanceId: actualInstanceId,
              limits: [{ primary: { usedPercent: 25, remainingPercent: 75 } }],
            },
          });
        }
        expect(
          (
            await client.callTool({
              name: "get_thread_usage",
              arguments: { threadId: "missing-thread" },
            })
          ).isError,
        ).toBe(true);
      },
    );
  });

  it("keeps missing reports unknown and does not borrow quota from a selected or unauthenticated account", async (context) => {
    await withClient(
      context,
      passiveDependencies({
        threads: [usageThread()],
        providers: [
          { ...usageProvider, auth: { status: "unauthenticated" } },
          { ...usageProvider, instanceId: selectedInstanceId },
        ],
      }),
      async (client) => {
        const result = await client.callTool({ name: "get_thread_usage", arguments: {} });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          target: { selection: "authenticated-launch", launchMatchesSession: false },
          provider: { instanceId: actualInstanceId, source: "session" },
          context: {
            status: "unknown",
            observedAt: null,
            ownerAttribution: "not-recorded",
            usedTokens: null,
            maxTokens: null,
            remainingTokens: null,
            usedPercent: null,
            totalProcessedTokens: null,
            compactsAutomatically: null,
            autoCompactTokenLimit: null,
          },
          quota: {
            status: "unknown",
            providerInstanceId: actualInstanceId,
            checkedAt: null,
            limits: [],
            availableResetCount: null,
            truncated: false,
          },
        });
      },
      {
        managementLaunchContext: { threadId, providerInstanceId: selectedInstanceId, launchNonce },
      },
    );
  });

  it("returns a fixed usage failure without exposing dependency errors", async (context) => {
    const dependencies = passiveDependencies({ threads: [usageThread()] });
    const result = await withClient(
      context,
      {
        ...dependencies,
        projectionSnapshotQuery: {
          ...dependencies.projectionSnapshotQuery,
          getThreadContextWindowActivity: () =>
            Effect.die("PRIVATE_DATABASE_ERROR /private/path key=secret"),
        },
      },
      (client) => client.callTool({ name: "get_thread_usage", arguments: { threadId } }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Unable to read thread usage metadata.");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_DATABASE_ERROR");
    expect(JSON.stringify(result)).not.toContain("/private/path");
    expect(JSON.stringify(result)).not.toContain("key=secret");
  });

  it("creates threads with project provider defaults and sends durable messages", async (context) => {
    const dispatched: Array<Parameters<CafeMcpDependencies["orchestrationEngine"]["dispatch"]>[0]> =
      [];
    await withClient(context, makeDependencies({ dispatched }), async (client) => {
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

  it.for([undefined, "approval-required", "auto-accept-edits", "full-access"] as const)(
    "creates and detaches standalone chats with no project lookup and access mode %s",
    async (runtimeMode, context) => {
      const dispatched: Array<
        Parameters<CafeMcpDependencies["orchestrationEngine"]["dispatch"]>[0]
      > = [];
      const dependencies = makeDependencies({ dispatched });
      const projectLookup = vi.fn(dependencies.projectionSnapshotQuery.getProjectShellById);
      await withClient(
        context,
        {
          ...dependencies,
          projectionSnapshotQuery: {
            ...dependencies.projectionSnapshotQuery,
            getProjectShellById: projectLookup,
          },
        },
        async (client) => {
          expect(
            (
              await client.callTool({
                name: "create_thread",
                arguments: { title: "Standalone", ...(runtimeMode ? { runtimeMode } : {}) },
              })
            ).isError,
          ).not.toBe(true);
          expect(
            (
              await client.callTool({
                name: "update_thread",
                arguments: { threadId, projectId: null },
              })
            ).isError,
          ).not.toBe(true);
        },
      );
      expect(projectLookup).not.toHaveBeenCalled();
      expect(dispatched[0]).toMatchObject({
        type: "thread.create",
        projectId: null,
        runtimeMode: runtimeMode ?? "full-access",
        branch: null,
        worktreePath: null,
      });
      expect(dispatched[1]).toMatchObject({ type: "thread.meta.update", projectId: null });
    },
  );

  it("redacts provider secrets from tool results", async (context) => {
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

    const result = await withClient(
      context,
      makeDependencies({ settings: secretSettings }),
      (client) =>
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

  it("acknowledges self-restarts before scheduling provider teardown", async (context) => {
    const scheduled: Array<Effect.Effect<void>> = [];
    const result = await withClient(
      context,
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
