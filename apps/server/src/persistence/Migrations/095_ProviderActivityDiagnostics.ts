import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Prospective private copies only; never reinterpret historic received payloads. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE provider_activity_diagnostics (
      activity_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      snapshot_json TEXT NOT NULL CHECK (length(snapshot_json) <= 65536),
      occurrence_key TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX idx_provider_activity_diagnostics_owner
    ON provider_activity_diagnostics (thread_id, turn_id, occurrence_key)`;
  // A stale daemon must not revive diagnostic material after hard deletion.
  yield* sql`CREATE TRIGGER trg_provider_diagnostics_tombstone
    BEFORE INSERT ON provider_activity_diagnostics
    WHEN EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id)
    BEGIN SELECT RAISE(ABORT, 'hard-deleted diagnostic owner'); END`;
  // Occurrence owners and the first captured copy are immutable. Replay may
  // only observe that same record; no UPSERT can silently rebind an identity.
  yield* sql`CREATE TRIGGER trg_provider_diagnostics_immutable
    BEFORE UPDATE ON provider_activity_diagnostics
    BEGIN SELECT RAISE(ABORT, 'immutable diagnostic occurrence'); END`;
  yield* sql`CREATE TRIGGER trg_provider_diagnostics_hard_delete
    AFTER INSERT ON hard_deleted_threads
    BEGIN DELETE FROM provider_activity_diagnostics WHERE thread_id = NEW.thread_id; END`;
});
