import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Schema-only. Existing Working records deliberately receive no guessed
 * runtime identity, and no transcript/event history is scanned at readiness.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN subagent_runtime_id TEXT
    CHECK (subagent_runtime_id IS NULL OR length(subagent_runtime_id) = 36)`;
});
