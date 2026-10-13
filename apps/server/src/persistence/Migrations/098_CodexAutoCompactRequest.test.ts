import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";

it.layer(TestSqliteClient.layerMemory())("098_CodexAutoCompactRequest", (it) => {
  it.effect(
    "keeps historical context pairing unknown and preserves prior rows and schema objects",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 97 });
        yield* sql`INSERT INTO projection_thread_sessions(thread_id, status, provider_name,
        provider_instance_id, runtime_mode, active_turn_id, last_error, updated_at,
        codex_context_window_override, codex_context_window_override_known)
        VALUES ('legacy-pairing', 'ready', 'codex', 'codex', 'full-access', NULL, NULL,
          '2026-10-14T00:00:00.000Z', 800000, 1)`;
        const before = yield* sql`SELECT * FROM projection_thread_sessions`;
        const objects = yield* sql`SELECT name, type, sql FROM sqlite_schema
        WHERE type IN ('index', 'trigger') ORDER BY name`;
        yield* runMigrations({ toMigrationInclusive: 98 });
        const rows = yield* sql`SELECT * FROM projection_thread_sessions`;
        assert.equal(rows.length, 1);
        const {
          codex_auto_compact_token_limit: value,
          codex_auto_compact_token_limit_known: known,
          ...retained
        } = rows[0]!;
        assert.equal(value, null);
        assert.equal(known, 0);
        assert.deepEqual(retained, before[0]);
        assert.deepEqual(
          yield* sql`SELECT name, type, sql FROM sqlite_schema
        WHERE type IN ('index', 'trigger') ORDER BY name`,
          objects,
        );
        for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
          assert.equal(
            (yield* Effect.result(sql`UPDATE projection_thread_sessions
          SET codex_auto_compact_token_limit = ${invalid}, codex_auto_compact_token_limit_known = 1`))
              ._tag,
            "Failure",
          );
        assert.equal(
          (yield* Effect.result(sql`UPDATE projection_thread_sessions
        SET codex_auto_compact_token_limit = 800000, codex_auto_compact_token_limit_known = 0`))
            ._tag,
          "Failure",
        );
        for (const valid of [1, 800_000, Number.MAX_SAFE_INTEGER, null]) {
          yield* sql`UPDATE projection_thread_sessions SET codex_auto_compact_token_limit = ${valid},
          codex_auto_compact_token_limit_known = 1`;
          assert.deepEqual(
            yield* sql`SELECT codex_auto_compact_token_limit AS value,
          codex_auto_compact_token_limit_known AS known FROM projection_thread_sessions`,
            [{ value: valid, known: 1 }],
          );
        }
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }),
  );
});
