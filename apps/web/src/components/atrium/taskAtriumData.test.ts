import { describe, expect, it } from "vitest";
import type {
  EnvironmentId,
  OrchestrationThreadActivity,
  ProjectId,
  TaskAtriumErrorDismissal,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";

import type { AppState } from "../../store";
import {
  formatElapsed,
  MAX_SUBAGENT_ROWS,
  mergeTaskAtriumErrorDismissals,
  selectAtriumSnapshot,
} from "./taskAtriumData";

const ENV = "env-1" as EnvironmentId;
const THREAD = "thread-1" as ThreadId;
const PROJECT = "project-1" as ProjectId;
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function activity(
  id: string,
  kind: "tool.started" | "tool.completed",
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
                latestTurnState === "error"
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
    expect(card?.subagents).toEqual([
      { id: "task-1", label: "explore", detail: "mapping canvas call sites", running: true },
    ]);
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
    expect(snapshot.cards[0]?.subagents[0]).toEqual({
      id: "sub-1",
      label: "Started",
      detail: "/root/tests",
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

  it("caps subagent rows and counts the remainder", () => {
    const activities = Array.from({ length: MAX_SUBAGENT_ROWS + 2 }, (_, index) =>
      activity(`a${index}`, "tool.started", "Subagent task started", {
        itemType: "collab_agent_tool_call",
        itemId: `task-${index}`,
        detail: `agent-${index}: working`,
      }),
    );
    const snapshot = selectAtriumSnapshot(buildState({ activities }), NOW);
    expect(snapshot.cards[0]?.subagents).toHaveLength(MAX_SUBAGENT_ROWS);
    expect(snapshot.cards[0]?.extraSubagents).toBe(2);
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
