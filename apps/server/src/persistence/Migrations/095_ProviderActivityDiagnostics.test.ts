// @effect-diagnostics nodeBuiltinImport:off
import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(TestSqliteClient.layerMemory());
layer("095_ProviderActivityDiagnostics", (it) => {
  it.effect(
    "adds a prospective private owner index and immutable/tombstone fences without backfilling history",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 94 });
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES ('migration-diagnostic-owner', NULL, 'Synthetic owner', '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z')`;
        yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
      VALUES ('existing-error', 'migration-diagnostic-owner', NULL, 'error', 'runtime.error', 'Legacy summary only', '{}', '2026-10-12T00:00:00Z')`;
        yield* runMigrations({ toMigrationInclusive: 95 });
        const initial = yield* sql`SELECT activity_id FROM provider_activity_diagnostics`;
        assert.equal(initial.length, 0);
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA index_info('idx_provider_activity_diagnostics_owner')`;
        assert.deepEqual(
          columns.map((column) => column.name),
          ["thread_id", "turn_id", "occurrence_key"],
        );
        const triggers = yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND name LIKE 'trg_provider_diagnostics_%' ORDER BY name`;
        assert.deepEqual(
          triggers.map((trigger) => trigger.name),
          [
            "trg_provider_diagnostics_hard_delete",
            "trg_provider_diagnostics_immutable",
            "trg_provider_diagnostics_tombstone",
          ],
        );
        yield* sql`INSERT INTO provider_activity_diagnostics (activity_id, thread_id, turn_id, snapshot_json, occurrence_key, created_at)
      VALUES ('new-error', 'migration-diagnostic-owner', NULL, '{}', NULL, '2026-10-12T00:00:00Z')`;
        const replace =
          yield* sql`UPDATE provider_activity_diagnostics SET snapshot_json = '{"replacement":true}'
      WHERE activity_id = 'new-error'`.pipe(Effect.exit);
        assert.equal(Exit.isFailure(replace), true);
        const oversized =
          yield* sql`INSERT INTO provider_activity_diagnostics (activity_id, thread_id, turn_id, snapshot_json, occurrence_key, created_at)
      VALUES ('oversized-error', 'migration-diagnostic-owner', NULL, ${"x".repeat(65_537)}, NULL, '2026-10-12T00:00:00Z')`.pipe(
            Effect.exit,
          );
        assert.equal(Exit.isFailure(oversized), true);
        yield* sql`INSERT INTO hard_deleted_threads (thread_id, deleted_at) VALUES ('migration-diagnostic-owner', '2026-10-12T00:00:01Z')`;
        const retired =
          yield* sql`SELECT activity_id FROM provider_activity_diagnostics WHERE thread_id = 'migration-diagnostic-owner'`;
        assert.equal(retired.length, 0);
        const replay =
          yield* sql`INSERT INTO provider_activity_diagnostics (activity_id, thread_id, turn_id, snapshot_json, occurrence_key, created_at)
      VALUES ('stale-error', 'migration-diagnostic-owner', NULL, '{}', NULL, '2026-10-12T00:00:02Z')`.pipe(
            Effect.exit,
          );
        assert.equal(Exit.isFailure(replay), true);
        // The prospective diagnostic migration does not alter old canonical data;
        // hard-delete orchestration independently owns transcript deletion.
        const history = yield* sql<{
          readonly summary: string;
        }>`SELECT summary FROM projection_thread_activities WHERE activity_id = 'existing-error'`;
        assert.equal(history[0]?.summary, "Legacy summary only");
      }),
  );
});
