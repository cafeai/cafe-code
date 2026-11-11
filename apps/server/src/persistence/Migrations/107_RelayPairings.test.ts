import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

it.effect(
  "adds relay pairing to the existing MCP schema without changing its receipts or sessions",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 106 });
      const at = "2026-11-10T00:00:00.000Z";
      yield* sql`
      INSERT INTO mcp_operations (
        owner_hash, request_id, tool, input_hash, state, result_json,
        created_at, updated_at, expires_at
      ) VALUES (
        ${"a".repeat(64)}, 'existing-operation', 'fixture-tool', ${"b".repeat(64)},
        'recorded', '{"success":true}', ${at}, ${at}, '2026-11-11T00:00:00.000Z'
      )
    `;
      yield* sql`
      INSERT INTO auth_sessions (session_id, subject, role, method, issued_at, expires_at)
      VALUES ('existing-session', 'fixture-owner', 'owner', 'bearer-session-token',
        ${at}, '2026-11-11T00:00:00.000Z')
    `;
      const receipts = yield* sql`SELECT * FROM mcp_operations`,
        sessions = yield* sql`SELECT * FROM auth_sessions`,
        ledger =
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;

      // Dev has already assigned 106 to MCP receipts. Upgrade through the real
      // loader so a duplicate or skipped relay migration cannot pass unnoticed.
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 107 }), [
        [107, "RelayPairings"],
      ]);
      assert.deepEqual(yield* sql`SELECT * FROM mcp_operations`, receipts);
      assert.deepEqual(yield* sql`SELECT * FROM auth_sessions`, sessions);
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id <= 106 ORDER BY migration_id`,
        ledger,
      );
      yield* sql`
      INSERT INTO relay_invitations (
        id, secret_hash, network_id, host_key, environment_id, role, expires_at
      ) VALUES ('invitation', 'fixture-hash', 'network', 'host', 'environment', 'client', 12345)
    `;
      yield* sql`
      INSERT INTO relay_device_sessions (
        network_id, host_key, device_key, session_id, expires_at
      ) VALUES ('network', 'host', 'device', 'existing-session', 12345)
    `;
      assert.deepEqual(yield* sql`SELECT session_id FROM relay_device_sessions`, [
        { session_id: "existing-session" },
      ]);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 107 }), []);
      assert.deepEqual(yield* sql`SELECT id FROM relay_invitations`, [{ id: "invitation" }]);
      assert.deepEqual(yield* sql`SELECT * FROM mcp_operations`, receipts);
    }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
);
