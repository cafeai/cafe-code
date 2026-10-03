import { assert, it } from "@effect/vitest";
import { ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as TestSqliteClient from "../persistence/TestSqliteClient.ts";
import {
  hydrateSubagentLifecyclePage,
  isSubagentLifecycleHydrationComplete,
  SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE,
} from "./subagentLifecycleRetention.ts";

interface CountRow {
  readonly count: number;
}

interface CursorRow {
  readonly createdAt: string;
  readonly activityId: string;
}

interface QueryPlanRow {
  readonly detail: string;
}

it.layer(TestSqliteClient.layerMemory())("subagentLifecycleRetention", (it) => {
  it.effect("hydrates one exact thread in stable bounded pages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-lifecycle-hydration");
      yield* runMigrations({ toMigrationInclusive: 81 });
      yield* sql`
        INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
        VALUES (${threadId}, NULL, 'Hydration', '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z')
      `;

      // Migration 082 must not visit these rows. The requested thread hydrator
      // later reads only a 64-row exact-kind page at a time.
      yield* Effect.forEach(
        Array.from({ length: SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE + 1 }, (_, index) => index),
        (index) => {
          const activityId = `legacy-start-${index.toString().padStart(3, "0")}`;
          const createdAt = new Date(
            Date.parse("2026-10-04T00:00:00.000Z") + index * 1_000,
          ).toISOString();
          const payload =
            index === 10
              ? "{malformed"
              : index === 11
                ? JSON.stringify({ subagent: { threadId: "😀".repeat(300) } })
                : index === 12
                  ? JSON.stringify({ subagent: { threadId: "😀".repeat(256) } })
                  : index === 64
                    ? JSON.stringify({
                        visibility: "ambient",
                        taskId: "ambient-task",
                        subagent: { threadId: "ambient-presentation" },
                      })
                    : JSON.stringify({ subagent: { threadId: `child-${index}` } });
          return sql`
            INSERT INTO projection_thread_activities(
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
            ) VALUES (
              ${activityId}, ${threadId}, 'turn-old', 'info', 'task.started', 'legacy',
              ${payload}, ${createdAt}, ${index}
            )
          `;
        },
        { discard: true },
      );
      // A large newer NULL-turn prefix is intentionally ineligible for roster
      // identity, but it must still advance the same bounded cursor instead of
      // forcing SQLite to scan past it in one synchronous index probe.
      yield* Effect.forEach(
        Array.from({ length: SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE + 1 }, (_, index) => index),
        (index) => sql`
          INSERT INTO projection_thread_activities(
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
          ) VALUES (
            ${`legacy-null-turn-${index.toString().padStart(3, "0")}`},
            ${threadId}, NULL, 'info', 'task.started', 'no visible turn',
            '{"subagent":{"threadId":"null-turn-child"}}',
            ${new Date(Date.parse("2026-10-04T00:02:00.000Z") + index * 1_000).toISOString()},
            ${200 + index}
          )
        `,
        { discard: true },
      );
      yield* runMigrations({ toMigrationInclusive: 82 });

      const firstPage = yield* hydrateSubagentLifecyclePage(sql, threadId);
      assert.isFalse(firstPage.complete);
      assert.isFalse(firstPage.retired);
      assert.isTrue(firstPage.advanced);
      assert.isFalse(yield* isSubagentLifecycleHydrationComplete(sql, threadId));
      assert.deepStrictEqual(
        yield* sql<CountRow>`
          SELECT COUNT(*) AS count
          FROM projection_subagent_lifecycle_sources
          WHERE thread_id = ${threadId}
        `,
        [{ count: 0 }],
      );

      const [cursor] = yield* sql<CursorRow>`
        SELECT
          cursor_created_at AS "createdAt",
          cursor_activity_id AS "activityId"
        FROM projection_subagent_lifecycle_hydration
        WHERE thread_id = ${threadId} AND kind = 'task.started'
      `;
      assert.isDefined(cursor);
      const resumedPagePlan = yield* sql<QueryPlanRow>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
          INDEXED BY idx_projection_thread_activities_thread_kind_created_id
        WHERE thread_id = ${threadId}
          AND kind = 'task.started'
          AND (created_at, activity_id) < (${cursor!.createdAt}, ${cursor!.activityId})
        ORDER BY created_at DESC, activity_id DESC
        LIMIT ${SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE}
      `;
      const resumedPlanText = resumedPagePlan.map((row) => row.detail).join("\n");
      assert.match(resumedPlanText, /idx_projection_thread_activities_thread_kind_created_id/);
      assert.match(resumedPlanText, /\(created_at,activity_id\)<\(\?,\?\)/);

      const secondPage = yield* hydrateSubagentLifecyclePage(sql, threadId);
      assert.isFalse(secondPage.complete);
      assert.isFalse(secondPage.retired);
      assert.isTrue(secondPage.advanced);
      assert.isFalse(yield* isSubagentLifecycleHydrationComplete(sql, threadId));
      assert.deepStrictEqual(
        yield* sql<CountRow>`
          SELECT COUNT(*) AS count
          FROM projection_subagent_lifecycle_sources
          WHERE thread_id = ${threadId}
        `,
        [{ count: SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE - 2 }],
      );

      const thirdPage = yield* hydrateSubagentLifecyclePage(sql, threadId);
      assert.isTrue(thirdPage.complete);
      assert.isTrue(yield* isSubagentLifecycleHydrationComplete(sql, threadId));
      assert.deepStrictEqual(
        yield* sql<CountRow>`
          SELECT COUNT(*) AS count
          FROM projection_subagent_lifecycle_sources
          WHERE thread_id = ${threadId}
        `,
        [{ count: SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE }],
      );
      assert.deepStrictEqual(
        yield* sql<CountRow>`
          SELECT COUNT(*) AS count
          FROM projection_subagent_lifecycle_sources
          WHERE activity_id LIKE 'legacy-null-turn-%' OR activity_id = 'legacy-start-010'
        `,
        [{ count: 0 }],
      );
      assert.deepStrictEqual(
        yield* sql<CountRow>`
          SELECT COUNT(*) AS count
          FROM projection_subagent_lifecycle_hydration
          WHERE thread_id = ${threadId} AND completed = 1
        `,
        [{ count: 3 }],
      );
    }),
  );

  it.effect("lets a permanent thread tombstone retire resumable hydration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-lifecycle-retired");
      yield* runMigrations({ toMigrationInclusive: 81 });
      yield* sql`
        INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
        VALUES (${threadId}, NULL, 'Retired', '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z')
      `;
      yield* Effect.forEach(
        Array.from({ length: SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE + 1 }, (_, index) => index),
        (index) => sql`
          INSERT INTO projection_thread_activities(
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
          ) VALUES (
            ${`retired-${index}`}, ${threadId}, 'turn-old', 'info', 'task.started', 'legacy',
            ${JSON.stringify({ subagent: { threadId: `retired-child-${index}` } })},
            ${new Date(Date.parse("2026-10-04T00:00:00.000Z") + index * 1_000).toISOString()},
            ${index}
          )
        `,
        { discard: true },
      );
      yield* runMigrations({ toMigrationInclusive: 82 });
      // The shared test layer may already have migration 082 installed from a
      // prior case, in which case the post-migration thread trigger correctly
      // initialized complete rows. Remove only this fixture's watermark to
      // model an existing pre-082 thread with resumable work remaining.
      yield* sql`
        DELETE FROM projection_subagent_lifecycle_hydration
        WHERE thread_id = ${threadId}
      `;
      assert.isFalse((yield* hydrateSubagentLifecyclePage(sql, threadId)).complete);

      yield* sql`
        INSERT INTO hard_deleted_threads(thread_id, deleted_at)
        VALUES (${threadId}, '2026-10-04T00:05:00.000Z')
      `;
      const afterRetirement = yield* hydrateSubagentLifecyclePage(sql, threadId);
      assert.isTrue(afterRetirement.retired);
      assert.isFalse(afterRetirement.complete);
      assert.isFalse(afterRetirement.advanced);
      assert.deepStrictEqual(
        yield* sql<CountRow>`
          SELECT COUNT(*) AS count
          FROM projection_subagent_lifecycle_sources
          WHERE thread_id = ${threadId}
        `,
        [{ count: 0 }],
      );
    }),
  );
});
