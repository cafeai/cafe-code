import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ThreadId, TurnId } from "@cafecode/contracts";
import { CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE } from "@cafecode/shared/codexHistorySafety";
import {
  CODEX_HISTORY_CANDIDATE_LIMIT,
  CODEX_HISTORY_DIAGNOSIS_UNCERTAIN_MESSAGE,
} from "../codexHistorySafety.ts";
import { makeCodexSessionRuntime, type CodexSessionRuntimeOptions } from "./CodexSessionRuntime.ts";

const nativeThreadId = "synthetic-native-thread";
const nativeTurnId = "synthetic-native-turn";
const oversized = JSON.stringify({
  error: {
    type: "invalid_request_error",
    code: "string_above_max_length",
    param: "input[169].arguments",
    message: "PRIVATE_PROVIDER_DETAIL",
  },
});

/** The real runtime/client are exercised against an in-memory JSONL peer. */
const fixture = (
  historySafety: NonNullable<CodexSessionRuntimeOptions["historySafety"]>,
  options: { resume?: boolean; holdTurnAck?: boolean; holdSnapshotRead?: boolean } = {},
) =>
  Effect.gen(function* () {
    const output = yield* Queue.unbounded<Uint8Array>();
    const calls: string[] = [];
    const turnRequested = yield* Deferred.make<string | number>();
    const snapshotRequested = yield* Deferred.make<string | number>();
    let snapshotTurns: unknown[] = [];
    const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    const turn = {
      id: nativeTurnId,
      status: "inProgress",
      items: [],
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    };
    const thread = {
      id: nativeThreadId,
      cliVersion: "0.160.1",
      createdAt: 1,
      updatedAt: 1,
      cwd: process.cwd(),
      ephemeral: false,
      modelProvider: "openai",
      preview: "",
      projectId: null,
      sessionId: "synthetic-session",
      source: "appServer",
      turns: [],
      status: { type: "idle" },
    };
    const opened = {
      cwd: process.cwd(),
      model: "gpt-6.1-sol",
      modelProvider: "openai",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
      thread,
    };
    let pending = "";
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(7001),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach((chunk: Uint8Array) =>
            Effect.gen(function* () {
              pending += new TextDecoder().decode(chunk);
              const lines = pending.split("\n");
              pending = lines.pop() ?? "";
              for (const line of lines) {
                const request = JSON.parse(line) as { id?: string | number; method: string };
                if (request.id === undefined) continue;
                calls.push(request.method);
                if (request.method === "turn/start" && options.holdTurnAck) {
                  yield* Deferred.succeed(turnRequested, request.id);
                  continue;
                }
                if (request.method === "thread/turns/list" && options.holdSnapshotRead) {
                  yield* Deferred.succeed(snapshotRequested, request.id);
                  continue;
                }
                const result =
                  request.method === "initialize"
                    ? {
                        userAgent: "synthetic",
                        codexHome: process.cwd(),
                        platformFamily: "synthetic",
                        platformOs: "synthetic",
                      }
                    : request.method === "thread/start" || request.method === "thread/resume"
                      ? opened
                      : request.method === "thread/read"
                        ? { thread }
                        : request.method === "thread/turns/list"
                          ? { data: snapshotTurns, nextCursor: null }
                          : request.method === "turn/start" || request.method === "review/start"
                            ? { turn }
                            : request.method === "thread/goal/get"
                              ? { goal: null }
                              : {};
                yield* Queue.offer(output, encode({ id: request.id, result }));
              }
            }),
          ),
          stdout: Stream.fromQueue(output),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make("synthetic-cafe-thread"),
      binaryPath: "never-launched-provider",
      environment: {},
      cwd: process.cwd(),
      runtimeMode: "full-access",
      historySafety,
      ...(options.resume ? { resumeCursor: { threadId: nativeThreadId } } : {}),
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const notify = (method: string, params: unknown) =>
      Queue.offer(output, encode({ method, params }));
    const acknowledgeTurn = Deferred.await(turnRequested).pipe(
      Effect.flatMap((id) => Queue.offer(output, encode({ id, result: { turn } }))),
    );
    const setSnapshotTurns = (turns: unknown[]) =>
      Effect.sync(() => {
        snapshotTurns = turns;
      });
    const acknowledgeSnapshot = Deferred.await(snapshotRequested).pipe(
      Effect.flatMap((id) =>
        Queue.offer(output, encode({ id, result: { data: snapshotTurns, nextCursor: null } })),
      ),
    );
    return {
      runtime,
      calls,
      notify,
      turn,
      turnRequested,
      acknowledgeTurn,
      setSnapshotTurns,
      snapshotRequested,
      acknowledgeSnapshot,
    };
  });

