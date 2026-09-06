import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Future draft thread ids do not yet exist in projection_threads. Keep a
  // separate private upload ledger, with the permanent deletion tombstone as
  // its admission fence. Legacy uploads have no row and are never age-pruned.
  yield* sql`
    CREATE TABLE file_attachment_uploads (
      attachment_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('writing', 'provisional', 'retained', 'deleting')),
      expires_at INTEGER NOT NULL,
      writer_pid INTEGER NOT NULL CHECK (writer_pid > 0)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX idx_file_attachment_upload_expiry ON file_attachment_uploads(state, expires_at, attachment_id)`;
  yield* sql`CREATE INDEX idx_file_attachment_upload_thread ON file_attachment_uploads(thread_id, attachment_id)`;
  yield* sql`
    CREATE TRIGGER file_attachment_upload_reject_retired_thread
    BEFORE INSERT ON file_attachment_uploads
    WHEN EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id)
    BEGIN SELECT RAISE(ABORT, 'retired attachment owner'); END
  `;
  // A normalized immutable commitment is permanent protection. Removing its
  // lifecycle row makes future cleanup independent of message/queue replay.
  yield* sql`
    CREATE TRIGGER file_attachment_upload_promote_commitment
    AFTER INSERT ON attachment_content_commitments
    BEGIN DELETE FROM file_attachment_uploads WHERE attachment_id = NEW.attachment_id; END
  `;
  // Hard deletion is explicit authorization to release retained references.
  // Mark them eligible without an unbounded periodic join over old threads.
  // Leave active writers alone: their final upload check compensates deletion,
  // and a crashed writer is reclaimed only after its process is absent.
  yield* sql`
    CREATE TRIGGER file_attachment_upload_retire_thread
    AFTER INSERT ON hard_deleted_threads
    BEGIN
      UPDATE file_attachment_uploads SET state = 'provisional', expires_at = 0
      WHERE thread_id = NEW.thread_id AND state IN ('provisional', 'retained');
    END
  `;
});
