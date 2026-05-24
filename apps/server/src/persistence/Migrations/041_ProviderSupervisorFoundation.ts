import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_supervisor_sessions (
      session_id TEXT PRIMARY KEY,
      supervisor_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL,
      thread_id TEXT,
      provider_instance_id TEXT,
      provider_kind TEXT,
      provider_pid INTEGER,
      command_display TEXT,
      cwd TEXT,
      socket_path TEXT,
      protocol_version INTEGER NOT NULL,
      io_generation INTEGER NOT NULL,
      raw_byte_cursor INTEGER NOT NULL,
      parser_cursor INTEGER NOT NULL,
      transfer_state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_attached_at TEXT,
      last_detached_at TEXT,
      last_error TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_supervisor_sessions_owner
    ON provider_supervisor_sessions(owner_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_supervisor_sessions_thread
    ON provider_supervisor_sessions(thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_supervisor_sessions_transfer_state
    ON provider_supervisor_sessions(transfer_state)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_supervisor_ownership_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      previous_owner_id TEXT,
      io_generation INTEGER NOT NULL,
      transfer_state TEXT NOT NULL,
      emitted_at TEXT NOT NULL,
      detail_json TEXT,
      FOREIGN KEY(session_id) REFERENCES provider_supervisor_sessions(session_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_supervisor_ownership_events_session
    ON provider_supervisor_ownership_events(session_id, event_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_supervisor_io_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      stream_kind TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      emitted_at TEXT NOT NULL,
      sha256 TEXT,
      FOREIGN KEY(session_id) REFERENCES provider_supervisor_sessions(session_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_supervisor_io_events_session
    ON provider_supervisor_io_events(session_id, cursor)
  `;
});
