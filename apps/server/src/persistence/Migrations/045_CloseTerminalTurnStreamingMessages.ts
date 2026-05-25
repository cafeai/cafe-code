import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Older projections could leave a partial assistant message marked
  // streaming after its provider turn had already reached a terminal state.
  // That stale per-message flag is enough to make the renderer keep showing a
  // working/streaming marker even though provider and session state are idle.
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
