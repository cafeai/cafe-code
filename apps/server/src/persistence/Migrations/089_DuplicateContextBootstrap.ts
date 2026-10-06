import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Projection-only admission for a visible-context copy, never a native fork.
 * The small row survives idle native materialization and backend restarts. It
 * is consumed by an accepted owner turn, not by merely opening a session.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE projection_thread_context_bootstraps (
      thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      pending INTEGER NOT NULL CHECK(pending IN (0, 1))
    ) WITHOUT ROWID
  `;
  // The projection is written inside event transactions, but its database
  // boundary must also reject stale workers during coordinated hard deletion.
  yield* sql`
    CREATE TRIGGER trg_context_bootstrap_hard_deleted_insert
    BEFORE INSERT ON projection_thread_context_bootstraps
    WHEN EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id)
    BEGIN SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired'); END
  `;
  yield* sql`
    CREATE TRIGGER trg_context_bootstrap_hard_deleted_update
    BEFORE UPDATE ON projection_thread_context_bootstraps
    WHEN EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id)
    BEGIN SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired'); END
  `;
});
