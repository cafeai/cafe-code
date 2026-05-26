import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Provider-daemon event journal pruning is intentionally handled by the
  // journal runtime after the daemon has had a chance to bind its IPC socket.
  // A previous version of this migration deleted large inherited event tables
  // during daemon startup; on real user databases that could exceed the
  // desktop readiness deadline and leave the app with no provider-daemon
  // socket. Keep this migration focused on quick projection reconciliation.

  // Re-run the terminal-turn streaming-message reconciliation. Some older
  // projections were rebuilt or received late backfill after migration 045, so
  // terminal turns can still have assistant rows marked streaming. Those stale
  // flags make the renderer show perpetual working/streaming state and increase
  // per-thread projection pressure.
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
