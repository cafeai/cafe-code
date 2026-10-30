import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { ProviderRespondToUserInputInput } from "./provider.ts";
import { ClientOrchestrationCommand, OrchestrationEvent } from "./orchestration.ts";
import { ProviderUserInputUnanswered } from "./providerUserInput.ts";

const response = {
  threadId: "thread-question",
  requestId: "request-question",
  answers: { "Actual?": "Yes" },
  unanswered: { "Later?": "skipped" },
};
const command = {
  type: "thread.user-input.respond",
  commandId: "question-command",
  ...response,
  createdAt: "2026-10-30T00:00:00.000Z",
};

describe("explicitly unanswered input contracts", () => {
  it("retains dispositions across provider and durable command boundaries", () => {
    expect(Schema.decodeUnknownSync(ProviderRespondToUserInputInput)(response)).toEqual(response);
    expect(Schema.decodeUnknownSync(ClientOrchestrationCommand)(command)).toEqual(command);
    const event = {
      type: "thread.user-input-response-requested",
      eventId: "question-event",
      sequence: 1,
      aggregateKind: "thread",
      aggregateId: "thread-question",
      occurredAt: command.createdAt,
      commandId: command.commandId,
      causationEventId: null,
      correlationId: command.commandId,
      metadata: {},
      payload: { ...response, createdAt: command.createdAt },
    };
    expect(Schema.decodeUnknownSync(OrchestrationEvent)(event).payload).toMatchObject(response);
  });

  it("retains old answers-only responses without inventing disposition metadata", () => {
    const legacy = {
      threadId: "legacy-thread",
      requestId: "legacy-request",
      answers: { q: "Yes" },
    };
    expect(Schema.decodeUnknownSync(ProviderRespondToUserInputInput)(legacy)).toEqual(legacy);
  });

  it("refuses overlapping answers and dispositions at both public response boundaries", () => {
    const overlap = { ...response, unanswered: { "Actual?": "dismissed" } };
    expect(() => Schema.decodeUnknownSync(ProviderRespondToUserInputInput)(overlap)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ClientOrchestrationCommand)({ ...command, ...overlap }),
    ).toThrow();
  });

  it("refuses unknown actions and finite annotation overflows", () => {
    for (const value of [
      { q: "replied_in_chat" },
      { q: "cancel" },
      { q: "" },
      Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`question-${i}`, "skipped"])),
      { ["x".repeat(16_385)]: "skipped" },
      Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`${i}${"x".repeat(16_000)}`, "skipped"]),
      ),
    ])
      expect(() => Schema.decodeUnknownSync(ProviderUserInputUnanswered)(value)).toThrow();
  });
});
