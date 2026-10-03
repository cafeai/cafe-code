import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A standalone chat has no project association. Rebuild only the parent table,
 * preserving its complete installed schema rather than assuming a historical
 * column list. SQLite's DROP TABLE performs ON DELETE CASCADE even inside a
 * deferred-foreign-key transaction, so explicitly retain both generations of
 * subagent provenance and attachment commitments before replacing the parent.
 * The migrator wraps this operation in one transaction: interruption/failure
 * rolls back the parent and every child together.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const schemas = yield* sql<{ type: string; name: string; sql: string | null }>`
    SELECT type, name, sql FROM sqlite_schema
    WHERE tbl_name = 'projection_threads'
    ORDER BY type, name
  `;
  const parent = schemas.find((row) => row.type === "table");
  if (!parent?.sql) return yield* Effect.die("Missing thread projection schema");
  const columns = yield* sql<{
    name: string;
    notnull: number;
  }>`PRAGMA table_info(projection_threads)`;
  if (columns.find((column) => column.name === "project_id")?.notnull === 1) {
    const tables = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;
    // Restore only the known cascade descendants. An unexpected extension
    // must fail before mutation rather than losing its unqualified child rows.
    const expectedChildren = new Map([
      ["attachment_content_commitments", "projection_threads"],
      ["provider_subagent_history_roots", "projection_threads"],
      ["provider_subagent_history_bindings", "provider_subagent_history_roots"],
    ]);
    for (const table of tables) {
      const quotedName = `"${table.name.replaceAll('"', '""')}"`;
      const references = yield* sql.unsafe<{ table: string }>(
        `PRAGMA foreign_key_list(${quotedName})`,
      );
      for (const reference of references) {
        if (
          (reference.table === "projection_threads" ||
            reference.table === "provider_subagent_history_roots" ||
            reference.table === "provider_subagent_history_bindings") &&
          expectedChildren.get(table.name) !== reference.table
        ) {
          return yield* Effect.die("Unexpected thread projection foreign key dependency");
        }
      }
    }
    const deleteTriggers = yield* sql`SELECT name FROM sqlite_schema WHERE type = 'trigger'
      AND tbl_name IN ('attachment_content_commitments', 'provider_subagent_history_roots', 'provider_subagent_history_bindings')
      AND (upper(sql) LIKE '%BEFORE DELETE%' OR upper(sql) LIKE '%AFTER DELETE%')`;
    if (deleteTriggers.length > 0)
      return yield* Effect.die("Unexpected thread cascade deletion trigger");
    // A durable retirement tombstone can legitimately coexist with these
    // children while asynchronous hard-delete cleanup is interrupted. Snapshot
    // only the two shipped INSERT fences: copying existing rows is not new
    // admission, and their exact installed SQL must be restored before commit.
    // Missing/misbound guards fail before mutation; unrelated triggers and all
    // FK/table constraints stay active throughout the rebuild.
    const childAdmissionTables = new Map([
      ["trg_provider_subagent_roots_hard_deleted_thread_insert", "provider_subagent_history_roots"],
      [
        "trg_provider_subagent_bindings_hard_deleted_thread_insert",
        "provider_subagent_history_bindings",
      ],
    ]);
    const childAdmissionTriggers = yield* sql<{ name: string; tbl_name: string; sql: string }>`
      SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' AND sql IS NOT NULL
      AND name IN ('trg_provider_subagent_roots_hard_deleted_thread_insert', 'trg_provider_subagent_bindings_hard_deleted_thread_insert')
      ORDER BY name
    `;
    if (
      childAdmissionTriggers.length !== childAdmissionTables.size ||
      childAdmissionTriggers.some(
        (trigger) => !trigger.sql || childAdmissionTables.get(trigger.name) !== trigger.tbl_name,
      )
    ) {
      return yield* Effect.die("Unexpected thread child admission trigger schema");
    }
    const replacement = parent.sql
      .replace(
        /CREATE TABLE(?: IF NOT EXISTS)?\s+["`\[]?projection_threads["`\]]?/i,
        "CREATE TABLE projection_threads_standalone_next",
      )
      .replace(/\bproject_id\s+TEXT\s+NOT\s+NULL\b/i, "project_id TEXT");
    if (replacement === parent.sql || /\bproject_id\s+TEXT\s+NOT\s+NULL\b/i.test(replacement)) {
      return yield* Effect.die("Unexpected thread projection schema");
    }
    // Child backups are temporary connection-local tables and contain no new
    // durable copies of credentials, provider cursors or private file hashes.
    yield* sql`CREATE TEMP TABLE standalone_attachment_backup AS SELECT * FROM attachment_content_commitments`;
    yield* sql`CREATE TEMP TABLE standalone_subagent_roots_backup AS SELECT * FROM provider_subagent_history_roots`;
    yield* sql`CREATE TEMP TABLE standalone_subagent_bindings_backup AS SELECT * FROM provider_subagent_history_bindings`;
    yield* sql.unsafe(replacement);
    const names = columns.map((column) => `"${column.name.replaceAll('"', '""')}"`).join(", ");
    yield* sql.unsafe(
      `INSERT INTO projection_threads_standalone_next (${names}) SELECT ${names} FROM projection_threads`,
    );
    yield* sql`DROP TABLE projection_threads`;
    yield* sql`ALTER TABLE projection_threads_standalone_next RENAME TO projection_threads`;
    for (const schema of schemas) {
      if ((schema.type === "index" || schema.type === "trigger") && schema.sql) {
        yield* sql.unsafe(schema.sql);
      }
    }
    // Restore parents before grandchildren. The migration's writer transaction
    // excludes concurrent admission while these known INSERT guards are absent.
    // Reinstall them exactly before completing so retired identities remain
    // fenced for all subsequent writers, including direct UPDATE/UPSERT paths.
    for (const trigger of childAdmissionTriggers) {
      yield* sql.unsafe(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    }
    yield* sql`INSERT INTO attachment_content_commitments SELECT * FROM standalone_attachment_backup`;
    yield* sql`INSERT INTO provider_subagent_history_roots SELECT * FROM standalone_subagent_roots_backup`;
    yield* sql`INSERT INTO provider_subagent_history_bindings SELECT * FROM standalone_subagent_bindings_backup`;
    for (const trigger of childAdmissionTriggers) {
      yield* sql.unsafe(trigger.sql);
    }
    yield* sql`DROP TABLE standalone_attachment_backup`;
    yield* sql`DROP TABLE standalone_subagent_roots_backup`;
    yield* sql`DROP TABLE standalone_subagent_bindings_backup`;
    const violations = yield* sql`PRAGMA foreign_key_check`;
    if (violations.length > 0)
      return yield* Effect.die("Thread projection foreign key integrity failure");
  }

  // Cwd ownership is private server state. The renderer supplies a ThreadId,
  // never a filesystem path or reusable workspace identifier. No cascading
  // delete: hard-delete cleanup retains ownership until files are removed.
  yield* sql`
    CREATE TABLE IF NOT EXISTS standalone_thread_workspaces (
      thread_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      directory_device TEXT,
      directory_inode TEXT,
      cleanup_name TEXT,
      fork_operation_id TEXT
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_standalone_workspace_owners ON standalone_thread_workspaces(workspace_id, thread_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS standalone_workspace_root_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    directory_device TEXT NOT NULL,
    directory_inode TEXT NOT NULL
  ) WITHOUT ROWID`;

  // Checkpoint history survives a deliberate project association change, but
  // its Git refs never acquire authority over the destination repository. This
  // private projection fence is committed with the metadata projection and is
  // copied with conversation history. Event sequence supplies a stable ref
  // namespace on replay; returning to the original project still starts a new
  // baseline rather than reviving an older workspace snapshot accidentally.
  yield* sql`CREATE TABLE IF NOT EXISTS thread_checkpoint_workspace_fences (
    thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    invalid_through_turn_count INTEGER NOT NULL CHECK (invalid_through_turn_count >= 0),
    association_sequence INTEGER NOT NULL CHECK (association_sequence > 0),
    changed_at TEXT NOT NULL
  ) WITHOUT ROWID`;
  // Fence exact historical native turn identities as well as counts. A late
  // backfill may acquire a newly allocated count after the move; provider and
  // server clocks cannot establish authority over destination files.
  yield* sql`CREATE TABLE IF NOT EXISTS thread_checkpoint_retired_turns (
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    PRIMARY KEY(thread_id, turn_id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE IF NOT EXISTS thread_checkpoint_request_epochs (
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    association_sequence INTEGER NOT NULL CHECK (association_sequence > 0),
    PRIMARY KEY(thread_id, message_id)
  ) WITHOUT ROWID`;
});
