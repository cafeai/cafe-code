import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("064_ProviderSubagentHistoryBindings", (it) => {
  it.effect("normalizes private roots and cascades them from the owning thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 63 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'provider_subagent_history_roots',
            'provider_subagent_history_bindings'
          )
      `;
      assert.deepEqual(before, []);

      yield* runMigrations({ toMigrationInclusive: 64 });
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'provider_subagent_history_roots',
            'provider_subagent_history_bindings'
          )
        ORDER BY name ASC
      `;
      assert.deepEqual(tables, [
        { name: "provider_subagent_history_bindings" },
        { name: "provider_subagent_history_roots" },
      ]);

      const rootForeignKeys = yield* sql<{
        readonly table: string;
        readonly from: string;
        readonly to: string;
        readonly onDelete: string;
      }>`
        SELECT "table", "from", "to", on_delete AS "onDelete"
        FROM pragma_foreign_key_list('provider_subagent_history_roots')
      `;
      assert.ok(
        rootForeignKeys.some(
          (foreignKey) =>
            foreignKey.table === "projection_threads" &&
            foreignKey.from === "thread_id" &&
            foreignKey.to === "thread_id" &&
            foreignKey.onDelete === "CASCADE",
        ),
      );

      const childForeignKeys = yield* sql<{
        readonly table: string;
        readonly from: string;
        readonly to: string;
        readonly onDelete: string;
      }>`
        SELECT "table", "from", "to", on_delete AS "onDelete"
        FROM pragma_foreign_key_list('provider_subagent_history_bindings')
      `;
      assert.equal(
        childForeignKeys.filter(
          (foreignKey) =>
            foreignKey.table === "provider_subagent_history_roots" &&
            foreignKey.onDelete === "CASCADE",
        ).length,
        2,
      );

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at
        ) VALUES (
          'thread-history-migration',
          'project-history-migration',
          'History migration',
          NULL,
          NULL,
          'turn-history-migration',
          '2026-08-25T00:00:00.000Z',
          '2026-08-25T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO provider_subagent_history_roots (
          thread_id,
          turn_id,
          provider_name,
          provider_instance_id,
          resume_cursor_json,
          cwd,
          created_at,
          updated_at
        ) VALUES (
          'thread-history-migration',
          'turn-history-migration',
          'codex',
          'codex-primary',
          '{"threadId":"provider-root"}',
          '/tmp/private-root',
          '2026-08-25T00:00:00.000Z',
          '2026-08-25T00:00:00.000Z'
        )
      `;
      for (const child of ["one", "two"]) {
        yield* sql`
          INSERT INTO provider_subagent_history_bindings (
            thread_id,
            turn_id,
            subagent_id,
            history_id,
            created_at,
            updated_at
          ) VALUES (
            'thread-history-migration',
            'turn-history-migration',
            ${`child-${child}`},
            ${`history-${child}`},
            '2026-08-25T00:00:00.000Z',
            '2026-08-25T00:00:00.000Z'
          )
        `;
      }

      const normalized = yield* sql<{
        readonly rootCount: number;
        readonly childCount: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM provider_subagent_history_roots) AS "rootCount",
          (SELECT COUNT(*) FROM provider_subagent_history_bindings) AS "childCount"
      `;
      assert.deepEqual(normalized, [{ rootCount: 1, childCount: 2 }]);

      yield* sql`
        DELETE FROM projection_threads
        WHERE thread_id = 'thread-history-migration'
      `;
      const afterDelete = yield* sql<{
        readonly rootCount: number;
        readonly childCount: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM provider_subagent_history_roots) AS "rootCount",
          (SELECT COUNT(*) FROM provider_subagent_history_bindings) AS "childCount"
      `;
      assert.deepEqual(afterDelete, [{ rootCount: 0, childCount: 0 }]);
    }),
  );
});
