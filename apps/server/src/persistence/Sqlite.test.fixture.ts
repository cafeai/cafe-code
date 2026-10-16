/** Fresh, scoped databases for feature tests. Migration tests use the real
 * persistence layer instead. The immutable snapshot is rebuilt from the current
 * migrations in each isolated test module, never read from a disk cache. */
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function snapshotSqliteDatabase(database: DatabaseSync): string {
  const schema = database
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )
    .all() as Array<{ type: string; name: string; sql: string }>;
  // A virtual table also owns implementation-specific shadow tables. Refuse
  // that unsupported fixture shape instead of copying an incomplete database.
  if (schema.some((entry) => /^CREATE\s+VIRTUAL\s+TABLE/i.test(entry.sql)))
    throw new Error("Virtual tables require an explicit SQLite fixture snapshot strategy");
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

let snapshot: Promise<string> | undefined;
function getSnapshot(): Promise<string> {
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
          return snapshotSqliteDatabase(database);
        }).pipe(Effect.provide(layer));
      }),
    ),
  ));
}

export const SqlitePersistenceTest = Layer.unwrap(
  Effect.map(Effect.promise(getSnapshot), (sql) =>
    NodeSqliteClient.layerWithDatabase({ filename: ":memory:", busyTimeoutMs: 15_000 }, () => {
      const database = new DatabaseSync(":memory:");
      try {
        database.exec(sql);
        return database;
      } catch (error) {
        database.close();
        throw error;
      }
    }),
  ),
);
