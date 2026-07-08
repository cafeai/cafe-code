import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Aggregated usage counters, one row per server-local day (`YYYY-MM-DD`).
  // The UsageStatsService accumulates deltas in memory and flushes them here
  // every few seconds; lifetime totals are the sum over all rows.
  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_stats_days (
      day TEXT PRIMARY KEY,
      generating_ms INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      user_messages INTEGER NOT NULL DEFAULT 0
    )
  `;
});
