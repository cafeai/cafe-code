import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";

const makeProjectionPipelinePrefixedTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* Effect.result(fileSystem.stat(filePath));
    return fileInfo._tag === "Success";
  });

const BaseTestLayer = makeProjectionPipelinePrefixedTestLayer("t3-projection-pipeline-test-");

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly scriptsJson: string;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `;
      assert.deepEqual(projectRows, [
        { projectId: "project-1", title: "Project 1", scriptsJson: "[]" },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 3);
      }
    }),
  );

  it.effect("duplicates thread context without copying provider session state", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-duplicate");
      const sourceThreadId = ThreadId.make("thread-source");
      const targetThreadId = ThreadId.make("thread-target");
      const turnId = TurnId.make("turn-source");
      const duplicateAt = "2026-06-05T00:00:05.000Z";

      const append = (event: Parameters<typeof eventStore.append>[0]) => eventStore.append(event);

      yield* append({
        type: "project.created",
        eventId: EventId.make("evt-duplicate-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: "2026-06-05T00:00:00.000Z",
        commandId: CommandId.make("cmd-duplicate-project"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-duplicate-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Duplicate Project",
          workspaceRoot: "/tmp/duplicate-project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-05T00:00:00.000Z",
          updatedAt: "2026-06-05T00:00:00.000Z",
        },
      });
      yield* append({
        type: "thread.created",
        eventId: EventId.make("evt-duplicate-source-created"),
        aggregateKind: "thread",
        aggregateId: sourceThreadId,
        occurredAt: "2026-06-05T00:00:01.000Z",
        commandId: CommandId.make("cmd-duplicate-source-created"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-duplicate-source-created"),
        metadata: {},
        payload: {
          threadId: sourceThreadId,
          projectId,
          title: "Source Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-06-05T00:00:01.000Z",
          updatedAt: "2026-06-05T00:00:01.000Z",
        },
      });
      yield* append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-duplicate-user-message"),
        aggregateKind: "thread",
        aggregateId: sourceThreadId,
        occurredAt: "2026-06-05T00:00:02.000Z",
        commandId: CommandId.make("cmd-duplicate-user-message"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-duplicate-user-message"),
        metadata: {},
        payload: {
          threadId: sourceThreadId,
          messageId: MessageId.make("message-user"),
          role: "user",
          text: "source prompt",
          turnId,
          streaming: false,
          createdAt: "2026-06-05T00:00:02.000Z",
          updatedAt: "2026-06-05T00:00:02.000Z",
        },
      });
      yield* append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-duplicate-assistant-message"),
        aggregateKind: "thread",
        aggregateId: sourceThreadId,
        occurredAt: "2026-06-05T00:00:03.000Z",
        commandId: CommandId.make("cmd-duplicate-assistant-message"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-duplicate-assistant-message"),
        metadata: {},
        payload: {
          threadId: sourceThreadId,
          messageId: MessageId.make("message-assistant"),
          role: "assistant",
          text: "partial source output",
          turnId,
          streaming: true,
          createdAt: "2026-06-05T00:00:03.000Z",
          updatedAt: "2026-06-05T00:00:03.000Z",
        },
      });
      yield* append({
        type: "thread.session-set",
        eventId: EventId.make("evt-duplicate-source-session"),
        aggregateKind: "thread",
        aggregateId: sourceThreadId,
        occurredAt: "2026-06-05T00:00:04.000Z",
        commandId: CommandId.make("cmd-duplicate-source-session"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-duplicate-source-session"),
        metadata: {},
        payload: {
          threadId: sourceThreadId,
          session: {
            threadId: sourceThreadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-06-05T00:00:04.000Z",
          },
        },
      });
      yield* append({
        type: "thread.created",
        eventId: EventId.make("evt-duplicate-target-created"),
        aggregateKind: "thread",
        aggregateId: targetThreadId,
        occurredAt: duplicateAt,
        commandId: CommandId.make("cmd-duplicate-target-created"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-duplicate-target-created"),
        metadata: {},
        payload: {
          threadId: targetThreadId,
          projectId,
          title: "Source Thread (copy)",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: duplicateAt,
          updatedAt: duplicateAt,
        },
      });
      yield* append({
        type: "thread.duplicated",
        eventId: EventId.make("evt-duplicate-context"),
        aggregateKind: "thread",
        aggregateId: targetThreadId,
        occurredAt: duplicateAt,
        commandId: CommandId.make("cmd-duplicate-context"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-duplicate-context"),
        metadata: {},
        payload: {
          sourceThreadId,
          targetThreadId,
          duplicatedAt: duplicateAt,
        },
      });

      yield* projectionPipeline.bootstrap;

      const targetMessages = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly isStreaming: number;
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE thread_id = ${targetThreadId}
        ORDER BY created_at ASC
      `;
      assert.deepEqual(targetMessages, [
        {
          messageId: "copy:thread-target:message-user",
          turnId: "copy:thread-target:turn-source",
          isStreaming: 0,
        },
        {
          messageId: "copy:thread-target:message-assistant",
          turnId: "copy:thread-target:turn-source",
          isStreaming: 0,
        },
      ]);

      const targetTurns = yield* sql<{
        readonly turnId: string;
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT
          turn_id AS "turnId",
          state,
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${targetThreadId}
      `;
      assert.deepEqual(targetTurns, [
        {
          turnId: "copy:thread-target:turn-source",
          state: "interrupted",
          completedAt: duplicateAt,
        },
      ]);

      const targetSessionCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_sessions
        WHERE thread_id = ${targetThreadId}
      `;
      assert.equal(targetSessionCount[0]?.count, 0);

      const targetShell = yield* sql<{
        readonly latestTurnId: string | null;
        readonly pendingApprovalCount: number;
        readonly pendingUserInputCount: number;
      }>`
        SELECT
          latest_turn_id AS "latestTurnId",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount"
        FROM projection_threads
        WHERE thread_id = ${targetThreadId}
      `;
      assert.deepEqual(targetShell, [
        {
          latestTurnId: "copy:thread-target:turn-source",
          pendingApprovalCount: 0,
          pendingUserInputCount: 0,
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-terminal-late-streaming-replay-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "does not reopen assistant streaming when a stale delta arrives after turn terminal",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-terminal-replay");
        const threadId = ThreadId.make("thread-terminal-replay");
        const turnId = TurnId.make("turn-terminal-replay");
        const messageId = MessageId.make("assistant-terminal-replay");
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-terminal-replay-project"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-05-27T01:00:00.000Z",
          commandId: CommandId.make("cmd-terminal-replay-project"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-terminal-replay-project"),
          metadata: {},
          payload: {
            projectId,
            title: "Terminal Replay Project",
            workspaceRoot: "/tmp/terminal-replay-project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-05-27T01:00:00.000Z",
            updatedAt: "2026-05-27T01:00:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-terminal-replay-thread"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-27T01:00:01.000Z",
          commandId: CommandId.make("cmd-terminal-replay-thread"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-terminal-replay-thread"),
          metadata: {},
          payload: {
            threadId,
            projectId,
            title: "Terminal Replay Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.5",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-05-27T01:00:01.000Z",
            updatedAt: "2026-05-27T01:00:01.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-terminal-replay-complete-message"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-27T01:00:02.000Z",
          commandId: CommandId.make("cmd-terminal-replay-complete-message"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-terminal-replay-complete-message"),
          metadata: {},
          payload: {
            threadId,
            messageId,
            role: "assistant",
            text: "complete text",
            turnId,
            streaming: false,
            createdAt: "2026-05-27T01:00:02.000Z",
            updatedAt: "2026-05-27T01:00:02.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-terminal-replay-turn-complete"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-27T01:00:03.000Z",
          commandId: CommandId.make("cmd-terminal-replay-turn-complete"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-terminal-replay-turn-complete"),
          metadata: {},
          payload: {
            threadId,
            turnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/terminal-replay/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: messageId,
            completedAt: "2026-05-27T01:00:03.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-terminal-replay-stale-delta"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-27T01:00:01.500Z",
          commandId: CommandId.make("cmd-terminal-replay-stale-delta"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-terminal-replay-stale-delta"),
          metadata: {},
          payload: {
            threadId,
            messageId,
            role: "assistant",
            text: " duplicate",
            turnId,
            streaming: true,
            createdAt: "2026-05-27T01:00:01.500Z",
            updatedAt: "2026-05-27T01:00:01.500Z",
          },
        });

        const rows = yield* sql<{
          readonly text: string;
          readonly isStreaming: number;
          readonly updatedAt: string;
        }>`
        SELECT
          text,
          is_streaming AS "isStreaming",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
      `;

        assert.deepEqual(rows, [
          {
            text: "complete text",
            isStreaming: 0,
            updatedAt: "2026-05-27T01:00:03.000Z",
          },
        ]);
      }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-clear-pending-turn-start-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("clears pending turn-start rows when a session is reset without an active turn", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const threadId = ThreadId.make("thread-orphan-start");
        const messageId = MessageId.make("message-orphan-start");

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-orphan-project"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-orphan"),
          occurredAt: now,
          commandId: CommandId.make("cmd-orphan-project"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-orphan-project"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-orphan"),
            title: "Project",
            workspaceRoot: "/tmp/project-orphan",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-orphan-thread"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-orphan-thread"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-orphan-thread"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-orphan"),
            title: "Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* eventStore.append({
          type: "thread.turn-start-requested",
          eventId: EventId.make("evt-orphan-turn-start"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-orphan-turn-start"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-orphan-turn-start"),
          metadata: {},
          payload: {
            threadId,
            messageId,
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-opus-4-6",
            },
            runtimeMode: "approval-required",
            interactionMode: "plan",
            createdAt: now,
          },
        });
        yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make("evt-orphan-session-reset"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-01-01T00:00:01.000Z",
          commandId: CommandId.make("cmd-orphan-session-reset"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-orphan-session-reset"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: "turn start interrupted",
              updatedAt: "2026-01-01T00:00:01.000Z",
            },
          },
        });

        yield* projectionPipeline.bootstrap;

        const sessionRows = yield* sql<{
          readonly status: string;
          readonly activeTurnId: string | null;
          readonly lastError: string | null;
        }>`
          SELECT
            status,
            active_turn_id AS "activeTurnId",
            last_error AS "lastError"
          FROM projection_thread_sessions
          WHERE thread_id = ${threadId}
        `;
        const threadRows = yield* sql<{
          readonly instanceId: string;
          readonly model: string;
          readonly runtimeMode: string;
          readonly interactionMode: string;
        }>`
          SELECT
            json_extract(model_selection_json, '$.instanceId') AS "instanceId",
            json_extract(model_selection_json, '$.model') AS "model",
            runtime_mode AS "runtimeMode",
            interaction_mode AS "interactionMode"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        const pendingRows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM projection_turns
          WHERE thread_id = ${threadId}
            AND turn_id IS NULL
            AND state = 'pending'
        `;

        assert.deepEqual(sessionRows, [
          {
            status: "ready",
            activeTurnId: null,
            lastError: "turn start interrupted",
          },
        ]);
        assert.deepEqual(threadRows, [
          {
            instanceId: "claudeAgent",
            model: "claude-opus-4-6",
            runtimeMode: "approval-required",
            interactionMode: "plan",
          },
        ]);
        assert.deepEqual(pendingRows, [{ count: 0 }]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-interrupt-clears-session-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("clears active thread sessions when an active turn is interrupted", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-interrupt-session");
        const turnId = TurnId.make("turn-interrupt-session");
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-interrupt-project"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-interrupt"),
          occurredAt: "2026-05-24T15:00:00.000Z",
          commandId: CommandId.make("cmd-interrupt-project"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-interrupt-project"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-interrupt"),
            title: "Project",
            workspaceRoot: "/tmp/project-interrupt",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-05-24T15:00:00.000Z",
            updatedAt: "2026-05-24T15:00:00.000Z",
          },
        });
        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-interrupt-thread"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-24T15:00:01.000Z",
          commandId: CommandId.make("cmd-interrupt-thread"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-interrupt-thread"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-interrupt"),
            title: "Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-05-24T15:00:01.000Z",
            updatedAt: "2026-05-24T15:00:01.000Z",
          },
        });
        yield* appendAndProject({
          type: "thread.session-set",
          eventId: EventId.make("evt-interrupt-running"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-24T15:00:02.000Z",
          commandId: CommandId.make("cmd-interrupt-running"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-interrupt-running"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: "2026-05-24T15:00:02.000Z",
            },
          },
        });
        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-interrupt-streaming-message"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-24T15:00:02.500Z",
          commandId: CommandId.make("cmd-interrupt-streaming-message"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-interrupt-streaming-message"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("message-interrupt-streaming"),
            role: "assistant",
            text: "partial assistant text",
            turnId,
            streaming: true,
            createdAt: "2026-05-24T15:00:02.500Z",
            updatedAt: "2026-05-24T15:00:02.500Z",
          },
        });
        yield* appendAndProject({
          type: "thread.turn-interrupt-requested",
          eventId: EventId.make("evt-interrupt-requested"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-24T15:00:03.000Z",
          commandId: CommandId.make("cmd-interrupt-requested"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-interrupt-requested"),
          metadata: {},
          payload: {
            threadId,
            turnId,
            createdAt: "2026-05-24T15:00:03.000Z",
          },
        });

        const rows = yield* sql<{
          readonly status: string;
          readonly activeTurnId: string | null;
          readonly turnState: string;
          readonly completedAt: string | null;
          readonly isStreaming: number;
          readonly messageUpdatedAt: string;
        }>`
          SELECT
            sessions.status,
            sessions.active_turn_id AS "activeTurnId",
            turns.state AS "turnState",
            turns.completed_at AS "completedAt",
            messages.is_streaming AS "isStreaming",
            messages.updated_at AS "messageUpdatedAt"
          FROM projection_thread_sessions sessions
          JOIN projection_turns turns
            ON turns.thread_id = sessions.thread_id
           AND turns.turn_id = ${turnId}
          JOIN projection_thread_messages messages
            ON messages.thread_id = sessions.thread_id
           AND messages.message_id = 'message-interrupt-streaming'
          WHERE sessions.thread_id = ${threadId}
        `;

        assert.deepEqual(rows, [
          {
            status: "interrupted",
            activeTurnId: null,
            turnState: "interrupted",
            completedAt: "2026-05-24T15:00:03.000Z",
            isStreaming: 0,
            messageUpdatedAt: "2026-05-24T15:00:03.000Z",
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-diff-completes-session-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("clears active sessions when a real turn diff completes the active turn", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-diff-completes-session");
        const missingThreadId = ThreadId.make("thread-missing-diff-keeps-session");
        const turnId = TurnId.make("turn-diff-completes-session");
        const missingTurnId = TurnId.make("turn-missing-diff-keeps-session");
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-diff-project"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-diff-session"),
          occurredAt: "2026-05-24T16:00:00.000Z",
          commandId: CommandId.make("cmd-diff-project"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-diff-project"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-diff-session"),
            title: "Project",
            workspaceRoot: "/tmp/project-diff-session",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-05-24T16:00:00.000Z",
            updatedAt: "2026-05-24T16:00:00.000Z",
          },
        });

        for (const [id, title] of [
          [threadId, "Real Diff"],
          [missingThreadId, "Missing Diff"],
        ] as const) {
          yield* appendAndProject({
            type: "thread.created",
            eventId: EventId.make(`evt-diff-thread-${id}`),
            aggregateKind: "thread",
            aggregateId: id,
            occurredAt: "2026-05-24T16:00:01.000Z",
            commandId: CommandId.make(`cmd-diff-thread-${id}`),
            causationEventId: null,
            correlationId: CommandId.make(`cmd-diff-thread-${id}`),
            metadata: {},
            payload: {
              threadId: id,
              projectId: ProjectId.make("project-diff-session"),
              title,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5-codex",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: "2026-05-24T16:00:01.000Z",
              updatedAt: "2026-05-24T16:00:01.000Z",
            },
          });
        }

        yield* appendAndProject({
          type: "thread.session-set",
          eventId: EventId.make("evt-diff-running"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-24T16:00:02.000Z",
          commandId: CommandId.make("cmd-diff-running"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-diff-running"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: "2026-05-24T16:00:02.000Z",
            },
          },
        });
        yield* appendAndProject({
          type: "thread.session-set",
          eventId: EventId.make("evt-diff-missing-running"),
          aggregateKind: "thread",
          aggregateId: missingThreadId,
          occurredAt: "2026-05-24T16:00:02.000Z",
          commandId: CommandId.make("cmd-diff-missing-running"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-diff-missing-running"),
          metadata: {},
          payload: {
            threadId: missingThreadId,
            session: {
              threadId: missingThreadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: missingTurnId,
              lastError: null,
              updatedAt: "2026-05-24T16:00:02.000Z",
            },
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-diff-completed"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-24T16:00:03.000Z",
          commandId: CommandId.make("cmd-diff-completed"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-diff-completed"),
          metadata: {},
          payload: {
            threadId,
            turnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/diff/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-diff-completed"),
            completedAt: "2026-05-24T16:00:03.000Z",
          },
        });
        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-diff-missing"),
          aggregateKind: "thread",
          aggregateId: missingThreadId,
          occurredAt: "2026-05-24T16:00:03.000Z",
          commandId: CommandId.make("cmd-diff-missing"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-diff-missing"),
          metadata: {},
          payload: {
            threadId: missingThreadId,
            turnId: missingTurnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("provider-diff:event"),
            status: "missing",
            files: [],
            assistantMessageId: MessageId.make("assistant-diff-missing"),
            completedAt: "2026-05-24T16:00:03.000Z",
          },
        });

        const rows = yield* sql<{
          readonly threadId: string;
          readonly status: string;
          readonly activeTurnId: string | null;
          readonly turnState: string;
          readonly completedAt: string | null;
        }>`
          SELECT
            sessions.thread_id AS "threadId",
            sessions.status,
            sessions.active_turn_id AS "activeTurnId",
            turns.state AS "turnState",
            turns.completed_at AS "completedAt"
          FROM projection_thread_sessions sessions
          JOIN projection_turns turns
            ON turns.thread_id = sessions.thread_id
           AND turns.turn_id = sessions.active_turn_id
              OR (
                sessions.active_turn_id IS NULL
                AND turns.thread_id = sessions.thread_id
              )
          WHERE sessions.thread_id IN (${threadId}, ${missingThreadId})
          ORDER BY sessions.thread_id ASC
        `;

        assert.deepEqual(rows, [
          {
            threadId: "thread-diff-completes-session",
            status: "ready",
            activeTurnId: null,
            turnState: "completed",
            completedAt: "2026-05-24T16:00:03.000Z",
          },
          {
            threadId: "thread-missing-diff-keeps-session",
            status: "running",
            activeTurnId: "turn-missing-diff-keeps-session",
            turnState: "running",
            completedAt: null,
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-terminal-session-replay-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("does not reopen a terminal turn from a late running session snapshot", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-terminal-session-replay");
        const turnId = TurnId.make("turn-terminal-session-replay");
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-terminal-replay-project"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-terminal-replay"),
          occurredAt: "2026-05-24T17:00:00.000Z",
          commandId: CommandId.make("cmd-terminal-replay-project"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-terminal-replay-project"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-terminal-replay"),
            title: "Project",
            workspaceRoot: "/tmp/project-terminal-replay",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-05-24T17:00:00.000Z",
            updatedAt: "2026-05-24T17:00:00.000Z",
          },
        });
        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-terminal-replay-thread"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-24T17:00:01.000Z",
          commandId: CommandId.make("cmd-terminal-replay-thread"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-terminal-replay-thread"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-terminal-replay"),
            title: "Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-05-24T17:00:01.000Z",
            updatedAt: "2026-05-24T17:00:01.000Z",
          },
        });
        yield* appendAndProject({
          type: "thread.session-set",
          eventId: EventId.make("evt-terminal-replay-running"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-24T17:00:02.000Z",
          commandId: CommandId.make("cmd-terminal-replay-running"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-terminal-replay-running"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: "2026-05-24T17:00:02.000Z",
            },
          },
        });
        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-terminal-replay-diff"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-24T17:00:03.000Z",
          commandId: CommandId.make("cmd-terminal-replay-diff"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-terminal-replay-diff"),
          metadata: {},
          payload: {
            threadId,
            turnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/terminal-replay/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-terminal-replay"),
            completedAt: "2026-05-24T17:00:03.000Z",
          },
        });
        yield* appendAndProject({
          type: "thread.session-set",
          eventId: EventId.make("evt-terminal-replay-late-running"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-24T17:00:04.500Z",
          commandId: CommandId.make("cmd-terminal-replay-late-running"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-terminal-replay-late-running"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: "2026-05-24T17:00:04.500Z",
            },
          },
        });

        const rows = yield* sql<{
          readonly sessionStatus: string;
          readonly activeTurnId: string | null;
          readonly turnState: string;
          readonly completedAt: string | null;
          readonly checkpointStatus: string | null;
        }>`
          SELECT
            sessions.status AS "sessionStatus",
            sessions.active_turn_id AS "activeTurnId",
            turns.state AS "turnState",
            turns.completed_at AS "completedAt",
            turns.checkpoint_status AS "checkpointStatus"
          FROM projection_thread_sessions sessions
          JOIN projection_turns turns
            ON turns.thread_id = sessions.thread_id
           AND turns.turn_id = ${turnId}
          WHERE sessions.thread_id = ${threadId}
        `;

        assert.deepEqual(rows, [
          {
            sessionStatus: "ready",
            activeTurnId: null,
            turnState: "completed",
            completedAt: "2026-05-24T17:00:03.000Z",
            checkpointStatus: "ready",
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-late-backfill-latest-turn-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("does not regress the shell latest turn from late older checkpoint backfill", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-late-backfill-latest-turn");
        const oldTurnId = TurnId.make("turn-late-backfill-old");
        const newTurnId = TurnId.make("turn-late-backfill-new");
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-late-backfill-project"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-late-backfill"),
          occurredAt: "2026-05-26T10:00:00.000Z",
          commandId: CommandId.make("cmd-late-backfill-project"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-late-backfill-project"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-late-backfill"),
            title: "Project",
            workspaceRoot: "/tmp/project-late-backfill",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-05-26T10:00:00.000Z",
            updatedAt: "2026-05-26T10:00:00.000Z",
          },
        });
        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-late-backfill-thread"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-26T10:00:01.000Z",
          commandId: CommandId.make("cmd-late-backfill-thread"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-late-backfill-thread"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-late-backfill"),
            title: "Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-05-26T10:00:01.000Z",
            updatedAt: "2026-05-26T10:00:01.000Z",
          },
        });

        for (const [eventId, turnId, updatedAt] of [
          ["evt-late-backfill-old-running", oldTurnId, "2026-05-26T11:00:00.000Z"],
          ["evt-late-backfill-new-running", newTurnId, "2026-05-26T12:00:00.000Z"],
        ] as const) {
          yield* appendAndProject({
            type: "thread.session-set",
            eventId: EventId.make(eventId),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: updatedAt,
            commandId: CommandId.make(eventId.replace("evt", "cmd")),
            causationEventId: null,
            correlationId: CommandId.make(eventId.replace("evt", "cmd")),
            metadata: {},
            payload: {
              threadId,
              session: {
                threadId,
                status: "running",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "full-access",
                activeTurnId: turnId,
                lastError: null,
                updatedAt,
              },
            },
          });
        }

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-late-backfill-new-diff"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-26T12:10:00.000Z",
          commandId: CommandId.make("cmd-late-backfill-new-diff"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-late-backfill-new-diff"),
          metadata: {},
          payload: {
            threadId,
            turnId: newTurnId,
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/backfill/new"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-late-backfill-new"),
            completedAt: "2026-05-26T12:10:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-late-backfill-old-diff"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-26T11:15:00.000Z",
          commandId: CommandId.make("cmd-late-backfill-old-diff"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-late-backfill-old-diff"),
          metadata: {},
          payload: {
            threadId,
            turnId: oldTurnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/backfill/old"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-late-backfill-old"),
            completedAt: "2026-05-26T11:15:00.000Z",
          },
        });
        yield* appendAndProject({
          type: "thread.session-set",
          eventId: EventId.make("evt-late-backfill-old-ready"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-05-26T11:16:00.000Z",
          commandId: CommandId.make("cmd-late-backfill-old-ready"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-late-backfill-old-ready"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-05-26T11:16:00.000Z",
            },
          },
        });

        const rows = yield* sql<{
          readonly latestTurnId: string | null;
          readonly threadUpdatedAt: string;
          readonly sessionStatus: string;
          readonly activeTurnId: string | null;
          readonly sessionUpdatedAt: string;
        }>`
          SELECT
            threads.latest_turn_id AS "latestTurnId",
            threads.updated_at AS "threadUpdatedAt",
            sessions.status AS "sessionStatus",
            sessions.active_turn_id AS "activeTurnId",
            sessions.updated_at AS "sessionUpdatedAt"
          FROM projection_threads threads
          JOIN projection_thread_sessions sessions
            ON sessions.thread_id = threads.thread_id
          WHERE threads.thread_id = ${threadId}
        `;

        assert.deepEqual(rows, [
          {
            latestTurnId: "turn-late-backfill-new",
            threadUpdatedAt: "2026-05-26T12:10:00.000Z",
            sessionStatus: "ready",
            activeTurnId: null,
            sessionUpdatedAt: "2026-05-26T12:10:00.000Z",
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-thread-move-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("persists moved thread project ids from thread meta updates", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const movedAt = "2026-01-01T00:00:01.000Z";

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-move-project-source"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-source"),
          occurredAt: now,
          commandId: CommandId.make("cmd-move-project-source"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-move-project-source"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-source"),
            title: "Source",
            workspaceRoot: "/tmp/source",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-move-project-target"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-target"),
          occurredAt: now,
          commandId: CommandId.make("cmd-move-project-target"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-move-project-target"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-target"),
            title: "Target",
            workspaceRoot: "/tmp/target",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-move-thread-create"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-move"),
          occurredAt: now,
          commandId: CommandId.make("cmd-move-thread-create"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-move-thread-create"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-move"),
            projectId: ProjectId.make("project-source"),
            title: "Move Me",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* eventStore.append({
          type: "thread.meta-updated",
          eventId: EventId.make("evt-move-thread-meta"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-move"),
          occurredAt: movedAt,
          commandId: CommandId.make("cmd-move-thread-meta"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-move-thread-meta"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-move"),
            projectId: ProjectId.make("project-target"),
            updatedAt: movedAt,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly threadId: string;
          readonly projectId: string;
          readonly title: string;
          readonly updatedAt: string;
        }>`
          SELECT
            thread_id AS "threadId",
            project_id AS "projectId",
            title,
            updated_at AS "updatedAt"
          FROM projection_threads
          WHERE thread_id = ${"thread-move"}
        `;
        assert.deepEqual(rows, [
          {
            threadId: "thread-move",
            projectId: "project-target",
            title: "Move Me",
            updatedAt: movedAt,
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-base-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("stores message attachment references without mutating payloads", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments"),
            messageId: MessageId.make("message-attachments"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-att-1",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments'
          `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-safe-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("preserves mixed image attachment metadata as-is", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments-safe"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments-safe"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments-safe"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments-safe"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments-safe"),
            messageId: MessageId.make("message-attachments-safe"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-safe-att-1",
                name: "untrusted.exe",
                mimeType: "image/x-unknown",
                sizeBytes: 5,
              },
              {
                type: "image",
                id: "thread-attachments-safe-att-2",
                name: "not-image.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments-safe'
          `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-safe-att-1",
            name: "untrusted.exe",
            mimeType: "image/x-unknown",
            sizeBytes: 5,
          },
          {
            type: "image",
            id: "thread-attachments-safe-att-2",
            name: "not-image.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "passes explicit empty attachment arrays through the projection pipeline to clear attachments",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const later = "2026-01-01T00:00:01.000Z";

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-clear-attachments-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-1"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Project Clear Attachments",
            workspaceRoot: "/tmp/project-clear-attachments",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-clear-attachments-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-2"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Thread Clear Attachments",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-clear-attachments-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-3"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "Has attachments",
            attachments: [
              {
                type: "image",
                id: "thread-clear-attachments-att-1",
                name: "clear.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-clear-attachments-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: later,
          commandId: CommandId.make("cmd-clear-attachments-4"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
          SELECT
            attachments_json AS "attachmentsJson"
          FROM projection_thread_messages
          WHERE message_id = 'message-clear-attachments'
        `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), []);
      }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("overwrites stored attachment references when a message updates attachments", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const later = "2026-01-01T00:00:01.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-overwrite-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-overwrite"),
          title: "Project Overwrite",
          workspaceRoot: "/tmp/project-overwrite",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-overwrite-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          projectId: ProjectId.make("project-overwrite"),
          title: "Thread Overwrite",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-overwrite-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "first image",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-1",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-overwrite-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: later,
        commandId: CommandId.make("cmd-overwrite-4"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-2",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: later,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
              SELECT attachments_json AS "attachmentsJson"
              FROM projection_thread_messages
              WHERE message_id = 'message-overwrite'
            `;
      assert.equal(rows.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-overwrite-att-2",
          name: "file.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-rollback-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("does not persist attachment files when projector transaction rolls back", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-rollback-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-rollback"),
          title: "Project Rollback",
          workspaceRoot: "/tmp/project-rollback",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-rollback-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-rollback"),
          projectId: ProjectId.make("project-rollback"),
          title: "Thread Rollback",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* sql`
        CREATE TRIGGER fail_thread_messages_projection_state_update
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.thread-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-projection-state-failure');
        END;
      `;

      const result = yield* Effect.result(
        appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-rollback-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-rollback"),
          occurredAt: now,
          commandId: CommandId.make("cmd-rollback-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-rollback-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-rollback"),
            messageId: MessageId.make("message-rollback"),
            role: "user",
            text: "Rollback me",
            attachments: [
              {
                type: "image",
                id: "thread-rollback-att-1",
                name: "rollback.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      assert.equal(result._tag, "Failure");

      const rows = yield* sql<{
        readonly count: number;
      }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE message_id = 'message-rollback'
      `;
      assert.equal(rows[0]?.count ?? 0, 0);

      const { attachmentsDir } = yield* ServerConfig;
      const attachmentPath = path.join(attachmentsDir, "thread-rollback-att-1.png");
      assert.isFalse(yield* exists(attachmentPath));
      yield* sql`DROP TRIGGER IF EXISTS fail_thread_messages_projection_state_update`;
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("removes unreferenced attachment files when a thread is reverted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("Thread Revert.Files");
      const keepAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000001";
      const removeAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000002";
      const otherThreadAttachmentId =
        "thread-revert-files-extra-00000000-0000-4000-8000-000000000003";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-revert-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-revert-files"),
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-revert-files"),
          title: "Project Revert Files",
          workspaceRoot: "/tmp/project-revert-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-revert-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-revert-files"),
          title: "Thread Revert Files",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-3"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-keep"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert-files/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-keep"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-4"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-keep"),
          role: "assistant",
          text: "Keep",
          attachments: [
            {
              type: "image",
              id: keepAttachmentId,
              name: "keep.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-keep"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-5"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-5"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-remove"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert-files/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-remove"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-6"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-6"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-remove"),
          role: "assistant",
          text: "Remove",
          attachments: [
            {
              type: "image",
              id: removeAttachmentId,
              name: "remove.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-remove"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const keepPath = path.join(attachmentsDir, `${keepAttachmentId}.png`);
      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "keep");
      yield* fileSystem.writeFileString(removePath, "remove");
      const otherThreadPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.writeFileString(otherThreadPath, "other");
      assert.isTrue(yield* exists(keepPath));
      assert.isTrue(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.make("evt-revert-files-7"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-7"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-7"),
        metadata: {},
        payload: {
          threadId,
          turnCount: 1,
        },
      });

      assert.isTrue(yield* exists(keepPath));
      assert.isFalse(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-revert-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("removes thread attachment directory when thread is deleted", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const { attachmentsDir } = yield* ServerConfig;
        const now = "2026-01-01T00:00:00.000Z";
        const threadId = ThreadId.make("Thread Delete.Files");
        const attachmentId = "thread-delete-files-00000000-0000-4000-8000-000000000001";
        const otherThreadAttachmentId =
          "thread-delete-files-extra-00000000-0000-4000-8000-000000000002";

        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-delete-files-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-delete-files"),
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-delete-files"),
            title: "Project Delete Files",
            workspaceRoot: "/tmp/project-delete-files",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-delete-files-2"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-2"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-delete-files"),
            title: "Thread Delete Files",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-delete-files-3"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-3"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("message-delete-files"),
            role: "user",
            text: "Delete",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "delete.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        const threadAttachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
        const otherThreadAttachmentPath = path.join(
          attachmentsDir,
          `${otherThreadAttachmentId}.png`,
        );
        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(threadAttachmentPath, "delete");
        yield* fileSystem.writeFileString(otherThreadAttachmentPath, "other-thread");
        assert.isTrue(yield* exists(threadAttachmentPath));
        assert.isTrue(yield* exists(otherThreadAttachmentPath));

        yield* appendAndProject({
          type: "thread.deleted",
          eventId: EventId.make("evt-delete-files-4"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-4"),
          metadata: {},
          payload: {
            threadId,
            deletedAt: now,
          },
        });

        assert.isFalse(yield* exists(threadAttachmentPath));
        assert.isTrue(yield* exists(otherThreadAttachmentPath));
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-delete-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("ignores unsafe thread ids for attachment cleanup paths", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const now = "2026-01-01T00:00:00.000Z";
        const { attachmentsDir: attachmentsRootDir, stateDir } = yield* ServerConfig;
        const attachmentsSentinelPath = path.join(attachmentsRootDir, "sentinel.txt");
        const stateDirSentinelPath = path.join(stateDir, "state-sentinel.txt");
        yield* fileSystem.makeDirectory(attachmentsRootDir, { recursive: true });
        yield* fileSystem.writeFileString(attachmentsSentinelPath, "keep-attachments-root");
        yield* fileSystem.writeFileString(stateDirSentinelPath, "keep-state-dir");

        yield* eventStore.append({
          type: "thread.deleted",
          eventId: EventId.make("evt-unsafe-thread-delete"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make(".."),
          occurredAt: now,
          commandId: CommandId.make("cmd-unsafe-thread-delete"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-unsafe-thread-delete"),
          metadata: {},
          payload: {
            threadId: ThreadId.make(".."),
            deletedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        assert.isTrue(yield* exists(attachmentsRootDir));
        assert.isTrue(yield* exists(attachmentsSentinelPath));
        assert.isTrue(yield* exists(stateDirSentinelPath));
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("resumes from projector last_applied_sequence without replaying older events", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-a1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-a"),
          title: "Project A",
          workspaceRoot: "/tmp/project-a",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-a2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          projectId: ProjectId.make("project-a"),
          title: "Thread A",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE message_id = 'message-a'
      `;
      assert.deepEqual(messageRows, [{ text: "hello world" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0;
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, maxSequence);
      }
    }),
  );

  it.effect("keeps accumulated assistant text when completion payload text is empty", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-empty-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-empty"),
          title: "Project Empty",
          workspaceRoot: "/tmp/project-empty",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-empty-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          projectId: ProjectId.make("project-empty"),
          title: "Thread Empty",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: "Hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string; readonly isStreaming: unknown }>`
        SELECT
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE message_id = 'assistant-empty'
      `;
      assert.equal(messageRows.length, 1);
      assert.equal(messageRows[0]?.text, "Hello world");
      assert.isFalse(Boolean(messageRows[0]?.isStreaming));
    }),
  );

  it.effect("does not churn thread shell timestamps for streaming assistant deltas", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      const createdAt = "2026-01-01T00:00:00.000Z";
      const deltaAt = "2026-01-01T00:00:05.000Z";

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-stream-shell-project"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-stream-shell"),
        occurredAt: createdAt,
        commandId: CommandId.make("cmd-stream-shell-project"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stream-shell-project"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-stream-shell"),
          title: "Project Stream Shell",
          workspaceRoot: "/tmp/project-stream-shell",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-stream-shell-thread"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stream-shell"),
        occurredAt: createdAt,
        commandId: CommandId.make("cmd-stream-shell-thread"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stream-shell-thread"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stream-shell"),
          projectId: ProjectId.make("project-stream-shell"),
          title: "Thread Stream Shell",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-stream-shell-delta"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stream-shell"),
        occurredAt: deltaAt,
        commandId: CommandId.make("cmd-stream-shell-delta"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stream-shell-delta"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stream-shell"),
          messageId: MessageId.make("assistant-stream-shell"),
          role: "assistant",
          text: "streaming",
          turnId: null,
          streaming: true,
          createdAt: deltaAt,
          updatedAt: deltaAt,
        },
      });

      const threadRows = yield* sql<{ readonly updatedAt: string }>`
        SELECT updated_at AS "updatedAt"
        FROM projection_threads
        WHERE thread_id = 'thread-stream-shell'
      `;
      assert.deepEqual(threadRows, [{ updatedAt: createdAt }]);

      const messageRows = yield* sql<{ readonly text: string }>`
        SELECT text
        FROM projection_thread_messages
        WHERE message_id = 'assistant-stream-shell'
      `;
      assert.deepEqual(messageRows, [{ text: "streaming" }]);
    }),
  );

  it.effect(
    "resolves turn-count conflicts when checkpoint completion rewrites provisional turns",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-conflict-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-conflict"),
          occurredAt: "2026-02-26T13:00:00.000Z",
          commandId: CommandId.make("cmd-conflict-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-conflict"),
            title: "Project Conflict",
            workspaceRoot: "/tmp/project-conflict",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-02-26T13:00:00.000Z",
            updatedAt: "2026-02-26T13:00:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-conflict-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:01.000Z",
          commandId: CommandId.make("cmd-conflict-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            projectId: ProjectId.make("project-conflict"),
            title: "Thread Conflict",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-02-26T13:00:01.000Z",
            updatedAt: "2026-02-26T13:00:01.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-interrupt-requested",
          eventId: EventId.make("evt-conflict-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:02.000Z",
          commandId: CommandId.make("cmd-conflict-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            turnId: TurnId.make("turn-interrupted"),
            createdAt: "2026-02-26T13:00:02.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-conflict-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:03.000Z",
          commandId: CommandId.make("cmd-conflict-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            messageId: MessageId.make("assistant-conflict"),
            role: "assistant",
            text: "done",
            turnId: TurnId.make("turn-completed"),
            streaming: false,
            createdAt: "2026-02-26T13:00:03.000Z",
            updatedAt: "2026-02-26T13:00:03.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-conflict-5"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:04.000Z",
          commandId: CommandId.make("cmd-conflict-5"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-5"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            turnId: TurnId.make("turn-completed"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-conflict/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-conflict"),
            completedAt: "2026-02-26T13:00:04.000Z",
          },
        });

        const turnRows = yield* sql<{
          readonly turnId: string;
          readonly checkpointTurnCount: number | null;
          readonly status: string;
        }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          state AS "status"
        FROM projection_turns
        WHERE thread_id = 'thread-conflict'
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC
      `;
        assert.deepEqual(turnRows, [
          { turnId: "turn-completed", checkpointTurnCount: 1, status: "completed" },
          { turnId: "turn-interrupted", checkpointTurnCount: null, status: "interrupted" },
        ]);
      }),
  );

  it.effect("clears stale pending approvals from projected shell summaries", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-stale-approval-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-stale-approval"),
        occurredAt: "2026-02-26T12:30:00.000Z",
        commandId: CommandId.make("cmd-stale-approval-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-stale-approval"),
          title: "Project Stale Approval",
          workspaceRoot: "/tmp/project-stale-approval",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:30:00.000Z",
          updatedAt: "2026-02-26T12:30:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-stale-approval-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:01.000Z",
        commandId: CommandId.make("cmd-stale-approval-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          projectId: ProjectId.make("project-stale-approval"),
          title: "Thread Stale Approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:30:01.000Z",
          updatedAt: "2026-02-26T12:30:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-approval-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:02.000Z",
        commandId: CommandId.make("cmd-stale-approval-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          activity: {
            id: EventId.make("activity-stale-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-stale-1",
              requestKind: "command",
            },
            turnId: null,
            createdAt: "2026-02-26T12:30:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-approval-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:03.000Z",
        commandId: CommandId.make("cmd-stale-approval-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          activity: {
            id: EventId.make("activity-stale-approval-failed"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-stale-1",
              detail: "Unknown pending permission request: approval-request-stale-1",
            },
            turnId: null,
            createdAt: "2026-02-26T12:30:03.000Z",
          },
        },
      });

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id = 'approval-request-stale-1'
      `;
      assert.deepEqual(approvalRows, [
        {
          requestId: "approval-request-stale-1",
          status: "resolved",
          resolvedAt: "2026-02-26T12:30:03.000Z",
        },
      ]);

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number;
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-stale-approval'
      `;
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 0 }]);
    }),
  );

  it.effect("ignores non-stale provider approval response failures", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-nonstale-approval-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:00.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-nonstale-approval"),
          title: "Project Non-Stale Approval",
          workspaceRoot: "/tmp/project-nonstale-approval",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:45:00.000Z",
          updatedAt: "2026-02-26T12:45:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-nonstale-approval-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:01.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          projectId: ProjectId.make("project-nonstale-approval"),
          title: "Thread Non-Stale Approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:45:01.000Z",
          updatedAt: "2026-02-26T12:45:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:02.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-nonstale-existing",
              requestKind: "command",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:03.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-failed-existing"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-nonstale-existing",
              detail: "Provider timed out while responding to approval request",
            },
            turnId: TurnId.make("turn-nonstale-failure"),
            createdAt: "2026-02-26T12:45:03.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:04.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-failed-missing"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-nonstale-missing",
              detail: "Provider timed out while responding to approval request",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:04.000Z",
          },
        },
      });

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly turnId: string | null;
        readonly createdAt: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          turn_id AS "turnId",
          created_at AS "createdAt",
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id IN (
          'approval-request-nonstale-existing',
          'approval-request-nonstale-missing'
        )
        ORDER BY request_id
      `;
      assert.deepEqual(approvalRows, [
        {
          requestId: "approval-request-nonstale-existing",
          status: "pending",
          turnId: null,
          createdAt: "2026-02-26T12:45:02.000Z",
          resolvedAt: null,
        },
      ]);

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number;
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-nonstale-approval'
      `;
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 1 }]);
    }),
  );

  it.effect("does not fallback-retain messages whose turnId is removed by revert", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-revert-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-revert"),
        occurredAt: "2026-02-26T12:00:00.000Z",
        commandId: CommandId.make("cmd-revert-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-revert"),
          title: "Project Revert",
          workspaceRoot: "/tmp/project-revert",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:00:00.000Z",
          updatedAt: "2026-02-26T12:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-revert-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: CommandId.make("cmd-revert-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          projectId: ProjectId.make("project-revert"),
          title: "Thread Revert",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:00:01.000Z",
          updatedAt: "2026-02-26T12:00:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: CommandId.make("cmd-revert-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-keep"),
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: CommandId.make("cmd-revert-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("assistant-keep"),
          role: "assistant",
          text: "kept",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: CommandId.make("cmd-revert-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnId: TurnId.make("turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-remove"),
          completedAt: "2026-02-26T12:00:03.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-6"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.050Z",
        commandId: CommandId.make("cmd-revert-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-6"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("user-remove"),
          role: "user",
          text: "removed",
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.050Z",
          updatedAt: "2026-02-26T12:00:03.050Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-7"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.100Z",
        commandId: CommandId.make("cmd-revert-7"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-7"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("assistant-remove"),
          role: "assistant",
          text: "removed",
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.100Z",
          updatedAt: "2026-02-26T12:00:03.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.make("evt-revert-8"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:04.000Z",
        commandId: CommandId.make("cmd-revert-8"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-8"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnCount: 1,
        },
      });

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly role: string;
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          role
        FROM projection_thread_messages
        WHERE thread_id = 'thread-revert'
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        {
          messageId: "assistant-keep",
          turnId: "turn-1",
          role: "assistant",
        },
      ]);
    }),
  );
});

