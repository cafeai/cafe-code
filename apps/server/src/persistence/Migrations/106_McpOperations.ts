import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Receipts contain only public mutation identifiers/metadata, never inputs,
  // messages, settings, secrets or native callback-consumption evidence.
  yield* sql`
    CREATE TABLE mcp_operations (
      owner_hash TEXT NOT NULL CHECK (length(owner_hash) = 64),
      request_id TEXT NOT NULL CHECK (length(request_id) <= 128),
      tool TEXT NOT NULL CHECK (length(tool) <= 128),
      input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
      state TEXT NOT NULL CHECK (state IN ('unconfirmed', 'recorded', 'scheduled', 'completed', 'failed')),
      result_json TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 65536)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (owner_hash, request_id)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX idx_mcp_operations_expiry ON mcp_operations(expires_at)`;
});
