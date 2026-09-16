import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import Migration0077 from "./077_RuntimeRecoveryControls.ts";

const layer = it.layer(TestSqliteClient.layerMemory());

layer("077_RuntimeRecoveryControls", (it) => {
  it.effect(
    "records a completeness fence without backfill and indexes only explicit controls",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 76 });
        const threadId = "recovery-control-thread";
        const occurredAt = "2026-09-16T00:00:00.000Z";
        let version = 0;
        const insert = (id: string, eventType: string, actor = "client", extra = {}) => {
          version += 1;
          return sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES (${id}, 'thread', ${threadId}, ${version}, ${eventType}, ${occurredAt},
            ${`${actor}:${id}`}, NULL, NULL, ${actor}, ${JSON.stringify({
              threadId,
              createdAt: occurredAt,
              messageId: `message-${id}`,
              ...extra,
            })}, '{}')
        `;
        };
        yield* insert("historical-start", "thread.turn-start-requested");
        yield* Migration0077;
        const [state] = yield* sql<{ readonly floor: number }>`
        SELECT indexed_from_sequence AS floor FROM orchestration_runtime_recovery_control_state
      `;
        assert.equal(state?.floor, 2);
        const [empty] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_runtime_recovery_controls
      `;
        assert.equal(empty?.count, 0);
        yield* insert("start", "thread.turn-start-requested");
        yield* insert("stop", "thread.session-stop-requested");
        yield* insert("synthetic-runtime", "thread.turn-start-requested", "server", {
          runtimeRecovery: {},
        });
        yield* insert("synthetic-steer", "thread.turn-start-requested", "server", {
          terminalSteerRecovery: {},
        });
        yield* insert("provider-forgery", "thread.turn-start-requested", "provider");
        yield* insert("wrong-thread", "thread.turn-start-requested", "client", {
          threadId: "other",
        });
        yield* insert("wrong-time", "thread.turn-start-requested", "client", {
          createdAt: "2026-09-15T00:00:00.000Z",
        });
        yield* insert("steer", "thread.turn-steer-requested");
        yield* insert("interrupt", "thread.turn-interrupt-requested", "client", { turnId: "turn" });
        yield* insert("title", "thread.meta-updated", "server", { title: "Automatic title" });
        yield* insert("settings", "thread.meta-updated", "client", { branch: "new-branch" });
        const rows = yield* sql<{ readonly id: string }>`
        SELECT event.event_id AS id FROM orchestration_runtime_recovery_controls AS control
        JOIN orchestration_events AS event ON event.sequence = control.sequence
        ORDER BY control.sequence
      `;
        assert.deepStrictEqual(
          rows.map((row) => row.id),
          ["start", "stop", "steer", "interrupt", "settings"],
        );
        const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN SELECT sequence, event_type FROM orchestration_runtime_recovery_controls
          INDEXED BY idx_runtime_recovery_controls_thread_sequence
        WHERE thread_id = ${threadId} AND sequence <= 1000 ORDER BY sequence DESC LIMIT 64
      `;
        assert.include(
          plan.map((row) => row.detail).join("\n"),
          "idx_runtime_recovery_controls_thread_sequence",
        );
        assert.notInclude(plan.map((row) => row.detail).join("\n"), "TEMP B-TREE");
        // Re-entry is idempotent and cannot advance the completeness boundary.
        yield* Migration0077;
        const [again] = yield* sql<{ readonly floor: number }>`
        SELECT indexed_from_sequence AS floor FROM orchestration_runtime_recovery_control_state
      `;
        assert.equal(again?.floor, state?.floor);
      }),
  );
});
