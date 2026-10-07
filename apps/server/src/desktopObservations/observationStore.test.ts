import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DesktopObservationRetention,
  ThreadId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as TestSqliteClient from "../persistence/TestSqliteClient.ts";
import { makeDesktopObservationStore, type DesktopObservationStore } from "./observationStore.ts";

const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";
const observed = { image, width: 1, height: 1, frame: 1, humanControl: false };
const threadId = ThreadId.make("observation-thread");
const otherThread = ThreadId.make("another-thread");

async function withStore(
  test: (
    store: DesktopObservationStore,
    directory: string,
    sql: SqlClient.SqlClient,
  ) => Promise<void>,
) {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          fs.mkdtemp(join(tmpdir(), "cafe-observations-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
        );
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const store = yield* makeDesktopObservationStore(directory);
        yield* Effect.tryPromise(() => test(store, directory, sql));
      }),
    ).pipe(Effect.provide(TestSqliteClient.layerMemory())),
  );
}

describe("private desktop observation retention", () => {
  it("defaults to 50 and accepts only nonnegative safe whole numbers without a product cap", () => {
    expect(DEFAULT_SERVER_SETTINGS.desktopObservationRetention).toBe(50);
    const valid = Schema.is(DesktopObservationRetention);
    for (const value of [0, 1, 50, 10_000, Number.MAX_SAFE_INTEGER])
      expect(valid(value)).toBe(true);
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(valid(value)).toBe(false);
  });
  it("retains the last 50 across threads, survives reopening, and enforces reductions immediately", () =>
    withStore(async (store, directory, sql) => {
      await store.setRetention(50, true);
      const first = await store.save(threadId, observed);
      for (let index = 0; index < 50; index++)
        await store.save(index % 2 ? threadId : otherThread, { ...observed, frame: index + 2 });
      const latest = await store.save(threadId, { ...observed, frame: 80 });
      expect(first.storage).toBe("saved");
      expect(latest.storage).toBe("saved");
      expect(await store.read(first.id, threadId, 50)).toBeUndefined();
      expect(await store.read(latest.id, otherThread, 50)).toBeUndefined();
      expect(Buffer.from((await store.read(latest.id, threadId, 50))!).toString("base64")).toBe(
        image,
      );
      const rows = await Effect.runPromise(
        sql`SELECT * FROM desktop_observations WHERE state = 'ready'`,
      );
      expect(rows).toHaveLength(50);
      expect(JSON.stringify(rows)).not.toContain(image);
      const reopened = await Effect.runPromise(
        makeDesktopObservationStore(directory).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      );
      await reopened.setRetention(50, true);
      expect(await reopened.read(latest.id, threadId, 50)).toEqual(Buffer.from(image, "base64"));
      await reopened.setRetention(2);
      expect(
        await Effect.runPromise(sql`SELECT id FROM desktop_observations WHERE state = 'ready'`),
      ).toHaveLength(2);
      await reopened.sweep();
      await reopened.sweep();
      expect(await fs.readdir(join(directory, "desktop-observations"))).toHaveLength(2);
      await reopened.setRetention(0);
      await reopened.sweep();
      expect(await reopened.read(latest.id, threadId, 50)).toBeUndefined();
      expect((await reopened.save(threadId, observed)).storage).toBe("disabled");
      expect(await fs.readdir(join(directory, "desktop-observations"))).toEqual([]);
      await reopened.setRetention(500);
      expect((await reopened.save(threadId, observed)).storage).toBe("saved");
    }));
  it("rejects hard-deleted owners, retires their images, and recovers interrupted write intents", () =>
    withStore(async (store, directory, sql) => {
      await store.setRetention(50, true);
      const saved = await store.save(threadId, observed);
      await Effect.runPromise(
        sql`INSERT INTO hard_deleted_threads(thread_id, deleted_at) VALUES (${threadId}, '2026-09-09T00:00:00.000Z')`,
      );
      expect(await store.read(saved.id, threadId, 50)).toBeUndefined();
      expect((await store.save(threadId, observed)).storage).toBe("failed");
      await store.sweep();
      await store.sweep();
      expect(await fs.readdir(join(directory, "desktop-observations"))).toEqual([]);
      const pendingId = randomUUID();
      await Effect.runPromise(sql`INSERT INTO desktop_observations(id, thread_id, metadata_json, sha256, byte_length, state)
      VALUES (${pendingId}, ${otherThread}, '{}', '', 0, 'pending')`);
      await fs.writeFile(join(directory, "desktop-observations", `${pendingId}.png`), "partial", {
        mode: 0o600,
      });
      await store.setRetention(50, true);
      await store.sweep();
      expect(await fs.readdir(join(directory, "desktop-observations"))).toEqual([]);
      expect(await Effect.runPromise(sql`SELECT id FROM desktop_observations`)).toEqual([]);
    }));
  it("uses private immutable bytes and rejects modified, linked, foreign, or malformed artifacts", () =>
    withStore(async (store, directory) => {
      await store.setRetention(50, true);
      const saved = await store.save(threadId, observed);
      const root = join(directory, "desktop-observations");
      const filename = join(root, `${saved.id}.png`);
      if (process.platform !== "win32") {
        expect((await fs.stat(root)).mode & 0o077).toBe(0);
        expect((await fs.stat(filename)).mode & 0o077).toBe(0);
      }
      expect(await store.read("../../sensitive", threadId, 50)).toBeUndefined();
      expect(await store.read(saved.id, threadId, 0)).toBeUndefined();
      const altered = Buffer.from(image, "base64");
      altered[30] = altered[30]! ^ 1;
      await fs.writeFile(filename, altered);
      expect(await store.read(saved.id, threadId, 50)).toBeUndefined();
      await fs.writeFile(filename, Buffer.from(image, "base64"));
      await fs.link(filename, join(directory, "linked.png"));
      expect(await store.read(saved.id, threadId, 50)).toBeUndefined();
      expect((await store.save(threadId, { ...observed, image: "invalid" })).storage).toBe(
        "failed",
      );
      expect((await store.save(threadId, { ...observed, width: 2 })).storage).toBe("failed");
    }));
  it("retries failed cleanup without starving other retired files", () =>
    withStore(async (store, directory, sql) => {
      await store.setRetention(50, true);
      const first = await store.save(threadId, observed);
      const second = await store.save(otherThread, observed);
      const blocked = join(directory, "desktop-observations", `${first.id}.png`);
      await fs.unlink(blocked);
      await fs.mkdir(blocked);
      await store.setRetention(0);
      expect(await Effect.runPromise(sql`SELECT id FROM desktop_observations`)).toEqual([
        { id: first.id },
      ]);
      expect(await store.read(second.id, otherThread, 50)).toBeUndefined();
      await fs.rmdir(blocked);
      await store.sweep();
      await store.sweep();
      expect(await Effect.runPromise(sql`SELECT id FROM desktop_observations`)).toEqual([]);
    }));
  it("keeps concurrent saves and retention changes ordered", () =>
    withStore(async (store, _directory, sql) => {
      await store.setRetention(50, true);
      const saving = Array.from({ length: 8 }, () => store.save(threadId, observed));
      const clearing = store.setRetention(0);
      const afterClear = store.save(threadId, observed);
      await Promise.all([...saving, clearing]);
      expect((await afterClear).storage).toBe("disabled");
      expect(
        await Effect.runPromise(sql`SELECT id FROM desktop_observations WHERE state = 'ready'`),
      ).toEqual([]);
    }));
  it("cannot publish a capture after its thread is deleted during the write", () =>
    withStore(async (store, directory, sql) => {
      await store.setRetention(50, true);
      await Effect.runPromise(sql`CREATE TEMP TRIGGER observation_delete_during_capture AFTER INSERT ON desktop_observations
      BEGIN INSERT INTO hard_deleted_threads(thread_id, deleted_at) VALUES (NEW.thread_id, '2026-09-09T00:00:00.000Z'); END`);
      const saved = await store.save(threadId, observed);
      expect(saved.storage).toBe("failed");
      expect(await store.read(saved.id, threadId, 50)).toBeUndefined();
      await store.sweep();
      expect(await fs.readdir(join(directory, "desktop-observations"))).toEqual([]);
    }));
});
