import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";
import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import { chatImageSchema } from "./096_ChatImages.ts";

describe("096_ChatImages", () => {
  for (const legacyImages of [false, true]) {
    it.effect(
      legacyImages
        ? "preserves local id-93 images and installs the skipped upstream recovery index"
        : "adds images after upstream migrations without replaying the ledger",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA foreign_keys = ON`;
          yield* runMigrations({ toMigrationInclusive: legacyImages ? 92 : 95 });
          if (legacyImages) {
            yield* chatImageSchema;
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (93, 'ChatImages')`;
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
              [],
            );
          }
          const before = legacyImages ? yield* sql`SELECT * FROM chat_image_assets` : [];
          assert.deepEqual(
            yield* runMigrations(),
            legacyImages
              ? [
                  [94, "CodexContextWindowOverride"],
                  [95, "ProviderActivityDiagnostics"],
                  [96, "ChatImages"],
                ]
              : [[96, "ChatImages"]],
          );
          assert.deepEqual(
            yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 93`,
            [{ name: legacyImages ? "ChatImages" : "RecoveryPresentationIndex" }],
          );
          assert.deepEqual(
            yield* sql`SELECT name FROM sqlite_master
          WHERE name = 'idx_projection_recovery_presentation_owner_order'`,
            [{ name: "idx_projection_recovery_presentation_owner_order" }],
          );
          assert.deepEqual(yield* sql`SELECT * FROM chat_image_assets`, before);
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
