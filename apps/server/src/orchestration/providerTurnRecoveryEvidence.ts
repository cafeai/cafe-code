import { ThreadId, TurnId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type PersistenceDecodeError,
  type PersistenceSqlError,
} from "../persistence/Errors.ts";

/**
 * The terminal projection can have two superficially identical causes while a
 * provider still owns the turn:
 *
 * - a user-issued Stop whose interrupt must be retried; or
 * - Cafe's own orphan repair, which must be undone when live ownership is
 *   subsequently proven.
 *
 * Keep this decision bound to the durable event stream. Process-local caches
 * disappear across restarts and timestamps are not a safe ordering primitive
 * when multiple Cafe processes briefly share one state directory.
 */
export type ProviderTurnRecoveryEvidence = "none" | "interrupt-requested" | "orphaned-active-turn";

const ProviderTurnRecoveryEvidenceRow = Schema.Struct({
  evidence: Schema.Literals(["interrupt-requested", "orphaned-active-turn"]),
});

const ProviderTurnRecoveryEvidenceRequest = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});

function toPersistenceError(
  operation: string,
): (cause: unknown) => PersistenceSqlError | PersistenceDecodeError {
  return (cause) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(operation)(cause)
      : toPersistenceSqlError(operation)(cause);
}

/**
 * Read only the newest cancellation/recovery barrier for one turn. The query
 * is bounded to one row and uses the indexed thread stream before inspecting
 * JSON payload fields, so recovery cost does not grow with a 16-hour turn's
 * message or activity count.
 */
export const makeProviderTurnRecoveryEvidenceReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readLatestEvidence = SqlSchema.findAll({
    Request: ProviderTurnRecoveryEvidenceRequest,
    Result: ProviderTurnRecoveryEvidenceRow,
    execute: (request) => sql`
      SELECT
        CASE
          WHEN event_type = 'thread.turn-interrupt-requested'
            THEN 'interrupt-requested'
          ELSE 'orphaned-active-turn'
        END AS evidence
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${request.threadId}
        AND (
          (
            event_type = 'thread.turn-interrupt-requested'
            AND (
              json_extract(payload_json, '$.turnId') = ${request.turnId}
              OR json_type(payload_json, '$.turnId') IS NULL
            )
          )
          OR (
            event_type = 'thread.activity-appended'
            AND actor_kind = 'server'
            AND json_extract(payload_json, '$.activity.payload.recovery') = 'orphaned-active-turn'
            AND json_extract(payload_json, '$.activity.turnId') = ${request.turnId}
          )
        )
      ORDER BY sequence DESC
      LIMIT 1
    `,
  });

  return Effect.fn("readProviderTurnRecoveryEvidence")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) {
    const rows = yield* readLatestEvidence(input).pipe(
      Effect.mapError(toPersistenceError("ProviderTurnRecoveryEvidence.readLatest")),
    );
    return rows[0]?.evidence ?? "none";
  });
});
