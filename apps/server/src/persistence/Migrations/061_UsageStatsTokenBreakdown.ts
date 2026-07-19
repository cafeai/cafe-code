import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * Daily output-token attribution starts with this migration. Existing
   * `usage_stats_days` rows cannot be backfilled truthfully because they do not
   * contain provider or model identity, so this migration intentionally leaves
   * historical aggregate totals untouched.
   *
   * `provider_driver` records only the canonical implementation kind (for
   * example `codex` or `claudeAgent`). Provider instance/account ids are not
   * part of this table. Length checks bound externally supplied model names and
   * keep the composite primary-key index resistant to malformed runtime data.
   */
  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_stats_token_breakdown_days (
      day TEXT NOT NULL,
      provider_driver TEXT NOT NULL,
      model TEXT NOT NULL,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, provider_driver, model),
      CHECK (length(day) = 10),
      CHECK (length(provider_driver) BETWEEN 1 AND 64),
      CHECK (length(model) BETWEEN 1 AND 256),
      CHECK (typeof(output_tokens) = 'integer' AND output_tokens >= 0)
    ) WITHOUT ROWID
  `;
});
