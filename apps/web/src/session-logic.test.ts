import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveCompletionDividerAfterEntryId,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  deriveActiveSubagentWorkEntries,
  deriveHistoricalWorkLogSummaries,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveSubagentWorkEntries,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  formatDuration,
  formatElapsed,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
} from "./session-logic";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.make(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("turn duration formatting", () => {
  it("uses one whole-second model across live and completed turn labels", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59_999)).toBe("59s");
    expect(formatDuration(61_000)).toBe("1m 1s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_603_000)).toBe("1h 3s");
    expect(formatDuration(3_723_000)).toBe("1h 2m 3s");
  });

  it("keeps seconds visible after elapsed time passes one hour", () => {
    expect(formatElapsed("2026-05-26T00:00:00.000Z", "2026-05-26T01:02:03.000Z")).toBe("1h 2m 3s");
  });
});

describe("derivePendingApprovals", () => {
  it("preserves only boolean provider approval safety hints", () => {
    const rows = derivePendingApprovals([
      makeActivity({
        kind: "approval.requested",
        payload: {
          requestId: "sensitive",
          requestKind: "command",
          defaultToNo: true,
          suppressAlwaysAllowRule: true,
        },
      }),
      makeActivity({
        kind: "approval.requested",
        payload: {
          requestId: "ordinary",
          requestKind: "command",
          defaultToNo: "true",
          suppressAlwaysAllowRule: 1,
        },
      }),
    ]);
    expect(rows.find((row) => row.requestId === "sensitive")).toMatchObject({
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
    });
    expect(rows.find((row) => row.requestId === "ordinary")).not.toHaveProperty("defaultToNo");
    expect(rows.find((row) => row.requestId === "ordinary")).not.toHaveProperty(
      "suppressAlwaysAllowRule",
    );
  });
  it("preserves typed network destinations for informed approvals", () => {
    const rows = derivePendingApprovals([
      makeActivity({
        kind: "approval.requested",
        payload: {
          requestId: "network",
          requestKind: "command",
          networkApproval: { host: "example.com", protocol: "https" },
        },
      }),
    ]);
    expect(rows[0]?.networkApproval).toEqual({ host: "example.com", protocol: "https" });
  });
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "yarn lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "yarn lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("maps Codex terminal-input approvals into a distinct pending approval", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "terminal-input-approval-open",
        createdAt: "2026-08-27T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Terminal input approval requested",
        tone: "approval",
        payload: {
          requestId: "stdin-approval-1",
          requestType: "terminal_input_approval",
          detail: "Allow input to the running terminal",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "stdin-approval-1",
        requestKind: "terminal-input",
        createdAt: "2026-08-27T00:00:01.000Z",
        detail: "Allow input to the running terminal",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("clears stale pending approvals when the backend marks them stale after restart", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale-restart",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-restart-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale-restart",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-restart-1",
          detail:
            "Stale pending approval request: req-stale-restart-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });
});

describe("private interaction projection", () => {
  it("restores bounded cards without ordinary questions and removes only the exact resolved request", () => {
    const requested = makeActivity({
      id: "interaction-open",
      kind: "user-input.requested",
      sequence: 1,
      payload: {
        requestId: "interaction",
        questions: [],
        isBlocking: true,
        interaction: {
          kind: "elicitation",
          mode: "url",
          serverName: "connector",
          message: "External authorization required",
          urlOrigin: "https://example.com",
        },
      },
    });
    const unrelated = makeActivity({
      id: "other-resolved",
      kind: "user-input.resolved",
      sequence: 2,
      payload: { requestId: "other", answers: {} },
    });
    expect(derivePendingUserInputs([requested, unrelated])[0]?.interaction).toMatchObject({
      mode: "url",
      urlOrigin: "https://example.com",
    });
    const resolved = makeActivity({
      id: "interaction-resolved",
      kind: "user-input.resolved",
      sequence: 3,
      payload: { requestId: "interaction", answers: {} },
    });
    expect(derivePendingUserInputs([requested, unrelated, resolved])).toEqual([]);
  });
});

describe("derivePendingUserInputs", () => {
  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: true,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        isBlocking: true,
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
            multiSelect: true,
          },
        ],
      },
    ]);
  });

  it("preserves an explicit non-blocking Codex prompt", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-non-blocking",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-non-blocking",
          isBlocking: false,
          questions: [
            {
              id: "continue",
              header: "Continue",
              question: "Continue automatically?",
              options: [{ label: "yes", description: "Continue execution" }],
              multiSelect: false,
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)[0]?.isBlocking).toBe(false);
  });

  it("clears stale pending user-input prompts when the provider reports an orphaned request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-stale-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: {
          requestId: "req-user-input-stale-1",
          detail:
            "Stale pending user-input request: req-user-input-stale-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });
});

describe("deriveActivePlanState", () => {
  it("returns the latest plan update for the active turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Initial plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.make("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
    });
  });

  it("falls back to the most recent plan from a previous turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-from-turn-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [{ step: "Write tests", status: "completed" }],
        },
      }),
    ];

    // Current turn is turn-2, which has no plan activity — should fall back to turn-1's plan
    const result = deriveActivePlanState(activities, TurnId.make("turn-2"));
    expect(result).toEqual({
      createdAt: "2026-02-23T00:00:01.000Z",
      turnId: "turn-1",
      steps: [{ step: "Write tests", status: "completed" }],
    });
  });

  it("treats an empty latest snapshot as an explicit task-list clear", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-populated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [{ step: "Old task", status: "inProgress" }],
        },
      }),
      makeActivity({
        id: "plan-cleared",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.make("turn-1"))).toBeNull();
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers the latest proposed plan for the active turn", () => {
    expect(
      findLatestProposedPlan(
        [
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Older",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Latest",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.make("turn-2"),
            planMarkdown: "# Different turn",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.make("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# First",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.make("turn-2"),
          planMarkdown: "# Latest",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
  });
});

describe("hasActionableProposedPlan", () => {
  it("returns true for an unimplemented proposed plan", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("returns false for a proposed plan already implemented elsewhere", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: "2026-02-23T00:00:02.000Z",
        implementationThreadId: ThreadId.make("thread-implement"),
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe(false);
  });
});

describe("findSidebarProposedPlan", () => {
  it("prefers the running turn source proposed plan when available on the same thread", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Source plan",
                implementedAt: "2026-02-23T00:00:03.000Z",
                implementationThreadId: ThreadId.make("thread-2"),
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
            ],
          },
          {
            id: ThreadId.make("thread-2"),
            proposedPlans: [
              {
                id: "plan-2",
                turnId: TurnId.make("turn-other"),
                planMarkdown: "# Latest elsewhere",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:04.000Z",
                updatedAt: "2026-02-23T00:00:05.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: false,
        threadId: ThreadId.make("thread-1"),
      }),
    ).toEqual({
      id: "plan-1",
      turnId: "turn-plan",
      planMarkdown: "# Source plan",
      implementedAt: "2026-02-23T00:00:03.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the latest proposed plan once the turn is settled", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Older",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
              {
                id: "plan-2",
                turnId: TurnId.make("turn-latest"),
                planMarkdown: "# Latest",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:03.000Z",
                updatedAt: "2026-02-23T00:00:04.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: true,
        threadId: ThreadId.make("thread-1"),
      })?.planMarkdown,
    ).toBe("# Latest");
  });
});

