import type { ThreadId, ThreadTurnRuntimeRecovery } from "@cafecode/contracts";
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

// The loss marker is recent in the normal path. Do not scan an arbitrarily old
// transcript on node:sqlite's synchronous event loop: an old/busy suffix is
// inconclusive and therefore denies unattended recovery. The stream-sequence
// index makes this a bounded range read independent of other busy threads.
const MAX_RECOVERY_SUFFIX_EVENTS = 256;
// This separate, append-time ledger contains controls only, never streaming
// deltas or synthetic recovery starts. It keeps the last explicit user intent
// available through arbitrarily long turns and repeated automatic retries.
const MAX_PRIOR_RECOVERY_CONTROLS = 64;

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
 */
export const makeRuntimeRecoveryBarrierReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (input: RuntimeRecoveryBarrierInput) =>
    Effect.gen(function* () {
      const { sourceEventSequence, threadId, turnId, sessionUpdatedAt } = input;
      const recoveryIntentSequence = input.recoveryIntentSequence ?? null;
      if (
        !Number.isSafeInteger(sourceEventSequence) ||
        sourceEventSequence <= 0 ||
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
            AND json_extract(payload_json, '$.activity.payload.recovery') = 'provider-runtime-ownership-lost'
            AND json_extract(payload_json, '$.activity.payload.sessionUpdatedAt') = ${sessionUpdatedAt}
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
          SELECT candidate.sequence, candidate.event_type, candidate.turn_id
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
          SELECT event_type FROM authenticated_prior_controls
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
          )
          AND (${recoveryIntentSequence} IS NULL OR EXISTS (SELECT 1 FROM exact_recovery_intent))
          AND (SELECT COUNT(*) FROM later_events) <= ${MAX_RECOVERY_SUFFIX_EVENTS}
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
          )
        ) AS allowed
      `.pipe(Effect.mapError(toPersistenceSqlError("RuntimeRecoveryBarrier.read")));
      return rows[0]?.allowed === 1;
    });
});
