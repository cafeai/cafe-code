import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import migration from "./091_CodexTransientRecoveryIntents.ts";

it.layer(TestSqliteClient.layerMemory())("091_CodexTransientRecoveryIntents", (it) => {
  it.effect("does not backfill and indexes only exact new server transient intents", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 90 });
      let version = 0;
      const insert = (actor: string, payload: object) => {
        version += 1;
        return sql`
        INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version,
          event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
        VALUES (${`intent-${version}`}, 'thread', 'thread', ${version}, 'thread.turn-start-requested',
          '2026-10-10T00:00:00.000Z', ${`command-${version}`}, NULL, NULL, ${actor}, ${JSON.stringify(payload)}, '{}')
      `;
      };
      const payload = { threadId: "thread", runtimeRecovery: { codexTransientFailure: {} } };
      yield* insert("server", payload);
      yield* migration;
      assert.deepStrictEqual(
        yield* sql`SELECT sequence FROM orchestration_codex_transient_recovery_intents`,
        [],
      );
      yield* insert("client", payload);
      yield* insert("provider", payload);
      yield* insert("server", { ...payload, threadId: "peer" });
      yield* insert("server", { threadId: "thread", runtimeRecovery: {} });
      yield* insert("server", payload);
      assert.deepStrictEqual(
        yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM orchestration_codex_transient_recovery_intents`,
        [{ sequence: 6 }],
      );
      const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN SELECT sequence FROM orchestration_codex_transient_recovery_intents
        INDEXED BY idx_codex_transient_recovery_intents_thread_sequence
      WHERE thread_id = 'thread' ORDER BY sequence DESC LIMIT 1
    `;
      assert.include(
        plan.map((row) => row.detail).join("\n"),
        "idx_codex_transient_recovery_intents_thread_sequence",
      );
      assert.notInclude(plan.map((row) => row.detail).join("\n"), "TEMP B-TREE");
      yield* migration;
      assert.deepStrictEqual(
        yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM orchestration_codex_transient_recovery_intents`,
        [{ sequence: 6 }],
      );
    }),
  );

  it.effect(
    "indexes only new exact server failure markers and keeps intent-only lookups indexed",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        const [latest] = yield* sql<{ readonly version: number }>`
      SELECT COALESCE(MAX(stream_version), 0) AS version FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = 'failure-thread'`;
        let version = latest?.version ?? 0;
        const insert = (actor: string, payload: object) => {
          version += 1;
          return sql`
        INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version,
          event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
        VALUES (${`failure-${version}`}, 'thread', 'failure-thread', ${version}, 'thread.activity-appended',
          '2026-10-10T00:00:00.000Z', ${`failure-command-${version}`}, NULL, NULL, ${actor}, ${JSON.stringify(payload)}, '{}')
      `;
        };
        const activity = {
          kind: "runtime.warning",
          turnId: "failed-root",
          payload: { recovery: "codex-transient-root-failed" },
        };
        yield* insert("provider", { threadId: "failure-thread", activity });
        yield* insert("client", { threadId: "failure-thread", activity });
        yield* insert("server", { threadId: "foreign-thread", activity });
        yield* insert("server", {
          threadId: "failure-thread",
          activity: { ...activity, turnId: null },
        });
        yield* insert("server", {
          threadId: "failure-thread",
          activity: { ...activity, kind: "runtime.error" },
        });
        yield* insert("server", { threadId: "failure-thread", activity });
        const rows = yield* sql<{ readonly sourceKind: string }>`
      SELECT source_kind AS "sourceKind" FROM orchestration_codex_transient_recovery_intents
      WHERE thread_id = 'failure-thread'`;
        assert.deepStrictEqual(rows, [{ sourceKind: "failure" }]);
        const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN SELECT sequence FROM orchestration_codex_transient_recovery_intents
        INDEXED BY idx_codex_transient_recovery_intents_thread_kind_sequence
      WHERE thread_id = 'failure-thread' AND source_kind = 'intent' ORDER BY sequence DESC LIMIT 1`;
        assert.include(
          plan.map((row) => row.detail).join("\n"),
          "idx_codex_transient_recovery_intents_thread_kind_sequence",
        );
        assert.notInclude(plan.map((row) => row.detail).join("\n"), "TEMP B-TREE");
      }),
  );
});
