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

const at = "2026-11-05T00:00:00.000Z";
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const questionId = (suffix: string) => EventId.make(`codex-async-questions:${suffix.repeat(64)}`);

function insertThread(sql: SqlClient.SqlClient, threadId: ThreadId) {
  return sql`
    INSERT INTO projection_threads(
      thread_id, project_id, title, model_selection_json, pending_approval_count,
      pending_user_input_count, created_at, updated_at
    ) VALUES (
      ${threadId}, NULL, 'Question query fixture',
      '{"instanceId":"codex","model":"gpt-6-astra"}', 0, 0, ${at}, ${at}
    )
  `;
}

function insertActivity(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  id: string,
  kind: string,
  payloadJson: string,
  sequence: number,
) {
  return sql`
    INSERT INTO projection_thread_activities(
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    ) VALUES (${id}, ${threadId}, NULL, 'info', ${kind}, 'Question query fixture',
      ${payloadJson}, ${sequence}, ${at})
  `;
}

function insertOrdinaryTail(sql: SqlClient.SqlClient, threadId: ThreadId) {
  return sql`
    WITH RECURSIVE tail(i) AS (
      SELECT 1 UNION ALL SELECT i + 1 FROM tail WHERE i < ${THREAD_DETAIL_ACTIVITY_LIMIT + 1}
    ) INSERT INTO projection_thread_activities(
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    ) SELECT ${threadId} || '-tool-' || i, ${threadId}, NULL, 'tool',
      'tool.completed', 'Ordinary activity', '{}', i + 10_000, ${at} FROM tail
  `;
}

const queryLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(
      Layer.succeed(RepositoryIdentityResolver, {
        resolve: () => Effect.die("Question fixtures never inspect a live workspace"),
      }),
    ),
    Layer.provideMerge(SqlitePersistenceTest),
    Layer.provideMerge(NodeServices.layer),
  ),
);

