import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Bytes stay outside the transcript database. Insert the intent before writing
  // the private PNG, so a crashed writer always leaves an indexed cleanup record.
  yield* sql`CREATE TABLE desktop_observations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'retired'))
  )`;
  yield* sql`CREATE INDEX desktop_observations_retention ON desktop_observations(state, sequence DESC)`;
  yield* sql`CREATE INDEX desktop_observations_thread ON desktop_observations(thread_id)`;
  yield* sql`CREATE TRIGGER desktop_observations_reject_deleted BEFORE INSERT ON desktop_observations
    WHEN EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id)
    BEGIN SELECT RAISE(ABORT, 'retired observation owner'); END`;
  // Keep the cleanup intent until its bytes have actually been removed. This
  // also fences a writer that was admitted immediately before thread deletion.
  yield* sql`CREATE TRIGGER desktop_observations_delete_thread AFTER INSERT ON hard_deleted_threads
    BEGIN UPDATE desktop_observations SET state = 'retired' WHERE thread_id = NEW.thread_id; END`;
});
