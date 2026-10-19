import {
  ProviderDaemonFailedRootRetirementRefusal,
  ProviderSendTurnInput,
  type ProviderInstanceId,
  type SubagentRuntimeId,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { ProviderAdapterRequestError } from "../provider/Errors.ts";

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(ProviderSendTurnInput));
const decodeRequest = Schema.decodeUnknownSync(ProviderSendTurnInput);
const isFailedRootRetirementRefusal = Schema.is(ProviderDaemonFailedRootRetirementRefusal);
const HASH = /^[0-9a-f]{64}$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const MAX_RECEIPT_JSON_BYTES = 16_384;

function positiveSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requireSequence(value: number): number {
  if (!positiveSequence(value)) throw new RangeError("A positive safe event sequence is required.");
  return value;
}

/** The request remains private. Only its domain-separated canonical commitment
 * is retained in recovery activities; native history, prompts and attachments
 * must never be copied into a public retry receipt. */
export const codexFailedRootRetryRequestCommitment = (request: ProviderSendTurnInput): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "cafe-codex-failed-root-retry-request-v1",
        encodeRequest(decodeRequest(request)),
      ]),
    )
    .digest("hex");

/** The first winning owner remains immutable for existing acceptance readers.
 * Later claims are separate one-use reservations keyed by a proven refusal. */
export const codexFailedRootRetryClaimCommandId = (
  intentSequence: number,
  refusalSequence?: number,
): string =>
  refusalSequence === undefined
    ? `server:runtime-recovery-attempt:${requireSequence(intentSequence)}`
    : `server:codex-transient-resubmit:${requireSequence(intentSequence)}:${requireSequence(refusalSequence)}`;

/** Order by the referenced claim's sequence, not the receipt append time. A
 * delayed old refusal cannot supersede a newer claim. Fixed-width safe decimal
 * suffixes let the existing command-id B-tree select the latest row directly. */
export const codexFailedRootRetryRefusalCommandId = (
  intentSequence: number,
  claimSequence: number,
): string =>
  `server:codex-transient-unsubmitted:${requireSequence(intentSequence)}:${String(requireSequence(claimSequence)).padStart(16, "0")}`;

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/** A sole typed failure may prove zero submission. Defects, interruption,
 * combined causes, arbitrary tags and error prose never establish that fact.
 * Reject proxies before instanceof/property inspection and never call getters. */
export function readCodexFailedRootRetirementRefusal(
  cause: Cause.Cause<unknown>,
): ProviderDaemonFailedRootRetirementRefusal | undefined {
  const failure = cause.reasons[0];
  if (cause.reasons.length !== 1 || failure === undefined || !Cause.isFailReason(failure))
    return undefined;
  const error = failure.error;
  if (
    typeof error !== "object" ||
    error === null ||
    utilTypes.isProxy(error) ||
    !(error instanceof ProviderAdapterRequestError)
  )
    return undefined;
  const provider = ownValue(error, "provider");
  const method = ownValue(error, "method");
  const remoteTagDescriptor = Object.getOwnPropertyDescriptor(error, "remoteErrorTag");
  if (remoteTagDescriptor !== undefined && !("value" in remoteTagDescriptor)) return undefined;
  const remoteTag =
    remoteTagDescriptor !== undefined && "value" in remoteTagDescriptor
      ? remoteTagDescriptor.value
      : undefined;
  const reason = ownValue(error, "failedRootRetirementRefusal");
  return ((provider === "codex" && method === "turn/start") ||
    (provider === "provider-daemon" &&
      method === "sendTurn" &&
      remoteTag === "ProviderAdapterRequestError")) &&
    typeof reason === "string" &&
    isFailedRootRetirementRefusal(reason)
    ? reason
    : undefined;
}

export interface CodexFailedRootRetryIdentity {
  readonly intentSequence: number;
  readonly sourceEventSequence: number;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly subagentRuntimeId: SubagentRuntimeId;
  readonly sessionUpdatedAt: string;
}

export type CodexFailedRootRetryState =
  | { readonly status: "fresh" }
  | { readonly status: "consumed" }
  | {
      readonly status: "refused";
      readonly attemptOwnerId: string;
      readonly requestCommitment: string;
      readonly refusalSequence: number;
      readonly nextPreparationAttempt: number;
    };

