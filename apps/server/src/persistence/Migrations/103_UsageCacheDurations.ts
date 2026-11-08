import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Zero means no known subset, not that old writes had a particular TTL.
  yield* sql`ALTER TABLE usage_stats_token_breakdown_days ADD COLUMN cache_write_5m_input_tokens INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE usage_stats_token_breakdown_days ADD COLUMN cache_write_1h_input_tokens INTEGER NOT NULL DEFAULT 0`;
});
