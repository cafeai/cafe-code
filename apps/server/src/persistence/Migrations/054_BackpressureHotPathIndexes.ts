import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Streaming assistant deltas should normally use the thread-scoped primary
  // key, but this secondary index protects older/global message-id lookups from
  // falling back to a table scan on databases with large message histories.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_message_thread
    ON projection_thread_messages(message_id, thread_id)
  `;

  // Thread shell summaries only care about a small set of activity kinds.
  // Without kind in the index, long-lived threads pay for scanning unrelated
  // tool/context/checkpoint activity before extracting request ids from JSON.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_kind_created_id
    ON projection_thread_activities(thread_id, kind, created_at, activity_id)
  `;
});
