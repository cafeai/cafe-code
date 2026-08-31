import type { MessageId, ThreadId, TurnId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import { buildCodexSteerClientCorrelationId } from "../provider/codexSteerCorrelation.ts";

/**
 * Only this many events from one active Codex thread are eligible for
 * pre-migration provider-side-effect recovery.
 *
 * A steer that predates this recent tail cannot represent a fresh
 * crash-before-I/O handoff: replaying arbitrarily old provider effects is more
 * dangerous than declining them. The bound is per thread (not global), uses
 * the existing `(aggregate_kind, stream_id, sequence)` index, and keeps the
 * synchronous node:sqlite read independent of a multi-gigabyte journal.
 */
export const LEGACY_CODEX_STEER_RECOVERY_TAIL_EVENTS = 4096;
const LEGACY_CODEX_STEER_RECOVERY_PAGE_EVENTS = 64;

export interface PersistedUnsettledCodexSteerIntent {
  readonly sequence: number;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly expectedTurnId: TurnId | null;
  readonly createdAt: string;
}

/** Trusted compact identity for a server-authored Codex steer acceptance. */
export interface PersistedAcceptedCodexSteerBarrier {
  readonly sequence: number;
  /** Authenticated start/steer request generation which produced this ACK. */
  readonly intentSequence: number;
  readonly intentCreatedAt: string;
  readonly threadId: ThreadId;
  readonly activityId: string;
  readonly acceptedTurnId: TurnId;
  readonly clientCorrelationId: string | null;
  readonly messageId: MessageId;
  readonly acceptedAt: string;
}

/** Exact canonical task-progress identity produced by runtime ingestion. */
export interface PersistedCodexSteerProcessingSource {
  readonly threadId: ThreadId;
  readonly activityId: string;
  readonly turnId: TurnId | null;
  readonly createdAt: string;
  readonly messageId: MessageId;
  readonly clientCorrelationId: string;
  readonly taskId: string;
}

export class CodexSteerIntentLedgerInvariantError extends Schema.TaggedErrorClass<CodexSteerIntentLedgerInvariantError>()(
  "CodexSteerIntentLedgerInvariantError",
  {
    issue: Schema.Literals([
      "missing-migration-state",
      "invalid-migration-state",
      "invalid-hydration-state",
      "invalid-event-payload",
      "candidate-event-mismatch",
    ]),
  },
) {
  override get message(): string {
    return `Codex steer intent ledger integrity check failed: ${this.issue}`;
  }
}

interface LedgerStateRow {
  readonly legacyCutoffSequence: number;
}

interface HydrationStateRow {
  readonly tailFloorSequence: number;
  readonly throughSequence: number;
}

interface TailFloorRow {
  readonly tailFloorSequence: number;
}

interface LegacyEventRow {
  readonly sequence: number;
  readonly eventType: string;
  readonly actorKind: string;
  readonly occurredAt: string;
  readonly payloadJson: string;
}

interface CandidateJoinRow {
  readonly candidateSequence: number;
  readonly candidateThreadId: string;
  readonly candidateMessageId: string;
  readonly candidateExpectedTurnId: string | null;
  readonly candidateCreatedAt: string;
  readonly eventSequence: number | null;
  readonly eventAggregateKind: string | null;
  readonly eventThreadId: string | null;
  readonly eventType: string | null;
  readonly eventActorKind: string | null;
  readonly eventOccurredAt: string | null;
  readonly eventPayloadJson: string | null;
}

interface AcceptedBarrierJoinRow {
  readonly barrierSequence: number;
  readonly barrierIntentSequence: number;
  readonly barrierThreadId: string;
  readonly barrierMessageId: string;
  readonly barrierActivityId: string | null;
  readonly barrierTurnId: string | null;
  readonly barrierClientCorrelationId: string | null;
  readonly barrierActivityCreatedAt: string | null;
  readonly eventSequence: number | null;
  readonly eventAggregateKind: string | null;
  readonly eventThreadId: string | null;
  readonly eventType: string | null;
  readonly eventActorKind: string | null;
  readonly eventPayloadJson: string | null;
  readonly intentEventSequence: number | null;
  readonly intentEventAggregateKind: string | null;
  readonly intentEventThreadId: string | null;
  readonly intentEventType: string | null;
  readonly intentEventActorKind: string | null;
  readonly intentEventOccurredAt: string | null;
  readonly intentEventPayloadJson: string | null;
}

interface TombstoneRow {
  readonly retired: number;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function parseEventPayload(
  payloadJson: string,
): Effect.Effect<JsonObject, CodexSteerIntentLedgerInvariantError> {
  return Effect.try({
    try: () => asObject(JSON.parse(payloadJson)),
    catch: () =>
      new CodexSteerIntentLedgerInvariantError({
        issue: "invalid-event-payload",
      }),
  }).pipe(
    Effect.flatMap((payload) =>
      payload === undefined
        ? Effect.fail(
            new CodexSteerIntentLedgerInvariantError({
              issue: "invalid-event-payload",
            }),
          )
        : Effect.succeed(payload),
    ),
  );
}

function isAuthenticatedIntentActor(actorKind: string): boolean {
  return actorKind === "client" || actorKind === "server";
}

function readIntentIdentity(
  row: LegacyEventRow,
  payload: JsonObject,
  threadId: ThreadId,
): { readonly messageId: MessageId; readonly expectedTurnId: TurnId | null } | undefined {
  if (
    !isAuthenticatedIntentActor(row.actorKind) ||
    payload.threadId !== threadId ||
    typeof payload.messageId !== "string"
  ) {
    return undefined;
  }
  const expectedTurnId = payload.expectedTurnId;
  if (
    expectedTurnId !== undefined &&
    expectedTurnId !== null &&
    typeof expectedTurnId !== "string"
  ) {
    return undefined;
  }
  return {
    messageId: payload.messageId as MessageId,
    expectedTurnId: (expectedTurnId ?? null) as TurnId | null,
  };
}

function readSteerCandidate(
  row: LegacyEventRow,
  payload: JsonObject,
  threadId: ThreadId,
): PersistedUnsettledCodexSteerIntent | undefined {
  if (row.eventType !== "thread.turn-steer-requested" || payload.createdAt !== row.occurredAt) {
    return undefined;
  }
  const identity = readIntentIdentity(row, payload, threadId);
  return identity === undefined
    ? undefined
    : {
        sequence: row.sequence,
        threadId,
        messageId: identity.messageId,
        expectedTurnId: identity.expectedTurnId,
        createdAt: row.occurredAt,
      };
}

interface RecoveryBarrier {
  readonly messageId: MessageId;
  /** NULL means every older generation of this MessageId is settled. */
  readonly candidateSequence: number | null;
}

function readActivityBarrier(
  row: LegacyEventRow,
  payload: JsonObject,
  threadId: ThreadId,
): RecoveryBarrier | undefined {
  if (
    row.eventType !== "thread.activity-appended" ||
    row.actorKind !== "server" ||
    payload.threadId !== threadId
  ) {
    return undefined;
  }
  const activity = asObject(payload.activity);
  const activityPayload = asObject(activity?.payload);
  if (
    activity === undefined ||
    activityPayload === undefined ||
    typeof activity.id !== "string" ||
    typeof activity.kind !== "string" ||
    typeof activityPayload.messageId !== "string"
  ) {
    return undefined;
  }
  const messageId = activityPayload.messageId as MessageId;
  const explicitIntentSequence = activityPayload.intentSequence;
  const candidateSequence =
    explicitIntentSequence === undefined || explicitIntentSequence === null
      ? null
      : Number.isSafeInteger(explicitIntentSequence) && (explicitIntentSequence as number) >= 0
        ? (explicitIntentSequence as number)
        : undefined;
  if (candidateSequence === undefined) {
    return undefined;
  }

  switch (activity.kind) {
    case "provider.turn.steer.accepted": {
      const correlation = activityPayload.clientCorrelationId;
      return activityPayload.provider === "codex" &&
        typeof activity.turnId === "string" &&
        activityPayload.acceptedTurnId === activity.turnId &&
        (correlation === undefined || correlation === null || typeof correlation === "string")
        ? { messageId, candidateSequence }
        : undefined;
    }
    case "provider.turn.steer.failed": {
      if (candidateSequence === null) {
        return { messageId, candidateSequence: null };
      }
      return { messageId, candidateSequence };
    }
    case "provider.turn.steer.recovered":
      return activityPayload.provider === "codex" &&
        typeof activityPayload.acceptedTurnId === "string" &&
        typeof activity.turnId === "string" &&
        activityPayload.recoveredTurnId === activity.turnId
        ? { messageId, candidateSequence }
        : undefined;
    case "provider.turn.steer.delivered":
      return activityPayload.provider === "codex" &&
        typeof activity.turnId === "string" &&
        activityPayload.deliveredTurnId === activity.turnId &&
        activityPayload.delivery === "next-turn" &&
        [
          "turn-start-after-no-local-active-turn",
          "turn-start-after-missing-active-turn-id",
          "turn-start-after-provider-no-active-turn",
        ].includes(String(activityPayload.reason))
        ? { messageId, candidateSequence }
        : undefined;
    case "provider.turn.steer.delivery-attempted": {
      if (candidateSequence === null) {
        return undefined;
      }
      const liveSteer =
        activityPayload.delivery === "live-steer" &&
        activityPayload.reason === "live-steer" &&
        typeof activity.turnId === "string" &&
        activityPayload.expectedTurnId === activity.turnId;
      const nextTurn =
        activityPayload.delivery === "next-turn" &&
        [
          "turn-start-after-no-local-active-turn",
          "turn-start-after-missing-active-turn-id",
          "turn-start-after-provider-no-active-turn",
          "turn-start-after-terminal-unprocessed-steer",
        ].includes(String(activityPayload.reason)) &&
        activityPayload.staleTurnId === activity.turnId;
      return activityPayload.provider === "codex" &&
        activityPayload.deliveryState === "attempted" &&
        (liveSteer || nextTurn)
        ? { messageId, candidateSequence }
        : undefined;
    }
    default:
      return undefined;
  }
}

function readAcceptedBarrier(
  row: LegacyEventRow,
  payload: JsonObject,
  threadId: ThreadId,
  intentOrigins: ReadonlyMap<number, { readonly messageId: MessageId; readonly createdAt: string }>,
  latestIntentSequenceByMessage: ReadonlyMap<MessageId, number>,
): PersistedAcceptedCodexSteerBarrier | undefined {
  if (
    row.eventType !== "thread.activity-appended" ||
    row.actorKind !== "server" ||
    payload.threadId !== threadId
  ) {
    return undefined;
  }
  const activity = asObject(payload.activity);
  const activityPayload = asObject(activity?.payload);
  const correlation = activityPayload?.clientCorrelationId;
  const explicitIntentSequence = activityPayload?.intentSequence;
  if (
    activity === undefined ||
    activityPayload === undefined ||
    activity.kind !== "provider.turn.steer.accepted" ||
    typeof activity.id !== "string" ||
    typeof activity.turnId !== "string" ||
    typeof activity.createdAt !== "string" ||
    activityPayload.provider !== "codex" ||
    typeof activityPayload.messageId !== "string" ||
    activityPayload.acceptedTurnId !== activity.turnId ||
    (correlation !== undefined && correlation !== null && typeof correlation !== "string")
  ) {
    return undefined;
  }
  const messageId = activityPayload.messageId as MessageId;
  const intentSequence = Number.isSafeInteger(explicitIntentSequence)
    ? (explicitIntentSequence as number)
    : latestIntentSequenceByMessage.get(messageId);
  const intentOrigin = intentSequence === undefined ? undefined : intentOrigins.get(intentSequence);
  if (
    intentSequence === undefined ||
    intentSequence < 0 ||
    intentSequence >= row.sequence ||
    intentOrigin?.messageId !== messageId
  ) {
    return undefined;
  }
  return {
    sequence: row.sequence,
    intentSequence,
    intentCreatedAt: intentOrigin.createdAt,
    threadId,
    activityId: activity.id,
    acceptedTurnId: activity.turnId as TurnId,
    clientCorrelationId: (correlation ?? null) as string | null,
    messageId,
    acceptedAt: activity.createdAt,
  };
}

function applyLegacyEvent(
  candidates: Map<number, PersistedUnsettledCodexSteerIntent>,
  row: LegacyEventRow,
  payload: JsonObject,
  threadId: ThreadId,
): void {
  const candidate = readSteerCandidate(row, payload, threadId);
  if (candidate !== undefined) {
    candidates.set(candidate.sequence, candidate);
  }

  const laterIntentIdentity =
    row.eventType === "thread.turn-start-requested" ||
    row.eventType === "thread.turn-steer-requested"
      ? readIntentIdentity(row, payload, threadId)
      : undefined;
  const barrier: RecoveryBarrier | undefined =
    laterIntentIdentity !== undefined
      ? { messageId: laterIntentIdentity.messageId, candidateSequence: null }
      : readActivityBarrier(row, payload, threadId);
  if (barrier === undefined) {
    return;
  }
  for (const [sequence, unsettled] of candidates) {
    if (
      sequence < row.sequence &&
      unsettled.messageId === barrier.messageId &&
      (barrier.candidateSequence === null || barrier.candidateSequence === sequence)
    ) {
      candidates.delete(sequence);
    }
  }
}

function applyLegacyAcceptedSettlement(
  accepted: Map<number, PersistedAcceptedCodexSteerBarrier>,
  row: LegacyEventRow,
  payload: JsonObject,
  threadId: ThreadId,
): void {
  if (row.eventType !== "thread.activity-appended" || payload.threadId !== threadId) {
    return;
  }
  const activity = asObject(payload.activity);
  const activityPayload = asObject(activity?.payload);
  if (
    activity === undefined ||
    activityPayload === undefined ||
    typeof activity.turnId !== "string" ||
    typeof activity.kind !== "string"
  ) {
    return;
  }

  for (const [sequence, candidate] of accepted) {
    if (sequence >= row.sequence) {
      continue;
    }
    if (activity.kind === "provider.turn.steer.recovered") {
      const recoveredIntentSequence = activityPayload.intentSequence;
      const exactRecoveredGeneration =
        recoveredIntentSequence === undefined || recoveredIntentSequence === null
          ? true
          : Number.isSafeInteger(recoveredIntentSequence) &&
            recoveredIntentSequence === candidate.intentSequence;
      if (
        row.actorKind === "server" &&
        exactRecoveredGeneration &&
        activityPayload.provider === "codex" &&
        activityPayload.messageId === candidate.messageId &&
        activityPayload.acceptedTurnId === candidate.acceptedTurnId &&
        activityPayload.recoveredTurnId === activity.turnId &&
        (activityPayload.clientCorrelationId ?? null) === candidate.clientCorrelationId
      ) {
        accepted.delete(sequence);
      }
      continue;
    }
    if (activity.kind !== "task.progress" || typeof activityPayload.taskId !== "string") {
      continue;
    }
    if (
      row.actorKind !== "provider" ||
      candidate.acceptedTurnId !== activity.turnId ||
      typeof activity.createdAt !== "string" ||
      activity.createdAt < candidate.intentCreatedAt
    ) {
      continue;
    }
    const usage = asObject(activityPayload.usage);
    if (usage === undefined) {
      continue;
    }
    // A provider-authored observation can destructively settle legacy
    // authority only after Cafe's enrichment bound both the independently
    // derived correlation and raw MessageId. Sequence/time together reject a
    // delayed replay created before this intent generation. Sequence-less
    // legacy acceptances remain recoverable unless a trusted server receipt
    // settles them.
    const processingMatches =
      candidate.clientCorrelationId !== null &&
      activityPayload.taskId === `codex-turn-steer-processing:${candidate.clientCorrelationId}` &&
      usage.clientCorrelationId === candidate.clientCorrelationId &&
      usage.messageId === candidate.messageId;
    if (processingMatches) {
      accepted.delete(sequence);
    }
  }
}

function readMigrationCutoff(
  sql: SqlClient.SqlClient,
): Effect.Effect<number, SqlError.SqlError | CodexSteerIntentLedgerInvariantError> {
  return Effect.gen(function* () {
    const [state] = yield* sql<LedgerStateRow>`
      SELECT legacy_cutoff_sequence AS "legacyCutoffSequence"
      FROM orchestration_unsettled_codex_steer_state
      WHERE singleton_id = 1
      LIMIT 1
    `;
    if (state === undefined) {
      return yield* new CodexSteerIntentLedgerInvariantError({
        issue: "missing-migration-state",
      });
    }
    if (!Number.isSafeInteger(state.legacyCutoffSequence) || state.legacyCutoffSequence < 0) {
      return yield* new CodexSteerIntentLedgerInvariantError({
        issue: "invalid-migration-state",
      });
    }
    return state.legacyCutoffSequence;
  });
}

/**
 * Hydrate one relevant thread from a fixed recent pre-migration event tail.
 *
 * The entire read is bounded by `LEGACY_CODEX_STEER_RECOVERY_TAIL_EVENTS` via
 * the existing stream-sequence index. Candidate writes and the hydration
 * marker commit atomically. Exact post-migration barriers are checked in the
 * same transaction, preventing an outcome that arrived before this first
 * hydration from resurrecting an already-settled legacy intent.
 */
export function hydrateLegacyUnsettledCodexSteerIntentsForThread(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  legacyCutoffSequence: number,
): Effect.Effect<void, SqlError.SqlError | CodexSteerIntentLedgerInvariantError> {
  return Effect.gen(function* () {
    const [hydration] = yield* sql<HydrationStateRow>`
      SELECT
        tail_floor_sequence AS "tailFloorSequence",
        through_sequence AS "throughSequence"
      FROM orchestration_unsettled_codex_steer_hydration
      WHERE thread_id = ${threadId}
      LIMIT 1
    `;
    if (hydration !== undefined) {
      if (
        !Number.isSafeInteger(hydration.tailFloorSequence) ||
        hydration.tailFloorSequence < 0 ||
        !Number.isSafeInteger(hydration.throughSequence) ||
        hydration.throughSequence !== legacyCutoffSequence ||
        hydration.tailFloorSequence > hydration.throughSequence
      ) {
        return yield* new CodexSteerIntentLedgerInvariantError({
          issue: "invalid-hydration-state",
        });
      }
      return;
    }

    const [floorRow] = yield* sql<TailFloorRow>`
      SELECT COALESCE(MIN(recent.sequence), 0) AS "tailFloorSequence"
      FROM (
        SELECT sequence
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
          AND sequence <= ${legacyCutoffSequence}
        ORDER BY sequence DESC
        LIMIT ${LEGACY_CODEX_STEER_RECOVERY_TAIL_EVENTS}
      ) AS recent
    `;
    const tailFloorSequence = floorRow?.tailFloorSequence ?? 0;
    if (
      !Number.isSafeInteger(tailFloorSequence) ||
      tailFloorSequence < 0 ||
      tailFloorSequence > legacyCutoffSequence
    ) {
      return yield* new CodexSteerIntentLedgerInvariantError({
        issue: "invalid-hydration-state",
      });
    }

    const candidates = new Map<number, PersistedUnsettledCodexSteerIntent>();
    const acceptedBarriers = new Map<number, PersistedAcceptedCodexSteerBarrier>();
    const intentOrigins = new Map<
      number,
      { readonly messageId: MessageId; readonly createdAt: string }
    >();
    const latestIntentSequenceByMessage = new Map<MessageId, number>();
    let pageCursor = Math.max(0, tailFloorSequence - 1);
    while (pageCursor < legacyCutoffSequence) {
      // Payloads are adversarially sized up to the journal limit. Keep each
      // synchronous StatementSync.all() bounded to a conservative row page;
      // the 4,096-event eligibility tail is a recovery authority bound, not a
      // license to materialize its payloads in one potentially GiB-sized read.
      const rows = yield* sql<LegacyEventRow>`
        SELECT
          sequence,
          event_type AS "eventType",
          actor_kind AS "actorKind",
          occurred_at AS "occurredAt",
          payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
          AND sequence >= ${tailFloorSequence}
          AND sequence > ${pageCursor}
          AND sequence <= ${legacyCutoffSequence}
          AND event_type IN (
            'thread.turn-start-requested',
            'thread.turn-steer-requested',
            'thread.activity-appended'
          )
        ORDER BY sequence ASC
        LIMIT ${LEGACY_CODEX_STEER_RECOVERY_PAGE_EVENTS}
      `;
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        if (
          !Number.isSafeInteger(row.sequence) ||
          row.sequence < 0 ||
          typeof row.payloadJson !== "string"
        ) {
          return yield* new CodexSteerIntentLedgerInvariantError({
            issue: "invalid-event-payload",
          });
        }
        const payload = yield* parseEventPayload(row.payloadJson);
        const intentIdentity =
          row.eventType === "thread.turn-start-requested" ||
          row.eventType === "thread.turn-steer-requested"
            ? readIntentIdentity(row, payload, threadId)
            : undefined;
        if (intentIdentity !== undefined) {
          intentOrigins.set(row.sequence, {
            messageId: intentIdentity.messageId,
            createdAt: row.occurredAt,
          });
          latestIntentSequenceByMessage.set(intentIdentity.messageId, row.sequence);
        }
        applyLegacyEvent(candidates, row, payload, threadId);
        const acceptedBarrier = readAcceptedBarrier(
          row,
          payload,
          threadId,
          intentOrigins,
          latestIntentSequenceByMessage,
        );
        if (acceptedBarrier !== undefined) {
          acceptedBarriers.set(acceptedBarrier.sequence, acceptedBarrier);
        }
        applyLegacyAcceptedSettlement(acceptedBarriers, row, payload, threadId);
      }
      pageCursor = rows.at(-1)!.sequence;
      if (rows.length === LEGACY_CODEX_STEER_RECOVERY_PAGE_EVENTS) {
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      }
    }

    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [tombstone] = yield* sql<TombstoneRow>`
          SELECT 1 AS retired
          FROM hard_deleted_threads
          WHERE thread_id = ${threadId}
          LIMIT 1
        `;
        if (tombstone !== undefined) {
          return;
        }
        // A prior interrupted implementation must not leave a partial legacy
        // set. Post-migration candidates have sequence > cutoff and survive.
        yield* sql`
          DELETE FROM orchestration_unsettled_codex_steer_intents
          WHERE thread_id = ${threadId}
            AND sequence <= ${legacyCutoffSequence}
        `;
        for (const candidate of candidates.values()) {
          yield* sql`
            INSERT INTO orchestration_unsettled_codex_steer_intents (
              sequence,
              thread_id,
              message_id,
              expected_turn_id,
              created_at
            )
            VALUES (
              ${candidate.sequence},
              ${candidate.threadId},
              ${candidate.messageId},
              ${candidate.expectedTurnId},
              ${candidate.createdAt}
            )
            ON CONFLICT (sequence) DO NOTHING
          `;
        }

        yield* sql`
          DELETE FROM orchestration_pending_codex_steer_acceptances
          WHERE thread_id = ${threadId}
            AND sequence <= ${legacyCutoffSequence}
        `;
        // Recent trusted pre-migration acceptances are retained only while
        // unsettled. Older acceptances outside the explicit tail are
        // intentionally not replay authority after upgrade.
        for (const barrier of acceptedBarriers.values()) {
          yield* sql`
            INSERT INTO orchestration_pending_codex_steer_acceptances (
              sequence,
              intent_sequence,
              thread_id,
              message_id,
              activity_id,
              accepted_turn_id,
              client_correlation_id,
              accepted_at
            )
            VALUES (
              ${barrier.sequence},
              ${barrier.intentSequence},
              ${barrier.threadId},
              ${barrier.messageId},
              ${barrier.activityId},
              ${barrier.acceptedTurnId},
              ${barrier.clientCorrelationId},
              ${barrier.acceptedAt}
            )
            ON CONFLICT (sequence) DO NOTHING
          `;
        }

        // Barriers are append-indexed after the cutoff even if the candidate
        // did not exist at outcome time. Apply them before declaring the
        // legacy tail complete so hydration cannot resurrect settled work.
        yield* sql`
          DELETE FROM orchestration_unsettled_codex_steer_intents
          WHERE thread_id = ${threadId}
            AND sequence <= ${legacyCutoffSequence}
            AND EXISTS (
              SELECT 1
              FROM orchestration_codex_steer_recovery_barriers AS barrier
              WHERE barrier.sequence > orchestration_unsettled_codex_steer_intents.sequence
                AND barrier.thread_id =
                  orchestration_unsettled_codex_steer_intents.thread_id
                AND (
                  barrier.message_id =
                    orchestration_unsettled_codex_steer_intents.message_id
                  AND (
                    barrier.candidate_sequence IS NULL
                    OR barrier.candidate_sequence =
                      orchestration_unsettled_codex_steer_intents.sequence
                  )
                )
              LIMIT 1
            )
        `;

        yield* sql`
          DELETE FROM orchestration_pending_codex_steer_acceptances
          WHERE thread_id = ${threadId}
            AND sequence <= ${legacyCutoffSequence}
            AND EXISTS (
              SELECT 1
              FROM orchestration_codex_steer_recovery_barriers AS barrier
              WHERE barrier.sequence >
                  orchestration_pending_codex_steer_acceptances.sequence
                AND barrier.thread_id =
                  orchestration_pending_codex_steer_acceptances.thread_id
                AND (
                  (
                    barrier.barrier_kind = 'provider.turn.steer.recovered'
                    AND barrier.message_id =
                      orchestration_pending_codex_steer_acceptances.message_id
                    AND barrier.accepted_turn_id =
                      orchestration_pending_codex_steer_acceptances.accepted_turn_id
                    AND barrier.client_correlation_id IS
                      orchestration_pending_codex_steer_acceptances.client_correlation_id
                  )
                  OR (
                    barrier.barrier_kind = 'task.progress'
                    AND barrier.accepted_turn_id =
                      orchestration_pending_codex_steer_acceptances.accepted_turn_id
                    AND (
                      (
                        orchestration_pending_codex_steer_acceptances.client_correlation_id
                          IS NOT NULL
                        AND barrier.client_correlation_id =
                          orchestration_pending_codex_steer_acceptances.client_correlation_id
                        AND (
                          barrier.message_id IS NULL
                          OR barrier.message_id =
                            orchestration_pending_codex_steer_acceptances.message_id
                        )
                      )
                      OR (
                        orchestration_pending_codex_steer_acceptances.client_correlation_id
                          IS NULL
                        AND barrier.client_correlation_id IS NULL
                        AND barrier.message_id =
                          orchestration_pending_codex_steer_acceptances.message_id
                      )
                    )
                  )
                )
              LIMIT 1
            )
        `;

        yield* sql`
          INSERT INTO orchestration_unsettled_codex_steer_hydration (
            thread_id,
            tail_floor_sequence,
            through_sequence
          )
          VALUES (${threadId}, ${tailFloorSequence}, ${legacyCutoffSequence})
          ON CONFLICT (thread_id) DO NOTHING
        `;

        // The durable candidate sets now reflect every pre/post-cutoff event
        // relevant to this thread. Historical barriers are no longer needed
        // and must not become an append-only startup cost.
        yield* sql`
          DELETE FROM orchestration_codex_steer_recovery_barriers
          WHERE thread_id = ${threadId}
        `;
      }),
    );
  });
}

