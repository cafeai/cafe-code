import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { ClientOrchestrationCommand, ThreadTurnSteerRequestedPayload } from "./orchestration.ts";
import { ProviderSteerTurnInput } from "./provider.ts";

const binding = {
  providerInstanceId: "claude-personal",
  subagentRuntimeId: "b4613f5d-dd81-4c5d-a49f-8f51e331ef51",
  activeTurnId: "priority-turn",
};
const createdAt = "2026-10-07T00:00:00.000Z";

describe("explicit-priority session transport", () => {
  it.each(["now", "next", "later"] as const)(
    "retains %s recipient across transport and durable decode",
    (deliveryPriority) => {
      const command = Schema.decodeUnknownSync(ClientOrchestrationCommand)({
        type: "thread.turn.steer",
        commandId: "priority-command",
        threadId: "priority-chat",
        deliveryPriority,
        expectedPrioritySession: binding,
        message: { messageId: "priority-message", role: "user", text: "Guidance", attachments: [] },
        createdAt,
      });
      expect(command).toMatchObject({ deliveryPriority, expectedPrioritySession: binding });
      const event = Schema.decodeUnknownSync(ThreadTurnSteerRequestedPayload)({
        threadId: "priority-chat",
        deliveryPriority,
        expectedPrioritySession: binding,
        expectedTurnId: binding.activeTurnId,
        messageId: "priority-message",
        createdAt,
      });
      expect(event.expectedPrioritySession).toEqual(binding);
      const provider = Schema.decodeUnknownSync(ProviderSteerTurnInput)({
        threadId: event.threadId,
        deliveryPriority,
        expectedPrioritySession: event.expectedPrioritySession,
        expectedTurnId: event.expectedTurnId,
        input: "Guidance",
      });
      expect(provider.expectedPrioritySession).toEqual(binding);
    },
  );

  it("keeps legacy events readable without manufacturing recipient evidence", () => {
    const event = Schema.decodeUnknownSync(ThreadTurnSteerRequestedPayload)({
      threadId: "priority-chat",
      deliveryPriority: "now",
      expectedTurnId: binding.activeTurnId,
      messageId: "priority-message",
      createdAt,
    });
    expect(event.expectedPrioritySession).toBeUndefined();
  });

  it("requires every binding field while accepting explicit legacy-null runtime", () => {
    const decode = Schema.decodeUnknownSync(ProviderSteerTurnInput);
    const input = {
      threadId: "priority-chat",
      expectedTurnId: binding.activeTurnId,
      input: "Guidance",
    };
    expect(
      decode({ ...input, expectedPrioritySession: { ...binding, subagentRuntimeId: null } })
        .expectedPrioritySession?.subagentRuntimeId,
    ).toBeNull();
    for (const invalid of [
      { ...binding, providerInstanceId: "" },
      { ...binding, activeTurnId: "" },
      { providerInstanceId: binding.providerInstanceId, activeTurnId: binding.activeTurnId },
    ]) {
      expect(() => decode({ ...input, expectedPrioritySession: invalid })).toThrow();
    }
  });
});
