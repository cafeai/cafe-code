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
      getThreadQuestionContextById: (requestedThreadId) =>
        Effect.succeed(
          Option.map(
            Option.fromUndefinedOr(threads.find((value) => value.id === requestedThreadId)),
            (value) => ({
              ...shell(value),
              activities: value.activities,
              pendingRequestRetentionTruncated: value.pendingRequestRetentionTruncated ?? false,
            }),
          ),
        ),
      getThreadAsyncQuestionActivitiesPage: ({
        threadId: requestedThreadId,
        limit = 20,
        before,
      }) => {
        const rows = (threads.find((value) => value.id === requestedThreadId)?.activities ?? [])
          .filter((activity) => activity.kind === "provider.async-questions")
          .filter(
            (activity) =>
              before === undefined ||
              activity.createdAt < before.createdAt ||
              (activity.createdAt === before.createdAt && activity.id < before.activityId),
          )
          .toSorted(
            (left, right) =>
              right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
          );
        const activities = rows.slice(0, limit);
        const last = activities.at(-1);
        const hasMore = rows.length > limit;
        return Effect.succeed({
          activities,
          hasMore,
          omittedCount: 0,
          nextCursor:
            hasMore && last
              ? { sequence: last.sequence ?? null, createdAt: last.createdAt, activityId: last.id }
              : null,
        });
      },
      getThreadAsyncQuestionActivity: ({ threadId: requestedThreadId, activityId }) =>
        Effect.succeed(
          Option.fromUndefinedOr(
            threads
              .find((value) => value.id === requestedThreadId)
              ?.activities.find(
                (activity) =>
                  activity.id === activityId && activity.kind === "provider.async-questions",
              ),
          ),
        ),
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

const callbackTarget = { kind: "callback", requestId: "question-request", createdAt: now } as const;
const inlineActivityId = EventId.make(`codex-async-questions:${"c".repeat(64)}`);
const inlineTarget = { kind: "async", activityId: inlineActivityId, questionIndex: 1 } as const;
const nativeQuestions = [
  {
    id: "route",
    header: "Route",
    question: "Which route should we use?",
    options: [{ label: "A", description: "Keep route A" }],
    multiSelect: false,
  },
  {
    id: "targets",
    header: "Targets",
    question: "Which platforms?",
    options: [
      { label: "Desktop", description: "Desktop app" },
      { label: "Server", description: "Headless server" },
    ],
    multiSelect: true,
  },
  {
    id: "followup",
    header: "Details",
    question: "Any additional context?",
    options: [],
    multiSelect: false,
  },
];

function nativeQuestionActivity(
  payload: Record<string, unknown> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make("native-question-activity"),
    kind: "user-input.requested",
    tone: "info",
    turnId: null,
    createdAt: now,
    sequence: 10,
    summary: "Provider question",
    payload: {
      requestId: callbackTarget.requestId,
      questions: nativeQuestions,
      supportsUnanswered: true,
      PRIVATE_PROVIDER_PAYLOAD: "do not expose",
      ...payload,
    },
  };
}

function inlineQuestionActivity(): OrchestrationThreadActivity {
  return {
    id: inlineActivityId,
    kind: "provider.async-questions",
    tone: "info",
    turnId: null,
    createdAt: now,
    sequence: 11,
    summary: "Inline questions",
    payload: {
      itemId: "PRIVATE_NATIVE_ITEM",
      questions: [
        { title: "Already handled?", options: ["Yes", "No"] },
        { title: "Which retained detail?", options: ["First", "Second"] },
      ],
      handledQuestionIndexes: [0],
      PRIVATE_PROVIDER_PAYLOAD: "do not expose",
    },
  };
}

