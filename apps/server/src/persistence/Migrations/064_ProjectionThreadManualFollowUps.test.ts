import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import { DEFAULT_THREAD_MANUAL_FOLLOW_UPS_JSON } from "./064_ProjectionThreadManualFollowUps.ts";

describe("064_ProjectionThreadManualFollowUps", () => {
  it.effect("adds an empty durable FIFO to existing Cafe threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, branch, worktree_path, latest_turn_id, created_at, updated_at
        ) VALUES (
          'thread-existing', 'project-1', 'Existing thread', NULL, NULL, NULL,
          '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z'
        )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 64 });
      assert.deepStrictEqual(executed, [[64, "ProjectionThreadManualFollowUps"]]);
      const rows = yield* sql<{ readonly queue: string }>`
        SELECT manual_follow_ups_json AS "queue"
        FROM projection_threads
        WHERE thread_id = 'thread-existing'
      `;
      assert.equal(rows[0]?.queue, DEFAULT_THREAD_MANUAL_FOLLOW_UPS_JSON);
    }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
  );
});
