import { assert, it as effectIt } from "@effect/vitest";
import { ProviderInstanceId, SubagentRuntimeId, ThreadId, TurnId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../persistence/Migrations.ts";
import * as TestSqliteClient from "../persistence/TestSqliteClient.ts";
import {
  buildCodexTransientFailureMarkerPayload,
  codexTransientAcceptanceCommandId,
  codexTransientRecoveryDelayMs,
  makeCodexTransientRecoveryChainReader,
  makeRuntimeRecoveryBarrierReader,
  saturateRuntimeRecoveryAttempt,
} from "./providerRuntimeRecovery.ts";

const threadId = ThreadId.make("transient-thread");
const instanceId = ProviderInstanceId.make("codex-account");
const runtimeId = SubagentRuntimeId.make("00000000-0000-4000-8000-000000000142");
const turnId = TurnId.make("failed-root");
const now = "2026-10-10T00:00:00.000Z";

describe("persistent retry delay", () => {
  it("has nonzero bounded jitter, capped delay and saturating counters without an attempt ceiling", () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6, 30].map((attempt) => codexTransientRecoveryDelayMs(attempt, 1)),
    ).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    for (const attempt of [0, 30, 300, Number.MAX_SAFE_INTEGER]) {
      expect(codexTransientRecoveryDelayMs(attempt, 0)).toBeGreaterThanOrEqual(750);
      expect(codexTransientRecoveryDelayMs(attempt, 1)).toBeLessThanOrEqual(60000);
    }
    expect(codexTransientRecoveryDelayMs(30, Number.NaN)).toBe(60000);
    expect(saturateRuntimeRecoveryAttempt(Number.MAX_SAFE_INTEGER)).toBe(30);
    expect(saturateRuntimeRecoveryAttempt(31)).toBe(30);
    expect(saturateRuntimeRecoveryAttempt(-1)).toBe(0);
  });

  it("uses exact exponential jitter windows before retaining the capped window indefinitely", () => {
    const minimums = [750, 1500, 3000, 6000, 12000, 24000, 45000];
    const maximums = [1000, 2000, 4000, 8000, 16000, 32000, 60000];
    for (let attempt = 0; attempt <= 300; attempt += 1) {
      const index = Math.min(attempt, 6);
      const minimum = minimums[index]!;
      const maximum = maximums[index]!;
      expect(codexTransientRecoveryDelayMs(attempt, 0)).toBe(minimum);
      expect(codexTransientRecoveryDelayMs(attempt, 0.5)).toBe((minimum + maximum) / 2);
      expect(codexTransientRecoveryDelayMs(attempt, 1)).toBe(maximum);
      for (const jitter of [0.001, 0.125, 0.375, 0.999]) {
        const actual = codexTransientRecoveryDelayMs(attempt, jitter);
        expect(Number.isSafeInteger(actual)).toBe(true);
        expect(actual).toBe(Math.ceil(maximum * (0.75 + 0.25 * jitter)));
        expect(actual).toBeGreaterThanOrEqual(minimum);
        expect(actual).toBeLessThanOrEqual(maximum);
      }
    }
  });

  it("fails closed on malformed exponents and clamps jitter without eliminating the wait", () => {
    for (const attempt of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(saturateRuntimeRecoveryAttempt(attempt)).toBe(30);
      expect(codexTransientRecoveryDelayMs(attempt, 0)).toBe(45000);
      expect(codexTransientRecoveryDelayMs(attempt, 1)).toBe(60000);
    }
    expect(codexTransientRecoveryDelayMs(-1, 0)).toBe(750);
    expect(codexTransientRecoveryDelayMs(Number.MAX_SAFE_INTEGER, 0)).toBe(45000);
    expect(codexTransientRecoveryDelayMs(0, -1)).toBe(750);
    expect(codexTransientRecoveryDelayMs(0, 2)).toBe(1000);
    for (const jitter of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(codexTransientRecoveryDelayMs(0, jitter)).toBe(1000);
      expect(codexTransientRecoveryDelayMs(30, jitter)).toBe(60000);
    }
  });
});

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  const readBarrier = yield* makeRuntimeRecoveryBarrierReader;
  const readChain = yield* makeCodexTransientRecoveryChainReader;
  const [latest] = yield* sql<{ readonly version: number }>`
    SELECT COALESCE(MAX(stream_version), 0) AS version FROM orchestration_events
    WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
  `;
  let version = latest?.version ?? 0;
  const append = (eventType: string, payload: object, actor = "server", commandId?: string) =>
    Effect.gen(function* () {
      version += 1;
      const rows = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version,
          event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
          payload_json, metadata_json)
        VALUES (${`event-${version}`}, 'thread', ${threadId}, ${version}, ${eventType}, ${now},
          ${commandId ?? `server:test-${version}`}, NULL, NULL, ${actor},
          ${JSON.stringify({ threadId, createdAt: now, ...payload })}, '{}') RETURNING sequence
      `;
      return rows[0]!.sequence;
    });
  const marker = (root = turnId, kind = "codex-transient-root-failed") =>
    append("thread.activity-appended", {
      activity: {
        kind: "runtime.warning",
        turnId: root,
        payload: {
          ...buildCodexTransientFailureMarkerPayload({
            providerInstanceId: instanceId,
            subagentRuntimeId: runtimeId,
            sessionUpdatedAt: now,
          }),
          recovery: kind,
        },
      },
    });
  const recovery = (source: number, root = turnId, attempt = 0, chainSource = source) => ({
    sourceEventSequence: source,
    turnId: root,
    sessionUpdatedAt: now,
    codexTransientFailure: {
      providerInstanceId: instanceId,
      subagentRuntimeId: runtimeId,
      chainSourceEventSequence: chainSource,
      retryAttempt: attempt,
    },
  });
  const humanStart = () =>
    append("thread.turn-start-requested", { messageId: "human-message" }, "client");
  const acceptRecovery = (firstSource: number, runtimeRecovery: object) =>
    Effect.gen(function* () {
      const intent = yield* append("thread.turn-start-requested", {
        messageId: "counter-recovery-message",
        runtimeRecovery,
      });
      yield* append(
        "thread.activity-appended",
        {
          activity: {
            kind: "runtime.warning",
            turnId,
            payload: {
              recovery: "codex-transient-continuation-attempted",
              sourceEventSequence: firstSource,
              attemptOwnerId: "counter-winning-owner",
            },
          },
        },
        "server",
        `server:runtime-recovery-attempt:${intent}`,
      );
      const nextRoot = TurnId.make("counter-accepted-then-failed-root");
      const source = yield* marker(nextRoot);
      yield* append(
        "thread.activity-appended",
        {
          activity: {
            kind: "runtime.warning",
            turnId: nextRoot,
            payload: {
              recovery: "codex-transient-continuation-accepted",
              recoveryIntentSequence: intent,
              attemptOwnerId: "counter-winning-owner",
              providerInstanceId: instanceId,
              subagentRuntimeId: runtimeId,
            },
          },
        },
        "server",
        codexTransientAcceptanceCommandId(threadId, nextRoot),
      );
      return {
        threadId,
        turnId: nextRoot,
        sourceEventSequence: source,
        providerInstanceId: instanceId,
        subagentRuntimeId: runtimeId,
      };
    });
  return { sql, append, marker, recovery, humanStart, acceptRecovery, readBarrier, readChain };
});

effectIt.layer(TestSqliteClient.layerMemory())("transient chain durability", (it) => {
  it.effect(
    "requires exact server markers and retains intent barriers through long streamed output",
    () =>
      Effect.gen(function* () {
        const s = yield* setup;
        yield* s.humanStart();
        const source = yield* s.marker();
        const input = { ...s.recovery(source), threadId };
        assert.equal(yield* s.readBarrier(input), true);
        for (let i = 0; i < 300; i += 1)
          yield* s.append("thread.message-sent", { messageId: `delta-${i}` });
        assert.equal(yield* s.readBarrier(input), true);
        assert.equal(
          yield* s.readBarrier({
            ...input,
            codexTransientFailure: {
              ...input.codexTransientFailure,
              subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000999"),
            },
          }),
          false,
        );
        assert.equal(
          yield* s.readBarrier({
            ...input,
            codexTransientFailure: {
              ...input.codexTransientFailure,
              retryAttempt: 31,
            },
          }),
          false,
        );
        yield* s.append("thread.session-stop-requested", {}, "client");
        assert.equal(yield* s.readBarrier(input), false);
      }),
  );

  it.effect(
    "parks unknown ACKs without turn.started and advances only exact accepted owner receipts",
    () =>
      Effect.gen(function* () {
        const s = yield* setup;
        yield* s.humanStart();
        const firstSource = yield* s.marker();
        const first = s.recovery(firstSource, turnId, 30);
        const intent = yield* s.append("thread.turn-start-requested", {
          messageId: "recovery-message",
          runtimeRecovery: first,
        });
        yield* s.append(
          "thread.activity-appended",
          {
            activity: {
              kind: "runtime.warning",
              turnId,
              payload: {
                recovery: "codex-transient-continuation-attempted",
                sourceEventSequence: firstSource,
                attemptOwnerId: "winning-owner",
              },
            },
          },
          "server",
          `server:runtime-recovery-attempt:${intent}`,
        );
        const nextRoot = TurnId.make("accepted-then-failed-root");
        // No native start/projection attribution is necessary to remember the
        // ambiguous attempt, even after a long transcript suffix.
        for (let i = 0; i < 300; i += 1)
          yield* s.append("thread.message-sent", { messageId: `later-${i}` });
        const source = yield* s.marker(nextRoot);
        const input = {
          threadId,
          turnId: nextRoot,
          sourceEventSequence: source,
          providerInstanceId: instanceId,
          subagentRuntimeId: runtimeId,
        };
        assert.deepStrictEqual(yield* s.readChain(input), { status: "pending" });
        const receipt = (owner: string) => ({
          activity: {
            kind: "runtime.warning",
            turnId: nextRoot,
            payload: {
              recovery: "codex-transient-continuation-accepted",
              recoveryIntentSequence: intent,
              attemptOwnerId: owner,
              providerInstanceId: instanceId,
              subagentRuntimeId: runtimeId,
            },
          },
        });
        yield* s.append(
          "thread.activity-appended",
          receipt("winning-owner"),
          "provider",
          codexTransientAcceptanceCommandId(threadId, nextRoot),
        );
        assert.deepStrictEqual(yield* s.readChain(input), { status: "pending" });
        yield* s.append(
          "thread.activity-appended",
          receipt("losing-owner"),
          "server",
          codexTransientAcceptanceCommandId(threadId, nextRoot),
        );
        assert.deepStrictEqual(yield* s.readChain(input), { status: "pending" });
        yield* s.append(
          "thread.activity-appended",
          receipt("winning-owner"),
          "server",
          codexTransientAcceptanceCommandId(threadId, nextRoot),
        );
        assert.deepStrictEqual(yield* s.readChain(input), {
          status: "accepted",
          chainSourceEventSequence: firstSource,
          retryAttempt: 30,
          continuationOrdinal: 32,
          continuationOrdinalLowerBound: true,
        });
        assert.equal(
          yield* s.readBarrier({ ...s.recovery(source, nextRoot, 30, firstSource), threadId }),
          true,
        );
        yield* s.humanStart();
        const freshSource = yield* s.marker(TurnId.make("new-human-root"));
        assert.deepStrictEqual(
          yield* s.readChain({
            ...input,
            turnId: TurnId.make("new-human-root"),
            sourceEventSequence: freshSource,
          }),
          {
            status: "fresh",
            chainSourceEventSequence: freshSource,
            retryAttempt: 0,
            continuationOrdinal: 1,
          },
        );
        assert.equal(
          yield* s.readBarrier({ ...s.recovery(source, nextRoot, 30, firstSource), threadId }),
          false,
        );
      }),
  );

  it.effect("keeps truthful continuation totals separate from the saturated backoff exponent", () =>
    Effect.gen(function* () {
      const s = yield* setup;
      yield* s.humanStart();
      const firstSource = yield* s.marker();
      const first = s.recovery(firstSource, turnId, 30);
      const input = yield* s.acceptRecovery(firstSource, {
        ...first,
        codexTransientFailure: {
          ...first.codexTransientFailure,
          continuationOrdinal: 35,
        },
      });
      const expected = {
        status: "accepted",
        chainSourceEventSequence: firstSource,
        retryAttempt: 30,
        continuationOrdinal: 36,
      } as const;
      assert.deepStrictEqual(yield* s.readChain(input), expected);
      // Reading or streaming another diagnostic cannot advance the counter:
      // only the next exact accepted continuation owns a new ordinal.
      yield* s.append("thread.activity-appended", {
        activity: {
          kind: "runtime.warning",
          turnId: input.turnId,
          payload: { recovery: "codex-transient-recovery-waiting", retryAttempt: 30 },
        },
      });
      assert.deepStrictEqual(yield* s.readChain(input), expected);
      assert.deepStrictEqual(
        yield* s.readChain({
          ...input,
          providerInstanceId: ProviderInstanceId.make("other-codex-account"),
        }),
        { status: "pending" },
      );
      assert.deepStrictEqual(
        yield* s.readChain({
          ...input,
          subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000999"),
        }),
        { status: "pending" },
      );
      yield* s.humanStart();
      const freshRoot = TurnId.make("fresh-counter-human-root");
      const freshSource = yield* s.marker(freshRoot);
      assert.deepStrictEqual(
        yield* s.readChain({ ...input, turnId: freshRoot, sourceEventSequence: freshSource }),
        {
          status: "fresh",
          chainSourceEventSequence: freshSource,
          retryAttempt: 0,
          continuationOrdinal: 1,
        },
      );
      assert.equal(
        yield* s.readBarrier({
          ...s.recovery(input.sourceEventSequence, input.turnId, 30, firstSource),
          threadId,
        }),
        false,
      );
    }),
  );

  it.effect(
    "reports exact legacy totals only below saturation and preserves lower-bound evidence",
    () =>
      Effect.gen(function* () {
        const s = yield* setup;
        const cases = [
          { attempt: 0, metadata: {}, ordinal: 2, lowerBound: false },
          { attempt: 29, metadata: {}, ordinal: 31, lowerBound: false },
          { attempt: 30, metadata: {}, ordinal: 32, lowerBound: true },
          {
            attempt: 30,
            metadata: { continuationOrdinal: 35, continuationOrdinalLowerBound: true },
            ordinal: 36,
            lowerBound: true,
          },
          {
            attempt: 30,
            metadata: { continuationOrdinal: Number.MAX_SAFE_INTEGER - 1 },
            ordinal: Number.MAX_SAFE_INTEGER,
            lowerBound: false,
          },
          {
            attempt: 30,
            metadata: { continuationOrdinal: Number.MAX_SAFE_INTEGER },
            ordinal: Number.MAX_SAFE_INTEGER,
            lowerBound: true,
          },
        ];
        for (const row of cases) {
          yield* s.humanStart();
          const firstSource = yield* s.marker();
          const first = s.recovery(firstSource, turnId, row.attempt);
          const input = yield* s.acceptRecovery(firstSource, {
            ...first,
            codexTransientFailure: { ...first.codexTransientFailure, ...row.metadata },
          });
          assert.deepStrictEqual(yield* s.readChain(input), {
            status: "accepted",
            chainSourceEventSequence: firstSource,
            retryAttempt: Math.min(row.attempt + 1, 30),
            continuationOrdinal: row.ordinal,
            ...(row.lowerBound ? { continuationOrdinalLowerBound: true } : {}),
          });
        }
      }),
  );

  it.effect(
    "omits malformed presentation counters without granting or revoking retry authority",
    () =>
      Effect.gen(function* () {
        const s = yield* setup;
        const malformed = [
          { continuationOrdinal: 0 },
          { continuationOrdinal: -1 },
          { continuationOrdinal: 1.5 },
          { continuationOrdinal: Number.MAX_SAFE_INTEGER + 1 },
          { continuationOrdinal: Number.MAX_VALUE },
          { continuationOrdinal: "35" },
          { continuationOrdinal: null },
          { continuationOrdinal: true },
          { continuationOrdinal: { nested: 35 } },
          { continuationOrdinal: [35] },
          { continuationOrdinal: 35, continuationOrdinalLowerBound: false },
          { continuationOrdinal: 35, continuationOrdinalLowerBound: "true" },
          { continuationOrdinal: 35, continuationOrdinalLowerBound: null },
          { continuationOrdinalLowerBound: true },
        ];
        for (const metadata of malformed) {
          yield* s.humanStart();
          const firstSource = yield* s.marker();
          const first = s.recovery(firstSource, turnId, 30);
          const input = yield* s.acceptRecovery(firstSource, {
            ...first,
            codexTransientFailure: { ...first.codexTransientFailure, ...metadata },
          });
          assert.deepStrictEqual(yield* s.readChain(input), {
            status: "accepted",
            chainSourceEventSequence: firstSource,
            retryAttempt: 30,
          });
          // The counter is deliberately not part of the recovery grant. The
          // immutable loss marker and existing exact ownership/control fences
          // continue to decide whether a continuation is eligible.
          assert.equal(
            yield* s.readBarrier({
              ...s.recovery(input.sourceEventSequence, input.turnId, 30, firstSource),
              threadId,
            }),
            true,
          );
        }
      }),
  );

  it.effect("keeps owner-loss suffix limits and refuses wrong-intent exemptions", () =>
    Effect.gen(function* () {
      const s = yield* setup;
      yield* s.humanStart();
      const source = yield* s.marker(turnId, "provider-runtime-ownership-lost");
      const input = { threadId, turnId, sourceEventSequence: source, sessionUpdatedAt: now };
      assert.equal(yield* s.readBarrier(input), true);
      for (let i = 0; i < 257; i += 1)
        yield* s.append("thread.activity-appended", {
          activity: { kind: "received", payload: {} },
        });
      assert.equal(yield* s.readBarrier(input), false);
    }),
  );
});