/**
 * Read and revalidate compact candidates for exactly the relevant Codex
 * threads. The LEFT JOIN and explicit tuple checks fail closed if foreign-key
 * enforcement was disabled, the ledger was manually altered, or an event was
 * rebound to the wrong thread/message identity.
 */
export function readUnsettledCodexSteerIntents(
  sql: SqlClient.SqlClient,
  threadIds: ReadonlyArray<ThreadId>,
): Effect.Effect<
  ReadonlyArray<PersistedUnsettledCodexSteerIntent>,
  SqlError.SqlError | CodexSteerIntentLedgerInvariantError
> {
  return Effect.gen(function* () {
    const uniqueThreadIds = [...new Set(threadIds)];
    const candidates: PersistedUnsettledCodexSteerIntent[] = [];
    for (const threadId of uniqueThreadIds) {
      const rows = yield* sql<CandidateJoinRow>`
        SELECT
          candidate.sequence AS "candidateSequence",
          candidate.thread_id AS "candidateThreadId",
          candidate.message_id AS "candidateMessageId",
          candidate.expected_turn_id AS "candidateExpectedTurnId",
          candidate.created_at AS "candidateCreatedAt",
          event.sequence AS "eventSequence",
          event.aggregate_kind AS "eventAggregateKind",
          event.stream_id AS "eventThreadId",
          event.event_type AS "eventType",
          event.actor_kind AS "eventActorKind",
          event.occurred_at AS "eventOccurredAt",
          event.payload_json AS "eventPayloadJson"
        FROM orchestration_unsettled_codex_steer_intents AS candidate
        LEFT JOIN orchestration_events AS event
          ON event.sequence = candidate.sequence
        WHERE candidate.thread_id = ${threadId}
        ORDER BY candidate.sequence ASC
      `;
      for (const row of rows) {
        if (
          !Number.isSafeInteger(row.candidateSequence) ||
          row.candidateSequence < 0 ||
          row.eventSequence !== row.candidateSequence ||
          row.candidateThreadId !== threadId ||
          row.eventAggregateKind !== "thread" ||
          row.eventThreadId !== threadId ||
          row.eventType !== "thread.turn-steer-requested" ||
          !isAuthenticatedIntentActor(row.eventActorKind ?? "") ||
          row.eventOccurredAt === null ||
          row.eventPayloadJson === null
        ) {
          return yield* new CodexSteerIntentLedgerInvariantError({
            issue: "candidate-event-mismatch",
          });
        }
        const payload = yield* parseEventPayload(row.eventPayloadJson);
        const verified = readSteerCandidate(
          {
            sequence: row.eventSequence,
            eventType: row.eventType,
            actorKind: row.eventActorKind ?? "",
            occurredAt: row.eventOccurredAt,
            payloadJson: row.eventPayloadJson,
          },
          payload,
          threadId,
        );
        if (
          verified === undefined ||
          verified.messageId !== row.candidateMessageId ||
          verified.expectedTurnId !== row.candidateExpectedTurnId ||
          verified.createdAt !== row.candidateCreatedAt
        ) {
          return yield* new CodexSteerIntentLedgerInvariantError({
            issue: "candidate-event-mismatch",
          });
        }
        candidates.push(verified);
      }
    }
    return candidates.toSorted((left, right) => left.sequence - right.sequence);
  });
}

