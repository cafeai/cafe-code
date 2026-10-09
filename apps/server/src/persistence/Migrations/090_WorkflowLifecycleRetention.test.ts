import { createHash } from "node:crypto";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const at = "2026-10-09T00:00:00.000Z";
const runtimeId = "10000000-0000-4000-8000-000000000001";
const secondRuntimeId = "20000000-0000-4000-8000-000000000001";
const account = "claude-account-a";
const workflowIdentity = (runtime = runtimeId, instance = account) =>
  `sha256:workflow:${createHash("sha256")
    .update(JSON.stringify(["turn-workflow", "native-root", instance, runtime]), "utf8")
    .digest("hex")}`;
const payload = (runtime = runtimeId, instance = account) => ({
  taskId: "native-root",
  workflow: { runtimeId: runtime, providerInstanceId: instance },
  workflowRetentionId: workflowIdentity(runtime, instance),
});

function insertThread(sql: SqlClient.SqlClient, threadId: string) {
  return sql`
    INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
    VALUES (${threadId}, NULL, 'Workflow retention fixture', ${at}, ${at})
  `;
}
function insertActivity(
  sql: SqlClient.SqlClient,
  threadId: string,
  activityId: string,
  kind: string,
  value: unknown,
  sequence: number,
  turnId: string | null = "turn-workflow",
) {
  return sql`
    INSERT INTO projection_thread_activities(
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
    ) VALUES (
      ${activityId}, ${threadId}, ${turnId}, 'info', ${kind}, 'Received workflow metadata',
      ${JSON.stringify(value)}, ${at}, ${sequence}
    )
  `;
}

