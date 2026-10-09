import {
  EventId,
  ProviderInstanceId,
  SubagentRuntimeId,
  TurnId,
  type OrchestrationThreadActivity,
  type RuntimeWorkflowPresentation,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveWorkflowTasks,
  readWorkflowTaskPresentation,
  type WorkflowTaskContext,
} from "./workflowTaskActivity";

const runtimeId = SubagentRuntimeId.make("10000000-0000-4000-8000-000000000001");
const otherRuntimeId = SubagentRuntimeId.make("20000000-0000-4000-8000-000000000001");
const providerInstanceId = ProviderInstanceId.make("claude-account-a");
const workflow: RuntimeWorkflowPresentation = {
  runtimeId,
  providerInstanceId,
  name: "Review implementation",
};
const snapshot: RuntimeWorkflowPresentation = {
  ...workflow,
  phases: [
    { index: 1, title: "Explore", kind: "parallel" },
    { index: 2, title: "Review" },
  ],
  agents: [
    {
      index: 1,
      phaseIndex: 1,
      label: "Inspect UI",
      model: "claude-opus-4-8",
      status: "completed",
      totalTokens: 1234,
      durationMs: 2400,
    },
    { index: 2, phaseIndex: 2, label: "Review boundaries", status: "running" },
  ],
};
const control = {
  runtimeId,
  taskId: "workflow-root",
  capability: {
    providerInstanceId,
    taskGeneration: "10000000-0000-4000-8000-000000000002",
    canStop: true,
    canBackground: false,
  },
};
const context: WorkflowTaskContext = {
  providerInstanceId,
  activities: [],
  runtimeSession: { subagentRuntimeId: runtimeId, orchestrationStatus: "running" },
};
function activity(
  sequence: number,
  kind: string,
  payload: Record<string, unknown> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`workflow-${sequence}`),
    kind,
    sequence,
    createdAt: `2026-10-09T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    tone: "info",
    summary: "Workflow activity",
    turnId: TurnId.make("turn"),
    payload: { taskId: "workflow-root", workflow, ...payload },
  };
}
const start = activity(1, "task.started", {
  taskType: "local_workflow",
  detail: "Review the requested change",
  individualTaskControl: control,
});

describe("received workflow task reconstruction", () => {
  it("keeps title and original description distinct from progress without inventing snapshot rows", () => {
    const progress = activity(2, "task.progress", {
      detail: "Reviewing boundaries",
      usage: { total_tokens: 0, duration_ms: 0 },
    });
    expect(deriveWorkflowTasks({ ...context, activities: [progress, start] })).toMatchObject([
      {
        title: "Review implementation",
        description: "Review the requested change",
        summary: "Reviewing boundaries",
        status: "running",
        startedAt: start.createdAt,
        totalTokens: 0,
        durationMs: 0,
        workflow: { name: "Review implementation" },
      },
    ]);
    expect(
      deriveWorkflowTasks({ ...context, activities: [start] })[0]?.workflow.phases,
    ).toBeUndefined();
    expect(deriveWorkflowTasks({ ...context, activities: [start] })[0]?.reference).toEqual(control);
  });

  it("replaces complete snapshots, retains omitted arrays, and honors explicit empty snapshots", () => {
    const first = activity(2, "task.progress", {
      workflow: snapshot,
      usage: { total_tokens: 1400, duration_ms: 2500 },
    });
    const omitted = activity(3, "task.progress", {
      workflow: { runtimeId, providerInstanceId },
      detail: "Still reviewing",
    });
    const replaced = activity(4, "task.progress", {
      workflow: {
        ...workflow,
        phases: [{ index: 2, title: "Review" }],
        agents: [{ index: 2, phaseIndex: 2, status: "completed", totalTokens: 200 }],
      },
    });
    const retained = deriveWorkflowTasks({ ...context, activities: [omitted, first, start] })[0];
    expect(retained?.workflow).toEqual(snapshot);
    expect(retained?.totalTokens).toBe(1400);
    expect(retained?.durationMs).toBe(2500);
    const replacement = deriveWorkflowTasks({
      ...context,
      activities: [start, first, omitted, replaced],
    })[0];
    expect(replacement?.workflow.agents).toEqual([
      { index: 2, phaseIndex: 2, status: "completed", totalTokens: 200 },
    ]);
    expect(replacement?.workflow.phases).toHaveLength(1);
    const emptied = activity(5, "task.progress", {
      workflow: { ...workflow, phases: [], agents: [] },
    });
    expect(
      deriveWorkflowTasks({ ...context, activities: [start, first, emptied] })[0]?.workflow,
    ).toMatchObject({ phases: [], agents: [] });
  });

  it("freezes received terminal telemetry and resets only for an explicit new root incarnation", () => {
    const progress = activity(2, "task.progress", { workflow: snapshot });
    const done = activity(3, "task.completed", {
      status: "completed",
      usage: { total_tokens: 2000, duration_ms: 5000 },
    });
    const late = activity(4, "task.progress", {
      workflow: { ...snapshot, agents: [{ index: 2, status: "running", totalTokens: 9999 }] },
      usage: { total_tokens: 9999, duration_ms: 9999 },
    });
    const completed = deriveWorkflowTasks({
      ...context,
      activities: [late, start, done, progress],
    })[0];
    expect(completed).toMatchObject({
      status: "completed",
      totalTokens: 2000,
      durationMs: 5000,
      completedAt: done.createdAt,
    });
    expect(completed?.workflow).toEqual(snapshot);
    expect(completed?.reference).toBeUndefined();
    const restarted = activity(5, "task.started", {
      detail: "Start a fresh review",
      individualTaskControl: control,
    });
    expect(
      deriveWorkflowTasks({ ...context, activities: [start, progress, done, late, restarted] })[0],
    ).toMatchObject({
      status: "running",
      description: "Start a fresh review",
      startedAt: restarted.createdAt,
    });
    expect(
      deriveWorkflowTasks({ ...context, activities: [start, progress, done, restarted] })[0]
        ?.workflow.agents,
    ).toBeUndefined();
    const duplicateStart = activity(3, "task.started");
    expect(
      deriveWorkflowTasks({ ...context, activities: [start, progress, duplicateStart] })[0]
        ?.workflow,
    ).toEqual(snapshot);
  });

  it("binds liveness, visibility and controls to the exact account/runtime/root without child identities", () => {
    const progress = activity(2, "task.progress", {
      workflow: snapshot,
      individualTaskControl: control,
    });
    for (const runtimeSession of [
      null,
      { subagentRuntimeId: otherRuntimeId, orchestrationStatus: "running" as const },
      { subagentRuntimeId: runtimeId, orchestrationStatus: "stopped" as const },
    ]) {
      const row = deriveWorkflowTasks({
        ...context,
        runtimeSession,
        activities: [start, progress],
      })[0];
      expect(row?.status).toBe("unknown");
      expect(row?.reference).toBeUndefined();
    }
    expect(
      deriveWorkflowTasks({
        ...context,
        providerInstanceId: ProviderInstanceId.make("other-account"),
        activities: [start, progress],
      }),
    ).toEqual([]);
    const foreign = activity(3, "task.completed", {
      workflow: { ...workflow, providerInstanceId: ProviderInstanceId.make("other-account") },
      status: "completed",
    });
    const delayedRuntime = activity(4, "task.completed", {
      workflow: { ...workflow, runtimeId: otherRuntimeId },
      status: "completed",
    });
    expect(
      deriveWorkflowTasks({ ...context, activities: [start, progress, foreign, delayedRuntime] })[0]
        ?.status,
    ).toBe("running");
    expect(
      deriveWorkflowTasks({
        ...context,
        activities: [start, progress, activity(3, "task.progress", { visibility: "ambient" })],
      }),
    ).toEqual([]);
    const mismatchedControl = activity(3, "task.progress", {
      individualTaskControl: { ...control, taskId: "snapshot-child" },
    });
    expect(
      deriveWorkflowTasks({ ...context, activities: [start, mismatchedControl] })[0]?.reference,
    ).toBeUndefined();
    expect(deriveWorkflowTasks({ ...context, activities: [progress] })).toHaveLength(1);
  });

  it("does not borrow a prior stamp or trust malformed counters and snapshot topology", () => {
    const unstamped = activity(2, "task.completed", {
      workflow: undefined,
      status: "completed",
      individualTaskControl: control,
    });
    expect(deriveWorkflowTasks({ ...context, activities: [start, unstamped] })[0]).toMatchObject({
      status: "unknown",
    });
    expect(
      deriveWorkflowTasks({ ...context, activities: [start, unstamped] })[0]?.reference,
    ).toBeUndefined();
    const invalidUsage = activity(2, "task.progress", {
      usage: { total_tokens: -1, duration_ms: Number.MAX_SAFE_INTEGER + 1 },
    });
    const row = deriveWorkflowTasks({ ...context, activities: [start, invalidUsage] })[0];
    expect(row?.totalTokens).toBeUndefined();
    expect(row?.durationMs).toBeUndefined();
    for (const invalid of [
      { ...workflow, phases: [] },
      { ...workflow, phases: [{ index: 1 }, { index: 1 }], agents: [] },
      { ...workflow, phases: [], agents: [{ index: 1, totalTokens: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...workflow, name: "hidden\u202E title" },
      { ...workflow, name: "/Users/private/workflow" },
      {
        ...workflow,
        phases: Array.from({ length: 65 }, (_, index) => ({ index: index + 1 })),
        agents: Array.from({ length: 64 }, (_, index) => ({ index: index + 1 })),
      },
    ]) {
      const invalidActivity = activity(2, "task.progress", { workflow: invalid });
      expect(readWorkflowTaskPresentation(invalidActivity)).toBeUndefined();
      expect(deriveWorkflowTasks({ ...context, activities: [invalidActivity] })).toEqual([]);
    }
  });
});
