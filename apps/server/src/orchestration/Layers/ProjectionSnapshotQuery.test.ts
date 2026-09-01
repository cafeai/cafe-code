import {
  CheckpointRef,
  EventId,
  MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { buildCodexSteerClientCorrelationId } from "../../provider/codexSteerCorrelation.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  OrchestrationProjectionSnapshotQueryLive,
  THREAD_DETAIL_ACTIVITY_LIMIT,
  THREAD_DETAIL_MESSAGE_LIMIT,
} from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);
const codexClientCorrelationId = `cafe-steer-v1:${"a".repeat(64)}`;

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      // This file shares one sqlite layer for speed, so clear every table this fixture repopulates.
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"yarn build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-1',
          '2026-02-24T00:00:04.000Z',
          1,
          0,
          0,
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          additionalWorkspaceRoots: [],
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "yarn build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.make("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-02-24T00:00:08.000Z",
          },
          goal: null,
        },
      ]);

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.snapshotSequence, 5);
      assert.deepEqual(shellSnapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          additionalWorkspaceRoots: [],
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "yarn build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
        },
      ]);
      assert.deepEqual(shellSnapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          deletedAt: null,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-02-24T00:00:08.000Z",
          },
          latestUserMessageAt: "2026-02-24T00:00:04.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      ]);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value, snapshot.threads[0]);
      }
    }),
  );

  it.effect("keeps archived threads out of the main shell snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-archive-test',
          'Archive Test',
          '/tmp/archive-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-active',
            'project-archive-test',
            'Active Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:02.000Z',
            '2026-04-06T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-archived',
            'project-archive-test',
            'Archived Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:04.000Z',
            '2026-04-06T00:00:05.000Z',
            '2026-04-06T00:00:06.000Z',
            NULL
          ),
          (
            'thread-deleted',
            'project-archive-test',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:07.000Z',
            '2026-04-06T00:00:08.000Z',
            NULL,
            '2026-04-06T00:00:09.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:10.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:10.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:10.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:10.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:10.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:10.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:10.000Z')
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-active")],
      );

      const archivedShellSnapshot = yield* snapshotQuery.getArchivedShellSnapshot();
      assert.deepEqual(
        archivedShellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-archived")],
      );
      assert.equal(archivedShellSnapshot.threads[0]?.archivedAt, "2026-04-06T00:00:06.000Z");

      const deletedShellSnapshot = yield* snapshotQuery.getDeletedShellSnapshot();
      assert.deepEqual(
        deletedShellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-deleted")],
      );
      assert.equal(deletedShellSnapshot.threads[0]?.deletedAt, "2026-04-06T00:00:09.000Z");
    }),
  );

  it.effect("filters duplicate Codex snapshot assistant item messages from thread snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_messages`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-codex-snapshot-dedupe',
          'Codex Snapshot Dedupe',
          '/tmp/codex-snapshot-dedupe',
          '{"instanceId":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-05-24T00:00:00.000Z',
          '2026-05-24T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-codex-snapshot-dedupe',
          'project-codex-snapshot-dedupe',
          'Codex Snapshot Dedupe Thread',
          '{"instanceId":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-codex-snapshot-dedupe',
          NULL,
          0,
          0,
          0,
          '2026-05-24T00:00:00.000Z',
          '2026-05-24T00:00:00.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'assistant:msg_live_1',
            'thread-codex-snapshot-dedupe',
            'turn-codex-snapshot-dedupe',
            'assistant',
            'duplicate assistant text',
            0,
            '2026-05-24T00:00:01.000Z',
            '2026-05-24T00:00:01.000Z'
          ),
          (
            'assistant:item-6768',
            'thread-codex-snapshot-dedupe',
            'turn-codex-snapshot-dedupe',
            'assistant',
            'duplicate assistant text',
            0,
            '2026-05-24T00:00:02.000Z',
            '2026-05-24T00:00:02.000Z'
          ),
          (
            'assistant:item-6769',
            'thread-codex-snapshot-dedupe',
            'turn-codex-snapshot-dedupe',
            'assistant',
            'snapshot-only assistant text',
            0,
            '2026-05-24T00:00:03.000Z',
            '2026-05-24T00:00:03.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const snapshotThread = snapshot.threads.find(
        (thread) => thread.id === ThreadId.make("thread-codex-snapshot-dedupe"),
      );
      assert.deepEqual(
        snapshotThread?.messages.map((message) => message.id),
        [asMessageId("assistant:msg_live_1"), asMessageId("assistant:item-6769")],
      );

      const detail = yield* snapshotQuery.getThreadDetailById(
        ThreadId.make("thread-codex-snapshot-dedupe"),
      );
      assert.equal(detail._tag, "Some");
      if (detail._tag === "Some") {
        assert.deepEqual(
          detail.value.messages.map((message) => message.id),
          [asMessageId("assistant:msg_live_1"), asMessageId("assistant:item-6769")],
        );
      }
    }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.make("thread-first"));
        }
      }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-incomplete',
            NULL,
            NULL,
            NULL,
            NULL,
            'running',
            '2026-03-02T00:00:06.000Z',
            '2026-03-02T00:00:06.000Z',
            NULL,
            3,
            'checkpoint-incomplete',
            'ready',
            '[]'
          )
      `;

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.make("thread-context"),
      );
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          threadId: ThreadId.make("thread-context"),
          projectId: asProjectId("project-context"),
          workspaceRoot: "/tmp/context-workspace",
          worktreePath: "/tmp/context-worktree",
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-a"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:04.000Z",
            },
            {
              turnId: asTurnId("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef("checkpoint-b"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:05.000Z",
            },
          ],
        });
      }

      const detail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-context"));
      assert.equal(detail._tag, "Some");
      if (detail._tag === "Some") {
        assert.deepEqual(
          detail.value.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount),
          [1, 2],
        );
      }
    }),
  );

  it.effect("keeps thread detail activity ordering consistent with shell snapshot ordering", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:02.000Z',
          '2026-04-01T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-unsequenced',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'unsequenced first',
            '{"source":"unsequenced"}',
            NULL,
            '2026-04-01T00:00:06.000Z'
          ),
          (
            'activity-sequence-2',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence two',
            '{"source":"sequence-2"}',
            2,
            '2026-04-01T00:00:04.000Z'
          ),
          (
            'activity-sequence-1',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence one',
            '{"source":"sequence-1"}',
            1,
            '2026-04-01T00:00:05.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));

      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value.activities, snapshot.threads[0]?.activities ?? []);
      }

      assert.deepEqual(snapshot.threads[0]?.activities ?? [], [
        {
          id: asEventId("activity-unsequenced"),
          tone: "info",
          kind: "runtime.note",
          summary: "unsequenced first",
          payload: { source: "unsequenced" },
          turnId: null,
          createdAt: "2026-04-01T00:00:06.000Z",
        },
        {
          id: asEventId("activity-sequence-1"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence one",
          payload: { source: "sequence-1" },
          turnId: null,
          sequence: 1,
          createdAt: "2026-04-01T00:00:05.000Z",
        },
        {
          id: asEventId("activity-sequence-2"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence two",
          payload: { source: "sequence-2" },
          turnId: null,
          sequence: 2,
          createdAt: "2026-04-01T00:00:04.000Z",
        },
      ]);
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for targeted thread latest turn queries", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-02T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-02T00:00:02.000Z',
          '2026-04-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-02T00:00:05.000Z',
            '2026-04-02T00:00:06.000Z',
            '2026-04-02T00:00:20.000Z',
            5,
            'checkpoint-5',
            'ready',
            '[]'
          ),
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-02T00:00:30.000Z',
            '2026-04-02T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.equal(threadShell.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadShell.value.latestTurn?.state, "running");
        assert.equal(threadShell.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.equal(threadDetail.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadDetail.value.latestTurn?.state, "running");
        assert.equal(threadDetail.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for bulk command and shell snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-03T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-03T00:00:02.000Z',
          '2026-04-03T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-03T00:00:30.000Z',
            '2026-04-03T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-03T00:00:05.000Z',
            '2026-04-03T00:00:06.000Z',
            '2026-04-03T00:00:20.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 3, '2026-04-03T00:00:40.000Z')
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "running");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.state, "running");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "running");
    }),
  );

  it.effect(
    "prefilters terminal Codex threads with legacy or trusted accepted-steer evidence",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM orchestration_events`;
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_thread_sessions`;
        yield* sql`DELETE FROM projection_turns`;
        yield* sql`DELETE FROM projection_threads`;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-stale-steer-candidate', 'project-stale-steer', 'Candidate',
            '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
            NULL, NULL, 'turn-stale-steer-candidate', '2026-07-14T00:00:11.000Z',
            0, 0, 0, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:11.000Z', NULL, NULL
          ),
          (
            'thread-message-before-completion', 'project-stale-steer', 'Before completion',
            '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
            NULL, NULL, 'turn-message-before-completion', '2026-07-14T00:00:09.000Z',
            0, 0, 0, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:10.000Z', NULL, NULL
          ),
          (
            'thread-claude-post-completion', 'project-stale-steer', 'Claude',
            '{"provider":"claudeAgent","model":"claude-sonnet-5"}', 'full-access', 'default',
            NULL, NULL, 'turn-claude-post-completion', '2026-07-14T00:00:11.000Z',
            0, 0, 0, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:11.000Z', NULL, NULL
          ),
          (
            'thread-running-post-message', 'project-stale-steer', 'Running',
            '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
            NULL, NULL, 'turn-running-post-message', '2026-07-14T00:00:11.000Z',
            0, 0, 0, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:11.000Z', NULL, NULL
          ),
          (
            'thread-archived-post-completion', 'project-stale-steer', 'Archived',
            '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
            NULL, NULL, 'turn-archived-post-completion', '2026-07-14T00:00:11.000Z',
            0, 0, 0, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:11.000Z',
            '2026-07-14T00:00:12.000Z', NULL
          )
      `;

        yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-stale-steer-candidate', 'turn-stale-steer-candidate', NULL, NULL,
            'completed', '2026-07-14T00:00:01.000Z', '2026-07-14T00:00:02.000Z',
            '2026-07-14T00:00:10.000Z', NULL, NULL, NULL, '[]'
          ),
          (
            'thread-message-before-completion', 'turn-message-before-completion', NULL, NULL,
            'completed', '2026-07-14T00:00:01.000Z', '2026-07-14T00:00:02.000Z',
            '2026-07-14T00:00:10.000Z', NULL, NULL, NULL, '[]'
          ),
          (
            'thread-claude-post-completion', 'turn-claude-post-completion', NULL, NULL,
            'completed', '2026-07-14T00:00:01.000Z', '2026-07-14T00:00:02.000Z',
            '2026-07-14T00:00:10.000Z', NULL, NULL, NULL, '[]'
          ),
          (
            'thread-running-post-message', 'turn-running-post-message', NULL, NULL,
            'running', '2026-07-14T00:00:01.000Z', '2026-07-14T00:00:02.000Z',
            NULL, NULL, NULL, NULL, '[]'
          ),
          (
            'thread-archived-post-completion', 'turn-archived-post-completion', NULL, NULL,
            'completed', '2026-07-14T00:00:01.000Z', '2026-07-14T00:00:02.000Z',
            '2026-07-14T00:00:10.000Z', NULL, NULL, NULL, '[]'
          )
      `;

        yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES
          ('thread-stale-steer-candidate', 'ready', 'codex', 'codex', 'full-access', NULL, NULL, '2026-07-14T00:00:10.000Z'),
          ('thread-message-before-completion', 'ready', 'codex', 'codex', 'full-access', NULL, NULL, '2026-07-14T00:00:10.000Z'),
          ('thread-claude-post-completion', 'ready', 'claudeAgent', 'claude', 'full-access', NULL, NULL, '2026-07-14T00:00:10.000Z'),
          ('thread-running-post-message', 'running', 'codex', 'codex', 'full-access', 'turn-running-post-message', NULL, '2026-07-14T00:00:10.000Z'),
          ('thread-archived-post-completion', 'ready', 'codex', 'codex', 'full-access', NULL, NULL, '2026-07-14T00:00:10.000Z')
      `;

        yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          ('message-stale-steer-candidate', 'thread-stale-steer-candidate', 'turn-stale-steer-candidate', 'user', 'candidate', 0, '2026-07-14T00:00:11.000Z', '2026-07-14T00:00:11.000Z'),
          ('message-before-completion', 'thread-message-before-completion', 'turn-message-before-completion', 'user', 'before', 0, '2026-07-14T00:00:09.000Z', '2026-07-14T00:00:09.000Z'),
          ('message-claude-post-completion', 'thread-claude-post-completion', 'turn-claude-post-completion', 'user', 'claude', 0, '2026-07-14T00:00:11.000Z', '2026-07-14T00:00:11.000Z'),
          ('message-running-post', 'thread-running-post-message', 'turn-running-post-message', 'user', 'running', 0, '2026-07-14T00:00:11.000Z', '2026-07-14T00:00:11.000Z'),
          ('message-archived-post-completion', 'thread-archived-post-completion', 'turn-archived-post-completion', 'user', 'archived', 0, '2026-07-14T00:00:11.000Z', '2026-07-14T00:00:11.000Z')
      `;

        const shellDerivedLegacyCandidates = [ThreadId.make("thread-stale-steer-candidate")];
        assert.deepStrictEqual(
          yield* snapshotQuery.getPostTerminalStaleSteerCandidateThreadIds(
            undefined,
            shellDerivedLegacyCandidates,
          ),
          shellDerivedLegacyCandidates,
        );

        const beforeCompletionCorrelationId = buildCodexSteerClientCorrelationId(
          MessageId.make("message-before-completion"),
        );
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES (
            'intent-before-completion', 'thread', 'thread-message-before-completion', 100,
            'thread.turn-steer-requested', '2026-07-14T00:00:09.400Z',
            'client:intent-before-completion', NULL, NULL, 'client',
            ${JSON.stringify({
              threadId: "thread-message-before-completion",
              messageId: "message-before-completion",
              expectedTurnId: "turn-message-before-completion",
              createdAt: "2026-07-14T00:00:09.400Z",
            })}, '{}'
          )
        `;
        const [beforeCompletionIntent] = yield* sql<{ readonly sequence: number }>`
          SELECT sequence FROM orchestration_events
          WHERE event_id = 'intent-before-completion'
        `;
        assert.isDefined(beforeCompletionIntent);
        const beforeCompletionAcceptedPayload = {
          provider: "codex",
          messageId: "message-before-completion",
          acceptedTurnId: "turn-message-before-completion",
          intentSequence: beforeCompletionIntent!.sequence,
          clientCorrelationId: beforeCompletionCorrelationId,
        };
        const beforeCompletionProcessingPayload = {
          taskId: `codex-turn-steer-processing:${beforeCompletionCorrelationId}`,
          usage: {
            messageId: "message-before-completion",
            clientCorrelationId: beforeCompletionCorrelationId,
          },
        };
        // A replayed provider observation can carry a timestamp newer than a
        // subsequently persisted candidate. Sequence, not wall-clock order,
        // is the authoritative generation boundary: this older source event
        // must not settle the acceptance inserted below.
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES (
          'historical-processed-steer-before-completion',
          'thread-message-before-completion',
          'turn-message-before-completion',
          'info',
          'task.progress',
          'Reasoning update',
          ${JSON.stringify(beforeCompletionProcessingPayload)},
          NULL,
          '2026-07-14T00:00:09.250Z'
        )
      `;
        yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'event-historical-processed-steer-before-completion',
          'thread',
          'thread-message-before-completion',
          0,
          'thread.activity-appended',
          '2026-07-14T00:00:09.250Z',
          'provider:codex:thread-message-before-completion:historical-processed-steer-before-completion:thread-activity-append:historical-processed-steer-before-completion',
          NULL,
          NULL,
          'provider',
          ${JSON.stringify({
            threadId: "thread-message-before-completion",
            activity: {
              id: "historical-processed-steer-before-completion",
              tone: "info",
              kind: "task.progress",
              summary: "Reasoning update",
              payload: beforeCompletionProcessingPayload,
              turnId: "turn-message-before-completion",
              createdAt: "2026-07-14T00:00:09.250Z",
            },
          })},
          '{}'
        )
      `;
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES (
          'accepted-steer-before-completion',
          'thread-message-before-completion',
          'turn-message-before-completion',
          'info',
          'provider.turn.steer.accepted',
          'Steer accepted',
          ${JSON.stringify(beforeCompletionAcceptedPayload)},
          NULL,
          '2026-07-14T00:00:09.500Z'
        )
      `;
        const beforeCompletionAcceptedEventPayload = {
          threadId: "thread-message-before-completion",
          activity: {
            id: "accepted-steer-before-completion",
            tone: "info",
            kind: "provider.turn.steer.accepted",
            summary: "Steer accepted",
            payload: beforeCompletionAcceptedPayload,
            turnId: "turn-message-before-completion",
            createdAt: "2026-07-14T00:00:09.500Z",
          },
        };
        yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'event-accepted-steer-before-completion',
          'thread',
          'thread-message-before-completion',
          1,
          'thread.activity-appended',
          '2026-07-14T00:00:09.500Z',
          'server:codex-steer-accepted:thread-message-before-completion:turn-message-before-completion:message-before-completion',
          NULL,
          'server:codex-steer-accepted:thread-message-before-completion:turn-message-before-completion:message-before-completion',
          'server',
          ${JSON.stringify(beforeCompletionAcceptedEventPayload)},
          '{}'
        )
      `;
        assert.deepStrictEqual(
          yield* snapshotQuery.getPostTerminalStaleSteerCandidateThreadIds(
            undefined,
            shellDerivedLegacyCandidates,
          ),
          [
            ThreadId.make("thread-message-before-completion"),
            ThreadId.make("thread-stale-steer-candidate"),
          ],
        );

        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES (
          'processed-steer-before-completion',
          'thread-message-before-completion',
          'turn-message-before-completion',
          'info',
          'task.progress',
          'Reasoning update',
          ${JSON.stringify(beforeCompletionProcessingPayload)},
          NULL,
          '2026-07-14T00:00:09.800Z'
        )
      `;
        yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'event-processed-steer-before-completion',
          'thread',
          'thread-message-before-completion',
          2,
          'thread.activity-appended',
          '2026-07-14T00:00:09.800Z',
          'provider:codex:thread-message-before-completion:processed-steer-before-completion:thread-activity-append:processed-steer-before-completion',
          NULL,
          NULL,
          'provider',
          ${JSON.stringify({
            threadId: "thread-message-before-completion",
            activity: {
              id: "processed-steer-before-completion",
              tone: "info",
              kind: "task.progress",
              summary: "Reasoning update",
              payload: beforeCompletionProcessingPayload,
              turnId: "turn-message-before-completion",
              createdAt: "2026-07-14T00:00:09.800Z",
            },
          })},
          '{}'
        )
      `;
        assert.deepStrictEqual(
          yield* snapshotQuery.getPostTerminalStaleSteerCandidateThreadIds(
            undefined,
            shellDerivedLegacyCandidates,
          ),
          shellDerivedLegacyCandidates,
        );
        const [prunedCanonicalProcessingCandidate] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM orchestration_pending_codex_steer_acceptances
          WHERE message_id = 'message-before-completion'
        `;
        assert.equal(prunedCanonicalProcessingCandidate?.count, 0);
      }),
  );

  it.effect(
    "reads unbounded exact Codex steer evidence across retargeting, newer turns, and interrupts",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM orchestration_events`;
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_thread_sessions`;
        yield* sql`DELETE FROM projection_turns`;
        yield* sql`DELETE FROM projection_threads`;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-historical-steer',
          'project-stale-steer',
          'Historical steer',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-newer-latest',
          '2026-08-30T12:10:00.000Z',
          0,
          0,
          0,
          '2026-08-30T12:00:00.000Z',
          '2026-08-30T12:10:00.000Z',
          NULL,
          NULL
        )
      `;

        // Accepted receipts bind to the authenticated request generation.
        // Processing may arrive before the provider ACK, so recovery compares
        // its durable event and provider timestamp with this intent, not with
        // the later accepted activity.
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES
            (
              'intent-retargeted-acceptance', 'thread', 'thread-historical-steer', 100,
              'thread.turn-steer-requested', '2026-08-30T12:00:03.000Z',
              'client:intent-retargeted-acceptance', NULL, NULL, 'client',
              ${JSON.stringify({
                threadId: "thread-historical-steer",
                messageId: "message-retargeted",
                expectedTurnId: "turn-retargeted-acceptance",
                createdAt: "2026-08-30T12:00:03.000Z",
              })}, '{}'
            ),
            (
              'intent-processed-acceptance', 'thread', 'thread-historical-steer', 101,
              'thread.turn-steer-requested', '2026-08-30T12:01:03.000Z',
              'client:intent-processed-acceptance', NULL, NULL, 'client',
              ${JSON.stringify({
                threadId: "thread-historical-steer",
                messageId: "message-processed",
                expectedTurnId: "turn-processed-acceptance",
                createdAt: "2026-08-30T12:01:03.000Z",
              })}, '{}'
            )
        `;
        const [retargetedIntent] = yield* sql<{ readonly sequence: number }>`
          SELECT sequence FROM orchestration_events
          WHERE event_id = 'intent-retargeted-acceptance'
        `;
        const [processedIntent] = yield* sql<{ readonly sequence: number }>`
          SELECT sequence FROM orchestration_events
          WHERE event_id = 'intent-processed-acceptance'
        `;
        assert.isDefined(retargetedIntent);
        assert.isDefined(processedIntent);
        // Provider progress may be durably ingested before the steer ACK. It
        // remains valid because it is newer than the authenticated intent in
        // both journal sequence and provider timestamp.
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES (
            'event-processing-exact', 'thread', 'thread-historical-steer', 102,
            'thread.activity-appended', '2026-08-30T12:01:03.050Z',
            'provider:codex:thread-historical-steer:processing-exact:thread-activity-append:processing-exact',
            NULL, NULL, 'provider',
            '{"threadId":"thread-historical-steer","activity":{"id":"processing-exact","tone":"info","kind":"task.progress","summary":"Reasoning update","payload":{"taskId":"codex-turn-steer-processing:message-processed","usage":{"messageId":"message-processed"}},"turnId":"turn-processed-acceptance","createdAt":"2026-08-30T12:01:03.050Z"}}',
            '{}'
          )
        `;

        yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-historical-steer', 'turn-retargeted-acceptance', NULL, NULL,
            'interrupted', '2026-08-30T12:00:01.000Z', '2026-08-30T12:00:02.000Z',
            '2026-08-30T12:00:05.000Z', NULL, NULL, NULL, '[]'
          ),
          (
            'thread-historical-steer', 'turn-processed-acceptance', NULL, NULL,
            'completed', '2026-08-30T12:01:01.000Z', '2026-08-30T12:01:02.000Z',
            '2026-08-30T12:01:05.000Z', NULL, NULL, NULL, '[]'
          ),
          (
            'thread-historical-steer', 'turn-newer-latest', NULL, NULL,
            'running', '2026-08-30T12:10:00.000Z', '2026-08-30T12:10:01.000Z',
            NULL, NULL, NULL, NULL, '[]'
          )
      `;

        yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-historical-steer',
          'running',
          'codex',
          'codex',
          'full-access',
          'turn-newer-latest',
          NULL,
          '2026-08-30T12:10:01.000Z'
        )
      `;

        // The first message was retargeted to the newer turn after its
        // acceptance. Evidence identity remains the accepted activity's
        // thread + message id, not the mutable message turn assignment.
        yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-retargeted', 'thread-historical-steer', 'turn-newer-latest', 'user',
            'retargeted private prompt',
            '[{"type":"image","id":"attachment-retargeted","name":"retargeted.png","mimeType":"image/png","sizeBytes":1}]',
            0, '2026-08-30T12:00:03.000Z', '2026-08-30T12:10:00.000Z'
          ),
          (
            'message-processed', 'thread-historical-steer', 'turn-processed-acceptance', 'user',
            'already processed prompt', NULL,
            0, '2026-08-30T12:01:03.000Z', '2026-08-30T12:01:03.000Z'
          ),
          (
            'message-forged', 'thread-historical-steer', 'turn-retargeted-acceptance', 'user',
            'forged provider acceptance', NULL,
            0, '2026-08-30T12:00:03.500Z', '2026-08-30T12:00:03.500Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'accepted-retargeted', 'thread-historical-steer', 'turn-retargeted-acceptance',
            'info', 'provider.turn.steer.accepted', 'Steer accepted',
            ${JSON.stringify({
              provider: "codex",
              messageId: "message-retargeted",
              acceptedTurnId: "turn-retargeted-acceptance",
              intentSequence: retargetedIntent!.sequence,
              clientCorrelationId: codexClientCorrelationId,
            })},
            1, '2026-08-30T12:00:03.100Z'
          ),
          (
            'accepted-processed', 'thread-historical-steer', 'turn-processed-acceptance',
            'info', 'provider.turn.steer.accepted', 'Steer accepted',
            ${JSON.stringify({
              provider: "codex",
              messageId: "message-processed",
              acceptedTurnId: "turn-processed-acceptance",
              intentSequence: processedIntent!.sequence,
            })},
            2, '2026-08-30T12:01:03.100Z'
          ),
          (
            'accepted-forged', 'thread-historical-steer', 'turn-retargeted-acceptance',
            'info', 'provider.turn.steer.accepted', 'Steer accepted',
            '{"provider":"codex","messageId":"message-forged","acceptedTurnId":"turn-retargeted-acceptance"}',
            3, '2026-08-30T12:00:03.600Z'
          ),
          (
            'processing-wrong-usage', 'thread-historical-steer', 'turn-retargeted-acceptance',
            'info', 'task.progress', 'Reasoning update',
            ${JSON.stringify({
              taskId: `codex-turn-steer-processing:${codexClientCorrelationId}`,
              usage: {
                messageId: "another-message",
                clientCorrelationId: codexClientCorrelationId,
              },
            })},
            4, '2026-08-30T12:00:04.000Z'
          ),
          (
            'processing-wrong-turn', 'thread-historical-steer', 'turn-newer-latest',
            'info', 'task.progress', 'Reasoning update',
            ${JSON.stringify({
              taskId: `codex-turn-steer-processing:${codexClientCorrelationId}`,
              usage: {
                messageId: "message-retargeted",
                clientCorrelationId: codexClientCorrelationId,
              },
            })},
            5, '2026-08-30T12:10:02.000Z'
          ),
          (
            'processing-wrong-token', 'thread-historical-steer', 'turn-retargeted-acceptance',
            'info', 'task.progress', 'Reasoning update',
            ${JSON.stringify({
              taskId: `codex-turn-steer-processing:cafe-steer-v1:${"b".repeat(64)}`,
              usage: {
                messageId: "message-retargeted",
                clientCorrelationId: `cafe-steer-v1:${"b".repeat(64)}`,
              },
            })},
            7, '2026-08-30T12:00:04.100Z'
          ),
          (
            'processing-exact', 'thread-historical-steer', 'turn-processed-acceptance',
            'info', 'task.progress', 'Reasoning update',
            '{"taskId":"codex-turn-steer-processing:message-processed","usage":{"messageId":"message-processed"}}',
            6, '2026-08-30T12:01:03.050Z'
          )
      `;

        // Push both accepted rows far outside the bounded detail activity tail.
        yield* sql`
        WITH RECURSIVE activity_counter(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM activity_counter WHERE value < 650
        )
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        SELECT
          'later-noise-' || value,
          'thread-historical-steer',
          'turn-newer-latest',
          'info',
          'tool.updated',
          'Later bounded-history noise',
          '{}',
          1000 + value,
          '2026-08-30T12:20:00.000Z'
        FROM activity_counter
      `;

        yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'event-accepted-retargeted', 'thread', 'thread-historical-steer', 0,
            'thread.activity-appended', '2026-08-30T12:00:03.100Z',
            'server:accepted-retargeted', NULL, 'server:accepted-retargeted', 'server',
            ${JSON.stringify({
              threadId: "thread-historical-steer",
              activity: {
                id: "accepted-retargeted",
                tone: "info",
                kind: "provider.turn.steer.accepted",
                summary: "Steer accepted",
                payload: {
                  provider: "codex",
                  messageId: "message-retargeted",
                  acceptedTurnId: "turn-retargeted-acceptance",
                  intentSequence: retargetedIntent!.sequence,
                  clientCorrelationId: codexClientCorrelationId,
                },
                turnId: "turn-retargeted-acceptance",
                createdAt: "2026-08-30T12:00:03.100Z",
              },
            })},
            '{}'
          ),
          (
            'event-accepted-processed', 'thread', 'thread-historical-steer', 1,
            'thread.activity-appended', '2026-08-30T12:01:03.100Z',
            'server:accepted-processed', NULL, 'server:accepted-processed', 'server',
            ${JSON.stringify({
              threadId: "thread-historical-steer",
              activity: {
                id: "accepted-processed",
                tone: "info",
                kind: "provider.turn.steer.accepted",
                summary: "Steer accepted",
                payload: {
                  provider: "codex",
                  messageId: "message-processed",
                  acceptedTurnId: "turn-processed-acceptance",
                  intentSequence: processedIntent!.sequence,
                },
                turnId: "turn-processed-acceptance",
                createdAt: "2026-08-30T12:01:03.100Z",
              },
            })},
            '{}'
          ),
          (
            'event-accepted-forged', 'thread', 'thread-historical-steer', 2,
            'thread.activity-appended', '2026-08-30T12:00:03.600Z',
            'provider:accepted-forged', NULL, 'provider:accepted-forged', 'provider',
            '{"threadId":"thread-historical-steer","activity":{"id":"accepted-forged","tone":"info","kind":"provider.turn.steer.accepted","summary":"Steer accepted","payload":{"provider":"codex","messageId":"message-forged","acceptedTurnId":"turn-retargeted-acceptance"},"turnId":"turn-retargeted-acceptance","createdAt":"2026-08-30T12:00:03.600Z"}}',
            '{}'
          ),
          (
            'event-exact-manual-interrupt', 'thread', 'thread-historical-steer', 3,
            'thread.turn-interrupt-requested', '2026-08-30T12:00:04.500Z',
            'client:manual-stop', NULL, 'client:manual-stop', 'client',
            '{"threadId":"thread-historical-steer","turnId":"turn-retargeted-acceptance","createdAt":"2026-08-30T12:00:04.500Z"}',
            '{}'
          ),
          (
            'event-wrong-turn-interrupt', 'thread', 'thread-historical-steer', 4,
            'thread.turn-interrupt-requested', '2026-08-30T12:10:03.000Z',
            'client:wrong-turn-stop', NULL, 'client:wrong-turn-stop', 'client',
            '{"threadId":"thread-historical-steer","turnId":"turn-newer-latest","createdAt":"2026-08-30T12:10:03.000Z"}',
            '{}'
          ),
          (
            'event-forged-session-stop', 'thread', 'thread-historical-steer', 50000,
            'thread.session-stop-requested', '2026-08-30T12:00:04.750Z',
            'provider:forged-session-stop', NULL, 'provider:forged-session-stop', 'provider',
            '{"threadId":"thread-historical-steer","createdAt":"2026-08-30T12:00:04.750Z"}',
            '{}'
          ),
          (
            'event-exact-session-stop', 'thread', 'thread-historical-steer', 50001,
            'thread.session-stop-requested', '2026-08-30T12:00:05.000Z',
            'client:session-stop', NULL, 'client:session-stop', 'client',
            '{"threadId":"thread-historical-steer","createdAt":"2026-08-30T12:00:05.000Z"}',
            '{}'
          )
      `;

        const evidence = yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
          threadId: ThreadId.make("thread-historical-steer"),
        });
        assert.equal(evidence.length, 2);
        const retargetedEvidence = evidence[0];
        const processedEvidence = evidence[1];
        assert.ok(retargetedEvidence);
        assert.ok(processedEvidence);
        assert.deepStrictEqual(retargetedEvidence, {
          threadId: ThreadId.make("thread-historical-steer"),
          acceptedTurnId: TurnId.make("turn-retargeted-acceptance"),
          intentSequence: retargetedIntent.sequence,
          clientCorrelationId: codexClientCorrelationId,
          messageId: MessageId.make("message-retargeted"),
          messageTurnId: TurnId.make("turn-newer-latest"),
          messageText: "retargeted private prompt",
          messageAttachments: [
            {
              type: "image",
              id: "attachment-retargeted",
              name: "retargeted.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
          acceptedAt: "2026-08-30T12:00:03.100Z",
          turnState: "interrupted",
          turnCompletedAt: "2026-08-30T12:00:05.000Z",
          processingObserved: false,
          recoveryObserved: false,
          interruptRequested: true,
          sessionStopRequested: true,
        });
        assert.deepStrictEqual(processedEvidence, {
          threadId: ThreadId.make("thread-historical-steer"),
          acceptedTurnId: TurnId.make("turn-processed-acceptance"),
          intentSequence: processedIntent.sequence,
          clientCorrelationId: null,
          messageId: MessageId.make("message-processed"),
          messageTurnId: TurnId.make("turn-processed-acceptance"),
          messageText: "already processed prompt",
          messageAttachments: [],
          acceptedAt: "2026-08-30T12:01:03.100Z",
          turnState: "completed",
          turnCompletedAt: "2026-08-30T12:01:05.000Z",
          processingObserved: true,
          recoveryObserved: false,
          interruptRequested: false,
          sessionStopRequested: true,
        });

        // Exact optional filters do not broaden to another message or turn.
        assert.deepStrictEqual(
          yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
            threadId: ThreadId.make("thread-historical-steer"),
            acceptedTurnId: TurnId.make("turn-retargeted-acceptance"),
            messageId: MessageId.make("message-retargeted"),
          }),
          [retargetedEvidence],
        );
        assert.deepStrictEqual(
          yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
            threadId: ThreadId.make("thread-historical-steer"),
            acceptedTurnId: TurnId.make("turn-retargeted-acceptance"),
            messageId: MessageId.make("message-processed"),
          }),
          [],
        );

        // The candidate scan includes historical terminal evidence even when
        // a newer turn is latest/running. Manual interrupt remains a candidate
        // fact so startup can move it to the retryable queue instead of replay.
        assert.deepStrictEqual(yield* snapshotQuery.getPostTerminalStaleSteerCandidateThreadIds(), [
          ThreadId.make("thread-historical-steer"),
        ]);
        const exactCandidates = yield* snapshotQuery.getPostTerminalStaleSteerCandidates();
        const [legacyNullCorrelationPending] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM orchestration_pending_codex_steer_acceptances
          WHERE message_id = 'message-processed'
        `;
        // Historical null-correlation processing may suppress duplicate I/O,
        // but it is not cryptographically bound strongly enough to destroy
        // Cafe's only durable accepted-recovery candidate.
        assert.equal(legacyNullCorrelationPending?.count, 1);
        const exactAcceptedCandidate = exactCandidates.find(
          (candidate) => candidate._tag === "accepted",
        );
        assert.ok(exactAcceptedCandidate);
        assert.equal(exactAcceptedCandidate.threadId, "thread-historical-steer");
        assert.equal(exactAcceptedCandidate.activityId, "accepted-retargeted");
        assert.equal(exactAcceptedCandidate.acceptedTurnId, "turn-retargeted-acceptance");
        assert.equal(exactAcceptedCandidate.messageId, "message-retargeted");
        assert.equal(exactAcceptedCandidate.clientCorrelationId, codexClientCorrelationId);
        assert.equal(exactAcceptedCandidate.acceptedAt, "2026-08-30T12:00:03.100Z");
        assert.deepStrictEqual(
          yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
            exactAcceptedBarrier: exactAcceptedCandidate,
          }),
          [retargetedEvidence],
        );
        assert.deepStrictEqual(
          yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
            exactAcceptedBarrier: {
              ...exactAcceptedCandidate,
              // The event sequence is part of the authenticated compact
              // identity. A mismatched source event must fail closed instead
              // of broadening to another acceptance in this long thread.
              eventSequence: exactAcceptedCandidate.eventSequence + 1,
            },
          }),
          [],
        );

        const recoveredPayload = {
          provider: "codex",
          messageId: "message-retargeted",
          acceptedTurnId: "turn-retargeted-acceptance",
          recoveredTurnId: "turn-newer-latest",
          intentSequence: retargetedIntent.sequence,
          clientCorrelationId: codexClientCorrelationId,
        };
        const recoveredEventPayload = {
          threadId: "thread-historical-steer",
          activity: {
            id: "recovered-retargeted",
            tone: "info",
            kind: "provider.turn.steer.recovered",
            summary: "Steer recovered",
            payload: recoveredPayload,
            turnId: "turn-newer-latest",
            createdAt: "2026-08-30T12:11:00.000Z",
          },
        };
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES (
          'recovered-retargeted', 'thread-historical-steer', 'turn-newer-latest',
          'info', 'provider.turn.steer.recovered', 'Steer recovered',
          ${JSON.stringify(recoveredPayload)}, 1998, '2026-08-30T12:11:00.000Z'
        )
      `;
        yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-forged-recovered-retargeted', 'thread', 'thread-historical-steer', 5,
          'thread.activity-appended', '2026-08-30T12:11:00.000Z',
          'provider:forged-recovered', NULL, 'provider:forged-recovered', 'provider',
          ${JSON.stringify(recoveredEventPayload)}, '{}'
        )
      `;

        // A provider-authored lookalike cannot suppress recovery or become a
        // durable second-restart receipt.
        const forgedRecoveryEvidence = yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
          threadId: ThreadId.make("thread-historical-steer"),
          acceptedTurnId: TurnId.make("turn-retargeted-acceptance"),
          messageId: MessageId.make("message-retargeted"),
        });
        assert.equal(forgedRecoveryEvidence[0]?.recoveryObserved, false);
        assert.deepStrictEqual(yield* snapshotQuery.getPostTerminalStaleSteerCandidateThreadIds(), [
          ThreadId.make("thread-historical-steer"),
        ]);

        const delayedOldRecoveredPayload = {
          ...recoveredPayload,
          // This receipt belongs to another intent generation. Persisting it
          // after the newer acceptance must not let journal order alone settle
          // the newer compact candidate.
          intentSequence: processedIntent.sequence,
        };
        const delayedOldRecoveredEventPayload = {
          threadId: "thread-historical-steer",
          activity: {
            ...recoveredEventPayload.activity,
            id: "recovered-retargeted-old-generation",
            payload: delayedOldRecoveredPayload,
          },
        };
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          )
          VALUES (
            'recovered-retargeted-old-generation', 'thread-historical-steer',
            'turn-newer-latest', 'info', 'provider.turn.steer.recovered', 'Steer recovered',
            ${JSON.stringify(delayedOldRecoveredPayload)}, 1997, '2026-08-30T12:11:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          )
          VALUES (
            'event-delayed-old-recovered-retargeted', 'thread', 'thread-historical-steer', 6,
            'thread.activity-appended', '2026-08-30T12:11:00.000Z',
            'server:delayed-old-recovered', NULL, 'server:delayed-old-recovered', 'server',
            ${JSON.stringify(delayedOldRecoveredEventPayload)}, '{}'
          )
        `;
        // Simulate a compact barrier written by an older generation. The
        // post-terminal lookup must bind it to the accepted intent sequence;
        // otherwise this later journal row would erase the newer authority.
        yield* sql`
          INSERT INTO orchestration_codex_steer_recovery_barriers (
            sequence, thread_id, message_id, candidate_sequence, barrier_kind,
            activity_id, turn_id, accepted_turn_id, client_correlation_id,
            activity_created_at
          )
          SELECT
            sequence, 'thread-historical-steer', 'message-retargeted',
            ${processedIntent.sequence}, 'provider.turn.steer.recovered',
            'recovered-retargeted-old-generation', 'turn-newer-latest',
            'turn-retargeted-acceptance', ${codexClientCorrelationId},
            '2026-08-30T12:11:00.000Z'
          FROM orchestration_events
          WHERE event_id = 'event-delayed-old-recovered-retargeted'
        `;
        const delayedOldRecoveryEvidence = yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
          threadId: ThreadId.make("thread-historical-steer"),
          acceptedTurnId: TurnId.make("turn-retargeted-acceptance"),
          messageId: MessageId.make("message-retargeted"),
        });
        assert.equal(delayedOldRecoveryEvidence[0]?.recoveryObserved, false);
        assert.deepStrictEqual(yield* snapshotQuery.getPostTerminalStaleSteerCandidateThreadIds(), [
          ThreadId.make("thread-historical-steer"),
        ]);

        yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-trusted-recovered-retargeted', 'thread', 'thread-historical-steer', 7,
          'thread.activity-appended', '2026-08-30T12:11:00.000Z',
          'server:recovered-retargeted', NULL, 'server:trusted-recovered', 'server',
          ${JSON.stringify(recoveredEventPayload)}, '{}'
        )
      `;
        const trustedRecoveryEvidence = yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
          threadId: ThreadId.make("thread-historical-steer"),
          acceptedTurnId: TurnId.make("turn-retargeted-acceptance"),
          messageId: MessageId.make("message-retargeted"),
        });
        assert.equal(trustedRecoveryEvidence[0]?.recoveryObserved, true);
        const exactTrustedRecoveryEvidence = yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
          exactAcceptedBarrier: exactAcceptedCandidate,
        });
        assert.equal(exactTrustedRecoveryEvidence[0]?.recoveryObserved, true);
        assert.equal(exactTrustedRecoveryEvidence[0]?.interruptRequested, true);
        assert.equal(exactTrustedRecoveryEvidence[0]?.sessionStopRequested, true);
        assert.deepStrictEqual(
          yield* snapshotQuery.getPostTerminalStaleSteerCandidateThreadIds(),
          [],
        );

        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES (
          'processing-retargeted-exact',
          'thread-historical-steer',
          'turn-retargeted-acceptance',
          'info',
          'task.progress',
          'Reasoning update',
          ${JSON.stringify({
            taskId: `codex-turn-steer-processing:${codexClientCorrelationId}`,
            // Restart-time provider observations deliberately carry only the
            // fixed opaque token. The trusted acceptance maps it back to the
            // original message without persisting or echoing prompt content.
            usage: { clientCorrelationId: codexClientCorrelationId },
          })},
          2000,
          '2026-08-30T12:00:04.250Z'
        )
      `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES (
            'event-processing-retargeted-exact', 'thread', 'thread-historical-steer', 200,
            'thread.activity-appended', '2026-08-30T12:00:04.250Z',
            'provider:codex:thread-historical-steer:processing-retargeted-exact:thread-activity-append:processing-retargeted-exact',
            NULL, NULL, 'provider',
            ${JSON.stringify({
              threadId: "thread-historical-steer",
              activity: {
                id: "processing-retargeted-exact",
                tone: "info",
                kind: "task.progress",
                summary: "Reasoning update",
                payload: {
                  taskId: `codex-turn-steer-processing:${codexClientCorrelationId}`,
                  usage: { clientCorrelationId: codexClientCorrelationId },
                },
                turnId: "turn-retargeted-acceptance",
                createdAt: "2026-08-30T12:00:04.250Z",
              },
            })}, '{}'
          )
        `;
        assert.deepStrictEqual(
          yield* snapshotQuery.getPostTerminalStaleSteerCandidateThreadIds(),
          [],
        );
        const processedRetargeted = yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
          threadId: ThreadId.make("thread-historical-steer"),
          acceptedTurnId: TurnId.make("turn-retargeted-acceptance"),
          messageId: MessageId.make("message-retargeted"),
        });
        assert.equal(processedRetargeted[0]?.processingObserved, true);
        assert.equal(processedRetargeted[0]?.interruptRequested, true);
        const exactProcessedRetargeted = yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
          exactAcceptedBarrier: exactAcceptedCandidate,
        });
        assert.equal(exactProcessedRetargeted[0]?.processingObserved, true);
      }),
  );

  it.effect(
    "keeps live and terminal exact Codex steer evidence bounded across a delayed-ACK Stop race",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM orchestration_events`;
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_thread_sessions`;
        yield* sql`DELETE FROM projection_turns`;
        yield* sql`DELETE FROM projection_threads`;

        const threadId = ThreadId.make("thread-live-exact-steer-mature");
        const turnId = TurnId.make("turn-live-exact-steer-mature");
        const messageId = MessageId.make("message-live-exact-steer-mature");
        const activityId = "accepted-live-exact-steer-mature";
        const intentCreatedAt = "2026-08-31T23:00:00.000Z";
        const interruptedAt = "2026-08-31T23:00:01.000Z";
        const sessionStoppedAt = "2026-08-31T23:00:01.500Z";
        const acceptedAt = "2026-08-31T23:00:02.000Z";
        const clientCorrelationId = buildCodexSteerClientCorrelationId(messageId);

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
            branch, worktree_path, latest_turn_id, latest_user_message_at,
            pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
            created_at, updated_at, archived_at, deleted_at
          ) VALUES (
            ${threadId}, 'project-stale-steer', 'Live exact steer',
            '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
            NULL, NULL, ${turnId}, ${intentCreatedAt}, 0, 0, 0,
            ${intentCreatedAt}, ${intentCreatedAt}, NULL, NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id, state,
            requested_at, started_at, completed_at, checkpoint_turn_count,
            checkpoint_ref, checkpoint_status, checkpoint_files_json
          ) VALUES (
            ${threadId}, ${turnId}, NULL, NULL, 'running',
            ${intentCreatedAt}, ${intentCreatedAt}, NULL,
            NULL, NULL, NULL, '[]'
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, attachments_json,
            is_streaming, created_at, updated_at
          ) VALUES (
            ${messageId}, ${threadId}, ${turnId}, 'user', 'private mature prompt', NULL,
            0, ${intentCreatedAt}, ${intentCreatedAt}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json,
            metadata_json
          ) VALUES (
            'intent-live-exact-steer-mature', 'thread', ${threadId}, 0,
            'thread.turn-steer-requested', ${intentCreatedAt},
            'client:intent-live-exact-steer-mature',
            NULL, NULL, 'client', ${JSON.stringify({
              threadId,
              messageId,
              expectedTurnId: turnId,
              createdAt: intentCreatedAt,
            })}, '{}'
          )
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json,
            metadata_json
          ) VALUES (
            'session-stop-before-live-exact-steer-ack', 'thread', ${threadId}, 2,
            'thread.session-stop-requested', ${sessionStoppedAt},
            'client:session-stop-before-live-exact-steer-ack', NULL, NULL, 'client',
            ${JSON.stringify({ threadId, createdAt: sessionStoppedAt })}, '{}'
          )
        `;
        const [intent] = yield* sql<{ readonly sequence: number }>`
          SELECT sequence
          FROM orchestration_events
          WHERE event_id = 'intent-live-exact-steer-mature'
        `;
        assert.isDefined(intent);

        // Stop commits after the exact intent but before a delayed provider
        // ACK. Sequence is the generation fence; comparing this control with
        // acceptedAt would incorrectly discard it.
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json,
            metadata_json
          ) VALUES (
            'interrupt-before-live-exact-steer-ack', 'thread', ${threadId}, 1,
            'thread.turn-interrupt-requested', ${interruptedAt},
            'client:interrupt-before-live-exact-steer-ack', NULL, NULL, 'client',
            ${JSON.stringify({ threadId, turnId, createdAt: interruptedAt })}, '{}'
          )
        `;

        const acceptedPayload = {
          provider: "codex",
          messageId,
          acceptedTurnId: turnId,
          intentSequence: intent.sequence,
          clientCorrelationId,
        };
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary,
            payload_json, sequence, created_at
          ) VALUES (
            ${activityId}, ${threadId}, ${turnId}, 'info', 'provider.turn.steer.accepted',
            'Steer accepted', ${JSON.stringify(acceptedPayload)}, NULL, ${acceptedAt}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json,
            metadata_json
          ) VALUES (
            'event-live-exact-steer-mature', 'thread', ${threadId}, 3,
            'thread.activity-appended', ${acceptedAt}, 'server:accepted-live-exact-steer-mature',
            NULL, NULL, 'server', ${JSON.stringify({
              threadId,
              activity: {
                id: activityId,
                tone: "info",
                kind: "provider.turn.steer.accepted",
                summary: "Steer accepted",
                payload: acceptedPayload,
                turnId,
                createdAt: acceptedAt,
              },
            })}, '{}'
          )
        `;
        const [acceptedEvent] = yield* sql<{ readonly sequence: number }>`
          SELECT sequence
          FROM orchestration_events
          WHERE event_id = 'event-live-exact-steer-mature'
        `;
        assert.isDefined(acceptedEvent);

        // Model a production-aged stream after this acceptance. The former
        // all-in-one evidence statement could make a correlated recovery
        // subquery walk this complete suffix even though a running turn can
        // never require terminal replay.
        yield* sql`
          WITH RECURSIVE event_numbers(index_value) AS (
            SELECT 1
            UNION ALL
            SELECT index_value + 1
            FROM event_numbers
            WHERE index_value < 50000
          )
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json,
            metadata_json
          )
          SELECT
            printf('event-live-exact-steer-mature-noise-%05d', index_value),
            'thread', ${threadId}, index_value + 3, 'thread.title-updated',
            '2026-09-01T00:00:00.000Z',
            printf('client:live-exact-steer-mature-noise-%05d', index_value),
            NULL, NULL, 'client', '{"threadId":"thread-live-exact-steer-mature"}', '{}'
          FROM event_numbers
        `;

        const exactBasePlan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT accepted.activity_id
          FROM projection_thread_activities AS accepted
          CROSS JOIN orchestration_events AS accepted_event
          CROSS JOIN orchestration_events AS accepted_intent
          CROSS JOIN projection_thread_messages AS message
          CROSS JOIN projection_turns AS accepted_turn
          WHERE accepted.activity_id = ${activityId}
            AND accepted.thread_id = ${threadId}
            AND accepted.turn_id = ${turnId}
            AND accepted_event.sequence = ${acceptedEvent.sequence}
            AND accepted_intent.sequence = ${intent.sequence}
            AND message.thread_id = ${threadId}
            AND message.message_id = ${messageId}
            AND accepted_turn.thread_id = ${threadId}
            AND accepted_turn.turn_id = ${turnId}
          LIMIT 1
        `;
        const exactBasePlanText = exactBasePlan.map((row) => row.detail).join("\n");
        assert.match(exactBasePlanText, /projection_thread_activities.*activity_id/);
        assert.match(exactBasePlanText, /accepted_event.*INTEGER PRIMARY KEY/);
        assert.match(exactBasePlanText, /accepted_intent.*INTEGER PRIMARY KEY/);
        assert.match(exactBasePlanText, /projection_thread_messages/);
        assert.match(exactBasePlanText, /projection_turns/);
        assert.notInclude(exactBasePlanText, "idx_orch_events_stream_sequence");

        const lookupStartedAt = performance.now();
        const evidence = yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
          exactAcceptedBarrier: {
            _tag: "accepted",
            threadId,
            eventSequence: acceptedEvent.sequence,
            intentSequence: intent.sequence,
            intentCreatedAt,
            activityId,
            acceptedTurnId: turnId,
            clientCorrelationId,
            messageId,
            acceptedAt,
          },
        });
        const lookupElapsedMs = performance.now() - lookupStartedAt;
        assert.isBelow(
          lookupElapsedMs,
          1000,
          `live exact steer lookup exceeded the synchronous liveness budget (${lookupElapsedMs.toFixed(1)} ms)`,
        );
        assert.deepStrictEqual(evidence, [
          {
            threadId,
            acceptedTurnId: turnId,
            intentSequence: intent.sequence,
            clientCorrelationId,
            messageId,
            messageTurnId: turnId,
            messageText: "private mature prompt",
            messageAttachments: [],
            acceptedAt,
            turnState: "running",
            turnCompletedAt: null,
            processingObserved: false,
            recoveryObserved: false,
            interruptRequested: false,
            sessionStopRequested: false,
          },
        ]);

        const terminalControlPlan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT interrupt_barrier.sequence
          FROM orchestration_codex_steer_control_barriers AS interrupt_barrier
            INDEXED BY idx_codex_steer_control_thread_kind_turn_sequence
          CROSS JOIN orchestration_events AS interrupt_event
            ON interrupt_event.sequence = interrupt_barrier.sequence
          WHERE interrupt_barrier.thread_id = ${threadId}
            AND interrupt_barrier.barrier_kind = 'thread.turn-interrupt-requested'
            AND interrupt_barrier.turn_id = ${turnId}
            AND interrupt_barrier.sequence > ${intent.sequence}
            AND interrupt_event.actor_kind IN ('client', 'server')
          LIMIT 1
        `;
        const terminalControlPlanText = terminalControlPlan.map((row) => row.detail).join("\n");
        assert.include(
          terminalControlPlanText,
          "idx_codex_steer_control_thread_kind_turn_sequence",
        );
        assert.match(terminalControlPlanText, /interrupt_event.*INTEGER PRIMARY KEY/);
        assert.notInclude(terminalControlPlanText, "idx_orch_events_stream_sequence");

        yield* sql`
          UPDATE projection_turns
          SET state = 'interrupted', completed_at = ${interruptedAt}
          WHERE thread_id = ${threadId}
            AND turn_id = ${turnId}
        `;
        const terminalLookupStartedAt = performance.now();
        const terminalEvidence = yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
          exactAcceptedBarrier: {
            _tag: "accepted",
            threadId,
            eventSequence: acceptedEvent.sequence,
            intentSequence: intent.sequence,
            intentCreatedAt,
            activityId,
            acceptedTurnId: turnId,
            clientCorrelationId,
            messageId,
            acceptedAt,
          },
        });
        const terminalLookupElapsedMs = performance.now() - terminalLookupStartedAt;
        assert.isBelow(
          terminalLookupElapsedMs,
          1000,
          `terminal exact steer lookup exceeded the synchronous liveness budget (${terminalLookupElapsedMs.toFixed(1)} ms)`,
        );
        assert.equal(terminalEvidence[0]?.interruptRequested, true);
        assert.equal(terminalEvidence[0]?.sessionStopRequested, true);

        // A schema-only upgrade cannot prove whether an older intent had a
        // pre-migration Stop. Absence from the append-time ledger therefore
        // fails closed instead of authorizing an ambiguous automatic replay.
        yield* sql`
          UPDATE orchestration_codex_steer_control_barrier_state
          SET indexed_from_sequence = ${intent.sequence + 1}
          WHERE singleton = 1
        `;
        assert.deepStrictEqual(
          yield* snapshotQuery.getCodexSteerAcceptanceEvidence({
            exactAcceptedBarrier: {
              _tag: "accepted",
              threadId,
              eventSequence: acceptedEvent.sequence,
              intentSequence: intent.sequence,
              intentCreatedAt,
              activityId,
              acceptedTurnId: turnId,
              clientCorrelationId,
              messageId,
              acceptedAt,
            },
          }),
          [],
        );
        yield* sql`
          UPDATE orchestration_codex_steer_control_barrier_state
          SET indexed_from_sequence = 0
          WHERE singleton = 1
        `;
      }),
    15_000,
  );

  it.effect(
    "returns only sequence-ordered Codex steer intents with no durable handling outcome",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM orchestration_events`;
        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_thread_sessions`;
        yield* sql`DELETE FROM projection_turns`;
        yield* sql`DELETE FROM projection_threads`;

        const recoveryThreadId = "thread-unsettled-steer-intents";
        const createdAt = "2026-08-31T01:00:00.000Z";
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, latest_user_message_at,
          pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
          created_at, updated_at, archived_at, deleted_at
        )
        VALUES (
          ${recoveryThreadId}, 'project-stale-steer', 'Unsettled steer intents',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, 'turn-unsettled-intents', ${createdAt}, 0, 0, 0,
          ${createdAt}, ${createdAt}, NULL, NULL
        )
      `;
        yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_instance_id, runtime_mode,
          active_turn_id, last_error, updated_at
        )
        VALUES (
          ${recoveryThreadId}, 'ready', 'codex', 'codex', 'full-access', NULL, NULL, ${createdAt}
        )
      `;

        // Keep the exact-processing lookup outer loop on the compact,
        // selective activity projection. Without CROSS JOIN, SQLite may
        // reorder this query to scan every later orchestration event in the
        // thread through idx_orch_events_stream_sequence. That blocked the
        // Node event loop for minutes on a 44-million-event production ledger.
        const exactProcessingPlan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT EXISTS (
            SELECT 1
            FROM projection_thread_activities AS processing
              INDEXED BY idx_projection_thread_activities_thread_turn_kind_created_id
            CROSS JOIN orchestration_events AS processing_event
              INDEXED BY idx_orch_events_command_id
              ON processing_event.command_id =
                'provider:codex:' || processing.thread_id || ':' ||
                processing.activity_id || ':thread-activity-append:' || processing.activity_id
              AND processing_event.sequence > 1
              AND processing_event.aggregate_kind = 'thread'
              AND processing_event.stream_id = processing.thread_id
              AND processing_event.event_type = 'thread.activity-appended'
              AND processing_event.actor_kind = 'provider'
              AND json_extract(processing_event.payload_json, '$.threadId') =
                processing.thread_id
              AND json_extract(processing_event.payload_json, '$.activity.id') =
                processing.activity_id
              AND json_extract(processing_event.payload_json, '$.activity.kind') =
                processing.kind
              AND json_extract(processing_event.payload_json, '$.activity.turnId') IS
                processing.turn_id
              AND json_extract(processing_event.payload_json, '$.activity.createdAt') =
                processing.created_at
              AND json_extract(processing_event.payload_json, '$.activity.payload') =
                json(processing.payload_json)
            WHERE processing.thread_id = ${recoveryThreadId}
              AND processing.turn_id IS 'turn-unsettled-intents'
              AND processing.kind = 'task.progress'
              AND processing.created_at >= ${createdAt}
              AND json_type(processing.payload_json, '$.taskId') = 'text'
              AND json_extract(processing.payload_json, '$.taskId') = 'safe-task-id'
              AND json_type(
                processing.payload_json,
                '$.usage.clientCorrelationId'
              ) = 'text'
              AND json_extract(
                processing.payload_json,
                '$.usage.clientCorrelationId'
              ) = 'safe-correlation-id'
              AND json_type(processing.payload_json, '$.usage.messageId') = 'text'
              AND json_extract(processing.payload_json, '$.usage.messageId') = 'safe-message-id'
            LIMIT 1
          )
        `;
        const exactProcessingPlanDetails = exactProcessingPlan.map((row) => row.detail);
        const processingLookupIndex = exactProcessingPlanDetails.findIndex((detail) =>
          detail.includes("idx_projection_thread_activities_thread_turn_kind_created_id"),
        );
        const eventLookupIndex = exactProcessingPlanDetails.findIndex((detail) =>
          detail.includes("idx_orch_events_command_id"),
        );
        assert.isTrue(processingLookupIndex >= 0);
        assert.isTrue(eventLookupIndex > processingLookupIndex);
        assert.notInclude(exactProcessingPlanDetails.join("\n"), "idx_orch_events_stream_sequence");

        let streamVersion = 0;
        const insertEvent = (input: {
          readonly eventId: string;
          readonly eventType:
            | "thread.turn-steer-requested"
            | "thread.turn-start-requested"
            | "thread.turn-interrupt-requested"
            | "thread.session-stop-requested"
            | "thread.activity-appended";
          readonly actorKind: "client" | "server" | "provider";
          readonly payload: unknown;
          readonly occurredAt?: string;
          readonly commandId?: string;
        }) => {
          const version = streamVersion;
          streamVersion += 1;
          return sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              command_id, causation_event_id, correlation_id, actor_kind, payload_json,
              metadata_json
            )
            VALUES (
              ${input.eventId}, 'thread', ${recoveryThreadId}, ${version}, ${input.eventType},
              ${input.occurredAt ?? createdAt},
              ${input.commandId ?? `${input.actorKind}:${input.eventId}`}, NULL,
              ${`${input.actorKind}:${input.eventId}`},
              ${input.actorKind}, ${JSON.stringify(input.payload)}, '{}'
            )
          `;
        };
        const insertSteerIntent = (input: {
          readonly eventId: string;
          readonly messageId: string;
          readonly expectedTurnId?: string | null;
          readonly actorKind?: "client" | "server" | "provider";
          readonly occurredAt?: string;
        }) =>
          insertEvent({
            eventId: input.eventId,
            eventType: "thread.turn-steer-requested",
            actorKind: input.actorKind ?? "client",
            ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
            payload: {
              threadId: recoveryThreadId,
              messageId: input.messageId,
              expectedTurnId:
                input.expectedTurnId === undefined
                  ? "turn-unsettled-intents"
                  : input.expectedTurnId,
              createdAt: input.occurredAt ?? createdAt,
            },
          });
        const readEventSequence = (eventId: string) =>
          sql<{ readonly sequence: number }>`
            SELECT sequence
            FROM orchestration_events
            WHERE event_id = ${eventId}
            LIMIT 1
          `.pipe(
            Effect.map((rows) => {
              const sequence = rows[0]?.sequence;
              assert.ok(sequence !== undefined);
              return sequence;
            }),
          );
        const insertActivity = (input: {
          readonly activityId: string;
          readonly kind: string;
          readonly payload: Readonly<Record<string, unknown>>;
          readonly turnId?: string;
          readonly actorKind?: "server" | "provider";
        }) =>
          Effect.gen(function* () {
            const turnId = input.turnId ?? "turn-unsettled-intents";
            yield* sql`
              INSERT INTO projection_thread_activities (
                activity_id, thread_id, turn_id, tone, kind, summary,
                payload_json, sequence, created_at
              )
              VALUES (
                ${input.activityId}, ${recoveryThreadId}, ${turnId}, 'info', ${input.kind},
                'Steer outcome', ${JSON.stringify(input.payload)}, NULL, ${createdAt}
              )
            `;
            yield* insertEvent({
              eventId: `event-${input.activityId}`,
              eventType: "thread.activity-appended",
              actorKind: input.actorKind ?? "server",
              ...(input.actorKind === "provider" && input.kind === "task.progress"
                ? {
                    commandId: `provider:codex:${recoveryThreadId}:${input.activityId}:thread-activity-append:${input.activityId}`,
                  }
                : {}),
              payload: {
                threadId: recoveryThreadId,
                activity: {
                  id: input.activityId,
                  tone: "info",
                  kind: input.kind,
                  summary: "Steer outcome",
                  payload: input.payload,
                  turnId,
                  createdAt,
                },
              },
            });
          });

        // These two authenticated intents model a crash after durable commit
        // but before the reactor reached provider I/O.
        yield* insertSteerIntent({
          eventId: "intent-crash-client",
          messageId: "message-crash-client",
        });
        yield* insertSteerIntent({
          eventId: "intent-crash-server",
          messageId: "message-crash-server",
          expectedTurnId: null,
          actorKind: "server",
          occurredAt: "2026-08-31T01:00:01.000Z",
        });
        // Provider-authored lookalikes never become replay authority.
        yield* insertSteerIntent({
          eventId: "intent-forged-provider",
          messageId: "message-forged-provider",
          actorKind: "provider",
        });

        yield* insertSteerIntent({
          eventId: "intent-accepted",
          messageId: "message-accepted",
        });
        const acceptedIntentSequence = yield* readEventSequence("intent-accepted");
        yield* insertActivity({
          activityId: "accepted-intent-outcome",
          kind: "provider.turn.steer.accepted",
          payload: {
            provider: "codex",
            messageId: "message-accepted",
            acceptedTurnId: "turn-unsettled-intents",
            intentSequence: acceptedIntentSequence,
            clientCorrelationId: codexClientCorrelationId,
          },
        });

        // A newer generation may intentionally reuse MessageId. Historical
        // progress with the exact same cryptographic binding must not settle
        // a candidate whose event sequence is newer than that observation.
        const repeatedProcessingMessageId = "message-processing-reused-generation";
        const repeatedProcessingToken = buildCodexSteerClientCorrelationId(
          repeatedProcessingMessageId,
        );
        yield* insertActivity({
          activityId: "processing-reused-generation-old",
          kind: "task.progress",
          actorKind: "provider",
          payload: {
            taskId: `codex-turn-steer-processing:${repeatedProcessingToken}`,
            usage: {
              messageId: repeatedProcessingMessageId,
              clientCorrelationId: repeatedProcessingToken,
            },
          },
        });
        yield* insertSteerIntent({
          eventId: "intent-processing-reused-generation",
          messageId: repeatedProcessingMessageId,
        });
        const repeatedProcessingSequence = yield* readEventSequence(
          "intent-processing-reused-generation",
        );
        assert.equal(
          (yield* snapshotQuery.getUnsettledCodexSteerIntentEvents()).some(
            (candidate) => candidate.sequence === repeatedProcessingSequence,
          ),
          true,
        );
        yield* insertActivity({
          activityId: "processing-reused-generation-new",
          kind: "task.progress",
          actorKind: "provider",
          payload: {
            taskId: `codex-turn-steer-processing:${repeatedProcessingToken}`,
            usage: {
              messageId: repeatedProcessingMessageId,
              clientCorrelationId: repeatedProcessingToken,
            },
          },
        });
        assert.equal(
          (yield* snapshotQuery.getUnsettledCodexSteerIntentEvents()).some(
            (candidate) => candidate.sequence === repeatedProcessingSequence,
          ),
          false,
        );

        // The cryptographic message tuple is not sufficient on its own when
        // a later generation can reuse MessageId. Processing must also belong
        // to the immutable provider turn recorded by the original intent.
        const wrongTurnMessageId = "message-processing-wrong-turn";
        const wrongTurnToken = buildCodexSteerClientCorrelationId(wrongTurnMessageId);
        yield* insertSteerIntent({
          eventId: "intent-processing-wrong-turn",
          messageId: wrongTurnMessageId,
        });
        const wrongTurnSequence = yield* readEventSequence("intent-processing-wrong-turn");
        yield* insertActivity({
          activityId: "processing-wrong-turn-outcome",
          kind: "task.progress",
          turnId: "turn-different-generation",
          actorKind: "provider",
          payload: {
            taskId: `codex-turn-steer-processing:${wrongTurnToken}`,
            usage: {
              messageId: wrongTurnMessageId,
              clientCorrelationId: wrongTurnToken,
            },
          },
        });
        assert.equal(
          (yield* snapshotQuery.getUnsettledCodexSteerIntentEvents()).some(
            (candidate) => candidate.sequence === wrongTurnSequence,
          ),
          true,
        );
        yield* insertActivity({
          activityId: "processing-right-turn-outcome",
          kind: "task.progress",
          actorKind: "provider",
          payload: {
            taskId: `codex-turn-steer-processing:${wrongTurnToken}`,
            usage: {
              messageId: wrongTurnMessageId,
              clientCorrelationId: wrongTurnToken,
            },
          },
        });
        assert.equal(
          (yield* snapshotQuery.getUnsettledCodexSteerIntentEvents()).some(
            (candidate) => candidate.sequence === wrongTurnSequence,
          ),
          false,
        );

        yield* insertSteerIntent({
          eventId: "intent-processing",
          messageId: "message-processing",
        });
        const exactProcessingToken = buildCodexSteerClientCorrelationId("message-processing");
        yield* insertActivity({
          activityId: "processing-intent-outcome",
          kind: "task.progress",
          actorKind: "provider",
          payload: {
            taskId: `codex-turn-steer-processing:${exactProcessingToken}`,
            usage: {
              messageId: "message-processing",
              clientCorrelationId: exactProcessingToken,
            },
          },
        });
        const liveProcessingSequence = yield* readEventSequence("intent-processing");
        const liveCandidates = yield* snapshotQuery.getUnsettledCodexSteerIntentEvents({
          threadId: ThreadId.make(recoveryThreadId),
          reconcileDurableProcessing: false,
        });
        assert.equal(
          liveCandidates.some((candidate) => candidate.sequence === liveProcessingSequence),
          true,
        );
        const [persistedLiveProcessingCandidate] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM orchestration_unsettled_codex_steer_intents
          WHERE sequence = ${liveProcessingSequence}
        `;
        assert.equal(persistedLiveProcessingCandidate?.count, 1);

        // MessageId equality alone is not processing authority. These rows
        // model both a different canonical token and a split token/task-id
        // tuple; neither may suppress startup replay of the saved intent.
        yield* insertSteerIntent({
          eventId: "intent-processing-wrong-token",
          messageId: "message-processing-wrong-token",
        });
        const wrongProcessingToken = buildCodexSteerClientCorrelationId("another-message");
        yield* insertActivity({
          activityId: "processing-wrong-token-intent-outcome",
          kind: "task.progress",
          actorKind: "provider",
          payload: {
            taskId: `codex-turn-steer-processing:${wrongProcessingToken}`,
            usage: {
              messageId: "message-processing-wrong-token",
              clientCorrelationId: wrongProcessingToken,
            },
          },
        });

        yield* insertSteerIntent({
          eventId: "intent-processing-split-binding",
          messageId: "message-processing-split-binding",
        });
        const splitBindingToken = buildCodexSteerClientCorrelationId(
          "message-processing-split-binding",
        );
        yield* insertActivity({
          activityId: "processing-split-binding-intent-outcome",
          kind: "task.progress",
          actorKind: "provider",
          payload: {
            taskId: `codex-turn-steer-processing:${wrongProcessingToken}`,
            usage: {
              messageId: "message-processing-split-binding",
              clientCorrelationId: splitBindingToken,
            },
          },
        });

        for (const [suffix, retryableFollowUp] of [
          ["retryable", true],
          ["terminal", false],
        ] as const) {
          const handledMessageId = `message-failed-${suffix}`;
          yield* insertSteerIntent({
            eventId: `intent-failed-${suffix}`,
            messageId: handledMessageId,
          });
          const handledIntentSequence = yield* readEventSequence(`intent-failed-${suffix}`);
          yield* insertActivity({
            activityId: `failed-intent-${suffix}`,
            kind: "provider.turn.steer.failed",
            payload: {
              messageId: handledMessageId,
              intentSequence: handledIntentSequence,
              retryableFollowUp,
            },
          });
        }

        yield* insertSteerIntent({
          eventId: "intent-recovered",
          messageId: "message-recovered",
        });
        const recoveredIntentSequence = yield* readEventSequence("intent-recovered");
        yield* insertActivity({
          activityId: "recovered-intent-outcome",
          kind: "provider.turn.steer.recovered",
          turnId: "turn-recovered-intent",
          payload: {
            provider: "codex",
            messageId: "message-recovered",
            acceptedTurnId: "turn-unsettled-intents",
            recoveredTurnId: "turn-recovered-intent",
            intentSequence: recoveredIntentSequence,
            clientCorrelationId: codexClientCorrelationId,
          },
        });

        yield* insertSteerIntent({
          eventId: "intent-delivered-next-turn",
          messageId: "message-delivered-next-turn",
        });
        const deliveredIntentSequence = yield* readEventSequence("intent-delivered-next-turn");
        yield* insertActivity({
          activityId: "delivered-next-turn-outcome",
          kind: "provider.turn.steer.delivered",
          turnId: "turn-delivered-next-turn",
          payload: {
            provider: "codex",
            messageId: "message-delivered-next-turn",
            deliveredTurnId: "turn-delivered-next-turn",
            intentSequence: deliveredIntentSequence,
            delivery: "next-turn",
            reason: "turn-start-after-provider-no-active-turn",
          },
        });

        // A post-intent outbox marker means provider delivery may already have
        // happened even if Cafe crashed before it persisted the success
        // receipt. Startup must fail closed rather than duplicate that input.
        yield* insertSteerIntent({
          eventId: "intent-delivery-attempted",
          messageId: "message-delivery-attempted",
        });
        const deliveryAttemptedIntentSequence = yield* readEventSequence(
          "intent-delivery-attempted",
        );
        yield* insertActivity({
          activityId: "delivery-attempted-outcome",
          kind: "provider.turn.steer.delivery-attempted",
          payload: {
            provider: "codex",
            messageId: "message-delivery-attempted",
            intentSequence: deliveryAttemptedIntentSequence,
            delivery: "live-steer",
            deliveryState: "attempted",
            reason: "live-steer",
            expectedTurnId: "turn-unsettled-intents",
          },
        });

        // Provider-authored and malformed attempt lookalikes are not allowed
        // to suppress recovery of a steer which never crossed Cafe's trusted
        // provider-I/O boundary.
        yield* insertSteerIntent({
          eventId: "intent-forged-attempt",
          messageId: "message-forged-attempt",
        });
        const forgedAttemptIntentSequence = yield* readEventSequence("intent-forged-attempt");
        yield* insertActivity({
          activityId: "forged-attempt-outcome",
          kind: "provider.turn.steer.delivery-attempted",
          actorKind: "provider",
          payload: {
            provider: "codex",
            messageId: "message-forged-attempt",
            intentSequence: forgedAttemptIntentSequence,
            delivery: "live-steer",
            deliveryState: "attempted",
            reason: "live-steer",
            expectedTurnId: "turn-unsettled-intents",
          },
        });
        yield* insertSteerIntent({
          eventId: "intent-malformed-attempt",
          messageId: "message-malformed-attempt",
        });
        const malformedAttemptIntentSequence = yield* readEventSequence("intent-malformed-attempt");
        yield* insertActivity({
          activityId: "malformed-attempt-outcome",
          kind: "provider.turn.steer.delivery-attempted",
          payload: {
            provider: "codex",
            messageId: "message-malformed-attempt",
            intentSequence: malformedAttemptIntentSequence,
            delivery: "live-steer",
            deliveryState: "attempted",
            reason: "unknown-attempt-kind",
            expectedTurnId: "turn-unsettled-intents",
          },
        });

        // Neither a provider-authored lookalike nor a malformed server receipt
        // may suppress restart replay of an otherwise unsettled steer intent.
        yield* insertSteerIntent({
          eventId: "intent-forged-delivery",
          messageId: "message-forged-delivery",
        });
        yield* insertActivity({
          activityId: "forged-delivery-outcome",
          kind: "provider.turn.steer.delivered",
          turnId: "turn-forged-delivery",
          actorKind: "provider",
          payload: {
            provider: "codex",
            messageId: "message-forged-delivery",
            deliveredTurnId: "turn-forged-delivery",
            delivery: "next-turn",
            reason: "turn-start-after-provider-no-active-turn",
          },
        });
        yield* insertSteerIntent({
          eventId: "intent-malformed-delivery",
          messageId: "message-malformed-delivery",
        });
        yield* insertActivity({
          activityId: "malformed-delivery-outcome",
          kind: "provider.turn.steer.delivered",
          turnId: "turn-malformed-delivery",
          payload: {
            provider: "codex",
            messageId: "message-malformed-delivery",
            deliveredTurnId: "turn-malformed-delivery",
            delivery: "next-turn",
            reason: "untrusted-reason",
          },
        });

        // A durable automatic retry intentionally reuses MessageId. The first
        // generation's queue row must not settle the new intent, and the second
        // failure must author a distinct row so already-mounted renderers can
        // observe the new outcome instead of being stranded on stale state.
        const repeatedFailureMessageId = "message-repeated-failure";
        yield* insertSteerIntent({
          eventId: "intent-repeated-failure-first",
          messageId: repeatedFailureMessageId,
        });
        const repeatedFailureFirstSequence = yield* readEventSequence(
          "intent-repeated-failure-first",
        );
        yield* insertActivity({
          activityId: "repeated-failure-first-outcome",
          kind: "provider.turn.steer.failed",
          payload: {
            provider: "codex",
            messageId: repeatedFailureMessageId,
            intentSequence: repeatedFailureFirstSequence,
            retryableFollowUp: true,
            delivery: "next-turn",
            deliveryState: "queued",
          },
        });
        yield* insertSteerIntent({
          eventId: "intent-repeated-failure-second",
          messageId: repeatedFailureMessageId,
        });
        const repeatedFailureSecondSequence = yield* readEventSequence(
          "intent-repeated-failure-second",
        );
        const exactProcessingSequence = yield* readEventSequence("intent-processing");
        const [persistedProcessingCandidateBeforeRead] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM orchestration_unsettled_codex_steer_intents
          WHERE sequence = ${exactProcessingSequence}
        `;
        assert.equal(persistedProcessingCandidateBeforeRead?.count, 1);
        const candidatesAfterFirstRead = yield* snapshotQuery.getUnsettledCodexSteerIntentEvents();
        assert.equal(
          candidatesAfterFirstRead.some(
            (candidate) => candidate.sequence === repeatedFailureSecondSequence,
          ),
          true,
        );
        const [persistedProcessingCandidateAfterRead] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM orchestration_unsettled_codex_steer_intents
          WHERE sequence = ${exactProcessingSequence}
        `;
        assert.equal(persistedProcessingCandidateAfterRead?.count, 0);
        yield* insertActivity({
          activityId: "repeated-failure-second-outcome",
          kind: "provider.turn.steer.failed",
          payload: {
            provider: "codex",
            messageId: repeatedFailureMessageId,
            intentSequence: repeatedFailureSecondSequence,
            retryableFollowUp: true,
            delivery: "next-turn",
            deliveryState: "queued",
          },
        });
        const repeatedFailureRows = yield* sql<{
          readonly activityId: string;
          readonly intentSequence: number;
        }>`
          SELECT
            activity_id AS "activityId",
            json_extract(payload_json, '$.intentSequence') AS "intentSequence"
          FROM projection_thread_activities
          WHERE thread_id = ${recoveryThreadId}
            AND json_extract(payload_json, '$.messageId') = ${repeatedFailureMessageId}
            AND kind = 'provider.turn.steer.failed'
          ORDER BY activity_id ASC
        `;
        assert.deepStrictEqual(repeatedFailureRows, [
          {
            activityId: "repeated-failure-first-outcome",
            intentSequence: repeatedFailureFirstSequence,
          },
          {
            activityId: "repeated-failure-second-outcome",
            intentSequence: repeatedFailureSecondSequence,
          },
        ]);

        // The same generation binding also guards the side-effect/receipt
        // crash window. A prior failed generation cannot alias the new attempt,
        // while the exact second-generation attempt fails closed on every
        // subsequent restart until provider evidence resolves it.
        const retryCrashMessageId = "message-retry-then-crash";
        yield* insertSteerIntent({
          eventId: "intent-retry-crash-first",
          messageId: retryCrashMessageId,
        });
        const retryCrashFirstSequence = yield* readEventSequence("intent-retry-crash-first");
        yield* insertActivity({
          activityId: "retry-crash-first-failure",
          kind: "provider.turn.steer.failed",
          payload: {
            provider: "codex",
            messageId: retryCrashMessageId,
            intentSequence: retryCrashFirstSequence,
            retryableFollowUp: true,
          },
        });
        yield* insertSteerIntent({
          eventId: "intent-retry-crash-second",
          messageId: retryCrashMessageId,
        });
        const retryCrashSecondSequence = yield* readEventSequence("intent-retry-crash-second");
        yield* insertActivity({
          activityId: "retry-crash-second-attempt",
          kind: "provider.turn.steer.delivery-attempted",
          payload: {
            provider: "codex",
            messageId: retryCrashMessageId,
            intentSequence: retryCrashSecondSequence,
            delivery: "live-steer",
            deliveryState: "attempted",
            reason: "live-steer",
            expectedTurnId: "turn-unsettled-intents",
          },
        });
        for (let restart = 0; restart < 2; restart += 1) {
          assert.equal(
            (yield* snapshotQuery.getUnsettledCodexSteerIntentEvents()).some(
              (candidate) => candidate.messageId === retryCrashMessageId,
            ),
            false,
          );
        }

        // Recovery and next-turn delivery receipts are also generation
        // scoped. A delayed success from an older provider side effect must
        // never erase a newer retry that intentionally reused MessageId.
        const repeatedRecoveryMessageId = "message-repeated-recovery";
        const repeatedRecoveryCorrelation =
          buildCodexSteerClientCorrelationId(repeatedRecoveryMessageId);
        yield* insertSteerIntent({
          eventId: "intent-repeated-recovery-first",
          messageId: repeatedRecoveryMessageId,
        });
        const repeatedRecoveryFirstSequence = yield* readEventSequence(
          "intent-repeated-recovery-first",
        );
        yield* insertActivity({
          activityId: "accepted-repeated-recovery-first",
          kind: "provider.turn.steer.accepted",
          payload: {
            provider: "codex",
            messageId: repeatedRecoveryMessageId,
            acceptedTurnId: "turn-unsettled-intents",
            intentSequence: repeatedRecoveryFirstSequence,
            clientCorrelationId: repeatedRecoveryCorrelation,
          },
        });
        yield* insertSteerIntent({
          eventId: "intent-repeated-recovery-second",
          messageId: repeatedRecoveryMessageId,
        });
        const repeatedRecoverySecondSequence = yield* readEventSequence(
          "intent-repeated-recovery-second",
        );
        yield* insertActivity({
          activityId: "accepted-repeated-recovery-second",
          kind: "provider.turn.steer.accepted",
          payload: {
            provider: "codex",
            messageId: repeatedRecoveryMessageId,
            acceptedTurnId: "turn-unsettled-intents",
            intentSequence: repeatedRecoverySecondSequence,
            clientCorrelationId: repeatedRecoveryCorrelation,
          },
        });
        yield* insertActivity({
          activityId: "recovered-repeated-recovery-first-delayed",
          kind: "provider.turn.steer.recovered",
          turnId: "turn-recovered-first-delayed",
          payload: {
            provider: "codex",
            messageId: repeatedRecoveryMessageId,
            acceptedTurnId: "turn-unsettled-intents",
            recoveredTurnId: "turn-recovered-first-delayed",
            intentSequence: repeatedRecoveryFirstSequence,
            clientCorrelationId: repeatedRecoveryCorrelation,
          },
        });
        const pendingRepeatedRecoveries = yield* sql<{ readonly intentSequence: number }>`
          SELECT intent_sequence AS "intentSequence"
          FROM orchestration_pending_codex_steer_acceptances
          WHERE thread_id = ${recoveryThreadId}
            AND message_id = ${repeatedRecoveryMessageId}
          ORDER BY intent_sequence ASC
        `;
        assert.deepStrictEqual(pendingRepeatedRecoveries, [
          { intentSequence: repeatedRecoverySecondSequence },
        ]);

        const repeatedDeliveryMessageId = "message-repeated-delivery";
        yield* insertSteerIntent({
          eventId: "intent-repeated-delivery-first",
          messageId: repeatedDeliveryMessageId,
        });
        const repeatedDeliveryFirstSequence = yield* readEventSequence(
          "intent-repeated-delivery-first",
        );
        yield* insertSteerIntent({
          eventId: "intent-repeated-delivery-second",
          messageId: repeatedDeliveryMessageId,
        });
        const repeatedDeliverySecondSequence = yield* readEventSequence(
          "intent-repeated-delivery-second",
        );
        yield* insertActivity({
          activityId: "delivered-repeated-delivery-first-delayed",
          kind: "provider.turn.steer.delivered",
          turnId: "turn-delivered-first-delayed",
          payload: {
            provider: "codex",
            messageId: repeatedDeliveryMessageId,
            deliveredTurnId: "turn-delivered-first-delayed",
            intentSequence: repeatedDeliveryFirstSequence,
            delivery: "next-turn",
            reason: "turn-start-after-provider-no-active-turn",
          },
        });
        assert.equal(
          (yield* snapshotQuery.getUnsettledCodexSteerIntentEvents()).some(
            (candidate) => candidate.sequence === repeatedDeliverySecondSequence,
          ),
          true,
        );
        yield* insertActivity({
          activityId: "delivered-repeated-delivery-second",
          kind: "provider.turn.steer.delivered",
          turnId: "turn-delivered-second",
          payload: {
            provider: "codex",
            messageId: repeatedDeliveryMessageId,
            deliveredTurnId: "turn-delivered-second",
            intentSequence: repeatedDeliverySecondSequence,
            delivery: "next-turn",
            reason: "turn-start-after-provider-no-active-turn",
          },
        });

        yield* insertSteerIntent({
          eventId: "intent-superseded",
          messageId: "message-superseded",
        });
        yield* insertEvent({
          eventId: "later-start-same-message",
          eventType: "thread.turn-start-requested",
          actorKind: "server",
          payload: {
            threadId: recoveryThreadId,
            messageId: "message-superseded",
            createdAt,
          },
        });

        // The projection row alone is not trusted; its provider-authored event
        // must not hide an otherwise unsettled authenticated intent.
        yield* insertSteerIntent({
          eventId: "intent-forged-acceptance",
          messageId: "message-forged-acceptance",
        });
        yield* insertActivity({
          activityId: "forged-accepted-intent-outcome",
          kind: "provider.turn.steer.accepted",
          actorKind: "provider",
          payload: {
            provider: "codex",
            messageId: "message-forged-acceptance",
            acceptedTurnId: "turn-unsettled-intents",
          },
        });

        const sequenceRows = yield* sql<{
          readonly eventId: string;
          readonly sequence: number;
        }>`
          SELECT event_id AS "eventId", sequence
          FROM orchestration_events
          WHERE event_id IN (
            'intent-crash-client',
            'intent-crash-server',
            'intent-processing-wrong-token',
            'intent-processing-split-binding',
            'intent-forged-attempt',
            'intent-malformed-attempt',
            'intent-forged-delivery',
            'intent-malformed-delivery',
            'intent-forged-acceptance'
          )
          ORDER BY sequence ASC
        `;
        const sequenceByEvent = new Map(sequenceRows.map((row) => [row.eventId, row.sequence]));
        const crashClientSequence = sequenceByEvent.get("intent-crash-client");
        const crashServerSequence = sequenceByEvent.get("intent-crash-server");
        const wrongProcessingSequence = sequenceByEvent.get("intent-processing-wrong-token");
        const splitBindingSequence = sequenceByEvent.get("intent-processing-split-binding");
        const forgedAcceptanceSequence = sequenceByEvent.get("intent-forged-acceptance");
        const forgedAttemptSequence = sequenceByEvent.get("intent-forged-attempt");
        const malformedAttemptSequence = sequenceByEvent.get("intent-malformed-attempt");
        const forgedDeliverySequence = sequenceByEvent.get("intent-forged-delivery");
        const malformedDeliverySequence = sequenceByEvent.get("intent-malformed-delivery");
        assert.ok(crashClientSequence !== undefined);
        assert.ok(crashServerSequence !== undefined);
        assert.ok(wrongProcessingSequence !== undefined);
        assert.ok(splitBindingSequence !== undefined);
        assert.ok(forgedAcceptanceSequence !== undefined);
        assert.ok(forgedAttemptSequence !== undefined);
        assert.ok(malformedAttemptSequence !== undefined);
        assert.ok(forgedDeliverySequence !== undefined);
        assert.ok(malformedDeliverySequence !== undefined);
        const unsettledIntents = yield* snapshotQuery.getUnsettledCodexSteerIntentEvents();
        assert.deepStrictEqual(unsettledIntents, [
          {
            sequence: crashClientSequence,
            threadId: ThreadId.make(recoveryThreadId),
            messageId: MessageId.make("message-crash-client"),
            expectedTurnId: TurnId.make("turn-unsettled-intents"),
            createdAt,
          },
          {
            sequence: crashServerSequence,
            threadId: ThreadId.make(recoveryThreadId),
            messageId: MessageId.make("message-crash-server"),
            expectedTurnId: null,
            createdAt: "2026-08-31T01:00:01.000Z",
          },
          {
            sequence: wrongProcessingSequence,
            threadId: ThreadId.make(recoveryThreadId),
            messageId: MessageId.make("message-processing-wrong-token"),
            expectedTurnId: TurnId.make("turn-unsettled-intents"),
            createdAt,
          },
          {
            sequence: splitBindingSequence,
            threadId: ThreadId.make(recoveryThreadId),
            messageId: MessageId.make("message-processing-split-binding"),
            expectedTurnId: TurnId.make("turn-unsettled-intents"),
            createdAt,
          },
          {
            sequence: forgedAttemptSequence,
            threadId: ThreadId.make(recoveryThreadId),
            messageId: MessageId.make("message-forged-attempt"),
            expectedTurnId: TurnId.make("turn-unsettled-intents"),
            createdAt,
          },
          {
            sequence: malformedAttemptSequence,
            threadId: ThreadId.make(recoveryThreadId),
            messageId: MessageId.make("message-malformed-attempt"),
            expectedTurnId: TurnId.make("turn-unsettled-intents"),
            createdAt,
          },
          {
            sequence: forgedDeliverySequence,
            threadId: ThreadId.make(recoveryThreadId),
            messageId: MessageId.make("message-forged-delivery"),
            expectedTurnId: TurnId.make("turn-unsettled-intents"),
            createdAt,
          },
          {
            sequence: malformedDeliverySequence,
            threadId: ThreadId.make(recoveryThreadId),
            messageId: MessageId.make("message-malformed-delivery"),
            expectedTurnId: TurnId.make("turn-unsettled-intents"),
            createdAt,
          },
          {
            sequence: forgedAcceptanceSequence,
            threadId: ThreadId.make(recoveryThreadId),
            messageId: MessageId.make("message-forged-acceptance"),
            expectedTurnId: TurnId.make("turn-unsettled-intents"),
            createdAt,
          },
        ]);
        assert.deepStrictEqual(
          yield* snapshotQuery.getUnsettledCodexSteerIntentEvents({
            threadId: ThreadId.make(recoveryThreadId),
          }),
          unsettledIntents,
        );
        assert.deepStrictEqual(
          yield* snapshotQuery.getUnsettledCodexSteerIntentEvents({
            threadId: ThreadId.make("thread-unrelated-unsettled-intents"),
          }),
          [],
        );

        // Provider-authored cancellation lookalikes are not replay barriers.
        yield* insertEvent({
          eventId: "forged-provider-interrupt",
          eventType: "thread.turn-interrupt-requested",
          actorKind: "provider",
          payload: {
            threadId: recoveryThreadId,
            turnId: "turn-unsettled-intents",
            createdAt,
          },
        });
        assert.deepStrictEqual(
          yield* snapshotQuery.getCodexSteerIntentRecoveryBarriers({
            sequence: forgedAcceptanceSequence,
            threadId: ThreadId.make(recoveryThreadId),
            messageId: MessageId.make("message-forged-acceptance"),
            expectedTurnId: TurnId.make("turn-unsettled-intents"),
          }),
          {
            intentVerified: true,
            newerTurnRequested: false,
            interruptRequested: false,
            sessionStopRequested: false,
          },
        );

        yield* insertEvent({
          eventId: "later-client-interrupt",
          eventType: "thread.turn-interrupt-requested",
          actorKind: "client",
          payload: {
            threadId: recoveryThreadId,
            turnId: "turn-unsettled-intents",
            createdAt,
          },
        });
        yield* insertEvent({
          eventId: "later-session-stop",
          eventType: "thread.session-stop-requested",
          actorKind: "server",
          payload: { threadId: recoveryThreadId, createdAt },
        });
        yield* insertEvent({
          eventId: "later-new-turn",
          eventType: "thread.turn-start-requested",
          actorKind: "client",
          payload: {
            threadId: recoveryThreadId,
            messageId: "message-newer-turn",
            createdAt,
          },
        });
        assert.deepStrictEqual(
          yield* snapshotQuery.getCodexSteerIntentRecoveryBarriers({
            sequence: crashClientSequence,
            threadId: ThreadId.make(recoveryThreadId),
            messageId: MessageId.make("message-crash-client"),
            expectedTurnId: TurnId.make("turn-unsettled-intents"),
          }),
          {
            intentVerified: true,
            newerTurnRequested: true,
            interruptRequested: true,
            sessionStopRequested: true,
          },
        );
        assert.equal(
          (yield* snapshotQuery.getCodexSteerIntentRecoveryBarriers({
            sequence: crashClientSequence,
            threadId: ThreadId.make(recoveryThreadId),
            messageId: MessageId.make("message-tuple-collision"),
            expectedTurnId: TurnId.make("turn-unsettled-intents"),
          })).intentVerified,
          false,
        );
      }),
  );

  it.effect("normalizes active-turn session state from the latest turn", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-session-normalize',
          'Project',
          '/tmp/project-session-normalize',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-04T00:00:00.000Z',
          '2026-04-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-session-normalize',
          'project-session-normalize',
          'Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          NULL,
          0,
          0,
          0,
          '2026-04-04T00:00:00.000Z',
          '2026-04-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-session-normalize',
          'turn-running',
          NULL,
          NULL,
          'running',
          '2026-04-04T00:00:01.000Z',
          '2026-04-04T00:00:02.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-session-normalize',
          'ready',
          'codex',
          'codex',
          'full-access',
          'turn-running',
          NULL,
          '2026-04-04T00:00:03.000Z'
        )
      `;

      const runningShell = yield* snapshotQuery.getThreadShellById(
        ThreadId.make("thread-session-normalize"),
      );
      assert.equal(runningShell._tag, "Some");
      if (runningShell._tag === "Some") {
        assert.equal(runningShell.value.session?.status, "running");
        assert.equal(runningShell.value.session?.activeTurnId, asTurnId("turn-running"));
      }

      yield* sql`
        UPDATE projection_turns
        SET state = 'completed',
            completed_at = '2026-04-04T00:00:04.000Z'
        WHERE thread_id = 'thread-session-normalize'
          AND turn_id = 'turn-running'
      `;

      const completedShell = yield* snapshotQuery.getThreadShellById(
        ThreadId.make("thread-session-normalize"),
      );
      assert.equal(completedShell._tag, "Some");
      if (completedShell._tag === "Some") {
        assert.equal(completedShell.value.session?.status, "ready");
        assert.equal(completedShell.value.session?.activeTurnId, null);
        assert.equal(completedShell.value.session?.updatedAt, "2026-04-04T00:00:04.000Z");
      }

      yield* sql`
        UPDATE projection_thread_sessions
        SET status = 'ready',
            active_turn_id = 'turn-missing'
        WHERE thread_id = 'thread-session-normalize'
      `;

      const missingActiveTurnShell = yield* snapshotQuery.getThreadShellById(
        ThreadId.make("thread-session-normalize"),
      );
      assert.equal(missingActiveTurnShell._tag, "Some");
      if (missingActiveTurnShell._tag === "Some") {
        assert.equal(missingActiveTurnShell.value.session?.status, "ready");
        assert.equal(missingActiveTurnShell.value.session?.activeTurnId, null);
      }
    }),
  );

  it.effect("caps thread detail messages to the latest server-side window", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-message-cap',
          'Project',
          '/tmp/project-message-cap',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-message-cap',
          'project-message-cap',
          'Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        WITH RECURSIVE message_numbers(index_value) AS (
          SELECT 1
          UNION ALL
          SELECT index_value + 1
          FROM message_numbers
          WHERE index_value < ${THREAD_DETAIL_MESSAGE_LIMIT + 5}
        )
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        SELECT
          printf('message-%04d', index_value),
          'thread-message-cap',
          NULL,
          'assistant',
          printf('message %04d', index_value),
          0,
          printf('2026-04-05T%02d:%02d:%02d.000Z', index_value / 3600, (index_value / 60) % 60, index_value % 60),
          printf('2026-04-05T%02d:%02d:%02d.000Z', index_value / 3600, (index_value / 60) % 60, index_value % 60)
        FROM message_numbers
      `;

      const detail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-message-cap"));
      assert.equal(detail._tag, "Some");
      if (detail._tag === "Some") {
        assert.equal(detail.value.messages.length, THREAD_DETAIL_MESSAGE_LIMIT);
        assert.equal(detail.value.messages[0]?.id, "message-0006");
        assert.equal(detail.value.messages.at(-1)?.id, "message-2005");
      }
    }),
  );

  it.effect("bounds latest task-plan retention to the thread-and-kind index", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      // Exercise both pathological shapes observed in mature real profiles:
      // a plan that fell far outside the bounded activity tail, and a thread
      // that never emitted a plan at all. The deterministic plan assertion is
      // the primary regression guard; the wall-clock budget catches accidental
      // synchronous work added around this already-bounded lookup.
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-mature-plan-index',
          'Mature plan index project',
          '/tmp/project-mature-plan-index',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'thread-mature-old-plan',
            'project-mature-plan-index',
            'Mature thread with an old plan',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:00.000Z',
            '2026-04-06T00:00:00.000Z',
            NULL
          ),
          (
            'thread-mature-no-plan',
            'project-mature-plan-index',
            'Mature thread without a plan',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:00.000Z',
            '2026-04-06T00:00:00.000Z',
            NULL
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'mature-old-plan',
          'thread-mature-old-plan',
          NULL,
          'info',
          'turn.plan.updated',
          'Plan updated',
          '{"plan":[{"step":"Retained old plan","status":"inProgress"}]}',
          1,
          '2026-04-06T00:00:01.000Z'
        )
      `;
      yield* sql`
        WITH RECURSIVE activity_numbers(index_value) AS (
          SELECT 1
          UNION ALL
          SELECT index_value + 1
          FROM activity_numbers
          WHERE index_value < 10000
        ),
        mature_threads(thread_id, activity_prefix) AS (
          VALUES
            ('thread-mature-old-plan', 'mature-old-plan-tail'),
            ('thread-mature-no-plan', 'mature-no-plan-tail')
        )
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        SELECT
          printf('%s-%05d', mature_threads.activity_prefix, activity_numbers.index_value),
          mature_threads.thread_id,
          NULL,
          'tool',
          'tool.completed',
          'Mature history activity',
          '{}',
          activity_numbers.index_value + 1,
          '2026-04-06T12:00:00.000Z'
        FROM activity_numbers
        CROSS JOIN mature_threads
      `;

      const latestPlanQueryPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
          INDEXED BY idx_projection_thread_activities_thread_kind_created_id
        WHERE thread_id = 'thread-mature-old-plan'
          AND kind = 'turn.plan.updated'
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
          sequence DESC,
          created_at DESC,
          activity_id DESC
        LIMIT 1
      `;
      const latestPlanQueryPlanText = latestPlanQueryPlan.map((row) => row.detail).join("\n");
      assert.match(
        latestPlanQueryPlanText,
        /idx_projection_thread_activities_thread_kind_created_id/,
      );
      assert.notInclude(latestPlanQueryPlanText, "idx_projection_thread_activities_thread_recent");

      const detailReadStartedAt = performance.now();
      const [oldPlanDetail, noPlanDetail] = yield* Effect.all(
        [
          snapshotQuery.getThreadDetailById(ThreadId.make("thread-mature-old-plan")),
          snapshotQuery.getThreadDetailById(ThreadId.make("thread-mature-no-plan")),
        ],
        { concurrency: 1 },
      );
      const detailReadElapsedMs = performance.now() - detailReadStartedAt;
      assert.isBelow(
        detailReadElapsedMs,
        3000,
        `mature thread detail reads exceeded the synchronous liveness budget (${detailReadElapsedMs.toFixed(1)} ms)`,
      );

      assert.equal(oldPlanDetail._tag, "Some");
      if (oldPlanDetail._tag === "Some") {
        assert.equal(oldPlanDetail.value.activities.length, THREAD_DETAIL_ACTIVITY_LIMIT + 1);
        assert.equal(oldPlanDetail.value.activities[0]?.id, asEventId("mature-old-plan"));
        assert.equal(
          oldPlanDetail.value.activities.filter((activity) => activity.kind === "turn.plan.updated")
            .length,
          1,
        );
      }
      assert.equal(noPlanDetail._tag, "Some");
      if (noPlanDetail._tag === "Some") {
        assert.equal(noPlanDetail.value.activities.length, THREAD_DETAIL_ACTIVITY_LIMIT);
        assert.equal(
          noPlanDetail.value.activities.some((activity) => activity.kind === "turn.plan.updated"),
          false,
        );
      }
    }),
  );

  it.effect("retains task-plan and current-turn subagent state beyond the activity tail cap", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-task-plan-cap',
          'Project',
          '/tmp/project-task-plan-cap',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-07T00:00:00.000Z',
          '2026-04-07T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-task-plan-cap',
          'project-task-plan-cap',
          'Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-task-plan',
          NULL,
          0,
          0,
          0,
          '2026-04-07T00:00:00.000Z',
          '2026-04-07T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'task-plan-obsolete',
            'thread-task-plan-cap',
            'turn-task-plan',
            'info',
            'turn.plan.updated',
            'Plan updated',
            '{"plan":[{"step":"Obsolete","status":"pending"}]}',
            1,
            '2026-04-07T00:00:01.000Z'
          ),
          (
            'task-plan-latest',
            'thread-task-plan-cap',
            'turn-task-plan',
            'info',
            'turn.plan.updated',
            'Plan updated',
            '{"explanation":"Current snapshot","plan":[{"step":"Inspect","status":"completed"},{"step":"Implement","status":"inProgress"}]}',
            2,
            '2026-04-07T00:00:02.000Z'
          ),
          (
            'subagent-start',
            'thread-task-plan-cap',
            'turn-task-plan',
            'info',
            'task.started',
            'Subagent started',
            '{"taskId":"child-1","subagent":{"threadId":"child-1","label":"Audit","status":"active","startedAt":"2026-04-07T00:00:03.000Z"}}',
            3,
            '2026-04-07T00:00:03.000Z'
          ),
          (
            'subagent-progress-obsolete',
            'thread-task-plan-cap',
            'turn-task-plan',
            'info',
            'task.progress',
            'Subagent update',
            '{"taskId":"child-1","detail":"Old progress","subagent":{"threadId":"child-1","status":"active"}}',
            4,
            '2026-04-07T00:00:04.000Z'
          ),
          (
            'subagent-progress-latest',
            'thread-task-plan-cap',
            'turn-task-plan',
            'info',
            'task.progress',
            'Subagent update',
            '{"taskId":"child-1","detail":"Latest progress","subagent":{"threadId":"child-1","status":"active"}}',
            5,
            '2026-04-07T00:00:05.000Z'
          ),
          (
            'subagent-completed',
            'thread-task-plan-cap',
            'turn-task-plan',
            'info',
            'task.completed',
            'Subagent completed',
            '{"taskId":"child-1","status":"completed","subagent":{"threadId":"child-1","status":"completed"}}',
            6,
            '2026-04-07T00:00:06.000Z'
          ),
          (
            'subagent-old-turn-corrupt',
            'thread-task-plan-cap',
            'turn-task-plan-old',
            'info',
            'task.progress',
            'Old subagent update',
            '{malformed legacy payload',
            1,
            '2026-04-06T00:00:01.000Z'
          )
      `;
      yield* sql`
        WITH RECURSIVE activity_numbers(index_value) AS (
          SELECT 1
          UNION ALL
          SELECT index_value + 1
          FROM activity_numbers
          WHERE index_value < ${THREAD_DETAIL_ACTIVITY_LIMIT}
        )
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        SELECT
          printf('task-plan-tail-%04d', index_value),
          'thread-task-plan-cap',
          'turn-task-plan',
          'tool',
          'tool.completed',
          printf('activity %04d', index_value),
          '{}',
          index_value + 6,
          printf(
            '2026-04-07T%02d:%02d:%02d.000Z',
            (index_value + 6) / 3600,
            ((index_value + 6) / 60) % 60,
            (index_value + 6) % 60
          )
        FROM activity_numbers
      `;

      const detail = yield* snapshotQuery.getThreadDetailById(
        ThreadId.make("thread-task-plan-cap"),
      );
      // A current-turn lifecycle lookup must not JSON-parse task rows from an
      // older turn. Besides tolerating a corrupt legacy payload, this proves
      // the query is constrained to the indexed thread+turn range instead of
      // scanning an arbitrarily long thread history on every subscription.
      assert.equal(detail._tag, "Some");
      if (detail._tag === "Some") {
        const activities = detail.value.activities;
        assert.equal(activities.length, THREAD_DETAIL_ACTIVITY_LIMIT + 4);
        assert.equal(activities[0]?.id, asEventId("task-plan-latest"));
        assert.equal(
          activities.filter((activity) => activity.kind === "turn.plan.updated").length,
          1,
        );
        assert.equal(
          activities.some((activity) => activity.id === asEventId("task-plan-obsolete")),
          false,
        );
        assert.equal(
          activities.some((activity) => activity.id === asEventId("subagent-progress-obsolete")),
          false,
        );
        assert.deepEqual(
          activities
            .filter((activity) => activity.kind.startsWith("task."))
            .map((activity) => activity.id),
          [
            asEventId("subagent-start"),
            asEventId("subagent-progress-latest"),
            asEventId("subagent-completed"),
          ],
        );
      }

      yield* sql`
        WITH RECURSIVE subagent_numbers(index_value) AS (
          SELECT 0
          UNION ALL
          SELECT index_value + 1
          FROM subagent_numbers
          WHERE index_value < ${MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN}
        )
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        SELECT
          printf('subagent-cardinality-%05d', index_value),
          'thread-task-plan-cap',
          'turn-task-plan',
          'info',
          'task.started',
          'Subagent started',
          printf(
            '{"taskId":"cardinality-%05d","subagent":{"threadId":"cardinality-%05d","status":"active"}}',
            index_value,
            index_value
          ),
          index_value + 10000,
          '2026-04-07T12:00:00.000Z'
        FROM subagent_numbers
      `;

      const cappedDetail = yield* snapshotQuery.getThreadDetailById(
        ThreadId.make("thread-task-plan-cap"),
      );
      assert.equal(cappedDetail._tag, "Some");
      if (cappedDetail._tag === "Some") {
        const activities = cappedDetail.value.activities;
        assert.equal(
          activities.filter((activity) => activity.kind === "task.started").length,
          MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN,
        );
        assert.equal(activities.length, MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN + 1);
        assert.equal(
          activities.some((activity) => activity.id === asEventId("subagent-cardinality-00000")),
          false,
        );
        assert.equal(
          activities.some(
            (activity) =>
              activity.id ===
              asEventId(
                `subagent-cardinality-${String(MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN).padStart(5, "0")}`,
              ),
          ),
          true,
        );
      }
    }),
  );

  it.effect("pages turn activity directly from SQLite outside the thread detail snapshot cap", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;

      yield* sql`
        WITH RECURSIVE activity_numbers(index_value) AS (
          SELECT 1
          UNION ALL
          SELECT index_value + 1
          FROM activity_numbers
          WHERE index_value < 10
        )
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        SELECT
          printf('turn-page-activity-%02d', index_value),
          'thread-turn-page',
          'turn-page',
          'tool',
          'tool.completed',
          printf('activity %02d', index_value),
          '{}',
          index_value,
          printf('2026-04-06T00:00:%02d.000Z', index_value)
        FROM activity_numbers
      `;

      const page = yield* snapshotQuery.getThreadTurnActivityPage({
        threadId: ThreadId.make("thread-turn-page"),
        turnId: TurnId.make("turn-page"),
        offset: 3,
        limit: 4,
      });

      assert.equal(page.totalCount, 10);
      assert.equal(page.offset, 3);
      assert.equal(page.activities.length, 4);
      assert.deepStrictEqual(
        page.activities.map((activity) => activity.id),
        [
          "turn-page-activity-04",
          "turn-page-activity-05",
          "turn-page-activity-06",
          "turn-page-activity-07",
        ],
      );
      assert.deepStrictEqual(
        page.activities.map((activity) => activity.sequence),
        [4, 5, 6, 7],
      );
    }),
  );

  it.effect("binds subagent detail authorization to the exact persisted thread and turn", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'subagent-binding-a',
            'thread-a',
            'turn-a',
            'info',
            'task.completed',
            'Subagent completed',
            '{"taskId":"task-a","subagent":{"threadId":"child-a","historyId":"history-a","status":"completed"}}',
            1,
            '2026-04-06T00:00:01.000Z'
          ),
          (
            'subagent-binding-b',
            'thread-b',
            'turn-b',
            'info',
            'task.progress',
            'Subagent working',
            '{"taskId":"task-b","subagent":{"threadId":"child-a","historyId":"history-b","status":"active"}}',
            2,
            '2026-04-06T00:00:02.000Z'
          ),
          (
            'subagent-binding-sibling',
            'thread-a',
            'turn-a',
            'info',
            'task.progress',
            'Sibling subagent working',
            '{"taskId":"task-sibling","subagent":{"threadId":"child-sibling","historyId":"history-sibling","status":"active"}}',
            3,
            '2026-04-06T00:00:03.000Z'
          ),
          (
            'subagent-binding-legacy',
            'thread-a',
            'turn-a',
            'info',
            'task.completed',
            'Legacy subagent completed',
            '{"taskId":"task-legacy","subagent":{"threadId":"child-legacy","status":"completed"}}',
            4,
            '2026-04-06T00:00:04.000Z'
          ),
          (
            'non-task-payload',
            'thread-a',
            'turn-a',
            'tool',
            'tool.completed',
            'Unrelated tool',
            '{"subagent":{"threadId":"tool-only-child"}}',
            5,
            '2026-04-06T00:00:05.000Z'
          )
      `;

      const hasExactBinding = yield* snapshotQuery.hasThreadTurnSubagentActivity({
        threadId: ThreadId.make("thread-a"),
        turnId: TurnId.make("turn-a"),
        subagentId: "child-a",
      });
      assert.equal(hasExactBinding, true);

      const hasExactHistoryBinding = yield* snapshotQuery.hasThreadTurnSubagentActivity({
        threadId: ThreadId.make("thread-a"),
        turnId: TurnId.make("turn-a"),
        subagentId: "child-a",
        historyId: "history-a",
      });
      assert.equal(hasExactHistoryBinding, true);

      const hasLegacyBindingWithoutHistory = yield* snapshotQuery.hasThreadTurnSubagentActivity({
        threadId: ThreadId.make("thread-a"),
        turnId: TurnId.make("turn-a"),
        subagentId: "child-legacy",
      });
      assert.equal(hasLegacyBindingWithoutHistory, true);

      for (const input of [
        { threadId: "thread-a", turnId: "turn-b", subagentId: "child-a" },
        { threadId: "thread-b", turnId: "turn-a", subagentId: "child-a" },
        { threadId: "thread-a", turnId: "turn-a", subagentId: "tool-only-child" },
        { threadId: "thread-a", turnId: "turn-a", subagentId: "child-a' OR 1=1 --" },
      ] as const) {
        const authorized = yield* snapshotQuery.hasThreadTurnSubagentActivity({
          threadId: ThreadId.make(input.threadId),
          turnId: TurnId.make(input.turnId),
          subagentId: input.subagentId,
        });
        assert.equal(authorized, false);
      }

      for (const input of [
        {
          subagentId: "child-a",
          historyId: "history-sibling",
        },
        {
          subagentId: "child-sibling",
          historyId: "history-a",
        },
        {
          subagentId: "child-legacy",
          historyId: "history-a",
        },
        {
          subagentId: "child-a",
          historyId: "history-a' OR 1=1 --",
        },
      ] as const) {
        const authorized = yield* snapshotQuery.hasThreadTurnSubagentActivity({
          threadId: ThreadId.make("thread-a"),
          turnId: TurnId.make("turn-a"),
          subagentId: input.subagentId,
          historyId: input.historyId,
        });
        assert.equal(authorized, false);
      }
    }),
  );

  it.effect("excludes non-rendered work-log activity from turn activity pages", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'hidden-context-window',
            'thread-turn-visible-page',
            'turn-visible-page',
            'info',
            'context-window.updated',
            'Context window updated',
            '{}',
            1,
            '2026-04-06T00:00:01.000Z'
          ),
          (
            'hidden-checkpoint',
            'thread-turn-visible-page',
            'turn-visible-page',
            'info',
            'checkpoint.captured',
            'Checkpoint captured',
            '{}',
            2,
            '2026-04-06T00:00:02.000Z'
          ),
          (
            'hidden-task-started',
            'thread-turn-visible-page',
            'turn-visible-page',
            'info',
            'task.started',
            'Task started',
            '{}',
            3,
            '2026-04-06T00:00:03.000Z'
          ),
          (
            'hidden-tool-started',
            'thread-turn-visible-page',
            'turn-visible-page',
            'tool',
            'tool.started',
            'Read started',
            '{"itemType":"file_read"}',
            4,
            '2026-04-06T00:00:04.000Z'
          ),
          (
            'hidden-plan-boundary',
            'thread-turn-visible-page',
            'turn-visible-page',
            'tool',
            'tool.completed',
            'Exit plan mode',
            '{"detail":"ExitPlanMode: proposed plan"}',
            5,
            '2026-04-06T00:00:05.000Z'
          ),
          (
            'hidden-retryable-steer',
            'thread-turn-visible-page',
            'turn-visible-page',
            'info',
            'provider.turn.steer.failed',
            'Provider steer queued',
            '{"retryableFollowUp":true}',
            6,
            '2026-04-06T00:00:06.000Z'
          ),
          (
            'visible-context-compaction',
            'thread-turn-visible-page',
            'turn-visible-page',
            'tool',
            'tool.started',
            'Context compaction started',
            '{"itemType":"context_compaction"}',
            7,
            '2026-04-06T00:00:07.000Z'
          ),
          (
            'visible-tool-completed',
            'thread-turn-visible-page',
            'turn-visible-page',
            'tool',
            'tool.completed',
            'Read file',
            '{"detail":"Read src/index.ts"}',
            8,
            '2026-04-06T00:00:08.000Z'
          ),
          (
            'hidden-only-context-window',
            'thread-turn-visible-page',
            'turn-hidden-only',
            'info',
            'context-window.updated',
            'Context window updated',
            '{}',
            9,
            '2026-04-06T00:00:09.000Z'
          )
      `;

      const page = yield* snapshotQuery.getThreadTurnActivityPage({
        threadId: ThreadId.make("thread-turn-visible-page"),
        turnId: TurnId.make("turn-visible-page"),
        offset: 0,
        limit: 10,
      });

      assert.equal(page.totalCount, 2);
      assert.deepStrictEqual(
        page.activities.map((activity) => activity.id),
        ["visible-context-compaction", "visible-tool-completed"],
      );

      const presence = yield* snapshotQuery.getThreadTurnWorkLogPresence({
        threadId: ThreadId.make("thread-turn-visible-page"),
        turnIds: [
          TurnId.make("turn-visible-page"),
          TurnId.make("turn-hidden-only"),
          TurnId.make("turn-without-activity"),
          TurnId.make("turn-visible-page"),
        ],
      });

      assert.deepStrictEqual(presence.turnIdsWithWorkLog, [TurnId.make("turn-visible-page")]);
    }),
  );

  it.effect(
    "keeps structured subagents out of historical Work Log pages, counts, and presence",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_thread_activities`;

        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES
            (
              'subagent-only-started',
              'thread-work-log-subagents',
              'turn-subagent-only',
              'info',
              'task.started',
              'Subagent started',
              '{"subagent":{"threadId":"child-only","status":"active"}}',
              1,
              '2026-04-06T01:00:01.000Z'
            ),
            (
              'subagent-only-progress',
              'thread-work-log-subagents',
              'turn-subagent-only',
              'info',
              'task.progress',
              'Subagent working',
              '{"subagent":{"threadId":"child-only","status":"active"}}',
              2,
              '2026-04-06T01:00:02.000Z'
            ),
            (
              'subagent-only-completed',
              'thread-work-log-subagents',
              'turn-subagent-only',
              'info',
              'task.completed',
              'Subagent completed',
              '{"subagent":{"threadId":"child-only","status":"completed"}}',
              3,
              '2026-04-06T01:00:03.000Z'
            ),
            (
              'mixed-ordinary-progress',
              'thread-work-log-subagents',
              'turn-mixed-work',
              'info',
              'task.progress',
              'Ordinary task progress',
              '{"taskId":"ordinary-task"}',
              1,
              '2026-04-06T02:00:01.000Z'
            ),
            (
              'mixed-subagent-progress',
              'thread-work-log-subagents',
              'turn-mixed-work',
              'info',
              'task.progress',
              'Subagent progress',
              '{"subagent":{"threadId":"child-mixed","status":"active"}}',
              2,
              '2026-04-06T02:00:02.000Z'
            ),
            (
              'mixed-ordinary-tool',
              'thread-work-log-subagents',
              'turn-mixed-work',
              'tool',
              'tool.completed',
              'Read file',
              '{"detail":"Read src/index.ts"}',
              3,
              '2026-04-06T02:00:03.000Z'
            ),
            (
              'mixed-subagent-completed',
              'thread-work-log-subagents',
              'turn-mixed-work',
              'info',
              'task.completed',
              'Subagent completed',
              '{"subagent":{"threadId":"child-mixed","status":"completed"}}',
              4,
              '2026-04-06T02:00:04.000Z'
            ),
            (
              'mixed-ordinary-completed',
              'thread-work-log-subagents',
              'turn-mixed-work',
              'info',
              'task.completed',
              'Ordinary task completed',
              '{"taskId":"ordinary-task","status":"completed"}',
              5,
              '2026-04-06T02:00:05.000Z'
            ),
            (
              'mixed-subagent-started',
              'thread-work-log-subagents',
              'turn-mixed-work',
              'info',
              'task.started',
              'Subagent started',
              '{"subagent":{"threadId":"child-second","status":"active"}}',
              6,
              '2026-04-06T02:00:06.000Z'
            ),
            (
              'mixed-context-compaction',
              'thread-work-log-subagents',
              'turn-mixed-work',
              'tool',
              'tool.started',
              'Context compaction started',
              '{"itemType":"context_compaction"}',
              7,
              '2026-04-06T02:00:07.000Z'
            ),
            (
              'mixed-ordinary-started',
              'thread-work-log-subagents',
              'turn-mixed-work',
              'info',
              'task.started',
              'Ordinary task started',
              '{"taskId":"ordinary-task"}',
              8,
              '2026-04-06T02:00:08.000Z'
            )
        `;

        const subagentOnlyPage = yield* snapshotQuery.getThreadTurnActivityPage({
          threadId: ThreadId.make("thread-work-log-subagents"),
          turnId: TurnId.make("turn-subagent-only"),
          offset: 0,
          limit: 10,
        });
        assert.equal(subagentOnlyPage.totalCount, 0);
        assert.deepStrictEqual(subagentOnlyPage.activities, []);

        // Offset and limit are applied after the common display predicate, so
        // hidden subagent lifecycle rows cannot create sparse or empty pages.
        const mixedPage = yield* snapshotQuery.getThreadTurnActivityPage({
          threadId: ThreadId.make("thread-work-log-subagents"),
          turnId: TurnId.make("turn-mixed-work"),
          offset: 1,
          limit: 2,
        });
        assert.equal(mixedPage.totalCount, 4);
        assert.deepStrictEqual(
          mixedPage.activities.map((activity) => activity.id),
          ["mixed-ordinary-tool", "mixed-ordinary-completed"],
        );

        const presence = yield* snapshotQuery.getThreadTurnWorkLogPresence({
          threadId: ThreadId.make("thread-work-log-subagents"),
          turnIds: [TurnId.make("turn-subagent-only"), TurnId.make("turn-mixed-work")],
        });
        assert.deepStrictEqual(presence.turnIdsWithWorkLog, [TurnId.make("turn-mixed-work")]);
      }),
  );

  it.effect("keeps deleted project and thread tombstones in the command read model", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-deleted',
          'Deleted Project',
          '/tmp/deleted-project',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:01.000Z',
          '2026-04-05T00:00:02.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-deleted',
          'project-deleted',
          'Deleted Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-deleted',
          NULL,
          0,
          0,
          0,
          '2026-04-05T00:00:03.000Z',
          '2026-04-05T00:00:04.000Z',
          NULL,
          '2026-04-05T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-deleted',
          'turn-deleted',
          'message-deleted-user',
          NULL,
          NULL,
          'message-deleted-assistant',
          'completed',
          '2026-04-05T00:00:04.100Z',
          '2026-04-05T00:00:04.200Z',
          '2026-04-05T00:00:04.300Z',
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.projects[0]?.id, asProjectId("project-deleted"));
      assert.equal(commandReadModel.projects[0]?.deletedAt, "2026-04-05T00:00:02.000Z");
      assert.equal(commandReadModel.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(commandReadModel.threads[0]?.deletedAt, "2026-04-05T00:00:05.000Z");
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "completed");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "completed");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.projects.length, 0);
      assert.equal(shellSnapshot.threads.length, 0);
    }),
  );
});

