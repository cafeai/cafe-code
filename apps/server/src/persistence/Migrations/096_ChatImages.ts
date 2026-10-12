import recoveryPresentationIndex from "./093_RecoveryPresentationIndex.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const chatImageSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Bounded raster bytes are committed with their ownership in one transaction.
  // No filesystem/SQL split publication or orphan-file cleanup is required.
  yield* sql`CREATE TABLE IF NOT EXISTS chat_image_assets (
    digest TEXT PRIMARY KEY, bytes BLOB NOT NULL, metadata_json TEXT NOT NULL
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE IF NOT EXISTS chat_message_images (
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    source TEXT NOT NULL,
    digest TEXT NOT NULL REFERENCES chat_image_assets(digest),
    PRIMARY KEY (thread_id, message_id, source),
    FOREIGN KEY (thread_id, message_id)
      REFERENCES projection_thread_messages(thread_id, message_id) ON DELETE CASCADE
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX IF NOT EXISTS chat_message_images_digest ON chat_message_images(digest)`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS chat_image_owner BEFORE INSERT ON chat_message_images
    WHEN NOT EXISTS (SELECT 1 FROM projection_thread_messages
      WHERE thread_id = NEW.thread_id AND message_id = NEW.message_id AND role = 'assistant')
      OR EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id)
    BEGIN SELECT RAISE(ABORT, 'invalid image owner'); END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS chat_image_release AFTER DELETE ON chat_message_images
    BEGIN DELETE FROM chat_image_assets WHERE digest = OLD.digest
      AND NOT EXISTS (SELECT 1 FROM chat_message_images WHERE digest = OLD.digest); END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS chat_image_retire AFTER INSERT ON hard_deleted_threads
    BEGIN DELETE FROM chat_message_images WHERE thread_id = NEW.thread_id; END`;
});

// Local development recorded ChatImages at id 93 before upstream used that id.
// Preserve its ledger and image ownership. Reconcile the missing idempotent
// upstream index and image schema here for both database histories.
export default recoveryPresentationIndex.pipe(Effect.andThen(chatImageSchema));
