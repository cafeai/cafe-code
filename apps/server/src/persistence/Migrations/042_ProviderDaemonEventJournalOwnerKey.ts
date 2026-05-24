import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE provider_daemon_events
    ADD COLUMN owner_key TEXT NOT NULL DEFAULT 'provider-daemon'
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_daemon_events_owner_cursor
    ON provider_daemon_events(owner_key, cursor)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_daemon_events_owner_emitted_at
    ON provider_daemon_events(owner_key, emitted_at)
  `;
});
