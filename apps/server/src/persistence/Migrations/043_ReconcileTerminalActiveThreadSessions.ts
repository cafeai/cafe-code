import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_thread_sessions
    SET
      status = COALESCE((
        SELECT CASE turns.state
          WHEN 'completed' THEN 'ready'
          WHEN 'error' THEN 'error'
          ELSE 'interrupted'
        END
        FROM projection_turns turns
        WHERE turns.thread_id = projection_thread_sessions.thread_id
          AND turns.turn_id = projection_thread_sessions.active_turn_id
          AND turns.state IN ('completed', 'interrupted', 'error')
        LIMIT 1
      ), projection_thread_sessions.status),
      active_turn_id = NULL,
      last_error = CASE
        WHEN EXISTS (
          SELECT 1
          FROM projection_turns turns
          WHERE turns.thread_id = projection_thread_sessions.thread_id
            AND turns.turn_id = projection_thread_sessions.active_turn_id
            AND turns.state = 'completed'
        )
        THEN NULL
        ELSE projection_thread_sessions.last_error
      END,
      updated_at = COALESCE((
        SELECT CASE
          WHEN turns.completed_at IS NOT NULL
           AND turns.completed_at > projection_thread_sessions.updated_at
          THEN turns.completed_at
          ELSE projection_thread_sessions.updated_at
        END
        FROM projection_turns turns
        WHERE turns.thread_id = projection_thread_sessions.thread_id
          AND turns.turn_id = projection_thread_sessions.active_turn_id
          AND turns.state IN ('completed', 'interrupted', 'error')
        LIMIT 1
      ), projection_thread_sessions.updated_at)
    WHERE projection_thread_sessions.active_turn_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns turns
        WHERE turns.thread_id = projection_thread_sessions.thread_id
          AND turns.turn_id = projection_thread_sessions.active_turn_id
          AND turns.state IN ('completed', 'interrupted', 'error')
      )
  `;

  yield* sql`
    UPDATE projection_thread_sessions
    SET
      status = COALESCE((
        SELECT CASE turns.state
          WHEN 'completed' THEN 'ready'
          WHEN 'error' THEN 'error'
          ELSE 'interrupted'
        END
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
         AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = projection_thread_sessions.thread_id
          AND turns.state IN ('completed', 'interrupted', 'error')
        LIMIT 1
      ), projection_thread_sessions.status),
      updated_at = COALESCE((
        SELECT CASE
          WHEN turns.completed_at IS NOT NULL
           AND turns.completed_at > projection_thread_sessions.updated_at
          THEN turns.completed_at
          ELSE projection_thread_sessions.updated_at
        END
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
         AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = projection_thread_sessions.thread_id
          AND turns.state IN ('completed', 'interrupted', 'error')
        LIMIT 1
      ), projection_thread_sessions.updated_at)
    WHERE projection_thread_sessions.active_turn_id IS NULL
      AND projection_thread_sessions.status IN ('starting', 'running')
      AND EXISTS (
        SELECT 1
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
         AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = projection_thread_sessions.thread_id
          AND turns.state IN ('completed', 'interrupted', 'error')
      )
  `;
});