describe("deriveHistoricalWorkLogSummaries", () => {
  it("keeps previous turns summarized while excluding the latest turn", () => {
    const previousTurnId = TurnId.make("turn-previous");
    const latestTurnId = TurnId.make("turn-latest");

    const summaries = deriveHistoricalWorkLogSummaries({
      messages: [
        {
          id: MessageId.make("assistant-previous"),
          role: "assistant",
          text: "done",
          turnId: previousTurnId,
          createdAt: "2026-02-23T00:00:05.000Z",
          streaming: false,
        },
        {
          id: MessageId.make("assistant-latest"),
          role: "assistant",
          text: "active",
          turnId: latestTurnId,
          createdAt: "2026-02-23T00:01:05.000Z",
          streaming: false,
        },
      ],
      activities: [
        makeActivity({
          id: "previous-tool",
          createdAt: "2026-02-23T00:00:03.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          turnId: "turn-previous",
        }),
        makeActivity({
          id: "latest-tool",
          createdAt: "2026-02-23T00:01:03.000Z",
          kind: "tool.completed",
          summary: "Still running",
          turnId: "turn-latest",
        }),
      ],
      latestTurnId,
    });

    expect([...summaries.keys()]).toEqual([previousTurnId]);
    expect(summaries.get(previousTurnId)?.snapshotEntryCount).toBe(1);
    expect(summaries.get(previousTurnId)?.previewEntries[0]?.label).toBe("Ran command");
  });
});

