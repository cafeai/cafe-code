import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE projection_auto_nudge_authority (
      singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'global'),
      authority_revision INTEGER NOT NULL CHECK (authority_revision >= 0),
      status TEXT NOT NULL CHECK (status IN ('allowed', 'stopped')),
      stopped_at TEXT,
      updated_at TEXT NOT NULL,
      CHECK (
        (status = 'allowed' AND stopped_at IS NULL) OR
        (status = 'stopped' AND stopped_at IS NOT NULL)
      )
    )
  `;
  yield* sql`
    INSERT INTO projection_auto_nudge_authority (
      singleton_key,
      authority_revision,
      status,
      stopped_at,
      updated_at
    ) VALUES ('global', 0, 'allowed', NULL, '1970-01-01T00:00:00.000Z')
  `;
  yield* sql`
    UPDATE projection_threads
    SET auto_nudge_json = json_set(auto_nudge_json, '$.globalAuthorityRevision', 0)
    WHERE json_extract(auto_nudge_json, '$.globalAuthorityRevision') IS NULL
  `;
});