it.layer(TestSqliteClient.layerMemory())("090_WorkflowLifecycleRetention", (it) => {
  it.effect("replaces only the activity triggers without scanning or backfilling history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 89 });
      const threadId = "workflow-before-090";
      yield* insertThread(sql, threadId);
      yield* insertActivity(
        sql,
        threadId,
        "workflow-before-migration",
        "task.started",
        payload(),
        1,
      );
      yield* insertActivity(
        sql,
        threadId,
        "ordinary-before-migration",
        "task.started",
        {
          subagent: { threadId: "ordinary-child" },
        },
        2,
      );
      const sourcesBefore = yield* sql`
        SELECT * FROM projection_subagent_lifecycle_sources ORDER BY activity_id, child_id
      `;
      const latestBefore = yield* sql`
        SELECT * FROM projection_subagent_lifecycle_latest ORDER BY activity_id, child_id
      `;
      const hydrationBefore = yield* sql`
        SELECT * FROM projection_subagent_lifecycle_hydration ORDER BY thread_id, kind
      `;
      const activitiesBefore = yield* sql`
        SELECT * FROM projection_thread_activities ORDER BY activity_id
      `;

      yield* runMigrations({ toMigrationInclusive: 90 });
      assert.deepStrictEqual(
        yield* sql`
        SELECT * FROM projection_subagent_lifecycle_sources ORDER BY activity_id, child_id
      `,
        sourcesBefore,
      );
      assert.deepStrictEqual(
        yield* sql`
        SELECT * FROM projection_subagent_lifecycle_latest ORDER BY activity_id, child_id
      `,
        latestBefore,
      );
      assert.deepStrictEqual(
        yield* sql`
        SELECT * FROM projection_subagent_lifecycle_hydration ORDER BY thread_id, kind
      `,
        hydrationBefore,
      );
      assert.deepStrictEqual(
        yield* sql`
        SELECT * FROM projection_thread_activities ORDER BY activity_id
      `,
        activitiesBefore,
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly activityId: string }>`
        SELECT activity_id AS "activityId" FROM projection_subagent_lifecycle_sources
        WHERE thread_id = ${threadId}
      `,
        [{ activityId: "ordinary-before-migration" }],
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name IN (
          'trg_projection_activity_insert_subagent_source',
          'trg_projection_activity_update_subagent_source'
        ) ORDER BY name
      `,
        [
          { name: "trg_projection_activity_insert_subagent_source" },
          { name: "trg_projection_activity_update_subagent_source" },
        ],
      );
    }),
  );

  it.effect(
    "preserves ordinary and ambient identities beside exact workflow query/account digests",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 90 });
        const threadId = "workflow-native-identities";
        yield* insertThread(sql, threadId);
        yield* insertActivity(
          sql,
          threadId,
          "ordinary-090",
          "task.started",
          {
            subagent: { threadId: "ordinary-child" },
          },
          1,
        );
        yield* insertActivity(
          sql,
          threadId,
          "ambient-090",
          "task.completed",
          {
            visibility: "ambient",
            taskId: "ambient-task",
            subagent: { threadId: "ambient-child" },
          },
          2,
        );
        yield* insertActivity(sql, threadId, "workflow-runtime-a", "task.started", payload(), 3);
        yield* insertActivity(
          sql,
          threadId,
          "workflow-runtime-b",
          "task.started",
          payload(secondRuntimeId),
          4,
        );
        yield* insertActivity(
          sql,
          threadId,
          "workflow-account-b",
          "task.started",
          payload(runtimeId, "claude-account-b"),
          5,
        );
        assert.deepStrictEqual(
          yield* sql<{ readonly activityId: string; readonly childId: string }>`
        SELECT activity_id AS "activityId", child_id AS "childId"
        FROM projection_subagent_lifecycle_sources WHERE thread_id = ${threadId}
        ORDER BY activity_id, child_id
      `,
          [
            { activityId: "ambient-090", childId: "ambient-child" },
            { activityId: "ambient-090", childId: "ambient-task" },
            { activityId: "ordinary-090", childId: "ordinary-child" },
            {
              activityId: "workflow-account-b",
              childId: workflowIdentity(runtimeId, "claude-account-b"),
            },
            { activityId: "workflow-runtime-a", childId: workflowIdentity() },
            { activityId: "workflow-runtime-b", childId: workflowIdentity(secondRuntimeId) },
          ],
        );
        assert.notEqual(workflowIdentity(), workflowIdentity(secondRuntimeId));
        assert.notEqual(workflowIdentity(), workflowIdentity(runtimeId, "claude-account-b"));
      }),
  );

  it.effect(
    "rejects malformed retention/provenance envelopes and non-lifecycle or null-turn rows",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 90 });
        const threadId = "workflow-malformed-retention";
        yield* insertThread(sql, threadId);
        const valid = payload();
        const malformed: unknown[] = [
          { ...valid, workflowRetentionId: "native-root" },
          { ...valid, workflowRetentionId: `sha256:other:${"a".repeat(64)}` },
          { ...valid, workflowRetentionId: `sha256:workflow:${"A".repeat(64)}` },
          { ...valid, workflowRetentionId: `sha256:workflow:${"g".repeat(64)}` },
          { ...valid, workflowRetentionId: `${workflowIdentity()}extra` },
          { ...valid, workflowRetentionId: `${workflowIdentity()}\u0000suffix` },
          { ...valid, workflowRetentionId: `sha256:workflow:${"a".repeat(63)}` },
          { ...valid, workflow: null },
          { ...valid, workflow: { runtimeId: "", providerInstanceId: account } },
          { ...valid, workflow: { runtimeId: 42, providerInstanceId: account } },
          { ...valid, workflow: { runtimeId, providerInstanceId: "" } },
          { ...valid, workflow: { runtimeId, providerInstanceId: [] } },
          { ...valid, workflow: { runtimeId: "a".repeat(129), providerInstanceId: account } },
          { ...valid, workflow: { runtimeId, providerInstanceId: "a".repeat(129) } },
          // Persisted legacy metadata cannot authorize a workflow identity by
          // hiding controls, bidi marks, whitespace, or non-ASCII in its owner.
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
        for (let index = 0; index < malformed.length; index++) {
          yield* insertActivity(
            sql,
            threadId,
            `malformed-workflow-${index}`,
            "task.progress",
            malformed[index],
            index,
          );
        }
        yield* insertActivity(
          sql,
          threadId,
          "workflow-non-lifecycle",
          "runtime.warning",
          valid,
          100,
        );
        yield* insertActivity(
          sql,
          threadId,
          "workflow-null-turn",
          "task.progress",
          valid,
          101,
          null,
        );
        yield* sql`
        INSERT INTO projection_thread_activities(
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
        ) VALUES ('workflow-invalid-json', ${threadId}, 'turn-workflow', 'info', 'task.progress',
          'Malformed JSON', '{bad', ${at}, 102)
      `;
        assert.deepStrictEqual(
          yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_subagent_lifecycle_sources WHERE thread_id = ${threadId}
      `,
          [{ count: 0 }],
        );
      }),
  );

  it.effect(
    "rekeys updates and repairs ordered lifecycle pointers on deletion without manufacturing completion",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 90 });
        const threadId = "workflow-updated-retention";
        yield* insertThread(sql, threadId);
        for (const [activityId, kind, sequence] of [
          ["workflow-start", "task.started", 1],
          ["workflow-progress-old", "task.progress", 2],
          ["workflow-completed", "task.completed", 3],
          ["workflow-progress-new", "task.progress", 4],
        ] as const) {
          yield* insertActivity(sql, threadId, activityId, kind, payload(), sequence);
        }
        const latest = () => sql<{ readonly activityId: string; readonly kind: string }>`
        SELECT activity_id AS "activityId", kind FROM projection_subagent_lifecycle_latest
        WHERE thread_id = ${threadId} AND child_id = ${workflowIdentity()} ORDER BY kind
      `;
        assert.deepStrictEqual(yield* latest(), [
          { activityId: "workflow-completed", kind: "task.completed" },
          { activityId: "workflow-progress-new", kind: "task.progress" },
          { activityId: "workflow-start", kind: "task.started" },
        ]);
        yield* sql`UPDATE projection_thread_activities SET sequence = 0 WHERE activity_id = 'workflow-progress-new'`;
        assert.equal(
          (yield* latest()).find((row) => row.kind === "task.progress")?.activityId,
          "workflow-progress-old",
        );
        yield* sql`UPDATE projection_thread_activities SET payload_json = ${JSON.stringify(payload(secondRuntimeId))}
        WHERE activity_id = 'workflow-progress-new'`;
        assert.deepStrictEqual(
          yield* sql<{ readonly childId: string }>`
        SELECT child_id AS "childId" FROM projection_subagent_lifecycle_sources
        WHERE activity_id = 'workflow-progress-new'
      `,
          [{ childId: workflowIdentity(secondRuntimeId) }],
        );
        yield* sql`UPDATE projection_thread_activities SET kind = 'runtime.warning'
        WHERE activity_id = 'workflow-progress-new'`;
        assert.deepStrictEqual(
          yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_subagent_lifecycle_sources
        WHERE activity_id = 'workflow-progress-new'
      `,
          [{ count: 0 }],
        );
        yield* sql`DELETE FROM projection_thread_activities WHERE activity_id = 'workflow-progress-old'`;
        assert.deepStrictEqual(yield* latest(), [
          { activityId: "workflow-completed", kind: "task.completed" },
          { activityId: "workflow-start", kind: "task.started" },
        ]);
        yield* sql`INSERT INTO hard_deleted_threads(thread_id, deleted_at) VALUES (${threadId}, ${at})`;
        // Permanent thread retirement rejects the activity itself, not merely
        // its lifecycle sidecar. Verify both barriers rather than bypassing the
        // preexisting tombstone trigger to exercise the new trigger in isolation.
        const afterRetirement = yield* Effect.exit(
          insertActivity(sql, threadId, "workflow-after-tombstone", "task.progress", payload(), 5),
        );
        assert.isTrue(Exit.isFailure(afterRetirement));
        assert.deepStrictEqual(
          yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_subagent_lifecycle_sources WHERE thread_id = ${threadId}
      `,
          [{ count: 0 }],
        );
        assert.deepStrictEqual(yield* latest(), []);
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }),
  );
});
