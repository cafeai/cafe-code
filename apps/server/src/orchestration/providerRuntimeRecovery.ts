import { createHash } from "node:crypto";
import type {
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  ThreadTurnRuntimeRecovery,
  TurnId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../persistence/Errors.ts";

export interface RuntimeRecoveryBarrierInput extends ThreadTurnRuntimeRecovery {
  readonly threadId: ThreadId;
  /**
   * Present only for the reactor's second check, after command admission. The
   * exact server-authored start intent is authenticated before it is exempted
   * from the later-start barrier. Arbitrary sequence exemptions are unsafe.
   */
  readonly recoveryIntentSequence?: number;
}

// The legacy ownership-loss path retains its bounded transcript window. The
// transient path instead uses the append-time intent/control indexes below;
// no automatic recovery path may scan arbitrary old transcript JSON on the
// synchronous SQLite event loop.
const MAX_RECOVERY_SUFFIX_EVENTS = 256;
// This separate, append-time ledger contains controls only, never streaming
// deltas or synthetic recovery starts. It keeps the last explicit user intent
// available through arbitrarily long turns and repeated automatic retries.
const MAX_PRIOR_RECOVERY_CONTROLS = 64;

export const buildCodexTransientFailureMarkerPayload = (input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly subagentRuntimeId: SubagentRuntimeId;
  readonly sessionUpdatedAt: string;
}) => ({ recovery: "codex-transient-root-failed", ...input });

/** Saturate bookkeeping, not retries: there is deliberately no attempt limit. */
export const saturateRuntimeRecoveryAttempt = (attempt: number) =>
  Math.min(30, Math.max(0, Number.isSafeInteger(attempt) ? attempt : 30));

/** Exponential backoff with 75–100% jitter always waits and caps at 60 seconds. */
export const codexTransientRecoveryDelayMs = (attempt: number, jitter: number) => {
  const boundedJitter = Number.isFinite(jitter) ? Math.min(1, Math.max(0, jitter)) : 1;
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(saturateRuntimeRecoveryAttempt(attempt), 6));
  return Math.ceil(base * (0.75 + 0.25 * boundedJitter));
};

// Only server receipts are authoritative. Hashing a turn makes the identity
// fixed-size and keeps native identifiers out of public activity/command IDs.
export const codexTransientAcceptanceCommandId = (threadId: ThreadId, turnId: TurnId) =>
  `server:codex-transient-accepted:${createHash("sha256")
    .update(JSON.stringify(["cafe-codex-transient-accepted-v1", threadId, turnId]))
    .digest("hex")}`;

export type CodexTransientRecoveryChain =
  | {
      readonly status: "fresh";
      readonly chainSourceEventSequence: number;
      readonly retryAttempt: 0;
      readonly continuationOrdinal: 1;
    }
  | {
      readonly status: "accepted";
      readonly chainSourceEventSequence: number;
      readonly retryAttempt: number;
      readonly continuationOrdinal?: number;
      readonly continuationOrdinalLowerBound?: true;
    }
  | { readonly status: "pending" };

/**
 * A failed native turn is a new retry generation only after Cafe durably knows
 * that the preceding generation was accepted. The append-time index outlives
 * streamed messages and includes uncertain submissions even when turn.started
 * was lost. Source events, the one-use owner claim and the exact ACK receipt
 * are joined back together; projections and provider warnings confer no grant.
 * Fresh human input supersedes an old chain through the existing control index.
 */
export const makeCodexTransientRecoveryChainReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly sourceEventSequence: number;
    readonly providerInstanceId: ProviderInstanceId;
    readonly subagentRuntimeId: SubagentRuntimeId;
  }) =>
    Effect.gen(function* () {
      const intents = yield* sql<{
        readonly sequence: number;
        readonly chainSource: number;
        readonly retryAttempt: number;
        readonly instanceId: string;
        readonly runtimeId: string;
        readonly continuationOrdinal: unknown;
        readonly continuationOrdinalType: string | null;
        readonly continuationOrdinalLowerBoundType: string | null;
      }>`
      WITH latest_control AS (
        SELECT COALESCE(MAX(sequence), 0) AS sequence
        FROM orchestration_runtime_recovery_controls
          INDEXED BY idx_runtime_recovery_controls_thread_sequence
        WHERE thread_id = ${input.threadId} AND sequence < ${input.sourceEventSequence}
      ), latest_intent AS (
        SELECT sequence FROM orchestration_codex_transient_recovery_intents
          INDEXED BY idx_codex_transient_recovery_intents_thread_kind_sequence
        WHERE thread_id = ${input.threadId}
          AND source_kind = 'intent'
          AND sequence > (SELECT sequence FROM latest_control)
        ORDER BY sequence DESC LIMIT 1
      )
      SELECT event.sequence,
        json_extract(event.payload_json, '$.runtimeRecovery.codexTransientFailure.chainSourceEventSequence') AS chainSource,
        json_extract(event.payload_json, '$.runtimeRecovery.codexTransientFailure.retryAttempt') AS retryAttempt,
        json_extract(event.payload_json, '$.runtimeRecovery.codexTransientFailure.providerInstanceId') AS instanceId,
        json_extract(event.payload_json, '$.runtimeRecovery.codexTransientFailure.subagentRuntimeId') AS runtimeId,
        CASE WHEN json_type(event.payload_json, '$.runtimeRecovery.codexTransientFailure.continuationOrdinal') = 'integer'
          AND json_extract(event.payload_json, '$.runtimeRecovery.codexTransientFailure.continuationOrdinal') BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
          THEN json_extract(event.payload_json, '$.runtimeRecovery.codexTransientFailure.continuationOrdinal')
          ELSE NULL END AS continuationOrdinal,
        json_type(event.payload_json, '$.runtimeRecovery.codexTransientFailure.continuationOrdinal') AS continuationOrdinalType,
        json_type(event.payload_json, '$.runtimeRecovery.codexTransientFailure.continuationOrdinalLowerBound') AS continuationOrdinalLowerBoundType
      FROM latest_intent JOIN orchestration_events AS event ON event.sequence = latest_intent.sequence
      WHERE event.aggregate_kind = 'thread' AND event.stream_id = ${input.threadId}
        AND event.actor_kind = 'server' AND event.event_type = 'thread.turn-start-requested'
        AND json_extract(event.payload_json, '$.threadId') = ${input.threadId}
    `.pipe(Effect.mapError(toPersistenceSqlError("CodexTransientRecoveryChain.intent")));
      const intent = intents[0];
      if (intent === undefined)
        return {
          status: "fresh",
          chainSourceEventSequence: input.sourceEventSequence,
          retryAttempt: 0,
          continuationOrdinal: 1,
        } as const;
      if (
        intent.instanceId !== input.providerInstanceId ||
        intent.runtimeId !== input.subagentRuntimeId ||
        !Number.isSafeInteger(intent.chainSource) ||
        intent.chainSource <= 0 ||
        intent.chainSource > intent.sequence ||
        !Number.isSafeInteger(intent.retryAttempt) ||
        intent.retryAttempt < 0 ||
        intent.retryAttempt > 30
      ) {
        return { status: "pending" } as const;
      }
      const receipts = yield* sql<{ readonly accepted: number }>`
      SELECT 1 AS accepted FROM orchestration_events AS receipt
      JOIN orchestration_events AS attempt
        ON attempt.command_id = ${`server:runtime-recovery-attempt:${intent.sequence}`}
      WHERE receipt.command_id = ${codexTransientAcceptanceCommandId(input.threadId, input.turnId)}
        AND receipt.aggregate_kind = 'thread' AND receipt.stream_id = ${input.threadId}
        AND receipt.actor_kind = 'server' AND receipt.event_type = 'thread.activity-appended'
        AND json_extract(receipt.payload_json, '$.activity.kind') = 'runtime.warning'
        AND json_extract(receipt.payload_json, '$.activity.turnId') = ${input.turnId}
        AND json_extract(receipt.payload_json, '$.activity.payload.recovery') = 'codex-transient-continuation-accepted'
        AND json_extract(receipt.payload_json, '$.activity.payload.recoveryIntentSequence') = ${intent.sequence}
        AND json_extract(receipt.payload_json, '$.activity.payload.providerInstanceId') = ${input.providerInstanceId}
        AND json_extract(receipt.payload_json, '$.activity.payload.subagentRuntimeId') = ${input.subagentRuntimeId}
        AND attempt.aggregate_kind = 'thread' AND attempt.stream_id = ${input.threadId}
        AND attempt.actor_kind = 'server' AND attempt.event_type = 'thread.activity-appended'
        AND json_extract(attempt.payload_json, '$.activity.payload.recovery') = 'codex-transient-continuation-attempted'
        AND json_type(attempt.payload_json, '$.activity.payload.attemptOwnerId') = 'text'
        AND json_extract(receipt.payload_json, '$.activity.payload.attemptOwnerId') =
          json_extract(attempt.payload_json, '$.activity.payload.attemptOwnerId')
      LIMIT 1
    `.pipe(Effect.mapError(toPersistenceSqlError("CodexTransientRecoveryChain.receipt")));
      // Advance display bookkeeping only from the same authenticated acceptance
      // used by the existing retry chain. This O(1) ledger lookup avoids counting
      // arbitrary transcript rows or trusting provider warning fractions. Missing
      // legacy metadata can be reconstructed below the old exponent ceiling; at
      // that ceiling only a lower bound is knowable. Present malformed metadata
      // is neither authority nor permission to fabricate a legacy count.
      const qualifiedLowerBound =
        intent.continuationOrdinalLowerBoundType === null ||
        intent.continuationOrdinalLowerBoundType === "true";
      const previousOrdinal = intent.continuationOrdinal;
      const nextOrdinal = !qualifiedLowerBound
        ? {}
        : intent.continuationOrdinalType === null
          ? intent.continuationOrdinalLowerBoundType !== null
            ? {}
            : {
                continuationOrdinal: intent.retryAttempt + 2,
                ...(intent.retryAttempt === 30
                  ? { continuationOrdinalLowerBound: true as const }
                  : {}),
              }
          : intent.continuationOrdinalType === "integer" &&
              typeof previousOrdinal === "number" &&
              Number.isSafeInteger(previousOrdinal) &&
              previousOrdinal > 0
            ? {
                continuationOrdinal: Math.min(Number.MAX_SAFE_INTEGER, previousOrdinal + 1),
                ...(intent.continuationOrdinalLowerBoundType === "true" ||
                previousOrdinal === Number.MAX_SAFE_INTEGER
                  ? { continuationOrdinalLowerBound: true as const }
                  : {}),
              }
            : {};
      return receipts[0]?.accepted === 1
        ? ({
            status: "accepted",
            chainSourceEventSequence: intent.chainSource,
            retryAttempt: saturateRuntimeRecoveryAttempt(intent.retryAttempt + 1),
            ...nextOrdinal,
          } as const)
        : ({ status: "pending" } as const);
    }).pipe(Effect.map((chain): CodexTransientRecoveryChain => chain));
});

