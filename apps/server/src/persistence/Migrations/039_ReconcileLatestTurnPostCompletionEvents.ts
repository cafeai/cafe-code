import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    WITH latest_completed_turn_events AS (
      SELECT
        turns.thread_id,
        turns.turn_id,
        MAX(events.event_at) AS latest_event_at
      FROM projection_turns turns
      JOIN projection_threads threads
        ON threads.thread_id = turns.thread_id
       AND threads.latest_turn_id = turns.turn_id
      LEFT JOIN projection_thread_sessions sessions
        ON sessions.thread_id = turns.thread_id
      JOIN (
        SELECT
          thread_id,
          turn_id,
          updated_at AS event_at
        FROM projection_thread_messages
        WHERE turn_id IS NOT NULL

        UNION ALL

        SELECT
          thread_id,
          turn_id,
          created_at AS event_at
        FROM projection_thread_activities
        WHERE turn_id IS NOT NULL
      ) events
        ON events.thread_id = turns.thread_id
       AND events.turn_id = turns.turn_id
       AND events.event_at > turns.completed_at
      WHERE turns.state = 'completed'
        AND turns.completed_at IS NOT NULL
        AND (
          sessions.thread_id IS NULL
          OR (
            sessions.status <> 'running'
            AND (
              sessions.active_turn_id IS NULL
              OR sessions.active_turn_id <> turns.turn_id
            )
          )
        )
      GROUP BY turns.thread_id, turns.turn_id
    )
    UPDATE projection_turns
    SET completed_at = (
      SELECT latest.latest_event_at
      FROM latest_completed_turn_events latest
      WHERE latest.thread_id = projection_turns.thread_id
        AND latest.turn_id = projection_turns.turn_id
      LIMIT 1
    )
    WHERE EXISTS (
      SELECT 1
      FROM latest_completed_turn_events latest
      WHERE latest.thread_id = projection_turns.thread_id
        AND latest.turn_id = projection_turns.turn_id
    )
  `;

  yield* sql`
    UPDATE projection_thread_sessions
    SET updated_at = COALESCE((
      SELECT CASE
        WHEN turns.completed_at > projection_thread_sessions.updated_at
        THEN turns.completed_at
        ELSE projection_thread_sessions.updated_at
      END
      FROM projection_threads threads
      JOIN projection_turns turns
        ON turns.thread_id = threads.thread_id
       AND turns.turn_id = threads.latest_turn_id
      WHERE threads.thread_id = projection_thread_sessions.thread_id
        AND turns.state = 'completed'
        AND turns.completed_at IS NOT NULL
        AND projection_thread_sessions.status <> 'running'
      LIMIT 1
    ), projection_thread_sessions.updated_at)
    WHERE projection_thread_sessions.status <> 'running'
      AND EXISTS (
        SELECT 1
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
         AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = projection_thread_sessions.thread_id
          AND turns.state = 'completed'
          AND turns.completed_at IS NOT NULL
          AND turns.completed_at > projection_thread_sessions.updated_at
      )
  `;

  yield* sql`
    UPDATE projection_threads
    SET updated_at = COALESCE((
      SELECT CASE
        WHEN turns.completed_at > projection_threads.updated_at
        THEN turns.completed_at
        ELSE projection_threads.updated_at
      END
      FROM projection_turns turns
      WHERE turns.thread_id = projection_threads.thread_id
        AND turns.turn_id = projection_threads.latest_turn_id
        AND turns.state = 'completed'
        AND turns.completed_at IS NOT NULL
      LIMIT 1
    ), projection_threads.updated_at)
    WHERE EXISTS (
      SELECT 1
      FROM projection_turns turns
      WHERE turns.thread_id = projection_threads.thread_id
        AND turns.turn_id = projection_threads.latest_turn_id
        AND turns.state = 'completed'
        AND turns.completed_at IS NOT NULL
        AND turns.completed_at > projection_threads.updated_at
    )
  `;
});
