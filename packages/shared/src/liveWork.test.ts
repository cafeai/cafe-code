import {
  EventId,
  ProviderInstanceId,
  SubagentRuntimeId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import {
  deriveCurrentNativeAgentStarts,
  deriveLiveWorkObservations,
  readLiveWorkObservation,
} from "./liveWork.ts";

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

  it("counts only the latest admitted native task binding across root turns, including its retirement", () => {
    const agent = (taskId: string, status: "active" | "completed") => ({
      taskId,
      subagent: { threadId: taskId, runtimeId, status },
    });
    const first = activity("task.started", 1, agent("reused-task", "active"));
    const second = {
      ...activity("task.started", 2, agent("reused-task", "active")),
      turnId: TurnId.make("second-root"),
    };
    const independent = activity("task.started", 3, agent("independent-task", "active"));
    // The newest admitted observation retains its exact root identity. Old
    // per-turn lifecycle history remains present, but it is not another live
    // native task slot. Equal timestamps deliberately require canonical order.
    const current = {
      ...activity("task.started", 4, agent("reused-task", "active")),
      turnId: TurnId.make("current-root"),
    };
    const history = [independent, current, first, second];
    expect(
      new Set(deriveLiveWorkObservations(history, session).map(({ activity: head }) => head.id)),
    ).toEqual(new Set([independent.id, current.id]));

    for (const retirement of [
      activity("task.completed", 5, agent("reused-task", "completed")),
      activity("task.progress", 5, {
        ...agent("reused-task", "active"),
        visibility: "ambient",
      }),
    ]) {
      const retired = { ...retirement, turnId: current.turnId };
      expect(
        deriveLiveWorkObservations([retired, ...history], session).map(
          ({ activity: head }) => head.id,
        ),
      ).toEqual([independent.id]);
      expect(
        new Set(
          deriveCurrentNativeAgentStarts([retired, ...history]).map(
            ({ activity: start }) => start.id,
          ),
        ),
      ).toEqual(new Set([current.id, independent.id]));
    }
  });

  it("keeps runtime and tool-turn ownership separate when native task ids are reused", () => {
    const task = activity("task.started", 1, {
      taskId: "native-task",
      subagent: { threadId: "native-task", runtimeId, status: "active" },
    });
    const firstTool = activity("tool.started", 2, {
      itemId: "native-task",
      individualTaskControl: control,
    });
    const secondTool = {
      ...activity("tool.started", 3, {
        itemId: "native-task",
        individualTaskControl: control,
      }),
      turnId: TurnId.make("other-tool-root"),
    };
    const foreign = {
      ...activity("task.completed", 4, {
        taskId: "native-task",
        subagent: {
          threadId: "native-task",
          runtimeId: "00000000-0000-4000-8000-000000000003",
          status: "completed",
        },
      }),
      turnId: TurnId.make("foreign-root"),
    };
    const replacement = {
      ...activity("task.started", 6, {
        taskId: "native-task",
        subagent: { threadId: "native-task", runtimeId, status: "active" },
      }),
      turnId: TurnId.make("replacement-root"),
    };
    const history = [task, firstTool, secondTool, foreign, replacement];
    // Even a runtime-stamped late old-turn terminal cannot retire the exact
    // newer explicit start. The same ownership fence rejects old progress and
    // visibility changes without borrowing another task/tool namespace.
    for (const delayed of [
      activity("task.progress", 7, { taskId: "native-task" }),
      activity("task.completed", 7, {
        taskId: "native-task",
        subagent: { threadId: "native-task", runtimeId, status: "completed" },
      }),
      activity("task.progress", 7, {
        taskId: "native-task",
        subagent: { threadId: "native-task", runtimeId, status: "active" },
      }),
      activity("task.progress", 7, {
        taskId: "native-task",
        visibility: "ambient",
        subagent: { threadId: "native-task", runtimeId, status: "active" },
      }),
    ]) {
      expect(
        new Set(
          deriveLiveWorkObservations([...history, delayed], session).map(
            ({ activity: head }) => head.id,
          ),
        ),
      ).toEqual(new Set([replacement.id, firstTool.id, secondTool.id]));
    }
    const invalidated = {
      ...activity("task.progress", 7, { taskId: "native-task" }),
      turnId: replacement.turnId,
    };
    const delayedProgress = activity("task.progress", 8, {
      taskId: "native-task",
      subagent: { threadId: "native-task", runtimeId, status: "active" },
    });
    expect(
      new Set(
        deriveLiveWorkObservations([...history, invalidated, delayedProgress], session).map(
          ({ activity: head }) => head.id,
        ),
      ),
    ).toEqual(new Set([firstTool.id, secondTool.id]));
  });

  it("requires exact explicit agent-start evidence before superseding another root turn", () => {
    for (const payload of [
      { taskId: "native-task", individualTaskControl: control },
      {
        taskId: "native-task",
        subagent: { threadId: "different-child-namespace", runtimeId, status: "active" },
      },
    ]) {
      const first = activity("task.started", 1, payload);
      const second = {
        ...activity("task.started", 2, payload),
        turnId: TurnId.make("second-root"),
      };
      expect(
        new Set(
          deriveLiveWorkObservations([first, second], session).map(({ activity: head }) => head.id),
        ),
      ).toEqual(new Set([first.id, second.id]));
    }

    const ordinary = activity("task.started", 1, {
      taskId: "native-task",
      individualTaskControl: control,
    });
    const nativeAgent = {
      ...activity("task.started", 2, {
        taskId: "native-task",
        subagent: { threadId: "native-task", runtimeId, status: "active" },
      }),
      turnId: TurnId.make("native-agent-root"),
    };
    expect(
      new Set(
        deriveLiveWorkObservations([ordinary, nativeAgent], session).map(
          ({ activity: head }) => head.id,
        ),
      ),
    ).toEqual(new Set([ordinary.id, nativeAgent.id]));
    const nativeTerminal = {
      ...activity("task.completed", 3, {
        taskId: "native-task",
        nativeWorkRuntimeId: runtimeId,
        status: "completed",
      }),
      turnId: nativeAgent.turnId,
    };
    expect(
      deriveLiveWorkObservations([ordinary, nativeAgent, nativeTerminal], session).map(
        ({ activity: head }) => head.id,
      ),
    ).toEqual([ordinary.id]);

    const progress = activity("task.progress", 1, {
      taskId: "native-task",
      subagent: { threadId: "native-task", runtimeId, status: "active" },
    });
    const otherTurnProgress = {
      ...activity("task.progress", 2, {
        taskId: "native-task",
        subagent: { threadId: "native-task", runtimeId, status: "active" },
      }),
      turnId: TurnId.make("other-root"),
    };
    // A missed start retains the existing per-turn observation rather than
    // inventing a native incarnation or letting progress rebind its owner.
    expect(
      new Set(
        deriveLiveWorkObservations([progress, otherTurnProgress], session).map(
          ({ activity: head }) => head.id,
        ),
      ),
    ).toEqual(new Set([progress.id, otherTurnProgress.id]));
    const explicitStart = {
      ...activity("task.started", 3, {
        taskId: "native-task",
        subagent: { threadId: "native-task", runtimeId, status: "active" },
      }),
      turnId: TurnId.make("explicit-root"),
    };
    expect(
      deriveLiveWorkObservations([progress, otherTurnProgress, explicitStart], session).map(
        ({ activity: head }) => head.id,
      ),
    ).toEqual([explicitStart.id]);
  });

  it("uses known canonical sequences before clock-skewed legacy rows and BINARY ids for ties", () => {
    const payload = {
      taskId: "native-task",
      subagent: { threadId: "native-task", runtimeId, status: "active" },
    };
    const legacy = {
      ...activity("task.started", 1, payload),
      sequence: undefined,
      createdAt: "2026-11-03T00:00:00.000Z",
    };
    const current = {
      ...activity("task.started", 2, payload),
      turnId: TurnId.make("known-root"),
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    expect(
      deriveLiveWorkObservations([current, legacy], session).map(({ activity: head }) => head.id),
    ).toEqual([current.id]);
    const completed = {
      ...activity("task.completed", 3, {
        ...payload,
        status: "completed",
        subagent: { ...payload.subagent, status: "completed" },
      }),
      turnId: current.turnId,
      createdAt: current.createdAt,
    };
    expect(deriveLiveWorkObservations([current, completed, legacy], session)).toEqual([]);

    for (const [earlierId, laterId] of [
      ["z", "ä"],
      ["\uE000", "😀"],
    ] as const) {
      const earlier = { ...current, id: EventId.make(earlierId) };
      const later = {
        ...current,
        id: EventId.make(laterId),
        turnId: TurnId.make("binary-later-root"),
      };
      expect(
        deriveLiveWorkObservations([later, earlier], session).map(({ activity: head }) => head.id),
      ).toEqual([later.id]);
    }
  });
});