describe("deriveWorkLogEntries", () => {
  it("folds public summary snapshots in their first chronological position, isolated by turn and block", () => {
    const summary = (
      id: string,
      turnId: string,
      sequence: number,
      detail: string,
      itemId = "block-0",
    ) =>
      makeActivity({
        id,
        turnId,
        sequence,
        kind: "reasoning.summary",
        tone: "info",
        createdAt: `2026-10-09T00:00:0${sequence}.000Z`,
        payload: {
          itemId,
          streamKind: "reasoning_summary_text",
          summaryVersion: 1,
          provider: "claudeAgent",
          detail,
          status: sequence === 3 ? "completed" : "inProgress",
          truncated: false,
        },
      });
    const tool = makeActivity({
      id: "tool-between",
      turnId: "turn-a",
      sequence: 2,
      createdAt: "2026-10-09T00:00:02.000Z",
      kind: "tool.completed",
      summary: "Read file",
    });
    const entries = deriveWorkLogEntries(
      [
        summary("summary-terminal", "turn-a", 3, "Checking complete"),
        tool,
        summary("summary-start", "turn-a", 1, "Checking"),
        summary("next-block", "turn-a", 4, "Next step", "block-1"),
        summary("other-turn", "turn-b", 5, "Other turn"),
      ],
      undefined,
    );
    expect(entries.map((entry) => entry.id)).toEqual([
      "summary-start",
      "tool-between",
      "next-block",
      "other-turn",
    ]);
    expect(entries[0]).toMatchObject({
      createdAt: "2026-10-09T00:00:01.000Z",
      label: "Claude summary",
      publicSummary: { text: "Checking complete", status: "completed" },
    });
    expect(
      deriveWorkLogEntries(
        [
          makeActivity({
            id: "malformed",
            turnId: "turn-a",
            kind: "reasoning.summary",
            payload: { detail: "signature-only private", streamKind: "reasoning_text" },
          }),
        ],
        undefined,
      ),
    ).toEqual([]);
  });

  it("retains a live Claude command with description and merges received output/status/observed timing", () => {
    const command = (id: string, kind: string, second: number, payload: Record<string, unknown>) =>
      makeActivity({
        id,
        turnId: "turn-a",
        sequence: second,
        createdAt: `2026-10-09T00:00:0${second}.000Z`,
        kind,
        summary: "Command run",
        payload: { itemId: "tool-a", itemType: "command_execution", ...payload },
      });
    const started = command("start", "tool.started", 1, {
      data: {
        toolName: "Bash",
        commandInspectionVersion: 1,
        inspectionProvider: "claudeAgent",
        input: { description: "Run tests", command: "yarn test" },
      },
    });
    expect(deriveWorkLogEntries([started], undefined)[0]).toMatchObject({
      commandInspection: {
        description: "Run tests",
        command: "yarn test",
        status: "inProgress",
        startedAt: started.createdAt,
      },
    });
    const updated = command("update", "tool.updated", 2, {
      status: "inProgress",
      data: {
        toolName: "Bash",
        commandInspectionVersion: 1,
        inspectionProvider: "claudeAgent",
        output: "test output",
        outputTruncated: true,
      },
    });
    const info = makeActivity({
      id: "info",
      turnId: "turn-a",
      sequence: 3,
      kind: "task.progress",
      summary: "Received public update",
    });
    const completed = command("complete", "tool.completed", 4, {
      status: "failed",
      data: { toolName: "Bash", commandInspectionVersion: 1, inspectionProvider: "claudeAgent" },
    });
    const entries = deriveWorkLogEntries([completed, updated, info, started], undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["start", "info"]);
    expect(entries[0]).toMatchObject({
      command: "yarn test",
      detail: "Run tests",
      commandInspection: {
        description: "Run tests",
        command: "yarn test",
        output: "test output",
        outputTruncated: true,
        status: "failed",
        startedAt: started.createdAt,
        completedAt: completed.createdAt,
      },
    });
    expect(
      deriveWorkLogEntries([completed], undefined)[0]?.commandInspection?.startedAt,
    ).toBeUndefined();
  });
  it("omits tool started entries and keeps completed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("does not revive terminal primary operations on delayed updates or another tool's success", () => {
    const turnId = "terminal-operation-turn";
    const command = (
      id: string,
      sequence: number,
      itemId: string,
      kind: string,
      status: string,
      output: string,
    ) =>
      makeActivity({
        id,
        turnId,
        sequence,
        kind,
        payload: {
          itemId,
          itemType: "command_execution",
          status,
          data: {
            toolName: "Bash",
            commandInspectionVersion: 1,
            inspectionProvider: "claudeAgent",
            output,
          },
        },
      });
    const summary = (id: string, sequence: number, status: string, detail: string) =>
      makeActivity({
        id,
        turnId,
        sequence,
        kind: "reasoning.summary",
        tone: "info",
        payload: {
          itemId: "summary-block",
          streamKind: "reasoning_summary_text",
          summaryVersion: 1,
          provider: "claudeAgent",
          status,
          detail,
          truncated: false,
        },
      });
    const entries = deriveWorkLogEntries(
      [
        command("failed", 1, "failed-command", "tool.completed", "failed", "Received failure"),
        summary("partial", 2, "failed", "Received partial summary"),
        command("late-update", 3, "failed-command", "tool.updated", "inProgress", "Stale update"),
        summary("late-summary", 4, "inProgress", "Stale summary"),
        command(
          "other-success",
          5,
          "other-command",
          "tool.completed",
          "completed",
          "Other command succeeded",
        ),
      ],
      undefined,
    );
    expect(entries.map((entry) => entry.id)).toEqual(["failed", "partial", "other-success"]);
    expect(entries[0]?.commandInspection).toMatchObject({
      status: "failed",
      output: "Received failure",
    });
    expect(entries[1]?.publicSummary).toMatchObject({
      status: "failed",
      text: "Received partial summary",
    });
    expect(entries[2]?.commandInspection?.status).toBe("completed");
  });

  it("omits ordinary task.started but shows task.progress and task.completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress", "task-complete"]);
  });

  it("keeps workflow lifecycle in its dedicated Tasks section without malformed display fallthrough", () => {
    const activities = [
      makeActivity({
        id: "workflow-start",
        kind: "task.started",
        payload: { taskId: "workflow", workflow: { futureSchema: "not admitted" } },
      }),
      makeActivity({
        id: "workflow-progress",
        kind: "task.progress",
        payload: { taskId: "workflow", workflow: { futureSchema: "not admitted" } },
      }),
      makeActivity({
        id: "workflow-completed",
        kind: "task.completed",
        payload: { taskId: "workflow", workflow: { futureSchema: "not admitted" } },
      }),
      makeActivity({
        id: "ordinary-progress",
        kind: "task.progress",
        payload: { taskId: "ordinary", detail: "Updating files" },
      }),
    ];
    expect(deriveWorkLogEntries(activities, undefined).map((entry) => entry.id)).toEqual([
      "ordinary-progress",
    ]);
  });

  it("keeps ambient provider tasks out of the ordinary work log", () => {
    const ambientProgress = makeActivity({
      id: "ambient-watcher-progress",
      createdAt: "2026-02-23T00:00:02.000Z",
      kind: "task.progress",
      summary: "Watcher update",
      tone: "info",
      payload: {
        taskId: "provider-watcher",
        detail: "Refreshing provider-owned metadata",
        visibility: "ambient",
      },
    });

    expect(deriveWorkLogEntries([ambientProgress], undefined)).toEqual([]);
  });

  it("uses the latest exact task visibility to retract and restore ordinary work-log rows", () => {
    const turnId = TurnId.make("turn-watcher-visibility");
    const visible = makeActivity({
      id: "watcher-visible",
      createdAt: "2026-02-23T00:00:01.000Z",
      kind: "task.progress",
      summary: "Watcher is running",
      tone: "info",
      turnId,
      payload: { taskId: "provider-watcher", visibility: "visible" },
    });
    const ambient = makeActivity({
      id: "watcher-ambient",
      createdAt: "2026-02-23T00:00:02.000Z",
      kind: "task.progress",
      summary: "Watcher moved to ambient work",
      tone: "info",
      turnId,
      payload: { taskId: "provider-watcher", visibility: "ambient" },
    });
    const restored = makeActivity({
      id: "watcher-restored",
      createdAt: "2026-02-23T00:00:03.000Z",
      kind: "task.progress",
      summary: "Watcher is visible again",
      tone: "info",
      turnId,
      payload: { taskId: "provider-watcher", visibility: "visible" },
    });
    const ambientTerminal = makeActivity({
      id: "watcher-ambient-terminal",
      createdAt: "2026-02-23T00:00:04.000Z",
      kind: "task.completed",
      summary: "Watcher ended silently",
      tone: "info",
      turnId,
      payload: { taskId: "provider-watcher", visibility: "ambient" },
    });

    expect(deriveWorkLogEntries([visible], turnId).map((entry) => entry.id)).toEqual([
      "watcher-visible",
    ]);
    expect(deriveWorkLogEntries([visible, ambient], turnId)).toEqual([]);
    expect(
      deriveWorkLogEntries([visible, ambient, restored], turnId).map((entry) => entry.id),
    ).toContain("watcher-restored");
    expect(deriveWorkLogEntries([visible, ambient, restored, ambientTerminal], turnId)).toEqual([]);
  });

  it("retracts and restores an ambient subagent in the active composer roster", () => {
    const turnId = TurnId.make("turn-ambient-worker");
    const presentation = {
      threadId: "ambient-worker",
      label: "Watch provider state",
      objective: "Track provider-owned background state",
      status: "active" as const,
      startedAt: "2026-02-23T00:00:01.000Z",
    };
    const started = makeActivity({
      id: "ambient-worker-started",
      createdAt: presentation.startedAt,
      kind: "task.started",
      summary: "Subagent started",
      tone: "info",
      turnId,
      payload: {
        taskId: presentation.threadId,
        visibility: "visible",
        subagent: presentation,
      },
    });
    const hidden = makeActivity({
      id: "ambient-worker-hidden",
      createdAt: "2026-02-23T00:00:02.000Z",
      kind: "task.progress",
      summary: "Subagent visibility changed",
      tone: "info",
      turnId,
      payload: {
        taskId: presentation.threadId,
        visibility: "ambient",
      },
    });
    const restored = makeActivity({
      id: "ambient-worker-restored",
      createdAt: "2026-02-23T00:00:03.000Z",
      kind: "task.progress",
      summary: "Subagent update",
      tone: "info",
      turnId,
      payload: {
        taskId: presentation.threadId,
        detail: "Visible again",
        visibility: "visible",
        subagent: presentation,
      },
    });
    const hiddenTerminal = makeActivity({
      id: "ambient-worker-hidden-terminal",
      createdAt: "2026-02-23T00:00:04.000Z",
      kind: "task.completed",
      summary: "Subagent completed",
      tone: "info",
      turnId,
      payload: {
        taskId: presentation.threadId,
        status: "completed",
        visibility: "ambient",
      },
    });

    expect(deriveActiveSubagentWorkEntries([started], turnId)).toHaveLength(1);
    expect(deriveActiveSubagentWorkEntries([started, hidden], turnId)).toEqual([]);
    expect(deriveActiveSubagentWorkEntries([started, hidden, restored], turnId)).toHaveLength(1);
    expect(
      deriveActiveSubagentWorkEntries([started, hidden, restored, hiddenTerminal], turnId),
    ).toEqual([]);
  });

  it("coalesces structured subagent lifecycle while ordinary task starts stay hidden", () => {
    const subagent = {
      threadId: " provider-child-locate-footer ",
      historyId: " history  id with preserved spacing ",
      label: "Locate footer label",
      path: "/root/locate_footer_label",
      objective: "Find where the footer status label is assembled",
      startedAt: "2026-02-23T00:00:01.000Z",
    };
    const started = makeActivity({
      id: "subagent-start",
      createdAt: "2026-02-23T00:00:01.000Z",
      kind: "task.started",
      summary: "Subagent started",
      tone: "info",
      turnId: "turn-subagents",
      payload: {
        taskId: subagent.threadId,
        taskType: "subagent",
        detail: subagent.objective,
        subagent: { ...subagent, status: "waiting" },
      },
    });
    const progress = makeActivity({
      id: "subagent-progress",
      createdAt: "2026-02-23T00:00:06.000Z",
      kind: "task.progress",
      summary: "Subagent update",
      tone: "info",
      turnId: "turn-subagents",
      sequence: 42,
      payload: {
        taskId: subagent.threadId,
        detail: "Refining trigger label filtering",
        subagent: { ...subagent, status: "active" },
      },
    });
    const completed = makeActivity({
      id: "subagent-complete",
      createdAt: "2026-02-23T00:01:06.000Z",
      kind: "task.completed",
      summary: "Subagent completed",
      tone: "info",
      turnId: "turn-subagents",
      payload: {
        taskId: subagent.threadId,
        status: "completed",
        detail: "Located the footer label source",
        subagent: { ...subagent, status: "completed" },
      },
    });
    const ordinaryStart = makeActivity({
      id: "ordinary-task-start",
      createdAt: "2026-02-23T00:00:03.000Z",
      kind: "task.started",
      summary: "Default task started",
      tone: "info",
      turnId: "turn-subagents",
      payload: {
        taskId: "ordinary-task",
        taskType: "background",
        detail: "Internal bookkeeping",
      },
    });

    const activeEntries = deriveSubagentWorkEntries(
      [started, ordinaryStart, progress],
      TurnId.make("turn-subagents"),
    );
    expect(
      deriveWorkLogEntries([started, ordinaryStart, progress], TurnId.make("turn-subagents")),
    ).toEqual([]);
    expect(activeEntries).toEqual([
      {
        id: "subagent-start",
        turnId: TurnId.make("turn-subagents"),
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Locate footer label",
        detail: "Find where the footer status label is assembled",
        tone: "thinking",
        itemType: "collab_agent_tool_call",
        subagent: {
          id: " provider-child-locate-footer ",
          label: "Locate footer label",
          objective: "Find where the footer status label is assembled",
          description: "Refining trigger label filtering",
          status: "active",
          startedAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:06.000Z",
          lifecycleRevision: "sequence:42:17:subagent-progress",
          historyId: " history  id with preserved spacing ",
        },
      },
    ]);

    const completedEntries = deriveSubagentWorkEntries(
      [started, ordinaryStart, progress, completed],
      TurnId.make("turn-subagents"),
    );
    expect(completedEntries).toHaveLength(1);
    expect(completedEntries[0]?.id).toBe("subagent-start");
    expect(completedEntries[0]?.subagent).toMatchObject({
      id: " provider-child-locate-footer ",
      label: "Locate footer label",
      objective: "Find where the footer status label is assembled",
      description: "Located the footer label source",
      status: "completed",
      startedAt: "2026-02-23T00:00:01.000Z",
      completedAt: "2026-02-23T00:01:06.000Z",
      historyId: " history  id with preserved spacing ",
    });
    expect(completedEntries.some((entry) => entry.id === "ordinary-task-start")).toBe(false);

    const delayedProgress = makeActivity({
      id: "subagent-delayed-progress",
      createdAt: "2026-02-23T00:01:07.000Z",
      kind: "task.progress",
      summary: "Subagent update",
      tone: "info",
      turnId: "turn-subagents",
      payload: {
        taskId: subagent.threadId,
        detail: "Delayed replay that must not resurrect the worker",
        subagent: { ...subagent, status: "active" },
      },
    });
    const afterDelayedProgress = deriveSubagentWorkEntries(
      [started, progress, completed, delayedProgress],
      TurnId.make("turn-subagents"),
    );
    expect(afterDelayedProgress[0]?.subagent).toMatchObject({
      status: "completed",
      description: "Located the footer label source",
      completedAt: "2026-02-23T00:01:06.000Z",
    });

    const restarted = makeActivity({
      id: "subagent-restarted",
      createdAt: "2026-02-23T00:02:00.000Z",
      kind: "task.started",
      summary: "Subagent started",
      tone: "info",
      turnId: "turn-subagents",
      payload: {
        taskId: subagent.threadId,
        detail: "Rechecking after an explicit restart",
        subagent: {
          ...subagent,
          status: "active",
          startedAt: "2026-02-23T00:02:00.000Z",
        },
      },
    });
    const afterRestart = deriveSubagentWorkEntries(
      [started, progress, completed, delayedProgress, restarted],
      TurnId.make("turn-subagents"),
    );
    expect(afterRestart[0]?.subagent).toMatchObject({
      status: "active",
      description: "Rechecking after an explicit restart",
      startedAt: "2026-02-23T00:02:00.000Z",
    });
    expect(afterRestart[0]?.subagent?.completedAt).toBeUndefined();
  });

  it("refreshes a completed worker's name without reopening work or rebinding history", () => {
    const turnId = TurnId.make("rename-completed-worker");
    const completed = makeActivity({
      id: "completed-worker",
      kind: "task.completed",
      summary: "Subagent completed",
      turnId,
      createdAt: "2026-10-03T00:00:00.000Z",
      sequence: 1,
      payload: {
        taskId: "worker",
        status: "completed",
        subagent: {
          threadId: "worker",
          label: "Old name",
          status: "completed",
          historyId: "exact-history",
          startedAt: "2026-10-02T23:59:00.000Z",
        },
      },
    });
    const rename = makeActivity({
      id: "worker-renamed",
      kind: "task.progress",
      summary: "Subagent update",
      turnId,
      createdAt: "2026-10-03T00:01:00.000Z",
      sequence: 2,
      payload: {
        taskId: "worker",
        detail: "Late progress",
        subagent: {
          threadId: "worker",
          label: "New name",
          status: "active",
          historyId: "different-history",
        },
      },
    });
    const [entry] = deriveSubagentWorkEntries([completed, rename], turnId);
    expect(entry?.label).toBe("New name");
    expect(entry?.subagent).toMatchObject({
      label: "New name",
      status: "completed",
      historyId: "exact-history",
      startedAt: "2026-10-02T23:59:00.000Z",
      completedAt: "2026-10-03T00:00:00.000Z",
      lifecycleRevision: "sequence:2:14:worker-renamed",
    });
  });

  it("settles legacy Codex control rows when their parent turn is terminal", () => {
    const turnId = TurnId.make("turn-legacy-subagent");
    const legacy = makeActivity({
      id: "legacy-subagent-started",
      createdAt: "2026-02-23T00:00:01.000Z",
      kind: "tool.completed",
      summary: "Subagent task",
      tone: "tool",
      turnId,
      payload: {
        itemType: "collab_agent_tool_call",
        itemId: "legacy-child",
        detail: "Started /root/audit_history",
      },
    });

    expect(deriveSubagentWorkEntries([legacy], turnId)[0]?.subagent).toMatchObject({
      status: "active",
      description: "Working",
    });
    const [terminal] = deriveSubagentWorkEntries([legacy], turnId, {
      terminalTurnIds: new Set([turnId]),
    });
    expect(terminal?.detail).toBe("Completed");
    expect(terminal?.subagent).toMatchObject({
      status: "completed",
      completedAt: legacy.createdAt,
    });
    expect(terminal?.subagent?.description).toBeUndefined();
  });

  it("replaces generic live copy at completion while preserving meaningful progress", () => {
    const turnId = TurnId.make("turn-terminal-subagent-description");
    const lifecycle = (input: {
      readonly id: string;
      readonly childId: string;
      readonly kind: "task.progress" | "task.completed";
      readonly detail?: string;
      readonly sequence: number;
    }) =>
      makeActivity({
        id: input.id,
        createdAt: `2026-02-23T00:02:0${input.sequence}.000Z`,
        kind: input.kind,
        summary: input.kind === "task.completed" ? "Subagent completed" : "Subagent update",
        tone: "info",
        turnId,
        sequence: input.sequence,
        payload: {
          taskId: input.childId,
          ...(input.detail ? { detail: input.detail } : {}),
          ...(input.kind === "task.completed" ? { status: "completed" } : {}),
          subagent: {
            threadId: input.childId,
            label: input.childId,
            status: input.kind === "task.completed" ? "completed" : "active",
          },
        },
      });
    const genericProgress = lifecycle({
      id: "generic-progress",
      childId: "generic-worker",
      kind: "task.progress",
      detail: "Working",
      sequence: 1,
    });
    const genericCompletion = lifecycle({
      id: "generic-completion",
      childId: "generic-worker",
      kind: "task.completed",
      sequence: 2,
    });
    const meaningfulProgress = lifecycle({
      id: "meaningful-progress",
      childId: "meaningful-worker",
      kind: "task.progress",
      detail: "Indexed the provider boundary",
      sequence: 3,
    });
    const meaningfulCompletion = lifecycle({
      id: "meaningful-completion",
      childId: "meaningful-worker",
      kind: "task.completed",
      sequence: 4,
    });

    const entries = deriveSubagentWorkEntries(
      [genericProgress, genericCompletion, meaningfulProgress, meaningfulCompletion],
      turnId,
    );
    expect(entries[0]?.detail).toBe("Completed");
    expect(entries[0]?.subagent).toMatchObject({
      id: "generic-worker",
      status: "completed",
    });
    expect(entries[0]?.subagent?.description).toBeUndefined();
    expect(entries[1]?.subagent).toMatchObject({
      id: "meaningful-worker",
      description: "Indexed the provider boundary",
      status: "completed",
    });
  });

  it("keeps structured background children from older turns in the active composer roster", () => {
    const olderTurnId = TurnId.make("turn-background-older");
    const runningTurnId = TurnId.make("turn-background-current");
    const structured = (id: string, turnId: TurnId, sequence: number) =>
      makeActivity({
        id: `started-${id}`,
        createdAt: `2026-02-23T00:00:0${sequence}.000Z`,
        kind: "task.started",
        summary: "Subagent started",
        tone: "info",
        turnId,
        sequence,
        payload: {
          taskId: id,
          taskType: "subagent",
          subagent: {
            threadId: id,
            label: id,
            status: "active",
          },
        },
      });
    const legacyOlder = makeActivity({
      id: "legacy-background-older",
      createdAt: "2026-02-23T00:00:03.000Z",
      kind: "tool.completed",
      summary: "Subagent task",
      tone: "tool",
      turnId: olderTurnId,
      sequence: 3,
      payload: {
        itemType: "collab_agent_tool_call",
        itemId: "legacy-child",
        detail: "Started /root/legacy_child",
      },
    });

    const entries = deriveActiveSubagentWorkEntries(
      [
        structured("older-structured-child", olderTurnId, 1),
        structured("current-child", runningTurnId, 2),
        legacyOlder,
      ],
      runningTurnId,
    );

    expect(entries.map((entry) => entry.subagent?.id)).toEqual([
      "older-structured-child",
      "current-child",
    ]);
  });

  it("heals persisted Codex root pseudo-agents without hiding genuine background children", () => {
    const olderTurnId = TurnId.make("turn-poisoned-root-older");
    const runningTurnId = TurnId.make("turn-poisoned-root-current");
    const structured = (input: {
      readonly id: string;
      readonly path: string;
      readonly label?: string;
      readonly sequence: number;
    }) =>
      makeActivity({
        id: `started-${input.id}`,
        createdAt: `2026-02-23T00:01:0${input.sequence}.000Z`,
        kind: "task.progress",
        summary: "Subagent update",
        tone: "info",
        turnId: olderTurnId,
        sequence: input.sequence,
        payload: {
          taskId: input.id,
          detail: "Working",
          subagent: {
            threadId: input.id,
            ...(input.label ? { label: input.label } : {}),
            path: input.path,
            status: "active",
          },
        },
      });

    const entries = deriveActiveSubagentWorkEntries(
      [
        structured({ id: "provider-root-thread", path: "/root/", sequence: 1 }),
        structured({
          id: "real-background-child",
          path: "/root/audit_restart",
          label: "Audit restart",
          sequence: 2,
        }),
      ],
      runningTurnId,
    );

    expect(entries.map((entry) => entry.subagent?.id)).toEqual(["real-background-child"]);
    expect(entries[0]?.subagent).toMatchObject({
      label: "Audit restart",
      status: "active",
    });
  });

  it("treats task.completed as terminal when repeated presentation state is stale", () => {
    const turnId = TurnId.make("turn-contradictory-subagent-status");
    const completed = makeActivity({
      id: "subagent-completed-with-stale-presentation",
      createdAt: "2026-02-23T00:03:00.000Z",
      kind: "task.completed",
      summary: "Subagent completed",
      tone: "info",
      turnId,
      payload: {
        taskId: "provider-child-stale-status",
        status: "completed",
        subagent: {
          threadId: "provider-child-stale-status",
          label: "Status audit",
          // Provider presentation is repeated display metadata and may lag the
          // canonical terminal task edge by one notification.
          status: "active",
        },
      },
    });

    expect(deriveSubagentWorkEntries([completed], turnId)[0]?.subagent).toMatchObject({
      status: "completed",
      completedAt: completed.createdAt,
    });
  });

  it("shows Codex guardian approval review starts", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "guardian-review-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "Approval review started",
        tone: "info",
        payload: {
          taskId: "codex-auto-approval-review:review-1",
          taskType: "approval-review",
          detail: "Automatic approval review started",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Approval review started");
  });

  it("uses payload summary as label for task entries when available", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-progress-with-summary",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        payload: { summary: "Searching for API endpoints" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries[0]?.label).toBe("Searching for API endpoints");
  });

  it("omits routine Codex delivery and running observations without hiding failures", () => {
    const hidden = [
      { kind: "provider.turn.steer.accepted", payload: { messageId: "steer-1" } },
      { kind: "task.progress", payload: { taskId: "codex-turn-steer:receipt-1" } },
      { kind: "task.progress", payload: { taskId: "codex-turn-steer-processing:receipt-1" } },
      {
        kind: "task.progress",
        payload: { detail: "Codex app-server began processing turn/steer." },
      },
      {
        kind: "runtime.warning",
        payload: {
          message:
            "Codex app-server accepted turn/steer but has not emitted the steer user message yet.",
        },
      },
      {
        kind: "runtime.warning",
        payload: {
          message:
            "Codex accepted turn/steer; it is queued until the active turn finishes current child-process work (4 live descendant processes).",
        },
      },
      {
        kind: "runtime.warning",
        payload: {
          message:
            "Codex still reports the active turn as in progress; app-server has 11 live descendant processes still running.",
        },
      },
      {
        kind: "runtime.warning",
        payload: {
          message:
            "Codex still reports the active turn as in progress after delayed snapshot polling.",
        },
      },
    ].map((activity, index) =>
      makeActivity({ ...activity, id: `routine-${index}`, sequence: index + 1 }),
    );
    const visible = [
      makeActivity({
        id: "actual-warning",
        kind: "runtime.warning",
        payload: { message: "Connection lost" },
      }),
      makeActivity({
        id: "actual-error",
        kind: "runtime.error",
        tone: "error",
        payload: {
          message:
            "Codex app-server accepted turn/steer but has not emitted the steer user message yet.",
        },
      }),
      makeActivity({ id: "failed-steer", kind: "provider.turn.steer.failed", tone: "error" }),
      makeActivity({
        id: "normal-progress",
        kind: "task.progress",
        payload: { detail: "Running tests" },
      }),
    ];
    expect(
      deriveWorkLogEntries(
        [
          ...hidden,
          ...visible.map((activity, index) => ({
            ...activity,
            sequence: hidden.length + index + 1,
          })),
        ],
        undefined,
      ).map((entry) => entry.id),
    ).toEqual(visible.map((activity) => activity.id));
    expect(deriveWorkLogEntries(hidden, undefined)).toEqual([]);
    expect(hidden).toHaveLength(8);
  });

  it("shows runtime warning message details in work log entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "runtime-warning",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
        payload: {
          message: "Provider stderr: failed to read cached session",
          detail: { retrying: true },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries[0]).toMatchObject({
      id: "runtime-warning",
      label: "Runtime warning",
      detail: 'Provider stderr: failed to read cached session\n{"retrying":true}',
    });
  });

  it("renders native retry observations as finite fixed copy without provider prose or JSON", () => {
    const retry = (payload: Record<string, unknown>) =>
      deriveWorkLogEntries(
        [
          makeActivity({
            kind: "runtime.warning",
            summary: "Provider transport retrying",
            payload,
          }),
        ],
        undefined,
      )[0]!;
    const privatePayload = {
      message: "Reconnecting... 1/5 private native diagnostic",
      detail: { willRetry: true, error: { message: "private diagnostic", secret: "never show" } },
      retrying: true,
    };
    expect(
      retry({ ...privatePayload, nativeRetry: { observedCount: 12, timing: "unknown" } }),
    ).toMatchObject({ label: "Provider retry · 12" });
    expect(
      retry({
        ...privatePayload,
        nativeRetry: { observedCount: 1024, timing: "unknown", countLimited: true },
      }),
    ).toMatchObject({ label: "Provider retry · 1024+" });
    for (const nativeRetry of [
      undefined,
      { observedCount: 0, timing: "unknown" },
      { observedCount: 1025, timing: "unknown" },
      { observedCount: 0.5, timing: "unknown" },
      { observedCount: 12, timing: "known" },
      { observedCount: 12, timing: "unknown", countLimited: false },
      { observedCount: 12, timing: "unknown", countLimited: "true" },
      { observedCount: 12, timing: "unknown", countLimited: undefined },
      Object.create({ observedCount: 12, timing: "unknown" }),
    ]) {
      const row = retry({ ...privatePayload, nativeRetry });
      expect(row.label).toBe("Provider retry");
      expect(row).not.toHaveProperty("detail");
      expect(JSON.stringify(row)).not.toContain("private");
      expect(JSON.stringify(row)).not.toContain("1/5");
      expect(JSON.stringify(row)).not.toContain("in 12s");
    }
    let reads = 0;
    const accessor = Object.defineProperty({}, "observedCount", {
      get() {
        reads += 1;
        return 12;
      },
    });
    expect(retry({ ...privatePayload, nativeRetry: accessor }).label).toBe("Provider retry");
    expect(reads).toBe(0);
    const detail = {
      toJSON() {
        reads += 1;
        return { privateText: "never stringify" };
      },
    };
    expect(
      retry({ ...privatePayload, detail, nativeRetry: { observedCount: 12, timing: "unknown" } })
        .label,
    ).toBe("Provider retry · 12");
    expect(reads).toBe(0);
    // Prose alone is not a semantic retry flag or a cumulative count source.
    expect(retry({ message: "Reconnecting... 3/5" }).label).toBe("Provider transport retrying");
  });

  it("keeps saved Cafe waits static and distinguishes their continuation count from native retry cycles", () => {
    const wait = makeActivity({
      id: "cafe-wait",
      kind: "runtime.warning",
      tone: "info",
      createdAt: "2026-02-23T00:00:00.000Z",
      turnId: "failed-root",
      payload: {
        recovery: "codex-transient-recovery-waiting",
        stage: "backoff",
        retryAttempt: 30,
        continuationOrdinal: 37,
        continuationOrdinalLowerBound: true,
        retryAt: "2026-02-23T00:00:45.000Z",
        detail: { secret: "not public" },
      },
    });
    const row = deriveWorkLogEntries([wait], undefined)[0]!;
    expect(row.label).toBe("Cafe recovery · Retry #37+ · backoff 45s");
    expect(row).not.toHaveProperty("detail");
    const summaries = deriveHistoricalWorkLogSummaries({
      messages: [],
      activities: [wait],
      latestTurnId: TurnId.make("new-root"),
    });
    expect(summaries.get(TurnId.make("failed-root"))?.previewEntries[0]).toEqual(row);
    expect(deriveWorkLogEntries(structuredClone([wait]), undefined)[0]).toEqual(row);
    const attempted = {
      ...wait,
      payload: { recovery: "codex-transient-continuation-attempted", continuationOrdinal: 38 },
    };
    const attemptedRow = deriveWorkLogEntries([attempted], undefined)[0]!;
    expect(attemptedRow.label).toBe("Cafe recovery · Retry #38");
    expect(attemptedRow).not.toHaveProperty("detail");
  });

  it("hides retryable steer delivery failures from the normal work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "retryable-steer",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.turn.steer.failed",
        summary: "Provider steer failed",
        tone: "error",
        payload: {
          detail: "Cafe Code preserved this follow-up for automatic delivery.",
          messageId: "msg-1",
          retryableFollowUp: true,
          retryAfter: "active-turn",
        },
      }),
      makeActivity({
        id: "real-warning",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["real-warning"]);
  });

  it("uses payload detail as label for task.completed and preserves error tone", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-completed-failed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task failed",
        tone: "error",
        payload: { detail: "Failed to deploy changes" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries[0]?.label).toBe("Failed to deploy changes");
    expect(entries[0]?.tone).toBe("error");
  });

  it("filters by turn id when provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "Tool call", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({ id: "no-turn", summary: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.make("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["turn-2"]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: yarn test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["yarn", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("yarn lint");
  });

  it("unwraps PowerShell command wrappers for displayed command text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'yarn lint'",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("yarn lint");
    expect(entry?.rawCommand).toBe(
      "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'yarn lint'",
    );
  });

  it("unwraps PowerShell command wrappers from argv-style command payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper-argv",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "rg -n foo ."],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("rg -n foo .");
    expect(entry?.rawCommand).toBe(
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n foo ."',
    );
  });

  it("extracts command text from command detail when structured command metadata is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-detail-fallback",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail:
            '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command \'rg -n -F "new Date()" .\' <exited with exit code 0>',
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe('rg -n -F "new Date()" .');
    expect(entry?.rawCommand).toBe(
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command 'rg -n -F "new Date()" .'`,
    );
  });

  it("does not unwrap shell commands when no wrapper flag is present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-shell-script",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "bash script.sh",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bash script.sh");
    expect(entry?.rawCommand).toBeUndefined();
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["yarn", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      command: "yarn dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("extracts changed file paths for file-change tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [
                { path: "apps/web/src/components/ChatView.tsx" },
                { filename: "apps/web/src/session-logic.ts" },
                { file_path: "/Users/mike/selia/selia/.selene/adrs/0110-deferred-arcs.md" },
                { path: "/Users/mike/selia/selia/.selene/adrs/0110-truncated…" },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
      "/Users/mike/selia/selia/.selene/adrs/0110-deferred-arcs.md",
    ]);
  });

  it("does not treat command metadata paths as changed-file pills", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-with-search-path",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            commandActions: [
              {
                command: "rg -n deferred /Users/mike/selia/selia/.selene/adrs",
                path: "selia/...",
                type: "search",
              },
            ],
            changedFiles: [{ path: "selia/..." }],
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toBeUndefined();
  });

  it("drops duplicated tool detail when it only repeats the title", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-file-generic",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.toolTitle).toBe("Read File");
    expect(entry?.detail).toBeUndefined();
  });

  it("recovers web-search queries from retained pre-detail activity payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-web-search-complete",
        kind: "tool.completed",
        summary: "Web search",
        payload: {
          itemType: "web_search",
          title: "Web search",
          data: {
            item: {
              type: "webSearch",
              id: "web-search-1",
              query: "current Codex five-hour and weekly usage limits",
              action: {
                type: "search",
                query: "current Codex five-hour and weekly usage limits",
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      toolTitle: "Web search",
      detail: "current Codex five-hour and weekly usage limits",
      itemType: "web_search",
    });
  });

  it("recovers Codex MCP and dynamic-tool detail from retained activity payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-mcp-complete",
        kind: "tool.completed",
        summary: "MCP tool call",
        payload: {
          itemType: "mcp_tool_call",
          title: "MCP tool call",
          data: {
            item: {
              type: "mcpToolCall",
              server: "openaiDeveloperDocs",
              tool: "search_openai_docs",
              arguments: {
                query: "current Responses API tools",
                apiKey: "sk-example-secret-value-1234567890",
              },
            },
          },
        },
      }),
      makeActivity({
        id: "codex-dynamic-complete",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          data: {
            item: {
              type: "dynamicToolCall",
              namespace: "workspace",
              tool: "read_file",
              arguments: { path: "/workspace/README.md" },
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.find((entry) => entry.id === "codex-mcp-complete")).toMatchObject({
      detail:
        'openaiDeveloperDocs.search_openai_docs: {"query":"current Responses API tools","apiKey":"[redacted]"}',
      itemType: "mcp_tool_call",
    });
    expect(entries.find((entry) => entry.id === "codex-dynamic-complete")).toMatchObject({
      detail: 'workspace.read_file: {"path":"/workspace/README.md"}',
      itemType: "dynamic_tool_call",
    });
  });

  it("keeps each observation tied to its own completed tool item through work-log coalescing", () => {
    const reference = {
      id: "24ff9ac9-1d98-4bb9-9d3f-1e868663a064",
      capturedAt: "2026-09-09T00:00:00.000Z",
      width: 1280,
      height: 800,
      frame: 4,
      humanControl: false,
      storage: "saved",
    };
    const activities = ["first", "second"].flatMap((id) =>
      ["started", "completed"].map((lifecycle) =>
        makeActivity({
          id: `${id}-${lifecycle}`,
          kind: `tool.${lifecycle}`,
          summary: "MCP tool call",
          payload: {
            itemType: "mcp_tool_call",
            itemId: id,
            data: {
              item: {
                id,
                type: "mcpToolCall",
                server: "cafe-desktop",
                tool: "observe",
                status: lifecycle === "completed" ? "completed" : "inProgress",
                result:
                  lifecycle === "completed" && id === "first"
                    ? { content: [], structuredContent: { desktopObservation: reference } }
                    : null,
              },
            },
          },
        }),
      ),
    );
    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.desktopObservation).toEqual({ reference, pending: false });
    expect(entries[1]?.desktopObservation).toEqual({ pending: false });
  });

  it("recovers Grok output-side queries and nested tool arguments from retained payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "grok-web-search-complete",
        kind: "tool.completed",
        summary: "Web search:",
        payload: {
          itemType: "web_search",
          title: "Web search:",
          data: {
            kind: "search",
            rawInput: { backend: true, variant: "web_search" },
            rawOutput: {
              action: {
                type: "search",
                query: "current Grok ACP release",
                sources: [],
              },
            },
          },
        },
      }),
      makeActivity({
        id: "grok-custom-tool-complete",
        kind: "tool.completed",
        summary: "cafe-code__list_threads",
        payload: {
          itemType: "dynamic_tool_call",
          title: "cafe-code__list_threads",
          data: {
            kind: "other",
            rawInput: {
              variant: "mcp",
              tool_name: "cafe-code__list_threads",
              tool_input: { state: "active" },
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.find((entry) => entry.id === "grok-web-search-complete")).toMatchObject({
      detail: "current Grok ACP release",
      itemType: "web_search",
    });
    expect(entries.find((entry) => entry.id === "grok-custom-tool-complete")).toMatchObject({
      detail: '{"state":"active"}',
      itemType: "dynamic_tool_call",
    });
  });

  it("uses grep raw output summaries instead of repeating the generic tool label", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "grep-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "grep-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawOutput: {
              totalFiles: 19,
              truncated: false,
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "grep-complete",
      toolTitle: "grep",
      detail: "19 files",
      itemType: "web_search",
    });
  });

  it("uses completed read-file output previews and still collapses the same tool call", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawOutput: {
              content:
                'import * as Effect from "effect/Effect"\nimport * as Layer from "effect/Layer"\n',
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "read-complete",
      toolTitle: "Read File",
      detail: 'import * as Effect from "effect/Effect"',
      itemType: "dynamic_tool_call",
    });
  });

  it("does not use command stdout as the detail when a provider omits the command input", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "provider-command-complete",
        createdAt: "2026-04-16T22:40:42.221Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            toolCallId: "toolu_vrtx_01WypXgRM8PPygBtrVAZwzy5",
            kind: "execute",
            rawInput: {},
            rawOutput: {
              exitCode: 0,
              stdout: "total 960\napps\npackages\n",
              stderr: "",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      id: "provider-command-complete",
      label: "Ran command",
      itemType: "command_execution",
      toolTitle: "Ran command",
    });
    expect(entry?.detail).toBeUndefined();
    expect(entry?.command).toBeUndefined();
  });

  it("collapses legacy completed tool rows that are missing tool metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "legacy-read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-legacy",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "legacy-read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "legacy-read-complete",
      toolTitle: "Read File",
      itemType: "dynamic_tool_call",
    });
    expect(entries[0]?.detail).toBeUndefined();
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete",
      createdAt: "2026-02-23T00:00:03.000Z",
      label: "Tool call completed",
      detail: 'Read: {"file_path":"/tmp/app.ts"}',
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-complete", "tool-2-complete"]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("a-complete-same-timestamp");
  });
});

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });

  it("anchors the completion divider after the latest same-turn timeline entry", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("assistant-earlier"),
          role: "assistant",
          text: "progress update",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.make("assistant-final"),
          role: "assistant",
          text: "final answer",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [
        {
          id: "work-after-assistant",
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran command",
          tone: "tool",
        },
      ],
    );

    expect(
      deriveCompletionDividerAfterEntryId(entries, {
        turnId: TurnId.make("turn-1"),
        assistantMessageId: MessageId.make("assistant-final"),
        startedAt: "2026-02-23T00:00:00.000Z",
        completedAt: "2026-02-23T00:00:04.000Z",
      }),
    ).toBe("work-after-assistant");
  });
});

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "context-1",
          turnId: "turn-1",
          kind: "context-window.updated",
          summary: "Context window updated",
          tone: "info",
        }),
        makeActivity({
          id: "tool-1",
          turnId: "turn-1",
          kind: "tool.completed",
          summary: "Ran command",
          tone: "tool",
        }),
      ],
      TurnId.make("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-1",
          turnId: "turn-1",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
        }),
      ],
      TurnId.make("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });

  it("includes unscoped manual compaction only in the main work log", () => {
    const activities = [
      makeActivity({
        id: "request",
        kind: "provider.compaction.requested",
        summary: "Compaction requested",
      }),
      makeActivity({
        id: "failed",
        kind: "provider.compaction.failed",
        summary: "Compaction could not start",
      }),
      makeActivity({
        id: "native",
        kind: "tool.started",
        summary: "Context compaction started",
        payload: { itemType: "context_compaction", itemId: "compact" },
      }),
      makeActivity({ id: "unrelated", kind: "runtime.warning" }),
      makeActivity({ id: "old", turnId: "old-turn", kind: "tool.completed" }),
    ];
    const turnId = TurnId.make("current-turn");
    expect(deriveWorkLogEntries(activities, turnId)).toEqual([]);
    expect(
      deriveWorkLogEntries(activities, turnId, { includeUnscopedCompaction: true })
        .map((entry) => entry.id)
        .toSorted(),
    ).toEqual(["failed", "native", "request"]);
  });

  it.each([
    ["Context compacted", "completed"],
    ["Context compaction failed", "failed"],
    ["Context compaction interrupted", "declined"],
  ])("replaces the native compaction start with %s in the same tool row", (summary, status) => {
    const started = makeActivity({
      id: "started",
      turnId: "manual-turn",
      kind: "tool.started",
      summary: "Context compaction started",
      payload: { itemType: "context_compaction", itemId: "compact", title: "Context compaction" },
    });
    expect(deriveWorkLogEntries([started], TurnId.make("manual-turn"))[0]?.toolTitle).toBe(
      "Compacting context",
    );
    const completed = makeActivity({
      id: "completed",
      turnId: "manual-turn",
      kind: "tool.completed",
      summary,
      payload: {
        itemType: "context_compaction",
        itemId: "compact",
        title: "Context compaction",
        status,
      },
    });
    const entries = deriveWorkLogEntries([started, completed], TurnId.make("manual-turn"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "completed", toolTitle: summary });
    // An unrelated native item must never finish a newer compaction.
    const other = { ...completed, payload: { ...(completed.payload as object), itemId: "other" } };
    expect(deriveWorkLogEntries([started, other], TurnId.make("manual-turn"))).toHaveLength(2);
  });

  it("keeps provider switch notices as normal work log entries", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "provider-switch-1",
          turnId: "turn-1",
          kind: "provider.switched",
          summary: "Switched from Claude to Codex · gpt-5.6-sol",
          tone: "info",
          payload: {
            fromProvider: "claudeAgent",
            toProvider: "codex",
            toModel: "gpt-5.6-sol",
          },
        }),
      ],
      TurnId.make("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      label: "Switched from Claude to Codex · gpt-5.6-sol",
      tone: "info",
    });
  });

  it("folds only the exact same-turn Codex start ACK into accepted settings", () => {
    const configuration = {
      version: 1,
      provider: "codex",
      providerInstanceId: "codex_personal",
      providerDisplayName: "Codex Personal",
      model: "gpt-6.1-sol",
      modelDisplayName: "GPT-6.1 Sol",
      effort: "ultra",
      fastMode: true,
      runtimeMode: "full-access",
      interactionMode: "default",
      settingsSource: "submitted",
    };
    const activities = [
      makeActivity({
        id: "accepted-ack",
        sequence: 1,
        turnId: "turn-settings",
        kind: "task.progress",
        payload: {
          taskId: "codex-turn-start:turn-settings",
          detail: "Codex app-server accepted turn/start.",
        },
      }),
      makeActivity({
        id: "accepted-settings",
        sequence: 2,
        turnId: "turn-settings",
        kind: "provider.turn.configuration",
        tone: "info",
        summary: "Turn started",
        payload: { turnConfiguration: configuration },
      }),
      makeActivity({
        id: "other-task",
        sequence: 3,
        turnId: "turn-settings",
        kind: "task.progress",
        payload: { taskId: "different-task", detail: "Still working" },
      }),
      makeActivity({
        id: "other-turn-ack",
        sequence: 4,
        turnId: "turn-other",
        kind: "task.progress",
        payload: {
          taskId: "codex-turn-start:turn-other",
          detail: "Codex app-server accepted turn/start.",
        },
      }),
      makeActivity({
        id: "switched",
        sequence: 5,
        turnId: "turn-settings",
        kind: "provider.switched",
        tone: "info",
        summary: "Switched from Claude Work to Codex Personal",
      }),
    ];
    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual([
      "accepted-settings",
      "other-task",
      "other-turn-ack",
      "switched",
    ]);
    expect(entries[0]).toMatchObject({
      label: "Turn accepted · GPT-6.1 Sol · Effort: Ultra · Fast on",
      detail: "Account: Codex Personal · Build · Full access · Submitted settings",
      turnConfiguration: configuration,
      tone: "info",
    });
    expect(deriveWorkLogEntries(activities, TurnId.make("turn-settings"))).toHaveLength(3);
  });

  it("preserves legacy ACK text when settings are absent or malformed", () => {
    const ack = makeActivity({
      id: "legacy-accepted",
      turnId: "legacy-turn",
      kind: "task.progress",
      summary: "Reasoning update",
      payload: {
        taskId: "codex-turn-start:legacy-turn",
        detail: "Codex app-server accepted turn/start.",
      },
    });
    const malformed = makeActivity({
      id: "malformed-settings",
      turnId: "legacy-turn",
      kind: "provider.turn.configuration",
      tone: "info",
      summary: "Turn started",
      payload: {
        turnConfiguration: {
          version: 1,
          provider: "codex",
          providerDisplayName: "Missing required identity and mode",
        },
      },
    });
    expect(deriveWorkLogEntries([ack], undefined)).toEqual([
      expect.objectContaining({
        id: "legacy-accepted",
        label: "Codex app-server accepted turn/start.",
      }),
    ]);
    const entries = deriveWorkLogEntries([ack, malformed], undefined);
    expect(entries.find((entry) => entry.id === "legacy-accepted")?.label).toBe(
      "Codex app-server accepted turn/start.",
    );
    expect(entries.every((entry) => entry.turnConfiguration === undefined)).toBe(true);
  });

  it("preserves each historical turn's model, account label, and explicit Fast state", () => {
    const base = {
      version: 1,
      provider: "codex",
      providerInstanceId: "codex_personal",
      runtimeMode: "full-access",
      interactionMode: "default",
      settingsSource: "submitted",
    };
    const activities = [
      makeActivity({
        id: "old-configuration",
        turnId: "old-turn",
        kind: "provider.turn.configuration",
        tone: "info",
        payload: {
          turnConfiguration: {
            ...base,
            providerDisplayName: "Original account label",
            model: "gpt-6.1-sol",
            modelDisplayName: "GPT-6.1 Sol",
            effort: "ultra",
            fastMode: true,
          },
        },
      }),
      makeActivity({
        id: "new-configuration",
        turnId: "new-turn",
        kind: "provider.turn.configuration",
        tone: "info",
        payload: {
          turnConfiguration: {
            ...base,
            providerDisplayName: "Renamed same account",
            model: "gpt-6-astra",
            modelDisplayName: "GPT-6 Astra",
            effort: "max",
            fastMode: false,
          },
        },
      }),
    ];
    const oldEntries = deriveWorkLogEntries(activities, TurnId.make("old-turn"));
    expect(oldEntries[0]?.label).toBe("Turn accepted · GPT-6.1 Sol · Effort: Ultra · Fast on");
    expect(oldEntries[0]?.detail).toBe(
      "Account: Original account label · Build · Full access · Submitted settings",
    );
    const newEntries = deriveWorkLogEntries(activities, TurnId.make("new-turn"));
    expect(newEntries[0]?.label).toBe("Turn accepted · GPT-6 Astra · Effort: Max · Fast off");
    expect(newEntries[0]?.detail).toBe(
      "Account: Renamed same account · Build · Full access · Submitted settings",
    );
  });

  it("shows active Codex context compaction items and collapses them when completed", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-started",
          turnId: "turn-1",
          kind: "tool.started",
          summary: "Context compaction started",
          tone: "tool",
          payload: {
            itemType: "context_compaction",
            title: "Context compaction",
          },
        }),
        makeActivity({
          id: "compaction-completed",
          turnId: "turn-1",
          kind: "tool.completed",
          summary: "Context compacted",
          tone: "tool",
          payload: {
            itemType: "context_compaction",
            title: "Context compaction",
          },
        }),
      ],
      TurnId.make("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
    expect(entries[0]?.tone).toBe("tool");
  });
});

describe("hasToolActivityForTurn", () => {
  it("returns false when turn id is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
    ];

    expect(hasToolActivityForTurn(activities, undefined)).toBe(false);
    expect(hasToolActivityForTurn(activities, null)).toBe(false);
  });

  it("returns true only for matching tool activity in the target turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
      makeActivity({ id: "info-1", turnId: "turn-2", kind: "turn.completed", tone: "info" }),
    ];

    expect(hasToolActivityForTurn(activities, TurnId.make("turn-1"))).toBe(true);
    expect(hasToolActivityForTurn(activities, TurnId.make("turn-2"))).toBe(false);
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false while a ready session still owns the active turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "ready",
        activeTurnId: TurnId.make("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("uses the new send start while the session is running a different turn", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-2"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});
