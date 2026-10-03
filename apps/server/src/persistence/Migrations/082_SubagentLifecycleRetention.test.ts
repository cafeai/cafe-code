import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

interface CountRow {
  readonly count: number;
}

interface LatestRow {
  readonly activityId: string;
  readonly childId: string;
  readonly kind: string;
}

interface QueryPlanRow {
  readonly detail: string;
}

it.layer(TestSqliteClient.layerMemory())("082_SubagentLifecycleRetention", (it) => {
  it.effect("installs empty sidecars and maintains exact lifecycle identities", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 81 });
      yield* sql`
        INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
        VALUES ('thread-retention', NULL, 'Retention', '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_thread_activities(
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
        ) VALUES (
          'legacy-before-082', 'thread-retention', 'turn-legacy', 'info', 'task.started',
          'legacy', '{"subagent":{"threadId":"legacy-child"}}',
          '2026-10-04T00:00:00.000Z', 1
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 82 });
      assert.deepStrictEqual(
        yield* sql<CountRow>`SELECT COUNT(*) AS count FROM projection_subagent_lifecycle_sources`,
        [{ count: 0 }],
      );
      assert.deepStrictEqual(
        yield* sql<CountRow>`SELECT COUNT(*) AS count FROM projection_subagent_lifecycle_latest`,
        [{ count: 0 }],
      );
      assert.deepStrictEqual(
        yield* sql<CountRow>`SELECT COUNT(*) AS count FROM projection_subagent_lifecycle_hydration`,
        [{ count: 0 }],
      );
      yield* sql`
        INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
        VALUES ('thread-post-082', NULL, 'New thread', '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z')
      `;
      assert.deepStrictEqual(
        yield* sql<CountRow>`
          SELECT COUNT(*) AS count
          FROM projection_subagent_lifecycle_hydration
          WHERE thread_id = 'thread-post-082' AND completed = 1
        `,
        [{ count: 3 }],
      );

      // An ambient lifecycle edge can carry both the visible presentation id
      // and a distinct task id. Both are exact removal targets in the renderer.
      yield* sql`
        INSERT INTO projection_thread_activities(
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
        ) VALUES (
          'ambient-dual', 'thread-retention', 'turn-a', 'info', 'task.completed', 'hidden',
          ${JSON.stringify({
            visibility: "ambient",
            taskId: "ambient-task",
            subagent: { threadId: "presentation-child" },
          })},
          '2026-10-04T00:00:01.000Z', 2
        )
      `;
      assert.deepStrictEqual(
        yield* sql<LatestRow>`
          SELECT activity_id AS "activityId", child_id AS "childId", kind
          FROM projection_subagent_lifecycle_latest
          ORDER BY child_id
        `,
        [
          { activityId: "ambient-dual", childId: "ambient-task", kind: "task.completed" },
          { activityId: "ambient-dual", childId: "presentation-child", kind: "task.completed" },
        ],
      );

      yield* sql`
        INSERT INTO projection_thread_activities(
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
        ) VALUES
          (
            'start-old', 'thread-retention', 'turn-a', 'info', 'task.started', 'old',
            '{"subagent":{"threadId":"child-a"}}', '2026-10-04T00:00:02.000Z', 10
          ),
          (
            'start-new', 'thread-retention', 'turn-a', 'info', 'task.started', 'new',
            '{"subagent":{"threadId":"child-a"}}', '2026-10-04T00:00:03.000Z', 20
          )
      `;
      assert.deepStrictEqual(
        yield* sql<{ readonly activityId: string }>`
          SELECT activity_id AS "activityId"
          FROM projection_subagent_lifecycle_latest
          WHERE child_id = 'child-a' AND kind = 'task.started'
        `,
        [{ activityId: "start-new" }],
      );

      // Updating the authoritative source to an older order repairs the exact
      // identity pointer from the indexed source history.
      yield* sql`UPDATE projection_thread_activities SET sequence = 5 WHERE activity_id = 'start-new'`;
      assert.deepStrictEqual(
        yield* sql<{ readonly activityId: string }>`
          SELECT activity_id AS "activityId"
          FROM projection_subagent_lifecycle_latest
          WHERE child_id = 'child-a' AND kind = 'task.started'
        `,
        [{ activityId: "start-old" }],
      );
      yield* sql`UPDATE projection_thread_activities SET sequence = 30 WHERE activity_id = 'start-new'`;
      yield* sql`DELETE FROM projection_thread_activities WHERE activity_id = 'start-new'`;
      assert.deepStrictEqual(
        yield* sql<{ readonly activityId: string }>`
          SELECT activity_id AS "activityId"
          FROM projection_subagent_lifecycle_latest
          WHERE child_id = 'child-a' AND kind = 'task.started'
        `,
        [{ activityId: "start-old" }],
      );

      // Null turns, malformed JSON, visible task ids without a structured
      // child, and unsafe exact ids remain ordinary activities but never keys.
      yield* sql`
        INSERT INTO projection_thread_activities(
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
        ) VALUES
          ('null-turn', 'thread-retention', NULL, 'info', 'task.started', 'null turn',
            '{"subagent":{"threadId":"null-child"}}', '2026-10-04T00:00:04.000Z', 40),
          ('malformed', 'thread-retention', 'turn-a', 'info', 'task.progress', 'bad json',
            '{bad', '2026-10-04T00:00:05.000Z', 50),
          ('visible-task-only', 'thread-retention', 'turn-a', 'info', 'task.progress', 'visible',
            '{"visibility":"visible","taskId":"not-a-fallback"}', '2026-10-04T00:00:06.000Z', 60),
          ('unsafe-control', 'thread-retention', 'turn-a', 'info', 'task.progress', 'unsafe',
            ${JSON.stringify({ subagent: { threadId: "unsafe\nchild" } })},
            '2026-10-04T00:00:07.000Z', 70)
      `;
      assert.deepStrictEqual(
        yield* sql<CountRow>`
          SELECT COUNT(*) AS count
          FROM projection_subagent_lifecycle_sources
          WHERE activity_id IN ('null-turn', 'malformed', 'visible-task-only', 'unsafe-control')
        `,
        [{ count: 0 }],
      );

      const acceptedAstralId = "😀".repeat(256);
      const rejectedAstralId = "😀".repeat(300);
      const acceptedMixedId = `${"a".repeat(300)}${"😀".repeat(100)}`;
      yield* sql`
        INSERT INTO projection_thread_activities(
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
        ) VALUES
          (
            'utf16-accepted-astral', 'thread-retention', 'turn-a', 'info', 'task.progress',
            'accepted astral', ${JSON.stringify({ subagent: { threadId: acceptedAstralId } })},
            '2026-10-04T00:00:08.000Z', 80
          ),
          (
            'utf16-rejected-astral', 'thread-retention', 'turn-a', 'info', 'task.progress',
            'rejected astral', ${JSON.stringify({ subagent: { threadId: rejectedAstralId } })},
            '2026-10-04T00:00:09.000Z', 90
          ),
          (
            'utf16-accepted-mixed', 'thread-retention', 'turn-a', 'info', 'task.progress',
            'accepted mixed', ${JSON.stringify({ subagent: { threadId: acceptedMixedId } })},
            '2026-10-04T00:00:10.000Z', 100
          )
      `;
      assert.deepStrictEqual(
        yield* sql<{ readonly activityId: string }>`
          SELECT activity_id AS "activityId"
          FROM projection_subagent_lifecycle_sources
          WHERE activity_id LIKE 'utf16-%'
          ORDER BY activity_id
        `,
        [{ activityId: "utf16-accepted-astral" }, { activityId: "utf16-accepted-mixed" }],
      );

      const sourcePlan = yield* sql<QueryPlanRow>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_subagent_lifecycle_sources
        WHERE thread_id = 'thread-retention'
          AND turn_id = 'turn-a'
          AND child_id = 'child-a'
          AND kind = 'task.started'
        ORDER BY sequence_known DESC, sequence DESC, created_at DESC, activity_id DESC
        LIMIT 1
      `;
      assert.match(
        sourcePlan.map((row) => row.detail).join("\n"),
        /idx_projection_subagent_sources_identity_order/,
      );
      const latestPlan = yield* sql<QueryPlanRow>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_subagent_lifecycle_latest
        WHERE thread_id = 'thread-retention'
        ORDER BY sequence_known DESC, sequence DESC, created_at DESC, activity_id DESC
        LIMIT 12291
      `;
      assert.match(
        latestPlan.map((row) => row.detail).join("\n"),
        /idx_projection_subagent_latest_thread_order/,
      );

      yield* sql`
        INSERT INTO hard_deleted_threads(thread_id, deleted_at)
        VALUES ('thread-retention', '2026-10-04T00:01:00.000Z')
      `;
      assert.deepStrictEqual(
        yield* sql<CountRow>`SELECT COUNT(*) AS count FROM projection_subagent_lifecycle_sources`,
        [{ count: 0 }],
      );
      assert.deepStrictEqual(
        yield* sql<CountRow>`SELECT COUNT(*) AS count FROM projection_subagent_lifecycle_latest`,
        [{ count: 0 }],
      );
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }),
  );
});
