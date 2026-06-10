import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("038_ProjectionProjectsAdditionalWorkspaceRoots", (it) => {
  it.effect("adds additional workspace roots with an empty-array default", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-before-038',
          'Project',
          '/tmp/project-before-038',
          NULL,
          '[]',
          '2026-05-23T00:00:00.000Z',
          '2026-05-23T00:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 38 });

      const rows = yield* sql<{ readonly additionalWorkspaceRoots: string }>`
        SELECT additional_workspace_roots_json AS "additionalWorkspaceRoots"
        FROM projection_projects
        WHERE project_id = 'project-before-038'
      `;

      assert.deepStrictEqual(rows, [{ additionalWorkspaceRoots: "[]" }]);
    }),
  );
});
