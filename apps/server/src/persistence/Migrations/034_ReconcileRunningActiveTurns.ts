import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_turns
    SET state = 'running',
        completed_at = NULL
    WHERE state = 'completed'
      AND turn_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM projection_thread_sessions
        WHERE projection_thread_sessions.thread_id = projection_turns.thread_id
          AND projection_thread_sessions.status = 'running'
          AND projection_thread_sessions.active_turn_id = projection_turns.turn_id
      )
  `;
});
