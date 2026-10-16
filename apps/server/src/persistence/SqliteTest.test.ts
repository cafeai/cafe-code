import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { SqlitePersistenceTest, snapshotSqliteDatabase } from "./Sqlite.test.fixture.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

it("retains seed values, generated columns, indexes, triggers, views and sequences in independent snapshots", () => {
  const source = new DatabaseSync(":memory:");
  const first = new DatabaseSync(":memory:");
  const second = new DatabaseSync(":memory:");
  try {
    source.exec(`
      CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT UNIQUE);
      CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), bytes BLOB, big INTEGER, derived INTEGER GENERATED ALWAYS AS (id + 1) STORED);
      CREATE INDEX child_parent ON child(parent_id);
      CREATE TABLE audit(value TEXT);
      CREATE TRIGGER audit_parent AFTER INSERT ON parent BEGIN INSERT INTO audit VALUES (new.value); END;
      CREATE VIEW names AS SELECT value FROM parent;
      INSERT INTO parent(value) VALUES ('seed''s value');
      INSERT INTO parent(value) VALUES ('temporary');
      DELETE FROM parent WHERE value = 'temporary';
      DELETE FROM audit WHERE value = 'temporary';
      INSERT INTO child(id,parent_id,bytes,big) VALUES (1,1,X'0001FF',9223372036854775807);
      PRAGMA user_version = 7;
      PRAGMA application_id = 13;
    `);
    const snapshot = snapshotSqliteDatabase(source);
    first.exec(snapshot);
    second.exec(snapshot);
    expect(first.prepare("SELECT value FROM names").get()?.value).toBe("seed's value");
    expect(
      first.prepare("SELECT hex(bytes) AS bytes, quote(big) AS big, derived FROM child").get(),
    ).toEqual({ bytes: "0001FF", big: "9223372036854775807", derived: 2 });
    expect(first.prepare("SELECT count(*) AS count FROM audit").get()?.count).toBe(1);
    expect(() => first.exec("INSERT INTO parent(value) VALUES ('seed''s value')")).toThrow();
    expect(() => first.exec("INSERT INTO child(id,parent_id) VALUES (2,999)")).toThrow();
    first.exec("INSERT INTO parent(value) VALUES ('new')");
    expect(first.prepare("SELECT id FROM parent WHERE value = 'new'").get()?.id).toBe(3);
    expect(first.prepare("SELECT count(*) AS count FROM audit").get()?.count).toBe(2);
    expect(second.prepare("SELECT count(*) AS count FROM parent").get()?.count).toBe(1);
    expect(first.prepare("SELECT name,seq FROM sqlite_sequence").all()).toEqual([
      { name: "parent", seq: 3 },
    ]);
    first.exec("BEGIN; DELETE FROM parent WHERE id = 3; ROLLBACK;");
    expect(first.prepare("SELECT count(*) AS count FROM parent").get()?.count).toBe(2);
    expect(first.prepare("PRAGMA user_version").get()?.user_version).toBe(7);
    expect(first.prepare("PRAGMA application_id").get()?.application_id).toBe(13);
    expect(
      first
        .prepare("PRAGMA index_list(child)")
        .all()
        .some((row) => row.name === "child_parent"),
    ).toBe(true);
  } finally {
    first.close();
    second.close();
    source.close();
  }
});

it("closes the exact database transferred to its scoped SQL layer", async () => {
  const database = new DatabaseSync(":memory:");
  const runtime = ManagedRuntime.make(
    NodeSqliteClient.layerWithDatabase({ filename: ":memory:" }, () => database),
  );
  try {
    expect(
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`SELECT 1 AS ready`;
        }),
      ),
    ).toEqual([{ ready: 1 }]);
  } finally {
    await runtime.dispose();
  }
  expect(() => database.prepare("SELECT 1")).toThrow();
});

it("matches the current real migration schema and seed data with fresh scoped ownership", async () => {
  const real = ManagedRuntime.make(SqlitePersistenceMemory);
  const first = ManagedRuntime.make(SqlitePersistenceTest);
  const second = ManagedRuntime.make(SqlitePersistenceTest);
  const inspect = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const schema = yield* sql<{
      type: string;
      name: string;
      sql: string;
    }>`SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name`;
    const data: Record<string, ReadonlyArray<unknown>> = {};
    for (const table of schema.filter((row) => row.type === "table")) {
      data[table.name] = yield* sql.unsafe(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`);
    }
    // Independently migrated databases have different recorded migration
    // times. A snapshot retains its original boundary, like an existing DB.
    // Keep every seed row/value assertion and qualify those two clock fields.
    for (const table of ["usage_stats_model_generating_time_metadata", "effect_sql_migrations"]) {
      data[table] = data[table]!.map((value) => {
        const row = { ...(value as Record<string, unknown>) };
        const field = table === "effect_sql_migrations" ? "created_at" : "started_at";
        if (field in row) {
          expect(Number.isFinite(Date.parse(String(row[field])))).toBe(true);
          row[field] = "qualified migration time";
        }
        return row;
      });
    }
    return { schema, data };
  });
  try {
    const baseline = await real.runPromise(inspect);
    expect(await first.runPromise(inspect)).toEqual(baseline);
    expect(await second.runPromise(inspect)).toEqual(baseline);
    await first.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE fixture_private(value TEXT)`;
        yield* sql`INSERT INTO fixture_private VALUES ('first')`;
      }),
    );
    expect(await second.runPromise(inspect)).toEqual(baseline);
  } finally {
    await first.dispose();
    await second.dispose();
    await real.dispose();
  }
});
