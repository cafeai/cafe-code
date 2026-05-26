import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("049_RecloseReopenedTerminalTurns", (it) => {
  it.effect(
    "re-closes terminal checkpoint turns and stale non-latest running turns recreated after migration 048",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 48 });

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
            'thread-terminal-reopened',
            'project',
            'terminal reopened',
            NULL,
            NULL,
            'turn-terminal',
            '2026-05-26T06:38:00.000Z',
            '2026-05-26T06:39:00.000Z'
          ),
          (
            'thread-stale-after-048',
            'project',
            'stale after 048',
            NULL,
            NULL,
            'turn-newer-completed',
            '2026-05-26T06:40:00.000Z',
            '2026-05-26T06:50:00.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES
          (
            'thread-terminal-reopened',
            'running',
            'codex',
            'session-terminal',
            'provider-thread-terminal',
            'turn-terminal',
            NULL,
            '2026-05-26T06:38:57.422Z'
          ),
          (
            'thread-stale-after-048',
            'ready',
            'codex',
            'session-stale',
            'provider-thread-stale',
            NULL,
            NULL,
            '2026-05-26T06:50:00.000Z'
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
            'thread-terminal-reopened',
            'turn-terminal',
            'user-terminal',
            'assistant-terminal',
            'running',
            '2026-05-26T06:38:41.956Z',
            '2026-05-26T06:38:42.141Z',
            NULL,
            195,
            'refs/cafe/checkpoints/thread-terminal/turn/195',
            'ready',
            '[]'
          ),
          (
            'thread-stale-after-048',
            'turn-stale-running',
            'user-stale',
            'assistant-stale',
            'running',
            '2026-05-26T06:40:00.000Z',
            '2026-05-26T06:40:01.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-stale-after-048',
            'turn-newer-completed',
            'user-newer',
            'assistant-newer',
            'completed',
            '2026-05-26T06:50:00.000Z',
            '2026-05-26T06:50:01.000Z',
            '2026-05-26T06:50:02.000Z',
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
            'assistant-terminal',
            'thread-terminal-reopened',
            'turn-terminal',
            'assistant',
            'terminal text',
            NULL,
            1,
            '2026-05-26T06:38:49.000Z',
            '2026-05-26T06:38:55.000Z'
          ),
          (
            'assistant-stale',
            'thread-stale-after-048',
            'turn-stale-running',
            'assistant',
            'stale text',
            NULL,
            1,
            '2026-05-26T06:40:03.000Z',
            '2026-05-26T06:40:04.000Z'
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
          'evt-terminal-diff',
          'thread',
          'thread-terminal-reopened',
          1,
          'thread.turn-diff-completed',
          '2026-05-26T06:38:57.000Z',
          'cmd-terminal-diff',
          NULL,
          'cmd-terminal-diff',
          'system',
          '{"threadId":"thread-terminal-reopened","turnId":"turn-terminal","checkpointTurnCount":195,"checkpointRef":"refs/cafe/checkpoints/thread-terminal/turn/195","status":"ready","files":[],"assistantMessageId":"assistant-terminal","completedAt":"2026-05-26T06:38:57.000Z"}',
          '{}'
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 49 });

        const turnRows = yield* sql<{
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
        ORDER BY thread_id ASC, requested_at ASC
      `;

        assert.deepStrictEqual(turnRows, [
          {
            threadId: "thread-stale-after-048",
            turnId: "turn-stale-running",
            state: "interrupted",
            completedAt: "2026-05-26T06:50:00.000Z",
          },
          {
            threadId: "thread-stale-after-048",
            turnId: "turn-newer-completed",
            state: "completed",
            completedAt: "2026-05-26T06:50:02.000Z",
          },
          {
            threadId: "thread-terminal-reopened",
            turnId: "turn-terminal",
            state: "completed",
            completedAt: "2026-05-26T06:38:57.000Z",
          },
        ]);

        const sessionRows = yield* sql<{
          readonly threadId: string;
          readonly status: string;
          readonly activeTurnId: string | null;
          readonly lastError: string | null;
        }>`
        SELECT
          thread_id AS "threadId",
          status,
          active_turn_id AS "activeTurnId",
          last_error AS "lastError"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `;

        assert.deepStrictEqual(sessionRows, [
          {
            threadId: "thread-stale-after-048",
            status: "ready",
            activeTurnId: null,
            lastError: null,
          },
          {
            threadId: "thread-terminal-reopened",
            status: "ready",
            activeTurnId: null,
            lastError: null,
          },
        ]);

        const messageRows = yield* sql<{
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

        assert.deepStrictEqual(messageRows, [
          {
            messageId: "assistant-stale",
            isStreaming: 0,
            updatedAt: "2026-05-26T06:50:00.000Z",
          },
          {
            messageId: "assistant-terminal",
            isStreaming: 0,
            updatedAt: "2026-05-26T06:38:57.000Z",
          },
        ]);
      }),
  );
});
