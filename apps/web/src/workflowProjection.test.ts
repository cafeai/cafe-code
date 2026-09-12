import type { OrchestrationThreadActivity } from "@cafecode/contracts";
import { EventId, ThreadId, TurnId } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveWorkflowProjection,
  EMPTY_WORKFLOW_SNAPSHOT,
  WORKFLOW_MAX_NODES,
  WORKFLOW_MAX_RECENT_ACTIVITIES,
  WORKFLOW_MAX_TEXT_CHARS,
} from "./workflowProjection";

const TURN = TurnId.make("turn-1");
const THREAD = ThreadId.make("thread-1");

let sequence = 0;

function activity(
  kind: string,
  payload: unknown,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  sequence += 1;
  return {
    id: EventId.make(`event-${sequence}`),
    tone: "tool",
    kind,
    summary: `${kind} summary`,
    payload,
    turnId: TURN,
    sequence,
    createdAt: new Date(Date.UTC(2026, 8, 11, 12, 0, sequence)).toISOString(),
    ...overrides,
  } as OrchestrationThreadActivity;
}

function startedTask(threadId: string, label: string) {
  return activity("task.started", {
    taskId: threadId,
    taskType: "subagent",
    subagent: { threadId, label, objective: `Review ${label}`, status: "active" },
  });
}

function completedTask(threadId: string, status: "completed" | "failed" | "stopped") {
  return activity("task.completed", {
    taskId: threadId,
    status,
    subagent: { threadId, status },
  });
}

