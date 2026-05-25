import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A later concrete turn proves an older "running" active turn is no longer
  // the provider-owned turn for the thread. Preserve the evidence by marking
  // the stale row interrupted at the first newer turn request instead of
  // inventing a successful completion that the provider never reported.
  yield* sql`
    WITH stale_active_turns AS (
      SELECT
        active.thread_id,
        active.turn_id,
        MIN(newer.requested_at) AS closed_at
      FROM projection_thread_sessions sessions
      JOIN projection_turns active
        ON active.thread_id = sessions.thread_id
       AND active.turn_id = sessions.active_turn_id
      JOIN projection_turns newer
        ON newer.thread_id = active.thread_id
       AND newer.turn_id IS NOT NULL
       AND newer.turn_id <> active.turn_id
       AND newer.requested_at > active.requested_at
      WHERE sessions.active_turn_id IS NOT NULL
        AND active.state = 'running'
        AND active.completed_at IS NULL
      GROUP BY active.thread_id, active.turn_id
    )
    UPDATE projection_turns
    SET
      state = 'interrupted',
      started_at = COALESCE(started_at, requested_at),
      completed_at = (
        SELECT stale.closed_at
        FROM stale_active_turns stale
        WHERE stale.thread_id = projection_turns.thread_id
          AND stale.turn_id = projection_turns.turn_id
        LIMIT 1
      )
    WHERE EXISTS (
      SELECT 1
      FROM stale_active_turns stale
      WHERE stale.thread_id = projection_turns.thread_id
        AND stale.turn_id = projection_turns.turn_id
    )
  `;

  // Recompute thread.latest_turn_id from the newest concrete turn. Older
  // projection bugs could leave this shell pointer on a stale active turn,
  // which made the renderer treat a finished thread as still steerable.
  yield* sql`
    WITH newest_concrete_turn AS (
      SELECT
        ranked.thread_id,
        ranked.turn_id,
        ranked.requested_at,
        ranked.started_at,
        ranked.completed_at
      FROM (
        SELECT
          thread_id,
          turn_id,
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
          WHEN COALESCE(newest.completed_at, newest.started_at, newest.requested_at)
             > projection_threads.updated_at
          THEN COALESCE(newest.completed_at, newest.started_at, newest.requested_at)
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
        )
    )
  `;

  // Bring thread sessions back into alignment with the newest turn whenever
  // they still point at an older/terminal/missing active turn. This is a
  // conservative reconciliation: terminal latest turns clear active_turn_id,
  // while a genuinely newest running turn remains active.
  yield* sql`
    WITH newest_concrete_turn AS (
      SELECT
        ranked.thread_id,
        ranked.turn_id,
        ranked.state,
        ranked.requested_at,
        ranked.started_at,
        ranked.completed_at
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
      status = CASE
        WHEN EXISTS (
          SELECT 1
          FROM newest_concrete_turn newest
          WHERE newest.thread_id = projection_thread_sessions.thread_id
        )
        THEN (
          SELECT CASE newest.state
            WHEN 'completed' THEN 'ready'
            WHEN 'error' THEN 'error'
            WHEN 'interrupted' THEN 'interrupted'
            ELSE 'running'
          END
          FROM newest_concrete_turn newest
          WHERE newest.thread_id = projection_thread_sessions.thread_id
          LIMIT 1
        )
        ELSE projection_thread_sessions.status
      END,
      active_turn_id = CASE
        WHEN EXISTS (
          SELECT 1
          FROM newest_concrete_turn newest
          WHERE newest.thread_id = projection_thread_sessions.thread_id
        )
        THEN (
          SELECT CASE
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
          WHEN COALESCE(newest.completed_at, newest.started_at, newest.requested_at)
             > projection_thread_sessions.updated_at
          THEN COALESCE(newest.completed_at, newest.started_at, newest.requested_at)
          ELSE projection_thread_sessions.updated_at
        END
        FROM newest_concrete_turn newest
        WHERE newest.thread_id = projection_thread_sessions.thread_id
        LIMIT 1
      ), projection_thread_sessions.updated_at)
    WHERE projection_thread_sessions.active_turn_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM newest_concrete_turn newest
        WHERE newest.thread_id = projection_thread_sessions.thread_id
          AND (
            newest.turn_id <> projection_thread_sessions.active_turn_id
            OR newest.state IN ('completed', 'interrupted', 'error')
            OR NOT EXISTS (
              SELECT 1
              FROM projection_turns active
              WHERE active.thread_id = projection_thread_sessions.thread_id
                AND active.turn_id = projection_thread_sessions.active_turn_id
            )
          )
      )
  `;

  yield* sql`
    WITH latest_terminal_turn AS (
      SELECT
        turns.thread_id,
        turns.state,
        turns.completed_at
      FROM projection_threads threads
      JOIN projection_turns turns
        ON turns.thread_id = threads.thread_id
       AND turns.turn_id = threads.latest_turn_id
      WHERE turns.state IN ('completed', 'interrupted', 'error')
    )
    UPDATE projection_thread_sessions
    SET
      status = COALESCE((
        SELECT CASE latest.state
          WHEN 'completed' THEN 'ready'
          WHEN 'error' THEN 'error'
          ELSE 'interrupted'
        END
        FROM latest_terminal_turn latest
        WHERE latest.thread_id = projection_thread_sessions.thread_id
        LIMIT 1
      ), projection_thread_sessions.status),
      updated_at = COALESCE((
        SELECT CASE
          WHEN latest.completed_at IS NOT NULL
           AND latest.completed_at > projection_thread_sessions.updated_at
          THEN latest.completed_at
          ELSE projection_thread_sessions.updated_at
        END
        FROM latest_terminal_turn latest
        WHERE latest.thread_id = projection_thread_sessions.thread_id
        LIMIT 1
      ), projection_thread_sessions.updated_at)
    WHERE projection_thread_sessions.active_turn_id IS NULL
      AND projection_thread_sessions.status IN ('starting', 'running')
      AND EXISTS (
        SELECT 1
        FROM latest_terminal_turn latest
        WHERE latest.thread_id = projection_thread_sessions.thread_id
      )
  `;
});
