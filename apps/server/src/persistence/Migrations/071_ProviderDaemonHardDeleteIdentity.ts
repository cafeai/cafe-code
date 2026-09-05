import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Add typed, indexed thread identity for daemon journals and command bodies.
 *
 * This migration is intentionally schema-only. Existing daemon journals can
 * be tens of gigabytes, so startup must never scan or JSON-decode historical
 * rows. New writes populate these empty sidecar tables transactionally. The
 * hard-delete path repairs legacy rows in small yielding pages for the one
 * thread being deleted, after the permanent tombstone has already fenced new
 * writes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // EventJournal historically created this table lazily. Hard-delete's local
  // fallback may open a store where the journal was never constructed, so the
  // schema migration makes exact quarantine cleanup universally available.
  // The definition intentionally matches EventJournal byte-for-byte.
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_daemon_event_quarantine (
      owner_key TEXT NOT NULL,
      cursor INTEGER NOT NULL,
      emitted_at TEXT NOT NULL,
      encoded_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      category TEXT NOT NULL,
      quarantined_at TEXT NOT NULL,
      PRIMARY KEY (owner_key, cursor)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_daemon_event_threads (
      cursor INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_daemon_event_threads_thread_cursor
    ON provider_daemon_event_threads(thread_id, cursor)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_daemon_command_threads (
      command_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      PRIMARY KEY (command_id, thread_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_daemon_command_threads_thread_command
    ON provider_daemon_command_threads(thread_id, command_id)
  `;

  // Commands such as runtime restart have no thread identity. A separate
  // marker distinguishes those fully decoded commands from legacy rows that
  // still need bounded on-demand hydration.
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_daemon_indexed_commands (
      command_id TEXT PRIMARY KEY
    ) WITHOUT ROWID
  `;

  // The body row and its typed identity are written in one transaction. If a
  // hard delete wins the SQLite writer lock first, these guards abort the
  // whole transaction before prompt/output material can survive the fence.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_daemon_event_threads_retired_insert
    BEFORE INSERT ON provider_daemon_event_threads
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'provider daemon thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_daemon_event_threads_retired_update
    BEFORE UPDATE ON provider_daemon_event_threads
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'provider daemon thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_daemon_command_threads_retired_insert
    BEFORE INSERT ON provider_daemon_command_threads
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'provider daemon thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_daemon_command_threads_retired_update
    BEFORE UPDATE ON provider_daemon_command_threads
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'provider daemon thread is permanently retired');
    END
  `;

  // Do not rely on every SQLite opener enabling foreign keys. These cleanup
  // triggers keep the small sidecars bounded when normal retention deletes a
  // journal row or when a command is purged.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_daemon_events_identity_cleanup
    AFTER DELETE ON provider_daemon_events
    BEGIN
      DELETE FROM provider_daemon_event_threads WHERE cursor = OLD.cursor;
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_daemon_commands_identity_cleanup
    AFTER DELETE ON provider_daemon_commands
    BEGIN
      DELETE FROM provider_daemon_command_threads WHERE command_id = OLD.command_id;
      DELETE FROM provider_daemon_indexed_commands WHERE command_id = OLD.command_id;
    END
  `;

  // Supervisor child rows do not carry thread_id themselves. Enforce their
  // parent boundary even when a legacy SQLite opener has foreign keys turned
  // off: after hard delete removes the exact parent session, a stale
  // supervisor callback must not recreate path/detail commitments as orphans.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_supervisor_ownership_parent_insert
    BEFORE INSERT ON provider_supervisor_ownership_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM provider_supervisor_sessions
      WHERE session_id = NEW.session_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'provider supervisor session no longer exists');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_supervisor_ownership_parent_update
    BEFORE UPDATE ON provider_supervisor_ownership_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM provider_supervisor_sessions
      WHERE session_id = NEW.session_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'provider supervisor session no longer exists');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_supervisor_io_parent_insert
    BEFORE INSERT ON provider_supervisor_io_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM provider_supervisor_sessions
      WHERE session_id = NEW.session_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'provider supervisor session no longer exists');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_supervisor_io_parent_update
    BEFORE UPDATE ON provider_supervisor_io_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM provider_supervisor_sessions
      WHERE session_id = NEW.session_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'provider supervisor session no longer exists');
    END
  `;
});
