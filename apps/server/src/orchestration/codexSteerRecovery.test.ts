import { MessageId, ThreadId, TurnId } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  CODEX_STEER_RECOVERED_ACTIVITY_KIND,
  CODEX_STEER_DELIVERED_ACTIVITY_KIND,
  CODEX_STEER_DELIVERY_ATTEMPTED_ACTIVITY_KIND,
  CODEX_TERMINAL_STEER_RECOVERY,
  buildCodexSteerAcceptedActivityCommand,
  buildCodexSteerDeliveredActivityCommand,
  buildCodexSteerDeliveryAttemptedActivityCommand,
  buildCodexSteerNextTurnQueuedCommand,
  buildCodexSteerRecoveredActivityCommand,
  decideCodexSteerRecovery,
  type CodexSteerAcceptanceEvidence,
} from "./codexSteerRecovery.ts";

const createdAt = "2026-08-30T12:53:43.714Z";
const completedAt = "2026-08-30T12:53:47.414Z";
const threadId = ThreadId.make("thread-steer-terminal-race");
const staleTurnId = TurnId.make("turn-steer-terminal-race");
const messageId = MessageId.make("message-steer-terminal-race");
const clientCorrelationId = `cafe-steer-v1:${"a".repeat(64)}`;

function message(input?: {
  readonly id?: MessageId;
  readonly turnId?: TurnId;
}): CodexSteerAcceptanceEvidence["message"] {
  return {
    id: input?.id ?? messageId,
    role: "user",
    text: "continue with the corrected implementation report",
    turnId: input?.turnId ?? staleTurnId,
    attachments: [],
  };
}

function terminalEvidence(
  input?: Partial<CodexSteerAcceptanceEvidence>,
): CodexSteerAcceptanceEvidence {
  return {
    threadId,
    acceptedTurnId: staleTurnId,
    message: message(),
    turnState: "interrupted",
    turnCompletedAt: completedAt,
    processingObserved: false,
    recoveryObserved: false,
    interruptRequested: false,
    sessionStopRequested: false,
    ...input,
  };
}

