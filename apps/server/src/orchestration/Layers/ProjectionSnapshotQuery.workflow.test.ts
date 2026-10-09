import { createHash } from "node:crypto";

import { ThreadId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationProjectionSnapshotQueryLive,
  THREAD_DETAIL_ACTIVITY_LIMIT,
} from "./ProjectionSnapshotQuery.ts";

const at = "2026-10-09T00:00:00.000Z";
const currentTurn = "workflow-current-turn";
const account = "claude-account-a";
const taskId = "native-root";
const runtimeId = "10000000-0000-4000-8000-000000000001";
const secondRuntimeId = "20000000-0000-4000-8000-000000000001";
const workflowIdentity = (turnId: string, runtime: string) =>
  `sha256:workflow:${createHash("sha256")
    .update(JSON.stringify([turnId, taskId, account, runtime]), "utf8")
    .digest("hex")}`;
const payload = (turnId: string, runtime = runtimeId) => ({
  taskId,
  workflow: { runtimeId: runtime, providerInstanceId: account, name: "Independent review" },
  workflowRetentionId: workflowIdentity(turnId, runtime),
});

function insertThread(sql: SqlClient.SqlClient, threadId: ThreadId) {
  return sql`
    INSERT INTO projection_threads(
      thread_id, project_id, title, model_selection_json, latest_turn_id, created_at, updated_at
    ) VALUES (
      ${threadId}, NULL, 'Workflow snapshot fixture',
      '{"instanceId":"claude-account-a","model":"claude-fable-5-1"}',
      ${currentTurn}, ${at}, ${at}
    )
  `;
}

function insertActivity(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  activityId: string,
  turnId: string,
  kind: string,
  value: unknown,
  sequence: number,
) {
  return sql`
    INSERT INTO projection_thread_activities(
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
    ) VALUES (
      ${activityId}, ${threadId}, ${turnId}, 'info', ${kind}, 'Workflow received',
      ${JSON.stringify(value)}, ${at}, ${sequence}
    )
  `;
}

function insertTail(sql: SqlClient.SqlClient, threadId: ThreadId) {
  // Tail rows are deliberately outside lifecycle kinds. The detail read must
  // retain its normal bounded window while separately hydrating exact roots.
  return sql`
    WITH RECURSIVE tail(index_value) AS (
      SELECT 1 UNION ALL SELECT index_value + 1 FROM tail
      WHERE index_value < ${THREAD_DETAIL_ACTIVITY_LIMIT + 1}
    )
    INSERT INTO projection_thread_activities(
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
    )
    SELECT ${threadId} || '-tail-' || index_value, ${threadId}, ${currentTurn},
      'tool', 'tool.completed', 'Bounded tail', '{}', ${at}, index_value + 10_000
    FROM tail
  `;
}

const snapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(
      Layer.succeed(RepositoryIdentityResolver, {
        resolve: () =>
          Effect.die("Standalone workflow snapshot must not resolve a live repository"),
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

snapshotLayer("ProjectionSnapshotQuery workflow retention", (it) => {
  it.effect(
    "retains old/current exact-generation terminal roots beyond the bounded activity tail",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const snapshot = yield* ProjectionSnapshotQuery;
        const threadId = ThreadId.make("workflow-snapshot-global");
        yield* insertThread(sql, threadId);
        const roots = [
          { prefix: "old-query", turnId: "workflow-old-turn", runtime: runtimeId },
          { prefix: "new-query", turnId: currentTurn, runtime: secondRuntimeId },
        ];
        const expectedIds: string[] = [];
        let sequence = 0;
        for (const root of roots) {
          for (const [kind, suffix] of [
            ["task.started", "start"],
            ["task.progress", "progress"],
            ["task.completed", "completed"],
          ] as const) {
            const activityId = `${root.prefix}-${suffix}`;
            expectedIds.push(activityId);
            yield* insertActivity(
              sql,
              threadId,
              activityId,
              root.turnId,
              kind,
              {
                ...payload(root.turnId, root.runtime),
                ...(kind === "task.completed" ? { status: "completed" } : {}),
              },
              ++sequence,
            );
          }
        }
        // Invalid legacy-looking metadata cannot manufacture additional retained
        // identities merely because its native task spelling matches a real root.
        yield* insertActivity(
          sql,
          threadId,
          "malformed-global-root",
          currentTurn,
          "task.started",
          { ...payload(currentTurn), workflowRetentionId: `sha256:workflow:${"G".repeat(64)}` },
          ++sequence,
        );
        yield* insertTail(sql, threadId);
        const detail = yield* snapshot.getThreadDetailById(threadId);
        assert.equal(detail._tag, "Some");
        if (detail._tag !== "Some") return;
        assert.equal(
          detail.value.activities.length,
          THREAD_DETAIL_ACTIVITY_LIMIT + expectedIds.length,
        );
        assert.deepStrictEqual(
          detail.value.activities.slice(0, expectedIds.length).map((activity) => activity.id),
          expectedIds,
        );
        for (const root of roots) {
          const rows = detail.value.activities.filter((activity) =>
            activity.id.startsWith(`${root.prefix}-`),
          );
          const payloads = rows.map(
            (row) => row.payload as Readonly<Record<string, unknown>> | undefined,
          );
          assert.deepStrictEqual(
            payloads.map((value) => value?.workflowRetentionId),
            Array(3).fill(workflowIdentity(root.turnId, root.runtime)),
          );
          assert.deepStrictEqual(
            rows.map((row) => row.kind),
            ["task.started", "task.progress", "task.completed"],
          );
          assert.equal(payloads[2]?.status, "completed");
        }
        assert.isFalse(
          detail.value.activities.some((activity) => activity.id === "malformed-global-root"),
        );
        assert.notEqual(
          workflowIdentity(roots[0]!.turnId, runtimeId),
          workflowIdentity(currentTurn, secondRuntimeId),
        );
      }),
  );

  it.effect(
    "uses the same strict owner/digest gates in incomplete legacy current-turn fallback",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const snapshot = yield* ProjectionSnapshotQuery;
        const threadId = ThreadId.make("workflow-snapshot-legacy");
        yield* insertThread(sql, threadId);
        const valid = payload(currentTurn);
        const malformed = [
          { ...valid, workflowRetentionId: `sha256:workflow:${"A".repeat(64)}` },
          { ...valid, workflowRetentionId: `sha256:workflow:${"g".repeat(64)}` },
          {
            ...valid,
            workflowRetentionId: `${workflowIdentity(currentTurn, runtimeId)}\u0000suffix`,
          },
          { ...valid, workflowRetentionId: `${workflowIdentity(currentTurn, runtimeId)}suffix` },
          ...[
            "owner\u0000",
            "owner\n",
            "owner\u202e",
            "owner\u2066",
            "owner space",
            "所有者",
            "owner/slash",
            "a".repeat(129),
          ].flatMap((owner) => [
            { ...valid, workflow: { ...valid.workflow, runtimeId: owner } },
            { ...valid, workflow: { ...valid.workflow, providerInstanceId: owner } },
          ]),
        ];
        let sequence = 0;
        for (const [index, value] of malformed.entries()) {
          yield* insertActivity(
            sql,
            threadId,
            `malformed-legacy-root-${index}`,
            currentTurn,
            "task.started",
            value,
            ++sequence,
          );
        }
        yield* insertActivity(
          sql,
          threadId,
          "legacy-other-turn-root",
          "other-turn",
          "task.started",
          payload("other-turn"),
          ++sequence,
        );
        // These 65 newer valid roots occupy the first 64-row hydration page.
        // The subsequent detail query therefore exercises the legacy fallback,
        // not the complete compact all-turn sidecar lane.
        const validIds: string[] = [];
        for (let index = 0; index < 65; index++) {
          const activityId = `legacy-valid-root-${index.toString().padStart(3, "0")}`;
          validIds.push(activityId);
          const runtime = `30000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
          yield* insertActivity(
            sql,
            threadId,
            activityId,
            currentTurn,
            "task.started",
            payload(currentTurn, runtime),
            ++sequence,
          );
        }
        yield* insertTail(sql, threadId);
        yield* sql`DELETE FROM projection_subagent_lifecycle_sources WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM projection_subagent_lifecycle_hydration WHERE thread_id = ${threadId}`;
        const detail = yield* snapshot.getThreadDetailById(threadId);
        assert.equal(detail._tag, "Some");
        if (detail._tag !== "Some") return;
        assert.equal(
          detail.value.activities.length,
          THREAD_DETAIL_ACTIVITY_LIMIT + validIds.length,
        );
        assert.deepStrictEqual(
          detail.value.activities
            .filter((activity) => activity.id.startsWith("legacy-valid-root-"))
            .map((activity) => activity.id),
          validIds,
        );
        assert.isFalse(
          detail.value.activities.some((activity) =>
            activity.id.startsWith("malformed-legacy-root-"),
          ),
        );
        assert.isFalse(
          detail.value.activities.some((activity) => activity.id === "legacy-other-turn-root"),
        );
      }),
  );
});
