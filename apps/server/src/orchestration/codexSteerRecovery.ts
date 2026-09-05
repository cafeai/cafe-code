import { createHash } from "node:crypto";

import {
  type ChatAttachment,
  CommandId,
  EventId,
  type MessageId,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";

export const CODEX_STEER_ACCEPTED_ACTIVITY_KIND = "provider.turn.steer.accepted";
export const CODEX_STEER_RECOVERED_ACTIVITY_KIND = "provider.turn.steer.recovered";
export const CODEX_STEER_DELIVERED_ACTIVITY_KIND = "provider.turn.steer.delivered";
export const CODEX_STEER_DELIVERY_ATTEMPTED_ACTIVITY_KIND =
  "provider.turn.steer.delivery-attempted";
export const CODEX_TERMINAL_STEER_RECOVERY = "turn-start-after-terminal-unprocessed-steer";

export type CodexSteerNextTurnReason =
  | "turn-start-after-no-local-active-turn"
  | "turn-start-after-missing-active-turn-id"
  | "turn-start-after-provider-no-active-turn"
  | typeof CODEX_TERMINAL_STEER_RECOVERY;

export interface CodexSteerAcceptanceEvidence {
  readonly threadId: ThreadId;
  readonly acceptedTurnId: TurnId;
  /** Exact authenticated turn intent generation acknowledged by Codex. */
  readonly intentSequence: number;
  /**
   * Fixed-size opaque token echoed by Codex for the exact injected user item.
   * This is correlation metadata only and must never contain prompt content.
   */
  readonly clientCorrelationId?: string;
  readonly message: Pick<OrchestrationMessage, "id" | "text" | "attachments" | "turnId"> & {
    readonly role: "user";
  };
  readonly turnState: "running" | "completed" | "error" | "interrupted";
  readonly turnCompletedAt: string | null;
  readonly processingObserved: boolean;
  readonly recoveryObserved: boolean;
  readonly interruptRequested: boolean;
  readonly sessionStopRequested: boolean;
}

export interface CodexSteerRecoveryDecision {
  readonly disposition:
    | "accepted-turn-live"
    | "provider-processing-observed"
    | "recovery-delivered"
    | "manual-stop-barrier"
    | "newer-turn-active"
    | "recover-as-next-turn";
  readonly commands: ReadonlyArray<OrchestrationCommand>;
}

export function codexSteerAcceptanceEvidenceFromProjection(input: {
  readonly threadId: ThreadId;
  readonly acceptedTurnId: TurnId;
  readonly intentSequence: number;
  readonly clientCorrelationId: string | null;
  readonly messageId: MessageId;
  readonly messageTurnId: TurnId | null;
  readonly messageText: string;
  readonly messageAttachments: ReadonlyArray<ChatAttachment>;
  readonly turnState: CodexSteerAcceptanceEvidence["turnState"];
  readonly turnCompletedAt: string | null;
  readonly processingObserved: boolean;
  readonly recoveryObserved: boolean;
  readonly interruptRequested: boolean;
  readonly sessionStopRequested: boolean;
}): CodexSteerAcceptanceEvidence {
  return {
    threadId: input.threadId,
    acceptedTurnId: input.acceptedTurnId,
    intentSequence: input.intentSequence,
    ...(input.clientCorrelationId !== null
      ? { clientCorrelationId: input.clientCorrelationId }
      : {}),
    message: {
      id: input.messageId,
      role: "user",
      text: input.messageText,
      attachments: input.messageAttachments,
      // Retargeted steers deliberately keep their original projected message
      // turn. Recovery authority comes from acceptedTurnId, not this display
      // association, but preserve the association when rebuilding the input.
      turnId: input.messageTurnId,
    },
    turnState: input.turnState,
    turnCompletedAt: input.turnCompletedAt,
    processingObserved: input.processingObserved,
    recoveryObserved: input.recoveryObserved,
    interruptRequested: input.interruptRequested,
    sessionStopRequested: input.sessionStopRequested,
  };
}

/**
 * Produce a compact, collision-resistant identity from externally influenced
 * identifiers. Entity ids are intentionally open strings, so concatenating
 * them with a delimiter is ambiguous (`["a:b", "c"]` collides with
 * `["a", "b:c"]`). Length-prefix every exact UTF-16 code-unit component and
 * domain-separate the digest before it reaches the durable command-receipt
 * namespace.
 */
function stableIdentity(domain: string, parts: ReadonlyArray<string>): string {
  const digest = createHash("sha256");
  digest.update("cafe-code/codex-steer-recovery/v1\0", "utf8");
  const encodedDomain = Buffer.from(domain, "utf16le");
  digest.update(`${encodedDomain.byteLength}:`, "utf8");
  digest.update(encodedDomain);
  for (const part of parts) {
    // Entity ids can contain lone UTF-16 surrogates. Node's UTF-8 encoder
    // replaces each of those with U+FFFD, which would make distinct valid ids
    // share one recovery receipt. Hash the exact code units, matching the
    // provider correlation token's collision-safe representation.
    const encodedPart = Buffer.from(part, "utf16le");
    digest.update(`${encodedPart.byteLength}:`, "utf8");
    digest.update(encodedPart);
  }
  return digest.digest("hex");
}

function acceptedIdentity(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly messageId: MessageId;
  readonly intentSequence: number;
}): string {
  return `codex-steer-accepted:${stableIdentity("accepted", [
    input.threadId,
    input.turnId,
    input.messageId,
    String(input.intentSequence),
  ])}`;
}