function questionThread(
  activities: OrchestrationThreadActivity[] = [nativeQuestionActivity(), inlineQuestionActivity()],
): OrchestrationThread {
  return { ...thread, activities, pendingRequestRetentionTruncated: false };
}

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
    expect(
      tools.tools.find((tool) => tool.name === "get_thread_question")?.annotations,
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(
      tools.tools.find((tool) => tool.name === "clear_thread_question")?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
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

  it("lists pending questions and reads their exact details without approval or transcript payloads", async (context) => {
    const resolved = {
      ...nativeQuestionActivity({ requestId: "settled-request" }),
      id: EventId.make("settled-request-activity"),
      sequence: 1,
    };
    const resolution: OrchestrationThreadActivity = {
      id: EventId.make("settled-resolution"),
      tone: "info",
      kind: "user-input.resolved",
      summary: "Resolved",
      createdAt: now,
      turnId: null,
      sequence: 2,
      payload: { requestId: "settled-request" },
    };
    // Legacy rows can share time and omit a sequence. Terminal resolution
    // must beat the opposite opaque-ID order and shuffled hydration order.
    const { sequence: _legacySequence, ...legacyBase } = nativeQuestionActivity({
      requestId: "legacy-settled",
    });
    const legacyRequest = { ...legacyBase, id: EventId.make("z-legacy-request") };
    const { sequence: _resolutionSequence, ...legacyResolvedBase } = resolution;
    const legacyResolution = {
      ...legacyResolvedBase,
      id: EventId.make("a-legacy-resolution"),
      payload: { requestId: "legacy-settled" },
    };
    const approval: OrchestrationThreadActivity = {
      id: EventId.make("approval-only"),
      tone: "approval",
      kind: "approval.requested",
      summary: "PRIVATE_APPROVAL_SUMMARY",
      createdAt: now,
      turnId: null,
      sequence: 12,
      payload: { requestId: "approval-only", detail: "PRIVATE_APPROVAL_COMMAND" },
    };
    const dependencies = passiveDependencies({
      threads: [
        questionThread([
          legacyResolution,
          resolved,
          resolution,
          nativeQuestionActivity(),
          inlineQuestionActivity(),
          approval,
          legacyRequest,
        ]),
      ],
    });
    await withClient(context, dependencies, async (client) => {
      const listed = await client.callTool({
        name: "list_thread_questions",
        arguments: { threadId },
      });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toMatchObject({
        threadId,
        nativePendingRequestCount: 1,
        asyncPendingQuestionCount: 1,
        hasPendingQuestions: true,
        hasMore: false,
        nextCursor: null,
        omissions: { nativeRequests: false, asyncActivities: 0, unavailableAsyncActivities: 0 },
        questions: [
          {
            target: callbackTarget,
            questionCount: 3,
            canAnswer: true,
            canSkip: true,
            canClear: true,
          },
          { target: inlineTarget, questionCount: 1 },
        ],
      });
      for (const excluded of [
        "PRIVATE_APPROVAL_COMMAND",
        "PRIVATE_APPROVAL_SUMMARY",
        "PRIVATE_PROVIDER_PAYLOAD",
        "PRIVATE_NATIVE_ITEM",
        "settled-request",
        "legacy-settled",
        "Which route should we use?",
        "Inspect the MCP design.",
      ])
        expect(JSON.stringify(listed)).not.toContain(excluded);
      const callback = await client.callTool({
        name: "get_thread_question",
        arguments: { threadId, target: callbackTarget },
      });
      expect(callback.isError).not.toBe(true);
      expect(callback.structuredContent).toMatchObject({
        threadId,
        target: callbackTarget,
        detail: {
          kind: "callback",
          questions: [
            {
              id: "route",
              header: "Route",
              question: "Which route should we use?",
              options: [{ label: "A", description: "Keep route A" }],
              multiSelect: false,
            },
            {
              id: "targets",
              multiSelect: true,
              options: [
                { label: "Desktop", description: "Desktop app" },
                { label: "Server", description: "Headless server" },
              ],
            },
            { id: "followup", question: "Any additional context?", options: [] },
          ],
          supported: true,
          supportsUnanswered: true,
        },
      });
      const inline = await client.callTool({
        name: "get_thread_question",
        arguments: { threadId, target: inlineTarget },
      });
      expect(inline.isError).not.toBe(true);
      expect(inline.structuredContent).toMatchObject({
        target: inlineTarget,
        detail: { kind: "async", title: "Which retained detail?", options: ["First", "Second"] },
      });
      for (const output of [callback, inline])
        for (const excluded of [
          "PRIVATE_PROVIDER_PAYLOAD",
          "PRIVATE_NATIVE_ITEM",
          "PRIVATE_APPROVAL_COMMAND",
          "Inspect the MCP design.",
        ])
          expect(JSON.stringify(output)).not.toContain(excluded);
    });
  });

  it("keeps paginated or omitted empty question views unknown instead of claiming no pending work", async (context) => {
    const cursor = { sequence: 3, createdAt: now, activityId: EventId.make("page-anchor") };
    for (const row of [
      { nativeOmitted: false, omittedCount: 0, hasMore: false, before: undefined, expected: false },
      { nativeOmitted: true, omittedCount: 0, hasMore: false, before: undefined, expected: null },
      { nativeOmitted: false, omittedCount: 1, hasMore: false, before: undefined, expected: null },
      { nativeOmitted: false, omittedCount: 0, hasMore: true, before: undefined, expected: null },
      { nativeOmitted: false, omittedCount: 0, hasMore: false, before: cursor, expected: null },
    ]) {
      const value: OrchestrationThread = {
        ...thread,
        activities: [],
        ...(row.nativeOmitted !== undefined
          ? { pendingRequestRetentionTruncated: row.nativeOmitted }
          : {}),
      };
      const dependencies = makeDependencies({ threads: [value] });
      await withClient(
        context,
        {
          ...dependencies,
          projectionSnapshotQuery: {
            ...dependencies.projectionSnapshotQuery,
            getThreadAsyncQuestionActivitiesPage: () =>
              Effect.succeed({
                activities: [],
                hasMore: row.hasMore,
                nextCursor: row.hasMore ? cursor : null,
                omittedCount: row.omittedCount,
              }),
          },
        },
        async (client) => {
          const result = await client.callTool({
            name: "list_thread_questions",
            arguments: { threadId, ...(row.before ? { before: row.before } : {}) },
          });
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toMatchObject({
            hasPendingQuestions: row.expected,
            omissions: {
              nativeRequests: row.nativeOmitted ?? null,
              asyncActivities: row.omittedCount,
            },
          });
        },
      );
    }
  });

  it("submits a complete callback response without presenting its dispatch receipt as native resolution", async (context) => {
    const dispatched: Array<Parameters<CafeMcpDependencies["orchestrationEngine"]["dispatch"]>[0]> =
      [];
    await withClient(
      context,
      makeDependencies({ threads: [questionThread()], dispatched }),
      async (client) => {
        const answered = await client.callTool({
          name: "answer_thread_question",
          arguments: {
            threadId,
            target: callbackTarget,
            answers: { route: "A", targets: ["Desktop", "Server"] },
            unanswered: { followup: "skipped" },
          },
        });
        expect(answered.isError).not.toBe(true);
        expect(answered.structuredContent).toMatchObject({
          accepted: true,
          resolution: "provider-confirmation-required",
          sequence: 1,
        });
        const listed = await client.callTool({
          name: "list_thread_questions",
          arguments: { threadId },
        });
        // This fixture only acknowledges durable admission. Without a separately
        // ingested canonical resolution, the native callback must remain visible.
        expect(listed.structuredContent).toMatchObject({
          nativePendingRequestCount: 1,
          hasPendingQuestions: true,
        });
      },
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.mcp-user-input.respond",
      threadId,
      requestId: "question-request",
      expectedRequestCreatedAt: now,
      answers: { route: "A", targets: ["Desktop", "Server"] },
      unanswered: { followup: "skipped" },
      action: "answered",
      noticeMessageId: expect.any(String),
    });
  });

  it("preserves opaque callback and own-data question IDs through MCP parsing", async (context) => {
    const target = { ...callbackTarget, requestId: " opaque-request " };
    const activity = nativeQuestionActivity({
      requestId: target.requestId,
      questions: [
        {
          id: "__proto__",
          header: "Free text",
          question: "What exact text?",
          options: [],
          multiSelect: false,
        },
      ],
    });
    const dispatched: Array<Parameters<CafeMcpDependencies["orchestrationEngine"]["dispatch"]>[0]> =
      [];
    await withClient(
      context,
      makeDependencies({ threads: [questionThread([activity])], dispatched }),
      async (client) => {
        const read = await client.callTool({
          name: "get_thread_question",
          arguments: { threadId, target },
        });
        expect(read.isError).not.toBe(true);
        expect(read.structuredContent).toMatchObject({
          target,
          detail: { questions: [{ id: "__proto__", question: "What exact text?", options: [] }] },
        });
        const answer = await client.callTool({
          name: "answer_thread_question",
          arguments: {
            threadId,
            target,
            answers: Object.fromEntries([["__proto__", "The exact answer"]]),
          },
        });
        expect(answer.isError).not.toBe(true);
      },
    );
    const command = dispatched[0];
    expect(dispatched).toHaveLength(1);
    if (command?.type !== "thread.mcp-user-input.respond")
      throw new Error("Expected the question response command.");
    expect(command.requestId).toBe(" opaque-request ");
    expect(Object.hasOwn(command.answers, "__proto__")).toBe(true);
    expect(command.answers["__proto__"]).toBe("The exact answer");
  });

  it("reports unsupported callbacks and unreadable inline metadata without exposing interaction details", async (context) => {
    const unsupported = nativeQuestionActivity({
      interaction: { kind: "url", url: "PRIVATE_INTERACTION_URL" },
    });
    const malformed = {
      ...inlineQuestionActivity(),
      payload: { questions: "unreadable question metadata" },
    };
    await withClient(
      context,
      makeDependencies({ threads: [questionThread([unsupported, malformed])] }),
      async (client) => {
        const listed = await client.callTool({
          name: "list_thread_questions",
          arguments: { threadId },
        });
        expect(listed.isError).not.toBe(true);
        expect(listed.structuredContent).toMatchObject({
          hasPendingQuestions: true,
          omissions: { unavailableAsyncActivities: 1 },
          questions: [
            {
              target: callbackTarget,
              canAnswer: false,
              canSkip: false,
              canClear: false,
              unsupportedReason: "provider-interaction",
            },
          ],
        });
        const read = await client.callTool({
          name: "get_thread_question",
          arguments: { threadId, target: callbackTarget },
        });
        expect(read.isError).not.toBe(true);
        expect(read.structuredContent).toMatchObject({
          detail: { supported: false, unsupportedReason: "provider-interaction" },
        });
        expect(JSON.stringify(read)).not.toContain("PRIVATE_INTERACTION_URL");
      },
    );
    const result = await withClient(
      context,
      makeDependencies({ threads: [questionThread([malformed])] }),
      (client) => client.callTool({ name: "list_thread_questions", arguments: { threadId } }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      questions: [],
      hasPendingQuestions: null,
      omissions: { unavailableAsyncActivities: 1 },
    });
  });

  it("refuses oversized UTF-8 question details without returning truncated actionable text", async (context) => {
    const activity = nativeQuestionActivity({
      questions: Array.from({ length: 7 }, (_, index) => ({
        id: `question-${index}`,
        header: "Details",
        question: "文".repeat(65_000),
        options: [],
        multiSelect: false,
      })),
    });
    const result = await withClient(
      context,
      makeDependencies({ threads: [questionThread([activity])] }),
      (client) =>
        client.callTool({
          name: "get_thread_question",
          arguments: { threadId, target: callbackTarget },
        }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("complete question details exceed the MCP size limit");
    expect(JSON.stringify(result)).not.toContain("question-0");
  });

  it.for([
    { name: "skip_thread_question", action: "skipped", disposition: "skipped" },
    { name: "clear_thread_question", action: "cleared", disposition: "dismissed" },
  ] as const)(
    "records explicit native $action without inventing answers",
    async ({ name, action, disposition }, context) => {
      const dispatched: Array<
        Parameters<CafeMcpDependencies["orchestrationEngine"]["dispatch"]>[0]
      > = [];
      const result = await withClient(
        context,
        makeDependencies({ threads: [questionThread()], dispatched }),
        (client) => client.callTool({ name, arguments: { threadId, target: callbackTarget } }),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        accepted: true,
        resolution: "provider-confirmation-required",
      });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.mcp-user-input.respond",
        answers: {},
        unanswered: { route: disposition, targets: disposition, followup: disposition },
        action,
      });
    },
  );

  it.for([
    {
      description: "a foreign request",
      target: { ...callbackTarget, requestId: "foreign-question" },
      payload: {},
      answers: { route: "A", targets: "Desktop", followup: "Continue" },
      error: "no longer pending",
    },
    {
      description: "a replaced request incarnation",
      target: { ...callbackTarget, createdAt: "2026-08-11T12:00:00.000Z" },
      payload: {},
      answers: { route: "A", targets: "Desktop", followup: "Continue" },
      error: "no longer pending",
    },
    {
      description: "an incomplete response",
      target: callbackTarget,
      payload: {},
      answers: { route: "A" },
      error: "every question",
    },
    {
      description: "an unknown question ID",
      target: callbackTarget,
      payload: {},
      answers: { foreign: "A" },
      error: "unknown or overlapping",
    },
    {
      description: "duplicate provider IDs",
      target: callbackTarget,
      payload: { questions: [nativeQuestions[0], nativeQuestions[0]] },
      answers: { route: "A" },
      error: "cannot be answered",
    },
    {
      description: "an interaction callback",
      target: callbackTarget,
      payload: { interaction: { kind: "url", url: "PRIVATE_INTERACTION_URL" } },
      answers: { route: "A", targets: "Desktop", followup: "Continue" },
      error: "cannot be answered",
    },
  ])(
    "refuses $description before any dispatch",
    async ({ target, payload, answers, error }, context) => {
      const dispatched: Array<
        Parameters<CafeMcpDependencies["orchestrationEngine"]["dispatch"]>[0]
      > = [];
      const foreign = {
        ...questionThread([nativeQuestionActivity({ requestId: "foreign-question" })]),
        id: secondThreadId,
      };
      const result = await withClient(
        context,
        makeDependencies({
          threads: [questionThread([nativeQuestionActivity(payload)]), foreign],
          dispatched,
        }),
        (client) =>
          client.callTool({
            name: "answer_thread_question",
            arguments: { threadId, target, answers },
          }),
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(error);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_INTERACTION_URL");
      expect(dispatched).toEqual([]);
    },
  );

  it("refuses answer/disposition overlap and legacy skip capability without consuming the callback", async (context) => {
    const dispatched: Array<Parameters<CafeMcpDependencies["orchestrationEngine"]["dispatch"]>[0]> =
      [];
    const legacy = nativeQuestionActivity();
    const payload = { ...(legacy.payload as Record<string, unknown>) };
    delete payload.supportsUnanswered;
    await withClient(
      context,
      makeDependencies({ threads: [questionThread([{ ...legacy, payload }])], dispatched }),
      async (client) => {
        for (const name of ["skip_thread_question", "clear_thread_question"]) {
          const result = await client.callTool({
            name,
            arguments: { threadId, target: callbackTarget },
          });
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).toContain("does not support skipping or clearing");
        }
        const overlap = await client.callTool({
          name: "answer_thread_question",
          arguments: {
            threadId,
            target: callbackTarget,
            answers: { route: "A", targets: "Desktop", followup: "Continue" },
            unanswered: { route: "skipped" },
          },
        });
        expect(overlap.isError).toBe(true);
        // A legacy capability refusal is meaningful even when the disposition
        // overlaps; complete answer-only delivery must remain usable afterwards.
        expect(JSON.stringify(overlap)).toContain("does not support skipping or clearing");
        const valid = await client.callTool({
          name: "answer_thread_question",
          arguments: {
            threadId,
            target: callbackTarget,
            answers: { route: "A", targets: "Desktop", followup: "Continue" },
          },
        });
        expect(valid.isError).not.toBe(true);
      },
    );
    expect(dispatched).toHaveLength(1);
    const capable = makeDependencies({ threads: [questionThread()] });
    const overlap = await withClient(context, capable, (client) =>
      client.callTool({
        name: "answer_thread_question",
        arguments: {
          threadId,
          target: callbackTarget,
          answers: { route: "A", targets: "Desktop", followup: "Continue" },
          unanswered: { route: "skipped" },
        },
      }),
    );
    expect(overlap.isError).toBe(true);
    expect(JSON.stringify(overlap)).toContain("unknown or overlapping");
  });

  it("routes inline answers and handling through the distinct durable commands", async (context) => {
    const dispatched: Array<Parameters<CafeMcpDependencies["orchestrationEngine"]["dispatch"]>[0]> =
      [];
    await withClient(
      context,
      makeDependencies({ threads: [questionThread()], dispatched }),
      async (client) => {
        const answer = await client.callTool({
          name: "answer_thread_question",
          arguments: { threadId, target: inlineTarget, answer: "Keep the exact second route." },
        });
        expect(answer.isError).not.toBe(true);
        expect(answer.structuredContent).toMatchObject({
          accepted: true,
          resolution: "recorded",
          messageId: expect.any(String),
        });
        for (const name of ["skip_thread_question", "clear_thread_question"]) {
          const result = await client.callTool({
            name,
            arguments: { threadId, target: inlineTarget },
          });
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toMatchObject({
            accepted: true,
            resolution: "recorded",
          });
        }
        const handled = await client.callTool({
          name: "get_thread_question",
          arguments: { threadId, target: { ...inlineTarget, questionIndex: 0 } },
        });
        expect(handled.isError).toBe(true);
        expect(JSON.stringify(handled)).toContain("already been handled");
      },
    );
    expect(dispatched).toHaveLength(3);
    expect(dispatched[0]).toMatchObject({
      type: "thread.async-question.answer",
      threadId,
      activityId: inlineActivityId,
      questionIndex: 1,
      answer: "Keep the exact second route.",
      messageId: expect.any(String),
      noticeMessageId: expect.any(String),
    });
    expect(dispatched[1]).toMatchObject({
      type: "thread.mcp-async-questions.resolve",
      threadId,
      activityId: inlineActivityId,
      questionIndexes: [1],
      action: "skipped",
    });
    expect(dispatched[2]).toMatchObject({
      type: "thread.mcp-async-questions.resolve",
      threadId,
      activityId: inlineActivityId,
      questionIndexes: [1],
      action: "cleared",
    });
  });

  it("preserves pending questions and returns a fixed error after dispatch failure", async (context) => {
    const dependencies = makeDependencies({ threads: [questionThread()] });
    await withClient(
      context,
      {
        ...dependencies,
        orchestrationEngine: {
          dispatch: () => Effect.die("PRIVATE_PROVIDER_FAILURE token=secret /private/cursor"),
        },
      },
      async (client) => {
        const result = await client.callTool({
          name: "answer_thread_question",
          arguments: {
            threadId,
            target: callbackTarget,
            answers: { route: "A", targets: "Desktop", followup: "Continue" },
          },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("Unable to submit this question action");
        expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_FAILURE");
        expect(JSON.stringify(result)).not.toContain("token=secret");
        const listed = await client.callTool({
          name: "list_thread_questions",
          arguments: { threadId },
        });
        expect(listed.structuredContent).toMatchObject({
          nativePendingRequestCount: 1,
          hasPendingQuestions: true,
        });
      },
    );
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
