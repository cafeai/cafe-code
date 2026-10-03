import { describe, expect, it } from "vitest";
import type {
  EnvironmentId,
  EventId,
  OrchestrationThreadActivity,
  ProjectId,
  ProviderTurnConfiguration,
  TaskAtriumErrorDismissal,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";

import type { AppState } from "../../store";
import {
  formatElapsed,
  formatAtriumCardElapsed,
  mergeTaskAtriumErrorDismissals,
  selectAtriumSnapshot,
} from "./taskAtriumData";

const ENV = "env-1" as EnvironmentId;
const THREAD = "thread-1" as ThreadId;
const PROJECT = "project-1" as ProjectId;
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

const TURN_CONFIGURATION: ProviderTurnConfiguration = {
  version: 1,
  provider: "codex" as ProviderTurnConfiguration["provider"],
  providerInstanceId: "codex_personal" as ProviderTurnConfiguration["providerInstanceId"],
  providerDisplayName: "Codex Personal",
  model: "gpt-6.1-sol",
  modelDisplayName: "GPT-6.1 Sol",
  effort: "ultra",
  fastMode: true,
  runtimeMode: "full-access",
  interactionMode: "default",
  settingsSource: "submitted",
};

function configurationActivity(
  configuration: unknown = TURN_CONFIGURATION,
  turnId: TurnId | null = "turn-1" as TurnId,
  id = "turn-configuration",
): OrchestrationThreadActivity {
  return {
    id: id as EventId,
    kind: "provider.turn.configuration",
    tone: "info",
    summary: "Turn accepted",
    payload: { turnConfiguration: configuration },
    turnId,
    createdAt: new Date(NOW - 40_000).toISOString(),
  };
}

function activity(
  id: string,
  kind: "tool.started" | "tool.completed" | "task.started" | "task.progress" | "task.completed",
  summary: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id,
    tone: "tool",
    kind,
    summary,
    payload,
    turnId: null,
    createdAt: new Date(NOW - 1000).toISOString(),
  } as OrchestrationThreadActivity;
}

function buildState(options: {
  activities?: OrchestrationThreadActivity[];
  status?: string;
  holding?: boolean;
  provider?: string;
  latestTurnState?: "running" | "interrupted" | "completed" | "error";
  turnId?: TurnId;
  sessionUpdatedAt?: string;
  completedAt?: string;
}): AppState {
  const activities = options.activities ?? [];
  const latestTurnState = options.latestTurnState ?? "running";
  const turnId = options.turnId ?? ("turn-1" as TurnId);
  const activityById: Record<string, OrchestrationThreadActivity> = {};
  for (const entry of activities) activityById[entry.id] = entry;

  return {
    activeEnvironmentId: ENV,
    environmentStateById: {
      [ENV]: {
        projectIds: [PROJECT],
        projectById: { [PROJECT]: { id: PROJECT, name: "cafe-code" } },
        threadIds: [THREAD],
        threadIdsByProjectId: {},
        threadShellById: {},
        threadSessionById: {},
        threadTurnStateById: {},
        messageIdsByThreadId: {},
        messageByThreadId: {},
        activityIdsByThreadId: { [THREAD]: activities.map((entry) => entry.id) },
        activityByThreadId: { [THREAD]: activityById },
        proposedPlanIdsByThreadId: {},
        proposedPlanByThreadId: {},
        turnDiffIdsByThreadId: {},
        turnDiffSummaryByThreadId: {},
        sidebarThreadSummaryById: {
          [THREAD]: {
            id: THREAD,
            environmentId: ENV,
            projectId: PROJECT,
            title: "Port the ambiance engine",
            session: {
              provider: options.provider ?? "claudeAgent",
              orchestrationStatus: options.status ?? "running",
              status: options.status === "error" ? "error" : "running",
              activeTurnId: turnId,
              createdAt: new Date(NOW - 60_000).toISOString(),
              updatedAt: options.sessionUpdatedAt ?? new Date(NOW - 10_000).toISOString(),
            },
            createdAt: new Date(NOW - 60_000).toISOString(),
            archivedAt: null,
            latestTurn: {
              turnId,
              state: latestTurnState,
              requestedAt: new Date(NOW - 45_000).toISOString(),
              startedAt: new Date(NOW - 45_000).toISOString(),
              completedAt:
                latestTurnState === "error" || latestTurnState === "completed"
                  ? (options.completedAt ?? new Date(NOW - 5_000).toISOString())
                  : null,
              assistantMessageId: null,
            },
            branch: null,
            worktreePath: null,
            latestUserMessageAt: null,
            hasPendingApprovals: options.holding ?? false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
          },
        },
        bootstrapComplete: true,
      },
    },
  } as unknown as AppState;
}

