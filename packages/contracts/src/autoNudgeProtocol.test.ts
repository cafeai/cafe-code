import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  ClientOrchestrationCommand,
  DEFAULT_THREAD_AUTO_NUDGE_CONFIG,
  DEFAULT_THREAD_AUTO_NUDGE_SUMMARY,
  MANUAL_FOLLOW_UP_MAX_ITEMS,
  ManualFollowUpQueue,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "./index.ts";

const decodeClientCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);

const dispatch = {
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  titleSeed: "Continue thread",
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

describe("Auto Nudge protocol prerequisite", () => {
  it("accepts exact-thread configuration without a time authority field", () => {
    const command = decodeClientCommand({
      type: "thread.auto-nudge.configure",
      commandId: "configure-1",
      threadId: "thread-1",
      expectedAuthorityRevision: 0,
      mode: "steady-progress",
      prompt: "Continue this exact thread.",
      backgroundContinuation: false,
      maxRounds: 5,
      createdAt: "2026-08-11T12:00:00.000Z",
    });
    expect(command.type).toBe("thread.auto-nudge.configure");
    expect("maxMinutes" in command).toBe(false);
    expect("deadlineAt" in command).toBe(false);
  });

  it("requires a prompt-free reservation before a payload enqueue", () => {
    const reservation = decodeClientCommand({
      type: "thread.manual-follow-up.reserve",
      commandId: "reserve-1",
      threadId: "thread-1",
      followUpId: "follow-up-1",
      messageId: "message-1",
      dispatch,
      createdAt: "2026-08-11T12:00:00.000Z",
    });
    const enqueue = decodeClientCommand({
      type: "thread.manual-follow-up.enqueue",
      commandId: "enqueue-1",
      reservationCommandId: "reserve-1",
      threadId: "thread-1",
      followUpId: "follow-up-1",
      message: {
        messageId: "message-1",
        role: "user",
        text: "Operator follow-up",
        attachments: [],
      },
      dispatch,
      createdAt: "2026-08-11T12:00:01.000Z",
    });
    expect(reservation.type).toBe("thread.manual-follow-up.reserve");
    expect(enqueue.type).toBe("thread.manual-follow-up.enqueue");
    expect("message" in reservation).toBe(false);
  });

  it("keeps detail prompt state separate from prompt-free shell state", () => {
    expect("prompt" in DEFAULT_THREAD_AUTO_NUDGE_CONFIG).toBe(true);
    expect("prompt" in DEFAULT_THREAD_AUTO_NUDGE_SUMMARY).toBe(false);
    expect(OrchestrationThread.fields.autoNudge).toBeDefined();
    expect(OrchestrationThread.fields.manualFollowUps).toBeDefined();
    expect(OrchestrationThreadShell.fields.autoNudge).toBeDefined();
    expect(OrchestrationThreadShell.fields.manualFollowUpCount).toBeDefined();
  });

  it("bounds the durable manual follow-up FIFO", () => {
    const decodeQueue = Schema.decodeUnknownSync(ManualFollowUpQueue);
    const item = {
      id: "follow-up-1",
      messageId: "message-1",
      dispatch,
      status: "reserving",
      reservationCommandId: "reserve-1",
      enqueuedAt: "2026-08-11T12:00:00.000Z",
    } as const;
    expect(
      decodeQueue(Array.from({ length: MANUAL_FOLLOW_UP_MAX_ITEMS }, () => item)),
    ).toHaveLength(MANUAL_FOLLOW_UP_MAX_ITEMS);
    expect(() =>
      decodeQueue(Array.from({ length: MANUAL_FOLLOW_UP_MAX_ITEMS + 1 }, () => item)),
    ).toThrow();
  });
});
