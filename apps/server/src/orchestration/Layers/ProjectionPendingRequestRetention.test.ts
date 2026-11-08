import { EventId, ThreadId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceTest } from "../../persistence/Sqlite.test.fixture.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationProjectionSnapshotQueryLive,
  THREAD_DETAIL_ACTIVITY_LIMIT,
} from "./ProjectionSnapshotQuery.ts";

const at = "2026-11-02T00:00:00.000Z";
const ownerTurn = "pending-request-completed-turn";
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const questions = [
  {
    id: "choice",
    header: "Choice",
    question: "Which option?",
    options: [{ label: "Continue", description: "Continue this exact request" }],
    multiSelect: false,
  },
];

function insertThread(sql: SqlClient.SqlClient, threadId: ThreadId) {
  return sql`
    INSERT INTO projection_threads(
      thread_id, project_id, title, model_selection_json, latest_turn_id,
      pending_approval_count, pending_user_input_count, created_at, updated_at
    ) VALUES (
      ${threadId}, NULL, 'Pending interaction snapshot',
      '{"instanceId":"claude-account","model":"claude-opus-5-5"}',
      ${ownerTurn}, 0, 0, ${at}, ${at}
    )
  `;
}

function insertActivity(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  activityId: string,
  kind: string,
  payload: unknown,
  sequence: number | null,
) {
  return sql`
    INSERT INTO projection_thread_activities(
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
    ) VALUES (
      ${activityId}, ${threadId}, ${ownerTurn}, 'info', ${kind}, 'Interaction lifecycle',
      ${encodeJson(payload)}, ${at}, ${sequence}
    )
  `;
}

function insertTail(sql: SqlClient.SqlClient, threadId: ThreadId) {
  return sql`
    WITH RECURSIVE tail(index_value) AS (
      SELECT 1 UNION ALL SELECT index_value + 1 FROM tail
      WHERE index_value < ${THREAD_DETAIL_ACTIVITY_LIMIT + 1}
    )
    INSERT INTO projection_thread_activities(
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
    )
    SELECT ${threadId} || '-tail-' || index_value, ${threadId}, ${ownerTurn}, 'tool',
      'tool.completed', 'Ordinary bounded activity', '{}', ${at}, index_value + 10_000
    FROM tail
  `;
}

const snapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(
      Layer.succeed(RepositoryIdentityResolver, {
        resolve: () =>
          Effect.die("Standalone interaction snapshot must not resolve a live repository"),
      }),
    ),
    Layer.provideMerge(SqlitePersistenceTest),
    Layer.provideMerge(NodeServices.layer),
  ),
);

