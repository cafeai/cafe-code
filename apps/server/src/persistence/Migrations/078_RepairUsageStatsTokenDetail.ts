import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Some shipped databases already recorded id 63 as WorkflowPersistence.
  // The numeric migration watermark then skipped UsageStatsTokenDetail,
  // breaking both history hydration and every subsequent usage flush. Repair
  // at a fresh id without rewriting migration history or replacing usage rows.
  // Inspect each table independently so partially widened schemas are safe too.
  for (const table of ["usage_stats_days", "usage_stats_token_breakdown_days"]) {
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
    const existing = new Set(columns.map((column) => column.name));
    for (const column of [
      "input_tokens",
      "cached_input_tokens",
      "cache_write_input_tokens",
      "reasoning_output_tokens",
    ]) {
      if (!existing.has(column)) {
        // Unrecorded historical detail cannot be inferred from output totals.
        yield* sql`ALTER TABLE ${sql.literal(table)} ADD COLUMN ${sql.literal(column)} INTEGER NOT NULL DEFAULT 0`;
      }
    }
  }
});
