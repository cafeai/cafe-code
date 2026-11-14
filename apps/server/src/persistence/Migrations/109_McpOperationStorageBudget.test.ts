import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const at = "2026-11-15T00:00:00.000Z";
const expires = "2026-12-15T00:00:00.000Z";
const ownerHash = "a".repeat(64);
const inputHash = "b".repeat(64);
const budget = 665_600_000;
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

interface Budget {
  readonly policy_version: number;
  readonly bytes: number;
  readonly entry_count: number;
}
const readBudget = (sql: SqlClient.SqlClient) =>
  sql<Budget>`SELECT policy_version, bytes, entry_count
    FROM mcp_operation_storage_budget WHERE singleton = 1`;
const insert = (
  sql: SqlClient.SqlClient,
  id: string,
  state: string,
  result: string | null = null,
  createdAt = at,
) => sql`INSERT INTO mcp_operations (
  owner_hash, request_id, tool, input_hash, state, result_json, created_at, updated_at, expires_at
) VALUES (${ownerHash}, ${id}, 'fixture-tool', ${inputHash}, ${state}, ${result}, ${createdAt}, ${at}, ${expires})`;

it.effect("backfills exact legacy UTF-8 charges without changing any retained receipt", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 108 });
    const cases = [
      { id: "pending", state: "unconfirmed", result: null, created: at },
      { id: "scheduled", state: "scheduled", result: '{"scheduled":true}', created: at },
      { id: "recorded", state: "recorded", result: '{"label":"🌸"}', created: at },
      { id: "completed", state: "completed", result: '{"success":true}', created: at },
      // Legacy schema permits arbitrary timestamp text. Account for its actual
      // bytes instead of treating malformed/large old metadata as free storage.
      { id: "failed", state: "failed", result: null, created: "🌸".repeat(400) },
    ];
    for (const entry of cases)
      yield* insert(sql, entry.id, entry.state, entry.result, entry.created);
    const before = yield* sql`SELECT owner_hash, request_id, tool, input_hash, state,
      result_json, created_at, updated_at, expires_at FROM mcp_operations ORDER BY request_id`;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 109 }), [
      [109, "McpOperationStorageBudget"],
    ]);
    assert.deepEqual(
      yield* sql`SELECT owner_hash, request_id, tool, input_hash, state,
        result_json, created_at, updated_at, expires_at FROM mcp_operations ORDER BY request_id`,
      before,
    );
    const expected = cases.map((entry) => {
      // Independent public-policy calculation, not the production SQL/helper:
      // reserve 64KiB only for unfinished settlement; retain every exact row.
      const metadata = Math.max(
        1024,
        512 +
          [ownerHash, entry.id, "fixture-tool", inputHash, entry.state, entry.created, at, expires]
            .map((value) => Buffer.byteLength(value, "utf8"))
            .reduce((sum, bytes) => sum + bytes, 0),
      );
      return {
        request_id: entry.id,
        storage_bytes:
          metadata +
          (entry.state === "unconfirmed" || entry.state === "scheduled"
            ? 65536
            : Buffer.byteLength(entry.result ?? "", "utf8")),
      };
    });
    assert.deepEqual(
      yield* sql`SELECT request_id, storage_bytes FROM mcp_operations ORDER BY request_id`,
      expected.sort((left, right) => left.request_id.localeCompare(right.request_id)),
    );
    assert.deepEqual(yield* readBudget(sql), [
      {
        policy_version: 1,
        bytes: expected.reduce((sum, row) => sum + row.storage_bytes, 0),
        entry_count: 5,
      },
    ]);
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 109 }), []);
    assert.deepEqual(
      yield* sql`SELECT result_json FROM mcp_operations WHERE request_id = 'recorded'`,
      [{ result_json: '{"label":"🌸"}' }],
    );
  }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
);

it.effect(
  "accounts for settlement and deletion atomically and rolls back refused result growth",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 109 });
      yield* sql`WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n < 9999)
      INSERT INTO mcp_operations (owner_hash, request_id, tool, input_hash, state,
        created_at, updated_at, expires_at)
      SELECT ${ownerHash}, printf('slot-%d', n), 'fixture-tool', ${inputHash},
        'unconfirmed', ${at}, ${at}, ${expires} FROM slots`;
      yield* insert(sql, "known", "recorded");
      assert.deepEqual(yield* readBudget(sql), [
        { policy_version: 1, bytes: budget - 65536, entry_count: 10000 },
      ]);
      // The unused payload reservation alone is insufficient: a new consumed ID
      // needs its own positive metadata charge too. Refusal changes neither owner.
      assert.equal((yield* Effect.exit(insert(sql, "new", "unconfirmed")))._tag, "Failure");
      yield* sql`UPDATE mcp_operations SET state = 'recorded' WHERE request_id = 'slot-1'`;
      yield* insert(sql, "new", "unconfirmed");
      const before = yield* readBudget(sql);
      const fullResult = encodeJson({ v: "x".repeat(65528) });
      assert.equal(Buffer.byteLength(fullResult, "utf8"), 65536);
      assert.equal(
        (yield* Effect.exit(sql`UPDATE mcp_operations SET result_json = ${fullResult}
        WHERE request_id = 'known'`))._tag,
        "Failure",
      );
      assert.deepEqual(yield* readBudget(sql), before);
      assert.deepEqual(
        yield* sql`SELECT state, result_json, storage_bytes FROM mcp_operations WHERE request_id = 'known'`,
        [{ state: "recorded", result_json: null, storage_bytes: 1024 }],
      );
      yield* sql`DELETE FROM mcp_operations WHERE request_id = 'new'`;
      yield* sql`UPDATE mcp_operations SET result_json = ${fullResult} WHERE request_id = 'known'`;
      assert.deepEqual(yield* readBudget(sql), [
        { policy_version: 1, bytes: budget - 65536, entry_count: 10000 },
      ]);
      assert.deepEqual(
        yield* sql`SELECT storage_bytes FROM mcp_operations WHERE request_id = 'known'`,
        [{ storage_bytes: 66560 }],
      );
    }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
);

