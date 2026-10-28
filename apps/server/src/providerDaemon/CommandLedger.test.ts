import {
  ProviderDaemonRpcRequest,
  CommandId,
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  ApprovalRequestId,
  TurnId,
  type ProviderDaemonRpcRequest as ProviderDaemonRpcRequestValue,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceTest } from "../persistence/Sqlite.test.fixture.ts";
import { makeProviderDaemonCommandLedger } from "./CommandLedger.ts";

const encodeProviderJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

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
  it("binds private recovery without persisting prompt or capability and refuses prepare replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ownerKey = "synthetic-private-recovery";
        const ledger = yield* makeProviderDaemonCommandLedger({ ownerKey });
        const calls = yield* Ref.make(0);
        const secret = "a".repeat(64);
        const continuation = "b".repeat(64);
        const prompt = "private-recovery-prompt-canary";
        const request = {
          method: "prepareFailedRootRecovery" as const,
          commandId: "10000000-0000-4000-8000-000000000001",
          payload: {
            attemptId: "synthetic-attempt",
            preparationSequence: 1,
            continuationToken: continuation,
            request: {
              threadId: ThreadId.make("private-thread"),
              input: prompt,
              expectedFailedRoot: {
                turnId: TurnId.make("private-root"),
                providerThreadId: "private-history",
                subagentRuntimeId: SubagentRuntimeId.make("10000000-0000-4000-8000-000000000003"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                observedAt: "2026-10-19T01:00:00.000Z",
                restartSession: true as const,
              },
            },
          },
        } satisfies ProviderDaemonRpcRequestValue;
        const outcome = { ok: true as const, value: { state: "prepared", permit: secret } };
        const execute = Ref.update(calls, (n) => n + 1).pipe(Effect.as(outcome));
        expect(yield* ledger.runOnce(request, execute)).toEqual(outcome);
        expect(yield* ledger.runOnce(request, execute)).toMatchObject({
          ok: false,
          error: { tag: "ProviderDaemonPrivateRecoveryLookupRequired" },
        });
        expect(
          yield* ledger.runOnce(
            {
              ...request,
              payload: {
                ...request.payload,
                request: { ...request.payload.request, input: "different" },
              },
            },
            execute,
          ),
        ).toMatchObject({ ok: false, error: { tag: "ProviderDaemonCommandIdentityMismatch" } });
        for (const changed of [
          {
            ...request,
            payload: {
              ...request.payload,
              request: { ...request.payload.request, threadId: ThreadId.make("foreign-thread") },
            },
          },
          {
            ...request,
            payload: {
              ...request.payload,
              request: {
                ...request.payload.request,
                expectedFailedRoot: {
                  ...request.payload.request.expectedFailedRoot,
                  providerInstanceId: ProviderInstanceId.make("foreign-account"),
                },
              },
            },
          },
          {
            ...stopRequest,
            commandId: request.commandId,
            payload: { threadId: request.payload.request.threadId },
          },
        ])
          expect(yield* ledger.runOnce(changed, execute)).toMatchObject({
            ok: false,
            error: { tag: "ProviderDaemonCommandIdentityMismatch" },
          });
        const ordinaryCommand = {
          ...stopRequest,
          commandId: "10000000-0000-4000-8000-000000000004",
        };
        expect(
          yield* ledger.runOnce(
            ordinaryCommand,
            Effect.succeed({ ok: true as const, value: null }),
          ),
        ).toMatchObject({ ok: true });
        expect(
          yield* ledger.runOnce({ ...request, commandId: ordinaryCommand.commandId }, execute),
        ).toMatchObject({ ok: false, error: { tag: "ProviderDaemonCommandIdentityMismatch" } });
        const paid = {
          method: "sendTurn" as const,
          commandId: "10000000-0000-4000-8000-000000000002",
          payload: {
            ...request.payload.request,
            preparedFailedRootRecovery: {
              attemptId: "synthetic-attempt",
              preparationSequence: 1,
              requestCommitment: "c".repeat(64),
              permit: secret,
            },
          },
        } satisfies ProviderDaemonRpcRequestValue;
        const paidAck = {
          ok: true as const,
          value: {
            threadId: paid.payload.threadId,
            turnId: TurnId.make("paid-turn"),
            resumeCursor: { opaqueSecret: secret },
          },
        };
        const paidExecute = Ref.update(calls, (n) => n + 1).pipe(Effect.as(paidAck));
        expect(yield* ledger.runOnce(paid, paidExecute)).toEqual(paidAck);
        expect(yield* ledger.runOnce(paid, paidExecute)).toMatchObject({
          ok: false,
          error: { tag: "ProviderDaemonPrivateRecoveryOutcomeUnknown" },
        });
        expect(
          yield* ledger.runOnce(
            {
              ...paid,
              payload: {
                ...paid.payload,
                preparedFailedRootRecovery: {
                  ...paid.payload.preparedFailedRootRecovery,
                  permit: "d".repeat(64),
                },
              },
            },
            paidExecute,
          ),
        ).toMatchObject({ ok: false, error: { tag: "ProviderDaemonCommandIdentityMismatch" } });
        const cancel = {
          method: "cancelFailedRootRecovery" as const,
          commandId: "10000000-0000-4000-8000-000000000005",
          payload: {
            threadId: request.payload.request.threadId,
            attemptId: "synthetic-attempt",
            requestCommitment: "c".repeat(64),
          },
        } satisfies ProviderDaemonRpcRequestValue;
        const cancelExecute = Ref.update(calls, (n) => n + 1).pipe(
          Effect.as({ ok: true as const, value: null }),
        );
        expect(yield* ledger.runOnce(cancel, cancelExecute)).toMatchObject({ ok: true });
        expect(yield* ledger.runOnce(cancel, cancelExecute)).toMatchObject({
          ok: false,
          error: { tag: "ProviderDaemonPrivateRecoveryOutcomeUnknown" },
        });
        expect(
          yield* ledger.runOnce(
            {
              ...cancel,
              payload: { ...cancel.payload, threadId: ThreadId.make("foreign-thread") },
            },
            cancelExecute,
          ),
        ).toMatchObject({ ok: false, error: { tag: "ProviderDaemonCommandIdentityMismatch" } });
        expect(
          yield* ledger.runOnce({ ...request, commandId: cancel.commandId }, execute),
        ).toMatchObject({ ok: false, error: { tag: "ProviderDaemonCommandIdentityMismatch" } });
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          request_json: string;
          response_json: string | null;
          error_json: string | null;
        }>`SELECT request_json, response_json, error_json FROM provider_daemon_commands WHERE command_id LIKE ${`${ownerKey}:%`}`;
        const snapshot = yield* ledger.snapshot;
        expect(encodeProviderJsonString(snapshot)).not.toContain("paid-turn");
        const stored = encodeProviderJsonString({ rows, snapshot });
        for (const value of [prompt, secret, continuation, "c".repeat(64), "private-history"])
          expect(stored).not.toContain(value);
        expect(
          rows.filter((row) => row.request_json.startsWith("private-recovery-v1:")),
        ).toHaveLength(3);
        const restarted = yield* makeProviderDaemonCommandLedger({
          ownerKey,
          recoverAbandonedOnStartup: false,
        });
        expect(yield* restarted.runOnce(request, execute)).toMatchObject({
          ok: false,
          error: { tag: "ProviderDaemonCommandIdentityMismatch" },
        });
        expect(yield* Ref.get(calls)).toBe(3);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("binds cold-send refusal receipts to exact input and failure identity in both directions", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ownerKey = "synthetic-cold-send-receipts";
        const ledger = yield* makeProviderDaemonCommandLedger({ ownerKey });
        const calls = yield* Ref.make(0);
        const request = {
          method: "sendTurn" as const,
          commandId: "bound-failed-root-send-command",
          payload: {
            threadId: ThreadId.make("owned-failed-root-thread"),
            input: "Continue preserved work.",
            attachments: [],
            expectedFailedRoot: {
              turnId: TurnId.make("owned-failed-root-turn"),
              providerThreadId: "owned-private-history",
              subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000199"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              observedAt: "2026-10-19T01:00:00.000Z",
              restartSession: true as const,
            },
          },
        } satisfies ProviderDaemonRpcRequestValue;
        const refusal = {
          ok: false as const,
          error: {
            tag: "ProviderAdapterRequestError",
            message: "Fixed refusal.",
            failedRootRetirementRefusal: "notifications-pending" as const,
          },
        };
        const execute = Ref.update(calls, (n) => n + 1).pipe(Effect.as(refusal));
        expect(yield* ledger.runOnce(request, execute)).toEqual(refusal);
        // Native transport reset retry returns only the exact durable result.
        expect(yield* ledger.runOnce(request, execute)).toEqual(refusal);
        const expected = request.payload.expectedFailedRoot;
        for (const changed of [
          { ...request, payload: { ...request.payload, threadId: ThreadId.make("other-thread") } },
          { ...request, payload: { ...request.payload, input: "Different input." } },
          {
            ...request,
            payload: {
              ...request.payload,
              attachments: [
                {
                  type: "image" as const,
                  id: "different-image",
                  name: "image.png",
                  mimeType: "image/png",
                  sizeBytes: 1,
                },
              ],
            },
          },
          ...[
            { ...expected, turnId: TurnId.make("other-turn") },
            { ...expected, providerThreadId: "other-history" },
            {
              ...expected,
              subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000200"),
            },
            { ...expected, providerInstanceId: ProviderInstanceId.make("other-account") },
            { ...expected, observedAt: "2026-10-19T01:00:00.001Z" },
            { ...expected, restartSession: undefined },
          ].map((expectedFailedRoot) => ({
            ...request,
            payload: { ...request.payload, expectedFailedRoot },
          })),
          {
            ...request,
            payload: { threadId: request.payload.threadId, input: request.payload.input },
          },
          {
            ...stopRequest,
            commandId: request.commandId,
            payload: { threadId: request.payload.threadId },
          },
        ]) {
          const result = yield* ledger.runOnce(changed, execute);
          expect(result).toMatchObject({
            ok: false,
            error: { tag: "ProviderDaemonCommandIdentityMismatch" },
          });
          if (!result.ok) expect(result.error).not.toHaveProperty("failedRootRetirementRefusal");
        }
        expect(yield* Ref.get(calls)).toBe(1);
        expect((yield* ledger.snapshot).recentFailedCommands).toContainEqual(
          expect.objectContaining({
            commandId: `${ownerKey}:${request.commandId}`,
            method: "sendTurn",
            failedRootRetirementRefusal: "notifications-pending",
          }),
        );
        const ack = { ok: true as const, value: null };
        const executeAck = Ref.update(calls, (n) => n + 1).pipe(Effect.as(ack));
        expect(yield* ledger.runOnce(stopRequest, executeAck)).toEqual(ack);
        expect(
          yield* ledger.runOnce({ ...request, commandId: stopRequest.commandId }, execute),
        ).toMatchObject({ ok: false, error: { tag: "ProviderDaemonCommandIdentityMismatch" } });
        // Missing/corrupt legacy request JSON cannot attest either a refusal or
        // success for a new cold send, even with an identical command id.
        const sql = yield* SqlClient.SqlClient;
        const storedId = `${ownerKey}:${request.commandId}`;
        yield* sql`UPDATE provider_daemon_commands SET request_json = '{}' WHERE command_id = ${storedId}`;
        const legacy = yield* ledger.runOnce(request, execute);
        expect(legacy).toMatchObject({
          ok: false,
          error: { tag: "ProviderDaemonCommandIdentityMismatch" },
        });
        if (!legacy.ok) expect(legacy.error).not.toHaveProperty("failedRootRetirementRefusal");
        expect(yield* Ref.get(calls)).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("binds session opening receipts in both directions and refuses missing legacy request identity", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ownerKey = "synthetic-opening-receipts";
        const ledger = yield* makeProviderDaemonCommandLedger({ ownerKey });
        const calls = yield* Ref.make(0);
        const request = {
          method: "startSession" as const,
          commandId: "bound-session-start-command",
          payload: {
            threadId: ThreadId.make("owned-session-thread"),
            providerInstanceId: ProviderInstanceId.make("owned-account"),
            runtimeMode: "full-access" as const,
            maxConcurrentSubagents: 9,
            codexContextWindowOverride: 800000,
            requireIdleForSubagentLimitChange: true,
            requireIdleForCodexContextWindowChange: true,
          },
        };
        const refusal = {
          ok: false as const,
          error: {
            tag: "ProviderAdapterRequestError",
            message: "Configuration is deferred.",
            sessionReconfigurationRefusal: "codex-context-window-active" as const,
          },
        };
        const execute = Ref.update(calls, (n) => n + 1).pipe(Effect.as(refusal));
        expect(yield* ledger.runOnce(request, execute)).toEqual(refusal);
        expect(yield* ledger.runOnce(request, execute)).toEqual(refusal);
        expect(yield* Ref.get(calls)).toBe(1);
        for (const changed of [
          { ...request, payload: { ...request.payload, threadId: ThreadId.make("other-thread") } },
          {
            ...request,
            payload: {
              ...request.payload,
              providerInstanceId: ProviderInstanceId.make("other-account"),
            },
          },
          {
            ...request,
            payload: { ...request.payload, runtimeMode: "approval-required" as const },
          },
          { ...request, payload: { ...request.payload, maxConcurrentSubagents: 10 } },
          { ...request, payload: { ...request.payload, codexContextWindowOverride: 900000 } },
          {
            ...request,
            payload: { ...request.payload, requireIdleForCodexContextWindowChange: false },
          },
          {
            ...stopRequest,
            commandId: request.commandId,
            payload: { threadId: request.payload.threadId },
          },
        ]) {
          const result = yield* ledger.runOnce(changed, execute);
          expect(result).toMatchObject({
            ok: false,
            error: { tag: "ProviderDaemonCommandIdentityMismatch" },
          });
          if (!result.ok) expect(result.error).not.toHaveProperty("sessionReconfigurationRefusal");
        }
        expect(yield* Ref.get(calls)).toBe(1);
        // Reverse collisions likewise cannot certify a session opening using
        // an unrelated method's saved outcome. Exact retry still executes once.
        const ack = { ok: true as const, value: null };
        const executeAck = Ref.update(calls, (n) => n + 1).pipe(Effect.as(ack));
        expect(yield* ledger.runOnce(stopRequest, executeAck)).toEqual(ack);
        expect(
          yield* ledger.runOnce({ ...request, commandId: stopRequest.commandId }, execute),
        ).toMatchObject({
          ok: false,
          error: { tag: "ProviderDaemonCommandIdentityMismatch" },
        });
        expect(yield* Ref.get(calls)).toBe(2);
        const successful = { ...request, commandId: "successful-bound-session-start" };
        expect(yield* ledger.runOnce(successful, executeAck)).toEqual(ack);
        expect(yield* ledger.runOnce(successful, executeAck)).toEqual(ack);
        expect(
          yield* ledger.runOnce(
            { ...successful, payload: { ...successful.payload, maxConcurrentSubagents: 12 } },
            executeAck,
          ),
        ).toMatchObject({
          ok: false,
          error: { tag: "ProviderDaemonCommandIdentityMismatch" },
        });
        expect(yield* Ref.get(calls)).toBe(3);
        // A scoped synthetic legacy row has no decodable request witness. It must not
        // return a modern semantic refusal, reopen, or manufacture an ACK.
        const sql = yield* SqlClient.SqlClient;
        const storedCommandId = `${ownerKey}:${request.commandId}`;
        // Retain SQLite's NOT NULL invariant: an empty old/corrupt envelope
        // cannot supply request identity, without weakening the real schema.
        yield* sql`UPDATE provider_daemon_commands SET request_json = '{}' WHERE command_id = ${storedCommandId}`;
        expect(
          yield* sql`SELECT command_id AS "commandId", request_json AS "requestJson"
          FROM provider_daemon_commands WHERE command_id = ${storedCommandId}`,
        ).toEqual([{ commandId: storedCommandId, requestJson: "{}" }]);
        expect(yield* ledger.runOnce(request, execute)).toMatchObject({
          ok: false,
          error: { tag: "ProviderDaemonCommandIdentityMismatch" },
        });
        expect(yield* Ref.get(calls)).toBe(3);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("retains finite configuration refusal diagnostics and the exact non-replaying receipt", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ownerKey = "synthetic-refusal-diagnostics";
        const ledger = yield* makeProviderDaemonCommandLedger({ ownerKey });
        const calls = yield* Ref.make(0);
        for (const [index, code] of (
          ["subagent-concurrency-active", "codex-context-window-active"] as const
        ).entries()) {
          const request = {
            method: "startSession" as const,
            commandId: `refusal-command-000000000000${index}`,
            payload: {
              threadId: ThreadId.make("refusal-thread"),
              runtimeMode: "full-access" as const,
            },
          };
          const result = {
            ok: false as const,
            error: {
              tag: "ProviderAdapterRequestError",
              message: "Configuration is deferred.",
              sessionReconfigurationRefusal: code,
            },
          };
          const execute = Ref.update(calls, (n) => n + 1).pipe(Effect.as(result));
          expect(yield* ledger.runOnce(request, execute)).toEqual(result);
          expect(yield* ledger.runOnce(request, execute)).toEqual(result);
          const snapshot = yield* ledger.snapshot;
          expect(
            snapshot.recentFailedCommands.find(
              (row) => row.commandId === `${ownerKey}:${request.commandId}`,
            ),
          ).toMatchObject({
            errorTag: "ProviderAdapterRequestError",
            sessionReconfigurationRefusal: code,
            errorMessage: "Configuration is deferred.",
          });
          expect(snapshot.runningCommandCount).toBe(0);
        }
        expect(yield* Ref.get(calls)).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("deduplicates every rewind phase and binds receipts to exact thread, checkpoint and finish proof", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* makeProviderDaemonCommandLedger();
        const count = yield* Ref.make(0);
        const identity = {
          threadId: ThreadId.make("rewind-thread"),
          operationId: "2d157a02-7309-45ee-8b1c-4bf5da146a51",
        };
        const prepare = {
          method: "prepareConversationRollback",
          commandId: "rewind-prepare-command-0001",
          payload: {
            ...identity,
            numTurns: 2,
            firstRemovedTurnId: TurnId.make("removed-turn"),
            retainedTurnCount: 1,
            expectedControlSequence: 7,
          },
        } satisfies ProviderDaemonRpcRequestValue;
        const commit = {
          method: "commitConversationRollback",
          commandId: "rewind-commit-command-0001",
          payload: identity,
        } satisfies ProviderDaemonRpcRequestValue;
        const finish = {
          method: "finishConversationRollback",
          commandId: "rewind-finish-command-0001",
          payload: { ...identity, outcome: "committed", completionCommandId: "completion-proof" },
        } satisfies ProviderDaemonRpcRequestValue;
        const execute = Ref.update(count, (n) => n + 1).pipe(
          Effect.as({ ok: true as const, value: null }),
        );
        for (const request of [prepare, commit, finish]) {
          expect(ledger.isMutating(request.method)).toBe(true);
          expect(yield* ledger.runOnce(request, execute)).toEqual({ ok: true, value: null });
          expect(yield* ledger.runOnce(request, execute)).toEqual({ ok: true, value: null });
        }
        expect(yield* Ref.get(count)).toBe(3);
        for (const request of [
          {
            ...prepare,
            payload: { ...prepare.payload, threadId: ThreadId.make("different-thread") },
          },
          {
            ...prepare,
            payload: { ...prepare.payload, firstRemovedTurnId: TurnId.make("different-turn") },
          },
          { ...prepare, payload: { ...prepare.payload, expectedControlSequence: 8 } },
          { ...prepare, payload: { ...prepare.payload, retainedTurnCount: 0 } },
          { ...finish, payload: { ...finish.payload, outcome: "aborted" as const } },
          { ...finish, payload: { ...finish.payload, completionCommandId: "different-proof" } },
          { ...stopRequest, commandId: commit.commandId, payload: { threadId: identity.threadId } },
        ]) {
          expect(yield* ledger.runOnce(request, execute)).toMatchObject({
            ok: false,
            error: { tag: "ProviderDaemonCommandIdentityMismatch" },
          });
        }
        // The reverse collision cannot borrow an unrelated legacy command's ACK.
        yield* ledger.runOnce(stopRequest, execute);
        expect(
          yield* ledger.runOnce({ ...commit, commandId: stopRequest.commandId }, execute),
        ).toMatchObject({ ok: false, error: { tag: "ProviderDaemonCommandIdentityMismatch" } });
        expect(yield* Ref.get(count)).toBe(4);
        const sql = yield* SqlClient.SqlClient;
        const bindings =
          yield* sql`SELECT thread_id FROM provider_daemon_command_threads WHERE thread_id = ${identity.threadId}`;
        expect(bindings).toHaveLength(3);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("cannot certify a rewind receipt with absent or corrupt stored request identity", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* makeProviderDaemonCommandLedger();
        const request = {
          method: "commitConversationRollback",
          commandId: "rewind-commit-command-0001",
          payload: {
            threadId: ThreadId.make("rewind-thread"),
            operationId: "2d157a02-7309-45ee-8b1c-4bf5da146a51",
          },
        } satisfies ProviderDaemonRpcRequestValue;
        let count = 0;
        const execute = Effect.sync(() => {
          count += 1;
          return { ok: true as const, value: null };
        });
        yield* ledger.runOnce(request, execute);
        const sql = yield* SqlClient.SqlClient;
        // The SQL column is NOT NULL; exercise absent decoded identity with
        // an empty object, then a corrupt body, without weakening the schema.
        for (const requestJson of ["{}", "private-malformed-request"]) {
          yield* sql`UPDATE provider_daemon_commands SET request_json = ${requestJson}`;
          const result = yield* ledger.runOnce(request, execute);
          expect(result).toMatchObject({
            ok: false,
            error: { tag: "ProviderDaemonCommandIdentityMismatch" },
          });
          expect(encodeProviderJsonString(result)).not.toContain("private-malformed-request");
        }
        expect(count).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("never persists private interaction answers or authorization URLs", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* makeProviderDaemonCommandLedger();
        yield* ledger.runOnce(
          {
            method: "respondToInteraction",
            payload: {
              threadId: ThreadId.make("thread-1"),
              requestId: ApprovalRequestId.make("request"),
              response: { action: "accept", content: { credential: "private-answer" } },
            },
          },
          Effect.succeed({ ok: true, value: null }),
        );
        yield* ledger.runOnce(
          {
            method: "resolveInteractionUrl",
            payload: {
              threadId: ThreadId.make("thread-1"),
              requestId: ApprovalRequestId.make("request"),
            },
          },
          Effect.succeed({ ok: true, value: "https://example.com/?token=private-token" }),
        );
        expect((yield* ledger.snapshot).commandCount).toBe(0);
        const sql = yield* SqlClient.SqlClient;
        const rows =
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%command%'`;
        for (const row of rows) {
          const contents = yield* sql.unsafe(
            `SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`,
          );
          expect(encodeProviderJsonString(contents)).not.toContain("private-answer");
          expect(encodeProviderJsonString(contents)).not.toContain("private-token");
        }
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });
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
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("deduplicates native compaction under the original orchestration command identity", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* makeProviderDaemonCommandLedger();
        const count = yield* Ref.make(0);
        const commandId = CommandId.make("command-compact-0000000000000000000");
        const request = {
          method: "compactThread" as const,
          commandId,
          payload: {
            threadId: ThreadId.make("thread-1"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            operationId: commandId,
          },
        };
        const execute = Ref.update(count, (n) => n + 1).pipe(
          Effect.as({ ok: true as const, value: null }),
        );
        yield* ledger.runOnce(request, execute);
        yield* ledger.runOnce(request, execute);
        expect(yield* Ref.get(count)).toBe(1);
        expect((yield* ledger.snapshot).recentCompletedCommands[0]?.method).toBe("compactThread");
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("deduplicates goal mutations without exposing objective text in diagnostics", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const callCount = yield* Ref.make(0);
        const ledger = yield* makeProviderDaemonCommandLedger();
        const objective = "private goal objective";
        const request = {
          method: "setGoal",
          commandId: "command-goal-000000000000000000000",
          payload: {
            threadId: ThreadId.make("thread-1"),
            objective,
            status: "active",
            tokenBudget: null,
          },
        } satisfies ProviderDaemonRpcRequestValue;
        const result = {
          ok: true,
          value: {
            threadId: ThreadId.make("thread-1"),
            objective,
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        } as const;
        const execute = Ref.update(callCount, (count) => count + 1).pipe(Effect.as(result));

        expect(yield* ledger.runOnce(request, execute)).toEqual(result);
        expect(yield* ledger.runOnce(request, execute)).toEqual(result);

        const snapshot = yield* ledger.snapshot;
        expect(yield* Ref.get(callCount)).toBe(1);
        expect(snapshot.recentCompletedCommands[0]).toMatchObject({
          method: "setGoal",
          requestSummary: {
            method: "setGoal",
            threadId: "thread-1",
          },
          responseSummary: {
            ok: true,
            threadId: "thread-1",
            status: "active",
          },
        });
        expect(encodeProviderJsonString(snapshot)).not.toContain(objective);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
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
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
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
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
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
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
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
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });
});
