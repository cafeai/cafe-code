import { scopeThreadRef } from "@cafecode/client-runtime";
import {
  CheckpointRef,
  DEFAULT_MODEL,
  EnvironmentId,
  EventId,
  MessageId,
  MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  applyShellEvent,
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  removeEnvironmentState,
  selectBootstrapCompleteForEnvironment,
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  selectThreadByRef,
  selectThreadDetailHydratedByRef,
  selectThreadExistsByRef,
  setThreadBranch,
  setError,
  selectThreadsAcrossEnvironments,
  syncServerThreadDetail,
  type AppState,
  type EnvironmentState,
} from "./store";
import { deriveActiveSubagentWorkEntries, deriveSubagentWorkEntries } from "./session-logic";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

function withActiveEnvironmentState(
  environmentState: EnvironmentState,
  overrides: Partial<AppState & EnvironmentState> = {},
): AppState {
  const {
    activeEnvironmentId: overrideActiveEnvironmentId,
    environmentStateById: overrideEnvironmentStateById,
    ...environmentOverrides
  } = overrides;
  const activeEnvironmentId = overrideActiveEnvironmentId ?? localEnvironmentId;
  const mergedEnvironmentState = {
    ...environmentState,
    ...environmentOverrides,
  };
  const environmentStateById =
    overrideEnvironmentStateById ??
    (activeEnvironmentId
      ? {
          [activeEnvironmentId]: mergedEnvironmentState,
        }
      : {});

  return {
    activeEnvironmentId,
    environmentStateById,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    codexThreadId: null,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeTurnConfigurationActivity(input: {
  readonly id: string;
  readonly turnId: TurnId;
  readonly sequence?: number;
  readonly createdAt?: string;
  readonly providerDisplayName?: string;
}): Thread["activities"][number] {
  return {
    id: EventId.make(input.id),
    tone: "info",
    kind: "provider.turn.configuration",
    summary: "Turn accepted",
    turnId: input.turnId,
    sequence: input.sequence ?? 1,
    createdAt: input.createdAt ?? "2026-02-27T00:00:01.000Z",
    payload: {
      turnConfiguration: {
        version: 1,
        provider: "codex",
        providerInstanceId: "codex_personal",
        providerDisplayName: input.providerDisplayName ?? "Codex Personal",
        model: "gpt-6.1-sol",
        modelDisplayName: "GPT-6.1 Sol",
        effort: "ultra",
        fastMode: true,
        runtimeMode: "full-access",
        interactionMode: "default",
        settingsSource: "submitted",
      },
    },
  };
}

function makeState(thread: Thread): AppState {
  const projectId = ProjectId.make("project-1");
  const project = {
    id: projectId,
    environmentId: thread.environmentId,
    name: "Project",
    cwd: "/tmp/project",
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    scripts: [],
  };
  const threadIdsByProjectId: EnvironmentState["threadIdsByProjectId"] =
    thread.projectId === null
      ? {}
      : {
          [thread.projectId]: [thread.id],
        };
  const environmentState = {
    projectIds: [projectId],
    projectById: {
      [projectId]: project,
    },
    threadIds: [thread.id],
    threadIdsByProjectId,
    threadShellById: {
      [thread.id]: {
        id: thread.id,
        environmentId: thread.environmentId,
        codexThreadId: thread.codexThreadId,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        subagentLimits: thread.subagentLimits,
        error: thread.error,
        createdAt: thread.createdAt,
        archivedAt: thread.archivedAt,
        updatedAt: thread.updatedAt,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
      },
    },
    threadSessionById: {
      [thread.id]: thread.session,
    },
    threadTurnStateById: {
      [thread.id]: {
        latestTurn: thread.latestTurn,
        ...(thread.pendingSourceProposedPlan
          ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
          : {}),
      },
    },
    messageIdsByThreadId: {
      [thread.id]: thread.messages.map((message) => message.id),
    },
    messageByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.messages.map((message) => [message.id, message] as const),
      ) as EnvironmentState["messageByThreadId"][ThreadId],
    },
    activityIdsByThreadId: {
      [thread.id]: thread.activities.map((activity) => activity.id),
    },
    activityByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.activities.map((activity) => [activity.id, activity] as const),
      ) as EnvironmentState["activityByThreadId"][ThreadId],
    },
    proposedPlanIdsByThreadId: {
      [thread.id]: thread.proposedPlans.map((plan) => plan.id),
    },
    proposedPlanByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.proposedPlans.map((plan) => [plan.id, plan] as const),
      ) as EnvironmentState["proposedPlanByThreadId"][ThreadId],
    },
    turnDiffIdsByThreadId: {
      [thread.id]: thread.turnDiffSummaries.map((summary) => summary.turnId),
    },
    turnDiffSummaryByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.turnDiffSummaries.map((summary) => [summary.turnId, summary] as const),
      ) as EnvironmentState["turnDiffSummaryByThreadId"][ThreadId],
    },
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  return withActiveEnvironmentState(environmentState, {
    activeEnvironmentId: thread.environmentId,
  });
}

function makeEmptyState(overrides: Partial<AppState & EnvironmentState> = {}): AppState {
  const environmentState: EnvironmentState = {
    projectIds: [],
    projectById: {},
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  return withActiveEnvironmentState(environmentState, overrides);
}

function localEnvironmentStateOf(state: AppState): EnvironmentState {
  return selectEnvironmentState(state, localEnvironmentId);
}

function environmentStateOf(state: AppState, environmentId: EnvironmentId): EnvironmentState {
  return selectEnvironmentState(state, environmentId);
}

function projectsOf(state: AppState) {
  return selectProjectsAcrossEnvironments(state);
}

function threadsOf(state: AppState) {
  return selectThreadsAcrossEnvironments(state);
}

describe("thread concurrency projection", () => {
  it.each(["thread.duplicated", "thread.forked"] as const)(
    "copies both driver choices and explicit reset through %s without copying session evidence",
    (kind) => {
      for (const limits of [{ codex: 12, claude: 20 }, {}]) {
        const source = makeThread({ subagentLimits: limits });
        const targetId = ThreadId.make("target-limit-chat");
        const target = {
          id: targetId,
          projectId: source.projectId,
          title: "Copied chat",
          modelSelection: source.modelSelection,
          runtimeMode: source.runtimeMode,
          interactionMode: source.interactionMode,
          // The authoritative created/copied shell already carries the copied
          // policy. A later context-copy event must not replace newer evidence.
          subagentLimits: { ...limits },
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: source.createdAt,
          updatedAt: source.createdAt,
          archivedAt: null,
          deletedAt: null,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        };
        const state = applyShellEvent(
          makeState(source),
          { kind: "thread-upserted", sequence: 1, thread: target },
          localEnvironmentId,
        );
        const payload = { sourceThreadId: source.id, targetThreadId: targetId };
        const event =
          kind === "thread.duplicated"
            ? makeEvent(kind, { ...payload, duplicatedAt: source.createdAt })
            : makeEvent(kind, { ...payload, forkedAt: source.createdAt });
        const copied = selectThreadByRef(
          applyOrchestrationEvent(state, event, localEnvironmentId),
          scopeThreadRef(localEnvironmentId, targetId),
        );
        expect(copied?.subagentLimits).toEqual(limits);
        expect(copied?.session).toBeNull();
        expect(copied?.subagentLimits).not.toBe(limits);
      }
    },
  );

  it("round-trips desired policy and explicit reset independently from configured session evidence", () => {
    const thread = makeThread();
    let state = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.meta-updated", {
        threadId: thread.id,
        subagentLimits: { codex: 12, claude: 20 },
        updatedAt: "2026-10-03T00:00:00.000Z",
      }),
      localEnvironmentId,
    );
    expect(threadsOf(state)[0]?.subagentLimits).toEqual({ codex: 12, claude: 20 });
    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          maxConcurrentSubagents: 3,
          updatedAt: "2026-10-03T00:00:01.000Z",
        },
      }),
      localEnvironmentId,
    );
    expect(threadsOf(state)[0]?.session?.maxConcurrentSubagents).toBe(3);
    expect(threadsOf(state)[0]?.subagentLimits).toEqual({ codex: 12, claude: 20 });
    state = applyOrchestrationEvent(
      state,
      {
        ...makeEvent("thread.meta-updated", {
          threadId: thread.id,
          subagentLimits: {},
          updatedAt: "2026-10-03T00:00:02.000Z",
        }),
        sequence: 2,
      },
      localEnvironmentId,
    );
    expect(threadsOf(state)[0]?.subagentLimits).toEqual({});
    expect(threadsOf(state)[0]?.session?.maxConcurrentSubagents).toBe(3);
    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: thread.id,
        title: "Renamed",
        updatedAt: "2026-10-03T00:00:03.000Z",
      }),
      localEnvironmentId,
    );
    expect(threadsOf(state)[0]?.subagentLimits).toEqual({});
  });
});