function recoveryIdentity(input: {
  readonly threadId: ThreadId;
  readonly acceptedTurnId: TurnId;
  readonly messageId: MessageId;
  readonly intentSequence: number;
}): string {
  return `terminal-unprocessed-codex-steer:${stableIdentity("terminal-recovery", [
    input.threadId,
    input.acceptedTurnId,
    input.messageId,
    String(input.intentSequence),
  ])}`;
}

function recoveredIdentity(input: {
  readonly threadId: ThreadId;
  readonly acceptedTurnId: TurnId;
  readonly messageId: MessageId;
  readonly intentSequence: number;
}): string {
  return `codex-steer-recovered:${stableIdentity("recovered", [
    input.threadId,
    input.acceptedTurnId,
    input.messageId,
    String(input.intentSequence),
  ])}`;
}

function nextTurnDeliveryIdentity(input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly intentSequence: number;
}): string {
  return `codex-steer-delivered:${stableIdentity("next-turn-delivery", [
    input.threadId,
    input.messageId,
    String(input.intentSequence),
  ])}`;
}

function deliveryAttemptIdentity(input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly intentSequence: number;
  readonly delivery: "live-steer" | "next-turn";
  readonly reason: "live-steer" | CodexSteerNextTurnReason;
}): string {
  return `codex-steer-delivery-attempted:${stableIdentity("delivery-attempt", [
    input.threadId,
    input.messageId,
    String(input.intentSequence),
    input.delivery,
    input.reason,
  ])}`;
}

function nextTurnQueueIdentity(input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly intentSequence: number;
}): string {
  return `codex-steer-queued:${stableIdentity("next-turn-queue", [
    input.threadId,
    input.messageId,
    String(input.intentSequence),
  ])}`;
}

/**
 * Persist trusted evidence that ProviderCommandReactor observed a successful
 * Codex `turn/steer` return. Provider notifications cannot author this activity
 * kind: it is emitted only after the authenticated provider service call
 * resolves, and it carries identifiers rather than prompt content.
 */
