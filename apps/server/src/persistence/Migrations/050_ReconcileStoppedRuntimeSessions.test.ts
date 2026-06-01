import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_ReconcileStoppedRuntimeSessions", (it) => {
  it.effect("interrupts orphan running turns when the runtime is stopped", () =>
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
            'thread-orphan-stopped',
            'project',
            'orphan stopped',
            NULL,
            NULL,
            'turn-orphan',
            '2026-06-01T09:00:00.000Z',
            '2026-06-01T09:59:00.000Z'
          ),
          (
            'thread-runtime-active',
            'project',
            'runtime active',
            NULL,
            NULL,
            'turn-active',
            '2026-06-01T09:00:00.000Z',
            '2026-06-01T09:59:00.000Z'
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
            'thread-orphan-stopped',
            'ready',
            'codex',
            'codex',
            'full-access',
            NULL,
            NULL,
            '2026-06-01T09:51:00.000Z'
          ),
          (
            'thread-runtime-active',
            'running',
            'codex',
            'codex',
            'full-access',
            'turn-active',
            NULL,
            '2026-06-01T09:51:00.000Z'
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
            'thread-orphan-stopped',
            'codex',
            'codex',
            'full-access',
            'stopped',
            '2026-06-01T09:51:00.000Z',
            '{"threadId":"codex-thread"}',
            '{"activeTurnId":null,"lastRuntimeEvent":"provider.stopAll"}',
            'codex'
          ),
          (
            'thread-runtime-active',
            'codex',
            'codex',
            'full-access',
            'running',
            '2026-06-01T09:51:00.000Z',
            '{"threadId":"codex-thread-active"}',
            '{"activeTurnId":"turn-active","lastRuntimeEvent":"turn.started"}',
            'codex'
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
            'thread-orphan-stopped',
            'turn-orphan',
            'user-orphan',
            'assistant-orphan-streaming',
            'running',
            '2026-06-01T09:20:00.000Z',
            '2026-06-01T09:20:01.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-orphan-stopped',
            'turn-after-stop',
            'user-after-stop',
            'assistant-after-stop',
            'running',
            '2026-06-01T09:52:00.000Z',
            '2026-06-01T09:52:01.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-runtime-active',
            'turn-active',
            'user-active',
            'assistant-active-streaming',
            'running',
            '2026-06-01T09:20:00.000Z',
            '2026-06-01T09:20:01.000Z',
            NULL,
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
            'assistant-orphan-streaming',
            'thread-orphan-stopped',
            'turn-orphan',
            'assistant',
            'orphan partial text',
            NULL,
            1,
            '2026-06-01T09:20:02.000Z',
            '2026-06-01T09:20:03.000Z'
          ),
          (
            'assistant-after-stop',
            'thread-orphan-stopped',
            'turn-after-stop',
            'assistant',
            'newer partial text',
            NULL,
            1,
            '2026-06-01T09:52:02.000Z',
            '2026-06-01T09:52:03.000Z'
          ),
          (
            'assistant-active-streaming',
            'thread-runtime-active',
            'turn-active',
            'assistant',
            'active partial text',
            NULL,
            1,
            '2026-06-01T09:20:02.000Z',
            '2026-06-01T09:20:03.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 50 });

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
        ORDER BY thread_id ASC, turn_id ASC
      `;

      assert.deepStrictEqual(turns, [
        {
          threadId: "thread-orphan-stopped",
          turnId: "turn-after-stop",
          state: "running",
          completedAt: null,
        },
        {
          threadId: "thread-orphan-stopped",
          turnId: "turn-orphan",
          state: "interrupted",
          completedAt: "2026-06-01T09:51:00.000Z",
        },
        {
          threadId: "thread-runtime-active",
          turnId: "turn-active",
          state: "running",
          completedAt: null,
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
          messageId: "assistant-active-streaming",
          isStreaming: 1,
          updatedAt: "2026-06-01T09:20:03.000Z",
        },
        {
          messageId: "assistant-after-stop",
          isStreaming: 1,
          updatedAt: "2026-06-01T09:52:03.000Z",
        },
        {
          messageId: "assistant-orphan-streaming",
          isStreaming: 0,
          updatedAt: "2026-06-01T09:51:00.000Z",
        },
      ]);
    }),
  );
});
