import {
  EventId,
  MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN,
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { deriveLiveWorkObservations } from "@cafecode/shared/liveWork";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { SqlitePersistenceTest } from "../../persistence/Sqlite.test.fixture.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationProjectionSnapshotQueryLive,
  THREAD_DETAIL_ACTIVITY_LIMIT,
} from "./ProjectionSnapshotQuery.ts";

const at = "2026-11-03T00:00:00.000Z";
const runtimeId = SubagentRuntimeId.make("00000000-0000-4000-8000-000000000207");
const foreignRuntimeId = SubagentRuntimeId.make("00000000-0000-4000-8000-000000000208");
const accountId = ProviderInstanceId.make("claude-current-agent-account");

const agent = (taskId: string, status: "active" | "completed" = "active") => ({
  taskId,
  subagent: { threadId: taskId, runtimeId, status },
});

function makeThread(threadId: ThreadId) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectionThreadActivityRepository;
    const query = yield* ProjectionSnapshotQuery;
    yield* sql`
      INSERT INTO projection_threads(
        thread_id, project_id, title, model_selection_json, created_at, updated_at
      ) VALUES (
        ${threadId}, NULL, 'Current native binding',
        '{"instanceId":"claude-current-agent-account","model":"claude-opus-5-5"}',
        ${at}, ${at}
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_sessions(
        thread_id, status, provider_name, provider_instance_id, runtime_mode,
        subagent_runtime_id, active_turn_id, last_error, updated_at
      ) VALUES (
        ${threadId}, 'ready', 'claudeAgent', ${accountId}, 'full-access',
        ${runtimeId}, NULL, NULL, ${at}
      )
    `;
    const append = (turn: string, kind: string, payload: unknown, sequence: number) =>
      repository.upsert({
        activityId: EventId.make(`${threadId}-activity-${sequence}`),
        threadId,
        turnId: TurnId.make(turn),
        tone: "info",
        kind,
        summary: "Native work lifecycle",
        payload,
        sequence,
        createdAt: at,
      });
    const read = (expectedAgents: ReadonlyArray<readonly [string, string | null]>, taskCount = 0) =>
      Effect.gen(function* () {
        const shell = Option.getOrThrow(yield* query.getThreadShellById(threadId));
        assert.deepEqual(shell.liveWork, {
          runtimeId,
          agentCount: expectedAgents.length,
          taskCount,
        });
        const detail = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
        assert.equal(detail.session?.status, "ready");
        const live = deriveLiveWorkObservations(detail.activities, {
          subagentRuntimeId: detail.session?.subagentRuntimeId,
          orchestrationStatus: detail.session?.status ?? "stopped",
        });
        assert.deepEqual(
          new Set(
            live
              .filter(({ observation }) => observation.agent)
              .map(({ activity, observation }) =>
                JSON.stringify([observation.workId, activity.turnId]),
              ),
          ),
          new Set(expectedAgents.map((binding) => JSON.stringify(binding))),
        );
        return detail;
      });
    return { sql, repository, query, append, read };
  });
}

const snapshotLayer = it.layer(
  Layer.mergeAll(
    OrchestrationProjectionSnapshotQueryLive,
    ProjectionThreadActivityRepositoryLive,
  ).pipe(
    Layer.provideMerge(
      Layer.succeed(RepositoryIdentityResolver, {
        resolve: () => Effect.die("Standalone lifecycle fixture must not resolve a repository"),
      }),
    ),
    Layer.provideMerge(SqlitePersistenceTest),
    Layer.provideMerge(NodeServices.layer),
  ),
);

