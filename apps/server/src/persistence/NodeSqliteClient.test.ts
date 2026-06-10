import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, it } from "vitest";

if (process.versions.bun !== undefined) {
  describe.skip("NodeSqliteClient", () => {
    it("requires the Node.js node:sqlite runtime module", () => {});
  });
} else {
  const SqliteClient = await import("./NodeSqliteClient.ts");

  const layer = effectIt.layer(SqliteClient.layerMemory());

  layer("NodeSqliteClient", (it) => {
    it.effect("runs prepared queries and returns positional values", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
        yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

        const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
        assert.equal(rows.length, 2);
        assert.equal(rows[0]?.name, "alpha");
        assert.equal(rows[1]?.name, "beta");

        const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
        assert.equal(values.length, 2);
        assert.equal(values[0]?.[1], "alpha");
        assert.equal(values[1]?.[1], "beta");
      }),
    );
  });

  const busyTimeoutLayer = effectIt.layer(SqliteClient.layerMemory({ busyTimeoutMs: 1234 }));

  busyTimeoutLayer("NodeSqliteClient busy timeout", (it) => {
    it.effect("configures sqlite to wait for transient writer locks", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;

        assert.equal(rows[0]?.timeout, 1234);
      }),
    );
  });
}
