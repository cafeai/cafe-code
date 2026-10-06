import { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { makeCodexHistorySafetyStore } from "./CodexHistorySafety.ts";
import { purgeProviderDaemonThreadPersistence } from "../providerDaemon/ProviderDaemonThreadPurge.ts";

const key = {
  threadId: ThreadId.make("cafe-chat"),
  providerInstanceId: ProviderInstanceId.make("codex-account"),
  nativeThreadId: "native-chat",
};

describe("Codex history safety persistence", () => {
  it("retains the guard after the database connection is closed and reopened", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-history-safety-" });
        const database = path.join(directory, "history.sqlite");
        yield* Effect.gen(function* () {
          const store = yield* makeCodexHistorySafetyStore;
          yield* store.markBlocked(key);
        }).pipe(Effect.provide(makeSqlitePersistenceLive(database)), Effect.scoped);
        // The first scoped connection is gone before a new layer opens the
        // fixture-owned file. Nothing consults provider profiles or live data.
        yield* Effect.gen(function* () {
          const store = yield* makeCodexHistorySafetyStore;
          expect(yield* store.isBlocked(key)).toBe(true);
          expect(yield* store.isBlocked({ ...key, nativeThreadId: "new-context" })).toBe(false);
        }).pipe(Effect.provide(makeSqlitePersistenceLive(database)), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  });

  it("binds every identity component and survives replacement of the in-memory owner", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeCodexHistorySafetyStore;
        expect(yield* store.isBlocked(key)).toBe(false);
        yield* store.markBlocked(key);
        const restarted = yield* makeCodexHistorySafetyStore;
        expect(yield* restarted.isBlocked(key)).toBe(true);
        for (const different of [
          { ...key, threadId: ThreadId.make("other-chat") },
          { ...key, providerInstanceId: ProviderInstanceId.make("other-account") },
          { ...key, nativeThreadId: "fresh-native-chat" },
          { ...key, nativeThreadId: "native-chat%" },
        ])
          expect(yield* restarted.isBlocked(different)).toBe(false);
        const sql = yield* SqlClient.SqlClient;
        // A daemon can own history without any orchestration projection or
        // current runtime row. Runtime deletion is not a safety reset operation.
        expect(yield* sql`SELECT * FROM projection_threads`).toHaveLength(0);
        yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${key.threadId}`;
        expect(yield* restarted.isBlocked(key)).toBe(true);
      }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
    );
  });

  it("keeps the first finite report under repeated and concurrent notifications", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeCodexHistorySafetyStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.markBlocked(key);
        const first = yield* sql`SELECT * FROM provider_codex_history_safety`;
        yield* Effect.all(
          Array.from({ length: 8 }, () => store.markBlocked(key)),
          { concurrency: 8 },
        );
        expect(yield* sql`SELECT * FROM provider_codex_history_safety`).toEqual(first);
        expect(Object.keys(first[0]!).toSorted()).toEqual([
          "native_thread_id",
          "provider_instance_id",
          "reason",
          "reported_at",
          "thread_id",
        ]);
        expect(first[0]?.reason).toBe("codex_history_tool_arguments_too_large");
        expect(first[0]?.reported_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
    );
  });

  it("purges only the deleted chat and rejects late writes/reads even without projections", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeCodexHistorySafetyStore;
        const sql = yield* SqlClient.SqlClient;
        const other = { ...key, threadId: ThreadId.make("unrelated-chat") };
        yield* store.markBlocked(key);
        yield* store.markBlocked({
          ...key,
          providerInstanceId: ProviderInstanceId.make("second-account"),
        });
        yield* store.markBlocked(other);
        yield* purgeProviderDaemonThreadPersistence({ threadId: key.threadId });
        expect(yield* sql`SELECT thread_id FROM provider_codex_history_safety`).toEqual([
          { thread_id: other.threadId },
        ]);
        expect(yield* store.isBlocked(other)).toBe(true);
        expect((yield* Effect.exit(store.markBlocked(key)))._tag).toBe("Failure");
        expect((yield* Effect.exit(store.isBlocked(key)))._tag).toBe("Failure");
        expect(
          (yield* Effect.exit(
            sql`UPDATE provider_codex_history_safety SET thread_id = ${key.threadId} WHERE thread_id = ${other.threadId}`,
          ))._tag,
        ).toBe("Failure");
        yield* purgeProviderDaemonThreadPersistence({ threadId: key.threadId });
        expect(yield* store.isBlocked(other)).toBe(true);
      }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
    );
  });

  it("fails closed without exposing SQL failures, malformed keys or unsupported stored reasons", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeCodexHistorySafetyStore;
        const sql = yield* SqlClient.SqlClient;
        for (const nativeThreadId of ["", "x".repeat(513), "opaque\0suffix"]) {
          expect((yield* Effect.exit(store.isBlocked({ ...key, nativeThreadId })))._tag).toBe(
            "Failure",
          );
          expect((yield* Effect.exit(store.markBlocked({ ...key, nativeThreadId })))._tag).toBe(
            "Failure",
          );
        }
        yield* store.markBlocked(key);
        expect(
          (yield* Effect.exit(
            sql`UPDATE provider_codex_history_safety SET reason = 'arbitrary payload'`,
          ))._tag,
        ).toBe("Failure");
        // Independently qualify corruption handling, not only the CHECK that
        // normally prevents an unsupported reason from entering the database.
        yield* sql`PRAGMA ignore_check_constraints = ON`;
        yield* sql`UPDATE provider_codex_history_safety SET reason = 'unknown reason'`;
        expect((yield* Effect.exit(store.isBlocked(key)))._tag).toBe("Failure");
        yield* sql`PRAGMA ignore_check_constraints = OFF`;
        yield* sql`DROP TABLE provider_codex_history_safety`;
        const read = yield* store.isBlocked(key).pipe(Effect.flip);
        const mark = yield* store.markBlocked(key).pipe(Effect.flip);
        expect(JSON.stringify(read)).toBe(
          '{"operation":"read","_tag":"CodexHistorySafetyStorageError"}',
        );
        expect(JSON.stringify(mark)).toBe(
          '{"operation":"mark","_tag":"CodexHistorySafetyStorageError"}',
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
    );
  });
});
