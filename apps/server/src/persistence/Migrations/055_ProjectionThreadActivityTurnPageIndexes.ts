import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Historical work-log pages are loaded by turn. The previous activity indexes
  // were thread-level, so a page/count request for one old turn in a large
  // long-running thread still walked unrelated activity rows and then evaluated
  // JSON visibility predicates. Keep both the ordered page and count paths on a
  // narrow thread+turn range before any payload JSON is touched.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_turn_order
    ON projection_thread_activities(
      thread_id,
      turn_id,
      (CASE WHEN sequence IS NULL THEN 0 ELSE 1 END),
      sequence,
      created_at,
      activity_id
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_turn_kind_created_id
    ON projection_thread_activities(thread_id, turn_id, kind, created_at, activity_id)
  `;
});
