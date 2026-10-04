import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Capabilities are issued by the actual provider runtime. Their secrets never
 * enter SQLite; the ledger contains only digests and exact lifetime fences.
 * A new runtime replaces the singleton generation before accepting bindings,
 * so credentials left by a crashed process cannot regain authority. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE scheduling_session_runtime (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE scheduling_session_capabilities (
    thread_id TEXT PRIMARY KEY,
    provider_instance_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('codex','claudeAgent','grok')),
    session_generation TEXT NOT NULL UNIQUE,
    runtime_generation TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0,1)),
    token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 64)
  )`;
  // Session startup may precede projection hydration, so a foreign key to the
  // projection would reject valid first turns. Tombstones remain authoritative.
  yield* sql`CREATE TRIGGER scheduling_session_hard_delete
    AFTER INSERT ON hard_deleted_threads
    BEGIN DELETE FROM scheduling_session_capabilities WHERE thread_id = NEW.thread_id; END`;
});