export function buildCodexSteerAcceptedActivityCommand(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly messageId: MessageId;
  readonly intentSequence: number;
  readonly clientCorrelationId?: string;
  readonly createdAt: string;
}): Extract<OrchestrationCommand, { type: "thread.activity.append" }> {
  const identity = acceptedIdentity(input);
  return {
    type: "thread.activity.append",
    commandId: CommandId.make(`server:${identity}`),
    threadId: input.threadId,
    activity: {
      id: EventId.make(identity),
      tone: "info",
      kind: CODEX_STEER_ACCEPTED_ACTIVITY_KIND,
      summary: "Steer accepted",
      payload: {
        provider: "codex",
        messageId: input.messageId,
        acceptedTurnId: input.turnId,
        // A provider notification can race ahead of the steer ACK. Persist
        // the authenticated request generation so processing evidence is
        // ordered after the request, not incorrectly after this later ACK.
        intentSequence: input.intentSequence,
        ...(input.clientCorrelationId !== undefined
          ? { clientCorrelationId: input.clientCorrelationId }
          : {}),
      },
      turnId: input.turnId,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  };
}

/**
 * Persist the terminal-recovery delivery receipt only after the provider has
 * successfully accepted the recovered message as a new turn. The stable id is
 * keyed by the original accepted tuple, rather than by the provider response,
 * so every immediate/startup recovery path converges on one durable receipt.
 * Its payload is intentionally content-free: the prompt remains only in the
 * canonical message projection and is never copied into recovery evidence.
 */
export function buildCodexSteerRecoveredActivityCommand(input: {
  readonly threadId: ThreadId;
  readonly acceptedTurnId: TurnId;
  readonly messageId: MessageId;
  readonly intentSequence: number;
  readonly recoveredTurnId: TurnId;
  readonly clientCorrelationId?: string;
  readonly createdAt: string;
}): Extract<OrchestrationCommand, { type: "thread.activity.append" }> {
  const identity = recoveredIdentity(input);
  return {
    type: "thread.activity.append",
    commandId: CommandId.make(`server:${identity}`),
    threadId: input.threadId,
    activity: {
      id: EventId.make(identity),
      tone: "info",
      kind: CODEX_STEER_RECOVERED_ACTIVITY_KIND,
      summary: "Steer recovered",
      payload: {
        provider: "codex",
        messageId: input.messageId,
        acceptedTurnId: input.acceptedTurnId,
        recoveredTurnId: input.recoveredTurnId,
        intentSequence: input.intentSequence,
        ...(input.clientCorrelationId !== undefined
          ? { clientCorrelationId: input.clientCorrelationId }
          : {}),
      },
      // Associate the receipt with the turn that actually received the input.
      // acceptedTurnId remains independently bound in the content-free payload.
      turnId: input.recoveredTurnId,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  };
}

/**
 * Persist the outcome of a durable steer intent that was submitted through
 * `turn/start` because no provider turn remained to steer. This receipt is
 * emitted only after `ProviderService.sendTurn` succeeds. It is deliberately
 * separate from the pre-I/O runtime warning: startup replay and renderer
 * settlement may trust this server-authored kind without treating an intent
 * marker as proof of delivery.
 *
 * The stable identity excludes the provider response turn id. If a database
 * acknowledgement is retried after provider success, every attempt converges
 * on one original-message receipt instead of creating contradictory outcomes.
 */
export function buildCodexSteerDeliveredActivityCommand(input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly intentSequence: number;
  readonly deliveredTurnId: TurnId;
  readonly reason: CodexSteerNextTurnReason;
  readonly createdAt: string;
}): Extract<OrchestrationCommand, { type: "thread.activity.append" }> {
  const identity = nextTurnDeliveryIdentity(input);
  return {
    type: "thread.activity.append",
    commandId: CommandId.make(`server:${identity}`),
    threadId: input.threadId,
    activity: {
      id: EventId.make(identity),
      tone: "info",
      kind: CODEX_STEER_DELIVERED_ACTIVITY_KIND,
      summary: "Steer delivered as next turn",
      payload: {
        provider: "codex",
        messageId: input.messageId,
        deliveredTurnId: input.deliveredTurnId,
        intentSequence: input.intentSequence,
        delivery: "next-turn",
        reason: input.reason,
      },
      turnId: input.deliveredTurnId,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  };
}

/**
 * Commit an outbox-style ambiguity barrier before crossing the provider I/O
 * boundary. If Cafe exits after the provider accepts a mutation but before the
 * success receipt reaches SQLite, startup sees this exact server-authored
 * marker and fails closed instead of blindly delivering the same user message
 * twice. The marker contains only bounded identifiers and routing metadata;
 * prompt text and provider error material never enter the recovery ledger.
 *
 * Delivery and reason are included in the identity because one live-steer
 * attempt can conclusively fail with `no active turn` and legitimately be
 * followed by a distinct next-turn attempt in the same process. The exact
 * immutable steer-intent sequence is equally important: automatic retries
 * deliberately reuse MessageId, so a marker from an older failed generation
 * must never make a newer, not-yet-attempted intent look ambiguous.
 */
export function buildCodexSteerDeliveryAttemptedActivityCommand(
  input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly intentSequence: number;
    readonly createdAt: string;
  } & (
    | {
        readonly delivery: "live-steer";
        readonly reason: "live-steer";
        readonly expectedTurnId: TurnId;
      }
    | {
        readonly delivery: "next-turn";
        readonly reason: CodexSteerNextTurnReason;
        readonly staleTurnId: TurnId | null;
      }
  ),
): Extract<OrchestrationCommand, { type: "thread.activity.append" }> {
  const identity = deliveryAttemptIdentity(input);
  const turnId = input.delivery === "live-steer" ? input.expectedTurnId : input.staleTurnId;
  return {
    type: "thread.activity.append",
    commandId: CommandId.make(`server:${identity}`),
    threadId: input.threadId,
    activity: {
      id: EventId.make(identity),
      tone: "info",
      kind: CODEX_STEER_DELIVERY_ATTEMPTED_ACTIVITY_KIND,
      summary: "Steer delivery attempted",
      payload: {
        provider: "codex",
        messageId: input.messageId,
        intentSequence: input.intentSequence,
        delivery: input.delivery,
        deliveryState: "attempted",
        reason: input.reason,
        ...(input.delivery === "live-steer"
          ? { expectedTurnId: input.expectedTurnId }
          : input.staleTurnId !== null
            ? { staleTurnId: input.staleTurnId }
            : {}),
      },
      turnId,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  };
}

/**
 * Persist a restart-safe queue barrier when the follow-up could not be
 * delivered as a new turn. The payload is content-free and stable by the
 * exact immutable steer-intent generation, so a backend restart sees explicit
 * queue truth and does not silently replay an ambiguous failed provider call.
 * MessageId remains in the payload for renderer correlation, while the intent
 * sequence prevents a later same-message retry from aliasing the older row.
 */
export function buildCodexSteerNextTurnQueuedCommand(input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly intentSequence: number;
  readonly staleTurnId: TurnId | null;
  readonly reason: CodexSteerNextTurnReason;
  readonly createdAt: string;
}): Extract<OrchestrationCommand, { type: "thread.activity.append" }> {
  const identity = nextTurnQueueIdentity(input);
  return {
    type: "thread.activity.append",
    commandId: CommandId.make(`server:${identity}`),
    threadId: input.threadId,
    activity: {
      id: EventId.make(identity),
      tone: "info",
      kind: "provider.turn.steer.failed",
      summary: "Provider steer queued",
      payload: {
        provider: "codex",
        messageId: input.messageId,
        intentSequence: input.intentSequence,
        retryableFollowUp: true,
        delivery: "next-turn",
        deliveryState: "queued",
        recoveryBarrier: "next-turn-delivery-failed",
        reason: input.reason,
        ...(input.staleTurnId !== null ? { staleTurnId: input.staleTurnId } : {}),
        detail:
          "Cafe Code could not deliver this saved steer as the next turn, so it remains queued for an explicit retry.",
      },
      turnId: input.staleTurnId,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  };
}

export function buildCodexSteerRecoveryQueuedCommand(input: {
  readonly threadId: ThreadId;
  readonly acceptedTurnId: TurnId;
  readonly messageId: MessageId;
  readonly intentSequence: number;
  readonly createdAt: string;
  readonly reason: "manual-stop-barrier" | "newer-turn-active";
}): Extract<OrchestrationCommand, { type: "thread.activity.append" }> {
  const identity = recoveryIdentity(input);
  const manualStop = input.reason === "manual-stop-barrier";
  const suffix = manualStop ? "queued-after-stop" : "queued-after-newer-turn";
  return {
    type: "thread.activity.append",
    commandId: CommandId.make(`server:${identity}:${suffix}`),
    threadId: input.threadId,
    activity: {
      id: EventId.make(`${identity}:${suffix}`),
      tone: "info",
      kind: "provider.turn.steer.failed",
      summary: "Provider steer queued",
      payload: {
        detail: manualStop
          ? "Codex accepted this steer before the turn stopped. Cafe Code kept the saved message queued because Stop is an explicit cancellation barrier."
          : "Codex accepted this steer for the previous turn, but newer work is already active. Cafe Code kept the saved message queued for the next safe turn.",
        messageId: input.messageId,
        intentSequence: input.intentSequence,
        retryableFollowUp: true,
        retryAfter: "active-turn",
        staleTurnId: input.acceptedTurnId,
        recoveryBarrier: input.reason,
      },
      turnId: input.acceptedTurnId,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  };
}

/**
 * Reconcile one exact trusted acceptance against unbounded durable evidence.
 * The caller supplies the current provider-owned active turn separately from
 * projection state: a newer live turn is a hard boundary, while an exact live
 * accepted turn remains attached to the current response.
 */
export function decideCodexSteerRecovery(input: {
  readonly evidence: CodexSteerAcceptanceEvidence;
  readonly providerActiveTurnId: TurnId | null;
  readonly createdAt: string;
}): CodexSteerRecoveryDecision {
  const { evidence } = input;
  const acceptedTurnTerminal =
    evidence.turnCompletedAt !== null || evidence.turnState !== "running";

  // Provider-owned liveness is newer than a potentially lagging terminal
  // projection. Never replay into a second turn while Codex still reports the
  // exact accepted turn as active.
  if (input.providerActiveTurnId === evidence.acceptedTurnId) {
    return { disposition: "accepted-turn-live", commands: [] };
  }
  if (!acceptedTurnTerminal) {
    return { disposition: "accepted-turn-live", commands: [] };
  }
  if (evidence.recoveryObserved) {
    return { disposition: "recovery-delivered", commands: [] };
  }
  if (evidence.processingObserved) {
    return { disposition: "provider-processing-observed", commands: [] };
  }
  if (evidence.interruptRequested || evidence.sessionStopRequested) {
    return {
      disposition: "manual-stop-barrier",
      commands: [
        buildCodexSteerRecoveryQueuedCommand({
          threadId: evidence.threadId,
          acceptedTurnId: evidence.acceptedTurnId,
          messageId: evidence.message.id,
          intentSequence: evidence.intentSequence,
          createdAt: input.createdAt,
          reason: "manual-stop-barrier",
        }),
      ],
    };
  }
  if (
    input.providerActiveTurnId !== null &&
    input.providerActiveTurnId !== evidence.acceptedTurnId
  ) {
    return {
      disposition: "newer-turn-active",
      commands: [
        buildCodexSteerRecoveryQueuedCommand({
          threadId: evidence.threadId,
          acceptedTurnId: evidence.acceptedTurnId,
          messageId: evidence.message.id,
          intentSequence: evidence.intentSequence,
          createdAt: input.createdAt,
          reason: "newer-turn-active",
        }),
      ],
    };
  }

  const identity = recoveryIdentity({
    threadId: evidence.threadId,
    acceptedTurnId: evidence.acceptedTurnId,
    messageId: evidence.message.id,
    intentSequence: evidence.intentSequence,
  });
  return {
    disposition: "recover-as-next-turn",
    commands: [
      {
        type: "thread.activity.append",
        commandId: CommandId.make(`server:${identity}:diagnostic`),
        threadId: evidence.threadId,
        activity: {
          id: EventId.make(`${identity}:diagnostic`),
          tone: "info",
          kind: "runtime.warning",
          summary: "Steer continued as next turn",
          payload: {
            detail:
              "Codex ended the active turn before it emitted the accepted steer user message. Cafe Code is continuing the already-saved message exactly once.",
            provider: "codex",
            recovery: CODEX_TERMINAL_STEER_RECOVERY,
            messageId: evidence.message.id,
            staleTurnId: evidence.acceptedTurnId,
          },
          turnId: evidence.acceptedTurnId,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      },
      {
        type: "thread.turn.steer",
        commandId: CommandId.make(`server:${identity}:dispatch`),
        threadId: evidence.threadId,
        message: {
          messageId: evidence.message.id,
          role: "user",
          text: evidence.message.text,
          attachments: evidence.message.attachments ?? [],
        },
        terminalRecovery: {
          staleTurnId: evidence.acceptedTurnId,
          intentSequence: evidence.intentSequence,
        },
        createdAt: input.createdAt,
      },
    ],
  };
}

export function buildTerminalCodexSteerRecoveryCommands(input: {
  readonly evidence: ReadonlyArray<CodexSteerAcceptanceEvidence>;
  readonly providerActiveTurnId: TurnId | null;
  readonly createdAt: string;
}): ReadonlyArray<OrchestrationCommand> {
  return input.evidence.flatMap(
    (evidence) =>
      decideCodexSteerRecovery({
        evidence,
        providerActiveTurnId: input.providerActiveTurnId,
        createdAt: input.createdAt,
      }).commands,
  );
}
