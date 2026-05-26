import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Late Codex/Claude snapshot backfill and daemon replay can arrive after
  // earlier one-shot streaming cleanup migrations have already run. Keep this
  // reconciliation lightweight and projection-scoped: terminal turns must not
  // leave assistant rows marked streaming, because the renderer treats those
  // rows as live provider work even when the provider session is idle.
  yield* sql`
    UPDATE projection_thread_messages
    SET
      is_streaming = 0,
      updated_at = COALESCE((
        SELECT CASE
          WHEN turns.completed_at IS NOT NULL
           AND turns.completed_at > projection_thread_messages.updated_at
          THEN turns.completed_at
          ELSE projection_thread_messages.updated_at
        END
        FROM projection_turns turns
        WHERE turns.thread_id = projection_thread_messages.thread_id
          AND turns.turn_id = projection_thread_messages.turn_id
          AND turns.state IN ('completed', 'interrupted', 'error')
        LIMIT 1
      ), projection_thread_messages.updated_at)
    WHERE projection_thread_messages.is_streaming = 1
      AND projection_thread_messages.role = 'assistant'
      AND projection_thread_messages.turn_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns turns
        WHERE turns.thread_id = projection_thread_messages.thread_id
          AND turns.turn_id = projection_thread_messages.turn_id
          AND turns.state IN ('completed', 'interrupted', 'error')
      )
  `;
});
