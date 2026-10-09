import { createHash } from "node:crypto";

import { ThreadId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as TestSqliteClient from "../persistence/TestSqliteClient.ts";
import {
  hydrateSubagentLifecyclePage,
  isSubagentLifecycleHydrationComplete,
  SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE,
} from "./subagentLifecycleRetention.ts";

const turnId = "workflow-hydration-turn";
const taskId = "native-root";
const account = "claude-account-a";
const runtimeId = "10000000-0000-4000-8000-000000000001";
const workflowIdentity = (runtime: string) =>
  `sha256:workflow:${createHash("sha256")
    .update(JSON.stringify([turnId, taskId, account, runtime]), "utf8")
    .digest("hex")}`;
const payload = (runtime = runtimeId) => ({
  taskId,
  workflow: { runtimeId: runtime, providerInstanceId: account },
  workflowRetentionId: workflowIdentity(runtime),
});

it.layer(TestSqliteClient.layerMemory())("workflowLifecycleRetention", (it) => {
  it.effect("hydrates only requested-thread legacy workflow identities through bounded pages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("workflow-legacy-hydration");
      const otherThreadId = ThreadId.make("workflow-legacy-not-requested");
      yield* runMigrations({ toMigrationInclusive: 81 });
      for (const id of [threadId, otherThreadId]) {
        yield* sql`
          INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
          VALUES (${id}, NULL, 'Legacy workflow fixture', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')
        `;
      }

      const validCount = SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE + 1;
      const valid = payload();
      const malformed = [
        { ...valid, workflowRetentionId: `sha256:workflow:${"A".repeat(64)}` },
        { ...valid, workflowRetentionId: `sha256:workflow:${"g".repeat(64)}` },
        { ...valid, workflowRetentionId: `${workflowIdentity(runtimeId)}suffix` },
        { ...valid, workflowRetentionId: `${workflowIdentity(runtimeId)}\u0000suffix` },
        { ...valid, workflowRetentionId: `sha256:workflow:${"a".repeat(63)}` },
        { ...valid, workflowRetentionId: `sha256:other:${"a".repeat(64)}` },
        { ...valid, workflow: { runtimeId: "a".repeat(129), providerInstanceId: account } },
        { ...valid, workflow: { runtimeId, providerInstanceId: "a".repeat(129) } },
        ...[
          "owner\u0000",
          "owner\n",
          "owner\u202e",
          "owner\u2066",
          "owner space",
          "所有者",
          "owner/slash",
        ].flatMap((owner) => [
          { ...valid, workflow: { runtimeId: owner, providerInstanceId: account } },
          { ...valid, workflow: { runtimeId, providerInstanceId: owner } },
        ]),
      ];
      const validRuntimes = Array.from(
        { length: validCount },
        (_, index) => `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      );
      for (let index = 0; index < validCount + malformed.length; index++) {
        const value =
          index < validCount ? payload(validRuntimes[index]!) : malformed[index - validCount];
        // The oldest row carries ordinary and ambient keys as well. These
        // remain separate opaque identities rather than being replaced by the
        // workflow digest during legacy hydration.
        const withOrdinaryIdentities =
          index === 0
            ? {
                ...value,
                visibility: "ambient",
                subagent: { threadId: "ordinary-child" },
              }
            : value;
        const createdAt = new Date(
          Date.parse("2026-10-09T00:00:00.000Z") + index * 1_000,
        ).toISOString();
        yield* sql`
          INSERT INTO projection_thread_activities(
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
          ) VALUES (
            ${`legacy-workflow-${index.toString().padStart(3, "0")}`}, ${threadId}, ${turnId},
            'info', 'task.started', 'Legacy workflow', ${JSON.stringify(withOrdinaryIdentities)},
            ${createdAt}, ${index}
          )
        `;
      }
      yield* sql`
        INSERT INTO projection_thread_activities(
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
        ) VALUES (
          'other-thread-legacy-workflow', ${otherThreadId}, ${turnId}, 'info', 'task.started',
          'Unrequested workflow', ${JSON.stringify(valid)}, '2026-10-09T00:00:00.000Z', 1
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 90 });
      assert.deepStrictEqual(
        yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_subagent_lifecycle_sources
      `,
        [{ count: 0 }],
      );

      const firstPage = yield* hydrateSubagentLifecyclePage(sql, threadId);
      assert.isTrue(firstPage.advanced);
      assert.isFalse(firstPage.complete);
      assert.isFalse(firstPage.retired);
      assert.isFalse(yield* isSubagentLifecycleHydrationComplete(sql, threadId));
      assert.deepStrictEqual(
        yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_subagent_lifecycle_sources WHERE thread_id = ${threadId}
      `,
        [{ count: SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE - malformed.length }],
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly activityId: string }>`
        SELECT cursor_activity_id AS "activityId" FROM projection_subagent_lifecycle_hydration
        WHERE thread_id = ${threadId} AND kind = 'task.started'
      `,
        [
          {
            activityId: `legacy-workflow-${(validCount + malformed.length - SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE).toString().padStart(3, "0")}`,
          },
        ],
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_subagent_lifecycle_hydration WHERE thread_id = ${otherThreadId}
      `,
        [{ count: 0 }],
      );

      const secondPage = yield* hydrateSubagentLifecyclePage(sql, threadId);
      assert.isTrue(secondPage.advanced);
      assert.isTrue(secondPage.complete);
      assert.isTrue(yield* isSubagentLifecycleHydrationComplete(sql, threadId));
      const identities = yield* sql<{ readonly childId: string }>`
        SELECT child_id AS "childId" FROM projection_subagent_lifecycle_sources
        WHERE thread_id = ${threadId} ORDER BY child_id
      `;
      assert.deepStrictEqual(
        identities.map((row) => row.childId),
        [taskId, "ordinary-child", ...validRuntimes.map(workflowIdentity)].sort(),
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_subagent_lifecycle_sources WHERE thread_id = ${otherThreadId}
      `,
        [{ count: 0 }],
      );
      const afterComplete = yield* hydrateSubagentLifecyclePage(sql, threadId);
      assert.isTrue(afterComplete.complete);
      assert.isFalse(afterComplete.advanced);
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }),
  );
});