it.effect(
  "restores the durable fence for every paid/history-copy operation while allowing read and Stop",
  () =>
    Effect.gen(function* () {
      const { runtime, calls } = yield* fixture({
        isBlocked: (id) => Effect.succeed(id === nativeThreadId),
        markBlocked: () => Effect.void,
      });
      const session = yield* runtime.start();
      assert.equal(session.lastError, CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE);
      for (const operation of [
        runtime.sendTurn({ input: "must not reach provider" }),
        runtime.sendTurn({ codexReview: { type: "uncommittedChanges" } }),
        runtime.steerTurn({
          expectedTurnId: TurnId.make(nativeTurnId),
          input: "must not reach provider",
        }),
        runtime.compactThread,
        runtime.forkThread,
        runtime.setGoal({ objective: "must not create a goal" }),
        runtime.setGoal({ status: "active" }),
      ]) {
        const rejected = yield* operation.pipe(Effect.flip);
        assert.equal(rejected.message, CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE);
      }
      assert.equal(
        calls.some((method) =>
          [
            "turn/start",
            "turn/steer",
            "review/start",
            "thread/compact/start",
            "thread/fork",
            "thread/goal/set",
          ].includes(method),
        ),
        false,
      );
      assert.equal((yield* runtime.readThread).threadId, nativeThreadId);
      yield* runtime.interruptTurn();
      assert.equal(calls.includes("thread/read"), true);
      yield* runtime.close;
    }).pipe(Effect.scoped),
);

it.effect(
  "refuses an already blocked native cursor before initialize or resume can restore queued work",
  () =>
    Effect.gen(function* () {
      const { runtime, calls } = yield* fixture(
        {
          isBlocked: (id) => Effect.succeed(id === nativeThreadId),
          markBlocked: () => Effect.void,
        },
        { resume: true },
      );
      const failure = yield* runtime.start().pipe(Effect.flip);
      assert.equal(failure.message, CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE);
      assert.deepEqual(calls, []);
      yield* runtime.close;
    }).pipe(Effect.scoped),
);

it.effect(
  "admits the exact pre-ACK terminal diagnosis even when a stale failed turn preceded it",
  () =>
    Effect.gen(function* () {
      const marked: string[] = [];
      const { runtime, notify, turn, turnRequested, acknowledgeTurn } = yield* fixture(
        {
          isBlocked: () => Effect.succeed(false),
          markBlocked: (id) =>
            Effect.sync(() => {
              marked.push(id);
            }),
        },
        { holdTurnAck: true },
      );
      yield* runtime.start();
      const terminalObserved = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          event.method === "turn/completed" && event.turnId === nativeTurnId
            ? Deferred.succeed(terminalObserved, undefined)
            : Effect.void,
        ),
        Effect.forkChild,
      );
      const sending = yield* runtime
        .sendTurn({ input: "synthetic initial input" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(turnRequested);
      yield* notify("turn/completed", {
        threadId: nativeThreadId,
        turn: {
          ...turn,
          id: "older-turn",
          status: "failed",
          error: { message: oversized, codexErrorInfo: "other", additionalDetails: null },
        },
      });
      yield* notify("turn/completed", {
        threadId: nativeThreadId,
        turn: {
          ...turn,
          status: "failed",
          error: { message: oversized, codexErrorInfo: "other", additionalDetails: null },
        },
      });
      yield* Deferred.await(terminalObserved);
      assert.deepEqual(marked, []);
      yield* acknowledgeTurn;
      yield* Fiber.join(sending);
      assert.deepEqual(marked, [nativeThreadId]);
      assert.equal((yield* runtime.getSession).lastError, CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE);
      assert.equal(
        (yield* runtime.sendTurn({ input: "must not replay" }).pipe(Effect.flip)).message,
        CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE,
      );
      yield* runtime.close;
    }).pipe(Effect.scoped),
);

