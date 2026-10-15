import {
  EnvironmentId,
  EventId,
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  deriveActiveProviderTasks,
  hasProviderTaskContent,
  type ProviderTasksContext,
} from "./ProviderTasks";

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
  it("derives child identity independently of operation kind and controls in every task lane", () => {
    const child = "private-owner-child";
    const started = activity("tool.started", {
      itemId: "raw-agent-target",
      itemType: "collab_agent_tool_call",
      detail: "Root-looking task label",
      data: { toolName: "Agent", receiverThreadIds: ["not-the-owner"] },
      nativeWorkRuntimeId: runtimeId,
      taskOwner: { type: "child", id: child },
      individualTaskControl: reference,
    });
    const controlled = deriveActiveProviderTasks({ ...context, activities: [started] })[0];
    expect(controlled?.ownerSubagentId).toBe(child);
    expect(controlled?.reference).toEqual(reference);
    const readOnly = deriveActiveProviderTasks({
      ...context,
      providerInstanceId: ProviderInstanceId.make("other-account"),
      activities: [started],
    })[0];
    expect(readOnly?.ownerSubagentId).toBe(child);
    expect(readOnly?.reference).toBeUndefined();
    const foreground = {
      ...started,
      payload: {
        ...(started.payload as Record<string, unknown>),
        individualTaskControl: undefined,
      },
    };
    const observed = deriveActiveProviderTasks({
      ...context,
      activeTurnId: foreground.turnId,
      activeTurnRunning: true,
      activities: [foreground],
    })[0];
    expect(observed?.ownerSubagentId).toBe(child);
    expect(observed?.reference).toBeUndefined();
    expect(controlled?.kind).toBe("agent");
    expect(controlled?.ownerSubagentId).not.toBe(controlled?.reference?.taskId);
  });

  it("keeps root, missing, malformed and foreign-runtime owners blank without borrowing labels or controls", () => {
    const getter = vi.fn(() => "must-not-read");
    const accessor = Object.defineProperty({ type: "child" }, "id", { get: getter });
    for (const taskOwner of [
      undefined,
      { type: "root" },
      { type: "unknown", id: "unqualified-child" },
      { type: "child", id: "" },
      { type: "child", id: "x".repeat(513) },
      { type: "child", id: "bad\u0000identity" },
      Object.create({ type: "child", id: "inherited-child" }),
      accessor,
    ]) {
      const started = activity("tool.started", {
        itemId: "looks-like-child",
        itemType: "collab_agent_tool_call",
        detail: "Agent: looks-like-child",
        nativeWorkRuntimeId: runtimeId,
        taskOwner,
        individualTaskControl: reference,
      });
      const task = deriveActiveProviderTasks({ ...context, activities: [started] })[0];
      expect(task?.ownerSubagentId).toBeUndefined();
      expect(task?.reference).toEqual(reference);
    }
    expect(getter).not.toHaveBeenCalled();
    for (const nativeWorkRuntimeId of [undefined, "other-runtime"]) {
      const task = deriveActiveProviderTasks({
        ...context,
        activities: [
          activity("tool.started", {
            itemId: "control-is-not-owner-proof",
            taskOwner: { type: "child", id: "child" },
            nativeWorkRuntimeId,
            individualTaskControl: reference,
          }),
        ],
      })[0];
      expect(task?.reference).toEqual(reference);
      expect(task?.ownerSubagentId).toBeUndefined();
    }
  });

  it("replaces or clears the exact task's owner on newer activity and runtime replacement", () => {
    const started = activity("tool.started", {
      itemId: "same-task",
      nativeWorkRuntimeId: runtimeId,
      taskOwner: { type: "child", id: "first-child" },
      individualTaskControl: reference,
    });
    for (const taskOwner of [{ type: "child", id: "second-child" }, { type: "root" }, undefined]) {
      const update = activity("tool.updated", {
        itemId: "same-task",
        nativeWorkRuntimeId: runtimeId,
        taskOwner,
        individualTaskControl: reference,
      });
      for (const activities of [
        [started, update],
        [update, started],
      ]) {
        const tasks = deriveActiveProviderTasks({ ...context, activities });
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.ownerSubagentId).toBe(
          taskOwner?.type === "child" ? taskOwner.id : undefined,
        );
        expect(tasks[0]?.reference).toEqual(reference);
      }
    }
    expect(
      deriveActiveProviderTasks({
        ...context,
        runtimeSession: {
          orchestrationStatus: "running",
          subagentRuntimeId: "replacement-runtime",
        },
        activities: [started],
      }),
    ).toEqual([]);
  });
  it("formats controlled and read-only native placeholders without changing control identity", () => {
    const started = activity("tool.started", {
      itemId: "raw-bash-item",
      itemType: "command_execution",
      data: { toolName: "Bash", input: {} },
      detail: "Bash: {}",
      individualTaskControl: { ...reference, taskId: "server-minted-control" },
    });
    const controlled = deriveActiveProviderTasks({ ...context, activities: [started] })[0];
    expect(controlled?.title).toBe("Shell command");
    expect(controlled?.kind).toBe("command");
    expect(controlled?.reference?.taskId).toBe("server-minted-control");
    const observed = deriveActiveProviderTasks({
      ...context,
      providerInstanceId: ProviderInstanceId.make("other"),
      activities: [started],
    })[0];
    expect(observed?.title).toBe("Shell command");
    expect(observed?.reference).toBeUndefined();
    expect(
      deriveActiveProviderTasks({
        ...context,
        activities: [started],
        liveWork: { runtimeId, taskCount: 0, agentCount: 0 },
      }),
    ).toEqual([]);
  });

  it("formats an unstamped foreground placeholder but never derives controls from its label", () => {
    const started = activity("tool.started", {
      itemId: "agent-tool",
      itemType: "collab_agent_tool_call",
      data: { toolName: "Agent", input: {} },
      detail: "Agent: {}",
    });
    const foreground = deriveActiveProviderTasks({
      ...context,
      activeTurnId: started.turnId,
      activeTurnRunning: true,
      activities: [started],
    })[0];
    expect(foreground?.title).toBe("Agent task");
    expect(foreground?.reference).toBeUndefined();
    expect(
      deriveActiveProviderTasks({
        ...context,
        activeTurnId: started.turnId,
        activeTurnRunning: false,
        activities: [started],
      }),
    ).toEqual([]);
  });
  it("keeps workflow roots in their own presentation section even without mutation capability", () => {
    const started = activity("task.started", {
      taskId: "workflow-root",
      taskType: "local_workflow",
      workflow: {
        runtimeId,
        providerInstanceId: context.providerInstanceId,
        name: "Review workflow",
      },
      individualTaskControl: { ...reference, taskId: "workflow-root" },
    });
    expect(deriveActiveProviderTasks({ ...context, activities: [started] })).toEqual([]);
    expect(hasProviderTaskContent({ ...context, activities: [started] })).toBe(true);
    const inert = {
      ...started,
      payload: {
        ...(started.payload as Record<string, unknown>),
        individualTaskControl: undefined,
      },
    };
    expect(hasProviderTaskContent({ ...context, activities: [inert] })).toBe(true);
    expect(
      hasProviderTaskContent({
        ...context,
        providerInstanceId: ProviderInstanceId.make("other"),
        activities: [inert],
      }),
    ).toBe(false);
  });
  it("preserves an older unstamped local workflow's exact ordinary controls without admitting malformed workflow details", () => {
    const legacy = activity("task.started", {
      taskId: "legacy-workflow",
      taskType: "local_workflow",
      individualTaskControl: { ...reference, taskId: "legacy-workflow" },
    });
    expect(deriveActiveProviderTasks({ ...context, activities: [legacy] })).toHaveLength(1);
    const malformed = activity("task.started", {
      taskId: "legacy-workflow",
      taskType: "local_workflow",
      workflow: { future: "unadmitted" },
      individualTaskControl: { ...reference, taskId: "legacy-workflow" },
    });
    expect(deriveActiveProviderTasks({ ...context, activities: [malformed] })).toEqual([]);
    expect(hasProviderTaskContent({ ...context, activities: [malformed] })).toBe(false);
  });
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
