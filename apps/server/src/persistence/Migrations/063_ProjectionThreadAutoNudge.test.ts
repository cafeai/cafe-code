import { ThreadAutoNudgeConfig } from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import { DEFAULT_THREAD_AUTO_NUDGE_JSON } from "./063_ProjectionThreadAutoNudge.ts";

const decodeThreadAutoNudgeConfig = Schema.decodeUnknownEffect(ThreadAutoNudgeConfig);

describe("063_ProjectionThreadAutoNudge", () => {
  it.effect("adds disabled exact-thread authority to existing Cafe threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, branch, worktree_path, latest_turn_id, created_at, updated_at
        ) VALUES (
          'thread-existing', 'project-1', 'Existing thread', NULL, NULL, NULL,
          '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z'
        )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 63 });
      assert.deepStrictEqual(executed, [[63, "ProjectionThreadAutoNudge"]]);
      const rows = yield* sql<{ readonly config: string }>`
        SELECT auto_nudge_json AS "config"
        FROM projection_threads
        WHERE thread_id = 'thread-existing'
      `;
      assert.equal(rows[0]?.config, DEFAULT_THREAD_AUTO_NUDGE_JSON);
      const config = yield* decodeThreadAutoNudgeConfig(JSON.parse(rows[0]?.config ?? "{}"));
      assert.equal(config.mode, "off");
      assert.equal(config.lastDispatchedMessageId, null);
    }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
  );
});