snapshotLayer("ProjectionSnapshotQuery current native agents", (it) => {
  it.effect(
    "bounds completed native ownership payloads to the identities already retained by detail",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("current-native-agent-completed-history-bound");
        const { sql, query, append, read } = yield* makeThread(threadId);
        const identities = MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN + 1;
        const oldestId = "completed-agent-00000";
        yield* append("obsolete-oldest-root", "task.started", agent(oldestId), 0);
        // Real ingestion qualifies every binding and its descriptor-free terminal.
        // Completed native slots remain private historical watermarks; they are
        // not an unlimited additional payload budget for every detail refresh.
        for (let index = 0; index < identities; index += 1) {
          const workId = `completed-agent-${String(index).padStart(5, "0")}`;
          const turnId = `completed-root-${index}`;
          yield* append(turnId, "task.started", agent(workId), index * 2 + 1);
          yield* append(
            turnId,
            "task.completed",
            { taskId: workId, nativeWorkRuntimeId: runtimeId, status: "completed" },
            index * 2 + 2,
          );
        }
        yield* sql`
        WITH RECURSIVE tail(index_value) AS (
          SELECT 1 UNION ALL SELECT index_value + 1 FROM tail
          WHERE index_value < ${THREAD_DETAIL_ACTIVITY_LIMIT}
        )
        INSERT INTO projection_thread_activities(
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, created_at, sequence
        )
        SELECT ${threadId} || '-tail-' || index_value, ${threadId}, 'ordinary-root',
          'tool', 'tool.completed', 'Ordinary work', '{}', ${at},
          index_value + ${identities * 2}
        FROM tail
      `;
        let nextSequence = identities * 2 + THREAD_DETAIL_ACTIVITY_LIMIT + 1;
        // Ordinary-tail selectors preserve exact opaque IDs and current-runtime
        // references. Neither whitespace aliasing, another native generation nor
        // non-string identity fields may select this omitted historical owner.
        yield* append(
          "ordinary-root",
          "task.progress",
          {
            taskId: ` ${oldestId} `,
            nativeWorkRuntimeId: runtimeId,
          },
          nextSequence++,
        );
        yield* append(
          "ordinary-root",
          "task.progress",
          {
            taskId: oldestId,
            nativeWorkRuntimeId: foreignRuntimeId,
          },
          nextSequence++,
        );
        yield* append(
          "ordinary-root",
          "task.progress",
          {
            taskId: { value: oldestId },
            subagent: { threadId: 1, runtimeId },
          },
          nextSequence++,
        );

        const detail = yield* read([]);
        assert.equal(
          detail.activities.length,
          THREAD_DETAIL_ACTIVITY_LIMIT + MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN * 2,
        );
        assert.equal(
          detail.activities.filter((activity) => activity.kind === "task.started").length,
          MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN,
        );
        assert.equal(
          detail.activities.filter((activity) => activity.kind === "task.completed").length,
          MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN,
        );
        assert.isFalse(
          detail.activities.some(
            (activity) =>
              activity.id === `${threadId}-activity-0` ||
              activity.id === `${threadId}-activity-1` ||
              activity.id === `${threadId}-activity-2`,
          ),
        );
        assert.deepEqual(
          yield* sql<{ count: number; valid: number }>`
        SELECT COUNT(*) AS count, SUM(valid) AS valid FROM projection_native_agent_bindings
        WHERE thread_id = ${threadId} AND runtime_id = ${runtimeId}
      `,
          [{ count: identities, valid: identities }],
        );

        // A late old-turn progress now selects that exact native identity. Keep
        // its current start AND inactive owning head, even though neither source
        // fits the ordinary tail or the global turn/child identity selection.
        yield* append("obsolete-oldest-root", "task.progress", agent(oldestId), nextSequence++);
        const selected = yield* read([]);
        assert.isTrue(
          selected.activities.some((activity) => activity.id === `${threadId}-activity-1`),
        );
        assert.isTrue(
          selected.activities.some((activity) => activity.id === `${threadId}-activity-2`),
        );
        assert.deepEqual(Option.getOrThrow(yield* query.getThreadShellById(threadId)).liveWork, {
          runtimeId,
          agentCount: 0,
          taskCount: 0,
        });
      }),
  );

  it.effect(
    "keeps a missing native owner head unconfirmed with or without another live agent",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("current-native-agent-missing-owner-head");
        const { sql, query, append, read } = yield* makeThread(threadId);
        yield* append("current-root", "task.started", agent("agent"), 1);
        yield* append(
          "current-root",
          "task.completed",
          {
            taskId: "agent",
            nativeWorkRuntimeId: runtimeId,
            status: "completed",
          },
          2,
        );
        yield* read([]);
        // Source deletion must not turn the still-valid start into new liveness.
        // Exact-source invalidation removes the sidecar pointer too; the start's
        // ownership watermark still cannot turn that absence into completion.
        yield* sql`DELETE FROM projection_thread_activities
        WHERE activity_id = ${`${threadId}-activity-2`}`;
        assert.deepEqual(Option.getOrThrow(yield* query.getThreadShellById(threadId)).liveWork, {
          runtimeId,
          agentCount: 0,
          taskCount: 0,
          unconfirmedAgentIds: ["agent"],
        });
        // No other work row exists to make the zero-count summary appear. The
        // known owner alone must retain honest, bounded unknown presentation.
        assert.deepEqual(
          yield* sql`SELECT * FROM projection_live_work
        WHERE thread_id = ${threadId}`,
          [],
        );
        yield* append("independent-root", "task.started", agent("independent-agent"), 3);
        assert.deepEqual(Option.getOrThrow(yield* query.getThreadShellById(threadId)).liveWork, {
          runtimeId,
          agentCount: 1,
          taskCount: 0,
          unconfirmedAgentIds: ["agent"],
        });
        assert.deepEqual(
          yield* sql<{ sequence: number; valid: number }>`
        SELECT sequence, valid FROM projection_native_agent_bindings
        WHERE thread_id = ${threadId} AND runtime_id = ${runtimeId} AND work_id = 'agent'
      `,
          [{ sequence: 1, valid: 1 }],
        );
        const detail = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
        assert.isTrue(
          detail.activities.some((activity) => activity.id === `${threadId}-activity-1`),
        );
        yield* append("replacement-root", "task.started", agent("agent"), 4);
        yield* read([
          ["agent", "replacement-root"],
          ["independent-agent", "independent-root"],
        ]);
      }),
  );

  it.effect("retires a native head when its exact source payload or canonical kind changes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("current-native-agent-head-source-rewrite");
      const { sql, query, append, read } = yield* makeThread(threadId);
      yield* append("current-root", "task.started", agent("agent"), 1);
      yield* append("current-root", "task.progress", agent("agent"), 2);
      yield* append("independent-root", "task.started", agent("independent-agent"), 3);
      yield* read([
        ["agent", "current-root"],
        ["independent-agent", "independent-root"],
      ]);

      // A source rewrite keeps its ID/thread/clock/order but changes the native
      // task identity. Metadata equality alone must not preserve the former
      // active sidecar or let another live agent hide its unknown condition.
      const retargetedPayload = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
        taskId: "retargeted-task",
        nativeWorkRuntimeId: runtimeId,
      });
      yield* sql`UPDATE projection_thread_activities
        SET payload_json = ${retargetedPayload}
        WHERE activity_id = ${`${threadId}-activity-2`}`;
      assert.deepEqual(Option.getOrThrow(yield* query.getThreadShellById(threadId)).liveWork, {
        runtimeId,
        agentCount: 1,
        taskCount: 0,
        unconfirmedAgentIds: ["agent"],
      });
      assert.deepEqual(
        yield* sql`SELECT * FROM projection_live_work
        WHERE thread_id = ${threadId} AND work_id = 'agent'`,
        [],
      );
      assert.deepEqual(
        yield* sql<{ sequence: number; valid: number }>`
        SELECT sequence, valid FROM projection_native_agent_bindings
        WHERE thread_id = ${threadId} AND runtime_id = ${runtimeId} AND work_id = 'agent'
      `,
        [{ sequence: 1, valid: 1 }],
      );

      // Normal ingestion writes and qualifies one prepared payload atomically,
      // renewing the exact owning head without inventing another task start.
      yield* append("current-root", "task.progress", agent("agent"), 2);
      yield* read([
        ["agent", "current-root"],
        ["independent-agent", "independent-root"],
      ]);
      yield* sql`UPDATE projection_thread_activities SET kind = 'task.unsupported'
        WHERE activity_id = ${`${threadId}-activity-2`}`;
      assert.deepEqual(Option.getOrThrow(yield* query.getThreadShellById(threadId)).liveWork, {
        runtimeId,
        agentCount: 1,
        taskCount: 0,
        unconfirmedAgentIds: ["agent"],
      });

      // Even a stamped repository write of an unsupported task.* kind cannot
      // make it a canonical native lifecycle head. Generic provider protocols
      // and their namespaces retain their existing admission independently.
      yield* append("current-root", "task.unsupported", agent("agent"), 2);
      assert.deepEqual(Option.getOrThrow(yield* query.getThreadShellById(threadId)).liveWork, {
        runtimeId,
        agentCount: 1,
        taskCount: 0,
        unconfirmedAgentIds: ["agent"],
      });
      yield* append("current-root", "task.progress", agent("agent"), 2);
      yield* read([
        ["agent", "current-root"],
        ["independent-agent", "independent-root"],
      ]);
    }),
  );

  it.effect("projects one current native binding while preserving its historical turn rows", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("current-native-agent-reuse");
      const { sql, repository, append, read } = yield* makeThread(threadId);
      // Populate the actual activity repository: its production transaction
      // writes both history and the live-work sidecar. No fabricated sidecar
      // can make the query appear correct without exercising real ingestion.
      yield* append("older-root-a", "task.started", agent("reused-agent"), 1);
      yield* append("older-root-b", "task.started", agent("reused-agent"), 2);
      yield* append("older-root-c", "task.started", agent("reused-agent"), 3);
      yield* append("current-root", "task.started", agent("reused-agent"), 4);
      yield* append("independent-older-root", "task.started", agent("independent-agent"), 5);
      // A later wall clock without canonical sequence cannot overwrite the
      // known native head, even on its exact owning turn. Shared fallback and
      // persisted admission use the same nullable-first canonical ordering.
      yield* repository.upsert({
        activityId: EventId.make("clock-skewed-legacy-native-terminal"),
        threadId,
        turnId: TurnId.make("current-root"),
        tone: "info",
        kind: "task.completed",
        summary: "Historical unsequenced lifecycle",
        payload: agent("reused-agent", "completed"),
        createdAt: "2026-12-01T00:00:00.000Z",
      });
      yield* read([
        ["reused-agent", "current-root"],
        ["independent-agent", "independent-older-root"],
      ]);

      // An old owning turn can deliver its terminal after the new explicit
      // start. Runtime equality alone cannot grant it the replacement's slot.
      yield* append("older-root-a", "task.completed", agent("reused-agent", "completed"), 6);
      yield* read([
        ["reused-agent", "current-root"],
        ["independent-agent", "independent-older-root"],
      ]);
      // Terminal DTOs may omit repeated presentation metadata. The explicit
      // start still owns the slot even when its newest sidecar head is no
      // longer classified as an agent; obsolete agent heads must stay retired.
      yield* append(
        "current-root",
        "task.completed",
        { taskId: "reused-agent", nativeWorkRuntimeId: runtimeId, status: "completed" },
        7,
      );
      yield* read([["independent-agent", "independent-older-root"]]);

      yield* append("replacement-root", "task.started", agent("reused-agent"), 8);
      yield* append("current-root", "task.progress", agent("reused-agent"), 9);
      // Put both the replacement's start and the old late progress outside the
      // ordinary tail. The detail query must retain explicit binding evidence,
      // independently of the parent's already-ready lifecycle and clock age.
      yield* sql`
        WITH RECURSIVE tail(index_value) AS (
          SELECT 1 UNION ALL SELECT index_value + 1 FROM tail
          WHERE index_value < ${THREAD_DETAIL_ACTIVITY_LIMIT + 1}
        )
        INSERT INTO projection_thread_activities(
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, created_at, sequence
        )
        SELECT ${threadId} || '-tail-' || index_value, ${threadId}, 'ordinary-root',
          'tool', 'tool.completed', 'Ordinary work', '{}', ${at}, index_value + 100
        FROM tail
      `;
      const detail = yield* read([
        ["reused-agent", "replacement-root"],
        ["independent-agent", "independent-older-root"],
      ]);
      assert.isTrue(detail.activities.some((activity) => activity.id === `${threadId}-activity-8`));
      const history = (yield* repository.listByThreadId({ threadId })).filter((activity) =>
        activity.kind.startsWith("task."),
      );
      assert.equal(history.length, 10);
      assert.deepEqual(
        history
          .filter((activity) => activity.kind === "task.started")
          .map((activity) => activity.turnId),
        [
          TurnId.make("older-root-a"),
          TurnId.make("older-root-b"),
          TurnId.make("older-root-c"),
          TurnId.make("current-root"),
          TurnId.make("independent-older-root"),
          TurnId.make("replacement-root"),
        ],
      );
    }),
  );

  it.effect(
    "retains an invalidated owner's watermark through source rewrites, deletion and stale starts",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("current-native-agent-source-retirement");
        const { sql, repository, query, append, read } = yield* makeThread(threadId);
        yield* append("older-root", "task.started", agent("agent"), 1);
        yield* append("current-root", "task.started", agent("agent"), 10);
        yield* append("independent-root", "task.started", agent("independent-agent"), 11);
        yield* read([
          ["agent", "current-root"],
          ["independent-agent", "independent-root"],
        ]);

        // Direct source edits have not passed the normal full-schema admission.
        // Keep their newer ownership watermark, but stop asserting live work.
        // Neither a stale start nor an equal-order change of owning turn may
        // acquire the invalidated slot. This is not a manufactured completion.
        yield* sql`
        UPDATE projection_thread_activities SET payload_json = '{}'
        WHERE activity_id = ${`${threadId}-activity-10`}
      `;
        yield* append("older-root", "task.started", agent("agent"), 2);
        assert.deepEqual(Option.getOrThrow(yield* query.getThreadShellById(threadId)).liveWork, {
          runtimeId,
          agentCount: 1,
          taskCount: 0,
          unconfirmedAgentIds: ["agent"],
        });
        const unconfirmedDetail = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
        assert.isTrue(
          unconfirmedDetail.activities.some(
            (activity) =>
              activity.id === `${threadId}-activity-1` && activity.kind === "task.started",
          ),
        );
        const admitted = {
          activityId: EventId.make(`${threadId}-activity-10`),
          threadId,
          turnId: TurnId.make("current-root"),
          tone: "info" as const,
          kind: "task.started",
          summary: "Native work lifecycle",
          payload: agent("agent"),
          sequence: 10,
          createdAt: at,
        };
        yield* repository.upsert({ ...admitted, turnId: TurnId.make("unproved-root") });
        assert.deepEqual(
          yield* sql<{ turn: string; sequence: number; valid: number }>`
          SELECT turn_id AS turn, sequence, valid FROM projection_native_agent_bindings
          WHERE thread_id = ${threadId} AND runtime_id = ${runtimeId} AND work_id = 'agent'
        `,
          [{ turn: "current-root", sequence: 10, valid: 0 }],
        );
        assert.deepEqual(Option.getOrThrow(yield* query.getThreadShellById(threadId)).liveWork, {
          runtimeId,
          agentCount: 1,
          taskCount: 0,
          unconfirmedAgentIds: ["agent"],
        });

        // The exact same source identity/turn/order can be qualified again in
        // the repository transaction, without granting an old owner a replay.
        yield* repository.upsert(admitted);
        yield* read([
          ["agent", "current-root"],
          ["independent-agent", "independent-root"],
        ]);
        yield* sql`
        DELETE FROM projection_thread_activities
        WHERE activity_id = ${admitted.activityId}
      `;
        yield* append("other-older-root", "task.started", agent("agent"), 3);
        assert.deepEqual(Option.getOrThrow(yield* query.getThreadShellById(threadId)).liveWork, {
          runtimeId,
          agentCount: 1,
          taskCount: 0,
          unconfirmedAgentIds: ["agent"],
        });
        assert.deepEqual(
          yield* sql<{ turn: string; sequence: number; valid: number }>`
          SELECT turn_id AS turn, sequence, valid FROM projection_native_agent_bindings
          WHERE thread_id = ${threadId} AND runtime_id = ${runtimeId} AND work_id = 'agent'
        `,
          [{ turn: "current-root", sequence: 10, valid: 0 }],
        );
        yield* append("replacement-root", "task.started", agent("agent"), 12);
        yield* read([
          ["agent", "replacement-root"],
          ["independent-agent", "independent-root"],
        ]);
        assert.deepEqual(
          (yield* repository.listByThreadId({ threadId })).map((row) => [row.turnId, row.kind]),
          [
            [TurnId.make("older-root"), "task.started"],
            [TurnId.make("older-root"), "task.started"],
            [TurnId.make("other-older-root"), "task.started"],
            [TurnId.make("independent-root"), "task.started"],
            [TurnId.make("replacement-root"), "task.started"],
          ],
        );
      }),
  );

  it.effect(
    "bounds unconfirmed native agent metadata without discarding ownership watermarks",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("current-native-agent-unconfirmed-bound");
        const { sql, query, append, read } = yield* makeThread(threadId);
        const workIds = Array.from(
          { length: 65 },
          (_, index) => `opaque-native-agent:${String(index).padStart(3, "0")}:retained`,
        );
        for (const [index, workId] of workIds.entries()) {
          yield* append("current-root", "task.started", agent(workId), index + 1);
        }
        yield* read(workIds.map((workId) => [workId, "current-root"] as const));

        // Retire only these test-owned source rows. Their private ownership
        // watermarks must survive, even when the compact public metadata needs
        // its overflow flag instead of exposing every complete native identity.
        yield* sql`
        DELETE FROM projection_thread_activities
        WHERE thread_id = ${threadId} AND kind = 'task.started'
      `;
        assert.deepEqual(Option.getOrThrow(yield* query.getThreadShellById(threadId)).liveWork, {
          runtimeId,
          agentCount: 0,
          taskCount: 0,
          unconfirmedAgentIds: workIds.slice(0, 64),
          unconfirmedAgentIdsTruncated: true,
        });
        assert.deepEqual(
          yield* sql<{
            workId: string;
            activityId: string;
            sequence: number;
            valid: number;
            payloadJson: string;
          }>`
          SELECT work_id AS "workId", activity_id AS "activityId", sequence,
            valid, payload_json AS "payloadJson"
          FROM projection_native_agent_bindings
          WHERE thread_id = ${threadId} AND runtime_id = ${runtimeId}
          ORDER BY work_id
        `,
          workIds.map((workId, index) => ({
            workId,
            activityId: `${threadId}-activity-${index + 1}`,
            sequence: index + 1,
            valid: 0,
            payloadJson: "null",
          })),
        );
      }),
  );

  it.effect("preserves a newly observed native agent's explicit between-turn owner", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("current-native-agent-null-turn");
      const { repository, read } = yield* makeThread(threadId);
      yield* repository.upsert({
        activityId: EventId.make("native-agent-between-roots"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.started",
        summary: "Native work lifecycle",
        payload: agent("between-roots"),
        sequence: 1,
        createdAt: at,
      });
      yield* read([["between-roots", null]]);
    }),
  );

  it.effect(
    "binds work to one exact payload encoding and rejects unsupported input before writing",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("current-native-agent-payload-encoding");
        const { sql, repository, read } = yield* makeThread(threadId);
        let reads = 0;
        const changingPayload = {
          taskId: "encoded-agent",
          get subagent() {
            reads += 1;
            return {
              threadId: "encoded-agent",
              runtimeId: reads === 1 ? runtimeId : foreignRuntimeId,
              status: "active",
            };
          },
        };
        yield* repository.upsert({
          activityId: EventId.make("native-agent-encoded-source"),
          threadId,
          turnId: TurnId.make("encoded-root"),
          tone: "info",
          kind: "task.started",
          summary: "Native work lifecycle",
          payload: changingPayload,
          sequence: 1,
          createdAt: at,
        });
        assert.equal(reads, 1);
        yield* read([["encoded-agent", "encoded-root"]]);
        assert.deepEqual(
          yield* sql<{ runtimeId: string; witnessMatches: number }>`
          SELECT binding.runtime_id AS "runtimeId",
            binding.payload_json = activity.payload_json AS "witnessMatches"
          FROM projection_native_agent_bindings AS binding
          JOIN projection_thread_activities AS activity ON activity.activity_id = binding.activity_id
          WHERE binding.thread_id = ${threadId}
        `,
          [{ runtimeId, witnessMatches: 1 }],
        );

        const rejectedThreadId = ThreadId.make("current-native-agent-invalid-encoding");
        const rejected = yield* makeThread(rejectedThreadId);
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const throwing = {
          get value(): unknown {
            throw new Error("Synthetic unsupported payload");
          },
        };
        for (const payload of [1n, circular, throwing]) {
          const result = yield* Effect.result(
            rejected.repository.upsert({
              activityId: EventId.make("native-agent-rejected-source"),
              threadId: rejectedThreadId,
              turnId: TurnId.make("rejected-root"),
              tone: "info",
              kind: "task.started",
              summary: "Native work lifecycle",
              payload,
              sequence: 1,
              createdAt: at,
            }),
          );
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.equal(result.failure._tag, "PersistenceDecodeError");
        }
        assert.deepEqual(
          yield* sql<{ activities: number; heads: number; bindings: number }>`
          SELECT
            (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = ${rejectedThreadId}) AS activities,
            (SELECT COUNT(*) FROM projection_live_work WHERE thread_id = ${rejectedThreadId}) AS heads,
            (SELECT COUNT(*) FROM projection_native_agent_bindings WHERE thread_id = ${rejectedThreadId}) AS bindings
        `,
          [{ activities: 0, heads: 0, bindings: 0 }],
        );
      }),
  );

  it.effect(
    "rejects malformed or foreign start authority and retains generic task/tool turn scopes",
    () =>
      Effect.gen(function* () {
        for (const [name, subagent] of [
          ["foreign", { threadId: "agent", runtimeId: foreignRuntimeId, status: "active" }],
          ["missing", { threadId: "agent", status: "active" }],
          ["malformed", { threadId: "agent", runtimeId, status: "unrecognized-status" }],
          ["malformed-label", { threadId: "agent", runtimeId, status: "active", label: 7 }],
        ] as const) {
          const { append, read } = yield* makeThread(ThreadId.make(`current-agent-${name}`));
          yield* append("owning-root", "task.started", agent("agent"), 1);
          yield* append(
            "unproved-root",
            "task.started",
            { taskId: "agent", nativeWorkRuntimeId: runtimeId, subagent },
            2,
          );
          yield* read([["agent", "owning-root"]]);
        }

        const differentNamespace = yield* makeThread(
          ThreadId.make("current-agent-different-task-namespace"),
        );
        yield* differentNamespace.append("owning-root", "task.started", agent("agent"), 1);
        yield* differentNamespace.append(
          "unproved-root",
          "task.started",
          {
            taskId: "other-task-namespace",
            subagent: { threadId: "agent", runtimeId, status: "active" },
          },
          2,
        );
        yield* differentNamespace.read([
          ["agent", "owning-root"],
          ["other-task-namespace", "unproved-root"],
        ]);

        const { sql, append, read } = yield* makeThread(
          ThreadId.make("current-agent-ordinary-scopes"),
        );
        const control = {
          taskId: "ordinary-task",
          runtimeId,
          capability: {
            providerInstanceId: accountId,
            taskGeneration: "00000000-0000-4000-8000-000000000209",
            canStop: true,
            canBackground: false,
          },
        };
        yield* append("first-root", "task.started", agent("independent-agent"), 1);
        for (const [turn, sequence] of [
          ["first-root", 2],
          ["second-root", 4],
        ] as const) {
          yield* append(
            turn,
            "task.started",
            { taskId: "ordinary-task", individualTaskControl: control },
            sequence,
          );
          yield* append(
            turn,
            "tool.started",
            { itemId: "ordinary-task", individualTaskControl: control },
            sequence + 1,
          );
        }
        yield* read([["independent-agent", "first-root"]], 4);
        yield* append("agent-root", "task.started", agent("ordinary-task"), 6);
        yield* read(
          [
            ["independent-agent", "first-root"],
            ["ordinary-task", "agent-root"],
          ],
          4,
        );
        yield* append(
          "agent-root",
          "task.completed",
          { taskId: "ordinary-task", nativeWorkRuntimeId: runtimeId, status: "completed" },
          7,
        );
        yield* read([["independent-agent", "first-root"]], 4);
        // Source retirement applies to generic tool heads too. A changed or
        // deleted activity cannot leave a foreground task behind; a later
        // qualified repository write can renew only its exact source slot.
        yield* sql`UPDATE projection_thread_activities SET payload_json = '{}'
          WHERE activity_id = 'current-agent-ordinary-scopes-activity-3'`;
        yield* read([["independent-agent", "first-root"]], 3);
        yield* sql`DELETE FROM projection_thread_activities
          WHERE activity_id = 'current-agent-ordinary-scopes-activity-5'`;
        yield* read([["independent-agent", "first-root"]], 2);
        yield* append(
          "first-root",
          "tool.started",
          {
            itemId: "ordinary-task",
            individualTaskControl: control,
          },
          3,
        );
        yield* read([["independent-agent", "first-root"]], 3);
      }),
  );
});
