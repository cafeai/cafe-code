import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import Migration0072 from "./072_CodexSteerControlBarrierLedger.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("072_CodexSteerControlBarrierLedger", (it) => {
  it.effect("indexes only authenticated post-migration Stop controls without a history scan", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = "thread-codex-steer-control-ledger";
      const historicalAt = "2026-09-01T01:00:00.000Z";

      yield* runMigrations({ toMigrationInclusive: 71 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json,
          metadata_json
        ) VALUES (
          'historical-control-before-ledger', 'thread', ${threadId}, 0,
          'thread.turn-interrupt-requested', ${historicalAt}, 'client:historical-control',
          NULL, NULL, 'client', ${JSON.stringify({
            threadId,
            turnId: "turn-historical",
            createdAt: historicalAt,
          })}, '{}'
        )
      `;
      const [historical] = yield* sql<{ readonly sequence: number }>`
        SELECT sequence
        FROM orchestration_events
        WHERE event_id = 'historical-control-before-ledger'
      `;
      assert.isDefined(historical);

      // Migration 72 records only a high-water completeness fence. It must
      // never backfill the production event journal during backend startup.
      yield* Migration0072;
      const [state] = yield* sql<{ readonly indexedFromSequence: number }>`
        SELECT indexed_from_sequence AS "indexedFromSequence"
        FROM orchestration_codex_steer_control_barrier_state
        WHERE singleton = 1
      `;
      assert.deepStrictEqual(state, { indexedFromSequence: historical.sequence + 1 });
      const [historicalBarrierCount] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_codex_steer_control_barriers
      `;
      assert.equal(historicalBarrierCount?.count, 0);

      const insertControl = (input: {
        readonly eventId: string;
        readonly streamVersion: number;
        readonly eventType: "thread.turn-interrupt-requested" | "thread.session-stop-requested";
        readonly actorKind: "client" | "server" | "provider";
        readonly occurredAt: string;
        readonly payload: unknown;
      }) => sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json,
          metadata_json
        ) VALUES (
          ${input.eventId}, 'thread', ${threadId}, ${input.streamVersion}, ${input.eventType},
          ${input.occurredAt}, ${`${input.actorKind}:${input.eventId}`}, NULL, NULL,
          ${input.actorKind}, ${JSON.stringify(input.payload)}, '{}'
        )
      `;
      const interruptAt = "2026-09-01T01:00:01.000Z";
      const stopAt = "2026-09-01T01:00:02.000Z";
      yield* insertControl({
        eventId: "indexed-interrupt",
        streamVersion: 1,
        eventType: "thread.turn-interrupt-requested",
        actorKind: "client",
        occurredAt: interruptAt,
        payload: { threadId, turnId: "turn-indexed", createdAt: interruptAt },
      });
      yield* insertControl({
        eventId: "indexed-session-stop",
        streamVersion: 2,
        eventType: "thread.session-stop-requested",
        actorKind: "server",
        occurredAt: stopAt,
        payload: { threadId, createdAt: stopAt },
      });
      yield* insertControl({
        eventId: "forged-provider-interrupt",
        streamVersion: 3,
        eventType: "thread.turn-interrupt-requested",
        actorKind: "provider",
        occurredAt: interruptAt,
        payload: { threadId, turnId: "turn-indexed", createdAt: interruptAt },
      });
      yield* insertControl({
        eventId: "wrong-thread-session-stop",
        streamVersion: 4,
        eventType: "thread.session-stop-requested",
        actorKind: "client",
        occurredAt: stopAt,
        payload: { threadId: "another-thread", createdAt: stopAt },
      });
      yield* insertControl({
        eventId: "wrong-time-interrupt",
        streamVersion: 5,
        eventType: "thread.turn-interrupt-requested",
        actorKind: "client",
        occurredAt: interruptAt,
        payload: {
          threadId,
          turnId: "turn-indexed",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      });

      const barriers = yield* sql<{
        readonly eventId: string;
        readonly barrierKind: string;
        readonly turnId: string | null;
      }>`
        SELECT
          source.event_id AS "eventId",
          barrier.barrier_kind AS "barrierKind",
          barrier.turn_id AS "turnId"
        FROM orchestration_codex_steer_control_barriers AS barrier
        INNER JOIN orchestration_events AS source
          ON source.sequence = barrier.sequence
        ORDER BY barrier.sequence ASC
      `;
      assert.deepStrictEqual(barriers, [
        {
          eventId: "indexed-interrupt",
          barrierKind: "thread.turn-interrupt-requested",
          turnId: "turn-indexed",
        },
        {
          eventId: "indexed-session-stop",
          barrierKind: "thread.session-stop-requested",
          turnId: null,
        },
      ]);

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT barrier.sequence
        FROM orchestration_codex_steer_control_barriers AS barrier
          INDEXED BY idx_codex_steer_control_thread_kind_turn_sequence
        CROSS JOIN orchestration_events AS source
          ON source.sequence = barrier.sequence
        WHERE barrier.thread_id = ${threadId}
          AND barrier.barrier_kind = 'thread.turn-interrupt-requested'
          AND barrier.turn_id = 'turn-indexed'
          AND barrier.sequence > ${historical.sequence}
          AND source.actor_kind IN ('client', 'server')
        LIMIT 1
      `;
      const planText = plan.map((row) => row.detail).join("\n");
      assert.include(planText, "idx_codex_steer_control_thread_kind_turn_sequence");
      assert.match(planText, /source.*INTEGER PRIMARY KEY/);
      assert.notInclude(planText, "idx_orch_events_stream_sequence");
    }),
  );
});
