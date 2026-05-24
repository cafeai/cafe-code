import {
  ProviderDaemonRpcRequest,
  ThreadId,
  type ProviderDaemonRpcRequest as ProviderDaemonRpcRequestValue,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProviderDaemonCommandLedger } from "./CommandLedger.ts";

const encodeProviderDaemonRpcRequestJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonRpcRequest),
);

const stopRequest = {
  method: "stopSession",
  commandId: "command-000000000000000000000000000",
  payload: {
    threadId: ThreadId.make("thread-1"),
  },
} satisfies ProviderDaemonRpcRequestValue;

describe("ProviderDaemonCommandLedger", () => {
  it("returns the stored result for duplicate mutating command ids", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const callCount = yield* Ref.make(0);
        const ledger = yield* makeProviderDaemonCommandLedger();
        const execute = Ref.update(callCount, (count) => count + 1).pipe(
          Effect.as({
            ok: true,
            value: null,
          } as const),
        );

        const first = yield* ledger.runOnce(stopRequest, execute);
        const second = yield* ledger.runOnce(stopRequest, execute);

        expect(first).toEqual({ ok: true, value: null });
        expect(second).toEqual(first);
        expect(yield* Ref.get(callCount)).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("rejects mutating commands without command ids", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* makeProviderDaemonCommandLedger();
        const result = yield* ledger.runOnce(
          {
            method: "stopSession",
            payload: {
              threadId: ThreadId.make("thread-1"),
            },
          },
          Effect.succeed({ ok: true, value: null } as const),
        );

        expect(result).toMatchObject({
          ok: false,
          error: {
            tag: "ProviderDaemonMissingCommandId",
          },
        });
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("keeps daemon and supervisor command ids isolated in the same database", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const daemonLedger = yield* makeProviderDaemonCommandLedger({
          ownerKey: "provider-daemon",
        });
        const supervisorLedger = yield* makeProviderDaemonCommandLedger({
          ownerKey: "provider-supervisor",
        });

        const daemonResult = yield* daemonLedger.runOnce(
          stopRequest,
          Effect.succeed({ ok: true, value: "daemon" } as const),
        );
        const supervisorResult = yield* supervisorLedger.runOnce(
          stopRequest,
          Effect.succeed({ ok: true, value: "supervisor" } as const),
        );

        expect(daemonResult).toEqual({ ok: true, value: "daemon" });
        expect(supervisorResult).toEqual({ ok: true, value: "supervisor" });
        expect((yield* daemonLedger.snapshot).commandCount).toBe(1);
        expect((yield* supervisorLedger.snapshot).commandCount).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("records execution defects as failed commands instead of leaving them running", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* makeProviderDaemonCommandLedger();
        const result = yield* ledger.runOnce(
          {
            ...stopRequest,
            commandId: "command-failing-000000000000000000",
          },
          Effect.die(new Error("provider runtime exploded")),
        );
        const snapshot = yield* ledger.snapshot;

        expect(result).toMatchObject({
          ok: false,
          error: {
            tag: "ProviderDaemonCommandExecutionFailed",
          },
        });
        expect(snapshot.failedCommandCount).toBe(1);
        expect(snapshot.runningCommandCount).toBe(0);
        expect(snapshot.recentFailedCommands[0]).toMatchObject({
          errorTag: "ProviderDaemonCommandExecutionFailed",
          method: "stopSession",
        });
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("marks abandoned running commands failed when the owner ledger starts", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO provider_daemon_commands (
            command_id,
            method,
            status,
            request_json,
            created_at,
            updated_at
          )
          VALUES (
            'provider-daemon:command-abandoned-000000000000',
            'stopSession',
            'running',
            ${encodeProviderDaemonRpcRequestJson(stopRequest)},
            ${now},
            ${now}
          )
        `;

        const ledger = yield* makeProviderDaemonCommandLedger();
        const snapshot = yield* ledger.snapshot;

        expect(snapshot.runningCommandCount).toBe(0);
        expect(snapshot.failedCommandCount).toBe(1);
        expect(snapshot.recentFailedCommands[0]).toMatchObject({
          commandId: "provider-daemon:command-abandoned-000000000000",
          errorTag: "ProviderDaemonCommandAbandonedOnStartup",
        });
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });
});
