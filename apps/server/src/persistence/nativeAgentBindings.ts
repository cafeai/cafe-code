import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deriveCurrentNativeAgentStarts } from "@cafecode/shared/liveWork";

import type { ProjectionThreadActivity } from "./Services/ProjectionThreadActivities.ts";

/**
 * Bound the additional private witness independently of legacy activity size.
 * The migration applies the same byte admission before hydrating a payload;
 * unsupported oversized rows never acquire native-binding presentation proof.
 */
export const MAX_NATIVE_AGENT_BINDING_PAYLOAD_BYTES = 1_024 * 1_024;
const decodePayloadJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const decodeCreatedAt = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString);

/**
 * Materialize one fully qualified explicit start per native task slot. The
 * caller owns the transaction containing the activity write, so the witness
 * always describes those exact persisted JSON bytes, not a second encoding.
 * Historical turn rows and task-control incarnations remain untouched.
 */
export function upsertNativeAgentBinding(
  sql: SqlClient.SqlClient,
  row: ProjectionThreadActivity,
  payloadJson: string,
  activitySequence: number | null = row.sequence ?? null,
) {
  if (
    row.kind !== "task.started" ||
    row.createdAt.length > 128 ||
    Option.isNone(decodeCreatedAt(row.createdAt)) ||
    Buffer.byteLength(payloadJson, "utf8") > MAX_NATIVE_AGENT_BINDING_PAYLOAD_BYTES
  )
    return Effect.void;
  // Legacy IsoDateTime is a string alias, not date validation. Unsupported
  // clocks remain historical data and cannot abort or mint an ordered witness.
  // Validate the exact stored witness, not an independently mutable input
  // object or a second serialization with potentially different semantics.
  const payload = decodePayloadJson(payloadJson);
  if (Option.isNone(payload)) return Effect.void;
  const start = deriveCurrentNativeAgentStarts([
    {
      id: row.activityId,
      turnId: row.turnId,
      tone: row.tone,
      kind: row.kind,
      summary: row.summary,
      payload: payload.value,
      createdAt: row.createdAt,
      ...(row.sequence === undefined ? {} : { sequence: row.sequence }),
    },
  ])[0];
  if (!start) return Effect.void;
  const { observation } = start;
  return sql`
    INSERT INTO projection_native_agent_bindings(
      thread_id, runtime_id, work_id, turn_id, activity_id,
      sequence_known, sequence, activity_sequence, created_at, payload_json, valid
    )
    SELECT ${row.threadId}, ${observation.runtimeId}, ${observation.workId},
      ${row.turnId}, ${row.activityId}, ${row.sequence === undefined ? 0 : 1},
      ${row.sequence ?? null}, ${activitySequence}, ${row.createdAt}, ${payloadJson}, 1
    WHERE NOT EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${row.threadId}
    )
    ON CONFLICT (thread_id, runtime_id, work_id) DO UPDATE SET
      turn_id = excluded.turn_id, activity_id = excluded.activity_id,
      sequence_known = excluded.sequence_known, sequence = excluded.sequence,
      activity_sequence = excluded.activity_sequence, created_at = excluded.created_at,
      payload_json = excluded.payload_json, valid = 1
    WHERE
      (excluded.sequence_known, COALESCE(excluded.sequence, -1),
        excluded.created_at, excluded.activity_id) >
      (projection_native_agent_bindings.sequence_known,
        COALESCE(projection_native_agent_bindings.sequence, -1),
        projection_native_agent_bindings.created_at, projection_native_agent_bindings.activity_id)
      OR (
        excluded.activity_id = projection_native_agent_bindings.activity_id
        AND excluded.turn_id IS projection_native_agent_bindings.turn_id
        AND excluded.sequence IS projection_native_agent_bindings.sequence
        AND excluded.created_at = projection_native_agent_bindings.created_at
      )
  `.pipe(Effect.asVoid);
}
