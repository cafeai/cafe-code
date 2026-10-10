import {
  EventId,
  ProviderInstanceId,
  SubagentRuntimeId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import { deriveLiveWorkObservations, readLiveWorkObservation } from "./liveWork.ts";

const runtimeId = SubagentRuntimeId.make("00000000-0000-4000-8000-000000000001");
const session = { subagentRuntimeId: runtimeId, orchestrationStatus: "ready" as const };
const control = {
  taskId: "native-task",
  runtimeId,
  capability: {
    providerInstanceId: ProviderInstanceId.make("account"),
    taskGeneration: "00000000-0000-4000-8000-000000000002",
    canStop: true,
    canBackground: false,
  },
};
function activity(
  kind: string,
  sequence: number,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`activity-${sequence}`),
    kind,
    sequence,
    payload,
    turnId: TurnId.make("turn"),
    summary: "Task",
    tone: "info",
    createdAt: "2026-10-09T00:00:00.000Z",
  };
}

describe("current native work presentation", () => {
  it("keeps independently active work after the main response finishes and rejects stopped or replaced runtimes", () => {
    const started = activity("task.started", 1, {
      taskId: "native-task",
      individualTaskControl: control,
    });
    expect(deriveLiveWorkObservations([started], session)).toHaveLength(1);
    expect(
      deriveLiveWorkObservations([started], { ...session, orchestrationStatus: "stopped" }),
    ).toEqual([]);
    expect(
      deriveLiveWorkObservations([started], {
        ...session,
        subagentRuntimeId: "00000000-0000-4000-8000-000000000003",
      }),
    ).toEqual([]);
    expect(deriveLiveWorkObservations([started], null)).toEqual([]);
  });
  it("uses durable lifecycle order and does not resurrect completed work from a late start", () => {
    const started = activity("task.started", 1, {
      taskId: "native-task",
      individualTaskControl: control,
    });
    const completed = activity("task.completed", 2, {
      taskId: "native-task",
      nativeWorkRuntimeId: runtimeId,
      status: "completed",
    });
    expect(deriveLiveWorkObservations([completed, started], session)).toEqual([]);
    expect(readLiveWorkObservation(completed)?.active).toBe(false);
  });
  it("retracts ambient or unstamped work and does not treat routine turn progress as an independent task", () => {
    const started = activity("task.started", 1, {
      taskId: "native-task",
      individualTaskControl: control,
    });
    for (const payload of [
      { taskId: "native-task" },
      { taskId: "native-task", individualTaskControl: control, visibility: "ambient" },
    ])
      expect(
        deriveLiveWorkObservations([started, activity("task.progress", 2, payload)], session),
      ).toEqual([]);
    expect(
      readLiveWorkObservation(
        activity("task.progress", 1, {
          taskId: "codex-turn-steer:turn",
          nativeWorkRuntimeId: runtimeId,
        }),
      ),
    ).toBeNull();
  });
  it("counts structured agents separately and fails closed on a malformed native binding", () => {
    const started = activity("task.started", 1, {
      taskId: "agent-task",
      subagent: { threadId: "agent", runtimeId, status: "active" },
    });
    expect(deriveLiveWorkObservations([started], session)[0]?.observation.agent).toBe(true);
    expect(
      readLiveWorkObservation(
        activity("task.started", 2, {
          taskId: "task",
          nativeWorkRuntimeId: runtimeId,
          individualTaskControl: {},
        }),
      )?.active,
    ).toBe(false);
  });
});
