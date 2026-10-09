import { ProviderSession } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError, toPersistenceDecodeError } from "../Errors.ts";
import type { ConversationRewindStore } from "../Services/ConversationRewinds.ts";

// Rewind recovery needs the exact runtime/cursor/authority snapshot, not live
// metadata from a query that will have been retired before recovery. Keep one
// durable schema at BOTH boundaries: encoding must never save structured quota
// reports or command catalogs/private configuration commitments, and decoding
// must not rehydrate those fields from older snapshots. Schema's default excess
// property handling strips them without traversing or validating their values.
// All other ProviderSession fields retain their original schema and semantics;
// this changes neither the rewind admission checks nor its native lifecycle.
const DurableProviderSession = ProviderSession.mapFields(
  Struct.omit(["quotaReport", "commandCatalog", "commandCatalogConfigurationKey"]),
);
const DurableProviderSessionJson = Schema.fromJsonString(DurableProviderSession);

const StoredRewind = Schema.Struct({
  operationId: Schema.String,
  phase: Schema.Literals([
    "preparing",
    "prepared",
    "switching",
    "committed",
    "aborted",
    "finished",
    "refused",
  ]),
  runtimeId: Schema.String,
  expectedControlSequence: Schema.Number,
  retainedTurnCount: Schema.Number,
  numTurns: Schema.Number,
  firstRemovedTurnId: Schema.String,
  original: DurableProviderSessionJson,
  candidate: Schema.NullOr(DurableProviderSessionJson),
});
const encodeSession = Schema.encodeSync(DurableProviderSessionJson);
const decodeRewind = Schema.decodeUnknownEffect(StoredRewind);
const isProviderSession = Schema.is(ProviderSession);

/** Captures the already-owned SQLite client. Every state/cursor switch is a
 * single transaction; no native process or filesystem I/O occurs inside it. */
