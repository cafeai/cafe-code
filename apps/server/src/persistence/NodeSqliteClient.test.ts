import { assert, it as effectIt } from "@effect/vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

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

      const streamed = yield* Stream.runCollect(
        sql<{ readonly name: string }>`SELECT name FROM entries ORDER BY id`.stream,
      );
      assert.deepStrictEqual([...streamed], [{ name: "alpha" }, { name: "beta" }]);
    }),
  );

  it.effect("commits successful transactions and rolls back failures", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE transactions(value TEXT NOT NULL)`;

      yield* sql.withTransaction(sql`INSERT INTO transactions(value) VALUES (${"committed"})`);
      yield* Effect.flip(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO transactions(value) VALUES (${"rolled-back"})`;
            return yield* Effect.fail("force rollback");
          }),
        ),
      );

      const rows = yield* sql<{ readonly value: string }>`SELECT value FROM transactions`;
      assert.deepStrictEqual(rows, [{ value: "committed" }]);
    }),
  );

  it.effect("supports raw and unprepared statement execution", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE execution_modes(value INTEGER NOT NULL)`;

      const raw = yield* sql`INSERT INTO execution_modes(value) VALUES (${42})`.raw;
      assert.isObject(raw);
      const rows = yield* sql<{ readonly value: number }>`SELECT value FROM execution_modes`
        .unprepared;
      assert.deepStrictEqual(rows, [{ value: 42 }]);
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

effectIt.effect("NodeSqliteClient closes file databases and reopens their data", () =>
  Effect.gen(function* () {
    const directory = mkdtempSync(join(tmpdir(), "cafecode-node-sqlite-reopen-"));
    const filename = join(directory, "state.sqlite");
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE durable(value TEXT NOT NULL)`;
          yield* sql`INSERT INTO durable(value) VALUES (${"persisted"})`;
        }).pipe(Effect.provide(SqliteClient.layer({ filename }))),
      );

      const rows = yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly value: string }>`SELECT value FROM durable`;
        }).pipe(Effect.provide(SqliteClient.layer({ filename }))),
      );
      assert.deepStrictEqual(rows, [{ value: "persisted" }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }),
);

effectIt.effect("NodeSqliteClient reports writer lock contention through SqlError", () =>
  Effect.gen(function* () {
    const directory = mkdtempSync(join(tmpdir(), "cafecode-node-sqlite-lock-"));
    const filename = join(directory, "state.sqlite");
    const lockOwner = new DatabaseSync(filename);
    try {
      lockOwner.exec("CREATE TABLE locked(value TEXT NOT NULL); BEGIN IMMEDIATE;");
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO locked(value) VALUES (${"blocked"})`;
        }).pipe(Effect.provide(SqliteClient.layer({ filename, busyTimeoutMs: 25 })), Effect.exit),
      );
      assert.equal(exit._tag, "Failure");
    } finally {
      lockOwner.exec("ROLLBACK");
      lockOwner.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }),
);