describe("deriveWorkflowProjection", () => {
  it("returns the empty snapshot when no thread is selected", () => {
    const snapshot = deriveWorkflowProjection({
      threadId: null,
      environmentId: "environment-local",
      activities: [startedTask("child-a", "Audit")],
    });

    expect(snapshot).toBe(EMPTY_WORKFLOW_SNAPSHOT);
    expect(snapshot.nodes).toHaveLength(0);
  });

  it("projects reported agents under the thread node with source-reported state", () => {
    const snapshot = deriveWorkflowProjection({
      threadId: THREAD,
      environmentId: "environment-local",
      threadTitle: "Ship the release",
      activities: [
        startedTask("child-a", "Audit"),
        activity("task.progress", {
          taskId: "child-a",
          description: "Reading the changelog",
          subagent: { threadId: "child-a", status: "active" },
        }),
        startedTask("child-b", "Docs"),
        completedTask("child-b", "completed"),
      ],
      latestTurn: {
        turnId: TURN,
        state: "running",
        requestedAt: "2026-09-11T12:00:00.000Z",
        startedAt: "2026-09-11T12:00:01.000Z",
        completedAt: null,
      },
      providerLabel: "codex",
      modelLabel: "gpt-5.2",
    });

    expect(snapshot.nodes[0]).toMatchObject({
      kind: "thread",
      parentId: null,
      status: "running",
      title: "Ship the release",
    });
    expect(snapshot.agentCount).toBe(2);
    const agents = snapshot.nodes.slice(1);
    expect(agents.map((node) => node.title)).toEqual(["Audit", "Docs"]);
    expect(agents.map((node) => node.status)).toEqual(["running", "completed"]);
    // Every agent hangs off the thread that recorded it. No agent is ever the
    // parent of another agent, because no provider reports that relationship.
    expect(agents.every((node) => node.parentId === snapshot.nodes[0]?.id)).toBe(true);
    expect(snapshot.fidelity).toBe("live");
    expect(snapshot.providerLabel).toBe("codex");
    expect(snapshot.modelLabel).toBe("gpt-5.2");
  });

  it("reports lifecycle-only fidelity when no progress edge arrived", () => {
    const snapshot = deriveWorkflowProjection({
      threadId: THREAD,
      environmentId: null,
      activities: [startedTask("child-a", "Audit"), completedTask("child-a", "completed")],
    });

    expect(snapshot.fidelity).toBe("lifecycle-only");
  });

  it("reports not-reported fidelity and no agents when the provider stayed silent", () => {
    const snapshot = deriveWorkflowProjection({
      threadId: THREAD,
      environmentId: null,
      activities: [
        activity("tool.started", { itemId: "tool-1" }),
        activity("message.delta", { text: "hello" }),
      ],
    });

    expect(snapshot.fidelity).toBe("not-reported");
    expect(snapshot.agentCount).toBe(0);
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.sourceActivityCount).toBe(0);
  });

  it("keeps a terminal agent terminal when a late progress edge replays", () => {
    const snapshot = deriveWorkflowProjection({
      threadId: THREAD,
      environmentId: null,
      activities: [
        startedTask("child-a", "Audit"),
        completedTask("child-a", "failed"),
        activity("task.progress", {
          taskId: "child-a",
          description: "Still working",
          subagent: { threadId: "child-a", status: "active" },
        }),
      ],
    });

    expect(snapshot.nodes[1]).toMatchObject({ status: "failed" });
  });

  it("marks the thread node unknown when no turn is recorded", () => {
    const snapshot = deriveWorkflowProjection({
      threadId: THREAD,
      environmentId: null,
      activities: [],
      latestTurn: null,
    });

    expect(snapshot.nodes[0]).toMatchObject({
      status: "unknown",
      startedAt: null,
      observedSpanSeconds: null,
    });
    expect(snapshot.turnId).toBeNull();
  });

  it("labels missing source fields instead of inventing them", () => {
    const snapshot = deriveWorkflowProjection({
      threadId: THREAD,
      environmentId: null,
      activities: [
        activity("task.started", {
          taskId: "child-a",
          subagent: { threadId: "child-a" },
        }),
      ],
      providerLabel: null,
      modelLabel: "   ",
    });

    const agent = snapshot.nodes[1];
    expect(agent).toMatchObject({ title: "Subagent", objective: null, detail: null });
    expect(snapshot.providerLabel).toBeNull();
    expect(snapshot.modelLabel).toBeNull();
  });

  it("derives the observed span from recorded timestamps only", () => {
    const started = activity("task.started", {
      taskId: "child-a",
      subagent: { threadId: "child-a", label: "Audit", status: "active" },
    });
    const completed = activity(
      "task.completed",
      { taskId: "child-a", status: "completed", subagent: { threadId: "child-a" } },
      { createdAt: new Date(Date.parse(started.createdAt) + 42_000).toISOString() },
    );

    const snapshot = deriveWorkflowProjection({
      threadId: THREAD,
      environmentId: null,
      activities: [started, completed],
    });

    expect(snapshot.nodes[1]?.observedSpanSeconds).toBe(42);
  });

  it("bounds nodes and counts the omitted rows", () => {
    const activities = Array.from({ length: WORKFLOW_MAX_NODES + 10 }, (_, index) =>
      startedTask(`child-${index}`, `Agent ${index}`),
    );

    const snapshot = deriveWorkflowProjection({
      threadId: THREAD,
      environmentId: null,
      activities,
    });

    expect(snapshot.nodes).toHaveLength(WORKFLOW_MAX_NODES);
    expect(snapshot.agentCount).toBe(WORKFLOW_MAX_NODES - 1);
    expect(snapshot.omittedNodeCount).toBe(WORKFLOW_MAX_NODES + 10 - (WORKFLOW_MAX_NODES - 1));
  });

  it("bounds the recent activity list, newest first, and counts the omitted rows", () => {
    const activities = Array.from({ length: WORKFLOW_MAX_RECENT_ACTIVITIES + 5 }, (_, index) =>
      activity("task.progress", {
        taskId: "child-a",
        description: `Update ${index}`,
        subagent: { threadId: "child-a", status: "active" },
      }),
    );

    const snapshot = deriveWorkflowProjection({
      threadId: THREAD,
      environmentId: null,
      activities: [startedTask("child-a", "Audit"), ...activities],
    });

    expect(snapshot.recentActivities).toHaveLength(WORKFLOW_MAX_RECENT_ACTIVITIES);
    expect(snapshot.omittedActivityCount).toBe(6);
    const [newest, next] = snapshot.recentActivities;
    expect(Date.parse(newest!.createdAt)).toBeGreaterThanOrEqual(Date.parse(next!.createdAt));
  });

  it("attaches an activity row to the node that reported it", () => {
    const snapshot = deriveWorkflowProjection({
      threadId: THREAD,
      environmentId: null,
      activities: [
        startedTask("child-a", "Audit"),
        activity("turn.plan.updated", { plan: [{ step: "Read the code", status: "pending" }] }),
      ],
    });

    const agentId = snapshot.nodes[1]?.id;
    const rows = snapshot.recentActivities;
    expect(rows.find((row) => row.kind === "task.started")?.nodeId).toBe(agentId);
    expect(rows.find((row) => row.kind === "turn.plan.updated")?.nodeId).toBeNull();
  });

  it("bounds one display string and never emits a control character", () => {
    const snapshot = deriveWorkflowProjection({
      threadId: THREAD,
      environmentId: null,
      activities: [
        activity("task.started", {
          taskId: "child-a",
          subagent: {
            threadId: "child-a",
            label: "Audit",
            objective: `${"x".repeat(WORKFLOW_MAX_TEXT_CHARS * 2)}`,
            status: "active",
          },
        }),
      ],
    });

    const objective = snapshot.nodes[1]?.objective ?? "";
    expect(objective.length).toBeLessThanOrEqual(WORKFLOW_MAX_TEXT_CHARS);
    expect(/[\p{Cc}]/u.test(objective)).toBe(false);
  });

  it("never copies the provider history binding into the projection", () => {
    const snapshot = deriveWorkflowProjection({
      threadId: THREAD,
      environmentId: null,
      activities: [
        activity("task.started", {
          taskId: "child-a",
          subagent: {
            threadId: "child-a",
            historyId: "secret-transcript-binding",
            label: "Audit",
            status: "active",
          },
        }),
      ],
    });

    expect(JSON.stringify(snapshot)).not.toContain("secret-transcript-binding");
  });

  it("gives two turns that reuse one provider identity separate nodes", () => {
    const otherTurn = TurnId.make("turn-2");
    const snapshot = deriveWorkflowProjection({
      threadId: THREAD,
      environmentId: null,
      activities: [
        startedTask("child-a", "Audit"),
        activity(
          "task.started",
          {
            taskId: "child-a",
            subagent: { threadId: "child-a", label: "Audit", status: "active" },
          },
          { turnId: otherTurn },
        ),
      ],
    });

    expect(snapshot.agentCount).toBe(2);
    expect(new Set(snapshot.nodes.map((node) => node.id)).size).toBe(3);
    expect(snapshot.duplicateNodeIdCount).toBe(0);
  });
});
