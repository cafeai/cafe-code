import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_thread_sessions
    SET
      status = 'ready',
      active_turn_id = NULL,
      last_error = NULL,
      updated_at = COALESCE((
        SELECT CASE
          WHEN completed_at > projection_thread_sessions.updated_at
          THEN completed_at
          ELSE projection_thread_sessions.updated_at
        END
        FROM projection_turns
        WHERE projection_turns.thread_id = projection_thread_sessions.thread_id
          AND projection_turns.turn_id = projection_thread_sessions.active_turn_id
          AND projection_turns.state = 'completed'
          AND projection_turns.completed_at IS NOT NULL
        LIMIT 1
      ), projection_thread_sessions.updated_at)
    WHERE projection_thread_sessions.status = 'running'
      AND projection_thread_sessions.active_turn_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns
        WHERE projection_turns.thread_id = projection_thread_sessions.thread_id
          AND projection_turns.turn_id = projection_thread_sessions.active_turn_id
          AND projection_turns.state = 'completed'
          AND projection_turns.completed_at IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM projection_turns
        JOIN projection_thread_activities
          ON projection_thread_activities.thread_id = projection_turns.thread_id
         AND projection_thread_activities.turn_id = projection_turns.turn_id
         AND projection_thread_activities.created_at > projection_turns.completed_at
        WHERE projection_turns.thread_id = projection_thread_sessions.thread_id
          AND projection_turns.turn_id = projection_thread_sessions.active_turn_id
          AND projection_turns.state = 'completed'
          AND projection_turns.completed_at IS NOT NULL
      )
  `;
});