it.effect("restores pending turn-start metadata across projection pipeline restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );
    const secondProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );

    const threadId = ThreadId.make("thread-restart");
    const turnId = TurnId.make("turn-restart");
    const messageId = MessageId.make("message-restart");
    const sourcePlanThreadId = ThreadId.make("thread-plan-source");
    const sourcePlanId = "plan-source";
    const turnStartedAt = "2026-02-26T14:00:00.000Z";
    const sessionSetAt = "2026-02-26T14:00:05.000Z";

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.make("evt-restart-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: turnStartedAt,
        commandId: CommandId.make("cmd-restart-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-restart-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          sourceProposedPlan: {
            threadId: sourcePlanThreadId,
            planId: sourcePlanId,
          },
          runtimeMode: "approval-required",
          createdAt: turnStartedAt,
        },
      });

      yield* projectionPipeline.bootstrap;
    }).pipe(Effect.provide(firstProjectionLayer));

    const turnRows = yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-restart-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: sessionSetAt,
        commandId: CommandId.make("cmd-restart-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-restart-2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: sessionSetAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const pendingRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `;
      assert.deepEqual(pendingRows, []);

      return yield* sql<{
        readonly turnId: string;
        readonly userMessageId: string | null;
        readonly sourceProposedPlanThreadId: string | null;
        readonly sourceProposedPlanId: string | null;
        readonly requestedAt: string;
        readonly startedAt: string;
      }>`
	        SELECT
	          turn_id AS "turnId",
	          pending_message_id AS "userMessageId",
	          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
	          source_proposed_plan_id AS "sourceProposedPlanId",
	          requested_at AS "requestedAt",
	          started_at AS "startedAt"
	        FROM projection_turns
	        WHERE turn_id = ${turnId}
	      `;
    }).pipe(Effect.provide(secondProjectionLayer));

    assert.deepEqual(turnRows, [
      {
        turnId: "turn-restart",
        userMessageId: "message-restart",
        sourceProposedPlanThreadId: "thread-plan-source",
        sourceProposedPlanId: "plan-source",
        requestedAt: turnStartedAt,
        startedAt: sessionSetAt,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-projection-pipeline-restart-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-projection-pipeline-engine-dispatch-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("OrchestrationProjectionPipeline via engine dispatch", (it) => {
  it.effect("projects dispatched engine events immediately", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-live-project"),
        projectId: ProjectId.make("project-live"),
        title: "Live Project",
        workspaceRoot: "/tmp/project-live",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      const projectRows = yield* sql<{ readonly title: string; readonly scriptsJson: string }>`
        SELECT
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
        WHERE project_id = 'project-live'
      `;
      assert.deepEqual(projectRows, [{ title: "Live Project", scriptsJson: "[]" }]);

      const projectorRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.projects'
      `;
      assert.deepEqual(projectorRows, [{ lastAppliedSequence: 1 }]);
    }),
  );

  it.effect("projects persist updated scripts from project.meta.update", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-scripts-project-create"),
        projectId: ProjectId.make("project-scripts"),
        title: "Scripts Project",
        workspaceRoot: "/tmp/project-scripts",
        additionalWorkspaceRoots: ["/tmp/project-docs"],
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make("cmd-scripts-project-update"),
        projectId: ProjectId.make("project-scripts"),
        additionalWorkspaceRoots: ["/tmp/project-docs", "/tmp/project-tools"],
        scripts: [
          {
            id: "script-1",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        },
      });

      const projectRows = yield* sql<{
        readonly additionalWorkspaceRoots: string;
        readonly scriptsJson: string;
        readonly defaultModelSelection: string;
      }>`
        SELECT
          additional_workspace_roots_json AS "additionalWorkspaceRoots",
          scripts_json AS "scriptsJson",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-scripts'
      `;
      assert.deepEqual(projectRows, [
        {
          additionalWorkspaceRoots: '["/tmp/project-docs","/tmp/project-tools"]',
          scriptsJson:
            '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5"}',
        },
      ]);
    }),
  );
});
