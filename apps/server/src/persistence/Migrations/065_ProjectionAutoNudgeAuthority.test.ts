import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

describe("065_ProjectionAutoNudgeAuthority", () => {
  it.effect("creates one allowed generation-zero authority row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, branch, worktree_path, latest_turn_id, created_at, updated_at
        ) VALUES (
          'legacy-thread', 'project-1', 'Legacy thread', NULL, NULL, NULL,
          '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z'
        )
      `;
      const executed = yield* runMigrations({ toMigrationInclusive: 65 });
      assert.deepStrictEqual(executed, [[65, "ProjectionAutoNudgeAuthority"]]);

      const rows = yield* sql<{
        readonly authorityRevision: number;
        readonly status: string;
        readonly stoppedAt: string | null;
      }>`
        SELECT
          authority_revision AS "authorityRevision",
          status,
          stopped_at AS "stoppedAt"
        FROM projection_auto_nudge_authority
      `;
      assert.deepStrictEqual(rows, [{ authorityRevision: 0, status: "allowed", stoppedAt: null }]);
      const configs = yield* sql<{ readonly globalAuthorityRevision: number }>`
        SELECT json_extract(auto_nudge_json, '$.globalAuthorityRevision') AS "globalAuthorityRevision"
        FROM projection_threads
        WHERE thread_id = 'legacy-thread'
      `;
      assert.deepStrictEqual(configs, [{ globalAuthorityRevision: 0 }]);
    }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
  );
});
