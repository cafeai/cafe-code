import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    WITH active_completed_turns AS (
      SELECT
        s.thread_id,
        s.active_turn_id AS turn_id,
        MAX(a.created_at) AS latest_activity_at
      FROM projection_thread_sessions s
      JOIN projection_turns t
        ON t.thread_id = s.thread_id
       AND t.turn_id = s.active_turn_id
      JOIN projection_thread_activities a
        ON a.thread_id = s.thread_id
       AND a.turn_id = s.active_turn_id
       AND a.created_at > t.completed_at
      WHERE s.status = 'running'
        AND s.active_turn_id IS NOT NULL
        AND t.state = 'completed'
        AND t.completed_at IS NOT NULL
      GROUP BY s.thread_id, s.active_turn_id
    )
    UPDATE projection_turns
    SET
      state = 'running',
      completed_at = NULL
    WHERE EXISTS (
      SELECT 1
      FROM active_completed_turns active
      WHERE active.thread_id = projection_turns.thread_id
        AND active.turn_id = projection_turns.turn_id
    )
  `;

  yield* sql`
    WITH active_completed_turns AS (
      SELECT
        s.thread_id,
        s.active_turn_id AS turn_id,
        MAX(a.created_at) AS latest_activity_at
      FROM projection_thread_sessions s
      JOIN projection_turns t
        ON t.thread_id = s.thread_id
       AND t.turn_id = s.active_turn_id
      JOIN projection_thread_activities a
        ON a.thread_id = s.thread_id
       AND a.turn_id = s.active_turn_id
      WHERE s.status = 'running'
        AND s.active_turn_id IS NOT NULL
        AND t.state = 'running'
        AND t.completed_at IS NULL
      GROUP BY s.thread_id, s.active_turn_id
    )
    UPDATE projection_thread_sessions
    SET
      updated_at = COALESCE((
        SELECT CASE
          WHEN active.latest_activity_at > projection_thread_sessions.updated_at
          THEN active.latest_activity_at
          ELSE projection_thread_sessions.updated_at
        END
        FROM active_completed_turns active
        WHERE active.thread_id = projection_thread_sessions.thread_id
          AND active.turn_id = projection_thread_sessions.active_turn_id
        LIMIT 1
      ), projection_thread_sessions.updated_at)
    WHERE EXISTS (
      SELECT 1
      FROM active_completed_turns active
      WHERE active.thread_id = projection_thread_sessions.thread_id
        AND active.turn_id = projection_thread_sessions.active_turn_id
    )
  `;

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
  `;
});
