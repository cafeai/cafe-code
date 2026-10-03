import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Schema-only: no transcript/event scan or guessed historical policy at startup. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN subagent_limits_json TEXT`;
  yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN max_concurrent_subagents INTEGER
    CHECK (max_concurrent_subagents IS NULL OR
      (typeof(max_concurrent_subagents) = 'integer' AND max_concurrent_subagents BETWEEN 1 AND 64))`;
  yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN max_concurrent_subagents_known INTEGER NOT NULL DEFAULT 0
    CHECK (max_concurrent_subagents_known IN (0, 1) AND
      (max_concurrent_subagents_known = 1 OR max_concurrent_subagents IS NULL))`;
});
