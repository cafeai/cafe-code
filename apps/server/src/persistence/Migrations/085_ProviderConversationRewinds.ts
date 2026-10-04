import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** One bounded private transaction per Cafe identity. A crash never expires a
 * rewind reservation: resuming the wrong native history is worse than asking
 * for explicit recovery. No provider transcripts are copied into this table. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE provider_conversation_rewinds (
      thread_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL CHECK (phase IN ('preparing','prepared','switching','committed','aborted','finished','refused')),
      provider_instance_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      expected_control_sequence INTEGER NOT NULL,
      retained_turn_count INTEGER NOT NULL,
      removed_turn_count INTEGER NOT NULL,
      first_removed_turn_id TEXT NOT NULL,
      original_session_json TEXT NOT NULL CHECK (length(original_session_json) <= 1048576),
      candidate_session_json TEXT CHECK (length(candidate_session_json) <= 1048576),
      FOREIGN KEY (thread_id) REFERENCES provider_session_runtime(thread_id) ON DELETE CASCADE
    )
  `;
  // Ordinary heartbeats, inventory reconciliation and older backend writers
  // cannot replace a binding while its native/filesystem transaction is open.
  // The coordinator's switching state exists only inside one SQL transaction.
  yield* sql`
    CREATE TRIGGER trg_provider_rewind_binding_guard BEFORE UPDATE ON provider_session_runtime
    WHEN EXISTS (SELECT 1 FROM provider_conversation_rewinds r
      WHERE r.thread_id = OLD.thread_id AND r.phase IN ('preparing','prepared','committed'))
    BEGIN SELECT RAISE(ABORT, 'Provider conversation rewind is reserved'); END
  `;
  yield* sql`
    CREATE TRIGGER trg_provider_rewind_delete_guard BEFORE DELETE ON provider_session_runtime
    WHEN EXISTS (SELECT 1 FROM provider_conversation_rewinds r
      WHERE r.thread_id = OLD.thread_id AND r.phase IN ('preparing','prepared','committed'))
      AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads t WHERE t.thread_id = OLD.thread_id)
    BEGIN SELECT RAISE(ABORT, 'Provider conversation rewind is reserved'); END
  `;
});
