import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Provider replay can append older checkpoint/session events after a newer
  // turn has already completed. Projection code now prevents that regression
  // live, and this migration repairs databases that already accepted the stale
  // shell pointer before the monotonic promotion rule existed.
  yield* sql`
    WITH newest_concrete_turn AS (
      SELECT
        ranked.thread_id,
        ranked.turn_id,
        ranked.state,
        ranked.requested_at,
        ranked.started_at,
        ranked.completed_at,
        COALESCE(ranked.completed_at, ranked.started_at, ranked.requested_at) AS observed_at
      FROM (
        SELECT
          thread_id,
          turn_id,
          state,
          requested_at,
          started_at,
          completed_at,
          row_id,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY requested_at DESC, row_id DESC
          ) AS rank
        FROM projection_turns
        WHERE turn_id IS NOT NULL
      ) ranked
      WHERE ranked.rank = 1
    )
    UPDATE projection_threads
    SET
      latest_turn_id = (
        SELECT newest.turn_id
        FROM newest_concrete_turn newest
        WHERE newest.thread_id = projection_threads.thread_id
        LIMIT 1
      ),
      updated_at = COALESCE((
        SELECT CASE
          WHEN newest.observed_at > projection_threads.updated_at
          THEN newest.observed_at
          ELSE projection_threads.updated_at
        END
        FROM newest_concrete_turn newest
        WHERE newest.thread_id = projection_threads.thread_id
        LIMIT 1
      ), projection_threads.updated_at)
    WHERE EXISTS (
      SELECT 1
      FROM newest_concrete_turn newest
      WHERE newest.thread_id = projection_threads.thread_id
        AND (
          projection_threads.latest_turn_id IS NULL
          OR projection_threads.latest_turn_id <> newest.turn_id
          OR newest.observed_at > projection_threads.updated_at
        )
    )
  `;

  // Keep session lifecycle timestamps in phase with the repaired latest turn
  // without overriding an explicit stopped runtime state from migration 050.
  yield* sql`
    WITH newest_concrete_turn AS (
      SELECT
        ranked.thread_id,
        ranked.turn_id,
        ranked.state,
        ranked.completed_at,
        COALESCE(ranked.completed_at, ranked.started_at, ranked.requested_at) AS observed_at
      FROM (
        SELECT
          thread_id,
          turn_id,
          state,
          requested_at,
          started_at,
          completed_at,
          row_id,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY requested_at DESC, row_id DESC
          ) AS rank
        FROM projection_turns
        WHERE turn_id IS NOT NULL
      ) ranked
      WHERE ranked.rank = 1
    )
    UPDATE projection_thread_sessions
    SET
      status = COALESCE((
        SELECT CASE
          WHEN projection_thread_sessions.status = 'stopped'
          THEN projection_thread_sessions.status
          WHEN newest.state = 'completed'
          THEN 'ready'
          WHEN newest.state = 'error'
          THEN 'error'
          WHEN newest.state = 'interrupted'
          THEN 'interrupted'
          ELSE 'running'
        END
        FROM newest_concrete_turn newest
        WHERE newest.thread_id = projection_thread_sessions.thread_id
        LIMIT 1
      ), projection_thread_sessions.status),
      active_turn_id = CASE
        WHEN EXISTS (
          SELECT 1
          FROM newest_concrete_turn newest
          WHERE newest.thread_id = projection_thread_sessions.thread_id
        )
        THEN (
          SELECT CASE
            WHEN projection_thread_sessions.status = 'stopped'
            THEN projection_thread_sessions.active_turn_id
            WHEN newest.state = 'running' AND newest.completed_at IS NULL
            THEN newest.turn_id
            ELSE NULL
          END
          FROM newest_concrete_turn newest
          WHERE newest.thread_id = projection_thread_sessions.thread_id
          LIMIT 1
        )
        ELSE projection_thread_sessions.active_turn_id
      END,
      last_error = CASE
        WHEN EXISTS (
          SELECT 1
          FROM newest_concrete_turn newest
          WHERE newest.thread_id = projection_thread_sessions.thread_id
            AND newest.state = 'completed'
        )
        THEN NULL
        ELSE projection_thread_sessions.last_error
      END,
      updated_at = COALESCE((
        SELECT CASE
          WHEN newest.observed_at > projection_thread_sessions.updated_at
          THEN newest.observed_at
          ELSE projection_thread_sessions.updated_at
        END
        FROM newest_concrete_turn newest
        WHERE newest.thread_id = projection_thread_sessions.thread_id
        LIMIT 1
      ), projection_thread_sessions.updated_at)
    WHERE EXISTS (
      SELECT 1
      FROM newest_concrete_turn newest
      WHERE newest.thread_id = projection_thread_sessions.thread_id
        AND (
          newest.observed_at > projection_thread_sessions.updated_at
          OR (
            projection_thread_sessions.status <> 'stopped'
            AND (
              projection_thread_sessions.active_turn_id IS NOT
                CASE
                  WHEN newest.state = 'running' AND newest.completed_at IS NULL
                  THEN newest.turn_id
                  ELSE NULL
                END
              OR projection_thread_sessions.status <> CASE newest.state
                WHEN 'completed' THEN 'ready'
                WHEN 'error' THEN 'error'
                WHEN 'interrupted' THEN 'interrupted'
                ELSE 'running'
              END
            )
          )
        )
    )
  `;
});