it.effect("preserves overbudget legacy evidence while allowing only shrink and deletion", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 108 });
    yield* sql`WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n < 9999)
      INSERT INTO mcp_operations (owner_hash, request_id, tool, input_hash, state,
        created_at, updated_at, expires_at)
      SELECT ${ownerHash}, printf('slot-%d', n), 'fixture-tool', ${inputHash},
        'unconfirmed', ${at}, ${at}, ${expires} FROM slots`;
    yield* insert(sql, "large-metadata", "unconfirmed", null, "🌸".repeat(400));
    yield* runMigrations({ toMigrationInclusive: 109 });
    const before = yield* readBudget(sql);
    assert.equal(before[0]!.entry_count, 10000);
    assert.isAbove(before[0]!.bytes, budget);
    assert.equal((yield* Effect.exit(insert(sql, "new", "unconfirmed")))._tag, "Failure");
    assert.equal(
      (yield* Effect.exit(sql`UPDATE mcp_operations SET created_at = ${"🌸".repeat(401)}
        WHERE request_id = 'large-metadata'`))._tag,
      "Failure",
    );
    assert.deepEqual(yield* readBudget(sql), before);
    yield* sql`UPDATE mcp_operations SET created_at = ${at} WHERE request_id = 'large-metadata'`;
    assert.deepEqual(yield* readBudget(sql), [
      { policy_version: 1, bytes: budget, entry_count: 10000 },
    ]);
    yield* sql`DELETE FROM mcp_operations WHERE request_id = 'large-metadata'`;
    assert.deepEqual(yield* readBudget(sql), [
      { policy_version: 1, bytes: budget - 66560, entry_count: 9999 },
    ]);
    assert.deepEqual(yield* sql`SELECT state FROM mcp_operations WHERE request_id = 'slot-1'`, [
      { state: "unconfirmed" },
    ]);
  }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
);

it.effect("refuses missing or invalid accounting instead of admitting untracked mutations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 109 });
    yield* insert(sql, "retained", "unconfirmed");
    for (const damaged of ["missing", "invalid-type"] as const) {
      if (damaged === "missing") {
        yield* sql`DELETE FROM mcp_operation_storage_budget`;
      } else {
        // Corrupt only this test-owned in-memory counter through the native
        // SQLite facility. Production never disables checks or repairs an
        // unknown singleton; the next ledger write must explicitly refuse it.
        yield* sql`PRAGMA ignore_check_constraints = ON`;
        yield* sql`UPDATE mcp_operation_storage_budget SET bytes = 'invalid'`.pipe(
          Effect.ensuring(
            sql`PRAGMA ignore_check_constraints = OFF`.pipe(Effect.orDie, Effect.asVoid),
          ),
        );
      }
      assert.equal((yield* Effect.exit(insert(sql, "new", "unconfirmed")))._tag, "Failure");
      assert.equal(
        (yield* Effect.exit(sql`UPDATE mcp_operations SET state = 'completed'
          WHERE request_id = 'retained'`))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(sql`DELETE FROM mcp_operations WHERE request_id = 'retained'`))._tag,
        "Failure",
      );
      assert.deepEqual(yield* sql`SELECT request_id, state, storage_bytes FROM mcp_operations`, [
        { request_id: "retained", state: "unconfirmed", storage_bytes: 66560 },
      ]);
      yield* sql`DELETE FROM mcp_operation_storage_budget`;
      yield* sql`INSERT INTO mcp_operation_storage_budget
        (singleton, policy_version, bytes, entry_count) VALUES (1, 1, 66560, 1)`;
    }
  }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
);

it.effect(
  "refuses replacement writes that could lose retained identities or bypass delete accounting",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 109 });
      yield* insert(sql, "first", "recorded", '{"messageId":"first"}');
      yield* insert(sql, "second", "failed", '{"error":"fixed"}');
      const before = yield* sql`SELECT request_id, state, result_json, storage_bytes
      FROM mcp_operations ORDER BY request_id`;
      const accounting = yield* readBudget(sql);
      // SQLite does not ordinarily fire DELETE triggers for REPLACE conflicts
      // unless recursive_triggers is enabled. Refuse the conflict rather than
      // changing a global SQLite setting or silently overwriting a consumed ID.
      assert.equal(
        (yield* Effect.exit(sql`INSERT OR REPLACE INTO mcp_operations
        (owner_hash, request_id, tool, input_hash, state, created_at, updated_at, expires_at)
        VALUES (${ownerHash}, 'first', 'fixture-tool', ${inputHash}, 'unconfirmed', ${at}, ${at}, ${expires})`))
          ._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(sql`UPDATE OR REPLACE mcp_operations SET request_id = 'second'
        WHERE request_id = 'first'`))._tag,
        "Failure",
      );
      assert.deepEqual(
        yield* sql`SELECT request_id, state, result_json, storage_bytes FROM mcp_operations ORDER BY request_id`,
        before,
      );
      assert.deepEqual(yield* readBudget(sql), accounting);
    }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
);
