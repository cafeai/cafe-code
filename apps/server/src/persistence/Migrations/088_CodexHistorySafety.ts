import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Retain a positively identified native-history failure across provider/backend
 * restarts. This is intentionally independent of volatile runtime rows and of
 * projections: a daemon database need not contain the orchestration thread.
 * No history scan, provider access, payload or filesystem path is involved.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE provider_codex_history_safety (
      thread_id TEXT NOT NULL CHECK(length(thread_id) BETWEEN 1 AND 512),
      provider_instance_id TEXT NOT NULL CHECK(length(provider_instance_id) BETWEEN 1 AND 512),
      native_thread_id TEXT NOT NULL CHECK(length(native_thread_id) BETWEEN 1 AND 512),
      reason TEXT NOT NULL CHECK(reason = 'codex_history_tool_arguments_too_large'),
      reported_at TEXT NOT NULL CHECK(length(reported_at) = 24),
      PRIMARY KEY (thread_id, provider_instance_id, native_thread_id)
    ) WITHOUT ROWID
  `;
  // INSERT covers UPSERT before conflict resolution. UPDATE closes direct SQL
  // writes while the separate daemon/main hard-delete purge is in progress.
  yield* sql`
    CREATE TRIGGER trg_codex_history_safety_hard_deleted_insert
    BEFORE INSERT ON provider_codex_history_safety
    WHEN EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id)
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER trg_codex_history_safety_hard_deleted_update
    BEFORE UPDATE ON provider_codex_history_safety
    WHEN EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id)
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
});
