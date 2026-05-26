import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Provider runtime state is the durable ownership record after a desktop or
  // daemon restart. If it says a session is stopped, Cafe no longer has a live
  // provider turn to steer. This mirrors the Codex CLI/app-server model: after
  // the app-server process is stopped, the Codex thread id/resume cursor stays
  // durable, but any in-flight turn from that stopped runtime is not live. Mark
  // the projected turn interrupted instead of synthesizing a provider
  // completion, then let the next user send resume the thread in a fresh
  // provider process.
  yield* sql`
    WITH stopped_runtime_sessions AS (
      SELECT
        runtime.thread_id,
        runtime.last_seen_at AS stopped_at,
        CASE
          WHEN runtime.runtime_payload_json IS NOT NULL
           AND json_valid(runtime.runtime_payload_json)
          THEN json_extract(runtime.runtime_payload_json, '$.activeTurnId')
          ELSE NULL
        END AS runtime_active_turn_id
      FROM provider_session_runtime runtime
      WHERE runtime.status = 'stopped'
    ),
    stale_projected_sessions AS (
      SELECT
        sessions.thread_id,
        sessions.active_turn_id,
        stopped.stopped_at
      FROM projection_thread_sessions sessions
      JOIN stopped_runtime_sessions stopped
        ON stopped.thread_id = sessions.thread_id
      WHERE stopped.runtime_active_turn_id IS NULL
        AND (
          sessions.status IN ('starting', 'running')
          OR sessions.active_turn_id IS NOT NULL
        )
    )
    UPDATE projection_turns
    SET
      state = 'interrupted',
      started_at = COALESCE(started_at, requested_at),
      completed_at = COALESCE(completed_at, (
        SELECT stale.stopped_at
        FROM stale_projected_sessions stale
        WHERE stale.thread_id = projection_turns.thread_id
          AND stale.active_turn_id = projection_turns.turn_id
        LIMIT 1
      ))
    WHERE turn_id IS NOT NULL
      AND state IN ('pending', 'running')
      AND EXISTS (
        SELECT 1
        FROM stale_projected_sessions stale
        WHERE stale.thread_id = projection_turns.thread_id
          AND stale.active_turn_id = projection_turns.turn_id
      )
  `;

  yield* sql`
    WITH stopped_runtime_sessions AS (
      SELECT
        runtime.thread_id,
        runtime.last_seen_at AS stopped_at,
        CASE
          WHEN runtime.runtime_payload_json IS NOT NULL
           AND json_valid(runtime.runtime_payload_json)
          THEN json_extract(runtime.runtime_payload_json, '$.activeTurnId')
          ELSE NULL
        END AS runtime_active_turn_id
      FROM provider_session_runtime runtime
      WHERE runtime.status = 'stopped'
    ),
    closed_runtime_turns AS (
      SELECT
        turns.thread_id,
        turns.turn_id,
        turns.completed_at AS closed_at
      FROM projection_thread_sessions sessions
      JOIN stopped_runtime_sessions stopped
        ON stopped.thread_id = sessions.thread_id
      JOIN projection_turns turns
        ON turns.thread_id = sessions.thread_id
       AND turns.turn_id = sessions.active_turn_id
      WHERE stopped.runtime_active_turn_id IS NULL
        AND turns.state IN ('completed', 'interrupted', 'error')
        AND turns.completed_at IS NOT NULL
    )
    UPDATE projection_thread_messages
    SET
      is_streaming = 0,
      updated_at = COALESCE((
        SELECT CASE
          WHEN closed.closed_at > projection_thread_messages.updated_at
          THEN closed.closed_at
          ELSE projection_thread_messages.updated_at
        END
        FROM closed_runtime_turns closed
        WHERE closed.thread_id = projection_thread_messages.thread_id
          AND closed.turn_id = projection_thread_messages.turn_id
        LIMIT 1
      ), projection_thread_messages.updated_at)
    WHERE is_streaming = 1
      AND role = 'assistant'
      AND turn_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM closed_runtime_turns closed
        WHERE closed.thread_id = projection_thread_messages.thread_id
          AND closed.turn_id = projection_thread_messages.turn_id
      )
  `;

  yield* sql`
    WITH stopped_runtime_sessions AS (
      SELECT
        runtime.thread_id,
        runtime.last_seen_at AS stopped_at,
        CASE
          WHEN runtime.runtime_payload_json IS NOT NULL
           AND json_valid(runtime.runtime_payload_json)
          THEN json_extract(runtime.runtime_payload_json, '$.activeTurnId')
          ELSE NULL
        END AS runtime_active_turn_id
      FROM provider_session_runtime runtime
      WHERE runtime.status = 'stopped'
    ),
    stale_projected_sessions AS (
      SELECT
        sessions.thread_id,
        stopped.stopped_at
      FROM projection_thread_sessions sessions
      JOIN stopped_runtime_sessions stopped
        ON stopped.thread_id = sessions.thread_id
      WHERE stopped.runtime_active_turn_id IS NULL
        AND (
          sessions.status IN ('starting', 'running')
          OR sessions.active_turn_id IS NOT NULL
        )
    )
    UPDATE projection_threads
    SET
      updated_at = COALESCE((
        SELECT CASE
          WHEN stale.stopped_at > projection_threads.updated_at
          THEN stale.stopped_at
          ELSE projection_threads.updated_at
        END
        FROM stale_projected_sessions stale
        WHERE stale.thread_id = projection_threads.thread_id
        LIMIT 1
      ), projection_threads.updated_at)
    WHERE EXISTS (
      SELECT 1
      FROM stale_projected_sessions stale
      WHERE stale.thread_id = projection_threads.thread_id
    )
  `;

  yield* sql`
    WITH stopped_runtime_sessions AS (
      SELECT
        runtime.thread_id,
        runtime.provider_name,
        runtime.provider_instance_id,
        runtime.runtime_mode,
        runtime.last_seen_at AS stopped_at,
        CASE
          WHEN runtime.runtime_payload_json IS NOT NULL
           AND json_valid(runtime.runtime_payload_json)
          THEN json_extract(runtime.runtime_payload_json, '$.activeTurnId')
          ELSE NULL
        END AS runtime_active_turn_id
      FROM provider_session_runtime runtime
      WHERE runtime.status = 'stopped'
    ),
    stale_projected_sessions AS (
      SELECT
        sessions.thread_id,
        stopped.provider_name,
        stopped.provider_instance_id,
        stopped.runtime_mode,
        stopped.stopped_at
      FROM projection_thread_sessions sessions
      JOIN stopped_runtime_sessions stopped
        ON stopped.thread_id = sessions.thread_id
      WHERE stopped.runtime_active_turn_id IS NULL
        AND (
          sessions.status IN ('starting', 'running')
          OR sessions.active_turn_id IS NOT NULL
        )
    )
    UPDATE projection_thread_sessions
    SET
      status = 'stopped',
      provider_name = COALESCE(provider_name, (
        SELECT stale.provider_name
        FROM stale_projected_sessions stale
        WHERE stale.thread_id = projection_thread_sessions.thread_id
        LIMIT 1
      )),
      provider_instance_id = COALESCE(provider_instance_id, (
        SELECT stale.provider_instance_id
        FROM stale_projected_sessions stale
        WHERE stale.thread_id = projection_thread_sessions.thread_id
        LIMIT 1
      )),
      runtime_mode = COALESCE(runtime_mode, (
        SELECT stale.runtime_mode
        FROM stale_projected_sessions stale
        WHERE stale.thread_id = projection_thread_sessions.thread_id
        LIMIT 1
      )),
      active_turn_id = NULL,
      updated_at = COALESCE((
        SELECT CASE
          WHEN stale.stopped_at > projection_thread_sessions.updated_at
          THEN stale.stopped_at
          ELSE projection_thread_sessions.updated_at
        END
        FROM stale_projected_sessions stale
        WHERE stale.thread_id = projection_thread_sessions.thread_id
        LIMIT 1
      ), projection_thread_sessions.updated_at)
    WHERE EXISTS (
      SELECT 1
      FROM stale_projected_sessions stale
      WHERE stale.thread_id = projection_thread_sessions.thread_id
    )
  `;
});
