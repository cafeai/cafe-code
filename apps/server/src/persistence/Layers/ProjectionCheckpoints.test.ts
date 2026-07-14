import { CheckpointRef, ThreadId, TurnId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionCheckpointRepository } from "../Services/ProjectionCheckpoints.ts";
import { ProjectionCheckpointRepositoryLive } from "./ProjectionCheckpoints.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionCheckpointRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionCheckpointRepository", (it) => {
  it.effect("creates an orphan missing provider diff as non-terminal checkpoint metadata", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionCheckpointRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-orphan-provider-diff");
      const turnId = TurnId.make("turn-orphan-provider-diff");

      yield* repository.upsert({
        threadId,
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("provider-diff:event-orphan"),
        status: "missing",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-07-14T00:00:01.000Z",
      });

      const rows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
        readonly checkpointCompletedAt: string | null;
      }>`
        SELECT
          state,
          completed_at AS "completedAt",
          checkpoint_completed_at AS "checkpointCompletedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
      `;
      assert.deepEqual(rows, [
        {
          state: "running",
          completedAt: null,
          checkpointCompletedAt: "2026-07-14T00:00:01.000Z",
        },
      ]);
    }),
  );

  it.effect("does not terminalize an existing running turn for a missing provider diff", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionCheckpointRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-running-provider-diff");
      const turnId = TurnId.make("turn-running-provider-diff");

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
          ${threadId},
          ${turnId},
          NULL,
          NULL,
          NULL,
          'assistant-live',
          'running',
          '2026-07-14T00:00:00.000Z',
          '2026-07-14T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      yield* repository.upsert({
        threadId,
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("provider-diff:event-running"),
        status: "missing",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-07-14T00:00:01.000Z",
      });

      const rows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
        readonly assistantMessageId: string | null;
        readonly checkpointStatus: string | null;
      }>`
        SELECT
          state,
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId",
          checkpoint_status AS "checkpointStatus"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
      `;
      assert.deepEqual(rows, [
        {
          state: "running",
          completedAt: null,
          assistantMessageId: "assistant-live",
          checkpointStatus: "missing",
        },
      ]);
    }),
  );

  it.effect("ignores incomplete checkpoint projection rows", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionCheckpointRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-incomplete-checkpoint");

      yield* repository.upsert({
        threadId,
        turnId: TurnId.make("turn-complete"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("checkpoint-complete"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-03-18T00:00:01.000Z",
      });

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
          ${threadId},
          'turn-incomplete',
          NULL,
          NULL,
          NULL,
          NULL,
          'running',
          '2026-03-18T00:00:02.000Z',
          '2026-03-18T00:00:02.000Z',
          NULL,
          2,
          'checkpoint-incomplete',
          'ready',
          '[]'
        )
      `;

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.checkpointTurnCount, 1);

      const complete = yield* repository.getByThreadAndTurnCount({
        threadId,
        checkpointTurnCount: 1,
      });
      assert.equal(complete._tag, "Some");

      const incomplete = yield* repository.getByThreadAndTurnCount({
        threadId,
        checkpointTurnCount: 2,
      });
      assert.equal(incomplete._tag, "None");
    }),
  );
});