describe("Codex terminal steer recovery", () => {
  it("recovers a trusted accepted steer with stable, content-free diagnostics", () => {
    const decision = decideCodexSteerRecovery({
      evidence: terminalEvidence(),
      providerActiveTurnId: null,
      createdAt: completedAt,
    });

    expect(decision.disposition).toBe("recover-as-next-turn");
    expect(decision.commands).toHaveLength(2);
    expect(decision.commands[0]).toMatchObject({
      type: "thread.activity.append",
      activity: {
        kind: "runtime.warning",
        payload: {
          provider: "codex",
          recovery: CODEX_TERMINAL_STEER_RECOVERY,
          messageId,
          staleTurnId,
        },
      },
    });
    expect(decision.commands[0]?.commandId).toMatch(
      /^server:terminal-unprocessed-codex-steer:[a-f0-9]{64}:diagnostic$/,
    );
    expect(JSON.stringify(decision.commands[0])).not.toContain("corrected implementation report");
    expect(decision.commands[1]).toMatchObject({
      type: "thread.turn.steer",
      message: {
        messageId,
        text: "continue with the corrected implementation report",
      },
    });
  });

  it("does not recover after the exact correlated processing marker exists", () => {
    const decision = decideCodexSteerRecovery({
      evidence: terminalEvidence({ processingObserved: true }),
      providerActiveTurnId: null,
      createdAt: completedAt,
    });

    expect(decision).toEqual({
      disposition: "provider-processing-observed",
      commands: [],
    });
  });

  it("does not replay after a trusted successful recovery receipt survives another restart", () => {
    const decision = decideCodexSteerRecovery({
      evidence: terminalEvidence({ recoveryObserved: true }),
      providerActiveTurnId: null,
      createdAt: completedAt,
    });

    expect(decision).toEqual({
      disposition: "recovery-delivered",
      commands: [],
    });
  });

  it("defers to provider liveness when the exact accepted turn is still active", () => {
    const decision = decideCodexSteerRecovery({
      evidence: terminalEvidence(),
      providerActiveTurnId: staleTurnId,
      createdAt: completedAt,
    });

    expect(decision).toEqual({
      disposition: "accepted-turn-live",
      commands: [],
    });
  });

  it("keeps a terminal steer queued behind an explicit Stop barrier", () => {
    const decision = decideCodexSteerRecovery({
      evidence: terminalEvidence({ interruptRequested: true }),
      providerActiveTurnId: null,
      createdAt: completedAt,
    });

    expect(decision.disposition).toBe("manual-stop-barrier");
    expect(decision.commands).toHaveLength(1);
    expect(decision.commands[0]).toMatchObject({
      type: "thread.activity.append",
      activity: {
        kind: "provider.turn.steer.failed",
        payload: {
          messageId,
          retryableFollowUp: true,
          recoveryBarrier: "manual-stop-barrier",
        },
      },
    });
  });

  it("keeps a terminal steer queued behind an explicit session-stop barrier", () => {
    const decision = decideCodexSteerRecovery({
      evidence: terminalEvidence({ sessionStopRequested: true }),
      providerActiveTurnId: null,
      createdAt: completedAt,
    });

    expect(decision.disposition).toBe("manual-stop-barrier");
    expect(decision.commands[0]).toMatchObject({
      type: "thread.activity.append",
      activity: {
        kind: "provider.turn.steer.failed",
        payload: {
          messageId,
          retryableFollowUp: true,
          recoveryBarrier: "manual-stop-barrier",
        },
      },
    });
  });

  it("queues the saved steer instead of injecting it into unrelated newer work", () => {
    const newerTurnId = TurnId.make("turn-newer-active-work");
    const decision = decideCodexSteerRecovery({
      evidence: terminalEvidence(),
      providerActiveTurnId: newerTurnId,
      createdAt: completedAt,
    });

    expect(decision.disposition).toBe("newer-turn-active");
    expect(decision.commands).toHaveLength(1);
    expect(decision.commands[0]).toMatchObject({
      type: "thread.activity.append",
      activity: {
        kind: "provider.turn.steer.failed",
        payload: {
          messageId,
          retryableFollowUp: true,
          retryAfter: "active-turn",
          staleTurnId,
        },
      },
    });
  });

  it("keeps a retargeted message recoverable even when its projected message turn differs", () => {
    const originalTurnId = TurnId.make("turn-before-retarget");
    const decision = decideCodexSteerRecovery({
      evidence: terminalEvidence({ message: message({ turnId: originalTurnId }) }),
      providerActiveTurnId: null,
      createdAt: completedAt,
    });

    expect(decision.disposition).toBe("recover-as-next-turn");
    expect(decision.commands[1]).toMatchObject({
      type: "thread.turn.steer",
      message: { messageId },
    });
  });

  it("uses collision-resistant receipts for adversarial identifier tuples", () => {
    const left = buildCodexSteerAcceptedActivityCommand({
      threadId: ThreadId.make("thread:turn"),
      turnId: TurnId.make("message"),
      messageId: MessageId.make("tail"),
      createdAt,
    });
    const right = buildCodexSteerAcceptedActivityCommand({
      threadId: ThreadId.make("thread"),
      turnId: TurnId.make("turn:message"),
      messageId: MessageId.make("tail"),
      createdAt,
    });

    expect(left.commandId).not.toBe(right.commandId);
    expect(left.activity.id).not.toBe(right.activity.id);
    expect(left.commandId).toMatch(/^server:codex-steer-accepted:[a-f0-9]{64}$/);

    const recoveredLeft = buildCodexSteerRecoveredActivityCommand({
      threadId: ThreadId.make("thread:turn"),
      acceptedTurnId: TurnId.make("message"),
      messageId: MessageId.make("tail"),
      recoveredTurnId: TurnId.make("recovered-left"),
      createdAt,
    });
    const recoveredRight = buildCodexSteerRecoveredActivityCommand({
      threadId: ThreadId.make("thread"),
      acceptedTurnId: TurnId.make("turn:message"),
      messageId: MessageId.make("tail"),
      recoveredTurnId: TurnId.make("recovered-right"),
      createdAt,
    });
    expect(recoveredLeft.commandId).not.toBe(recoveredRight.commandId);
    expect(recoveredLeft.activity.id).not.toBe(recoveredRight.activity.id);
    expect(recoveredLeft.commandId).toMatch(/^server:codex-steer-recovered:[a-f0-9]{64}$/);

    const repeatedRecoveredLeft = buildCodexSteerRecoveredActivityCommand({
      threadId: ThreadId.make("thread:turn"),
      acceptedTurnId: TurnId.make("message"),
      messageId: MessageId.make("tail"),
      // Provider response data is evidence, not part of the original intent
      // identity. A retry must converge on the first durable receipt.
      recoveredTurnId: TurnId.make("another-provider-response"),
      createdAt,
    });
    expect(repeatedRecoveredLeft.commandId).toBe(recoveredLeft.commandId);
    expect(repeatedRecoveredLeft.activity.id).toBe(recoveredLeft.activity.id);

    const loneHighSurrogate = buildCodexSteerAcceptedActivityCommand({
      threadId,
      turnId: staleTurnId,
      messageId: MessageId.make("message-\ud800"),
      createdAt,
    });
    const loneLowSurrogate = buildCodexSteerAcceptedActivityCommand({
      threadId,
      turnId: staleTurnId,
      messageId: MessageId.make("message-\udc00"),
      createdAt,
    });
    expect(loneHighSurrogate.commandId).not.toBe(loneLowSurrogate.commandId);
  });

  it("persists only opaque correlation metadata in accepted and recovered receipts", () => {
    const accepted = buildCodexSteerAcceptedActivityCommand({
      threadId,
      turnId: staleTurnId,
      messageId,
      clientCorrelationId,
      createdAt,
    });
    const recoveredTurnId = TurnId.make("turn-recovered-delivery");
    const recovered = buildCodexSteerRecoveredActivityCommand({
      threadId,
      acceptedTurnId: staleTurnId,
      messageId,
      recoveredTurnId,
      clientCorrelationId,
      createdAt,
    });

    expect(accepted.activity.payload).toEqual({
      provider: "codex",
      messageId,
      acceptedTurnId: staleTurnId,
      clientCorrelationId,
    });
    expect(recovered.activity).toMatchObject({
      kind: CODEX_STEER_RECOVERED_ACTIVITY_KIND,
      turnId: recoveredTurnId,
      payload: {
        provider: "codex",
        messageId,
        acceptedTurnId: staleTurnId,
        recoveredTurnId,
        clientCorrelationId,
      },
    });
    expect(JSON.stringify([accepted, recovered])).not.toContain("corrected implementation report");
  });

  it("persists stable content-free next-turn delivery and queue outcomes", () => {
    const deliveredTurnId = TurnId.make("turn-next-after-stale-steer");
    const delivered = buildCodexSteerDeliveredActivityCommand({
      threadId,
      messageId,
      deliveredTurnId,
      reason: "turn-start-after-provider-no-active-turn",
      createdAt,
    });
    const repeated = buildCodexSteerDeliveredActivityCommand({
      threadId,
      messageId,
      deliveredTurnId: TurnId.make("turn-repeated-provider-response"),
      reason: "turn-start-after-provider-no-active-turn",
      createdAt,
    });
    const queued = buildCodexSteerNextTurnQueuedCommand({
      threadId,
      messageId,
      intentSequence: 41,
      staleTurnId,
      reason: "turn-start-after-provider-no-active-turn",
      createdAt,
    });

    expect(delivered.activity).toMatchObject({
      kind: CODEX_STEER_DELIVERED_ACTIVITY_KIND,
      turnId: deliveredTurnId,
      payload: {
        provider: "codex",
        messageId,
        deliveredTurnId,
        delivery: "next-turn",
        reason: "turn-start-after-provider-no-active-turn",
      },
    });
    expect(delivered.commandId).toMatch(/^server:codex-steer-delivered:[a-f0-9]{64}$/);
    expect(repeated.commandId).toBe(delivered.commandId);
    expect(repeated.activity.id).toBe(delivered.activity.id);
    expect(queued.activity).toMatchObject({
      kind: "provider.turn.steer.failed",
      turnId: staleTurnId,
      payload: {
        provider: "codex",
        messageId,
        intentSequence: 41,
        retryableFollowUp: true,
        delivery: "next-turn",
        deliveryState: "queued",
        recoveryBarrier: "next-turn-delivery-failed",
      },
    });
    const laterQueued = buildCodexSteerNextTurnQueuedCommand({
      threadId,
      messageId,
      intentSequence: 42,
      staleTurnId,
      reason: "turn-start-after-provider-no-active-turn",
      createdAt,
    });
    expect(laterQueued.commandId).not.toBe(queued.commandId);
    expect(laterQueued.activity.id).not.toBe(queued.activity.id);
    expect(JSON.stringify([delivered, queued])).not.toContain("corrected implementation report");
  });

  it("binds content-free provider-I/O attempt barriers to their delivery stage", () => {
    const liveAttempt = buildCodexSteerDeliveryAttemptedActivityCommand({
      threadId,
      messageId,
      intentSequence: 41,
      delivery: "live-steer",
      reason: "live-steer",
      expectedTurnId: staleTurnId,
      createdAt,
    });
    const nextTurnAttempt = buildCodexSteerDeliveryAttemptedActivityCommand({
      threadId,
      messageId,
      intentSequence: 41,
      delivery: "next-turn",
      reason: "turn-start-after-provider-no-active-turn",
      staleTurnId,
      createdAt,
    });

    expect(liveAttempt.activity).toMatchObject({
      kind: CODEX_STEER_DELIVERY_ATTEMPTED_ACTIVITY_KIND,
      turnId: staleTurnId,
      payload: {
        provider: "codex",
        messageId,
        intentSequence: 41,
        delivery: "live-steer",
        deliveryState: "attempted",
        reason: "live-steer",
        expectedTurnId: staleTurnId,
      },
    });
    expect(nextTurnAttempt.activity).toMatchObject({
      kind: CODEX_STEER_DELIVERY_ATTEMPTED_ACTIVITY_KIND,
      turnId: staleTurnId,
      payload: {
        provider: "codex",
        messageId,
        intentSequence: 41,
        delivery: "next-turn",
        deliveryState: "attempted",
        reason: "turn-start-after-provider-no-active-turn",
        staleTurnId,
      },
    });
    expect(liveAttempt.commandId).not.toBe(nextTurnAttempt.commandId);
    const laterGenerationAttempt = buildCodexSteerDeliveryAttemptedActivityCommand({
      threadId,
      messageId,
      intentSequence: 42,
      delivery: "live-steer",
      reason: "live-steer",
      expectedTurnId: staleTurnId,
      createdAt,
    });
    expect(laterGenerationAttempt.commandId).not.toBe(liveAttempt.commandId);
    expect(liveAttempt.commandId).toMatch(/^server:codex-steer-delivery-attempted:[a-f0-9]{64}$/);
    expect(JSON.stringify([liveAttempt, nextTurnAttempt])).not.toContain(
      "corrected implementation report",
    );
  });
});
