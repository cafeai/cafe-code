import {
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivityCursor,
} from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";

import { SqlitePersistenceTest } from "../../persistence/Sqlite.test.fixture.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const threadId = ThreadId.make("cursor-thread");
const turnId = TurnId.make("cursor-current-turn");
const timestamp = (index: number) => new Date(Date.UTC(2026, 9, 11, 0, 0, index)).toISOString();
const cursor = (sequence: number | null, activityId: string, createdAt = timestamp(0)) =>
  ({
    sequence,
    activityId: EventId.make(activityId),
    createdAt,
  }) satisfies OrchestrationThreadActivityCursor;

const fixtureLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(RepositoryIdentityResolverLive),
  Layer.provideMerge(SqlitePersistenceTest),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(fixtureLayer)("earlier current-turn work-log pages", (it) => {
  it.effect("does not count already-inline retention exceptions as earlier work", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`INSERT INTO projection_thread_activities
        (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
        VALUES ('retained-settings',${threadId},${turnId},'info','provider.turn.configuration','Turn settings','{}',1,${timestamp(1)}),
          ('retained-live-work',${threadId},${turnId},'tool','tool.updated','Live work','{}',2,${timestamp(2)})`;
      const before = cursor(600, "raw-floor", timestamp(600));
      const excludeActivityIds = [
        EventId.make("retained-settings"),
        EventId.make("retained-live-work"),
      ];
      const presence = () =>
        query.getThreadTurnWorkLogPresence({
          threadId,
          turnIds: [turnId],
          before,
          excludeActivityIds,
        });
      const page = () =>
        query.getThreadTurnActivityPage({
          threadId,
          turnId,
          before,
          excludeActivityIds,
          offset: 0,
          limit: 6,
        });
      assert.deepStrictEqual((yield* presence()).turnIdsWithWorkLog, []);
      const empty = yield* page();
      assert.equal(empty.totalCount, 0);
      assert.deepStrictEqual(empty.activities, []);
      assert.deepStrictEqual(empty.excludeActivityIds, excludeActivityIds);

      // Exclusions only narrow an already-scoped query. Genuine evicted work
      // is still discoverable, and an ordinary offset reader is unchanged.
      yield* sql`INSERT INTO projection_thread_activities
        (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
        VALUES ('evicted-command',${threadId},${turnId},'tool','tool.completed','Saved command','{}',3,${timestamp(3)})`;
      assert.deepStrictEqual((yield* presence()).turnIdsWithWorkLog, [turnId]);
      const saved = yield* page();
      assert.equal(saved.totalCount, 1);
      assert.deepStrictEqual(
        saved.activities.map((activity) => activity.id),
        ["evicted-command"],
      );
      const ordinary = yield* query.getThreadTurnActivityPage({
        threadId,
        turnId,
        offset: 0,
        limit: 6,
      });
      assert.equal(ordinary.totalCount, 3);
    }),
  );

  it.effect("pages beyond the 500-row live window and never crosses the exact thread/turn", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`
        WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<620)
        INSERT INTO projection_thread_activities
          (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
        SELECT printf('work-%04d',n),${threadId},${turnId},'tool','tool.completed','Work','{}',n,${timestamp(0)}
        FROM numbers
      `;
      for (const [foreignThread, foreignTurn] of [
        ["other-thread", turnId],
        [threadId, "other-turn"],
      ]) {
        yield* sql`INSERT INTO projection_thread_activities
          (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
          VALUES (${`foreign-${foreignThread}-${foreignTurn}`},${foreignThread},${foreignTurn},'tool','tool.completed','Foreign','{}',1,${timestamp(0)})`;
      }
      const before = cursor(121, "work-0121");
      const presence = yield* query.getThreadTurnWorkLogPresence({
        threadId,
        turnIds: [turnId],
        before,
      });
      assert.deepStrictEqual(presence.turnIdsWithWorkLog, [turnId]);
      const page = yield* query.getThreadTurnActivityPage({
        threadId,
        turnId,
        offset: 0,
        limit: 7,
        before,
      });
      assert.equal(page.totalCount, 120);
      assert.deepStrictEqual(page.before, before);
      assert.deepStrictEqual(
        page.activities.map((row) => row.sequence),
        [114, 115, 116, 117, 118, 119, 120],
      );
      assert.isTrue(page.activities.every((row) => row.turnId === turnId));
      const earlier = yield* query.getThreadTurnActivityPage({
        threadId,
        turnId,
        offset: 0,
        limit: 7,
        before: cursor(
          page.activities[0]!.sequence!,
          page.activities[0]!.id,
          page.activities[0]!.createdAt,
        ),
      });
      assert.equal(earlier.totalCount, 113);
      assert.deepStrictEqual(
        earlier.activities.map((row) => row.sequence),
        [107, 108, 109, 110, 111, 112, 113],
      );
      const empty = yield* query.getThreadTurnActivityPage({
        threadId: ThreadId.make("missing-thread"),
        turnId,
        offset: 0,
        limit: 7,
        before,
      });
      assert.equal(empty.totalCount, 0);
      assert.deepStrictEqual(empty.activities, []);
    }),
  );

  it.effect(
    "keeps null legacy sequences and timestamp/id ties in the same exclusive total order",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        yield* sql`DELETE FROM projection_thread_activities`;
        for (const row of [
          { id: "legacy-a", sequence: null, time: timestamp(0) },
          { id: "legacy-b", sequence: null, time: timestamp(0) },
          { id: "legacy-c", sequence: null, time: timestamp(1) },
          { id: "modern-a", sequence: 1, time: timestamp(0) },
          { id: "modern-b", sequence: 1, time: timestamp(0) },
          { id: "modern-c", sequence: 1, time: timestamp(1) },
        ]) {
          yield* sql`INSERT INTO projection_thread_activities
          (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
          VALUES (${row.id},${threadId},${turnId},'tool','tool.completed','Work','{}',${row.sequence},${row.time})`;
        }
        for (const [before, expected] of [
          [cursor(null, "legacy-b"), ["legacy-a"]],
          [cursor(null, "legacy-c", timestamp(1)), ["legacy-a", "legacy-b"]],
          [cursor(1, "modern-b"), ["legacy-a", "legacy-b", "legacy-c", "modern-a"]],
          [
            cursor(1, "modern-c", timestamp(1)),
            ["legacy-a", "legacy-b", "legacy-c", "modern-a", "modern-b"],
          ],
        ] as const) {
          const page = yield* query.getThreadTurnActivityPage({
            threadId,
            turnId,
            offset: 0,
            limit: 10,
            before,
          });
          assert.equal(page.totalCount, expected.length);
          assert.deepStrictEqual(
            page.activities.map((row) => String(row.id)),
            [...expected],
          );
        }
      }),
  );

  it.effect(
    "preserves older keyset access after live appends and a Claude summary moves forward",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        yield* sql`DELETE FROM projection_thread_activities`;
        for (let sequence = 1; sequence <= 10; sequence++) {
          yield* sql`INSERT INTO projection_thread_activities
          (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
          VALUES (${`work-${sequence}`},${threadId},${turnId},'tool','tool.completed','Work','{}',${sequence},${timestamp(sequence)})`;
        }
        const summaryPayload = JSON.stringify({
          summaryVersion: 1,
          provider: "claudeAgent",
          streamKind: "reasoning_summary_text",
          itemId: "summary-item",
          detail: "Disclosed summary",
          truncated: false,
          status: "inProgress",
        });
        yield* sql`UPDATE projection_thread_activities SET kind='reasoning.summary',payload_json=${summaryPayload} WHERE activity_id='work-2'`;
        const before = cursor(11, "unpersisted-read-filter", timestamp(11));
        const first = yield* query.getThreadTurnActivityPage({
          threadId,
          turnId,
          offset: 0,
          limit: 3,
          before,
        });
        assert.deepStrictEqual(
          first.activities.map((row) => row.sequence),
          [8, 9, 10],
        );
        // Real summary upsert semantics remove a prior prefix row. An offset
        // page would shift; the captured ordering cursor must not skip work 7.
        yield* sql`UPDATE projection_thread_activities SET sequence=20,created_at=${timestamp(20)} WHERE activity_id='work-2'`;
        // Even the original cursor's activity can move. Its captured tuple is
        // a read filter, not a request to resolve this mutable row again.
        yield* sql`UPDATE projection_thread_activities SET sequence=22,created_at=${timestamp(22)} WHERE activity_id='work-8'`;
        yield* sql`INSERT INTO projection_thread_activities
        (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
        VALUES ('live-new',${threadId},${turnId},'tool','tool.completed','New','{}',21,${timestamp(21)})`;
        const older = yield* query.getThreadTurnActivityPage({
          threadId,
          turnId,
          offset: 0,
          limit: 3,
          before: cursor(8, "work-8", timestamp(8)),
        });
        assert.equal(older.totalCount, 6);
        assert.deepStrictEqual(
          older.activities.map((row) => row.sequence),
          [5, 6, 7],
        );
        const final = yield* query.getThreadTurnActivityPage({
          threadId,
          turnId,
          offset: 0,
          limit: 10,
          before: cursor(5, "work-5", timestamp(5)),
        });
        assert.deepStrictEqual(
          final.activities.map((row) => row.sequence),
          [1, 3, 4],
        );
        const frozen = yield* query.getThreadTurnActivityPage({
          threadId,
          turnId,
          offset: 0,
          limit: 10,
          before,
        });
        assert.isFalse(
          frozen.activities.some(
            (row) => row.id === "work-2" || row.id === "work-8" || row.id === "live-new",
          ),
        );
      }),
  );

  it.effect(
    "uses predicate parity for cursor presence/count/page without reading hidden work",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        yield* sql`DELETE FROM projection_thread_activities`;
        const hidden = [
          { kind: "context-window.updated", payload: {} },
          { kind: "checkpoint.captured", payload: {} },
          { kind: "tool.started", payload: {} },
          { kind: "task.progress", payload: { subagent: { threadId: "child" } } },
          { kind: "provider.turn.steer.failed", payload: { retryableFollowUp: true } },
          { kind: "tool.completed", payload: { detail: "ExitPlanMode: done" } },
        ];
        for (const [index, row] of hidden.entries()) {
          yield* sql`INSERT INTO projection_thread_activities
          (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
          VALUES (${`hidden-${index}`},${threadId},${turnId},'info',${row.kind},'Hidden',${JSON.stringify(row.payload)},${index + 1},${timestamp(0)})`;
        }
        yield* sql`INSERT INTO projection_thread_activities
        (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
        VALUES ('visible-after',${threadId},${turnId},'tool','tool.completed','Work','{}',20,${timestamp(0)})`;
        const hiddenBefore = cursor(10, "read-filter");
        const presence = yield* query.getThreadTurnWorkLogPresence({
          threadId,
          turnIds: [turnId],
          before: hiddenBefore,
        });
        const page = yield* query.getThreadTurnActivityPage({
          threadId,
          turnId,
          offset: 0,
          limit: 10,
          before: hiddenBefore,
        });
        assert.deepStrictEqual(presence.turnIdsWithWorkLog, []);
        assert.equal(page.totalCount, 0);
        assert.deepStrictEqual(page.activities, []);
        const visibleBefore = cursor(21, "read-filter");
        assert.deepStrictEqual(
          (yield* query.getThreadTurnWorkLogPresence({
            threadId,
            turnIds: [turnId],
            before: visibleBefore,
          })).turnIdsWithWorkLog,
          [turnId],
        );
        assert.deepStrictEqual(
          (yield* query.getThreadTurnActivityPage({
            threadId,
            turnId,
            offset: 0,
            limit: 10,
            before: visibleBefore,
          })).activities.map((row) => row.id),
          ["visible-after"],
        );
      }),
  );

  it.effect("executes the count and page under one short read transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let inTransaction = false;
      const reads: boolean[] = [];
      const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const observed = new Proxy(sql, {
        apply(target, thisArg, args) {
          const statement = Reflect.apply(target, thisArg, args) as Statement.Statement<unknown>;
          const compiled = statement.compile();
          if (compiled[0].includes("FROM projection_thread_activities")) {
            reads.push(inTransaction);
            statements.push(compiled);
          }
          return statement;
        },
        get(target, property, receiver) {
          if (property !== "withTransaction") return Reflect.get(target, property, receiver);
          return <A, E, R>(work: Effect.Effect<A, E, R>) =>
            target.withTransaction(
              Effect.sync(() => {
                inTransaction = true;
              }).pipe(
                Effect.flatMap(() => work),
                Effect.ensuring(
                  Effect.sync(() => {
                    inTransaction = false;
                  }),
                ),
              ),
            );
        },
      });
      const query = yield* Effect.service(ProjectionSnapshotQuery).pipe(
        Effect.provide(
          Layer.fresh(OrchestrationProjectionSnapshotQueryLive).pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, observed)),
          ),
        ),
      );
      yield* query.getThreadTurnActivityPage({
        threadId,
        turnId,
        offset: 0,
        limit: 1,
        before: cursor(100, "filter"),
      });
      assert.deepStrictEqual(reads, [true, true]);
      assert.isFalse(inTransaction);
      for (const [statement, parameters] of statements) {
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
          parameters,
        );
        const details = plan.map((row) => row.detail).join("\n");
        assert.isTrue(
          plan.some((row) =>
            /SEARCH projection_thread_activities USING (?:COVERING )?INDEX .+ \(thread_id=\? AND turn_id=\?/u.test(
              row.detail,
            ),
          ),
          `cursor lookup did not bind the indexed exact turn:\n${details}`,
        );
        assert.isFalse(
          plan.some((row) => /SCAN projection_thread_activities/u.test(row.detail)),
          details,
        );
        assert.isFalse(
          plan.some((row) => /USE TEMP B-TREE FOR ORDER BY/u.test(row.detail)),
          details,
        );
      }
    }),
  );
});
