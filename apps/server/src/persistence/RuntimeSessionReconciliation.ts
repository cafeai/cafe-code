import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Reconciles durable provider runtime state back into the projections that feed
 * the renderer. This intentionally lives in persistence rather than a provider
 * adapter because it repairs cross-layer state after process death: no provider
 * protocol call is safe or necessary once the runtime row already proves the
 * owning app-server/session was stopped.
 */
export const reconcileStoppedRuntimeSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A malformed shutdown can be interrupted after the provider finalizer writes
  // the stop marker but before it flips the row status and clears activeTurnId.
  // Treat `lastRuntimeEvent=provider.stopAll` as authoritative durable proof
  // that Cafe intentionally stopped owning the live app-server session. This is
  // the same lifecycle boundary Codex app-server exposes: the thread/resume
  // cursor may remain durable, but an in-flight turn from a stopped process is
  // no longer steerable or running.
  yield* sql`
    UPDATE provider_session_runtime
    SET
      status = 'stopped',
      runtime_payload_json = json_set(
        CASE
          WHEN runtime_payload_json IS NOT NULL
           AND json_valid(runtime_payload_json)
          THEN runtime_payload_json
          ELSE '{}'
        END,
        '$.activeTurnId',
        json('null'),
        '$.lastRuntimeEvent',
        'provider.stopAll',
        '$.lastRuntimeEventAt',
        COALESCE(
          json_extract(runtime_payload_json, '$.lastRuntimeEventAt'),
          last_seen_at
        )
      )
    WHERE status <> 'stopped'
      AND runtime_payload_json IS NOT NULL
      AND json_valid(runtime_payload_json)
      AND json_extract(runtime_payload_json, '$.lastRuntimeEvent') = 'provider.stopAll'
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