describe("selectAtriumSnapshot", () => {
  it("projects the accepted turn's frozen settings without consulting current selections", () => {
    const state = buildState({ provider: "codex", activities: [configurationActivity()] });
    const environment = state.environmentStateById[ENV]!;
    // The shell describes the next request and can change while a turn runs.
    // It must never become the source of the running card's sanity check.
    Object.assign(environment.threadShellById, {
      [THREAD]: {
        modelSelection: { provider: "codex_personal", model: "gpt-6-astra" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
      },
    });
    const first = selectAtriumSnapshot(state, NOW).cards[0]!;
    expect(first.turnConfiguration).toEqual(TURN_CONFIGURATION);
    const later = selectAtriumSnapshot(state, NOW + 1_000).cards[0]!;
    // Avoid schema decoding/new objects on each one-second Atrium clock tick.
    expect(later.turnConfiguration).toBe(first.turnConfiguration);
    expect(later.activityLabel).toBe("Turn accepted");
  });

  it("updates only after the exact latest turn changes, never from a newer unrelated record", () => {
    const future = configurationActivity(
      { ...TURN_CONFIGURATION, modelDisplayName: "GPT-6 Astra", effort: "max", fastMode: false },
      "turn-2" as TurnId,
      "future-configuration",
    );
    const state = buildState({
      provider: "codex",
      activities: [configurationActivity(), future],
    });
    const first = selectAtriumSnapshot(state, NOW).cards[0]!;
    expect(first.turnConfiguration?.modelDisplayName).toBe("GPT-6.1 Sol");
    const environment = state.environmentStateById[ENV]!;
    const summary = environment.sidebarThreadSummaryById[THREAD]!;
    summary.latestTurn = { ...summary.latestTurn!, turnId: "turn-2" as TurnId };
    summary.session = { ...summary.session!, activeTurnId: "turn-2" as TurnId };
    const next = selectAtriumSnapshot(state, NOW + 1_000).cards[0]!;
    expect(next.turnConfiguration?.modelDisplayName).toBe("GPT-6 Astra");
    expect(next.turnConfiguration).not.toBe(first.turnConfiguration);
  });

  it("accepts late immutable metadata while preserving completed parent timing", () => {
    const state = buildState({ status: "ready", latestTurnState: "completed" });
    const first = selectAtriumSnapshot(state, NOW).cards[0]!;
    expect(first.turnConfiguration).toBeNull();
    const environment = state.environmentStateById[ENV]!;
    const entry = configurationActivity({
      ...TURN_CONFIGURATION,
      provider: "claudeAgent",
      providerInstanceId: "claude_work",
      modelDisplayName: "Claude Opus 5.5",
      effort: "max",
      fastMode: false,
    });
    environment.activityIdsByThreadId[THREAD] = [entry.id];
    environment.activityByThreadId[THREAD] = { [entry.id]: entry };
    const later = selectAtriumSnapshot(state, NOW + 1_000).cards[0]!;
    expect(later.turnConfiguration?.modelDisplayName).toBe("Claude Opus 5.5");
    expect(later.turnConfiguration?.fastMode).toBe(false);
    expect(later.completedAt).toBe(first.completedAt);
  });

  it.each(["different-turn", null])("never borrows settings from turn %s", (turnId) => {
    const state = buildState({
      provider: "codex",
      activities: [configurationActivity(TURN_CONFIGURATION, turnId as TurnId | null)],
    });
    expect(selectAtriumSnapshot(state, NOW).cards[0]!.turnConfiguration).toBeNull();
  });

  it("does not show predecessor settings while a new active session turn is pending", () => {
    const state = buildState({ provider: "codex", activities: [configurationActivity()] });
    state.environmentStateById[ENV]!.sidebarThreadSummaryById[THREAD]!.session!.activeTurnId =
      "replacement-turn" as TurnId;
    expect(selectAtriumSnapshot(state, NOW).cards[0]!.turnConfiguration).toBeNull();
  });

  it("rejects snapshots from a different driver or known account instance", () => {
    const wrongDriver = buildState({ activities: [configurationActivity()] });
    expect(selectAtriumSnapshot(wrongDriver, NOW).cards[0]!.turnConfiguration).toBeNull();
    const wrongAccount = buildState({ provider: "codex", activities: [configurationActivity()] });
    wrongAccount.environmentStateById[ENV]!.sidebarThreadSummaryById[
      THREAD
    ]!.session!.providerInstanceId =
      "codex_other" as ProviderTurnConfiguration["providerInstanceId"];
    expect(selectAtriumSnapshot(wrongAccount, NOW).cards[0]!.turnConfiguration).toBeNull();
  });

  it.each([
    { ...TURN_CONFIGURATION, modelDisplayName: "forged\u202Elabel" },
    { ...TURN_CONFIGURATION, version: 2 },
    { ...TURN_CONFIGURATION, fastMode: "false" },
  ])("fails closed for malformed turn settings %j", (configuration) => {
    const state = buildState({
      provider: "codex",
      activities: [configurationActivity(configuration)],
    });
    expect(selectAtriumSnapshot(state, NOW).cards[0]!.turnConfiguration).toBeNull();
  });

  it("exposes only validated public metadata, not arbitrary credential-like payload fields", () => {
    const state = buildState({
      provider: "codex",
      activities: [
        configurationActivity({
          ...TURN_CONFIGURATION,
          authEmail: "private@example.invalid",
          apiKey: "synthetic-secret",
          options: { authToken: "synthetic-token" },
        }),
      ],
    });
    expect(selectAtriumSnapshot(state, NOW).cards[0]!.turnConfiguration).toEqual(
      TURN_CONFIGURATION,
    );
  });

  it("keeps missing legacy settings unknown rather than guessing defaults", () => {
    expect(selectAtriumSnapshot(buildState({}), NOW).cards[0]!.turnConfiguration).toBeNull();
  });

  it.each(["completed", "error"] as const)(
    "freezes the %s parent duration across late worker/title updates",
    (latestTurnState) => {
      const completedAt = NOW - 5_000;
      const state = buildState({
        latestTurnState,
        status: latestTurnState === "error" ? "error" : "ready",
        completedAt: new Date(completedAt).toISOString(),
        activities: [
          activity("worker-completed", "task.completed", "Worker completed", {
            taskId: "worker",
            status: "completed",
            subagent: { threadId: "worker", label: "Original name", status: "completed" },
          }),
        ],
      });
      const first = selectAtriumSnapshot(state, NOW).cards[0]!;
      expect(first.completedAt).toBe(completedAt);
      expect(formatAtriumCardElapsed(first, NOW)).toBe("40s");
      const environment = state.environmentStateById[ENV]!;
      environment.sidebarThreadSummaryById[THREAD]!.title = "Renamed after completion";
      const rename = {
        ...activity("worker-renamed", "task.progress", "Worker renamed", {
          taskId: "worker",
          subagent: { threadId: "worker", label: "Late worker name", status: "active" },
        }),
        createdAt: new Date(NOW + 30_000).toISOString(),
      };
      environment.activityIdsByThreadId[THREAD] = [
        ...environment.activityIdsByThreadId[THREAD]!,
        rename.id,
      ];
      environment.activityByThreadId[THREAD] = {
        ...environment.activityByThreadId[THREAD],
        [rename.id]: rename,
      };
      const later = selectAtriumSnapshot(state, NOW + 30_000).cards[0]!;
      expect(later.title).toBe("Renamed after completion");
      expect(later.subagents).not.toBe(first.subagents);
      expect(later.completedAt).toBe(completedAt);
      expect(formatAtriumCardElapsed(later, NOW + 30_000)).toBe("40s");
    },
  );

  it("uses a session failure's own edge rather than an unrelated prior turn completion", () => {
    const state = buildState({
      status: "error",
      latestTurnState: "completed",
      sessionUpdatedAt: new Date(NOW - 1_000).toISOString(),
    });
    const card = selectAtriumSnapshot(state, NOW).cards[0]!;
    expect(card.completedAt).toBe(NOW - 1_000);
    expect(formatAtriumCardElapsed(card, NOW + 60_000)).toBe("44s");
  });

  it("keeps live parent time ticking but never guesses a missing terminal boundary", () => {
    const card = selectAtriumSnapshot(buildState({}), NOW).cards[0]!;
    expect(card.completedAt).toBeNull();
    expect(formatAtriumCardElapsed(card, NOW)).toBe("45s");
    expect(formatAtriumCardElapsed(card, NOW + 1_000)).toBe("46s");
    expect(formatAtriumCardElapsed({ ...card, state: "done", completedAt: null }, NOW)).toBe("");
  });

  it("does not use a failed turn's dismissal-identity fallback as its completion time", () => {
    const state = buildState({ latestTurnState: "error", status: "ready" });
    const summary = state.environmentStateById[ENV]!.sidebarThreadSummaryById[THREAD]!;
    summary.latestTurn = { ...summary.latestTurn!, completedAt: null };
    const card = selectAtriumSnapshot(state, NOW).cards[0]!;
    expect(card.state).toBe("error");
    expect(card.errorDismissal?.observedAt).toBe(new Date(NOW - 45_000).toISOString());
    expect(card.completedAt).toBeNull();
    expect(formatAtriumCardElapsed(card, NOW + 30_000)).toBe("");
  });

  it("surfaces a standalone running chat without a project or an eager detail lookup", () => {
    const state = buildState({});
    const environment = state.environmentStateById[ENV]!;
    environment.projectIds = [];
    environment.projectById = {};
    environment.sidebarThreadSummaryById[THREAD]!.projectId = null;
    const snapshot = selectAtriumSnapshot(state, NOW);
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0]).toMatchObject({
      environmentId: ENV,
      threadId: THREAD,
      projectName: "",
      state: "running",
    });
    expect(snapshot.runningCount).toBe(1);
  });
  it("surfaces a running thread with its project and elapsed start", () => {
    const snapshot = selectAtriumSnapshot(buildState({}), NOW);
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0]?.state).toBe("running");
    expect(snapshot.cards[0]?.title).toBe("Port the ambiance engine");
    expect(snapshot.cards[0]?.projectName).toBe("cafe-code");
    expect(snapshot.runningCount).toBe(1);
  });

  it("sorts a thread waiting on the user ahead of running work", () => {
    const snapshot = selectAtriumSnapshot(buildState({ holding: true }), NOW);
    expect(snapshot.cards[0]?.state).toBe("holding");
    expect(snapshot.holdingCount).toBe(1);
  });

  // Claude reports subagents as `Task`/`*agent*` tools, which the adapter
  // classifies to the same canonical item type Codex uses.
  it("extracts Claude subagents from collab_agent_tool_call detail", () => {
    const snapshot = selectAtriumSnapshot(
      buildState({
        provider: "claudeAgent",
        activities: [
          activity("a1", "tool.started", "Subagent task started", {
            itemType: "collab_agent_tool_call",
            itemId: "task-1",
            title: "Subagent task",
            detail: "explore: mapping canvas call sites",
          }),
        ],
      }),
      NOW,
    );
    const [card] = snapshot.cards;
    expect(card?.subagents[0]).toMatchObject({
      id: "task-1",
      label: "explore",
      detail: "mapping canvas call sites",
      status: "active",
      running: true,
    });
    expect(snapshot.subagentCount).toBe(1);
  });

  it("extracts Codex subagents from agent-path detail", () => {
    const snapshot = selectAtriumSnapshot(
      buildState({
        provider: "codex",
        activities: [
          activity("a1", "tool.started", "Subagent task started", {
            itemType: "collab_agent_tool_call",
            itemId: "sub-1",
            detail: "Started /root/tests",
          }),
        ],
      }),
      NOW,
    );
    expect(snapshot.cards[0]?.subagents[0]).toMatchObject({
      rowKey: "a1",
      id: "sub-1",
      label: "Tests",
      detail: "Working",
      status: "active",
      running: true,
      startedAt: NOW - 1_000,
      completedAt: null,
    });
  });

  it("coalesces structured Claude lifecycle with stable identity, progress and timing", () => {
    const startedAt = new Date(NOW - 65_000).toISOString();
    const snapshot = selectAtriumSnapshot(
      buildState({
        provider: "claudeAgent",
        activities: [
          {
            ...activity("task-start", "task.started", "Subagent started", {
              taskId: "claude-task-1",
              taskType: "local_agent",
              detail: "Audit the renderer",
              subagent: {
                threadId: "claude-task-1",
                label: "Audit the renderer",
                role: "code-reviewer",
                objective: "Audit the renderer for lifecycle gaps",
                status: "active",
                startedAt,
              },
            }),
            createdAt: new Date(NOW - 2_000).toISOString(),
          },
          activity("task-progress", "task.progress", "Subagent update", {
            taskId: "claude-task-1",
            detail: "Checking activity projection",
            subagent: {
              threadId: "claude-task-1",
              label: "Audit the renderer",
              status: "active",
              startedAt,
            },
          }),
        ],
      }),
      NOW,
    );

    expect(snapshot.cards[0]?.subagents).toMatchObject([
      {
        rowKey: "task-start",
        id: "claude-task-1",
        label: "Audit the renderer",
        detail: "Checking activity projection",
        status: "active",
        running: true,
        startedAt: NOW - 65_000,
        completedAt: null,
      },
    ]);
  });

  it("retracts ambient Claude tasks from Atrium and restores later visible work", () => {
    const turnId = "turn-ambient-atrium" as TurnId;
    const presentation = {
      threadId: "claude-ambient-atrium",
      label: "Watch provider state",
      status: "active" as const,
      startedAt: new Date(NOW - 65_000).toISOString(),
    };
    const started = {
      ...activity("ambient-start", "task.started", "Subagent started", {
        taskId: presentation.threadId,
        visibility: "visible",
        subagent: presentation,
      }),
      turnId,
      createdAt: new Date(NOW - 3_000).toISOString(),
    };
    const hidden = {
      ...activity("ambient-hide", "task.progress", "Subagent visibility changed", {
        taskId: presentation.threadId,
        visibility: "ambient",
      }),
      turnId,
      createdAt: new Date(NOW - 2_000).toISOString(),
    };
    const restored = {
      ...activity("ambient-restore", "task.progress", "Subagent update", {
        taskId: presentation.threadId,
        detail: "Visible again",
        visibility: "visible",
        subagent: presentation,
      }),
      turnId,
      createdAt: new Date(NOW - 1_000).toISOString(),
    };

    const hiddenSnapshot = selectAtriumSnapshot(
      buildState({ activities: [started, hidden], turnId }),
      NOW,
    );
    expect(hiddenSnapshot.cards[0]?.subagents).toEqual([]);
    expect(hiddenSnapshot.subagentCount).toBe(0);

    const restoredSnapshot = selectAtriumSnapshot(
      buildState({ activities: [started, hidden, restored], turnId }),
      NOW,
    );
    expect(restoredSnapshot.cards[0]?.subagents).toHaveLength(1);
    expect(restoredSnapshot.cards[0]?.subagents[0]).toMatchObject({
      id: presentation.threadId,
      detail: "Visible again",
      running: true,
    });
  });

  it("collapses a started/completed pair into one row and marks it finished", () => {
    const snapshot = selectAtriumSnapshot(
      buildState({
        activities: [
          activity("a1", "tool.started", "Subagent task started", {
            itemType: "collab_agent_tool_call",
            itemId: "task-1",
            detail: "explore: scanning",
          }),
          activity("a2", "tool.completed", "Subagent task", {
            itemType: "collab_agent_tool_call",
            itemId: "task-1",
            detail: "explore: scanning",
          }),
        ],
      }),
      NOW,
    );
    expect(snapshot.cards[0]?.subagents).toHaveLength(1);
    expect(snapshot.cards[0]?.subagents[0]?.running).toBe(false);
    expect(snapshot.subagentCount).toBe(0);
  });

  it("returns every subagent row without an overflow remainder", () => {
    const activities = Array.from({ length: 8 }, (_, index) =>
      activity(`a${index}`, "tool.started", "Subagent task started", {
        itemType: "collab_agent_tool_call",
        itemId: `task-${index}`,
        detail: `agent-${index}: working`,
      }),
    );
    const snapshot = selectAtriumSnapshot(buildState({ activities }), NOW);
    expect(snapshot.cards[0]?.subagents).toHaveLength(8);
    expect(snapshot.cards[0]?.subagents.map((subagent) => subagent.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `task-${index}`),
    );
  });

  it("retains distinct row keys when one provider child is reused across turns", () => {
    const childId = "shared-provider-child";
    const firstTurn = {
      ...activity("first-turn-start", "task.started", "Subagent started", {
        taskId: childId,
        taskType: "subagent",
        detail: "Inspect the first turn",
        subagent: {
          threadId: childId,
          label: "Shared worker",
          status: "completed",
        },
      }),
      turnId: "turn-1" as TurnId,
    };
    const secondTurn = {
      ...activity("second-turn-start", "task.started", "Subagent started", {
        taskId: childId,
        taskType: "subagent",
        detail: "Continue in the next turn",
        subagent: {
          threadId: childId,
          label: "Shared worker",
          status: "active",
        },
      }),
      turnId: "turn-2" as TurnId,
    };

    const snapshot = selectAtriumSnapshot(buildState({ activities: [firstTurn, secondTurn] }), NOW);

    expect(snapshot.cards[0]?.subagents).toHaveLength(2);
    expect(snapshot.cards[0]?.subagents.map((subagent) => subagent.id)).toEqual([childId, childId]);
    expect(snapshot.cards[0]?.subagents.map((subagent) => subagent.rowKey)).toEqual([
      "second-turn-start",
      "first-turn-start",
    ]);
    expect(new Set(snapshot.cards[0]?.subagents.map((subagent) => subagent.rowKey)).size).toBe(2);
  });

  it("settles a legacy child row when its owning turn is terminal", () => {
    const legacy = {
      ...activity("legacy-child", "tool.completed", "Subagent task", {
        itemType: "collab_agent_tool_call",
        itemId: "legacy-child-id",
        detail: "Started /root/legacy_audit",
      }),
      turnId: "turn-1" as TurnId,
    };
    const snapshot = selectAtriumSnapshot(
      buildState({
        activities: [legacy],
        latestTurnState: "completed",
        status: "ready",
      }),
      NOW,
    );

    expect(snapshot.cards[0]?.state).toBe("done");
    expect(snapshot.cards[0]?.subagents[0]).toMatchObject({
      id: "legacy-child-id",
      status: "completed",
      running: false,
    });
    expect(snapshot.subagentCount).toBe(0);
  });

  it("reuses subagent derivation across clock-only snapshot updates", () => {
    const state = buildState({
      activities: [
        activity("subagent", "task.started", "Subagent started", {
          taskId: "cached-child",
          subagent: {
            threadId: "cached-child",
            label: "Cached worker",
            status: "active",
          },
        }),
        ...Array.from({ length: 500 }, (_, index) =>
          activity(`ordinary-${index}`, "tool.completed", "Command completed", {
            itemType: "command_execution",
            itemId: `command-${index}`,
          }),
        ),
      ],
    });

    const first = selectAtriumSnapshot(state, NOW);
    const clockOnly = selectAtriumSnapshot(state, NOW + 1_000);

    expect(first.cards[0]?.subagents).toHaveLength(1);
    expect(clockOnly.cards[0]?.subagents).toBe(first.cards[0]?.subagents);
  });

  it("ignores non-subagent tool activity", () => {
    const snapshot = selectAtriumSnapshot(
      buildState({
        activities: [
          activity("a1", "tool.started", "Command run started", {
            itemType: "command_execution",
            itemId: "cmd-1",
            detail: "yarn build",
          }),
        ],
      }),
      NOW,
    );
    expect(snapshot.cards[0]?.subagents).toHaveLength(0);
    expect(snapshot.cards[0]?.activityLabel).toBe("Command run");
    expect(snapshot.cards[0]?.activityDetail).toBe("yarn build");
  });

  it("drops idle threads that have nothing to report", () => {
    const state = buildState({ status: "ready" });
    const summary = state.environmentStateById[ENV]!.sidebarThreadSummaryById[THREAD]!;
    summary.latestTurn = null;
    expect(selectAtriumSnapshot(state, NOW).cards).toHaveLength(0);
  });

  it("suppresses only the exact historical error occurrence that was cleared", () => {
    const failedState = buildState({ status: "error", latestTurnState: "error" });
    const initial = selectAtriumSnapshot(failedState, NOW);
    const dismissed = initial.cards[0]?.errorDismissal;

    expect(initial.errorCount).toBe(1);
    expect(dismissed).not.toBeNull();
    if (!dismissed) throw new Error("Expected an error occurrence watermark");
    expect(selectAtriumSnapshot(failedState, NOW, [dismissed]).cards).toHaveLength(0);

    const settledProjection = buildState({
      status: "error",
      latestTurnState: "error",
      completedAt: new Date(NOW - 2_000).toISOString(),
    });
    expect(selectAtriumSnapshot(settledProjection, NOW, [dismissed]).cards).toHaveLength(0);

    const laterFailure = buildState({
      status: "error",
      latestTurnState: "error",
      turnId: "turn-2" as TurnId,
    });
    const later = selectAtriumSnapshot(laterFailure, NOW, [dismissed]);
    expect(later.errorCount).toBe(1);
    expect(later.cards[0]?.errorDismissal?.turnId).toBe("turn-2");
  });

  it("uses the transition timestamp to distinguish turnless session failures", () => {
    const firstState = buildState({
      status: "error",
      sessionUpdatedAt: "2026-08-25T01:00:00.000Z",
    });
    const firstSummary = firstState.environmentStateById[ENV]!.sidebarThreadSummaryById[THREAD]!;
    firstSummary.latestTurn = null;
    if (!firstSummary.session) throw new Error("Expected a session fixture");
    firstSummary.session.activeTurnId = undefined;

    const dismissed = selectAtriumSnapshot(firstState, NOW).cards[0]?.errorDismissal;
    expect(dismissed?.turnId).toBeNull();
    if (!dismissed) throw new Error("Expected a turnless error occurrence watermark");
    expect(selectAtriumSnapshot(firstState, NOW, [dismissed]).cards).toHaveLength(0);

    const laterState = buildState({
      status: "error",
      sessionUpdatedAt: "2026-08-25T02:00:00.000Z",
    });
    const laterSummary = laterState.environmentStateById[ENV]!.sidebarThreadSummaryById[THREAD]!;
    laterSummary.latestTurn = null;
    if (!laterSummary.session) throw new Error("Expected a session fixture");
    laterSummary.session.activeTurnId = undefined;

    expect(selectAtriumSnapshot(laterState, NOW, [dismissed]).errorCount).toBe(1);
  });

  it("ages a stale failure off the board without needing a dismissal", () => {
    const state = buildState({ status: "error" });
    const summary = state.environmentStateById[ENV]!.sidebarThreadSummaryById[THREAD]!;
    // A thread that failed days ago is history, not current work. Leaving it
    // pinned forever is what made the board read as permanently broken.
    summary.session = {
      ...summary.session!,
      orchestrationStatus: "error",
      updatedAt: new Date(NOW - 40 * 60 * 60 * 1000).toISOString(),
    };
    summary.latestTurn = null;
    expect(selectAtriumSnapshot(state, NOW).cards).toHaveLength(0);
  });

  it("still shows a failure that happened recently", () => {
    const state = buildState({ status: "error" });
    const summary = state.environmentStateById[ENV]!.sidebarThreadSummaryById[THREAD]!;
    summary.session = {
      ...summary.session!,
      orchestrationStatus: "error",
      updatedAt: new Date(NOW - 60_000).toISOString(),
    };
    summary.latestTurn = null;
    const snapshot = selectAtriumSnapshot(state, NOW);
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0]?.state).toBe("error");
  });

  it("keeps one most-recent dismissal per scoped thread", () => {
    const first: TaskAtriumErrorDismissal = {
      environmentId: ENV,
      threadId: THREAD,
      turnId: "turn-1" as TurnId,
      observedAt: "2026-08-25T01:00:00.000Z",
    };
    const other: TaskAtriumErrorDismissal = {
      environmentId: ENV,
      threadId: "thread-2" as ThreadId,
      turnId: null,
      observedAt: "2026-08-25T02:00:00.000Z",
    };
    const replacement: TaskAtriumErrorDismissal = {
      ...first,
      turnId: "turn-3" as TurnId,
      observedAt: "2026-08-25T03:00:00.000Z",
    };

    expect(mergeTaskAtriumErrorDismissals([first, other], [replacement])).toEqual([
      other,
      replacement,
    ]);
  });
});

describe("formatElapsed", () => {
  it("renders seconds, minutes and hours", () => {
    expect(formatElapsed(NOW - 48_000, NOW)).toBe("48s");
    expect(formatElapsed(NOW - 252_000, NOW)).toBe("4m 12s");
    expect(formatElapsed(NOW - 3_780_000, NOW)).toBe("1h 03m");
  });

  it("renders nothing without a start time", () => {
    expect(formatElapsed(null, NOW)).toBe("");
  });
});
