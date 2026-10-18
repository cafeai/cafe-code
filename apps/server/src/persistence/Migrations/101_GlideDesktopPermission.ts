import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE glide_thread_preferences ADD COLUMN desktop INTEGER NOT NULL DEFAULT 0 CHECK(desktop IN (0,1))`;
});