/**
 * Build the shared admission/pre-provider-I/O guard. A projection alone cannot
 * establish user intent: Stop is durable before its provider side effect runs,
 * and a Stop accepted after the loss may leave an already-stopped row intact.
 * Authenticate the immutable loss observation and inspect subsequent controls
 * in one SQL snapshot. Every failure is closed; this never authorizes recovery
 * from a provider-authored warning, timestamps, or a caller-supplied turn id.
 * The prior-control check also covers Stop/settings accepted between recording
 * the stopped session and recording the loss warning. Only fresh explicit
 * input after the ledger completeness fence can renew continuation consent.
 * Scheduled starts remain authentic control barriers but are not new human
 * continuation consent: an uncertain scheduled attempt belongs to its run
 * ledger and must never become an automatic paid recovery prompt here.
 */
export const makeRuntimeRecoveryBarrierReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (input: RuntimeRecoveryBarrierInput) =>
    Effect.gen(function* () {
      const { sourceEventSequence, threadId, turnId, sessionUpdatedAt } = input;
      const transient = input.codexTransientFailure;
      const chainSourceSequence = transient?.chainSourceEventSequence ?? sourceEventSequence;
      const markerKind =
        transient === undefined ? "provider-runtime-ownership-lost" : "codex-transient-root-failed";
      const recoveryIntentSequence = input.recoveryIntentSequence ?? null;
      if (
        !Number.isSafeInteger(sourceEventSequence) ||
        sourceEventSequence <= 0 ||
        !Number.isSafeInteger(chainSourceSequence) ||
        chainSourceSequence <= 0 ||
        chainSourceSequence > sourceEventSequence ||
        (transient !== undefined &&
          (!Number.isSafeInteger(transient.retryAttempt) ||
            transient.retryAttempt < 0 ||
            transient.retryAttempt > 30)) ||
        (recoveryIntentSequence !== null &&
          (!Number.isSafeInteger(recoveryIntentSequence) ||
            recoveryIntentSequence <= sourceEventSequence))
      ) {
        return false;
      }
      const rows = yield* sql<{ readonly allowed: number }>`
        WITH exact_loss AS (
          SELECT 1 FROM orchestration_events
          WHERE sequence = ${sourceEventSequence}
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND event_type = 'thread.activity-appended'
            AND actor_kind = 'server'
            AND json_extract(payload_json, '$.threadId') = ${threadId}
            AND json_extract(payload_json, '$.activity.kind') = 'runtime.warning'
            AND json_extract(payload_json, '$.activity.turnId') = ${turnId}
            AND json_extract(payload_json, '$.activity.payload.recovery') = ${markerKind}
            AND json_extract(payload_json, '$.activity.payload.sessionUpdatedAt') = ${sessionUpdatedAt}
            AND (${transient === undefined ? 1 : 0} = 1 OR (
              json_extract(payload_json, '$.activity.payload.providerInstanceId') = ${transient?.providerInstanceId ?? null}
              AND json_extract(payload_json, '$.activity.payload.subagentRuntimeId') = ${transient?.subagentRuntimeId ?? null}
            ))
          LIMIT 1
        ), prior_control_candidates AS MATERIALIZED (
          SELECT sequence, thread_id, event_type, turn_id
          FROM orchestration_runtime_recovery_controls
            INDEXED BY idx_runtime_recovery_controls_thread_sequence
          WHERE thread_id = ${threadId} AND sequence <= ${sourceEventSequence}
            AND sequence >= (
              SELECT indexed_from_sequence FROM orchestration_runtime_recovery_control_state
              WHERE singleton = 1
            )
          ORDER BY sequence DESC
          LIMIT ${MAX_PRIOR_RECOVERY_CONTROLS}
        ), authenticated_prior_controls AS MATERIALIZED (
          SELECT candidate.sequence, candidate.event_type, candidate.turn_id,
            CASE WHEN json_type(event.payload_json, '$.scheduledFollowUp') IS NOT NULL
              THEN 1 ELSE 0 END AS scheduled_followup
          FROM prior_control_candidates AS candidate
          CROSS JOIN orchestration_events AS event ON event.sequence = candidate.sequence
          WHERE event.aggregate_kind = 'thread'
            AND event.stream_id = candidate.thread_id
            AND event.event_type = candidate.event_type
            AND event.actor_kind IN ('client', 'server')
            AND json_extract(event.payload_json, '$.threadId') = candidate.thread_id
            AND (
              (event.event_type IN ('thread.turn-start-requested', 'thread.turn-steer-requested')
                AND candidate.turn_id IS NULL
                AND json_extract(event.payload_json, '$.createdAt') = event.occurred_at
                AND json_type(event.payload_json, '$.messageId') = 'text'
                AND json_type(event.payload_json, '$.runtimeRecovery') IS NULL
                AND json_type(event.payload_json, '$.terminalSteerRecovery') IS NULL)
              OR (event.event_type = 'thread.session-stop-requested' AND candidate.turn_id IS NULL
                AND json_extract(event.payload_json, '$.createdAt') = event.occurred_at)
              OR (event.event_type = 'thread.turn-interrupt-requested'
                AND json_extract(event.payload_json, '$.createdAt') = event.occurred_at
                AND json_extract(event.payload_json, '$.turnId') IS candidate.turn_id)
              OR (event.event_type = 'thread.meta-updated' AND candidate.turn_id IS NULL AND (
                json_type(event.payload_json, '$.modelSelection') IS NOT NULL
                OR json_type(event.payload_json, '$.projectId') IS NOT NULL
                OR json_type(event.payload_json, '$.branch') IS NOT NULL
                OR json_type(event.payload_json, '$.worktreePath') IS NOT NULL
              ))
              OR (event.event_type IN (
                'thread.archived', 'thread.deleted',
                'thread.runtime-mode-set', 'thread.interaction-mode-set',
                'thread.checkpoint-revert-requested', 'thread.reverted'
              ) AND candidate.turn_id IS NULL)
            )
        ), latest_prior_control AS (
          SELECT event_type, scheduled_followup FROM authenticated_prior_controls
          WHERE event_type <> 'thread.turn-interrupt-requested'
            OR turn_id IS NULL OR turn_id = ${turnId}
          ORDER BY sequence DESC LIMIT 1
        ), exact_recovery_intent AS (
          SELECT 1 FROM orchestration_events
          WHERE sequence = ${recoveryIntentSequence}
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND event_type = 'thread.turn-start-requested'
            AND actor_kind = 'server'
            AND json_extract(payload_json, '$.threadId') = ${threadId}
            AND json_extract(payload_json, '$.runtimeRecovery.sourceEventSequence') = ${sourceEventSequence}
            AND json_extract(payload_json, '$.runtimeRecovery.turnId') = ${turnId}
            AND json_extract(payload_json, '$.runtimeRecovery.sessionUpdatedAt') = ${sessionUpdatedAt}
            AND (${transient === undefined ? 1 : 0} = 1 OR (
              json_extract(payload_json, '$.runtimeRecovery.codexTransientFailure.providerInstanceId') = ${transient?.providerInstanceId ?? null}
              AND json_extract(payload_json, '$.runtimeRecovery.codexTransientFailure.subagentRuntimeId') = ${transient?.subagentRuntimeId ?? null}
              AND json_extract(payload_json, '$.runtimeRecovery.codexTransientFailure.chainSourceEventSequence') = ${chainSourceSequence}
              AND json_extract(payload_json, '$.runtimeRecovery.codexTransientFailure.retryAttempt') = ${transient?.retryAttempt ?? null}
            ))
          LIMIT 1
        ), later_events AS MATERIALIZED (
          SELECT sequence, event_type, actor_kind,
            CASE WHEN event_type = 'thread.meta-updated' THEN (
              json_type(payload_json, '$.modelSelection') IS NOT NULL
              OR json_type(payload_json, '$.projectId') IS NOT NULL
              OR json_type(payload_json, '$.branch') IS NOT NULL
              OR json_type(payload_json, '$.worktreePath') IS NOT NULL
            ) ELSE 0 END AS execution_meta_changed
          FROM orchestration_events INDEXED BY idx_orch_events_stream_sequence
          WHERE aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND sequence > ${sourceEventSequence}
          ORDER BY sequence ASC
          LIMIT ${MAX_RECOVERY_SUFFIX_EVENTS + 1}
        )
        SELECT (
          EXISTS (SELECT 1 FROM exact_loss)
          AND EXISTS (
            SELECT 1 FROM orchestration_runtime_recovery_control_state
            WHERE singleton = 1 AND indexed_from_sequence <= ${sourceEventSequence}
          )
          AND (SELECT COUNT(*) FROM prior_control_candidates) =
            (SELECT COUNT(*) FROM authenticated_prior_controls)
          AND EXISTS (
            SELECT 1 FROM latest_prior_control
            WHERE event_type IN ('thread.turn-start-requested', 'thread.turn-steer-requested')
              AND scheduled_followup = 0
          )
          AND (${recoveryIntentSequence} IS NULL OR EXISTS (SELECT 1 FROM exact_recovery_intent))
          AND (${transient === undefined ? 1 : 0} = 0 OR ((SELECT COUNT(*) FROM later_events) <= ${MAX_RECOVERY_SUFFIX_EVENTS}
          AND NOT EXISTS (
            SELECT 1 FROM later_events
            WHERE actor_kind IN ('client', 'server')
              AND (event_type <> 'thread.meta-updated' OR execution_meta_changed = 1)
              AND event_type IN (
                'thread.turn-start-requested',
                'thread.turn-steer-requested',
                'thread.turn-interrupt-requested',
                'thread.session-stop-requested',
                'thread.archived',
                'thread.deleted',
                'thread.meta-updated',
                'thread.runtime-mode-set',
                'thread.interaction-mode-set',
                'thread.checkpoint-revert-requested',
                'thread.reverted'
              )
              AND (${recoveryIntentSequence} IS NULL OR sequence <> ${recoveryIntentSequence})
          )))
          AND (${transient === undefined ? 1 : 0} = 1 OR NOT EXISTS (
            SELECT 1 FROM orchestration_runtime_recovery_controls
              INDEXED BY idx_runtime_recovery_controls_thread_sequence
            WHERE thread_id = ${threadId} AND sequence > ${chainSourceSequence}
          ))
        ) AS allowed
      `.pipe(Effect.mapError(toPersistenceSqlError("RuntimeRecoveryBarrier.read")));
      return rows[0]?.allowed === 1;
    });
});
