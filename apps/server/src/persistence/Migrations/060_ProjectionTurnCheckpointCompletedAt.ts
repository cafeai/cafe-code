import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Turn lifecycle completion and checkpoint observation are independent.
  // In particular, a Codex `turn/diff/updated` placeholder must remain visible
  // for deduplication while the provider turn is still running. Keeping the
  // timestamps in separate columns prevents checkpoint writes from making a
  // live turn look terminal. Existing rows fall back to `completed_at` in read
  // queries, so this migration stays a constant-time schema change and avoids
  // a startup backfill over long-lived databases.
  yield* sql`ALTER TABLE projection_turns ADD COLUMN checkpoint_completed_at TEXT`;
});
