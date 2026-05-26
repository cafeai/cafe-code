import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Some historical Codex event streams contain a valid terminal checkpoint
  // followed by late `running` session snapshots for the same turn. Earlier live
  // projection code let those stale snapshots reopen the turn while keeping the
  // checkpoint metadata. Re-close those rows from the durable checkpoint signal
  // before the renderer or command invariants read them.
  yield* sql`
    WITH terminal_checkpoint_turns AS (
      SELECT
        turns.thread_id,
        turns.turn_id,
        turns.checkpoint_status,
        COALESCE(
          turns.completed_at,
          (
            SELECT json_extract(events.payload_json, '$.completedAt')
            FROM orchestration_events events
            WHERE events.stream_id = turns.thread_id
              AND events.event_type = 'thread.turn-diff-completed'
              AND json_extract(events.payload_json, '$.turnId') = turns.turn_id
              AND json_extract(events.payload_json, '$.status') = turns.checkpoint_status
            ORDER BY events.sequence DESC
            LIMIT 1
          ),
          (
            SELECT MIN(newer.requested_at)
            FROM projection_turns newer
            WHERE newer.thread_id = turns.thread_id
              AND newer.turn_id IS NOT NULL
              AND newer.turn_id <> turns.turn_id
              AND newer.requested_at > turns.requested_at
          ),
          turns.started_at,
          turns.requested_at
        ) AS closed_at
      FROM projection_turns turns
      WHERE turns.turn_id IS NOT NULL
        AND turns.state = 'running'
        AND turns.completed_at IS NULL
        AND turns.checkpoint_status IN ('ready', 'error')
    )
    UPDATE projection_turns
    SET
      state = CASE (
        SELECT terminal.checkpoint_status
        FROM terminal_checkpoint_turns terminal
        WHERE terminal.thread_id = projection_turns.thread_id
          AND terminal.turn_id = projection_turns.turn_id
        LIMIT 1
      )
        WHEN 'error' THEN 'error'
        ELSE 'completed'
      END,
      started_at = COALESCE(started_at, requested_at),
      completed_at = (
        SELECT terminal.closed_at
        FROM terminal_checkpoint_turns terminal
        WHERE terminal.thread_id = projection_turns.thread_id
          AND terminal.turn_id = projection_turns.turn_id
        LIMIT 1
      )
    WHERE EXISTS (
      SELECT 1
      FROM terminal_checkpoint_turns terminal
      WHERE terminal.thread_id = projection_turns.thread_id
        AND terminal.turn_id = projection_turns.turn_id
    )
  `;

  // Keep the broader non-latest stale-running reconciliation from migration 048
  // idempotent for databases where late replay recreated rows after 048 had
  // already run. These rows have no durable terminal checkpoint, so preserve
  // that uncertainty by marking them interrupted at the first newer turn.
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

  yield* sql`
    UPDATE projection_thread_sessions
    SET
      status = (
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
      ),
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
});
