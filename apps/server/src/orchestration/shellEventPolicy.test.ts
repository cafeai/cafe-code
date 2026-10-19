import { EventId, ThreadId, TurnId, type OrchestrationEvent } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import { doesOrchestrationEventAffectShell } from "./shellEventPolicy.ts";

const runtimeId = "00000000-0000-4000-8000-000000000321";
const threadId = ThreadId.make("shell-work-thread");
const event = (kind: string, payload: unknown): OrchestrationEvent => ({
  sequence: 1,
  eventId: EventId.make("shell-work-event"),
  type: "thread.activity-appended",
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: "2026-10-19T03:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    threadId,
    activity: {
      id: EventId.make("shell-work-activity"),
      kind,
      tone: "info",
      summary: "Native work",
      turnId: TurnId.make("shell-work-root"),
      createdAt: "2026-10-19T03:00:00.000Z",
      payload,
    },
  },
});

describe("shell live-work event admission", () => {
  it("forwards native child starts, progress and inactive retractions without inventing liveness", () => {
    const child = { taskId: "child", subagent: { threadId: "child", runtimeId, status: "active" } };
    for (const update of [
      event("task.started", child),
      event("task.progress", { ...child, subagent: { ...child.subagent, status: "waiting" } }),
      event("task.completed", { ...child, subagent: { ...child.subagent, status: "completed" } }),
      event("task.progress", { ...child, visibility: "ambient" }),
      event("tool.completed", { itemId: "tool", nativeWorkRuntimeId: runtimeId }),
    ])
      expect(doesOrchestrationEventAffectShell(update)).toBe(true);
  });

  it("does not refresh shell state for unbound, malformed or routine work-log activity", () => {
    for (const update of [
      event("task.started", {
        taskId: "unbound",
        subagent: { threadId: "child", status: "active" },
      }),
      event("task.started", {
        taskId: "invalid",
        subagent: { threadId: "child", runtimeId: "invalid", status: "active" },
      }),
      event("task.progress", { taskId: "codex-turn-start:root", nativeWorkRuntimeId: runtimeId }),
      event("tool.progress", { itemId: "tool", text: "Routine output" }),
      event("runtime.warning", { recovery: "unrelated bookkeeping" }),
    ])
      expect(doesOrchestrationEventAffectShell(update)).toBe(false);
    expect(doesOrchestrationEventAffectShell(event("approval.requested", {}))).toBe(true);
    expect(doesOrchestrationEventAffectShell(event("user-input.resolved", {}))).toBe(true);
  });
});
