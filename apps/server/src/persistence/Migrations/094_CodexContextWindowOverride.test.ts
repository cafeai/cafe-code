import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";

it.layer(TestSqliteClient.layerMemory())("094_CodexContextWindowOverride", (it) => {
  it.effect(
    "preserves legacy unknown policy and all prior rows, while fencing exact requested/materialized integers",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 93 });
        yield* sql`INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
      VALUES ('legacy', NULL, 'Legacy', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')`;
        yield* sql`INSERT INTO projection_thread_sessions(thread_id, status, provider_name, provider_instance_id, runtime_mode, active_turn_id, last_error, updated_at)
      VALUES ('legacy', 'ready', 'codex', 'codex', 'approval-required', NULL, NULL, '2026-10-12T00:00:00.000Z')`;
        const objects =
          yield* sql`SELECT name, type, sql FROM sqlite_schema WHERE type IN ('index', 'trigger') ORDER BY name`;
        let eventVersion = 0;
        const appendContextEdit = (id: string, extra: object, actor = "client") => {
          eventVersion += 1;
          return sql`INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
        VALUES (${id}, 'thread', 'legacy', ${eventVersion}, 'thread.meta-updated', '2026-10-12T00:00:00.000Z', ${id}, NULL, NULL, ${actor}, ${JSON.stringify({ threadId: "legacy", ...extra })}, '{}')`;
        };
        yield* appendContextEdit("historical-context", { codexContextWindowOverride: 500_000 });
        yield* runMigrations({ toMigrationInclusive: 94 });
        for (const table of ["projection_threads", "projection_thread_sessions"] as const) {
          assert.deepEqual(
            yield* sql.unsafe(
              `SELECT thread_id, codex_context_window_override, codex_context_window_override_known FROM ${table}`,
            ),
            [
              {
                thread_id: "legacy",
                codex_context_window_override: null,
                codex_context_window_override_known: 0,
              },
            ],
          );
          // Only fixed source-owned table names are interpolated; values stay bound.
          for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            assert.equal(
              (yield* Effect.result(
                sql.unsafe(
                  `UPDATE ${table} SET codex_context_window_override = ?, codex_context_window_override_known = 1`,
                  [value],
                ),
              ))._tag,
              "Failure",
            );
          }
          assert.equal(
            (yield* Effect.result(
              sql.unsafe(
                `UPDATE ${table} SET codex_context_window_override = 500000, codex_context_window_override_known = 0`,
              ),
            ))._tag,
            "Failure",
          );
          yield* sql.unsafe(
            `UPDATE ${table} SET codex_context_window_override = 500000, codex_context_window_override_known = 1`,
          );
          yield* sql.unsafe(
            `UPDATE ${table} SET codex_context_window_override = NULL, codex_context_window_override_known = 1`,
          );
          assert.deepEqual(
            yield* sql.unsafe(
              `SELECT codex_context_window_override, codex_context_window_override_known FROM ${table}`,
            ),
            [{ codex_context_window_override: null, codex_context_window_override_known: 1 }],
          );
        }
        // All previous indexes/triggers remain byte-for-byte unchanged. Only the
        // narrow prospective context-edit recovery-control trigger is added.
        assert.deepEqual(
          yield* sql`SELECT name, type, sql FROM sqlite_schema WHERE type IN ('index', 'trigger') AND name <> 'trg_codex_context_window_recovery_control' ORDER BY name`,
          objects,
        );
        yield* appendContextEdit("numeric-context", { codexContextWindowOverride: 500_000 });
        yield* appendContextEdit("reset-context", { codexContextWindowOverride: null });
        yield* appendContextEdit("foreign-context", {
          threadId: "other",
          codexContextWindowOverride: 500_000,
        });
        yield* appendContextEdit(
          "provider-forgery",
          { codexContextWindowOverride: 500_000 },
          "provider",
        );
        yield* appendContextEdit("title-only", { title: "No configuration change" }, "server");
        assert.deepEqual(
          yield* sql`SELECT event.event_id FROM orchestration_runtime_recovery_controls AS control JOIN orchestration_events AS event ON event.sequence = control.sequence ORDER BY control.sequence`,
          [{ event_id: "numeric-context" }, { event_id: "reset-context" }],
        );
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }),
  );
});
