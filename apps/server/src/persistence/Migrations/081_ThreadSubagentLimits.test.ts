import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";

it.layer(TestSqliteClient.layerMemory())("081_ThreadSubagentLimits", (it) => {
  it.effect(
    "retains legacy parent/session rows, indexes and child admission while adding unknown policy",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 80 });
        yield* sql`INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
      VALUES ('legacy', NULL, 'Legacy', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`;
        yield* sql`INSERT INTO projection_thread_sessions(thread_id, status, provider_name, provider_instance_id, runtime_mode, active_turn_id, last_error, updated_at)
      VALUES ('legacy', 'ready', 'codex', 'codex', 'approval-required', NULL, NULL, '2026-10-03T00:00:00.000Z')`;
        yield* sql`INSERT INTO attachment_content_commitments VALUES ('retained', 'legacy', ${"a".repeat(64)}, 64)`;
        const schema =
          yield* sql`SELECT name, type, sql FROM sqlite_schema WHERE type IN ('index', 'trigger') ORDER BY name`;
        const children = yield* sql`SELECT * FROM attachment_content_commitments`;
        // Keep this migration's schema-only assertion scoped to migration 081.
        // Later migrations intentionally add their own indexes and triggers.
        yield* runMigrations({ toMigrationInclusive: 81 });
        assert.deepEqual(
          yield* sql`SELECT thread_id, title, subagent_limits_json FROM projection_threads`,
          [{ thread_id: "legacy", title: "Legacy", subagent_limits_json: null }],
        );
        assert.deepEqual(
          yield* sql`SELECT thread_id, max_concurrent_subagents, max_concurrent_subagents_known FROM projection_thread_sessions`,
          [
            {
              thread_id: "legacy",
              max_concurrent_subagents: null,
              max_concurrent_subagents_known: 0,
            },
          ],
        );
        assert.deepEqual(
          yield* sql`SELECT name, type, sql FROM sqlite_schema WHERE type IN ('index', 'trigger') ORDER BY name`,
          schema,
        );
        assert.deepEqual(yield* sql`SELECT * FROM attachment_content_commitments`, children);
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        for (const invalid of [0, -1, 1.5, 65]) {
          assert.equal(
            (yield* Effect.result(
              sql`UPDATE projection_thread_sessions SET max_concurrent_subagents = ${invalid}, max_concurrent_subagents_known = 1 WHERE thread_id = 'legacy'`,
            ))._tag,
            "Failure",
          );
        }
        assert.equal(
          (yield* Effect.result(
            sql`UPDATE projection_thread_sessions SET max_concurrent_subagents = 4, max_concurrent_subagents_known = 0 WHERE thread_id = 'legacy'`,
          ))._tag,
          "Failure",
        );
        yield* sql`UPDATE projection_thread_sessions SET max_concurrent_subagents = 4, max_concurrent_subagents_known = 1 WHERE thread_id = 'legacy'`;
        yield* sql`UPDATE projection_thread_sessions SET max_concurrent_subagents = NULL, max_concurrent_subagents_known = 1 WHERE thread_id = 'legacy'`;
        assert.deepEqual(
          yield* sql`SELECT max_concurrent_subagents_known FROM projection_thread_sessions`,
          [{ max_concurrent_subagents_known: 1 }],
        );
      }),
  );
});
