import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";
import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import { chatImageSchema } from "./097_ChatImages.ts";

describe("097_ChatImages", () => {
  for (const history of ["upstream-95", "local-93", "local-96", "upstream-96"] as const) {
    const legacyImages = history === "local-93" || history === "local-96";
    it.effect(`preserves the ${history} ledger and owned bytes while installing both schemas`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* runMigrations({
          toMigrationInclusive: history === "local-93" ? 92 : history === "upstream-96" ? 96 : 95,
        });
        if (legacyImages) {
          yield* chatImageSchema;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
              VALUES (${history === "local-93" ? 93 : 96}, 'ChatImages')`;
          yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
            VALUES ('image-owner', NULL, 'Owned fixture', '2026-10-12', '2026-10-12')`;
          yield* sql`INSERT INTO projection_thread_messages
            (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
            VALUES ('image-message', 'image-owner', 'assistant', 'fixture', 0, '2026-10-12', '2026-10-12')`;
          yield* sql`INSERT INTO chat_image_assets (digest, bytes, metadata_json)
            VALUES ('fixture-digest', ${new Uint8Array([1, 2, 3])}, '{}')`;
          yield* sql`INSERT INTO chat_message_images (thread_id, message_id, source, digest)
            VALUES ('image-owner', 'image-message', '/fixture.png', 'fixture-digest')`;
          assert.deepEqual(
            yield* sql`SELECT name FROM sqlite_master
            WHERE name = 'idx_projection_recovery_presentation_owner_order'`,
            history === "local-93"
              ? []
              : [{ name: "idx_projection_recovery_presentation_owner_order" }],
          );
        }
        if (history === "upstream-96") {
          yield* sql`INSERT INTO visualization_session_runtime VALUES (1, 'fixture-generation')`;
        }
        const ledgerBefore =
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        const before = legacyImages ? yield* sql`SELECT * FROM chat_image_assets` : [];
        assert.deepEqual(
          yield* runMigrations(),
          history === "local-93"
            ? [
                [94, "CodexContextWindowOverride"],
                [95, "ProviderActivityDiagnostics"],
                [96, "GeneratedVisualizations"],
                [97, "ChatImages"],
                [98, "ReportedUsageCosts"],
                [99, "UsageAndCompactionReconciliation"],
              ]
            : history === "upstream-95"
              ? [
                  [96, "GeneratedVisualizations"],
                  [97, "ChatImages"],
                  [98, "ReportedUsageCosts"],
                  [99, "UsageAndCompactionReconciliation"],
                ]
              : [
                  [97, "ChatImages"],
                  [98, "ReportedUsageCosts"],
                  [99, "UsageAndCompactionReconciliation"],
                ],
        );
        assert.deepEqual(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations
              WHERE migration_id <= ${history === "local-93" ? 93 : history === "upstream-95" ? 95 : 96}
              ORDER BY migration_id`,
          ledgerBefore,
        );
        assert.deepEqual(
          yield* sql`SELECT name FROM sqlite_master
          WHERE name = 'idx_projection_recovery_presentation_owner_order'`,
          [{ name: "idx_projection_recovery_presentation_owner_order" }],
        );
        assert.deepEqual(yield* sql`SELECT * FROM chat_image_assets`, before);
        assert.deepEqual(
          yield* sql`SELECT * FROM visualization_session_runtime`,
          history === "upstream-96" ? [{ singleton: 1, generation: "fixture-generation" }] : [],
        );
        if (legacyImages) {
          assert.deepEqual(yield* sql`SELECT source, digest FROM chat_message_images`, [
            { source: "/fixture.png", digest: "fixture-digest" },
          ]);
          yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'image-message'`;
          assert.deepEqual(yield* sql`SELECT * FROM chat_image_assets`, []);
        }
        assert.deepEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
    );
  }
});
