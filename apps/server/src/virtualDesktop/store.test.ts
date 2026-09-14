import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@cafecode/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as TestSqliteClient from "../persistence/TestSqliteClient.ts";
import { makeDesktopStore } from "./store.ts";

it.layer(TestSqliteClient.layerMemory())("desktop attachment persistence", (it) => {
  it.effect("preserves a future draft selection and retires it with the real thread", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient,
        store = yield* makeDesktopStore;
      const threadId = ThreadId.make("future-desktop-thread");
      yield* Effect.promise(() =>
        store.put({
          id: "desktop",
          name: "Desk",
          incarnation: "one",
          directory: "private",
          boot_id: "boot",
          pid: null,
          process_start: null,
          state: "ready",
          created_at: Date.now(),
        }),
      );
      yield* Effect.promise(() => store.attach(threadId, "desktop"));
      assert.equal(yield* Effect.promise(() => store.selected(threadId)), "desktop");
      yield* sql`INSERT INTO hard_deleted_threads (thread_id, deleted_at) VALUES (${threadId}, '2026-09-08T00:00:00.000Z')`;
      assert.equal(yield* Effect.promise(() => store.selected(threadId)), null);
      const retired = yield* Effect.exit(
        Effect.tryPromise(() => store.attach(threadId, "desktop")),
      );
      assert.equal(retired._tag, "Failure");
      const draft = ThreadId.make("other-draft");
      yield* Effect.promise(() => store.attach(draft, "desktop"));
      yield* Effect.promise(() => store.retire("desktop"));
      assert.equal(yield* Effect.promise(() => store.selected(draft)), null);
    }),
  );
  it.effect("retains pending cleanup until the runtime owner verifies and removes it", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* makeDesktopStore;
      const definition = {
        id: "attached-failure",
        name: "Failed",
        incarnation: "one",
        directory: "private",
        boot_id: "boot",
        pid: null,
        process_start: null,
        state: "failed" as const,
        created_at: 1,
      };
      yield* Effect.promise(() => store.put(definition));
      yield* Effect.promise(() => store.attach(ThreadId.make("preserved-draft"), definition.id));
      yield* Effect.promise(() =>
        store.put({ ...definition, id: "still-owned", pid: 42, created_at: 0 }),
      );
      for (let index = 0; index < 40; index++) {
        yield* Effect.promise(() =>
          store.put({ ...definition, id: `failed-${index}`, created_at: index + 2 }),
        );
      }
      const rows = yield* Effect.promise(() => store.list());
      assert.equal(rows[0]?.id, "still-owned");
      assert.equal(rows.filter((r) => r.id.startsWith("failed-")).length, 40);
      assert.equal(
        rows.some((r) => r.id === definition.id),
        true,
      );
      assert.equal(yield* Effect.promise(() => store.attached(definition.id)), true);
    }),
  );
  it.effect("deletes only stopped entries and their attachments in one durable transaction", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient,
        store = yield* makeDesktopStore;
      const definition = {
        id: "delete-stopped",
        name: "Old desktop",
        incarnation: "old",
        directory: "private",
        boot_id: "boot",
        pid: null,
        process_start: null,
        state: "stopped" as const,
        created_at: Date.now(),
      };
      const threadId = ThreadId.make("delete-desktop-draft");
      yield* Effect.promise(() => store.put(definition));
      yield* Effect.promise(() => store.attach(threadId, definition.id));
      // A database failure after deleting associations must roll those deletes
      // back too, leaving the same record and selection available for retry.
      yield* sql`CREATE TRIGGER reject_fixture_desktop_delete BEFORE DELETE ON virtual_desktops WHEN OLD.id = 'delete-stopped' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`;
      assert.equal(
        (yield* Effect.exit(Effect.tryPromise(() => store.deleteStopped(definition.id))))._tag,
        "Failure",
      );
      assert.equal(yield* Effect.promise(() => store.selected(threadId)), definition.id);
      yield* sql`DROP TRIGGER reject_fixture_desktop_delete`;
      assert.equal(yield* Effect.promise(() => store.deleteStopped(definition.id)), true);
      const reopened = yield* makeDesktopStore;
      assert.equal(yield* Effect.promise(() => reopened.selected(threadId)), null);
      assert.equal(
        (yield* Effect.promise(() => reopened.list())).some((d) => d.id === definition.id),
        false,
      );
      assert.equal(yield* Effect.promise(() => reopened.deleteStopped(definition.id)), true);
      for (const [state, pid, process_start] of [
        ["ready", 42, "birth"],
        ["failed", 43, "birth"],
        ["stopped", 44, "birth"],
        ["stopped", null, "birth"],
      ] as const) {
        const value = { ...definition, id: `preserve-${state}-${pid}`, state, pid, process_start };
        yield* Effect.promise(() => store.put(value));
        yield* Effect.promise(() => store.attach(threadId, value.id));
        assert.equal(yield* Effect.promise(() => store.deleteStopped(value.id)), false);
        assert.equal(yield* Effect.promise(() => store.selected(threadId)), value.id);
      }
    }),
  );
});
