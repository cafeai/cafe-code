import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_daemon_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      emitted_at TEXT NOT NULL,
      event_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_daemon_events_emitted_at
    ON provider_daemon_events(emitted_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_daemon_commands (
      command_id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_daemon_commands_status
    ON provider_daemon_commands(status)
  `;
});