for (const mode of ["snapshot", "uncertain", "live-during-snapshot"] as const) {
  const proved = mode === "snapshot";
  const concurrentProof = mode === "live-during-snapshot";
  const confirmed = proved || concurrentProof;
  it.effect(
    `bounds pre-ACK candidates and ${proved ? "qualifies overflow against the exact ACK snapshot" : concurrentProof ? "keeps live positive proof ahead of an inconclusive snapshot" : "preserves accepted delivery while fencing inconclusive overflow"}`,
    () =>
      Effect.gen(function* () {
        const marked: string[] = [];
        const {
          runtime,
          calls,
          notify,
          turn,
          turnRequested,
          acknowledgeTurn,
          setSnapshotTurns,
          snapshotRequested,
          acknowledgeSnapshot,
        } = yield* fixture(
          {
            isBlocked: () => Effect.succeed(false),
            markBlocked: (id) =>
              Effect.sync(() => {
                marked.push(id);
              }),
          },
          { holdTurnAck: true, holdSnapshotRead: concurrentProof },
        );
        yield* runtime.start();
        const allErrorsObserved = yield* Deferred.make<void>();
        const warningObserved = yield* Deferred.make<void>();
        const startedObserved = yield* Deferred.make<void>();
        const diagnosisObserved = yield* Deferred.make<void>();
        let errors = 0;
        let uncertainWarnings = 0;
        let terminalEvents = 0;
        yield* runtime.events.pipe(
          Stream.runForEach((event) => {
            if (event.method === "turn/started")
              return Deferred.succeed(startedObserved, undefined);
            if (
              event.method === "warning" &&
              event.message === CODEX_HISTORY_DIAGNOSIS_UNCERTAIN_MESSAGE
            ) {
              uncertainWarnings += 1;
              return Deferred.succeed(warningObserved, undefined);
            }
            if (event.method === "turn/completed" || event.method === "session/exited")
              terminalEvents += 1;
            if (event.method !== "error") return Effect.void;
            errors += 1;
            const payload = event.payload as { error?: { message?: string } } | undefined;
            if (payload?.error?.message === CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE)
              return Deferred.succeed(diagnosisObserved, undefined);
            return errors === CODEX_HISTORY_CANDIDATE_LIMIT + 1
              ? Deferred.succeed(allErrorsObserved, undefined)
              : Effect.void;
          }),
          Effect.forkChild,
        );
        const sending = yield* runtime
          .sendTurn({ input: "synthetic initial input" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(turnRequested);
        for (let index = 0; index <= CODEX_HISTORY_CANDIDATE_LIMIT; index += 1)
          yield* notify("error", {
            threadId: nativeThreadId,
            turnId: index === CODEX_HISTORY_CANDIDATE_LIMIT ? nativeTurnId : `older-${index}`,
            willRetry: false,
            error: { message: oversized, codexErrorInfo: "other", additionalDetails: null },
          });
        yield* Deferred.await(allErrorsObserved);
        if (proved)
          yield* setSnapshotTurns([
            {
              ...turn,
              status: "failed",
              error: { message: oversized, codexErrorInfo: "other", additionalDetails: null },
            },
          ]);
        yield* acknowledgeTurn;
        if (concurrentProof) {
          // Suspend the exact ACK-turn snapshot, then admit an authoritative
          // live diagnosis before delivering its stale empty result. Positive
          // proof must win without changing the accepted delivery result.
          yield* Deferred.await(snapshotRequested);
          yield* notify("turn/started", { threadId: nativeThreadId, turn });
          yield* Deferred.await(startedObserved);
          yield* notify("error", {
            threadId: nativeThreadId,
            turnId: nativeTurnId,
            willRetry: false,
            error: { message: oversized, codexErrorInfo: "other", additionalDetails: null },
          });
          yield* Deferred.await(diagnosisObserved);
          yield* acknowledgeSnapshot;
        }
        const accepted = yield* Fiber.join(sending);
        assert.equal(accepted.turnId, nativeTurnId);
        assert.deepEqual(accepted.resumeCursor, { threadId: nativeThreadId });
        if (confirmed) yield* Deferred.await(diagnosisObserved);
        else yield* Deferred.await(warningObserved);
        assert.equal(uncertainWarnings, confirmed ? 0 : 1);
        assert.equal(terminalEvents, 0);
        // Uncertainty is a warning, not a fabricated provider rejection: only
        // positive snapshot proof may add a normalized terminal error.
        if (!concurrentProof)
          assert.equal(errors, CODEX_HISTORY_CANDIDATE_LIMIT + 1 + (proved ? 1 : 0));
        assert.deepEqual(marked, confirmed ? [nativeThreadId] : []);
        const message = confirmed
          ? CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE
          : CODEX_HISTORY_DIAGNOSIS_UNCERTAIN_MESSAGE;
        assert.equal((yield* runtime.getSession).lastError, message);
        assert.equal(
          (yield* runtime.sendTurn({ input: "must not replay" }).pipe(Effect.flip)).message,
          message,
        );
        assert.equal(calls.filter((method) => method === "turn/start").length, 1);
        assert.equal(calls.filter((method) => method === "thread/turns/list").length, 1);
        yield* runtime.close;
      }).pipe(Effect.scoped),
  );
}

it.effect("does not admit another native turn's pre-ACK failure or a child failure", () =>
  Effect.gen(function* () {
    const marked: string[] = [];
    const { runtime, notify, turn, turnRequested, acknowledgeTurn } = yield* fixture(
      {
        isBlocked: () => Effect.succeed(false),
        markBlocked: (id) =>
          Effect.sync(() => {
            marked.push(id);
          }),
      },
      { holdTurnAck: true },
    );
    yield* runtime.start();
    const terminalObserved = yield* Deferred.make<void>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        event.method === "turn/completed"
          ? Deferred.succeed(terminalObserved, undefined)
          : Effect.void,
      ),
      Effect.forkChild,
    );
    const sending = yield* runtime
      .sendTurn({ input: "synthetic initial input" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(turnRequested);
    yield* notify("error", {
      threadId: "synthetic-child-thread",
      turnId: nativeTurnId,
      willRetry: false,
      error: { message: oversized, codexErrorInfo: "other", additionalDetails: null },
    });
    yield* notify("turn/completed", {
      threadId: nativeThreadId,
      turn: {
        ...turn,
        id: "older-native-turn",
        status: "failed",
        error: { message: oversized, codexErrorInfo: "other", additionalDetails: null },
      },
    });
    yield* Deferred.await(terminalObserved);
    yield* acknowledgeTurn;
    yield* Fiber.join(sending);
    assert.deepEqual(marked, []);
    assert.notEqual((yield* runtime.getSession).lastError, CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE);
    yield* runtime.close;
  }).pipe(Effect.scoped),
);

it.effect(
  "classifies the exact active root's authoritative failed snapshot when the terminal notification was missed",
  () =>
    Effect.gen(function* () {
      const marked: string[] = [];
      const { runtime, notify, turn, setSnapshotTurns } = yield* fixture({
        isBlocked: () => Effect.succeed(false),
        markBlocked: (id) =>
          Effect.sync(() => {
            marked.push(id);
          }),
      });
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "synthetic initial input" });
      const terminalObserved = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.method !== "turn/completed") return;
            assert.equal(
              (event.payload as { turn: { error: { message: string } } }).turn.error.message,
              CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE,
            );
            yield* Deferred.succeed(terminalObserved, undefined);
          }),
        ),
        Effect.forkChild,
      );
      yield* setSnapshotTurns([
        {
          ...turn,
          status: "failed",
          error: { message: oversized, codexErrorInfo: "other", additionalDetails: null },
        },
      ]);
      yield* notify("thread/status/changed", {
        threadId: nativeThreadId,
        status: { type: "idle" },
      });
      yield* Deferred.await(terminalObserved);
      assert.deepEqual(marked, [nativeThreadId]);
      assert.equal((yield* runtime.getSession).lastError, CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE);
      yield* runtime.close;
    }).pipe(Effect.scoped),
);

