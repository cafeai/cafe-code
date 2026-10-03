import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";

it.layer(TestSqliteClient.layerMemory())("083_SubagentRuntimeGeneration", (it) => {
  it.effect("adds unknown evidence without touching legacy status, history or indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 82 });
      yield* sql`INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
      VALUES ('legacy', NULL, 'Legacy', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_thread_sessions(thread_id, status, provider_name, provider_instance_id, runtime_mode, active_turn_id, last_error, updated_at)
      VALUES ('legacy', 'running', 'codex', 'codex', 'approval-required', 'turn', NULL, '2026-10-03T00:00:00.000Z')`;
      const schema =
        yield* sql`SELECT name, type, sql FROM sqlite_schema WHERE type IN ('index', 'trigger') ORDER BY name`;
      yield* runMigrations({ toMigrationInclusive: 83 });
      assert.deepEqual(
        yield* sql`SELECT status, active_turn_id, subagent_runtime_id FROM projection_thread_sessions`,
        [{ status: "running", active_turn_id: "turn", subagent_runtime_id: null }],
      );
      assert.deepEqual(
        yield* sql`SELECT name, type, sql FROM sqlite_schema WHERE type IN ('index', 'trigger') ORDER BY name`,
        schema,
      );
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }),
  );
});
