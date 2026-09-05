import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Preserve the provider-native root needed to read a nested-agent transcript.
 *
 * `provider_session_runtime` intentionally keeps only the current binding for
 * a Cafe thread. A user may switch that thread from Codex to Claude (or the
 * reverse) after a child has completed, so detail reads cannot safely route
 * through that mutable row. Root provenance is normalized per Cafe turn: a
 * turn can have thousands of children, but its private cursor and cwd are
 * stored once rather than copied into every child row.
 *
 * The table is server-private. Neither resume state nor workspace paths are
 * copied into projection activity payloads or renderer-visible snapshots.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_subagent_history_roots (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      resume_cursor_json TEXT,
      cwd TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id),
      FOREIGN KEY (thread_id)
        REFERENCES projection_threads(thread_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_subagent_history_bindings (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      history_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id, subagent_id, history_id),
      FOREIGN KEY (thread_id, turn_id)
        REFERENCES provider_subagent_history_roots(thread_id, turn_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_subagent_history_roots_thread_updated
    ON provider_subagent_history_roots(thread_id, updated_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_subagent_history_bindings_thread_updated
    ON provider_subagent_history_bindings(thread_id, updated_at DESC)
  `;
});
