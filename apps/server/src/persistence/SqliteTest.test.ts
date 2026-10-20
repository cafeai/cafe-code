import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import {
  SQLITE_FIXTURE_SNAPSHOT_MAX_BYTES,
  SqlitePersistenceTest,
  createSqliteSnapshotFactory,
  snapshotSqliteDatabase,
} from "./Sqlite.test.fixture.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

it.each(["sql", "binary"] as const)(
  "retains seed values, generated columns, indexes, triggers, views and sequences in independent %s snapshots",
  (format) => {
    const source = new DatabaseSync(":memory:");
    let first: DatabaseSync | undefined;
    let second: DatabaseSync | undefined;
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
      if (format === "binary") {
        const openDatabase = createSqliteSnapshotFactory(source);
        first = openDatabase();
        second = openDatabase();
      } else {
        first = new DatabaseSync(":memory:");
        first.exec(snapshot);
        second = new DatabaseSync(":memory:");
        second.exec(snapshot);
      }
      expect(snapshotSqliteDatabase(first)).toBe(snapshot);
      expect(snapshotSqliteDatabase(second)).toBe(snapshot);
      expect(first.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(first.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(15_000);
      expect(first.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("memory");
      expect(first.prepare("SELECT value FROM names").get()?.value).toBe("seed's value");
      expect(
        first.prepare("SELECT hex(bytes) AS bytes, quote(big) AS big, derived FROM child").get(),
      ).toEqual({ bytes: "0001FF", big: "9223372036854775807", derived: 2 });
      expect(first.prepare("SELECT count(*) AS count FROM audit").get()?.count).toBe(1);
      // Capture the admitted handle for callbacks; the outer optional variable
      // exists only so failed construction can still close already-owned peers.
      const admittedFirst = first;
      expect(() =>
        admittedFirst.exec("INSERT INTO parent(value) VALUES ('seed''s value')"),
      ).toThrow();
      expect(() => admittedFirst.exec("INSERT INTO child(id,parent_id) VALUES (2,999)")).toThrow();
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
      first?.close();
      second?.close();
      source.close();
    }
  },
);

it("refuses an active source transaction without copying or changing its owner", () => {
  const source = new DatabaseSync(":memory:");
  const serialize = vi.spyOn(source, "serialize");
  let clone: DatabaseSync | undefined;
  try {
    source.exec(
      "CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('committed'); BEGIN; INSERT INTO retained VALUES ('pending');",
    );
    expect(source.isTransaction).toBe(true);
    expect(() => createSqliteSnapshotFactory(source)).toThrow("requires a committed source");
    expect(serialize).not.toHaveBeenCalled();
    expect(source.isTransaction).toBe(true);
    expect(source.prepare("SELECT value FROM retained ORDER BY rowid").all()).toEqual([
      { value: "committed" },
      { value: "pending" },
    ]);
    source.exec("ROLLBACK");
    expect(source.isTransaction).toBe(false);
    clone = createSqliteSnapshotFactory(source)();
    expect(clone.prepare("SELECT value FROM retained").all()).toEqual([{ value: "committed" }]);
  } finally {
    clone?.close();
    serialize.mockRestore();
    source.close();
  }
});

it("preserves hidden rowids and independent insertion identity in binary snapshots", () => {
  const source = new DatabaseSync(":memory:");
  let first: DatabaseSync | undefined;
  let second: DatabaseSync | undefined;
  try {
    // A logical dump of named columns does not qualify sparse hidden rowids.
    // Bind that native property directly rather than comparing page layout.
    source.exec(
      "CREATE TABLE retained(value TEXT); INSERT INTO retained(rowid,value) VALUES (7,'first'),(41,'second');",
    );
    const openDatabase = createSqliteSnapshotFactory(source);
    first = openDatabase();
    second = openDatabase();
    const original = [
      { id: 7, value: "first" },
      { id: 41, value: "second" },
    ];
    expect(first.prepare("SELECT rowid AS id,value FROM retained ORDER BY rowid").all()).toEqual(
      original,
    );
    expect(second.prepare("SELECT rowid AS id,value FROM retained ORDER BY rowid").all()).toEqual(
      original,
    );
    first.exec("INSERT INTO retained(value) VALUES ('third')");
    expect(first.prepare("SELECT rowid AS id FROM retained WHERE value = 'third'").get()?.id).toBe(
      42,
    );
    expect(second.prepare("SELECT rowid AS id,value FROM retained ORDER BY rowid").all()).toEqual(
      original,
    );
  } finally {
    first?.close();
    second?.close();
    source.close();
  }
});

it.each(["sql", "binary"] as const)(
  "retains deferred foreign-key rejection and rollback after %s cloning",
  (format) => {
    const source = new DatabaseSync(":memory:");
    let clone: DatabaseSync | undefined;
    try {
      source.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE parent(id INTEGER PRIMARY KEY, value TEXT);
      CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
      INSERT INTO parent VALUES (1,'seed');
      INSERT INTO child VALUES (1,1);
    `);
      if (format === "binary") clone = createSqliteSnapshotFactory(source)();
      else {
        clone = new DatabaseSync(":memory:");
        clone.exec(snapshotSqliteDatabase(source));
      }
      clone.exec("BEGIN; UPDATE parent SET value = 'pending'; INSERT INTO child VALUES (2,999);");
      expect(clone.isTransaction).toBe(true);
      expect(clone.prepare("SELECT value FROM parent").get()?.value).toBe("pending");
      expect(clone.prepare("SELECT count(*) AS count FROM child").get()?.count).toBe(2);
      // A deferred violation must fail the real COMMIT and leave its transaction
      // active for the same native owner to roll back; do not emulate this in JS.
      const admittedClone = clone;
      expect(() => admittedClone.exec("COMMIT")).toThrow();
      expect(clone.isTransaction).toBe(true);
      clone.exec("ROLLBACK");
      expect(clone.isTransaction).toBe(false);
      expect(clone.prepare("SELECT id,value FROM parent").all()).toEqual([
        { id: 1, value: "seed" },
      ]);
      expect(clone.prepare("SELECT id,parent_id FROM child").all()).toEqual([
        { id: 1, parent_id: 1 },
      ]);
    } finally {
      clone?.close();
      source.close();
    }
  },
);

it("bounds binary seed allocation before native serialization", () => {
  const source = new DatabaseSync(":memory:");
  const serialize = vi.spyOn(source, "serialize");
  try {
    // Keep this resource refusal native and finite: one bounded synthetic
    // value plus SQLite's pages is just larger than the admitted seed limit.
    source.exec(`
      PRAGMA page_size = 65536;
      CREATE TABLE too_large(value BLOB);
      INSERT INTO too_large VALUES (zeroblob(${SQLITE_FIXTURE_SNAPSHOT_MAX_BYTES}));
    `);
    expect(() => createSqliteSnapshotFactory(source)).toThrow("bounded in-memory format");
    expect(serialize).not.toHaveBeenCalled();
  } finally {
    serialize.mockRestore();
    source.close();
  }
});

it("retains the explicit virtual-table refusal for SQL and binary snapshots", () => {
  const source = new DatabaseSync(":memory:");
  const serialize = vi.spyOn(source, "serialize");
  try {
    source.exec("CREATE VIRTUAL TABLE synthetic_search USING fts5(value)");
    expect(() => snapshotSqliteDatabase(source)).toThrow("Virtual tables require");
    expect(() => createSqliteSnapshotFactory(source)).toThrow("Virtual tables require");
    expect(serialize).not.toHaveBeenCalled();
  } finally {
    serialize.mockRestore();
    source.close();
  }
});

it("closes the exact database transferred to its scoped SQL layer", async () => {
  const source = new DatabaseSync(":memory:");
  let openDatabase: () => DatabaseSync;
  try {
    source.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('seed');");
    openDatabase = createSqliteSnapshotFactory(source);
    source.exec("UPDATE retained SET value = 'later source mutation';");
  } finally {
    source.close();
  }
  // The immutable input survives source closure, without retaining a shared
  // database or allowing a later source write to change an admitted clone.
  const database = openDatabase();
  expect(database.prepare("SELECT value FROM retained").get()?.value).toBe("seed");
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
