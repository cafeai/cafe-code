import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE relay_invitations (
    id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE,
    network_id TEXT NOT NULL, host_key TEXT NOT NULL, environment_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('client', 'owner')),
    expires_at INTEGER NOT NULL, consumed_at INTEGER, revoked_at INTEGER
  )`;
  yield* sql`CREATE INDEX relay_invitations_expiry ON relay_invitations(expires_at)`;
  yield* sql`CREATE TABLE relay_device_sessions (
    network_id TEXT NOT NULL, host_key TEXT NOT NULL, device_key TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES auth_sessions(session_id), expires_at INTEGER NOT NULL,
    PRIMARY KEY(network_id, host_key, device_key, session_id)
  )`;
  yield* sql`CREATE INDEX relay_device_sessions_expiry ON relay_device_sessions(expires_at)`;
});
