import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestSqliteClient from "../persistence/TestSqliteClient.ts";
import migration from "../persistence/Migrations/100_GlideThreadPreferences.ts";
import desktopMigration from "../persistence/Migrations/101_GlideDesktopPermission.ts";
import { makeGlidePolicyStore } from "./policyStore.ts";

it.layer(TestSqliteClient.layerMemory())("Glide durable app grants", (it) => {
  it.effect(
    "persists explicit per-chat choices and checks current ownership/access at publication",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY, runtime_mode TEXT, deleted_at TEXT)`;
        yield* sql`CREATE TABLE hard_deleted_threads(thread_id TEXT PRIMARY KEY)`;
        yield* migration;
        yield* desktopMigration;
        yield* sql`INSERT INTO projection_threads VALUES ('owned','full-access',NULL),('other','full-access',NULL)`;
        const store = yield* makeGlidePolicyStore;
        assert.deepEqual(yield* store.read("owned"), {
          enabled: false,
          desktop: false,
          fullAccess: true,
          apps: [],
        });
        yield* store.write("owned", { enabled: true, apps: ["fixture.editor"] });
        const reopened = yield* makeGlidePolicyStore;
        assert.deepEqual(yield* reopened.read("owned"), {
          enabled: true,
          desktop: false,
          fullAccess: true,
          apps: ["fixture.editor"],
        });
        assert.deepEqual(yield* reopened.read("other"), {
          enabled: false,
          desktop: false,
          fullAccess: true,
          apps: [],
        });
        yield* sql`UPDATE projection_threads SET runtime_mode='approval-required' WHERE thread_id='owned'`;
        assert.isTrue(
          Exit.isFailure(
            yield* store
              .write("owned", { enabled: true, apps: ["fixture.foreign"] })
              .pipe(Effect.exit),
          ),
        );
        assert.deepEqual(yield* store.read("owned"), {
          enabled: true,
          desktop: false,
          fullAccess: false,
          apps: ["fixture.editor"],
        });
        yield* store.write("owned", { enabled: false, apps: [] });
        yield* sql`UPDATE projection_threads SET runtime_mode='full-access',deleted_at='deleted' WHERE thread_id='owned'`;
        assert.isTrue(
          Exit.isFailure(
            yield* store
              .write("owned", { enabled: true, apps: ["fixture.editor"] })
              .pipe(Effect.exit),
          ),
        );
        yield* sql`UPDATE projection_threads SET deleted_at=NULL WHERE thread_id='owned'`;
        yield* sql`INSERT INTO hard_deleted_threads VALUES ('owned')`;
        assert.isTrue(Exit.isFailure(yield* store.read("owned").pipe(Effect.exit)));
        assert.isTrue(
          Exit.isFailure(
            yield* store
              .write("owned", { enabled: true, apps: ["fixture.editor"] })
              .pipe(Effect.exit),
          ),
        );
        assert.deepEqual(
          yield* sql`SELECT enabled, apps_json FROM glide_thread_preferences WHERE thread_id='owned'`,
          [{ enabled: 0, apps_json: "[]" }],
        );
      }),
  );
});

it.layer(TestSqliteClient.layerMemory())("Glide durable desktop grants", (it) => {
  it.effect(
    "persists desktop permission per chat and revokes it without rewriting legacy app grants",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY, runtime_mode TEXT, deleted_at TEXT)`;
        yield* sql`CREATE TABLE hard_deleted_threads(thread_id TEXT PRIMARY KEY)`;
        yield* migration;
        yield* sql`INSERT INTO glide_thread_preferences VALUES ('legacy',1,'["fixture.editor"]')`;
        yield* desktopMigration;
        yield* sql`INSERT INTO projection_threads VALUES ('owned','full-access',NULL),('other','full-access',NULL),('legacy','full-access',NULL)`;
        const store = yield* makeGlidePolicyStore;
        assert.deepEqual(yield* store.read("legacy"), {
          enabled: true,
          fullAccess: true,
          desktop: false,
          apps: ["fixture.editor"],
        });
        yield* store.initialize("owned");
        const reopened = yield* makeGlidePolicyStore;
        assert.deepEqual(yield* reopened.read("owned"), {
          enabled: true,
          desktop: true,
          fullAccess: true,
          apps: [],
        });
        assert.isFalse((yield* reopened.read("other")).desktop);
        yield* store.write("owned", { enabled: false, apps: [] });
        yield* store.initialize("owned");
        assert.isFalse((yield* store.read("owned")).enabled);
        yield* store.write("owned", { enabled: true, desktop: true, apps: [] });
        yield* sql`UPDATE projection_threads SET runtime_mode='approval-required' WHERE thread_id='owned'`;
        assert.isTrue(Exit.isFailure(yield* store.initialize("owned").pipe(Effect.exit)));
        assert.isTrue(
          Exit.isFailure(
            yield* store
              .write("owned", { enabled: true, desktop: true, apps: [] })
              .pipe(Effect.exit),
          ),
        );
        yield* store.write("owned", { enabled: false, desktop: true, apps: [] });
        assert.deepEqual(yield* store.read("owned"), {
          enabled: false,
          desktop: false,
          fullAccess: false,
          apps: [],
        });
        yield* sql`UPDATE projection_threads SET runtime_mode='full-access',deleted_at='deleted' WHERE thread_id='owned'`;
        assert.isTrue(Exit.isFailure(yield* store.initialize("owned").pipe(Effect.exit)));
        assert.isTrue(Exit.isFailure(yield* store.initialize("missing").pipe(Effect.exit)));
        assert.isTrue(
          Exit.isFailure(
            yield* store
              .write("owned", { enabled: true, desktop: true, apps: [] })
              .pipe(Effect.exit),
          ),
        );
      }),
  );
});
