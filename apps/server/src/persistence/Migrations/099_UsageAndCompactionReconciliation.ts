import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import codexAutoCompactRequest from "./098_CodexAutoCompactRequest.ts";
import reportedUsageCosts from "./098_ReportedUsageCosts.ts";

/**
 * Local and upstream builds independently shipped different additive schemas at
 * id 98. The migrator skips numeric ids, so retain each recorded history and
 * apply only its missing counterpart inside this migration's transaction.
 * Fresh databases use ReportedUsageCosts at 98. Unknown histories must not be
 * guessed from partial schema evidence or silently marked as reconciled.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ name: string }>`
    SELECT name FROM effect_sql_migrations WHERE migration_id = 98
  `;
  switch (rows[0]?.name) {
    case "ReportedUsageCosts":
      yield* codexAutoCompactRequest;
      break;
    case "CodexAutoCompactRequest":
      yield* reportedUsageCosts;
      break;
    default:
      return yield* Effect.die(new Error("Unrecognized database migration 98 lineage."));
  }
});
