import { EventId, ProjectId, ThreadId, ProviderInstanceId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.make("project-null-options"),
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        additionalWorkspaceRoots: [],
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_projects row to exist.");
      }

      assert.strictEqual(
        row.defaultModelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.make("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-null-options"),
        projectId: ProjectId.make("project-null-options"),
        title: "Null options thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_threads row to exist.");
      }

      assert.strictEqual(
        row.modelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      });
    }),
  );

  it.effect("counts pending user-input callbacks without loading activity rows", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-user-input-count");
      const now = "2026-03-24T00:00:00.000Z";

      yield* activities.upsert({
        activityId: EventId.make("activity-user-input-requested-open"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "user-input.requested",
        summary: "Input requested",
        payload: { requestId: "request-open" },
        createdAt: now,
      });
      yield* activities.upsert({
        activityId: EventId.make("activity-user-input-requested-resolved"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "user-input.requested",
        summary: "Input requested",
        payload: { requestId: "request-resolved" },
        createdAt: "2026-03-24T00:00:01.000Z",
      });
      yield* activities.upsert({
        activityId: EventId.make("activity-user-input-resolved"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "user-input.resolved",
        summary: "Input resolved",
        payload: { requestId: "request-resolved" },
        createdAt: "2026-03-24T00:00:02.000Z",
      });
      yield* activities.upsert({
        activityId: EventId.make("activity-user-input-requested-stale"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "user-input.requested",
        summary: "Input requested",
        payload: { requestId: "request-stale" },
        createdAt: "2026-03-24T00:00:03.000Z",
      });
      yield* activities.upsert({
        activityId: EventId.make("activity-user-input-stale-failure"),
        threadId,
        turnId: null,
        tone: "error",
        kind: "provider.user-input.respond.failed",
        summary: "Input response failed",
        payload: {
          requestId: "request-stale",
          detail: "stale pending user-input request",
        },
        createdAt: "2026-03-24T00:00:04.000Z",
      });

      // Persist malformed identities through the same public boundary. They
      // cannot name a callback and must not add invisible pending attention.
      for (const [index, requestId] of [0, "", null, { id: "not-an-opaque-string" }].entries()) {
        yield* activities.upsert({
          activityId: EventId.make(`activity-user-input-malformed-${index}`),
          threadId,
          turnId: null,
          tone: "info",
          kind: "user-input.requested",
          summary: "Malformed input request",
          payload: { requestId },
          createdAt: "2026-03-24T00:00:05.000Z",
        });
      }

      const count = yield* activities.countPendingUserInputByThreadId({ threadId });

      assert.strictEqual(count, 1);
    }),
  );

  it.effect(
    "orders pending questions by their canonical lifecycle rather than wall clocks or opaque ids",
    () =>
      Effect.gen(function* () {
        const activities = yield* ProjectionThreadActivityRepository;
        const cases: ReadonlyArray<{
          name: string;
          requestSequence?: number;
          terminalSequence?: number;
          requestTime: string;
          terminalTime: string;
          terminalKind: "user-input.resolved" | "provider.user-input.respond.failed";
          detail?: unknown;
          expected: number;
        }> = [
          {
            name: "resolution-at-same-clock",
            requestSequence: 10,
            terminalSequence: 11,
            requestTime: "2026-03-24T00:00:01.000Z",
            terminalTime: "2026-03-24T00:00:01.000Z",
            terminalKind: "user-input.resolved",
            expected: 0,
          },
          {
            name: "resolution-with-earlier-clock",
            requestSequence: 20,
            terminalSequence: 21,
            requestTime: "2026-03-24T00:00:03.000Z",
            terminalTime: "2026-03-24T00:00:02.000Z",
            terminalKind: "user-input.resolved",
            expected: 0,
          },
          {
            name: "old-resolution-with-later-clock",
            requestSequence: 31,
            terminalSequence: 30,
            requestTime: "2026-03-24T00:00:09.000Z",
            terminalTime: "2026-03-24T00:00:10.000Z",
            terminalKind: "user-input.resolved",
            expected: 1,
          },
          {
            name: "legacy-request-before-known-resolution",
            terminalSequence: 1,
            requestTime: "2026-03-24T00:00:30.000Z",
            terminalTime: "2026-03-24T00:00:20.000Z",
            terminalKind: "user-input.resolved",
            expected: 0,
          },
          {
            name: "legacy-resolution-before-known-request",
            requestSequence: 50,
            requestTime: "2026-03-24T00:00:10.000Z",
            terminalTime: "2026-03-24T00:00:20.000Z",
            terminalKind: "user-input.resolved",
            expected: 1,
          },
          {
            name: "legacy-resolution-at-same-clock",
            requestTime: "2026-03-24T00:00:40.000Z",
            terminalTime: "2026-03-24T00:00:40.000Z",
            terminalKind: "user-input.resolved",
            expected: 0,
          },
          ...["stale pending user-input request", "unknown pending user-input request"].map(
            (detail) => ({
              name: detail.startsWith("stale") ? "stale-failure" : "unknown-failure",
              requestSequence: 60,
              terminalSequence: 61,
              requestTime: "2026-03-24T00:00:50.000Z",
              terminalTime: "2026-03-24T00:00:49.000Z",
              terminalKind: "provider.user-input.respond.failed" as const,
              detail,
              expected: 0,
            }),
          ),
          {
            name: "old-stale-failure-cannot-retire-newer-question",
            requestSequence: 63,
            terminalSequence: 62,
            requestTime: "2026-03-24T00:00:51.000Z",
            terminalTime: "2026-03-24T00:00:52.000Z",
            terminalKind: "provider.user-input.respond.failed",
            detail: "stale pending user-input request",
            expected: 1,
          },
          {
            name: "malformed-stale-detail-keeps-question",
            requestSequence: 65,
            terminalSequence: 66,
            requestTime: "2026-03-24T00:00:55.000Z",
            terminalTime: "2026-03-24T00:00:56.000Z",
            terminalKind: "provider.user-input.respond.failed",
            detail: { message: "unknown pending user-input request" },
            expected: 1,
          },
          {
            name: "ordinary-response-failure-keeps-question",
            requestSequence: 70,
            terminalSequence: 71,
            requestTime: "2026-03-24T00:01:00.000Z",
            terminalTime: "2026-03-24T00:01:01.000Z",
            terminalKind: "provider.user-input.respond.failed",
            detail: "Temporary provider transport failure",
            expected: 1,
          },
        ];

        for (const scenario of cases) {
          const threadId = ThreadId.make(`thread-question-order-${scenario.name}`);
          const requestId = `request-${scenario.name}`;
          // The later resolution deliberately has the lexically smaller id.
          // Persist through the public repository so this exercises SQL ordering
          // and aggregate accounting, rather than a test-only copy of the fold.
          yield* activities.upsert({
            activityId: EventId.make(`z-question-${scenario.name}`),
            threadId,
            turnId: null,
            tone: "info",
            kind: "user-input.requested",
            summary: "Input requested",
            payload: { requestId },
            ...(scenario.requestSequence !== undefined
              ? { sequence: scenario.requestSequence }
              : {}),
            createdAt: scenario.requestTime,
          });
          yield* activities.upsert({
            activityId: EventId.make(`a-terminal-${scenario.name}`),
            threadId,
            turnId: null,
            tone: "info",
            kind: scenario.terminalKind,
            summary: "Input response",
            payload: {
              requestId,
              ...(scenario.detail !== undefined ? { detail: scenario.detail } : {}),
            },
            ...(scenario.terminalSequence !== undefined
              ? { sequence: scenario.terminalSequence }
              : {}),
            createdAt: scenario.terminalTime,
          });

          const count = yield* activities.countPendingUserInputByThreadId({ threadId });
          assert.strictEqual(count, scenario.expected, scenario.name);
        }
      }),
  );
});