/**
 * Read only currently pending trusted accepted-steer identities from the
 * compact append-time candidate table. Processed/recovered acceptances are
 * pruned as their exact server-authored events append, so this read cannot
 * grow with historical successful steering.
 */
export function readAcceptedCodexSteerRecoveryBarriers(
  sql: SqlClient.SqlClient,
  threadIds: ReadonlyArray<ThreadId>,
): Effect.Effect<
  ReadonlyArray<PersistedAcceptedCodexSteerBarrier>,
  SqlError.SqlError | CodexSteerIntentLedgerInvariantError
> {
  return Effect.gen(function* () {
    // Missing migration authority must never silently look like no accepted
    // recovery evidence.
    const legacyCutoffSequence = yield* readMigrationCutoff(sql);
    const uniqueThreadIds = [...new Set(threadIds)];
    const accepted: PersistedAcceptedCodexSteerBarrier[] = [];
    for (const threadId of uniqueThreadIds) {
      const rows = yield* sql<AcceptedBarrierJoinRow>`
        SELECT
          candidate.sequence AS "barrierSequence",
          candidate.intent_sequence AS "barrierIntentSequence",
          candidate.thread_id AS "barrierThreadId",
          candidate.message_id AS "barrierMessageId",
          candidate.activity_id AS "barrierActivityId",
          candidate.accepted_turn_id AS "barrierTurnId",
          candidate.client_correlation_id AS "barrierClientCorrelationId",
          candidate.accepted_at AS "barrierActivityCreatedAt",
          event.sequence AS "eventSequence",
          event.aggregate_kind AS "eventAggregateKind",
          event.stream_id AS "eventThreadId",
          event.event_type AS "eventType",
          event.actor_kind AS "eventActorKind",
          event.payload_json AS "eventPayloadJson",
          intent_event.sequence AS "intentEventSequence",
          intent_event.aggregate_kind AS "intentEventAggregateKind",
          intent_event.stream_id AS "intentEventThreadId",
          intent_event.event_type AS "intentEventType",
          intent_event.actor_kind AS "intentEventActorKind",
          intent_event.occurred_at AS "intentEventOccurredAt",
          intent_event.payload_json AS "intentEventPayloadJson"
        FROM orchestration_pending_codex_steer_acceptances AS candidate
        LEFT JOIN orchestration_events AS event
          ON event.sequence = candidate.sequence
        LEFT JOIN orchestration_events AS intent_event
          ON intent_event.sequence = candidate.intent_sequence
        WHERE candidate.thread_id = ${threadId}
        ORDER BY candidate.sequence ASC
      `;
      for (const row of rows) {
        if (
          !Number.isSafeInteger(row.barrierSequence) ||
          row.barrierSequence < 0 ||
          !Number.isSafeInteger(row.barrierIntentSequence) ||
          row.barrierIntentSequence < 0 ||
          row.barrierIntentSequence >= row.barrierSequence ||
          row.eventSequence !== row.barrierSequence ||
          row.intentEventSequence !== row.barrierIntentSequence ||
          row.barrierThreadId !== threadId ||
          row.eventAggregateKind !== "thread" ||
          row.eventThreadId !== threadId ||
          row.eventType !== "thread.activity-appended" ||
          row.eventActorKind !== "server" ||
          row.intentEventAggregateKind !== "thread" ||
          row.intentEventThreadId !== threadId ||
          (row.intentEventType !== "thread.turn-start-requested" &&
            row.intentEventType !== "thread.turn-steer-requested") ||
          !isAuthenticatedIntentActor(row.intentEventActorKind ?? "") ||
          row.intentEventOccurredAt === null ||
          row.intentEventPayloadJson === null ||
          row.eventPayloadJson === null ||
          row.barrierActivityId === null ||
          row.barrierTurnId === null ||
          row.barrierActivityCreatedAt === null
        ) {
          return yield* new CodexSteerIntentLedgerInvariantError({
            issue: "candidate-event-mismatch",
          });
        }
        const payload = yield* parseEventPayload(row.eventPayloadJson);
        const intentPayload = yield* parseEventPayload(row.intentEventPayloadJson);
        const activity = asObject(payload.activity);
        const activityPayload = asObject(activity?.payload);
        const correlation = activityPayload?.clientCorrelationId;
        if (
          payload.threadId !== threadId ||
          activity === undefined ||
          activityPayload === undefined ||
          activity.kind !== "provider.turn.steer.accepted" ||
          activity.id !== row.barrierActivityId ||
          activity.turnId !== row.barrierTurnId ||
          activity.createdAt !== row.barrierActivityCreatedAt ||
          activityPayload.provider !== "codex" ||
          activityPayload.messageId !== row.barrierMessageId ||
          activityPayload.acceptedTurnId !== row.barrierTurnId ||
          (activityPayload.intentSequence !== row.barrierIntentSequence &&
            !(
              activityPayload.intentSequence === undefined &&
              row.barrierSequence <= legacyCutoffSequence
            )) ||
          intentPayload.threadId !== threadId ||
          intentPayload.messageId !== row.barrierMessageId ||
          intentPayload.createdAt !== row.intentEventOccurredAt ||
          (correlation !== undefined && correlation !== null && typeof correlation !== "string") ||
          (correlation ?? null) !== row.barrierClientCorrelationId
        ) {
          return yield* new CodexSteerIntentLedgerInvariantError({
            issue: "candidate-event-mismatch",
          });
        }
        accepted.push({
          sequence: row.barrierSequence,
          intentSequence: row.barrierIntentSequence,
          intentCreatedAt: row.intentEventOccurredAt,
          threadId,
          activityId: row.barrierActivityId,
          acceptedTurnId: row.barrierTurnId as TurnId,
          clientCorrelationId: row.barrierClientCorrelationId,
          messageId: row.barrierMessageId as MessageId,
          acceptedAt: row.barrierActivityCreatedAt,
        });
      }
    }
    return accepted.toSorted((left, right) => left.sequence - right.sequence);
  });
}

