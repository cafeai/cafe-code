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