it.effect(
  "ProjectionSnapshotQuery dedupes repository identity resolution by workspace root and skips deleted projects for shell snapshots",
  () => {
    const resolveCalls: string[] = [];
    const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provideMerge(
        Layer.succeed(RepositoryIdentityResolver, {
          resolve: (cwd: string) =>
            Effect.sync(() => {
              resolveCalls.push(cwd);
              return {
                canonicalKey: `github.com/acme${cwd}`,
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: `https://github.com/acme${cwd}.git`,
                },
                rootPath: cwd,
              };
            }),
        }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    return Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-1',
            'Shared Project 1',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:00.000Z',
            '2026-04-04T00:00:01.000Z',
            NULL
          ),
          (
            'project-2',
            'Shared Project 2',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:02.000Z',
            '2026-04-04T00:00:03.000Z',
            NULL
          ),
          (
            'project-3',
            'Deleted Project',
            '/tmp/deleted-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:04.000Z',
            '2026-04-04T00:00:05.000Z',
            '2026-04-04T00:00:06.000Z'
          )
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/shared-root"]);
      assert.equal(shellSnapshot.projects.length, 2);
      assert.equal(shellSnapshot.projects[0]?.repositoryIdentity?.rootPath, "/tmp/shared-root");
      assert.equal(shellSnapshot.projects[1]?.repositoryIdentity?.rootPath, "/tmp/shared-root");

      resolveCalls.length = 0;

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/deleted-root", "/tmp/shared-root"]);
      assert.equal(fullSnapshot.projects.length, 3);
      assert.equal(fullSnapshot.projects[2]?.repositoryIdentity?.rootPath, "/tmp/deleted-root");
    }).pipe(Effect.provide(layer));
  },
);
