import { assert, it as effectIt } from "@effect/vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

effectIt("NodeSqliteClient statement diagnostics stay redacted and opt-in", () =>
  Effect.sync(() => {
    const records: unknown[] = [];
    const clock = [100, 131];
    const enabled = SqliteClient.makeSqliteStatementDiagnosticReporter({
      enabled: true,
      write: (record) => records.push(record),
      now: () => clock.shift() ?? 131,
      slowStatementMs: 25,
    });
    const sqlText = "SELECT value FROM private_entries WHERE token = ?";
    const secretParameter = "sk-never-log-this-value";

    const result = enabled(sqlText, 1, () => secretParameter.length);
    assert.equal(result, secretParameter.length);
    assert.equal(records.length, 2);
    const serialized = JSON.stringify(records);
    assert.equal(serialized.includes(sqlText), false);
    assert.equal(serialized.includes("private_entries"), false);
    assert.equal(serialized.includes(secretParameter), false);
    assert.deepInclude(records[0] as object, {
      phase: "start",
      operation: "select",
      parameterCount: 1,
    });
    assert.deepInclude(records[1] as object, {
      phase: "slow-complete",
      operation: "select",
      parameterCount: 1,
      durationMs: 31,
      outcome: "success",
    });

    const disabledRecords: unknown[] = [];
    const disabled = SqliteClient.makeSqliteStatementDiagnosticReporter({
      enabled: false,
      write: (record) => disabledRecords.push(record),
    });
    assert.equal(
      disabled(sqlText, 1, () => 42),
      42,
    );
    assert.deepStrictEqual(disabledRecords, []);
  }),
);

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

effectIt.effect("NodeSqliteClient classifies a second writer lock as retryable SqlError", () =>
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
      if (exit._tag !== "Failure") {
        return;
      }

      const failure = Cause.findErrorOption(exit.cause);
      assert.equal(Option.isSome(failure), true);
      if (Option.isNone(failure)) {
        return;
      }

      const error = failure.value;
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason._tag, "LockTimeoutError");
      assert.equal(error.isRetryable, true);

      // Preserve the real node:sqlite exception rather than a facade carrying
      // a synthesized `errno`. This keeps native stack/message/metadata intact
      // for local diagnostics while classification remains retryable.
      const nativeCause = error.reason.cause;
      assert.instanceOf(nativeCause, Error);
      assert.equal(Reflect.get(nativeCause as object, "code"), "ERR_SQLITE_ERROR");
      assert.equal(Reflect.get(nativeCause as object, "errcode"), 5);
      assert.equal(Reflect.has(nativeCause as object, "errno"), false);
    } finally {
      lockOwner.exec("ROLLBACK");
      lockOwner.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }),
);