describe("bootstrap selectors", () => {
  it("reads bootstrap completion for an explicit environment", () => {
    const bootstrappedEnvironment = selectEnvironmentState(
      makeEmptyState({ bootstrapComplete: true }),
      localEnvironmentId,
    );
    const pendingEnvironment = selectEnvironmentState(
      makeEmptyState({ bootstrapComplete: false }),
      localEnvironmentId,
    );
    const state: AppState = {
      activeEnvironmentId: localEnvironmentId,
      environmentStateById: {
        [localEnvironmentId]: bootstrappedEnvironment,
        [remoteEnvironmentId]: pendingEnvironment,
      },
    };

    expect(selectBootstrapCompleteForEnvironment(state, localEnvironmentId)).toBe(true);
    expect(selectBootstrapCompleteForEnvironment(state, remoteEnvironmentId)).toBe(false);
    expect(selectBootstrapCompleteForEnvironment(state, null)).toBe(false);
    expect(selectBootstrapCompleteForEnvironment(state, EnvironmentId.make("missing"))).toBe(false);
  });
});

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.make("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

describe("environment state removal", () => {
  it("drops local state for removed environments", () => {
    const removedThread = makeThread({
      environmentId: remoteEnvironmentId,
      id: ThreadId.make("thread-removed"),
    });
    const keptThread = makeThread({ id: ThreadId.make("thread-kept") });
    const removedState = makeState(removedThread).environmentStateById[remoteEnvironmentId]!;
    const keptState = makeState(keptThread).environmentStateById[localEnvironmentId]!;
    const state: AppState = {
      activeEnvironmentId: remoteEnvironmentId,
      environmentStateById: {
        [remoteEnvironmentId]: removedState,
        [localEnvironmentId]: keptState,
      },
    };

    const next = removeEnvironmentState(state, remoteEnvironmentId);

    expect(next.activeEnvironmentId).toBeNull();
    expect(next.environmentStateById[remoteEnvironmentId]).toBeUndefined();
    expect(next.environmentStateById[localEnvironmentId]).toBe(keptState);
  });

  it("preserves active environment when removing a different environment", () => {
    const state = makeState(makeThread());

    const next = removeEnvironmentState(state, remoteEnvironmentId);

    expect(next).toBe(state);
  });
});

describe("thread selection memoization", () => {
  it("keeps standalone shells in the environment catalog without a synthetic project index", () => {
    const thread = makeThread({
      projectId: null,
      branch: "stale-main",
      worktreePath: "/stale-project",
    });
    const state = makeState(thread);
    const event: OrchestrationShellStreamEvent = {
      kind: "thread-upserted",
      sequence: 1,
      thread: {
        id: thread.id,
        projectId: null,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: thread.interactionMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        latestTurn: null,
        createdAt: thread.createdAt,
        updatedAt: thread.createdAt,
        archivedAt: null,
        deletedAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    };
    const next = applyShellEvent(state, event, localEnvironmentId);
    expect(localEnvironmentStateOf(next).threadIds).toContain(thread.id);
    expect(localEnvironmentStateOf(next).threadIdsByProjectId).toEqual({});
    expect(selectThreadByRef(next, scopeThreadRef(localEnvironmentId, thread.id))).toMatchObject({
      projectId: null,
      branch: null,
      worktreePath: null,
    });
    expect(
      setThreadBranch(next, scopeThreadRef(localEnvironmentId, thread.id), "new", "/other"),
    ).toBe(next);
  });
  it("projects provider errors for standalone chats and allows clearing them", () => {
    const thread = makeThread({ projectId: null, branch: null, worktreePath: null });
    const state = makeState(thread);
    const ref = scopeThreadRef(localEnvironmentId, thread.id);
    const failed = setError(state, ref, "Provider rejected the message.");
    expect(selectThreadByRef(failed, ref)?.error).toBe("Provider rejected the message.");
    expect(selectThreadByRef(setError(failed, ref, null), ref)?.error).toBeNull();
  });

  it("does not rewrite shell state for structurally equal model selections", () => {
    const thread = makeThread();
    const state = makeState(thread);
    const shellEvent: OrchestrationShellStreamEvent = {
      kind: "thread-upserted",
      sequence: 1,
      thread: {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        latestTurn: thread.latestTurn,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt ?? thread.createdAt,
        archivedAt: thread.archivedAt,
        deletedAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    };

    const populated = applyShellEvent(state, shellEvent, localEnvironmentId);
    const repeated = applyShellEvent(populated, { ...shellEvent, sequence: 2 }, localEnvironmentId);

    // Exact-thread policy authority advances even for equal data, but UI
    // shells retain identity so unrelated selectors need not rerender.
    expect(localEnvironmentStateOf(repeated).threadShellById).toBe(
      localEnvironmentStateOf(populated).threadShellById,
    );
    expect(localEnvironmentStateOf(repeated).subagentPolicySequenceByThreadId?.[thread.id]).toBe(2);
  });

  it("returns stable thread references for repeated reads of the same state", () => {
    const thread = makeThread({
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "user",
          text: "hello",
          createdAt: "2026-02-13T00:01:00.000Z",
          streaming: false,
        },
      ],
      activities: [
        {
          id: EventId.make("activity-1"),
          tone: "info",
          kind: "step",
          summary: "working",
          payload: {},
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-02-13T00:01:30.000Z",
        },
      ],
      proposedPlans: [
        {
          id: "plan-1",
          turnId: null,
          planMarkdown: "plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-13T00:02:00.000Z",
          updatedAt: "2026-02-13T00:02:00.000Z",
        },
      ],
      turnDiffSummaries: [
        {
          turnId: TurnId.make("turn-1"),
          completedAt: "2026-02-13T00:03:00.000Z",
          files: [],
        },
      ],
    });
    const state = makeState(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);

    const first = selectThreadByRef(state, ref);
    const second = selectThreadByRef(state, ref);

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(second?.messages).toBe(first?.messages);
    expect(second?.activities).toBe(first?.activities);
    expect(second?.proposedPlans).toBe(first?.proposedPlans);
    expect(second?.turnDiffSummaries).toBe(first?.turnDiffSummaries);
  });

  it("reuses the derived thread when the app state wrapper changes but thread data does not", () => {
    const thread = makeThread({
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "done",
          createdAt: "2026-02-13T00:01:00.000Z",
          streaming: false,
        },
      ],
    });
    const state = makeState(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const wrappedState: AppState = {
      ...state,
      environmentStateById: { ...state.environmentStateById },
    };

    const first = selectThreadByRef(state, ref);
    const second = selectThreadByRef(wrappedState, ref);

    expect(second).toBe(first);
  });

  it("updates the derived thread when the underlying thread data changes", () => {
    const thread = makeThread();
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const firstState = makeState(thread);
    const secondState = makeState({
      ...thread,
      messages: [
        {
          id: MessageId.make("message-2"),
          role: "user",
          text: "new",
          createdAt: "2026-02-13T00:04:00.000Z",
          streaming: false,
        },
      ],
    });

    const first = selectThreadByRef(firstState, ref);
    const second = selectThreadByRef(secondState, ref);

    expect(second).not.toBe(first);
    expect(second?.messages).toHaveLength(1);
    expect(second?.messages[0]?.text).toBe("new");
  });

  it("checks thread existence without materializing the full thread", () => {
    const thread = makeThread();
    const state = makeState(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);

    expect(selectThreadExistsByRef(state, ref)).toBe(true);
    expect(
      selectThreadExistsByRef(
        state,
        scopeThreadRef(thread.environmentId, ThreadId.make("missing")),
      ),
    ).toBe(false);
    expect(selectThreadExistsByRef(state, null)).toBe(false);
  });

  it("distinguishes a shell-only thread from a conclusively empty detail snapshot", () => {
    const thread = makeThread();
    const hydratedState = makeState(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const hydratedEnvironment = hydratedState.environmentStateById[thread.environmentId];
    if (!hydratedEnvironment) {
      throw new Error("Expected test environment state");
    }
    const shellOnlyState: AppState = {
      ...hydratedState,
      environmentStateById: {
        ...hydratedState.environmentStateById,
        [thread.environmentId]: {
          ...hydratedEnvironment,
          messageIdsByThreadId: {},
        },
      },
    };

    expect(selectThreadDetailHydratedByRef(shellOnlyState, ref)).toBe(false);
    // An owned empty array is intentional: detail snapshots always materialize
    // it, so an empty conversation is no longer ambiguous with loading.
    expect(selectThreadDetailHydratedByRef(hydratedState, ref)).toBe(true);
    expect(selectThreadDetailHydratedByRef(hydratedState, null)).toBe(false);
  });
});

describe("setThreadBranch", () => {
  it("updates only the scoped thread environment", () => {
    const sharedThreadId = ThreadId.make("thread-shared");
    const localThread = makeThread({
      id: sharedThreadId,
      environmentId: localEnvironmentId,
      branch: "local-branch",
    });
    const remoteThread = makeThread({
      id: sharedThreadId,
      environmentId: remoteEnvironmentId,
      branch: "remote-branch",
    });
    const state: AppState = {
      activeEnvironmentId: localEnvironmentId,
      environmentStateById: {
        [localEnvironmentId]: environmentStateOf(makeState(localThread), localEnvironmentId),
        [remoteEnvironmentId]: environmentStateOf(makeState(remoteThread), remoteEnvironmentId),
      },
    };

    const next = setThreadBranch(
      state,
      scopeThreadRef(remoteEnvironmentId, sharedThreadId),
      "remote-next",
      "/tmp/remote-worktree",
    );

    expect(
      environmentStateOf(next, localEnvironmentId).threadShellById[sharedThreadId]?.branch,
    ).toBe("local-branch");
    expect(
      environmentStateOf(next, remoteEnvironmentId).threadShellById[sharedThreadId]?.branch,
    ).toBe("remote-next");
    expect(
      environmentStateOf(next, remoteEnvironmentId).threadShellById[sharedThreadId]?.worktreePath,
    ).toBe("/tmp/remote-worktree");
  });
});

describe("incremental orchestration updates", () => {
  it("does not mark bootstrap complete for incremental events", () => {
    const state = withActiveEnvironmentState(localEnvironmentStateOf(makeState(makeThread())), {
      bootstrapComplete: false,
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.make("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(localEnvironmentStateOf(next).bootstrapComplete).toBe(false);
  });

  it("moves thread state between project indexes on thread meta project updates", () => {
    const targetProjectId = ProjectId.make("project-2");
    const thread = makeThread({
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "user",
          text: "keep me",
          createdAt: "2026-02-13T00:00:01.000Z",
          streaming: false,
        },
      ],
    });
    const initialState = makeState(thread);
    const initialEnvironment = localEnvironmentStateOf(initialState);
    const sourceProject = initialEnvironment.projectById[ProjectId.make("project-1")]!;
    const state = withActiveEnvironmentState({
      ...initialEnvironment,
      projectIds: [...initialEnvironment.projectIds, targetProjectId],
      projectById: {
        ...initialEnvironment.projectById,
        [targetProjectId]: {
          ...sourceProject,
          id: targetProjectId,
          name: "Project 2",
          cwd: "/tmp/project-2",
        },
      },
      sidebarThreadSummaryById: {
        [thread.id]: {
          id: thread.id,
          environmentId: thread.environmentId,
          projectId: thread.projectId,
          title: thread.title,
          interactionMode: thread.interactionMode,
          session: thread.session,
          createdAt: thread.createdAt,
          archivedAt: thread.archivedAt,
          updatedAt: thread.updatedAt,
          latestTurn: thread.latestTurn,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: thread.id,
        projectId: targetProjectId,
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    const nextEnvironment = localEnvironmentStateOf(next);
    expect(nextEnvironment.threadIdsByProjectId[ProjectId.make("project-1")]).toBeUndefined();
    expect(nextEnvironment.threadIdsByProjectId[targetProjectId]).toEqual([thread.id]);
    expect(nextEnvironment.sidebarThreadSummaryById[thread.id]?.projectId).toBe(targetProjectId);
    expect(
      selectThreadByRef(next, scopeThreadRef(localEnvironmentId, thread.id))?.messages,
    ).toEqual(thread.messages);
  });

  it("preserves state identity for no-op project and thread deletes", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const nextAfterProjectDelete = applyOrchestrationEvent(
      state,
      makeEvent("project.deleted", {
        projectId: ProjectId.make("project-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );
    const nextAfterThreadDelete = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: ThreadId.make("thread-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(nextAfterProjectDelete).toBe(state);
    expect(nextAfterThreadDelete).toBe(state);
  });

  it("reuses an existing project row when project.created arrives with a new id for the same cwd", () => {
    const originalProjectId = ProjectId.make("project-1");
    const recreatedProjectId = ProjectId.make("project-2");
    const state: AppState = makeEmptyState({
      projectIds: [originalProjectId],
      projectById: {
        [originalProjectId]: {
          id: originalProjectId,
          environmentId: localEnvironmentId,
          name: "Project",
          cwd: "/tmp/project",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: recreatedProjectId,
        title: "Project Recreated",
        workspaceRoot: "/tmp/project",
        additionalWorkspaceRoots: [],
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(projectsOf(next)).toHaveLength(1);
    expect(projectsOf(next)[0]?.id).toBe(recreatedProjectId);
    expect(projectsOf(next)[0]?.cwd).toBe("/tmp/project");
    expect(projectsOf(next)[0]?.name).toBe("Project Recreated");
    expect(localEnvironmentStateOf(next).projectIds).toEqual([recreatedProjectId]);
    expect(localEnvironmentStateOf(next).projectById[originalProjectId]).toBeUndefined();
    expect(localEnvironmentStateOf(next).projectById[recreatedProjectId]?.id).toBe(
      recreatedProjectId,
    );
  });

  it("removes stale project index entries when thread.created recreates a thread under a new project", () => {
    const originalProjectId = ProjectId.make("project-1");
    const recreatedProjectId = ProjectId.make("project-2");
    const threadId = ThreadId.make("thread-1");
    const thread = makeThread({
      id: threadId,
      projectId: originalProjectId,
    });
    const state = withActiveEnvironmentState(localEnvironmentStateOf(makeState(thread)), {
      projectIds: [originalProjectId, recreatedProjectId],
      projectById: {
        [originalProjectId]: {
          id: originalProjectId,
          environmentId: localEnvironmentId,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
        [recreatedProjectId]: {
          id: recreatedProjectId,
          environmentId: localEnvironmentId,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId: recreatedProjectId,
        title: "Recovered thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)).toHaveLength(1);
    expect(threadsOf(next)[0]?.projectId).toBe(recreatedProjectId);
    expect(localEnvironmentStateOf(next).threadIdsByProjectId[originalProjectId]).toBeUndefined();
    expect(localEnvironmentStateOf(next).threadIdsByProjectId[recreatedProjectId]).toEqual([
      threadId,
    ]);
  });

  it("updates only the affected thread for message events", () => {
    const thread1 = makeThread({
      id: ThreadId.make("thread-1"),
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:00.000Z",
          streaming: false,
        },
      ],
    });
    const thread2 = makeThread({ id: ThreadId.make("thread-2") });
    const baseState = makeState(thread1);
    const baseEnvironmentState = localEnvironmentStateOf(baseState);
    const state = withActiveEnvironmentState(baseEnvironmentState, {
      threadIds: [thread1.id, thread2.id],
      threadShellById: {
        ...baseEnvironmentState.threadShellById,
        [thread2.id]: {
          id: thread2.id,
          environmentId: thread2.environmentId,
          codexThreadId: thread2.codexThreadId,
          projectId: thread2.projectId,
          title: thread2.title,
          modelSelection: thread2.modelSelection,
          runtimeMode: thread2.runtimeMode,
          interactionMode: thread2.interactionMode,
          error: thread2.error,
          createdAt: thread2.createdAt,
          archivedAt: thread2.archivedAt,
          updatedAt: thread2.updatedAt,
          branch: thread2.branch,
          worktreePath: thread2.worktreePath,
        },
      },
      threadSessionById: {
        ...baseEnvironmentState.threadSessionById,
        [thread2.id]: thread2.session,
      },
      threadTurnStateById: {
        ...baseEnvironmentState.threadTurnStateById,
        [thread2.id]: {
          latestTurn: thread2.latestTurn,
        },
      },
      messageIdsByThreadId: {
        ...baseEnvironmentState.messageIdsByThreadId,
        [thread2.id]: [],
      },
      messageByThreadId: {
        ...baseEnvironmentState.messageByThreadId,
        [thread2.id]: {},
      },
      activityIdsByThreadId: {
        ...baseEnvironmentState.activityIdsByThreadId,
        [thread2.id]: [],
      },
      activityByThreadId: {
        ...baseEnvironmentState.activityByThreadId,
        [thread2.id]: {},
      },
      proposedPlanIdsByThreadId: {
        ...baseEnvironmentState.proposedPlanIdsByThreadId,
        [thread2.id]: [],
      },
      proposedPlanByThreadId: {
        ...baseEnvironmentState.proposedPlanByThreadId,
        [thread2.id]: {},
      },
      turnDiffIdsByThreadId: {
        ...baseEnvironmentState.turnDiffIdsByThreadId,
        [thread2.id]: [],
      },
      turnDiffSummaryByThreadId: {
        ...baseEnvironmentState.turnDiffSummaryByThreadId,
        [thread2.id]: {},
      },
      sidebarThreadSummaryById: {
        ...baseEnvironmentState.sidebarThreadSummaryById,
      },
      threadIdsByProjectId: {
        [ProjectId.make("project-1")]: [thread1.id, thread2.id],
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread1.id,
        messageId: MessageId.make("message-1"),
        role: "assistant",
        text: " world",
        turnId: TurnId.make("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.messages[0]?.text).toBe("hello world");
    expect(threadsOf(next)[0]?.latestTurn?.state).toBe("running");
    const nextEnvironmentState = next.environmentStateById[localEnvironmentId];
    const previousEnvironmentState = state.environmentStateById[localEnvironmentId];
    expect(nextEnvironmentState?.messageIdsByThreadId[thread1.id]).toBe(
      previousEnvironmentState?.messageIdsByThreadId[thread1.id],
    );
    expect(nextEnvironmentState?.messageByThreadId[thread1.id]).not.toBe(
      previousEnvironmentState?.messageByThreadId[thread1.id],
    );
    expect(nextEnvironmentState?.threadShellById[thread2.id]).toBe(
      previousEnvironmentState?.threadShellById[thread2.id],
    );
    expect(nextEnvironmentState?.threadSessionById[thread2.id]).toBe(
      previousEnvironmentState?.threadSessionById[thread2.id],
    );
    expect(nextEnvironmentState?.messageIdsByThreadId[thread2.id]).toBe(
      previousEnvironmentState?.messageIdsByThreadId[thread2.id],
    );
    expect(nextEnvironmentState?.messageByThreadId[thread2.id]).toBe(
      previousEnvironmentState?.messageByThreadId[thread2.id],
    );
  });

  it("preserves streamed assistant text when an empty completion marker closes the message", () => {
    const turnId = TurnId.make("turn-1");
    const messageId = MessageId.make("message-1");
    const thread = makeThread({
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: messageId,
      },
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "That makes sense",
          turnId,
          createdAt: "2026-02-27T00:00:01.000Z",
          streaming: true,
        },
      ],
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread.id,
        messageId,
        role: "assistant",
        text: "",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.messages[0]?.text).toBe("That makes sense");
    expect(threadsOf(next)[0]?.messages[0]?.streaming).toBe(false);
  });

  it("applies replay batches in sequence and updates session state", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const state = makeState(thread);

    const afterAssistantMessage = applyOrchestrationEvents(
      state,
      [
        makeEvent(
          "thread.session-set",
          {
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.make("turn-1"),
              lastError: null,
              updatedAt: "2026-02-27T00:00:02.000Z",
            },
          },
          { sequence: 2 },
        ),
        makeEvent(
          "thread.message-sent",
          {
            threadId: thread.id,
            messageId: MessageId.make("assistant-1"),
            role: "assistant",
            text: "done",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-02-27T00:00:03.000Z",
            updatedAt: "2026-02-27T00:00:03.000Z",
          },
          { sequence: 3 },
        ),
      ],
      localEnvironmentId,
    );

    expect(threadsOf(afterAssistantMessage)[0]?.session?.status).toBe("running");
    expect(threadsOf(afterAssistantMessage)[0]?.latestTurn?.state).toBe("running");
    expect(threadsOf(afterAssistantMessage)[0]?.messages).toHaveLength(1);

    const afterSessionReady = applyOrchestrationEvent(
      afterAssistantMessage,
      makeEvent(
        "thread.session-set",
        {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-02-27T00:00:04.000Z",
          },
        },
        { sequence: 4 },
      ),
      localEnvironmentId,
    );

    expect(threadsOf(afterSessionReady)[0]?.session?.status).toBe("ready");
    expect(threadsOf(afterSessionReady)[0]?.latestTurn?.state).toBe("completed");
    expect(threadsOf(afterSessionReady)[0]?.latestTurn?.completedAt).toBe(
      "2026-02-27T00:00:04.000Z",
    );
  });

  it("ignores stale same-turn session replays after terminal readiness", () => {
    const turnId = TurnId.make("turn-1");
    const messageId = MessageId.make("assistant-1");
    const thread = makeThread({
      session: {
        provider: "codex" as never,
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: turnId,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:10.000Z",
      },
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: messageId,
      },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvents(
      state,
      [
        makeEvent("thread.message-sent", {
          threadId: thread.id,
          messageId,
          role: "assistant",
          text: "",
          turnId,
          streaming: false,
          createdAt: "2026-02-27T00:00:39.671Z",
          updatedAt: "2026-02-27T00:00:39.671Z",
        }),
        makeEvent("thread.session-set", {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-02-27T00:00:39.802Z",
          },
        }),
        makeEvent("thread.session-set", {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-02-27T00:00:39.803Z",
          },
        }),
        makeEvent("thread.session-set", {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-02-27T00:00:39.000Z",
          },
        }),
        makeEvent("thread.session-set", {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-02-27T00:00:39.000Z",
          },
        }),
      ],
      localEnvironmentId,
    );

    const nextThread = threadsOf(next)[0];
    expect(nextThread?.session?.status).toBe("ready");
    expect(nextThread?.session?.activeTurnId).toBeUndefined();
    expect(nextThread?.session?.updatedAt).toBe("2026-02-27T00:00:39.803Z");
    expect(nextThread?.latestTurn).toMatchObject({
      turnId,
      state: "completed",
      completedAt: "2026-02-27T00:00:39.803Z",
      assistantMessageId: messageId,
    });
  });

  it("marks a turn start request as a starting session before provider events arrive", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-start-requested", {
        threadId: thread.id,
        messageId: MessageId.make("message-starting"),
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: "2026-02-27T00:00:00.000Z",
      }),
      localEnvironmentId,
    );

    const nextThread = threadsOf(next)[0];
    expect(nextThread?.session?.status).toBe("connecting");
    expect(nextThread?.session?.orchestrationStatus).toBe("starting");
    expect(nextThread?.session?.activeTurnId).toBeUndefined();
    expect(nextThread?.runtimeMode).toBe("approval-required");
  });

  it("preserves turn request time when a starting session becomes running", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const requested = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-start-requested", {
        threadId: thread.id,
        messageId: MessageId.make("message-starting"),
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: "2026-02-27T00:00:00.000Z",
      }),
      localEnvironmentId,
    );
    const running = applyOrchestrationEvent(
      requested,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:05.000Z",
        },
      }),
      localEnvironmentId,
    );

    expect(threadsOf(running)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.make("turn-1"),
      state: "running",
      requestedAt: "2026-02-27T00:00:00.000Z",
      startedAt: "2026-02-27T00:00:05.000Z",
    });
  });

  it("does not regress latestTurn when an older turn diff completes late", () => {
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "running",
          requestedAt: "2026-02-27T00:00:02.000Z",
          startedAt: "2026-02-27T00:00:03.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.make("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.turnDiffSummaries).toHaveLength(1);
    expect(threadsOf(next)[0]?.latestTurn).toEqual(threadsOf(state)[0]?.latestTurn);
  });

  it("does not settle a running turn for missing provider diff metadata", () => {
    const turnId = TurnId.make("turn-1");
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          provider: "codex" as never,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: turnId,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.make("thread-1"),
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("provider-diff:evt"),
        status: "missing",
        files: [],
        assistantMessageId: MessageId.make("assistant:placeholder"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.turnDiffSummaries).toHaveLength(1);
    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId,
      state: "running",
      completedAt: null,
      assistantMessageId: null,
    });
  });

  it("rebinds live turn diffs to the authoritative assistant message when it arrives later", () => {
    const turnId = TurnId.make("turn-1");
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: MessageId.make("assistant:turn-1"),
        },
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:02.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            assistantMessageId: MessageId.make("assistant:turn-1"),
            files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("assistant-real"),
        role: "assistant",
        text: "final answer",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(
      MessageId.make("assistant-real"),
    );
    expect(threadsOf(next)[0]?.latestTurn?.assistantMessageId).toBe(
      MessageId.make("assistant-real"),
    );
  });

  it("reverts messages, plans, activities, and checkpoints by retained turns", () => {
    const state = makeState(
      makeThread({
        messages: [
          {
            id: MessageId.make("user-1"),
            role: "user",
            text: "first",
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            completedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.make("assistant-1"),
            role: "assistant",
            text: "first reply",
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-02-27T00:00:01.000Z",
            completedAt: "2026-02-27T00:00:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.make("user-2"),
            role: "user",
            text: "second",
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
            completedAt: "2026-02-27T00:00:02.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "plan 1",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: "plan-2",
            turnId: TurnId.make("turn-2"),
            planMarkdown: "plan 2",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:02.000Z",
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        activities: [
          {
            id: EventId.make("activity-1"),
            tone: "info",
            kind: "step",
            summary: "one",
            payload: {},
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: EventId.make("activity-2"),
            tone: "info",
            kind: "step",
            summary: "two",
            payload: {},
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        turnDiffSummaries: [
          {
            turnId: TurnId.make("turn-1"),
            completedAt: "2026-02-27T00:00:01.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            files: [],
          },
          {
            turnId: TurnId.make("turn-2"),
            completedAt: "2026-02-27T00:00:03.000Z",
            status: "ready",
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            files: [],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", {
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(threadsOf(next)[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(threadsOf(next)[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.make("activity-1"),
    ]);
    expect(threadsOf(next)[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.make("turn-1"),
    ]);
  });

  it("clears pending source proposed plans after revert before a new session-set event", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-2"),
        state: "completed",
        requestedAt: "2026-02-27T00:00:02.000Z",
        startedAt: "2026-02-27T00:00:02.000Z",
        completedAt: "2026-02-27T00:00:03.000Z",
        assistantMessageId: MessageId.make("assistant-2"),
        sourceProposedPlan: {
          threadId: ThreadId.make("thread-source"),
          planId: "plan-2" as never,
        },
      },
      pendingSourceProposedPlan: {
        threadId: ThreadId.make("thread-source"),
        planId: "plan-2" as never,
      },
      turnDiffSummaries: [
        {
          turnId: TurnId.make("turn-1"),
          completedAt: "2026-02-27T00:00:01.000Z",
          status: "ready",
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("ref-1"),
          files: [],
        },
        {
          turnId: TurnId.make("turn-2"),
          completedAt: "2026-02-27T00:00:03.000Z",
          status: "ready",
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("ref-2"),
          files: [],
        },
      ],
    });
    const reverted = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.reverted", {
        threadId: thread.id,
        turnCount: 1,
      }),
      localEnvironmentId,
    );

    expect(threadsOf(reverted)[0]?.pendingSourceProposedPlan).toBeUndefined();

    const next = applyOrchestrationEvent(
      reverted,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-3"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:04.000Z",
        },
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.make("turn-3"),
      state: "running",
    });
    expect(threadsOf(next)[0]?.latestTurn?.sourceProposedPlan).toBeUndefined();
  });

  it("does not extend a completed turn when accepted settings arrive after completion", () => {
    const turnId = TurnId.make("fast-completed-turn");
    const completedAt = "2026-02-27T00:00:10.000Z";
    const thread = makeThread({
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:01.000Z",
        completedAt,
        assistantMessageId: MessageId.make("fast-completed-assistant"),
      },
    });
    const state = makeState(thread);
    const activity = makeTurnConfigurationActivity({
      id: "late-accepted-settings",
      turnId,
      createdAt: "2026-02-27T00:00:30.000Z",
    });
    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.activity-appended", { threadId: thread.id, activity }),
      localEnvironmentId,
    );
    expect(threadsOf(next)[0]?.latestTurn).toEqual(thread.latestTurn);
    expect(threadsOf(next)[0]?.activities).toContainEqual(activity);
    // The exception is exact to presentation metadata. Existing late native
    // work still advances the terminal completion edge as it did before.
    const withLateTool = applyOrchestrationEvent(
      state,
      makeEvent("thread.activity-appended", {
        threadId: thread.id,
        activity: {
          ...activity,
          id: EventId.make("late-real-work"),
          kind: "tool.completed",
          payload: {},
        },
      }),
      localEnvironmentId,
    );
    expect(threadsOf(withLateTool)[0]?.latestTurn?.completedAt).toBe(activity.createdAt);
  });

  it("uses aggregate order for same-millisecond subagent restarts live and after reconnect", () => {
    const turnId = TurnId.make("turn-same-millisecond-subagent-restart");
    const childId = "provider-reused-child";
    const priorStartedAt = "2026-02-27T00:00:01.000Z";
    const restartedAt = "2026-02-27T00:10:36.000Z";
    const collidedAt = "2026-02-27T00:10:36.745Z";
    const priorTerminal: Thread["activities"][number] = {
      id: EventId.make("prior-terminal-edge"),
      tone: "info",
      kind: "task.completed",
      summary: "Subagent completed",
      payload: {
        taskId: childId,
        status: "completed",
        subagent: {
          threadId: childId,
          label: "Source factory",
          status: "completed",
          startedAt: priorStartedAt,
        },
      },
      turnId,
      sequence: 10,
      createdAt: "2026-02-27T00:07:34.448Z",
    };
    const delayedTerminalProgress: Thread["activities"][number] = {
      // The id deliberately sorts after the restart id. Opaque identity order
      // must never decide which equal-millisecond lifecycle edge wins.
      id: EventId.make("z-delayed-terminal-progress"),
      tone: "info",
      kind: "task.progress",
      summary: "Turn settings",
      payload: {
        taskId: childId,
        status: "completed",
        subagent: {
          threadId: childId,
          label: "Source factory",
          status: "completed",
          startedAt: priorStartedAt,
        },
      },
      turnId,
      // This obsolete provider/session-local value conflicts with canonical
      // aggregate order and must be replaced by the enclosing event sequence.
      sequence: 999,
      createdAt: collidedAt,
    };
    const restart: Thread["activities"][number] = {
      id: EventId.make("a-new-generation-start"),
      tone: "info",
      kind: "task.started",
      summary: "Subagent started",
      payload: {
        taskId: childId,
        subagent: {
          threadId: childId,
          label: "Source factory",
          status: "active",
          startedAt: restartedAt,
        },
      },
      turnId,
      sequence: 1,
      createdAt: collidedAt,
    };
    const thread = makeThread({
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-02-27T00:10:35.000Z",
        startedAt: "2026-02-27T00:10:35.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [priorTerminal],
    });

    const afterDelayedProgress = applyOrchestrationEvent(
      makeState(thread),
      makeEvent(
        "thread.activity-appended",
        { threadId: thread.id, activity: delayedTerminalProgress },
        { sequence: 20 },
      ),
      localEnvironmentId,
    );
    const live = applyOrchestrationEvent(
      afterDelayedProgress,
      makeEvent(
        "thread.activity-appended",
        { threadId: thread.id, activity: restart },
        { sequence: 21 },
      ),
      localEnvironmentId,
    );
    const liveThread = threadsOf(live)[0]!;
    expect(
      liveThread.activities
        .filter((activity) => activity.createdAt === collidedAt)
        .map((activity) => [activity.id, activity.sequence]),
    ).toEqual([
      ["z-delayed-terminal-progress", 20],
      ["a-new-generation-start", 21],
    ]);
    expect(
      deriveActiveSubagentWorkEntries(liveThread.activities, turnId)[0]?.subagent,
    ).toMatchObject({
      id: childId,
      status: "active",
      startedAt: restartedAt,
    });

    // A detail reconnect does not have the enclosing events. The server
    // snapshot therefore carries their canonical aggregate sequences on each
    // activity. Reverse the transport array to prove semantic reconstruction
    // is sequence-driven and matches the live reducer.
    const reconnected = syncServerThreadDetail(
      makeEmptyState(),
      {
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
        updatedAt: collidedAt,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: liveThread.activities.toReversed(),
        checkpoints: [],
        session: null,
        goal: null,
      },
      localEnvironmentId,
      21,
    );
    const reconnectedActivities = threadsOf(reconnected)[0]?.activities ?? [];
    expect(
      deriveActiveSubagentWorkEntries(reconnectedActivities, turnId)[0]?.subagent,
    ).toMatchObject({
      id: childId,
      status: "active",
      startedAt: restartedAt,
    });
  });

  it.each(["running", "completed"] as const)(
    "retains only one valid exact-current configuration beyond 500 rows while %s and after snapshot reload",
    (state) => {
      const turnId = TurnId.make("long-settings-turn");
      const configurations = [
        makeTurnConfigurationActivity({ id: "settings-obsolete", turnId, sequence: 1 }),
        makeTurnConfigurationActivity({
          id: "settings-other-turn",
          turnId: TurnId.make("historical-settings-turn"),
          sequence: 2,
        }),
        makeTurnConfigurationActivity({ id: "settings-latest", turnId, sequence: 3 }),
        makeTurnConfigurationActivity({
          id: "settings-malformed",
          turnId,
          sequence: 4,
          providerDisplayName: "x".repeat(201),
        }),
      ];
      const ordinaryTail: Thread["activities"] = Array.from({ length: 500 }, (_, index) => ({
        id: EventId.make(`settings-tail-${index}`),
        tone: "tool" as const,
        kind: "tool.completed",
        summary: "Ordinary activity",
        payload: {},
        turnId,
        sequence: index + 5,
        createdAt: "2026-02-27T00:01:00.000Z",
      }));
      const thread = makeThread({
        latestTurn: {
          turnId,
          state,
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:01.000Z",
          completedAt: state === "completed" ? "2026-02-27T00:02:00.000Z" : null,
          assistantMessageId: null,
        },
        activities: [...configurations, ...ordinaryTail],
      });
      const newestActivity = {
        ...ordinaryTail[0]!,
        id: EventId.make("settings-tail-newest"),
        sequence: 505,
        createdAt: "2026-02-27T00:02:00.000Z",
      };
      const next = applyOrchestrationEvent(
        makeState(thread),
        makeEvent(
          "thread.activity-appended",
          { threadId: thread.id, activity: newestActivity },
          { sequence: 505 },
        ),
        localEnvironmentId,
      );
      const retained = threadsOf(next)[0]!.activities;
      expect(retained).toHaveLength(501);
      expect(
        retained.filter((activity) => activity.kind === "provider.turn.configuration"),
      ).toEqual([configurations[2]]);
      expect(retained.some((activity) => activity.id === "settings-tail-0")).toBe(false);

      // The server's compact snapshot carries this same one-row exception.
      // Reloading it and receiving further live events must not drop the row
      // merely because it remains chronologically older than the tool tail.
      const snapshot = syncServerThreadDetail(
        makeEmptyState(),
        {
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          latestTurn: threadsOf(next)[0]!.latestTurn,
          createdAt: thread.createdAt,
          updatedAt: "2026-02-27T00:02:00.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: retained,
          checkpoints: [],
          session: null,
          goal: null,
        },
        localEnvironmentId,
      );
      expect(threadsOf(snapshot)[0]?.activities).toHaveLength(501);
      const afterReload = applyOrchestrationEvent(
        snapshot,
        makeEvent(
          "thread.activity-appended",
          {
            threadId: thread.id,
            activity: {
              ...newestActivity,
              id: EventId.make("settings-after-reload"),
              sequence: 506,
            },
          },
          { sequence: 506 },
        ),
        localEnvironmentId,
      );
      const afterReloadActivities = threadsOf(afterReload)[0]!.activities;
      expect(afterReloadActivities).toHaveLength(501);
      expect(
        afterReloadActivities.filter((activity) => activity.kind === "provider.turn.configuration"),
      ).toEqual([configurations[2]]);
    },
  );

  it("retains compact subagent lifecycle state beyond the live activity tail", () => {
    const turnId = TurnId.make("turn-long-subagents");
    const child = {
      threadId: "provider-child-1",
      label: "Audit long turn",
      status: "active",
      startedAt: "2026-02-27T00:00:01.000Z",
    } as const;
    const lifecycle: Thread["activities"] = [
      {
        id: EventId.make("subagent-start"),
        tone: "info",
        kind: "task.started",
        summary: "Subagent started",
        payload: { taskId: child.threadId, subagent: child },
        turnId,
        sequence: 1,
        createdAt: "2026-02-27T00:00:01.000Z",
      },
      {
        id: EventId.make("subagent-progress-obsolete"),
        tone: "info",
        kind: "task.progress",
        summary: "Subagent update",
        payload: { taskId: child.threadId, detail: "Old detail", subagent: child },
        turnId,
        sequence: 2,
        createdAt: "2026-02-27T00:00:02.000Z",
      },
      {
        id: EventId.make("subagent-progress-latest"),
        tone: "info",
        kind: "task.progress",
        summary: "Subagent update",
        payload: { taskId: child.threadId, detail: "Latest detail", subagent: child },
        turnId,
        sequence: 3,
        createdAt: "2026-02-27T00:00:03.000Z",
      },
      {
        id: EventId.make("subagent-completed"),
        tone: "info",
        kind: "task.completed",
        summary: "Subagent completed",
        payload: {
          taskId: child.threadId,
          status: "completed",
          subagent: { ...child, status: "completed" },
        },
        turnId,
        sequence: 4,
        createdAt: "2026-02-27T00:00:04.000Z",
      },
    ];
    const ordinaryTail: Thread["activities"] = Array.from({ length: 500 }, (_, index) => ({
      id: EventId.make(`ordinary-${String(index + 1).padStart(4, "0")}`),
      tone: "tool" as const,
      kind: "tool.completed",
      summary: `Ordinary activity ${index + 1}`,
      payload: {},
      turnId,
      sequence: index + 5,
      createdAt: "2026-02-27T00:01:00.000Z",
    }));
    const thread = makeThread({
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [...lifecycle, ...ordinaryTail],
    });

    const next = applyOrchestrationEvent(
      makeState(thread),
      makeEvent(
        "thread.activity-appended",
        {
          threadId: thread.id,
          activity: {
            id: EventId.make("ordinary-newest"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Newest ordinary activity",
            payload: {},
            turnId,
            sequence: 505,
            createdAt: "2026-02-27T00:02:00.000Z",
          },
        },
        { sequence: 2_000 },
      ),
      localEnvironmentId,
    );

    const retained = threadsOf(next)[0]?.activities ?? [];
    expect(retained).toHaveLength(503);
    expect(retained.some((activity) => activity.id === "subagent-progress-obsolete")).toBe(false);
    expect(
      retained
        .filter((activity) => activity.kind.startsWith("task."))
        .map((activity) => activity.id),
    ).toEqual(["subagent-start", "subagent-progress-latest", "subagent-completed"]);
  });

  it("retains an active structured child from an older turn across a later turn's activity tail", () => {
    const olderTurnId = TurnId.make("turn-background-child");
    const currentTurnId = TurnId.make("turn-current-work");
    const start: Thread["activities"][number] = {
      id: EventId.make("older-turn-subagent-start"),
      tone: "info",
      kind: "task.started",
      summary: "Subagent started",
      payload: {
        taskId: "provider-background-child",
        subagent: {
          threadId: "provider-background-child",
          label: "Background audit",
          status: "active",
          startedAt: "2026-02-27T00:00:01.000Z",
        },
      },
      turnId: olderTurnId,
      sequence: 1,
      createdAt: "2026-02-27T00:00:01.000Z",
    };
    const ordinaryTail: Thread["activities"] = Array.from({ length: 500 }, (_, index) => ({
      id: EventId.make(`cross-turn-ordinary-${String(index + 1).padStart(4, "0")}`),
      tone: "tool" as const,
      kind: "tool.completed",
      summary: "Ordinary current-turn activity",
      payload: {},
      turnId: currentTurnId,
      sequence: index + 2,
      createdAt: "2026-02-27T00:01:00.000Z",
    }));
    const thread = makeThread({
      latestTurn: {
        turnId: currentTurnId,
        state: "running",
        requestedAt: "2026-02-27T00:00:30.000Z",
        startedAt: "2026-02-27T00:00:30.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [start, ...ordinaryTail],
    });

    const next = applyOrchestrationEvent(
      makeState(thread),
      makeEvent(
        "thread.activity-appended",
        {
          threadId: thread.id,
          activity: {
            ...ordinaryTail[0]!,
            id: EventId.make("cross-turn-ordinary-newest"),
            sequence: 502,
            createdAt: "2026-02-27T00:02:00.000Z",
          },
        },
        { sequence: 2_050 },
      ),
      localEnvironmentId,
    );

    const retained = threadsOf(next)[0]?.activities ?? [];
    expect(retained).toHaveLength(501);
    expect(retained).toContainEqual(start);
    expect(
      deriveActiveSubagentWorkEntries(retained, currentTurnId).map((entry) => entry.subagent?.id),
    ).toEqual(["provider-background-child"]);
  });

  it("retains prior-turn terminal authority when delayed progress outlives the ordinary tail", () => {
    const olderTurnId = TurnId.make("turn-terminal-background-child");
    const currentTurnId = TurnId.make("turn-after-terminal-child");
    const presentation = {
      threadId: "provider-terminal-child",
      label: "Completed audit",
      status: "active",
      startedAt: "2026-02-27T00:00:01.000Z",
    } as const;
    const lifecycle: Thread["activities"] = [
      {
        id: EventId.make("prior-child-start"),
        tone: "info",
        kind: "task.started",
        summary: "Subagent started",
        payload: { taskId: presentation.threadId, subagent: presentation },
        turnId: olderTurnId,
        sequence: 1,
        createdAt: "2026-02-27T00:00:01.000Z",
      },
      {
        id: EventId.make("prior-child-completed"),
        tone: "info",
        kind: "task.completed",
        summary: "Subagent completed",
        payload: {
          taskId: presentation.threadId,
          status: "completed",
          subagent: { ...presentation, status: "completed" },
        },
        turnId: olderTurnId,
        sequence: 2,
        createdAt: "2026-02-27T00:00:02.000Z",
      },
      {
        id: EventId.make("prior-child-delayed-progress"),
        tone: "info",
        kind: "task.progress",
        summary: "Subagent update",
        payload: {
          taskId: presentation.threadId,
          detail: "Delayed replay",
          subagent: presentation,
        },
        turnId: olderTurnId,
        sequence: 3,
        createdAt: "2026-02-27T00:00:03.000Z",
      },
    ];
    const ordinaryTail: Thread["activities"] = Array.from({ length: 500 }, (_, index) => ({
      id: EventId.make(`terminal-boundary-ordinary-${String(index + 1).padStart(4, "0")}`),
      tone: "tool" as const,
      kind: "tool.completed",
      summary: "Ordinary later-turn activity",
      payload: {},
      turnId: currentTurnId,
      sequence: index + 4,
      createdAt: "2026-02-27T00:01:00.000Z",
    }));
    const thread = makeThread({
      latestTurn: {
        turnId: currentTurnId,
        state: "running",
        requestedAt: "2026-02-27T00:00:30.000Z",
        startedAt: "2026-02-27T00:00:30.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [...lifecycle, ...ordinaryTail],
    });

    const next = applyOrchestrationEvent(
      makeState(thread),
      makeEvent(
        "thread.activity-appended",
        {
          threadId: thread.id,
          activity: {
            ...ordinaryTail[0]!,
            id: EventId.make("terminal-boundary-ordinary-newest"),
            sequence: 504,
            createdAt: "2026-02-27T00:02:00.000Z",
          },
        },
        { sequence: 2_060 },
      ),
      localEnvironmentId,
    );

    const retained = threadsOf(next)[0]?.activities ?? [];
    expect(
      retained.filter((activity) => activity.turnId === olderTurnId).map((activity) => activity.id),
    ).toEqual(["prior-child-start", "prior-child-completed", "prior-child-delayed-progress"]);
    expect(deriveSubagentWorkEntries(retained, olderTurnId)[0]?.subagent).toMatchObject({
      id: presentation.threadId,
      status: "completed",
      completedAt: "2026-02-27T00:00:02.000Z",
    });
    expect(deriveActiveSubagentWorkEntries(retained, currentTurnId)).toEqual([]);
  });

  it("retains explicit restart authority after a prior-turn terminal edge", () => {
    const olderTurnId = TurnId.make("turn-restarted-background-child");
    const currentTurnId = TurnId.make("turn-after-restarted-child");
    const childId = "provider-restarted-child";
    const lifecycle: Thread["activities"] = [
      {
        id: EventId.make("restarted-child-completed"),
        tone: "info",
        kind: "task.completed",
        summary: "Subagent completed",
        payload: {
          taskId: childId,
          status: "completed",
          subagent: { threadId: childId, label: "Reusable worker", status: "completed" },
        },
        turnId: olderTurnId,
        sequence: 1,
        createdAt: "2026-02-27T00:00:01.000Z",
      },
      {
        id: EventId.make("restarted-child-start"),
        tone: "info",
        kind: "task.started",
        summary: "Subagent restarted",
        payload: {
          taskId: childId,
          subagent: {
            threadId: childId,
            label: "Reusable worker",
            status: "active",
            startedAt: "2026-02-27T00:00:02.000Z",
          },
        },
        turnId: olderTurnId,
        sequence: 2,
        createdAt: "2026-02-27T00:00:02.000Z",
      },
      {
        id: EventId.make("restarted-child-progress"),
        tone: "info",
        kind: "task.progress",
        summary: "Subagent update",
        payload: {
          taskId: childId,
          detail: "Working after restart",
          subagent: { threadId: childId, label: "Reusable worker", status: "active" },
        },
        turnId: olderTurnId,
        sequence: 3,
        createdAt: "2026-02-27T00:00:03.000Z",
      },
    ];
    const ordinaryTail: Thread["activities"] = Array.from({ length: 500 }, (_, index) => ({
      id: EventId.make(`restart-boundary-ordinary-${String(index + 1).padStart(4, "0")}`),
      tone: "tool" as const,
      kind: "tool.completed",
      summary: "Ordinary later-turn activity",
      payload: {},
      turnId: currentTurnId,
      sequence: index + 4,
      createdAt: "2026-02-27T00:01:00.000Z",
    }));
    const thread = makeThread({
      latestTurn: {
        turnId: currentTurnId,
        state: "running",
        requestedAt: "2026-02-27T00:00:30.000Z",
        startedAt: "2026-02-27T00:00:30.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [...lifecycle, ...ordinaryTail],
    });
    const next = applyOrchestrationEvent(
      makeState(thread),
      makeEvent(
        "thread.activity-appended",
        {
          threadId: thread.id,
          activity: {
            ...ordinaryTail[0]!,
            id: EventId.make("restart-boundary-ordinary-newest"),
            sequence: 504,
          },
        },
        { sequence: 2_070 },
      ),
      localEnvironmentId,
    );
    const retained = threadsOf(next)[0]?.activities ?? [];

    expect(
      retained.filter((activity) => activity.turnId === olderTurnId).map((activity) => activity.id),
    ).toEqual(["restarted-child-completed", "restarted-child-start", "restarted-child-progress"]);
    expect(deriveActiveSubagentWorkEntries(retained, currentTurnId)[0]?.subagent).toMatchObject({
      id: childId,
      status: "active",
      startedAt: "2026-02-27T00:00:02.000Z",
    });
  });

  it("retains an older visible start and its ambient visibility tombstone together", () => {
    const olderTurnId = TurnId.make("turn-ambient-background-child");
    const currentTurnId = TurnId.make("turn-after-ambient-child");
    const childId = "provider-ambient-child";
    const lifecycle: Thread["activities"] = [
      {
        id: EventId.make("ambient-boundary-start"),
        tone: "info",
        kind: "task.started",
        summary: "Subagent started",
        payload: {
          taskId: childId,
          visibility: "visible",
          subagent: { threadId: childId, label: "Ambient worker", status: "active" },
        },
        turnId: olderTurnId,
        sequence: 1,
        createdAt: "2026-02-27T00:00:01.000Z",
      },
      {
        id: EventId.make("ambient-boundary-hidden"),
        tone: "info",
        kind: "task.progress",
        summary: "Subagent visibility changed",
        payload: { taskId: childId, visibility: "ambient" },
        turnId: olderTurnId,
        sequence: 2,
        createdAt: "2026-02-27T00:00:02.000Z",
      },
    ];
    const ordinaryTail: Thread["activities"] = Array.from({ length: 500 }, (_, index) => ({
      id: EventId.make(`ambient-boundary-ordinary-${String(index + 1).padStart(4, "0")}`),
      tone: "tool" as const,
      kind: "tool.completed",
      summary: "Ordinary later-turn activity",
      payload: {},
      turnId: currentTurnId,
      sequence: index + 3,
      createdAt: "2026-02-27T00:01:00.000Z",
    }));
    const thread = makeThread({
      latestTurn: {
        turnId: currentTurnId,
        state: "running",
        requestedAt: "2026-02-27T00:00:30.000Z",
        startedAt: "2026-02-27T00:00:30.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [...lifecycle, ...ordinaryTail],
    });
    const next = applyOrchestrationEvent(
      makeState(thread),
      makeEvent(
        "thread.activity-appended",
        {
          threadId: thread.id,
          activity: {
            ...ordinaryTail[0]!,
            id: EventId.make("ambient-boundary-ordinary-newest"),
            sequence: 503,
          },
        },
        { sequence: 2_080 },
      ),
      localEnvironmentId,
    );
    const retained = threadsOf(next)[0]?.activities ?? [];

    expect(
      retained.filter((activity) => activity.turnId === olderTurnId).map((activity) => activity.id),
    ).toEqual(["ambient-boundary-start", "ambient-boundary-hidden"]);
    expect(deriveSubagentWorkEntries(retained, olderTurnId)).toEqual([]);
  });

  it("caps compact lifecycle retention across adversarial identities from multiple turns", () => {
    const turnId = TurnId.make("turn-subagent-cardinality-limit");
    const olderTurnId = TurnId.make("turn-subagent-cardinality-older");
    const lifecycle: Thread["activities"] = Array.from(
      { length: MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN + 1 },
      (_, index) => ({
        id: EventId.make(`subagent-cardinality-${String(index).padStart(5, "0")}`),
        tone: "info" as const,
        kind: "task.started",
        summary: "Subagent started",
        payload: {
          taskId: `child-${index}`,
          subagent: { threadId: `child-${index}`, status: "active" },
        },
        turnId: index % 2 === 0 ? olderTurnId : turnId,
        sequence: index + 1,
        createdAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    const ordinaryTail: Thread["activities"] = Array.from({ length: 500 }, (_, index) => ({
      id: EventId.make(`ordinary-cardinality-${String(index).padStart(4, "0")}`),
      tone: "tool" as const,
      kind: "tool.completed",
      summary: "Ordinary activity",
      payload: {},
      turnId,
      sequence: lifecycle.length + index + 1,
      createdAt: "2026-02-27T00:01:00.000Z",
    }));
    const thread = makeThread({
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [...lifecycle, ...ordinaryTail],
    });

    const next = applyOrchestrationEvent(
      makeState(thread),
      makeEvent(
        "thread.activity-appended",
        {
          threadId: thread.id,
          activity: {
            id: EventId.make("ordinary-cardinality-newest"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Newest ordinary activity",
            payload: {},
            turnId,
            sequence: lifecycle.length + ordinaryTail.length + 1,
            createdAt: "2026-02-27T00:02:00.000Z",
          },
        },
        { sequence: 2_100 },
      ),
      localEnvironmentId,
    );

    const retained = threadsOf(next)[0]?.activities ?? [];
    const retainedSubagentStarts = retained.filter((activity) => activity.kind === "task.started");
    expect(retainedSubagentStarts).toHaveLength(MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN);
    expect(retained).toHaveLength(MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN + 500);
    expect(retained.some((activity) => activity.id === "subagent-cardinality-00000")).toBe(false);
  });
});