export function makeConversationRewindStore(sql: SqlClient.SqlClient): ConversationRewindStore {
  const classifyEvent: ConversationRewindStore["classifyEvent"] = (event) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT r.phase,r.runtime_id AS retired,
        r.provider_instance_id AS reserved_instance,
        json_extract(r.original_session_json,'$.provider') AS original_provider,
        json_extract(s.runtime_payload_json,'$.subagentRuntimeId') AS current,
        s.provider_instance_id AS instance,s.provider_name AS provider
      FROM provider_conversation_rewinds r LEFT JOIN provider_session_runtime s ON s.thread_id=r.thread_id
      WHERE r.thread_id=${event.threadId}`;
      const row = rows[0];
      if (row === undefined) return "accepted" as const;
      const matchesCurrent =
        event.subagentRuntimeId !== undefined &&
        event.subagentRuntimeId === row.current &&
        event.providerInstanceId === row.instance &&
        event.provider === row.provider;
      const matchesOriginal =
        event.subagentRuntimeId !== undefined &&
        event.subagentRuntimeId === row.retired &&
        event.providerInstanceId === row.reserved_instance &&
        event.provider === row.original_provider;
      // Preparation can still refuse an active descendant without changing any
      // files or retiring the native source. Project its exact original events
      // now: holding one frame while another chat advances the global replay
      // cursor would silently lose legitimate history after such a refusal.
      // Ordinary runtime-binding writes remain fenced by the SQL triggers.
      if (row.phase === "preparing")
        return matchesCurrent && matchesOriginal ? ("accepted" as const) : ("pending" as const);
      if (row.phase === "refused")
        return matchesCurrent ? ("accepted" as const) : ("retired" as const);
      // Reaching prepared proves source retirement. The checkpoint coordinator
      // drains any earlier accepted ingestion before restoring files; old frames
      // after this point cannot recover authority, even if compensation later
      // resumes the original history under a fresh runtime generation.
      if (row.phase === "prepared" || row.phase === "switching" || row.phase === "committed") {
        return matchesOriginal ? ("retired" as const) : ("pending" as const);
      }
      if (row.phase === "aborted" || row.phase === "finished") {
        return matchesCurrent && event.subagentRuntimeId !== row.retired
          ? ("accepted" as const)
          : ("retired" as const);
      }
      return "pending" as const;
    }).pipe(Effect.mapError(toPersistenceSqlError("ConversationRewinds.classifyEvent")));
  const read: ConversationRewindStore["read"] = (threadId) =>
    Effect.gen(function* () {
      const rows = yield* sql`
      SELECT operation_id AS "operationId", phase, runtime_id AS "runtimeId",
        expected_control_sequence AS "expectedControlSequence", retained_turn_count AS "retainedTurnCount",
        removed_turn_count AS "numTurns", first_removed_turn_id AS "firstRemovedTurnId",
        original_session_json AS original, candidate_session_json AS candidate
      FROM provider_conversation_rewinds WHERE thread_id = ${threadId}
    `.pipe(Effect.mapError(toPersistenceSqlError("ConversationRewinds.read")));
      return rows[0] === undefined
        ? null
        : yield* decodeRewind(rows[0]).pipe(
            Effect.mapError(toPersistenceDecodeError("ConversationRewinds.read")),
          );
    });
  return {
    classifyEvent,
    read,
    reserve: (input, original) =>
      Effect.gen(function* () {
        if (
          !isProviderSession(original) ||
          original.threadId !== input.threadId ||
          original.status !== "ready" ||
          original.activeTurnId !== undefined ||
          !original.subagentRuntimeId ||
          !original.providerInstanceId
        )
          return false;
        const encoded = encodeSession(original);
        if (Buffer.byteLength(encoded, "utf8") > 1024 * 1024) return false;
        const rows = yield* sql`
        INSERT INTO provider_conversation_rewinds
          (thread_id,operation_id,phase,provider_instance_id,runtime_id,expected_control_sequence,
            retained_turn_count,removed_turn_count,first_removed_turn_id,original_session_json,candidate_session_json)
        SELECT r.thread_id,${input.operationId},'preparing',r.provider_instance_id,${original.subagentRuntimeId},
          ${input.expectedControlSequence},${input.retainedTurnCount},${input.numTurns},${input.firstRemovedTurnId},${encoded},NULL
        FROM provider_session_runtime r
        WHERE r.thread_id = ${input.threadId} AND r.provider_name = ${original.provider}
          AND r.provider_instance_id = ${original.providerInstanceId}
          AND json_extract(r.runtime_payload_json,'$.subagentRuntimeId') = ${original.subagentRuntimeId}
          AND r.resume_cursor_json IS ${JSON.stringify(original.resumeCursor ?? null)}
          AND COALESCE((SELECT MAX(sequence) FROM orchestration_runtime_recovery_controls
            WHERE thread_id = r.thread_id),0) = ${input.expectedControlSequence}
        ON CONFLICT(thread_id) DO UPDATE SET
          operation_id=excluded.operation_id,phase=excluded.phase,provider_instance_id=excluded.provider_instance_id,
          runtime_id=excluded.runtime_id,expected_control_sequence=excluded.expected_control_sequence,
          retained_turn_count=excluded.retained_turn_count,original_session_json=excluded.original_session_json,
          removed_turn_count=excluded.removed_turn_count,first_removed_turn_id=excluded.first_removed_turn_id,
          candidate_session_json=NULL
        WHERE provider_conversation_rewinds.phase IN ('aborted','finished','refused')
        RETURNING thread_id
      `;
        return rows.length === 1;
      }).pipe(Effect.mapError(toPersistenceSqlError("ConversationRewinds.reserve"))),
    prepared: (input, candidate) =>
      Effect.gen(function* () {
        const prior = yield* read(input.threadId);
        if (
          !prior ||
          prior.operationId !== input.operationId ||
          prior.phase !== "preparing" ||
          !isProviderSession(candidate) ||
          candidate.status !== "closed" ||
          candidate.threadId !== prior.original.threadId ||
          candidate.provider !== prior.original.provider ||
          candidate.providerInstanceId !== prior.original.providerInstanceId ||
          candidate.cwd !== prior.original.cwd ||
          candidate.runtimeMode !== prior.original.runtimeMode ||
          candidate.activeTurnId !== undefined ||
          candidate.subagentRuntimeId !== undefined
        )
          return false;
        const encoded = encodeSession(candidate);
        if (Buffer.byteLength(encoded, "utf8") > 1024 * 1024) return false;
        const rows = yield* sql`
        UPDATE provider_conversation_rewinds SET phase='prepared',candidate_session_json=${encoded}
        WHERE thread_id=${input.threadId} AND operation_id=${input.operationId} AND phase='preparing'
        RETURNING thread_id
      `;
        return rows.length === 1;
      }).pipe(Effect.mapError(toPersistenceSqlError("ConversationRewinds.prepared"))),
    commit: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ candidate: string }>`
        UPDATE provider_conversation_rewinds SET phase='switching'
        WHERE thread_id=${input.threadId} AND operation_id=${input.operationId} AND phase='prepared'
          AND candidate_session_json IS NOT NULL
          AND expected_control_sequence = COALESCE((SELECT MAX(sequence)
            FROM orchestration_runtime_recovery_controls WHERE thread_id=${input.threadId}),0)
        RETURNING candidate_session_json AS candidate
      `;
            if (rows[0] === undefined) return false;
            // Session JSON is produced only by the bounded decoder above. Extracting
            // it in SQL keeps the native cursor and admission fence indivisible.
            yield* sql`
        UPDATE provider_session_runtime SET
          status='stopped', resume_cursor_json=json_extract(${rows[0].candidate},'$.resumeCursor'),
          runtime_payload_json=json_patch(COALESCE(runtime_payload_json,'{}'),
            json_object('subagentRuntimeId',NULL,'activeTurnId',NULL,'lastRuntimeEvent','provider.conversation.rewind'))
        WHERE thread_id=${input.threadId}
      `;
            yield* sql`UPDATE provider_conversation_rewinds SET phase='committed'
        WHERE thread_id=${input.threadId} AND operation_id=${input.operationId} AND phase='switching'`;
            return true;
          }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("ConversationRewinds.commit"))),
    finish: (input) =>
      Effect.gen(function* () {
        if (input.outcome === "aborted") {
          const rows = yield* sql`UPDATE provider_conversation_rewinds SET phase='aborted'
          WHERE thread_id=${input.threadId} AND operation_id=${input.operationId} AND phase='prepared'
          RETURNING thread_id`;
          return rows.length === 1;
        }
        if (!input.completionCommandId) return false;
        const rows = yield* sql`UPDATE provider_conversation_rewinds SET phase='finished'
        WHERE thread_id=${input.threadId} AND operation_id=${input.operationId} AND phase='committed'
          AND EXISTS (SELECT 1 FROM orchestration_events e JOIN orchestration_command_receipts c
            ON c.command_id=e.command_id
            WHERE e.stream_id=${input.threadId} AND e.command_id=${input.completionCommandId}
              AND e.event_type='thread.reverted' AND e.sequence > expected_control_sequence
              AND e.aggregate_kind='thread' AND e.actor_kind='server'
              AND json_extract(e.payload_json,'$.turnCount') = retained_turn_count
              AND c.status='accepted' AND c.result_sequence=e.sequence
              AND c.aggregate_kind='thread' AND c.aggregate_id=${input.threadId})
        RETURNING thread_id`;
        return rows.length === 1;
      }).pipe(Effect.mapError(toPersistenceSqlError("ConversationRewinds.finish"))),
    refuse: (input) =>
      sql`UPDATE provider_conversation_rewinds SET phase='refused'
      WHERE thread_id=${input.threadId} AND operation_id=${input.operationId} AND phase='preparing'
      RETURNING thread_id`.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("ConversationRewinds.refuse")),
      ),
    acceptsEvent: (event) =>
      classifyEvent(event).pipe(Effect.map((result) => result === "accepted")),
  };
}
