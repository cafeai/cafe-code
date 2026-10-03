import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import migrate from "./080_StandaloneThreads.ts";

const layer = it.layer(TestSqliteClient.layerMemory());
layer("080_StandaloneThreads", (it) => {
  it.effect(
    "preserves every parent column, index, trigger and cascading child while admitting null",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 79 });
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, branch, worktree_path, archived_at, latest_user_message_at, pending_approval_count, pending_user_input_count, has_actionable_proposed_plan)
      VALUES ('linked', 'project', 'Original', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 'feature', '/owned-worktree', '2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 2, 3, 1)`;
        yield* sql`INSERT INTO attachment_content_commitments VALUES ('attachment', 'linked', ${"a".repeat(64)}, 42)`;
        yield* sql`INSERT INTO provider_subagent_history_roots VALUES ('linked', 'turn', 'codex', 'codex', '{"opaque":"private-cursor"}', '/owned-worktree', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`;
        yield* sql`INSERT INTO provider_subagent_history_bindings VALUES ('linked', 'turn', 'child', 'history', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`;
        const parent = yield* sql`SELECT * FROM projection_threads`;
        const attachments = yield* sql`SELECT * FROM attachment_content_commitments`;
        const roots = yield* sql`SELECT * FROM provider_subagent_history_roots`;
        const children = yield* sql`SELECT * FROM provider_subagent_history_bindings`;
        const schema =
          yield* sql`SELECT name, type, sql FROM sqlite_schema WHERE tbl_name = 'projection_threads' AND type IN ('index', 'trigger') ORDER BY name`;
        yield* runMigrations();
        assert.deepEqual(yield* sql`SELECT * FROM projection_threads`, parent);
        assert.deepEqual(yield* sql`SELECT * FROM attachment_content_commitments`, attachments);
        assert.deepEqual(yield* sql`SELECT * FROM provider_subagent_history_roots`, roots);
        assert.deepEqual(yield* sql`SELECT * FROM provider_subagent_history_bindings`, children);
        assert.deepEqual(
          yield* sql`SELECT name, type, sql FROM sqlite_schema WHERE tbl_name = 'projection_threads' AND type IN ('index', 'trigger') ORDER BY name`,
          schema,
        );
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at) VALUES ('standalone', NULL, 'Standalone', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`;
        yield* sql`INSERT INTO hard_deleted_threads VALUES ('retired', '2026-10-03T00:00:00.000Z')`;
        const retired = yield* Effect.result(
          sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at) VALUES ('retired', NULL, 'Rejected', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`,
        );
        assert.equal(retired._tag, "Failure");
        // Rebuilding cannot disable real cascading semantics or drop grandchildren.
        yield* sql`DELETE FROM projection_threads WHERE thread_id = 'linked'`;
        assert.deepEqual(yield* sql`SELECT * FROM attachment_content_commitments`, []);
        assert.deepEqual(yield* sql`SELECT * FROM provider_subagent_history_roots`, []);
        assert.deepEqual(yield* sql`SELECT * FROM provider_subagent_history_bindings`, []);
        yield* migrate;
        assert.equal((yield* sql`SELECT * FROM projection_threads`).length, 1);
      }),
  );
  it.effect(
    "preserves interrupted hard-delete children without reopening retired identity admission",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 79 });
        for (const threadId of ["interrupted-delete", "still-linked"]) {
          yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES (${threadId}, 'project', 'Existing', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`;
          yield* sql`INSERT INTO attachment_content_commitments VALUES (${`${threadId}-attachment`}, ${threadId}, ${"b".repeat(64)}, 64)`;
          yield* sql`INSERT INTO provider_subagent_history_roots VALUES (${threadId}, 'turn', 'codex', 'codex', '{"opaque":"existing-cursor"}', '/owned-worktree', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`;
          yield* sql`INSERT INTO provider_subagent_history_bindings VALUES (${threadId}, 'turn', 'child', 'history', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`;
        }
        yield* sql`INSERT INTO file_attachment_uploads VALUES ('pending-attachment', 'interrupted-delete', 'retained', 100, 1)`;
        // Retirement intentionally precedes the asynchronous provider/file purge.
        // A restart in that interval must retain the already-admitted parent and
        // descendants, not treat restoration as a new write by a stale worker.
        yield* sql`INSERT INTO hard_deleted_threads VALUES ('interrupted-delete', '2026-10-03T00:00:00.000Z')`;
        const parents = yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`;
        const attachments =
          yield* sql`SELECT * FROM attachment_content_commitments ORDER BY attachment_id`;
        const roots = yield* sql`SELECT * FROM provider_subagent_history_roots ORDER BY thread_id`;
        const bindings =
          yield* sql`SELECT * FROM provider_subagent_history_bindings ORDER BY thread_id`;
        const uploads = yield* sql`SELECT * FROM file_attachment_uploads`;
        const triggers =
          yield* sql`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name`;
        yield* runMigrations();
        assert.deepEqual(yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`, parents);
        assert.deepEqual(
          yield* sql`SELECT * FROM attachment_content_commitments ORDER BY attachment_id`,
          attachments,
        );
        assert.deepEqual(
          yield* sql`SELECT * FROM provider_subagent_history_roots ORDER BY thread_id`,
          roots,
        );
        assert.deepEqual(
          yield* sql`SELECT * FROM provider_subagent_history_bindings ORDER BY thread_id`,
          bindings,
        );
        assert.deepEqual(yield* sql`SELECT * FROM file_attachment_uploads`, uploads);
        assert.deepEqual(
          yield* sql`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name`,
          triggers,
        );
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        const newRoot = yield* Effect.result(
          sql`INSERT INTO provider_subagent_history_roots VALUES ('interrupted-delete', 'new-turn', 'codex', 'codex', '{}', '/owned-worktree', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`,
        );
        const newBinding = yield* Effect.result(
          sql`INSERT INTO provider_subagent_history_bindings VALUES ('interrupted-delete', 'turn', 'new-child', 'new-history', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`,
        );
        const newAttachment = yield* Effect.result(
          sql`INSERT INTO file_attachment_uploads VALUES ('new-attachment', 'interrupted-delete', 'writing', 100, 1)`,
        );
        const staleRootUpdate = yield* Effect.result(
          sql`UPDATE provider_subagent_history_roots SET cwd = '/other' WHERE thread_id = 'interrupted-delete'`,
        );
        assert.equal(newRoot._tag, "Failure");
        assert.equal(newBinding._tag, "Failure");
        assert.equal(newAttachment._tag, "Failure");
        assert.equal(staleRootUpdate._tag, "Failure");
      }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
  );
  it.effect("fails before mutation for an unqualified cascading child table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      yield* sql`CREATE TABLE unexpected_thread_child (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE)`;
      const before = yield* sql`SELECT sql FROM sqlite_schema WHERE name = 'projection_threads'`;
      const result = yield* Effect.exit(migrate);
      assert.equal(result._tag, "Failure");
      assert.deepEqual(
        yield* sql`SELECT sql FROM sqlite_schema WHERE name = 'projection_threads'`,
        before,
      );
      yield* sql`DROP TABLE unexpected_thread_child`;
    }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
  );
});