/**
 * Remove one pending acceptance only after the caller has independently
 * verified exact durable processing/recovery evidence. Provider runtime
 * `task.progress` events retain provider actor provenance, so the append
 * trigger deliberately cannot treat their payload as settlement authority.
 * Binding every persisted identity here prevents a stale caller from pruning
 * a different candidate even if the database was manually altered.
 */
export function pruneSettledAcceptedCodexSteerRecoveryCandidate(
  sql: SqlClient.SqlClient,
  candidate: PersistedAcceptedCodexSteerBarrier,
): Effect.Effect<void, SqlError.SqlError> {
  return sql`
    DELETE FROM orchestration_pending_codex_steer_acceptances
    WHERE sequence = ${candidate.sequence}
      AND intent_sequence = ${candidate.intentSequence}
      AND thread_id = ${candidate.threadId}
      AND message_id = ${candidate.messageId}
      AND activity_id = ${candidate.activityId}
      AND accepted_turn_id = ${candidate.acceptedTurnId}
      AND client_correlation_id IS ${candidate.clientCorrelationId}
      AND accepted_at = ${candidate.acceptedAt}
  `.pipe(Effect.asVoid);
}

/**
 * Remove one pre-I/O steer candidate only after the caller has durably
 * recorded exact processing evidence. Every identity column is bound so a
 * delayed ingestion fiber cannot accidentally retire a newer steer for the
 * same thread or message after reconnect/replay reordering.
 */