snapshotLayer("ProjectionSnapshotQuery pending interaction retention", (it) => {
  it.effect(
    "rehydrates independent pending decisions after their completed turn leaves the activity tail",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const snapshot = yield* ProjectionSnapshotQuery;
        const threadId = ThreadId.make("pending-retention-completed-owner");
        yield* insertThread(sql, threadId);
        yield* sql`
        INSERT INTO projection_turns(
          thread_id, turn_id, state, requested_at, started_at, completed_at, checkpoint_files_json
        ) VALUES (${threadId}, ${ownerTurn}, 'completed', ${at}, ${at}, ${at}, '[]')
      `;
        yield* sql`
        INSERT INTO projection_pending_approvals(
          request_id, thread_id, turn_id, status, decision, created_at, resolved_at
        ) VALUES ('shared-decision-id', ${threadId}, ${ownerTurn}, 'pending', NULL, ${at}, NULL)
      `;
        const approval = {
          requestId: "shared-decision-id",
          requestKind: "command",
          detail: "Review this exact command",
          defaultToNo: true,
          suppressAlwaysAllowRule: true,
        };
        const question = {
          requestId: "shared-decision-id",
          questions,
          isBlocking: false,
          supportsUnanswered: true,
        };
        yield* insertActivity(
          sql,
          threadId,
          "pending-old-approval",
          "approval.requested",
          approval,
          1,
        );
        yield* insertActivity(
          sql,
          threadId,
          "pending-old-question",
          "user-input.requested",
          question,
          2,
        );
        yield* insertActivity(
          sql,
          threadId,
          "pending-ordinary-failure",
          "provider.user-input.respond.failed",
          { requestId: "shared-decision-id", detail: "Temporary provider transport failure" },
          3,
        );
        yield* insertActivity(
          sql,
          threadId,
          "pending-stale-question",
          "user-input.requested",
          { requestId: "retired-question", questions },
          4,
        );
        yield* insertActivity(
          sql,
          threadId,
          "pending-stale-response",
          "provider.user-input.respond.failed",
          { requestId: "retired-question", detail: "stale pending user-input request" },
          5,
        );
        // Malformed provider data is not a stale-request observation. Neither
        // channel may stringify an arbitrary object into retirement evidence.
        for (const [kind, suffix, phrase, sequence] of [
          ["provider.approval.respond.failed", "approval", "unknown pending approval request", 6],
          [
            "provider.user-input.respond.failed",
            "question",
            "unknown pending user-input request",
            7,
          ],
        ] as const) {
          yield* insertActivity(
            sql,
            threadId,
            `pending-malformed-${suffix}-failure`,
            kind,
            { requestId: "shared-decision-id", detail: { message: phrase } },
            sequence,
          );
        }
        yield* insertTail(sql, threadId);

        // A reconnect must recover the same exact requests and their restrictions;
        // completing the root is not permission to cancel an independent callback.
        for (let read = 0; read < 2; read += 1) {
          const detail = Option.getOrThrow(yield* snapshot.getThreadDetailById(threadId));
          assert.equal(detail.latestTurn?.state, "completed");
          assert.equal(detail.activities.length, THREAD_DETAIL_ACTIVITY_LIMIT + 2);
          assert.equal(detail.pendingRequestRetentionTruncated, false);
          const retainedApproval = detail.activities.find(
            (activity) => activity.id === EventId.make("pending-old-approval"),
          );
          const retainedQuestion = detail.activities.find(
            (activity) => activity.id === EventId.make("pending-old-question"),
          );
          assert.ok(retainedApproval);
          assert.ok(retainedQuestion);
          assert.equal(retainedApproval.turnId, ownerTurn);
          assert.equal(retainedQuestion.turnId, ownerTurn);
          assert.deepEqual(retainedApproval.payload, approval);
          assert.deepEqual(retainedQuestion.payload, question);
          assert.equal(
            detail.activities.some(
              (activity) => activity.id === EventId.make("pending-stale-question"),
            ),
            false,
          );
        }
      }),
  );

  it.effect("retains an evicted legacy resolution beside its still-visible request", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const snapshot = yield* ProjectionSnapshotQuery;
      const threadId = ThreadId.make("pending-retention-legacy-terminal");
      yield* insertThread(sql, threadId);
      // These legacy edges share a clock and lack sequence evidence. The
      // ordinary window sorts opaque ids, whereas the request fold places a
      // genuine resolution after its same-clock request. Retain both edges so
      // reconnecting cannot manufacture a new unanswered question.
      yield* insertActivity(
        sql,
        threadId,
        "z-legacy-request-kept",
        "user-input.requested",
        { requestId: "legacy-settled-question", questions },
        null,
      );
      yield* insertActivity(
        sql,
        threadId,
        "a-legacy-resolution-evicted",
        "user-input.resolved",
        { requestId: "legacy-settled-question" },
        null,
      );
      yield* sql`
        WITH RECURSIVE tail(index_value) AS (
          SELECT 1 UNION ALL SELECT index_value + 1 FROM tail
          WHERE index_value < ${THREAD_DETAIL_ACTIVITY_LIMIT}
        )
        INSERT INTO projection_thread_activities(
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
        )
        SELECT 'm-legacy-tail-' || index_value, ${threadId}, ${ownerTurn}, 'tool',
          'tool.completed', 'Ordinary legacy activity', '{}', ${at}, NULL
        FROM tail
      `;

      const detail = Option.getOrThrow(yield* snapshot.getThreadDetailById(threadId));
      assert.equal(detail.activities.length, THREAD_DETAIL_ACTIVITY_LIMIT + 1);
      assert.equal(detail.pendingRequestRetentionTruncated, false);
      assert.ok(
        detail.activities.some((activity) => activity.id === EventId.make("z-legacy-request-kept")),
      );
      assert.ok(
        detail.activities.some(
          (activity) => activity.id === EventId.make("a-legacy-resolution-evicted"),
        ),
      );
    }),
  );

  it.effect(
    "reports bounded pending omission and clears it after an exact resolution admits the oldest request",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const snapshot = yield* ProjectionSnapshotQuery;
        const threadId = ThreadId.make("pending-retention-overflow");
        yield* insertThread(sql, threadId);
        for (let index = 1; index <= 65; index += 1) {
          yield* insertActivity(
            sql,
            threadId,
            `pending-overflow-${index}`,
            "user-input.requested",
            { requestId: `overflow-request-${index}`, questions },
            index,
          );
        }
        yield* insertTail(sql, threadId);
        const overflow = Option.getOrThrow(yield* snapshot.getThreadDetailById(threadId));
        assert.equal(overflow.pendingRequestRetentionTruncated, true);
        assert.equal(overflow.activities.length, THREAD_DETAIL_ACTIVITY_LIMIT + 64);
        const overflowRequests = overflow.activities.filter(
          (activity) => activity.kind === "user-input.requested",
        );
        assert.equal(overflowRequests.length, 64);
        assert.equal(
          overflowRequests.some((activity) => activity.id === EventId.make("pending-overflow-1")),
          false,
        );
        assert.ok(
          overflowRequests.some((activity) => activity.id === EventId.make("pending-overflow-65")),
        );

        yield* insertActivity(
          sql,
          threadId,
          "pending-overflow-resolved-65",
          "user-input.resolved",
          { requestId: "overflow-request-65" },
          20_000,
        );
        const settled = Option.getOrThrow(yield* snapshot.getThreadDetailById(threadId));
        assert.equal(settled.pendingRequestRetentionTruncated, false);
        assert.equal(settled.activities.length, THREAD_DETAIL_ACTIVITY_LIMIT + 64);
        const pending = settled.activities.filter(
          (activity) => activity.kind === "user-input.requested",
        );
        assert.equal(pending.length, 64);
        assert.ok(pending.some((activity) => activity.id === EventId.make("pending-overflow-1")));
        assert.equal(
          pending.some((activity) => activity.id === EventId.make("pending-overflow-65")),
          false,
        );
        assert.ok(
          settled.activities.some(
            (activity) => activity.id === EventId.make("pending-overflow-resolved-65"),
          ),
        );
      }),
  );
});
