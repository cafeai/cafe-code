import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Prospective native-opening provenance only. Legacy sessions remain unknown;
 * neither their saved context nor historical usage can prove which nominal
 * auto-compaction request the actual process received. No transcript backfill
 * or historical command rewrite is permitted by this additive migration.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_thread_sessions
    ADD COLUMN codex_auto_compact_token_limit INTEGER
    CHECK (codex_auto_compact_token_limit IS NULL OR
      (typeof(codex_auto_compact_token_limit) = 'integer' AND
        codex_auto_compact_token_limit BETWEEN 1 AND 9007199254740991))
  `;
  yield* sql`
    ALTER TABLE projection_thread_sessions
    ADD COLUMN codex_auto_compact_token_limit_known INTEGER NOT NULL DEFAULT 0
    CHECK (codex_auto_compact_token_limit_known IN (0, 1) AND
      (codex_auto_compact_token_limit_known = 1 OR codex_auto_compact_token_limit IS NULL))
  `;
});
