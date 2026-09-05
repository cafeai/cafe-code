import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // These are Cafe-minted counter epochs, never provider account/session IDs.
  // Retaining the compact final checkpoint makes replay idempotent even after
  // the live query and backend have both restarted. Historical usage cannot
  // be repaired: the previously missing request counters were not persisted.
  yield* sql`
    CREATE TABLE usage_accounting_checkpoints (
      provider_driver TEXT NOT NULL,
      scope_id TEXT NOT NULL CHECK(length(scope_id) = 36),
      revision INTEGER NOT NULL CHECK(revision > 0),
      snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) <= 131072),
      PRIMARY KEY (provider_driver, scope_id)
    )
  `;
});