interface RetryEventRow {
  readonly sequence: number;
  readonly commandId: string;
  readonly aggregateKind: string;
  readonly streamId: string;
  readonly actorKind: string;
  readonly eventType: string;
  readonly payloadJson: string | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function activityPayload(
  row: RetryEventRow,
  input: CodexFailedRootRetryIdentity,
): Record<string, unknown> | undefined {
  if (
    !positiveSequence(row.sequence) ||
    row.aggregateKind !== "thread" ||
    row.streamId !== input.threadId ||
    row.actorKind !== "server" ||
    row.eventType !== "thread.activity-appended" ||
    row.payloadJson === null
  )
    return undefined;
  try {
    const payload = record(JSON.parse(row.payloadJson));
    const activity = record(payload?.activity);
    if (
      payload?.threadId !== input.threadId ||
      activity?.kind !== "runtime.warning" ||
      activity.turnId !== input.turnId
    )
      return undefined;
    return record(activity.payload);
  } catch {
    return undefined;
  }
}

function matchesIdentity(
  payload: Record<string, unknown>,
  input: CodexFailedRootRetryIdentity,
): boolean {
  return (
    payload.recoveryIntentSequence === input.intentSequence &&
    payload.sourceEventSequence === input.sourceEventSequence &&
    payload.providerInstanceId === input.providerInstanceId &&
    payload.subagentRuntimeId === input.subagentRuntimeId &&
    payload.sessionUpdatedAt === input.sessionUpdatedAt
  );
}

/** Every read is either one exact command lookup or the latest command-id range
 * endpoint. Do not replace this with ORDER BY event.sequence, a transcript
 * suffix or a chain walk: retry-forever histories must stay bounded on restart.
 * Missing/legacy/malformed authority is consumed, never a fallback to an older
 * refusal. This reader only classifies durable evidence; user-control and live
 * native admission must still be repeated immediately before provider I/O. */
export const makeCodexFailedRootRetryReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readExact = (commandId: string) => sql<RetryEventRow>`
    SELECT sequence, command_id AS commandId, aggregate_kind AS aggregateKind,
      stream_id AS streamId, actor_kind AS actorKind, event_type AS eventType,
      CASE WHEN length(CAST(payload_json AS BLOB)) <= ${MAX_RECEIPT_JSON_BYTES}
        THEN payload_json ELSE NULL END AS payloadJson
    FROM orchestration_events INDEXED BY idx_orch_events_command_id
    WHERE command_id = ${commandId} LIMIT 2
  `;
  return (input: CodexFailedRootRetryIdentity) =>
    Effect.gen(function* () {
      if (
        !positiveSequence(input.intentSequence) ||
        !positiveSequence(input.sourceEventSequence) ||
        input.sourceEventSequence >= input.intentSequence
      )
        return { status: "consumed" } as const;
      const rootId = codexFailedRootRetryClaimCommandId(input.intentSequence);
      const roots = yield* readExact(rootId);
      if (roots.length === 0) return { status: "fresh" } as const;
      if (roots.length !== 1) return { status: "consumed" } as const;
      const root = roots[0]!;
      const rootPayload = activityPayload(root, input);
      if (
        root.sequence <= input.intentSequence ||
        rootPayload === undefined ||
        rootPayload.recovery !== "codex-transient-continuation-attempted" ||
        !matchesIdentity(rootPayload, input) ||
        typeof rootPayload.attemptOwnerId !== "string" ||
        !OWNER.test(rootPayload.attemptOwnerId) ||
        rootPayload.claimOwnerId !== rootPayload.attemptOwnerId ||
        typeof rootPayload.requestCommitment !== "string" ||
        !HASH.test(rootPayload.requestCommitment) ||
        typeof rootPayload.nativeConversationCommitment !== "string" ||
        !HASH.test(rootPayload.nativeConversationCommitment)
      )
        return { status: "consumed" } as const;
      const prefix = `server:codex-transient-unsubmitted:${input.intentSequence}:`;
      const latest = yield* sql<RetryEventRow>`
      SELECT sequence, command_id AS commandId, aggregate_kind AS aggregateKind,
        stream_id AS streamId, actor_kind AS actorKind, event_type AS eventType,
        CASE WHEN length(CAST(payload_json AS BLOB)) <= ${MAX_RECEIPT_JSON_BYTES}
          THEN payload_json ELSE NULL END AS payloadJson
      FROM orchestration_events INDEXED BY idx_orch_events_command_id
      WHERE command_id >= ${prefix} AND command_id < ${prefix + "~"}
      ORDER BY command_id DESC LIMIT 1
    `;
      const receipt = latest[0];
      if (receipt === undefined) return { status: "consumed" } as const;
      // Refuse ambiguous duplicate receipt identities instead of selecting an
      // arbitrary server event. The duplicate probe remains an exact index read.
      if ((yield* readExact(receipt.commandId)).length !== 1)
        return { status: "consumed" } as const;
      const receiptPayload = activityPayload(receipt, input);
      const suffix = receipt.commandId.slice(prefix.length);
      const claimSequence = /^\d{16}$/.test(suffix) ? Number(suffix) : undefined;
      if (
        !positiveSequence(claimSequence) ||
        receipt.commandId !==
          codexFailedRootRetryRefusalCommandId(input.intentSequence, claimSequence) ||
        receipt.sequence <= claimSequence ||
        receiptPayload === undefined ||
        receiptPayload.recovery !== "codex-transient-continuation-unsubmitted" ||
        !matchesIdentity(receiptPayload, input) ||
        receiptPayload.attemptOwnerId !== rootPayload.attemptOwnerId ||
        receiptPayload.requestCommitment !== rootPayload.requestCommitment ||
        receiptPayload.nativeConversationCommitment !== rootPayload.nativeConversationCommitment ||
        typeof receiptPayload.claimCommandId !== "string" ||
        typeof receiptPayload.claimOwnerId !== "string" ||
        !OWNER.test(receiptPayload.claimOwnerId) ||
        typeof receiptPayload.nextPreparationAttempt !== "number" ||
        !Number.isSafeInteger(receiptPayload.nextPreparationAttempt) ||
        receiptPayload.nextPreparationAttempt < 1 ||
        receiptPayload.nextPreparationAttempt > 30 ||
        typeof receiptPayload.failedRootRetirementRefusal !== "string" ||
        !isFailedRootRetirementRefusal(receiptPayload.failedRootRetirementRefusal)
      )
        return { status: "consumed" } as const;
      const claims = yield* readExact(receiptPayload.claimCommandId);
      const claim = claims.length === 1 ? claims[0] : undefined;
      const claimPayload = claim === undefined ? undefined : activityPayload(claim, input);
      if (
        claim === undefined ||
        claim.sequence !== claimSequence ||
        claimPayload === undefined ||
        !matchesIdentity(claimPayload, input) ||
        claimPayload.attemptOwnerId !== rootPayload.attemptOwnerId ||
        claimPayload.claimOwnerId !== receiptPayload.claimOwnerId ||
        claimPayload.requestCommitment !== rootPayload.requestCommitment ||
        claimPayload.nativeConversationCommitment !== rootPayload.nativeConversationCommitment
      )
        return { status: "consumed" } as const;
      if (claim.commandId === rootId) {
        if (
          claimPayload.recovery !== "codex-transient-continuation-attempted" ||
          claim.sequence !== root.sequence ||
          claimPayload.claimOwnerId !== rootPayload.attemptOwnerId
        )
          return { status: "consumed" } as const;
      } else {
        const previous = claimPayload.previousRefusalSequence;
        if (
          claimPayload.recovery !== "codex-transient-continuation-resubmit-attempted" ||
          !positiveSequence(previous) ||
          previous >= claim.sequence ||
          claim.commandId !== codexFailedRootRetryClaimCommandId(input.intentSequence, previous)
        )
          return { status: "consumed" } as const;
        // Only one predecessor is needed: a server-authored claim is an exact
        // immutable reservation. Verify its referenced receipt exists and binds
        // this same root/request; never recursively scan the entire retry chain.
        const predecessors = yield* sql<RetryEventRow>`
        SELECT sequence, command_id AS commandId, aggregate_kind AS aggregateKind,
          stream_id AS streamId, actor_kind AS actorKind, event_type AS eventType,
          CASE WHEN length(CAST(payload_json AS BLOB)) <= ${MAX_RECEIPT_JSON_BYTES}
            THEN payload_json ELSE NULL END AS payloadJson
        FROM orchestration_events WHERE sequence = ${previous} LIMIT 1
      `;
        const predecessor = predecessors[0];
        const previousPayload =
          predecessor === undefined ? undefined : activityPayload(predecessor, input);
        const previousSuffix = predecessor?.commandId.slice(prefix.length);
        const previousClaimSequence =
          previousSuffix !== undefined && /^\d{16}$/.test(previousSuffix)
            ? Number(previousSuffix)
            : undefined;
        if (
          predecessor === undefined ||
          !positiveSequence(previousClaimSequence) ||
          predecessor.commandId !==
            codexFailedRootRetryRefusalCommandId(input.intentSequence, previousClaimSequence) ||
          predecessor.sequence <= previousClaimSequence ||
          previousPayload === undefined ||
          previousPayload.recovery !== "codex-transient-continuation-unsubmitted" ||
          !matchesIdentity(previousPayload, input) ||
          previousPayload.attemptOwnerId !== rootPayload.attemptOwnerId ||
          previousPayload.requestCommitment !== rootPayload.requestCommitment ||
          previousPayload.nativeConversationCommitment !==
            rootPayload.nativeConversationCommitment ||
          typeof previousPayload.claimCommandId !== "string" ||
          typeof previousPayload.claimOwnerId !== "string" ||
          !OWNER.test(previousPayload.claimOwnerId) ||
          typeof previousPayload.nextPreparationAttempt !== "number" ||
          !Number.isSafeInteger(previousPayload.nextPreparationAttempt) ||
          previousPayload.nextPreparationAttempt < 1 ||
          previousPayload.nextPreparationAttempt > 30 ||
          typeof previousPayload.failedRootRetirementRefusal !== "string" ||
          !isFailedRootRetirementRefusal(previousPayload.failedRootRetirementRefusal) ||
          (yield* readExact(predecessor.commandId)).length !== 1
        )
          return { status: "consumed" } as const;
      }
      const nextId = codexFailedRootRetryClaimCommandId(input.intentSequence, receipt.sequence);
      if ((yield* readExact(nextId)).length !== 0) return { status: "consumed" } as const;
      return {
        status: "refused",
        attemptOwnerId: rootPayload.attemptOwnerId,
        requestCommitment: rootPayload.requestCommitment,
        refusalSequence: receipt.sequence,
        nextPreparationAttempt: receiptPayload.nextPreparationAttempt,
      } as const;
    }).pipe(
      Effect.mapError(toPersistenceSqlError("CodexFailedRootRetry.read")),
      Effect.map((state): CodexFailedRootRetryState => state),
    );
});
