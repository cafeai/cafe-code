import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE glide_control_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL CHECK(revision>=0 AND revision<=9007199254740991)
  )`;
  yield* sql`INSERT INTO glide_control_state(singleton,revision) VALUES(1,0)`;
});
