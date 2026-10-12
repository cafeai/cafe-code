import type { ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The existing canonical transaction copies references, never producer,
 * session, viewer-ticket or native action authority. */
export const copyVisualizationHistory = (
  sql: SqlClient.SqlClient,
  input: {
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly completeTurnsOnly: boolean;
  },
) =>
  Effect.gen(function* () {
    const prefix = `copy:${input.targetThreadId}:`;
    yield* sql`INSERT INTO visualization_history(id,thread_id,turn_id,message_id,origin_item_id,occurred_at,actor_json,reference_json,revision_id,native_call_key,byte_length)
    SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
      ${input.targetThreadId},${prefix} || h.turn_id,${prefix} || h.message_id,${prefix} || h.origin_item_id,
      h.occurred_at,h.actor_json,h.reference_json,h.revision_id,${prefix} || h.native_call_key,h.byte_length + ${prefix.length * 4}
    FROM visualization_history h
    WHERE h.thread_id = ${input.sourceThreadId}
      AND NOT EXISTS(SELECT 1 FROM hard_deleted_threads WHERE thread_id IN (${input.sourceThreadId},${input.targetThreadId}))
      AND EXISTS(SELECT 1 FROM projection_turns t WHERE t.thread_id = ${input.targetThreadId}
        AND t.turn_id = ${prefix} || h.turn_id AND (${input.completeTurnsOnly ? 1 : 0} = 0 OR t.checkpoint_turn_count IS NOT NULL))
    ON CONFLICT(thread_id,native_call_key) DO NOTHING`;
  });

/** Retained canonical turns keep their immutable references. Claimed bytes
 * survive while any fork owns them; age-based sweep never removes that ref. */
export const reconcileVisualizationHistory = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM visualization_history WHERE thread_id = ${threadId}
    AND NOT EXISTS(SELECT 1 FROM projection_turns t WHERE t.thread_id = ${threadId} AND t.turn_id = visualization_history.turn_id)`;
    // A retained revision may have been produced by an already-deleted parent.
    // The final fork reference, not the producer's chat ID, controls retirement.
    yield* sql`UPDATE visualization_artifacts SET state = 'retired' WHERE state = 'ready'
    AND NOT EXISTS(SELECT 1 FROM visualization_history h WHERE h.revision_id = visualization_artifacts.revision_id)
    AND NOT EXISTS(SELECT 1 FROM visualization_invocations i WHERE i.revision_id = visualization_artifacts.revision_id AND i.native_call_key IS NULL)`;
  });