export function pruneSettledCodexSteerIntent(
  sql: SqlClient.SqlClient,
  candidate: PersistedUnsettledCodexSteerIntent,
): Effect.Effect<void, SqlError.SqlError> {
  return sql`
    DELETE FROM orchestration_unsettled_codex_steer_intents
    WHERE sequence = ${candidate.sequence}
      AND thread_id = ${candidate.threadId}
      AND message_id = ${candidate.messageId}
      AND expected_turn_id IS ${candidate.expectedTurnId}
      AND created_at = ${candidate.createdAt}
  `.pipe(Effect.asVoid);
}

function isCanonicalProcessingSource(source: PersistedCodexSteerProcessingSource): boolean {
  return (
    source.clientCorrelationId === buildCodexSteerClientCorrelationId(source.messageId) &&
    source.taskId === `codex-turn-steer-processing:${source.clientCorrelationId}`
  );
}

/**
 * Retire one accepted candidate only when the canonical provider activity is
 * durably newer than that exact candidate generation. Runtime event replay can
 * resolve an old deterministic command receipt successfully; sequence order
 * prevents that old event from deleting a newer same-MessageId acceptance.
 */
export function pruneAcceptedCodexSteerCandidateAfterDurableProcessing(
  sql: SqlClient.SqlClient,
  candidate: PersistedAcceptedCodexSteerBarrier,
  source: PersistedCodexSteerProcessingSource,
): Effect.Effect<void, SqlError.SqlError> {
  if (
    !isCanonicalProcessingSource(source) ||
    source.createdAt < candidate.intentCreatedAt ||
    source.threadId !== candidate.threadId ||
    source.messageId !== candidate.messageId ||
    source.turnId !== candidate.acceptedTurnId ||
    candidate.clientCorrelationId !== source.clientCorrelationId
  ) {
    return Effect.void;
  }
  const commandId = `provider:codex:${source.threadId}:${source.activityId}:thread-activity-append:${source.activityId}`;
  return sql`
    DELETE FROM orchestration_pending_codex_steer_acceptances
    WHERE sequence = ${candidate.sequence}
      AND intent_sequence = ${candidate.intentSequence}
      AND thread_id = ${candidate.threadId}
      AND message_id = ${candidate.messageId}
      AND activity_id = ${candidate.activityId}
      AND accepted_turn_id = ${candidate.acceptedTurnId}
      AND client_correlation_id = ${source.clientCorrelationId}
      AND accepted_at = ${candidate.acceptedAt}
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS processing_event
        WHERE processing_event.command_id = ${commandId}
          AND processing_event.sequence > ${candidate.intentSequence}
          AND processing_event.aggregate_kind = 'thread'
          AND processing_event.stream_id = ${source.threadId}
          AND processing_event.event_type = 'thread.activity-appended'
          AND processing_event.actor_kind = 'provider'
          AND json_extract(processing_event.payload_json, '$.threadId') = ${source.threadId}
          AND json_extract(processing_event.payload_json, '$.activity.id') = ${source.activityId}
          AND json_extract(processing_event.payload_json, '$.activity.kind') = 'task.progress'
          AND json_extract(processing_event.payload_json, '$.activity.turnId') IS ${source.turnId}
          AND json_extract(processing_event.payload_json, '$.activity.createdAt') =
            ${source.createdAt}
          AND json_extract(processing_event.payload_json, '$.activity.createdAt') >=
            ${candidate.intentCreatedAt}
          AND json_extract(processing_event.payload_json, '$.activity.payload.taskId') =
            ${source.taskId}
          AND json_extract(
            processing_event.payload_json,
            '$.activity.payload.usage.clientCorrelationId'
          ) = ${source.clientCorrelationId}
          AND json_extract(
            processing_event.payload_json,
            '$.activity.payload.usage.messageId'
          ) = ${source.messageId}
        LIMIT 1
      )
  `.pipe(Effect.asVoid);
}

