import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE virtual_desktops (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, incarnation TEXT NOT NULL,
    directory TEXT NOT NULL, boot_id TEXT NOT NULL, pid INTEGER,
    process_start TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL
  ) WITHOUT ROWID`;
  // Drafts already have a future thread id. Keep their association outside the
  // transcript projection, and let hard deletion remove it authoritatively.
  yield* sql`CREATE TABLE virtual_desktop_attachments (
    thread_id TEXT PRIMARY KEY, desktop_id TEXT NOT NULL REFERENCES virtual_desktops(id),
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX virtual_desktop_attachment_id ON virtual_desktop_attachments(desktop_id)`;
  yield* sql`CREATE TRIGGER virtual_desktop_reject_retired_thread BEFORE INSERT ON virtual_desktop_attachments
    WHEN EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id)
    BEGIN SELECT RAISE(ABORT, 'retired desktop owner'); END`;
  yield* sql`CREATE TRIGGER virtual_desktop_retire_thread AFTER INSERT ON hard_deleted_threads
    BEGIN DELETE FROM virtual_desktop_attachments WHERE thread_id = NEW.thread_id; END`;
});
