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
  return { sql, append, marker, recovery, humanStart, readBarrier, readChain };
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
          { status: "fresh", chainSourceEventSequence: freshSource, retryAttempt: 0 },
        );
        assert.equal(
          yield* s.readBarrier({ ...s.recovery(source, nextRoot, 30, firstSource), threadId }),
          false,
        );
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
