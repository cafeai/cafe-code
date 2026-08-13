import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const DEFAULT_THREAD_MANUAL_FOLLOW_UPS_JSON = "[]";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN manual_follow_ups_json TEXT NOT NULL
    DEFAULT '[]'
  `;
});
