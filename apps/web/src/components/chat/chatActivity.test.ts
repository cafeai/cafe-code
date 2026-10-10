import {
  EventId,
  SubagentRuntimeId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import { deriveChatActivityPresentation } from "./chatActivity";

const runtimeId = SubagentRuntimeId.make("00000000-0000-4000-8000-000000000001");
const turnId = TurnId.make("turn");
const base = {
  activities: [] as OrchestrationThreadActivity[],
  runtimeSession: { subagentRuntimeId: runtimeId, orchestrationStatus: "ready" as const },
  turnId,
  running: false,
  preparing: false,
  connecting: false,
  streaming: false,
  approvalCount: 0,
  questionCount: 0,
};

describe("composer activity presentation", () => {
  it("keeps current background work visible after the response ends, and clears it on an authoritative zero", () => {
    const active = { ...base, liveWork: { runtimeId, taskCount: 1, agentCount: 2 } };
    expect(deriveChatActivityPresentation(active)?.label).toBe(
      "Background work running · 1 task · 2 agents",
    );
    expect(
      deriveChatActivityPresentation({
        ...active,
        liveWork: { runtimeId, taskCount: 0, agentCount: 0 },
      }),
    ).toBeNull();
    expect(
      deriveChatActivityPresentation({
        ...active,
        runtimeSession: { ...base.runtimeSession, subagentRuntimeId: "different-runtime" },
      }),
    ).toBeNull();
    expect(deriveChatActivityPresentation({ ...base, streaming: true })).toBeNull();
  });
  it("prioritizes blocking approval or answer waits over streaming and running tools", () => {
    const running = { ...base, running: true, streaming: true };
    expect(deriveChatActivityPresentation({ ...running, approvalCount: 1 })).toMatchObject({
      label: "Waiting for approval",
      attention: true,
      canInspect: false,
    });
    expect(deriveChatActivityPresentation({ ...running, questionCount: 1 })).toMatchObject({
      label: "Waiting for your answer",
      attention: true,
      canInspect: false,
    });
  });
  it("uses current tool lifecycle evidence and removes a completed command", () => {
    const started: OrchestrationThreadActivity = {
      id: EventId.make("tool-start"),
      turnId,
      kind: "tool.started",
      tone: "info",
      summary: "Ran command",
      createdAt: "2026-10-09T00:00:00.000Z",
      sequence: 1,
      payload: { itemId: "command", itemType: "command_execution" },
    };
    expect(
      deriveChatActivityPresentation({ ...base, running: true, activities: [started] })?.label,
    ).toBe("Running command…");
    const completed = {
      ...started,
      id: EventId.make("tool-end"),
      kind: "tool.completed",
      sequence: 2,
    };
    expect(
      deriveChatActivityPresentation({ ...base, running: true, activities: [completed, started] })
        ?.label,
    ).toBe("Working…");
    expect(deriveChatActivityPresentation({ ...base, activities: [started] })).toBeNull();
  });
});
