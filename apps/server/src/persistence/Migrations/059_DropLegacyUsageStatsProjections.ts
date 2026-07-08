import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Remove the tables from an earlier, abandoned usage-stats attempt (its
  // `057_ProjectionUsageStats` migration). The current feature uses only
  // `usage_stats_days`; these projection tables are orphaned. No-op on
  // databases that never ran that attempt.
  yield* sql`DROP TABLE IF EXISTS projection_usage_stats_rollups`;
  yield* sql`DROP TABLE IF EXISTS projection_thread_usage_stats_latest`;
});
