import {
  EnvironmentId,
  EventId,
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import { deriveActiveProviderTasks, type ProviderTasksContext } from "./ProviderTasks";

const runtimeId = SubagentRuntimeId.make("00000000-0000-4000-8000-000000000001");
const reference = {
  taskId: "native-task",
  runtimeId,
  capability: {
    providerInstanceId: ProviderInstanceId.make("claude-account"),
    taskGeneration: "00000000-0000-4000-8000-000000000002",
    canStop: true,
    canBackground: false,
  },
};
const context: ProviderTasksContext = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("chat"),
  providerInstanceId: reference.capability.providerInstanceId,
  activities: [],
  runtimeSession: { subagentRuntimeId: runtimeId, orchestrationStatus: "running" },
};
function activity(kind: string, payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: EventId.make(kind),
    kind,
    payload,
    createdAt: "2026-10-05T00:00:00.000Z",
    tone: "info",
    summary: "Native task",
    turnId: TurnId.make("turn"),
    sequence: kind.endsWith("started") ? 1 : 2,
  };
}
describe("ordinary provider task controls", () => {
  it("keeps opaque turn/task separator spellings distinct", () => {
    const first = {
      ...activity("task.started", { taskId: "b:c", individualTaskControl: reference }),
      turnId: TurnId.make("a"),
    };
    const second = {
      ...activity("task.started", { taskId: "c", individualTaskControl: reference }),
      turnId: TurnId.make("a:b"),
    };
    expect(deriveActiveProviderTasks({ ...context, activities: [first, second] })).toHaveLength(2);
  });
  it("retains only exact-account current-generation native controls and removes completed, hidden and unstamped tasks", () => {
    const started = activity("task.started", {
      taskId: "native-task",
      individualTaskControl: reference,
    });
    expect(deriveActiveProviderTasks({ ...context, activities: [started] })).toHaveLength(1);
    for (const payload of [
      { status: "completed" },
      { visibility: "ambient", individualTaskControl: reference },
      {},
      { subagent: {}, individualTaskControl: reference },
    ]) {
      const update = activity(payload.status ? "task.completed" : "task.progress", {
        taskId: "native-task",
        ...payload,
      });
      expect(deriveActiveProviderTasks({ ...context, activities: [started, update] })).toEqual([]);
      expect(deriveActiveProviderTasks({ ...context, activities: [update, started] })).toEqual([]);
    }
    const otherAccountTasks = deriveActiveProviderTasks({
      ...context,
      providerInstanceId: ProviderInstanceId.make("other"),
      activities: [started],
    });
    expect(otherAccountTasks).toHaveLength(1);
    expect(otherAccountTasks[0]?.reference).toBeUndefined();
    expect(
      deriveActiveProviderTasks({
        ...context,
        runtimeSession: { orchestrationStatus: "stopped", subagentRuntimeId: runtimeId },
        activities: [started],
      }),
    ).toEqual([]);
    expect(
      deriveActiveProviderTasks({
        ...context,
        runtimeSession: { orchestrationStatus: "ready", subagentRuntimeId: "other-runtime" },
        activities: [started],
      }),
    ).toEqual([]);
  });
  it("backgrounds only the exact foreground item and removes the affordance on its detached placeholder", () => {
    const started = activity("tool.started", {
      itemId: "raw-item",
      individualTaskControl: {
        ...reference,
        taskId: "server-minted-control",
        capability: { ...reference.capability, canStop: false, canBackground: true },
      },
    });
    expect(
      deriveActiveProviderTasks({ ...context, activities: [started] })[0]?.reference?.taskId,
    ).toBe("server-minted-control");
    const sibling = activity("tool.started", {
      itemId: "sibling",
      individualTaskControl: { ...reference, taskId: "sibling-control" },
    });
    const detached = activity("tool.updated", {
      itemId: "raw-item",
      status: "inProgress",
      detail: "Continuing in the background",
    });
    expect(
      deriveActiveProviderTasks({ ...context, activities: [started, sibling, detached] }).map(
        (task) => task.reference?.taskId,
      ),
    ).toEqual(["sibling-control"]);
  });
});
