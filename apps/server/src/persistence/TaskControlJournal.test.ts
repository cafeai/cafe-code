import { ProviderInstanceId, SubagentRuntimeId, ThreadId, TurnId } from "@cafecode/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { makeTaskControlJournal } from "./TaskControlJournal.ts";

const input = {
  threadId: ThreadId.make("owner-chat"),
  turnId: TurnId.make("owner-turn"),
  providerInstanceId: ProviderInstanceId.make("owner-account"),
  runtimeId: SubagentRuntimeId.make("10000000-0000-4000-8000-000000000001"),
  taskId: "task-a",
  taskGeneration: "00000000-0000-4000-8000-000000000001",
  action: "stop" as const,
};

describe("task control durable receipts", () => {
  it("does not repeat a native control while its acknowledgement is pending or after reconnect", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* makeTaskControlJournal;
        const nativeStarted = yield* Deferred.make<void>();
        const acknowledgeNative = yield* Deferred.make<void>();
        let calls = 0;
        const first = yield* journal
          .run(
            input,
            Effect.gen(function* () {
              calls++;
              // This barrier proves the durable claim already admitted native I/O.
              // Keep its acknowledgement pending while another owner connection
              // submits the identical immutable task/action tuple.
              yield* Deferred.succeed(nativeStarted, undefined);
              yield* Deferred.await(acknowledgeNative);
              return { status: "accepted" as const };
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(nativeStarted);
        const duplicateNative = Effect.sync(() => {
          calls++;
          return { status: "accepted" as const };
        });
        const concurrentConnection = yield* makeTaskControlJournal;
        expect(yield* concurrentConnection.run(input, duplicateNative)).toEqual({
          status: "unknown",
        });
        expect(calls).toBe(1);

        yield* Deferred.succeed(acknowledgeNative, undefined);
        expect(yield* Fiber.join(first)).toEqual({ status: "accepted" });
        // A fresh journal must return the persisted receipt rather than call the
        // provider again, even after the original connection has completed.
        const reconnected = yield* makeTaskControlJournal;
        expect(yield* reconnected.run(input, duplicateNative)).toEqual({ status: "accepted" });
        expect(calls).toBe(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
    );
  });
  it("deduplicates clicks and reconnects while keeping actions and account/runtime/task incarnations distinct", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* makeTaskControlJournal;
        let calls = 0;
        const execute = Effect.sync(() => {
          calls++;
          return { status: "accepted" as const };
        });
        expect(yield* first.run(input, execute)).toEqual({ status: "accepted" });
        const reconnect = yield* makeTaskControlJournal;
        expect(yield* reconnect.run(input, execute)).toEqual({ status: "accepted" });
        expect(calls).toBe(1);
        for (const changed of [
          { ...input, action: "background" as const },
          { ...input, taskGeneration: "00000000-0000-4000-8000-000000000002" },
          { ...input, providerInstanceId: ProviderInstanceId.make("account-b") },
          { ...input, runtimeId: SubagentRuntimeId.make("10000000-0000-4000-8000-000000000002") },
          { ...input, taskId: "task-b" },
          { ...input, turnId: TurnId.make("turn-b") },
          { ...input, threadId: ThreadId.make("chat-b") },
        ])
          yield* reconnect.run(changed, execute);
        expect(calls).toBe(8);
      }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
    );
  });
  it("never replays an unresolved or corrupt receipt after restart", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* makeTaskControlJournal;
        let calls = 0;
        const execute = Effect.sync(() => {
          calls++;
          return { status: "accepted" as const };
        });
        yield* journal.run(input, execute);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE provider_daemon_commands SET status = 'running', response_json = NULL`;
        const restarted = yield* makeTaskControlJournal;
        expect(yield* restarted.run(input, execute)).toEqual({ status: "unknown" });
        expect(calls).toBe(1);
        yield* sql`UPDATE provider_daemon_commands SET request_json = '{}'`;
        expect(yield* restarted.run(input, execute)).toEqual({ status: "unknown" });
        expect(calls).toBe(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
    );
  });
});
