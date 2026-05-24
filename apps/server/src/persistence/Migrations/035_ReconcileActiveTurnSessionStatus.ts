import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_thread_sessions
    SET
      status = 'running',
      updated_at = COALESCE((
        SELECT CASE
          WHEN projection_turns.started_at IS NOT NULL
           AND projection_turns.started_at > projection_thread_sessions.updated_at
          THEN projection_turns.started_at
          WHEN projection_turns.requested_at > projection_thread_sessions.updated_at
          THEN projection_turns.requested_at
          ELSE projection_thread_sessions.updated_at
        END
        FROM projection_turns
        WHERE projection_turns.thread_id = projection_thread_sessions.thread_id
          AND projection_turns.turn_id = projection_thread_sessions.active_turn_id
          AND projection_turns.state = 'running'
          AND projection_turns.completed_at IS NULL
        LIMIT 1
      ), projection_thread_sessions.updated_at)
    WHERE projection_thread_sessions.status <> 'running'
      AND projection_thread_sessions.active_turn_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns
        WHERE projection_turns.thread_id = projection_thread_sessions.thread_id
          AND projection_turns.turn_id = projection_thread_sessions.active_turn_id
          AND projection_turns.state = 'running'
          AND projection_turns.completed_at IS NULL
      )
  `;

  yield* sql`
    UPDATE projection_thread_sessions
    SET
      status = CASE
        WHEN EXISTS (
          SELECT 1
          FROM projection_turns
          WHERE projection_turns.thread_id = projection_thread_sessions.thread_id
            AND projection_turns.turn_id = projection_thread_sessions.active_turn_id
            AND projection_turns.state = 'completed'
        )
        THEN 'ready'
        WHEN EXISTS (
          SELECT 1
          FROM projection_turns
          WHERE projection_turns.thread_id = projection_thread_sessions.thread_id
            AND projection_turns.turn_id = projection_thread_sessions.active_turn_id
            AND projection_turns.state = 'error'
        )
        THEN 'error'
        WHEN EXISTS (
          SELECT 1
          FROM projection_turns
          WHERE projection_turns.thread_id = projection_thread_sessions.thread_id
            AND projection_turns.turn_id = projection_thread_sessions.active_turn_id
            AND projection_turns.state = 'interrupted'
            AND projection_thread_sessions.status = 'running'
        )
        THEN 'interrupted'
        ELSE projection_thread_sessions.status
      END,
      active_turn_id = NULL,
      updated_at = COALESCE((
        SELECT CASE
          WHEN projection_turns.completed_at IS NOT NULL
           AND projection_turns.completed_at > projection_thread_sessions.updated_at
          THEN projection_turns.completed_at
          ELSE projection_thread_sessions.updated_at
        END
        FROM projection_turns
        WHERE projection_turns.thread_id = projection_thread_sessions.thread_id
          AND projection_turns.turn_id = projection_thread_sessions.active_turn_id
          AND (
            projection_turns.state IN ('completed', 'interrupted', 'error')
            OR projection_turns.completed_at IS NOT NULL
          )
        LIMIT 1
      ), projection_thread_sessions.updated_at)
    WHERE projection_thread_sessions.active_turn_id IS NOT NULL
      AND (
        NOT EXISTS (
          SELECT 1
          FROM projection_turns
          WHERE projection_turns.thread_id = projection_thread_sessions.thread_id
            AND projection_turns.turn_id = projection_thread_sessions.active_turn_id
        )
        OR EXISTS (
          SELECT 1
          FROM projection_turns
          WHERE projection_turns.thread_id = projection_thread_sessions.thread_id
            AND projection_turns.turn_id = projection_thread_sessions.active_turn_id
            AND (
              projection_turns.state IN ('completed', 'interrupted', 'error')
              OR projection_turns.completed_at IS NOT NULL
            )
        )
      )
  `;
});
