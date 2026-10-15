import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Exact decimal amounts and their measured token share are independent of
  // historical rate estimates. Old observations cannot be retroactively billed.
  yield* sql`ALTER TABLE usage_stats_token_breakdown_days ADD COLUMN reported_cost_json TEXT`;
});
