import { EventId, MessageId, ThreadId, TurnId, type OrchestrationEvent } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  coalesceOrchestrationUiEvents,
  shouldApplyProjectionEvent,
  shouldApplyProjectionSnapshot,
} from "./service";

function makeThreadMessageEvent(
  sequence: number,
  payload: Extract<OrchestrationEvent, { type: "thread.message-sent" }>["payload"],
): Extract<OrchestrationEvent, { type: "thread.message-sent" }> {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: payload.threadId,
    occurredAt: payload.updatedAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload,
  };
}

function selectThreadMessageEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): Extract<OrchestrationEvent, { type: "thread.message-sent" }>[] {
  return events.filter(
    (event): event is Extract<OrchestrationEvent, { type: "thread.message-sent" }> =>
      event.type === "thread.message-sent",
  );
}

describe("shouldApplyProjectionSnapshot", () => {
  it("accepts the first snapshot for an environment", () => {
    expect(
      shouldApplyProjectionSnapshot({
        current: null,
        next: {
          snapshotSequence: 1,
          updatedAt: "2026-04-22T10:00:00.000Z",
        },
      }),
    ).toBe(true);
  });

  it("drops snapshots with an older sequence", () => {
    expect(
      shouldApplyProjectionSnapshot({
        current: {
          sequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
        next: {
          snapshotSequence: 4,
          updatedAt: "2026-04-22T10:06:00.000Z",
        },
      }),
    ).toBe(false);
  });

  it("drops snapshots with the same sequence and older timestamp", () => {
    expect(
      shouldApplyProjectionSnapshot({
        current: {
          sequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
        next: {
          snapshotSequence: 5,
          updatedAt: "2026-04-22T10:04:59.000Z",
        },
      }),
    ).toBe(false);
  });

  it("accepts snapshots with the same sequence and a newer timestamp", () => {
    expect(
      shouldApplyProjectionSnapshot({
        current: {
          sequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
        next: {
          snapshotSequence: 5,
          updatedAt: "2026-04-22T10:05:01.000Z",
        },
      }),
    ).toBe(true);
  });
});

describe("shouldApplyProjectionEvent", () => {
  it("accepts the first event for an environment", () => {
    expect(
      shouldApplyProjectionEvent({
        current: null,
        sequence: 1,
      }),
    ).toBe(true);
  });

  it("drops stale or duplicate events", () => {
    expect(
      shouldApplyProjectionEvent({
        current: {
          sequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
        sequence: 5,
      }),
    ).toBe(false);
    expect(
      shouldApplyProjectionEvent({
        current: {
          sequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
        sequence: 4,
      }),
    ).toBe(false);
  });

  it("accepts newer events", () => {
    expect(
      shouldApplyProjectionEvent({
        current: {
          sequence: 5,
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
        sequence: 6,
      }),
    ).toBe(true);
  });
});

describe("coalesceOrchestrationUiEvents", () => {
  const threadId = ThreadId.make("thread-1");
  const turnId = TurnId.make("turn-1");
  const messageId = MessageId.make("assistant-1");

  it("coalesces adjacent streaming deltas for the same message", () => {
    const coalesced = coalesceOrchestrationUiEvents([
      makeThreadMessageEvent(1, {
        threadId,
        messageId,
        role: "assistant",
        text: "That makes ",
        turnId,
        streaming: true,
        createdAt: "2026-05-27T00:00:01.000Z",
        updatedAt: "2026-05-27T00:00:01.000Z",
      }),
      makeThreadMessageEvent(2, {
        threadId,
        messageId,
        role: "assistant",
        text: "sense",
        turnId,
        streaming: true,
        createdAt: "2026-05-27T00:00:02.000Z",
        updatedAt: "2026-05-27T00:00:02.000Z",
      }),
    ]);

    const messages = selectThreadMessageEvents(coalesced);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload.text).toBe("That makes sense");
    expect(messages[0]?.payload.streaming).toBe(true);
    expect(messages[0]?.payload.createdAt).toBe("2026-05-27T00:00:01.000Z");
    expect(messages[0]?.payload.updatedAt).toBe("2026-05-27T00:00:02.000Z");
  });

  it("keeps assistant completion separate from streamed text", () => {
    const coalesced = coalesceOrchestrationUiEvents([
      makeThreadMessageEvent(1, {
        threadId,
        messageId,
        role: "assistant",
        text: "That makes sense",
        turnId,
        streaming: true,
        createdAt: "2026-05-27T00:00:01.000Z",
        updatedAt: "2026-05-27T00:00:01.000Z",
      }),
      makeThreadMessageEvent(2, {
        threadId,
        messageId,
        role: "assistant",
        text: "",
        turnId,
        streaming: false,
        createdAt: "2026-05-27T00:00:02.000Z",
        updatedAt: "2026-05-27T00:00:02.000Z",
      }),
    ]);

    const messages = selectThreadMessageEvents(coalesced);
    expect(messages.map((event) => event.payload.streaming)).toEqual([true, false]);
    expect(messages.map((event) => event.payload.text)).toEqual(["That makes sense", ""]);
  });
});