/** Sequence-bound equivalent for a crash-before-provider-I/O steer intent. */
export function pruneCodexSteerIntentAfterDurableProcessing(
  sql: SqlClient.SqlClient,
  candidate: PersistedUnsettledCodexSteerIntent,
  source: PersistedCodexSteerProcessingSource,
): Effect.Effect<void, SqlError.SqlError> {
  if (
    !isCanonicalProcessingSource(source) ||
    source.createdAt < candidate.createdAt ||
    source.threadId !== candidate.threadId ||
    source.messageId !== candidate.messageId
  ) {
    return Effect.void;
  }
  const commandId = `provider:codex:${source.threadId}:${source.activityId}:thread-activity-append:${source.activityId}`;
  return sql`
    DELETE FROM orchestration_unsettled_codex_steer_intents
    WHERE sequence = ${candidate.sequence}
      AND thread_id = ${candidate.threadId}
      AND message_id = ${candidate.messageId}
      AND expected_turn_id IS ${candidate.expectedTurnId}
      AND created_at = ${candidate.createdAt}
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS processing_event
        WHERE processing_event.command_id = ${commandId}
          AND processing_event.sequence > ${candidate.sequence}
          AND processing_event.aggregate_kind = 'thread'
          AND processing_event.stream_id = ${source.threadId}
          AND processing_event.event_type = 'thread.activity-appended'
          AND processing_event.actor_kind = 'provider'
          AND json_extract(processing_event.payload_json, '$.threadId') = ${source.threadId}
          AND json_extract(processing_event.payload_json, '$.activity.id') = ${source.activityId}
          AND json_extract(processing_event.payload_json, '$.activity.kind') = 'task.progress'
          AND json_extract(processing_event.payload_json, '$.activity.turnId') IS ${source.turnId}
          AND json_extract(processing_event.payload_json, '$.activity.createdAt') =
            ${source.createdAt}
          AND json_extract(processing_event.payload_json, '$.activity.createdAt') >=
            ${candidate.createdAt}
          AND json_extract(processing_event.payload_json, '$.activity.payload.taskId') =
            ${source.taskId}
          AND json_extract(
            processing_event.payload_json,
            '$.activity.payload.usage.clientCorrelationId'
          ) = ${source.clientCorrelationId}
          AND json_extract(
            processing_event.payload_json,
            '$.activity.payload.usage.messageId'
          ) = ${source.messageId}
        LIMIT 1
      )
  `.pipe(Effect.asVoid);
}

/**
 * Hydrate each caller-selected active Codex thread and return its validated
 * compact candidates. A real Node event-loop boundary between threads keeps
 * readiness probes, sockets, and provider IPC responsive even if an
 * adversarial database contains many active thread shells.
 */
export function hydrateAndReadUnsettledCodexSteerIntents(
  sql: SqlClient.SqlClient,
  activeCodexThreadIds: ReadonlyArray<ThreadId>,
): Effect.Effect<
  ReadonlyArray<PersistedUnsettledCodexSteerIntent>,
  SqlError.SqlError | CodexSteerIntentLedgerInvariantError
> {
  return Effect.gen(function* () {
    const legacyCutoffSequence = yield* readMigrationCutoff(sql);
    const threadIds = [...new Set(activeCodexThreadIds)];
    for (const [index, threadId] of threadIds.entries()) {
      yield* hydrateLegacyUnsettledCodexSteerIntentsForThread(sql, threadId, legacyCutoffSequence);
      if (index + 1 < threadIds.length) {
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      }
    }
    return yield* readUnsettledCodexSteerIntents(sql, threadIds);
  });
}
