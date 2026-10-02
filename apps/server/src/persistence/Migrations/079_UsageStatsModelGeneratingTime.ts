import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Historical generating_ms has no model identity. Start a separate ledger
  // prospectively, retaining every existing aggregate/token row untouched.
  // Canonical driver/model labels and integer durations are its only dimensions;
  // account, thread, prompt and native-session identities never enter this table.
  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_stats_model_generating_time_days (
      day TEXT NOT NULL,
      provider_driver TEXT NOT NULL,
      model TEXT NOT NULL,
      generating_ms INTEGER NOT NULL,
      PRIMARY KEY (day, provider_driver, model),
      CHECK (length(day) = 10),
      CHECK (length(provider_driver) BETWEEN 1 AND 64),
      CHECK (length(model) BETWEEN 1 AND 256),
      CHECK (typeof(generating_ms) = 'integer' AND generating_ms BETWEEN 0 AND 9007199254740991)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_stats_model_generating_time_metadata (
      singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
      started_at TEXT NOT NULL CHECK (length(started_at) = 24)
    )
  `;
  // SQLite's UTC migration timestamp is persisted once. Reopening the backend
  // or retrying an idempotent migration must never move the measurement boundary.
  yield* sql`
    INSERT OR IGNORE INTO usage_stats_model_generating_time_metadata (singleton, started_at)
    VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `;
});
