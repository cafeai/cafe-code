import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * Widen usage stats from output tokens alone to the full token picture.
   *
   * Provider runtimes already report input, cached-input, cache-write and
   * reasoning counts on `thread.token-usage.updated`; until now the usage
   * service discarded everything except output. Cost is dominated by input on
   * every provider we ship — cached input in particular runs orders of
   * magnitude above output — so an output-only ledger cannot express spend or
   * cache savings at all.
   *
   * Existing rows are intentionally left at zero rather than back-filled: the
   * discarded counts were never recorded anywhere, so any backfill would be
   * invention. Historical days therefore show output only, and the UI reports
   * them as such rather than implying the input columns are truly zero.
   */
  for (const column of [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "reasoning_output_tokens",
  ]) {
    yield* sql`ALTER TABLE usage_stats_days ADD COLUMN ${sql.literal(column)} INTEGER NOT NULL DEFAULT 0`;
    yield* sql`ALTER TABLE usage_stats_token_breakdown_days ADD COLUMN ${sql.literal(column)} INTEGER NOT NULL DEFAULT 0`;
  }
});