queryLayer("indexed historical question reads", (it) => {
  it.effect(
    "pages old questions independently of ordinary activity and reports unreadable bodies",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        const threadId = ThreadId.make("question-pages");
        const sibling = ThreadId.make("question-pages-sibling");
        yield* insertThread(sql, threadId);
        yield* insertThread(sql, sibling);
        const source = encodeJson({
          itemId: "question-item",
          questions: [{ title: "Choose?", options: [] }],
        });
        yield* insertActivity(
          sql,
          threadId,
          questionId("a"),
          "provider.async-questions",
          source,
          1,
        );
        yield* insertActivity(
          sql,
          threadId,
          questionId("b"),
          "provider.async-questions",
          source,
          2,
        );
        yield* insertActivity(
          sql,
          threadId,
          questionId("c"),
          "provider.async-questions",
          "malformed-private-question",
          3,
        );
        yield* insertActivity(
          sql,
          threadId,
          questionId("d"),
          "provider.async-questions",
          "x".repeat(1_048_577),
          4,
        );
        yield* insertOrdinaryTail(sql, threadId);
        const detail = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
        assert.equal(
          detail.activities.some((row) => row.kind === "provider.async-questions"),
          false,
        );

        // Question-only management reads must not hydrate a transcript merely
        // to discover callbacks. A malformed, unrelated attachment is an
        // independent negative control: ordinary detail must reject it while
        // the bounded question context remains readable.
        yield* sql`INSERT INTO projection_thread_messages(
        message_id, thread_id, turn_id, role, text, attachments_json,
        is_streaming, created_at, updated_at
      ) VALUES ('question-private-message', ${threadId}, NULL, 'user',
        'Unrelated private transcript sentinel', 'malformed-attachment-json', 0, ${at}, ${at})`;
        assert.equal((yield* Effect.exit(query.getThreadDetailById(threadId)))._tag, "Failure");
        const context = Option.getOrThrow(yield* query.getThreadQuestionContextById(threadId));
        assert.equal(context.id, threadId);
        assert.equal(Object.hasOwn(context, "messages"), false);
        assert.equal(Object.hasOwn(context, "proposedPlans"), false);
        assert.equal(Object.hasOwn(context, "checkpoints"), false);
        assert.equal(context.pendingRequestRetentionTruncated, false);

        const first = yield* query.getThreadAsyncQuestionActivitiesPage({ threadId, limit: 2 });
        assert.deepEqual(first.activities, []);
        assert.equal(first.omittedCount, 2);
        assert.equal(first.hasMore, true);
        assert.equal(first.nextCursor?.activityId, questionId("c"));
        const second = yield* query.getThreadAsyncQuestionActivitiesPage({
          threadId,
          limit: 2,
          before: first.nextCursor!,
        });
        assert.deepEqual(
          second.activities.map((row) => row.id),
          [questionId("b"), questionId("a")],
        );
        assert.equal(second.omittedCount, 0);
        assert.equal(second.hasMore, false);
        assert.equal(second.nextCursor, null);

        const exact = yield* query.getThreadAsyncQuestionActivity({
          threadId,
          activityId: questionId("a"),
        });
        assert.equal(Option.getOrThrow(exact).id, questionId("a"));
        assert.equal(
          Option.isNone(
            yield* query.getThreadAsyncQuestionActivity({
              threadId: sibling,
              activityId: questionId("a"),
            }),
          ),
          true,
        );
        assert.equal(
          Option.isNone(
            yield* query.getThreadAsyncQuestionActivity({ threadId, activityId: questionId("c") }),
          ),
          true,
        );
        assert.equal(
          Option.isNone(
            yield* query.getThreadAsyncQuestionActivity({ threadId, activityId: questionId("d") }),
          ),
          true,
        );

        // Updating handling changes the ledger sequence, never its page position.
        yield* sql`UPDATE projection_thread_activities SET sequence = 99, payload_json = ${encodeJson(
          {
            itemId: "question-item",
            questions: [{ title: "Choose?", options: [] }],
            handledQuestionIndexes: [0],
          },
        )} WHERE activity_id = ${questionId("a")}`;
        const repeated = yield* query.getThreadAsyncQuestionActivitiesPage({
          threadId,
          limit: 2,
          before: first.nextCursor!,
        });
        assert.deepEqual(
          repeated.activities.map((row) => row.id),
          [questionId("b"), questionId("a")],
        );
        assert.deepEqual(
          (repeated.activities[1]!.payload as { handledQuestionIndexes: number[] })
            .handledQuestionIndexes,
          [0],
        );
      }),
  );

  it.effect(
    "bounds legacy and exact-detail MCP notice history by count and extra encoded bytes",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        const threadId = ThreadId.make("question-notice-retention");
        yield* insertThread(sql, threadId);
        for (let index = 0; index < 65; index += 1)
          yield* insertActivity(
            sql,
            threadId,
            `mcp-notice-${String(index).padStart(3, "0")}`,
            "mcp.question.resolved",
            encodeJson(
              index === 64
                ? {
                    version: 2,
                    source: "mcp",
                    action: "answered",
                    questionCount: 1,
                    items: [
                      {
                        question: { id: "route", header: "Choice", question: "Which route?" },
                        answer: "A",
                      },
                    ],
                  }
                : { version: 1, source: "mcp", action: "answered", questionCount: 1 },
            ),
            index + 1,
          );
        yield* insertActivity(
          sql,
          threadId,
          "mcp-notice-invalid",
          "mcp.question.resolved",
          encodeJson({ version: 1, source: "mcp", action: "answered", questionCount: 0 }),
          66,
        );
        yield* insertOrdinaryTail(sql, threadId);
        const detail = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
        const notices = detail.activities.filter((row) => row.kind === "mcp.question.resolved");
        assert.equal(notices.length, 64);
        assert.equal(
          notices.some((row) => row.id === "mcp-notice-000"),
          false,
        );
        assert.equal(
          notices.some((row) => row.id === "mcp-notice-064"),
          true,
        );
        assert.equal(
          notices.some((row) => row.id === "mcp-notice-invalid"),
          false,
        );

        const budgetThread = ThreadId.make("question-notice-byte-budget");
        yield* insertThread(sql, budgetThread);
        // Every text field fits the actual v2 receipt limits. Two such records
        // together exceed the extra budget, independently of the 64-row limit.
        const largePayload = encodeJson({
          version: 2,
          source: "mcp",
          action: "answered",
          questionCount: 4,
          items: Array.from({ length: 4 }, (_, index) => ({
            question: {
              id: `large-${index}`,
              header: "h".repeat(60_000),
              question: "q".repeat(60_000),
            },
            answer: "a".repeat(60_000),
          })),
        });
        assert.equal(Buffer.byteLength(largePayload, "utf8") < 1_048_576, true);
        assert.equal(Buffer.byteLength(largePayload, "utf8") * 2 > 1_048_576, true);
        yield* insertActivity(
          sql,
          budgetThread,
          "budget-a-small",
          "mcp.question.resolved",
          encodeJson({
            version: 2,
            source: "mcp",
            action: "cleared",
            questionCount: 1,
            items: [
              {
                question: { id: "old", header: "", question: "Old question?" },
                disposition: "dismissed",
              },
            ],
          }),
          1,
        );
        yield* insertActivity(
          sql,
          budgetThread,
          "budget-x-older",
          "mcp.question.resolved",
          largePayload,
          2,
        );
        yield* insertActivity(
          sql,
          budgetThread,
          "budget-y-newer",
          "mcp.question.resolved",
          largePayload,
          3,
        );
        yield* insertOrdinaryTail(sql, budgetThread);
        // Already-visible ordinary-tail data consumes no additional budget.
        yield* insertActivity(
          sql,
          budgetThread,
          "budget-z-recent",
          "mcp.question.resolved",
          largePayload,
          20_000,
        );
        const budgetDetail = Option.getOrThrow(yield* query.getThreadDetailById(budgetThread));
        const retainedNotices = budgetDetail.activities.filter(
          (row) => row.kind === "mcp.question.resolved",
        );
        assert.deepEqual(
          retainedNotices.map((row) => row.id),
          ["budget-y-newer", "budget-z-recent"],
        );
        assert.deepEqual(retainedNotices[0]!.payload, JSON.parse(largePayload));
        assert.equal(budgetDetail.pendingRequestRetentionTruncated, false);
      }),
  );
});
