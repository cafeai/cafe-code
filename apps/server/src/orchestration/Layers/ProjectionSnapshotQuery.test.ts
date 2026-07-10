import {
  CheckpointRef,
  EventId,
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
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  OrchestrationProjectionSnapshotQueryLive,
  THREAD_DETAIL_MESSAGE_LIMIT,
} from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

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
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
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
              command: "bun run build",
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
              command: "bun run build",
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
