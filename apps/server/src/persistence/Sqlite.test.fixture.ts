/** Fresh, scoped databases for feature tests. Migration tests use the real
 * persistence layer instead. The immutable snapshot is rebuilt from the current
 * migrations in each isolated test module, never read from a disk cache. */
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** This is fixture INPUT, rebuilt from real migrations per isolated module.
 * Refuse growth rather than retain an unbounded binary seed or silently omit
 * data. It is never a persisted database or a cache of successful test work. */
export const SQLITE_FIXTURE_SNAPSHOT_MAX_BYTES = 16 * 1_024 * 1_024;

function assertSupportedSnapshotSchema(schema: ReadonlyArray<{ readonly sql: string }>): void {
  // Virtual tables can own extension-specific state and shadow tables. Keep
  // the existing explicit refusal even though native serialization copies pages.
  if (schema.some((entry) => /^CREATE\s+VIRTUAL\s+TABLE/i.test(entry.sql)))
    throw new Error("Virtual tables require an explicit SQLite fixture snapshot strategy");
}

export function snapshotSqliteDatabase(database: DatabaseSync): string {
  const schema = database
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )
    .all() as Array<{ type: string; name: string; sql: string }>;
  assertSupportedSnapshotSchema(schema);
  const statements = ["PRAGMA foreign_keys = OFF", "BEGIN"];
  statements.push(...schema.filter((entry) => entry.type === "table").map((entry) => entry.sql));
  const tables = schema.filter((entry) => entry.type === "table").map((entry) => entry.name);
  if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").get()) {
    tables.push("sqlite_sequence");
  }
  for (const table of tables) {
    // Explicit seed inserts can create sequence rows. Replace them only after
    // all ordinary table data, retaining the source's deleted-row high water.
    if (table === "sqlite_sequence") statements.push("DELETE FROM sqlite_sequence");
    const columns = (
      database.prepare(`PRAGMA table_xinfo(${identifier(table)})`).all() as Array<{
        name: string;
        hidden: number;
      }>
    )
      .filter((column) => column.hidden === 0)
      .map((column) => column.name);
    const values = columns.map((column) => `quote(${identifier(column)})`).join(" || ',' || ");
    const rows = database.prepare(`SELECT ${values} AS value FROM ${identifier(table)}`).all();
    for (const row of rows)
      statements.push(
        `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(",")}) VALUES (${row.value})`,
      );
  }
  statements.push(...schema.filter((entry) => entry.type !== "table").map((entry) => entry.sql));
  for (const pragma of ["user_version", "application_id"]) {
    const row = database.prepare(`PRAGMA ${pragma}`).get()!;
    statements.push(`PRAGMA ${pragma} = ${row[pragma]}`);
  }
  statements.push("COMMIT", "PRAGMA foreign_keys = ON", "PRAGMA busy_timeout = 15000");
  return statements.join(";\n") + ";";
}

/** Capture only this caller-owned database. The bytes remain private to the
 * returned factory, and Node's native deserialize copies them into separately
 * owned SQLite memory before any statements or client caches can be created.
 * A returned handle belongs to its caller until layerWithDatabase adopts it. */
export function createSqliteSnapshotFactory(database: DatabaseSync): () => DatabaseSync {
  // A seed is a completed migration result, never a view of a transaction
  // which its owner might subsequently roll back. Refuse before any read/copy.
  if (database.isTransaction)
    throw new Error("SQLite fixture snapshot requires a committed source.");
  const pageCount = database.prepare("PRAGMA page_count").get()?.page_count;
  const pageSize = database.prepare("PRAGMA page_size").get()?.page_size;
  if (
    typeof pageCount !== "number" ||
    !Number.isSafeInteger(pageCount) ||
    pageCount <= 0 ||
    typeof pageSize !== "number" ||
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    pageCount > Math.floor(SQLITE_FIXTURE_SNAPSHOT_MAX_BYTES / pageSize)
  )
    throw new Error("SQLite fixture snapshot exceeds its bounded in-memory format.");
  const schema = database
    .prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ sql: string }>;
  assertSupportedSnapshotSchema(schema);
  const bytes = database.serialize();
  if (bytes.byteLength === 0 || bytes.byteLength > SQLITE_FIXTURE_SNAPSHOT_MAX_BYTES)
    throw new Error("SQLite fixture snapshot exceeds its bounded in-memory format.");
  return () => {
    const clone = new DatabaseSync(":memory:");
    try {
      clone.deserialize(bytes);
      // These are connection state, not database-page state. Preserve the
      // canonical SQL snapshot's post-import policy on every fresh handle.
      clone.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 15000;");
      return clone;
    } catch (error) {
      clone.close();
      throw error;
    }
  };
}

let snapshot: Promise<() => DatabaseSync> | undefined;
function getSnapshot(): Promise<() => DatabaseSync> {
  return (snapshot ??= Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { runMigrations } = yield* Effect.promise(() => import("./Migrations.ts"));
        let database!: DatabaseSync;
        const layer = NodeSqliteClient.layerWithDatabase(
          { filename: ":memory:", busyTimeoutMs: 15_000 },
          () => {
            database = new DatabaseSync(":memory:");
            return database;
          },
        );
        return yield* Effect.gen(function* () {
          yield* SqlClient.SqlClient;
          yield* runMigrations();
          return createSqliteSnapshotFactory(database);
        }).pipe(Effect.provide(layer));
      }),
    ),
  ));
}

export const SqlitePersistenceTest = Layer.unwrap(
  Effect.map(Effect.promise(getSnapshot), (openDatabase) =>
    NodeSqliteClient.layerWithDatabase(
      { filename: ":memory:", busyTimeoutMs: 15_000 },
      openDatabase,
    ),
  ),
);