it.effect(
  "records one exact live root rejection and preserves the explanation through later generic failure",
  () =>
    Effect.gen(function* () {
      const marked: string[] = [];
      const { runtime, calls, notify, turn } = yield* fixture({
        isBlocked: () => Effect.succeed(false),
        markBlocked: (id) =>
          Effect.sync(() => {
            marked.push(id);
          }),
      });
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "synthetic initial input" });
      const firstError = yield* Deferred.make<void>();
      const secondError = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      let errors = 0;
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.method === "error") {
              const payload = event.payload as { error: { message: string } };
              assert.equal(payload.error.message, CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE);
              errors += 1;
              yield* Deferred.succeed(errors === 1 ? firstError : secondError, undefined);
            }
            if (event.method === "turn/completed") {
              const payload = event.payload as { turn: { error: { message: string } } };
              assert.equal(payload.turn.error.message, CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE);
              yield* Deferred.succeed(completed, undefined);
            }
          }),
        ),
        Effect.forkChild,
      );
      yield* notify("error", {
        threadId: nativeThreadId,
        turnId: nativeTurnId,
        willRetry: false,
        error: { message: oversized, codexErrorInfo: "other", additionalDetails: null },
      });
      yield* Deferred.await(firstError);
      assert.deepEqual(marked, [nativeThreadId]);
      const failure = yield* runtime.sendTurn({ input: "must not replay" }).pipe(Effect.flip);
      assert.equal(failure.message, CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE);
      assert.equal(calls.filter((method) => method === "turn/start").length, 1);
      yield* notify("error", {
        threadId: nativeThreadId,
        turnId: nativeTurnId,
        willRetry: false,
        error: {
          message: '{"detail":"Bad Request"}',
          codexErrorInfo: "other",
          additionalDetails: null,
        },
      });
      yield* Deferred.await(secondError);
      yield* notify("turn/completed", {
        threadId: nativeThreadId,
        turn: {
          ...turn,
          status: "failed",
          error: {
            message: '{"detail":"Bad Request"}',
            codexErrorInfo: "other",
            additionalDetails: null,
          },
        },
      });
      yield* Deferred.await(completed);
      assert.equal((yield* runtime.getSession).lastError, CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE);
      assert.deepEqual(marked, [nativeThreadId]);
      yield* runtime.close;
    }).pipe(Effect.scoped),
);
