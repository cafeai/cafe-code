import {
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  TurnId,
  type ProviderSendTurnInput,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceTest } from "../persistence/Sqlite.test.fixture.ts";
import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import {
  codexFailedRootRetryClaimCommandId,
  codexFailedRootRetryRefusalCommandId,
  codexFailedRootRetryRequestCommitment,
  makeCodexFailedRootRetryReader,
  readCodexFailedRootRetirementRefusal,
  type CodexFailedRootRetryIdentity,
} from "./codexFailedRootRetry.ts";

const now = "2026-10-19T01:00:00.000Z";
const account = ProviderInstanceId.make("retry-account");
const runtime = SubagentRuntimeId.make("00000000-0000-4000-8000-000000000221");

describe("failed-root pre-submission retry evidence", () => {
  it("commits schema-canonical private requests and separates every relevant input", () => {
    const request: ProviderSendTurnInput = {
      threadId: ThreadId.make("request-thread"),
      input: "Private continuation.",
      allowActiveTurnSteerFallback: false,
      expectedFailedRoot: {
        turnId: TurnId.make("request-turn"),
        providerThreadId: "private-native-history",
        subagentRuntimeId: runtime,
        providerInstanceId: account,
        observedAt: now,
        restartSession: true,
      },
    };
    const commitment = codexFailedRootRetryRequestCommitment(request);
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
    const reordered = {
      expectedFailedRoot: {
        restartSession: true as const,
        observedAt: now,
        providerInstanceId: account,
        subagentRuntimeId: runtime,
        providerThreadId: "private-native-history",
        turnId: TurnId.make("request-turn"),
      },
      allowActiveTurnSteerFallback: false,
      input: "Private continuation.",
      threadId: request.threadId,
    };
    expect(codexFailedRootRetryRequestCommitment(reordered)).toBe(commitment);
    for (const changed of [
      { ...request, input: "Other continuation." },
      { ...request, threadId: ThreadId.make("other-thread") },
      { ...request, allowActiveTurnSteerFallback: true },
      ...[
        { ...request.expectedFailedRoot!, turnId: TurnId.make("other-turn") },
        { ...request.expectedFailedRoot!, providerThreadId: "other-history" },
        {
          ...request.expectedFailedRoot!,
          providerInstanceId: ProviderInstanceId.make("other-account"),
        },
        {
          ...request.expectedFailedRoot!,
          subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000222"),
        },
        { ...request.expectedFailedRoot!, observedAt: "2026-10-19T01:00:00.001Z" },
        { ...request.expectedFailedRoot!, restartSession: undefined },
      ].map((expectedFailedRoot) => ({ ...request, expectedFailedRoot })),
    ])
      expect(codexFailedRootRetryRequestCommitment(changed)).not.toBe(commitment);
    expect(() =>
      codexFailedRootRetryRequestCommitment({ ...request, threadId: 7 } as never),
    ).toThrow();
    for (const value of [0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => codexFailedRootRetryClaimCommandId(value)).toThrow();
      expect(() => codexFailedRootRetryRefusalCommandId(1, value)).toThrow();
    }
    const sequences = [1, 9, 10, 99, 100, 1_000_000, Number.MAX_SAFE_INTEGER];
    const ids = sequences.map((sequence) => codexFailedRootRetryRefusalCommandId(7, sequence));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(sequences.length);
  });

  it("accepts only sole own-data typed refusal failures, never unknown/proxy/getter/composite causes", () => {
    const local = () =>
      new ProviderAdapterRequestError({
        provider: "codex",
        method: "turn/start",
        detail: "Fixed refusal.",
        failedRootRetirementRefusal: "notifications-pending",
      });
    const remote = () =>
      new ProviderAdapterRequestError({
        provider: "provider-daemon",
        method: "sendTurn",
        remoteErrorTag: "ProviderAdapterRequestError",
        detail: "Fixed refusal.",
        failedRootRetirementRefusal: "notifications-pending",
      });
    expect(readCodexFailedRootRetirementRefusal(Cause.fail(local()))).toBe("notifications-pending");
    expect(readCodexFailedRootRetirementRefusal(Cause.fail(remote()))).toBe(
      "notifications-pending",
    );
    let getterReads = 0;
    let proxyReads = 0;
    const getter = Object.defineProperty(local(), "failedRootRetirementRefusal", {
      get: () => {
        getterReads += 1;
        return "notifications-pending";
      },
    });
    const inherited = local();
    delete (inherited as { failedRootRetirementRefusal?: unknown }).failedRootRetirementRefusal;
    Object.setPrototypeOf(
      inherited,
      Object.create(Object.getPrototypeOf(inherited), {
        failedRootRetirementRefusal: { value: "notifications-pending" },
      }),
    );
    const proxy = new Proxy(local(), {
      get: () => {
        proxyReads += 1;
        throw Error("Must not inspect proxy.");
      },
      getOwnPropertyDescriptor: () => {
        proxyReads += 1;
        throw Error("Must not inspect proxy.");
      },
      getPrototypeOf: () => {
        proxyReads += 1;
        throw Error("Must not inspect proxy.");
      },
    });
    const revoked = Proxy.revocable(local(), {});
    revoked.revoke();
    const remoteGetter = Object.defineProperty(remote(), "remoteErrorTag", {
      get: () => {
        getterReads += 1;
        return "ProviderAdapterRequestError";
      },
    });
    const causes: Cause.Cause<unknown>[] = [
      Cause.empty,
      Cause.die(local()),
      Cause.interrupt(),
      Cause.combine(Cause.fail(local()), Cause.die("unrelated")),
      Cause.combine(Cause.fail(local()), Cause.fail(new Error("Other failure."))),
      Cause.fail(getter),
      Cause.fail(inherited),
      Cause.fail(proxy),
      Cause.fail(revoked.proxy),
      Cause.fail(remoteGetter),
      Cause.fail(
        Object.assign(new Error("notifications-pending"), {
          provider: "codex",
          method: "turn/start",
          failedRootRetirementRefusal: "notifications-pending",
        }),
      ),
    ];
    for (const [provider, method, remoteErrorTag] of [
      ["claudeAgent", "turn/start", undefined],
      ["codex", "turn/steer", undefined],
      ["provider-daemon", "startSession", "ProviderAdapterRequestError"],
      ["provider-daemon", "sendTurn", undefined],
      ["provider-daemon", "sendTurn", "notifications-pending"],
    ]) {
      causes.push(
        Cause.fail(
          new ProviderAdapterRequestError({
            provider: provider!,
            method: method!,
            ...(remoteErrorTag === undefined ? {} : { remoteErrorTag }),
            detail: "Fixed refusal.",
            failedRootRetirementRefusal: "notifications-pending",
          }),
        ),
      );
    }
    for (const reason of [undefined, null, false, 7, {}, "unknown"]) {
      // Construct a valid typed error first: the schema constructor correctly
      // rejects malformed fields before the guarded reader can inspect them.
      // A later own data property models a corrupted/foreign received object.
      const malformed = new ProviderAdapterRequestError({
        provider: "codex",
        method: "turn/start",
        detail: "Fixed refusal.",
      });
      if (reason !== undefined)
        Object.defineProperty(malformed, "failedRootRetirementRefusal", {
          value: reason,
          configurable: true,
        });
      causes.push(Cause.fail(malformed));
    }
    for (const cause of causes) expect(readCodexFailedRootRetirementRefusal(cause)).toBeUndefined();
    expect(getterReads).toBe(0);
    expect(proxyReads).toBe(0);
  });

  const fixture = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = yield* makeCodexFailedRootRetryReader;
    let eventCount = 0;
    let fixtureCount = 0;
    const append = (
      threadId: ThreadId,
      commandId: string,
      payload: unknown,
      options?: { actor?: string; eventType?: string; aggregate?: string; rawPayload?: string },
    ) =>
      Effect.gen(function* () {
        const id = ++eventCount;
        const rows = yield* sql<{
          readonly sequence: number;
        }>`INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, actor_kind, payload_json, metadata_json)
        VALUES (${`retry-test-event-${id}`}, ${options?.aggregate ?? "thread"}, ${threadId}, ${id}, ${options?.eventType ?? "thread.activity-appended"}, ${now}, ${commandId}, ${options?.actor ?? "server"}, ${options?.rawPayload ?? JSON.stringify(payload)}, '{}') RETURNING sequence`;
        return rows[0]!.sequence;
      });
    const create = () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`receipt-thread-${++fixtureCount}`);
        const turnId = TurnId.make(`receipt-turn-${fixtureCount}`);
        const sourceEventSequence = yield* append(threadId, `source-${fixtureCount}`, {
          threadId,
          activity: {
            kind: "runtime.warning",
            turnId,
            payload: { recovery: "codex-transient-root-failed" },
          },
        });
        const intentSequence = yield* append(
          threadId,
          `intent-${fixtureCount}`,
          {
            threadId,
            runtimeRecovery: {
              sourceEventSequence,
              turnId,
              sessionUpdatedAt: now,
              codexTransientFailure: { providerInstanceId: account, subagentRuntimeId: runtime },
            },
          },
          { eventType: "thread.turn-start-requested" },
        );
        const input: CodexFailedRootRetryIdentity = {
          threadId,
          turnId,
          intentSequence,
          sourceEventSequence,
          providerInstanceId: account,
          subagentRuntimeId: runtime,
          sessionUpdatedAt: now,
        };
        const request: ProviderSendTurnInput = {
          threadId,
          input: "Continue private history.",
          expectedFailedRoot: {
            turnId,
            providerThreadId: "private-history",
            subagentRuntimeId: runtime,
            providerInstanceId: account,
            observedAt: now,
            restartSession: true,
          },
        };
        const base = {
          recoveryIntentSequence: intentSequence,
          sourceEventSequence,
          providerInstanceId: account,
          subagentRuntimeId: runtime,
          sessionUpdatedAt: now,
          attemptOwnerId: "root-owner",
          requestCommitment: codexFailedRootRetryRequestCommitment(request),
          nativeConversationCommitment: "a".repeat(64),
        };
        const activity = (payload: Record<string, unknown>) => ({
          threadId,
          activity: { kind: "runtime.warning", turnId, payload },
        });
        const rootPayload = {
          ...base,
          recovery: "codex-transient-continuation-attempted",
          claimOwnerId: "root-owner",
        };
        const rootId = codexFailedRootRetryClaimCommandId(intentSequence);
        const root = (
          patch: Record<string, unknown> = {},
          options?: Parameters<typeof append>[3],
        ) => append(threadId, rootId, activity({ ...rootPayload, ...patch }), options);
        const refusal = (
          claimSequence: number,
          claimCommandId = rootId,
          claimOwnerId = "root-owner",
          patch: Record<string, unknown> = {},
          options?: Parameters<typeof append>[3],
        ) =>
          append(
            threadId,
            codexFailedRootRetryRefusalCommandId(intentSequence, claimSequence),
            activity({
              ...base,
              recovery: "codex-transient-continuation-unsubmitted",
              claimCommandId,
              claimOwnerId,
              nextPreparationAttempt: 30,
              failedRootRetirementRefusal: "notifications-pending",
              ...patch,
            }),
            options,
          );
        const retry = (
          previousRefusalSequence: number,
          claimOwnerId = "retry-owner",
          patch: Record<string, unknown> = {},
          options?: Parameters<typeof append>[3],
        ) =>
          append(
            threadId,
            codexFailedRootRetryClaimCommandId(intentSequence, previousRefusalSequence),
            activity({
              ...base,
              recovery: "codex-transient-continuation-resubmit-attempted",
              claimOwnerId,
              previousRefusalSequence,
              ...patch,
            }),
            options,
          );
        return { input, base, rootId, root, refusal, retry, activity };
      });
    return { sql, read, append, create };
  });

  it("reconstructs repeated definite refusals without renewing an unknown or consumed subclaim", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const t = yield* f.create();
        expect(yield* f.read(t.input)).toEqual({ status: "fresh" });
        const rootSequence = yield* t.root();
        expect(yield* f.read(t.input)).toEqual({ status: "consumed" });
        const first = yield* t.refusal(rootSequence);
        const expected = {
          status: "refused",
          attemptOwnerId: "root-owner",
          requestCommitment: t.base.requestCommitment,
          refusalSequence: first,
          nextPreparationAttempt: 30,
        };
        expect(yield* f.read(t.input)).toEqual(expected);
        // A new process obtains the same immutable authority, not a reset owner.
        const restartedRead = yield* makeCodexFailedRootRetryReader;
        expect(yield* restartedRead(t.input)).toEqual(expected);
        const retrySequence = yield* t.retry(first);
        expect(yield* restartedRead(t.input)).toEqual({ status: "consumed" });
        const second = yield* t.refusal(
          retrySequence,
          codexFailedRootRetryClaimCommandId(t.input.intentSequence, first),
          "retry-owner",
        );
        expect(yield* restartedRead(t.input)).toEqual({ ...expected, refusalSequence: second });
        const retry2 = yield* t.retry(second, "retry-owner-2");
        expect(yield* restartedRead(t.input)).toEqual({ status: "consumed" });
        const third = yield* t.refusal(
          retry2,
          codexFailedRootRetryClaimCommandId(t.input.intentSequence, second),
          "retry-owner-2",
        );
        expect(yield* restartedRead(t.input)).toEqual({ ...expected, refusalSequence: third });
        // Counter saturation is delay bookkeeping only. Unique event-sequence
        // reservations continue to advance even after the exponent reaches30.
        yield* t.retry(third, "retry-owner-3");
        expect(yield* restartedRead(t.input)).toEqual({ status: "consumed" });
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("refuses legacy, foreign, malformed, changed and ambiguous durable authority without falling back", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const patch of [
          { requestCommitment: undefined },
          { claimOwnerId: "other-owner" },
          { attemptOwnerId: "" },
          { nativeConversationCommitment: "bad" },
          { recoveryIntentSequence: 0 },
          { sourceEventSequence: 0 },
          { providerInstanceId: "other-account" },
          { subagentRuntimeId: "other-runtime" },
          { sessionUpdatedAt: "other-time" },
        ]) {
          const t = yield* f.create();
          const root = yield* t.root(patch);
          yield* t.refusal(root);
          expect(yield* f.read(t.input)).toEqual({ status: "consumed" });
        }
        for (const patch of [
          { recovery: "unrecognized" },
          { requestCommitment: "b".repeat(64) },
          { nativeConversationCommitment: "b".repeat(64) },
          { attemptOwnerId: "other-owner" },
          { claimOwnerId: "other-owner" },
          { claimCommandId: "other-command" },
          { failedRootRetirementRefusal: undefined },
          { failedRootRetirementRefusal: "unknown" },
          { nextPreparationAttempt: 0 },
          { nextPreparationAttempt: 31 },
          { nextPreparationAttempt: 1.5 },
          { recoveryIntentSequence: 0 },
          { sourceEventSequence: 0 },
          { providerInstanceId: "other-account" },
          { subagentRuntimeId: "other-runtime" },
          { sessionUpdatedAt: "other-time" },
        ]) {
          const t = yield* f.create();
          const root = yield* t.root();
          yield* t.refusal(root, t.rootId, "root-owner", patch);
          expect(yield* f.read(t.input)).toEqual({ status: "consumed" });
        }
        for (const options of [
          { actor: "client" },
          { actor: "provider" },
          { eventType: "thread.meta-updated" },
          { aggregate: "project" },
          { rawPayload: JSON.stringify({ large: "x".repeat(16_385) }) },
        ]) {
          const t = yield* f.create();
          const root = yield* t.root();
          yield* t.refusal(root, t.rootId, "root-owner", {}, options);
          expect(yield* f.read(t.input)).toEqual({ status: "consumed" });
        }
        const t = yield* f.create();
        const root = yield* t.root();
        const receipt = yield* t.refusal(root);
        for (const input of [
          { ...t.input, threadId: ThreadId.make("other-thread") },
          { ...t.input, turnId: TurnId.make("other-turn") },
          { ...t.input, providerInstanceId: ProviderInstanceId.make("other-account") },
          {
            ...t.input,
            subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000223"),
          },
          { ...t.input, sessionUpdatedAt: "other-time" },
          { ...t.input, sourceEventSequence: 0 },
        ])
          expect(yield* f.read(input)).toEqual({ status: "consumed" });
        // A newer malformed prefix receipt vetoes; it cannot resurrect the older
        // valid refusal. An exact duplicate is likewise ambiguous, not a winner.
        yield* f.append(
          t.input.threadId,
          `server:codex-transient-unsubmitted:${t.input.intentSequence}:zz`,
          t.activity({ ...t.base, recovery: "codex-transient-continuation-unsubmitted" }),
        );
        expect(yield* f.read(t.input)).toEqual({ status: "consumed" });
        const duplicate = yield* f.create();
        const duplicateRoot = yield* duplicate.root();
        yield* duplicate.refusal(duplicateRoot);
        yield* duplicate.refusal(duplicateRoot);
        expect(yield* f.read(duplicate.input)).toEqual({ status: "consumed" });
        const wrongRetry = yield* f.create();
        const wrongRoot = yield* wrongRetry.root();
        const previous = yield* wrongRetry.refusal(wrongRoot);
        const claim = yield* wrongRetry.retry(previous, "retry-owner", {
          previousRefusalSequence: receipt,
        });
        yield* wrongRetry.refusal(
          claim,
          codexFailedRootRetryClaimCommandId(wrongRetry.input.intentSequence, previous),
          "retry-owner",
        );
        expect(yield* f.read(wrongRetry.input)).toEqual({ status: "consumed" });
        const missingProof = yield* f.create();
        const proofRoot = yield* missingProof.root();
        const previousProof = yield* missingProof.refusal(
          proofRoot,
          missingProof.rootId,
          "root-owner",
          { failedRootRetirementRefusal: undefined },
        );
        const proofClaim = yield* missingProof.retry(previousProof);
        yield* missingProof.refusal(
          proofClaim,
          codexFailedRootRetryClaimCommandId(missingProof.input.intentSequence, previousProof),
          "retry-owner",
        );
        expect(yield* f.read(missingProof.input)).toEqual({ status: "consumed" });
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("uses the existing command-id B-tree endpoint without sorting or scanning retry history", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture;
        const t = yield* f.create();
        const root = yield* t.root();
        yield* t.refusal(root);
        const prefix = `server:codex-transient-unsubmitted:${t.input.intentSequence}:`;
        const rows = yield* f.sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
        SELECT sequence, command_id FROM orchestration_events INDEXED BY idx_orch_events_command_id
        WHERE command_id >= ${prefix} AND command_id < ${prefix + "~"}
        ORDER BY command_id DESC LIMIT 1`;
        expect(rows.some((row) => /SEARCH.*idx_orch_events_command_id/.test(row.detail))).toBe(
          true,
        );
        expect(rows.some((row) => /TEMP B-TREE|SCAN orchestration_events/.test(row.detail))).toBe(
          false,
        );
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });
});
