import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("067_AttachmentContentCommitments", (it) => {
  it.effect("stores only valid private SHA-256 commitments owned by a thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });
      yield* runMigrations({ toMigrationInclusive: 67 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at
        ) VALUES (
          'project-attachment-commitment',
          'Attachment commitment',
          '/tmp/project-attachment-commitment',
          NULL,
          '[]',
          '2026-08-31T00:00:00.000Z',
          '2026-08-31T00:00:00.000Z'
        )
      `;
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
          'thread-attachment-commitment',
          'project-attachment-commitment',
          'Attachment commitment',
          NULL,
          NULL,
          NULL,
          '2026-08-31T00:00:00.000Z',
          '2026-08-31T00:00:00.000Z'
        )
      `;

      yield* sql`
        INSERT INTO attachment_content_commitments (
          attachment_id,
          thread_id,
          content_sha256,
          size_bytes
        ) VALUES (
          'thread-attachment-commitment-00000000-0000-4000-8000-000000000001',
          'thread-attachment-commitment',
          ${"a".repeat(64)},
          4
        )
      `;

      const malformedDigest = yield* Effect.result(sql`
        INSERT INTO attachment_content_commitments (
          attachment_id,
          thread_id,
          content_sha256,
          size_bytes
        ) VALUES (
          'thread-attachment-commitment-00000000-0000-4000-8000-000000000002',
          'thread-attachment-commitment',
          ${"g".repeat(64)},
          4
        )
      `);
      assert.equal(malformedDigest._tag, "Failure");

      const unknownThread = yield* Effect.result(sql`
        INSERT INTO attachment_content_commitments (
          attachment_id,
          thread_id,
          content_sha256,
          size_bytes
        ) VALUES (
          'unknown-thread-00000000-0000-4000-8000-000000000001',
          'unknown-thread',
          ${"b".repeat(64)},
          4
        )
      `);
      assert.equal(unknownThread._tag, "Failure");

      yield* sql`
        DELETE FROM projection_threads
        WHERE thread_id = 'thread-attachment-commitment'
      `;
      const rows = yield* sql<{ readonly attachmentId: string }>`
        SELECT attachment_id AS "attachmentId"
        FROM attachment_content_commitments
      `;
      assert.deepEqual(rows, []);
    }),
  );
});
