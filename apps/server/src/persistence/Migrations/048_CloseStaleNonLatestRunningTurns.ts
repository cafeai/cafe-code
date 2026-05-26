import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A newer concrete turn is durable evidence that an older same-thread turn is
  // no longer provider-owned, even when earlier projection bugs failed to mark
  // the older row terminal. Close those stale rows as interrupted at the first
  // newer turn request, preserving the fact that we never observed a successful
  // completion for the stale turn.
  yield* sql`
    WITH stale_running_turns AS (
      SELECT
        stale.thread_id,
        stale.turn_id,
        MIN(newer.requested_at) AS closed_at
      FROM projection_turns stale
      JOIN projection_turns newer
        ON newer.thread_id = stale.thread_id
       AND newer.turn_id IS NOT NULL
       AND newer.turn_id <> stale.turn_id
       AND newer.requested_at > stale.requested_at
      WHERE stale.turn_id IS NOT NULL
        AND stale.state = 'running'
        AND stale.completed_at IS NULL
      GROUP BY stale.thread_id, stale.turn_id
    )
    UPDATE projection_turns
    SET
      state = 'interrupted',
      started_at = COALESCE(started_at, requested_at),
      completed_at = (
        SELECT stale.closed_at
        FROM stale_running_turns stale
        WHERE stale.thread_id = projection_turns.thread_id
          AND stale.turn_id = projection_turns.turn_id
        LIMIT 1
      )
    WHERE EXISTS (
      SELECT 1
      FROM stale_running_turns stale
      WHERE stale.thread_id = projection_turns.thread_id
        AND stale.turn_id = projection_turns.turn_id
    )
  `;

  // The renderer treats assistant streaming flags as live provider work. Once a
  // stale turn is reconciled to terminal, clear its assistant streaming rows in
  // the same migration so the UI cannot keep displaying a phantom in-progress
  // marker after backend/provider state is idle.
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

  // If a session still points at a turn this migration just made terminal,
  // realign it to the newest concrete turn. This mirrors the reconciliation
  // model in earlier active-turn migrations but keeps the fix idempotent for
  // databases that receive stale rows after those one-shot migrations ran.
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
      status = COALESCE((
        SELECT CASE newest.state
          WHEN 'completed' THEN 'ready'
          WHEN 'error' THEN 'error'
          WHEN 'interrupted' THEN 'interrupted'
          ELSE 'running'
        END
        FROM newest_concrete_turn newest
        WHERE newest.thread_id = projection_thread_sessions.thread_id
        LIMIT 1
      ), projection_thread_sessions.status),
      active_turn_id = COALESCE((
        SELECT CASE
          WHEN newest.state = 'running' AND newest.completed_at IS NULL
          THEN newest.turn_id
          ELSE NULL
        END
        FROM newest_concrete_turn newest
        WHERE newest.thread_id = projection_thread_sessions.thread_id
        LIMIT 1
      ), NULL),
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
        FROM projection_turns active
        WHERE active.thread_id = projection_thread_sessions.thread_id
          AND active.turn_id = projection_thread_sessions.active_turn_id
          AND active.state IN ('completed', 'interrupted', 'error')
      )
  `;
});
