import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_ReconcileStoppedRuntimeSessions", (it) => {
  it.effect("stops projected active turns when the provider runtime is already stopped", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 49 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at
        )
        VALUES
          (
            'thread-runtime-stopped',
            'project',
            'runtime stopped',
            NULL,
            NULL,
            'turn-stale-active',
            '2026-05-26T15:22:39.176Z',
            '2026-05-26T15:22:39.734Z'
          ),
          (
            'thread-runtime-running',
            'project',
            'runtime running',
            NULL,
            NULL,
            'turn-live-active',
            '2026-05-26T15:30:00.000Z',
            '2026-05-26T15:30:01.000Z'
          ),
          (
            'thread-already-stopped',
            'project',
            'already stopped',
            NULL,
            NULL,
            'turn-already-stopped',
            '2026-05-26T15:10:00.000Z',
            '2026-05-26T15:10:10.000Z'
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
          (
            'thread-runtime-stopped',
            'running',
            'codex',
            'codex_astrea',
            'full-access',
            'turn-stale-active',
            NULL,
            '2026-05-26T15:22:39.734Z'
          ),
          (
            'thread-runtime-running',
            'running',
            'codex',
            'codex_astrea',
            'full-access',
            'turn-live-active',
            NULL,
            '2026-05-26T15:30:01.000Z'
          ),
          (
            'thread-already-stopped',
            'stopped',
            'codex',
            'codex_astrea',
            'full-access',
            NULL,
            NULL,
            '2026-05-26T15:10:10.000Z'
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
            'thread-runtime-stopped',
            'turn-stale-active',
            'user-stale',
            'assistant-stale',
            'running',
            '2026-05-26T15:22:39.176Z',
            '2026-05-26T15:22:39.734Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-runtime-running',
            'turn-live-active',
            'user-live',
            'assistant-live',
            'running',
            '2026-05-26T15:30:00.000Z',
            '2026-05-26T15:30:01.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-already-stopped',
            'turn-already-stopped',
            'user-already-stopped',
            'assistant-already-stopped',
            'completed',
            '2026-05-26T15:10:00.000Z',
            '2026-05-26T15:10:01.000Z',
            '2026-05-26T15:10:10.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

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
            'assistant-stale',
            'thread-runtime-stopped',
            'turn-stale-active',
            'assistant',
            'partial text',
            NULL,
            1,
            '2026-05-26T15:22:45.000Z',
            '2026-05-26T15:22:56.000Z'
          ),
          (
            'assistant-live',
            'thread-runtime-running',
            'turn-live-active',
            'assistant',
            'live text',
            NULL,
            1,
            '2026-05-26T15:30:02.000Z',
            '2026-05-26T15:30:03.000Z'
          )
      `;

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json,
          provider_instance_id
        )
        VALUES
          (
            'thread-runtime-stopped',
            'codex',
            'codex',
            'full-access',
            'stopped',
            '2026-05-26T15:38:46.866Z',
            '{"threadId":"codex-thread"}',
            '{"activeTurnId":null,"lastRuntimeEvent":"provider.stopAll"}',
            'codex_astrea'
          ),
          (
            'thread-runtime-running',
            'codex',
            'codex',
            'full-access',
            'running',
            '2026-05-26T15:31:00.000Z',
            '{"threadId":"codex-live-thread"}',
            '{"activeTurnId":"turn-live-active"}',
            'codex_astrea'
          ),
          (
            'thread-already-stopped',
            'codex',
            'codex',
            'full-access',
            'stopped',
            '2026-05-26T15:40:00.000Z',
            '{"threadId":"codex-already-stopped-thread"}',
            '{"activeTurnId":null,"lastRuntimeEvent":"provider.stopAll"}',
            'codex_astrea'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 50 });

      const sessions = yield* sql<{
        readonly threadId: string;
        readonly status: string;
        readonly activeTurnId: string | null;
        readonly updatedAt: string;
      }>`
        SELECT
          thread_id AS "threadId",
          status,
          active_turn_id AS "activeTurnId",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(sessions, [
        {
          threadId: "thread-already-stopped",
          status: "stopped",
          activeTurnId: null,
          updatedAt: "2026-05-26T15:10:10.000Z",
        },
        {
          threadId: "thread-runtime-running",
          status: "running",
          activeTurnId: "turn-live-active",
          updatedAt: "2026-05-26T15:30:01.000Z",
        },
        {
          threadId: "thread-runtime-stopped",
          status: "stopped",
          activeTurnId: null,
          updatedAt: "2026-05-26T15:38:46.866Z",
        },
      ]);

      const turns = yield* sql<{
        readonly threadId: string;
        readonly turnId: string;
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          completed_at AS "completedAt"
        FROM projection_turns
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(turns, [
        {
          threadId: "thread-already-stopped",
          turnId: "turn-already-stopped",
          state: "completed",
          completedAt: "2026-05-26T15:10:10.000Z",
        },
        {
          threadId: "thread-runtime-running",
          turnId: "turn-live-active",
          state: "running",
          completedAt: null,
        },
        {
          threadId: "thread-runtime-stopped",
          turnId: "turn-stale-active",
          state: "interrupted",
          completedAt: "2026-05-26T15:38:46.866Z",
        },
      ]);

      const messages = yield* sql<{
        readonly messageId: string;
        readonly isStreaming: number;
        readonly updatedAt: string;
      }>`
        SELECT
          message_id AS "messageId",
          is_streaming AS "isStreaming",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY message_id ASC
      `;

      assert.deepStrictEqual(messages, [
        {
          messageId: "assistant-live",
          isStreaming: 1,
          updatedAt: "2026-05-26T15:30:03.000Z",
        },
        {
          messageId: "assistant-stale",
          isStreaming: 0,
          updatedAt: "2026-05-26T15:38:46.866Z",
        },
      ]);

      const threads = yield* sql<{
        readonly threadId: string;
        readonly updatedAt: string;
      }>`
        SELECT
          thread_id AS "threadId",
          updated_at AS "updatedAt"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(threads, [
        {
          threadId: "thread-already-stopped",
          updatedAt: "2026-05-26T15:10:10.000Z",
        },
        {
          threadId: "thread-runtime-running",
          updatedAt: "2026-05-26T15:30:01.000Z",
        },
        {
          threadId: "thread-runtime-stopped",
          updatedAt: "2026-05-26T15:38:46.866Z",
        },
      ]);
    }),
  );
});
