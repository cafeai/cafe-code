import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlError from "effect/unstable/sql/SqlError";
import {
  settleDurableWrite,
  singleDurableWriteError,
  type DurableWriteState,
} from "./durableWrite.ts";
import { isSqliteLockTimeoutError } from "./sqliteLockRetry.ts";

const settle = Effect.forEach(Array.from({ length: 16 }), () => Effect.yieldNow, { discard: true });
const lockError = new SqlError.SqlError({
  reason: new SqlError.LockTimeoutError({
    operation: "execute",
    cause: "private input must not appear in diagnostics",
  }),
});
const classify = (cause: Cause.Cause<unknown>) =>
  Effect.succeed(
    isSqliteLockTimeoutError(singleDurableWriteError(cause))
      ? ("retry" as const)
      : ("block" as const),
  );

describe("settleDurableWrite", () => {
  it.effect("retries the exact head write before admitting later events", () =>
    Effect.gen(function* () {
      const attempts: number[] = [];
      const committed: number[] = [];
      const states: DurableWriteState[] = [];
      let failures = 2;
      const fiber = yield* Stream.runForEach(Stream.fromIterable([1, 2]), (id) =>
        settleDurableWrite({
          name: "provider-journal",
          classify,
          onState: (state) => states.push(state),
          operation: Effect.suspend(() => {
            attempts.push(id);
            if (failures-- > 0) return Effect.die(lockError);
            committed.push(id);
            return Effect.succeed(id);
          }),
        }),
      ).pipe(Effect.forkChild);
      yield* settle;
      assert.deepEqual(attempts, [1]);
      assert.deepEqual(committed, []);
      yield* TestClock.adjust(100);
      yield* settle;
      assert.deepEqual(attempts, [1, 1]);
      yield* TestClock.adjust(200);
      yield* Fiber.join(fiber);
      assert.deepEqual(attempts, [1, 1, 1, 2]);
      assert.deepEqual(committed, [1, 2]);
      assert.deepEqual(states, ["retrying", "retrying", "ready", "ready"]);
    }),
  );

  it.effect(
    "does not retry or acknowledge permanent storage errors and remains interruptible",
    () =>
      Effect.gen(function* () {
        let attempts = 0;
        let acknowledged = false;
        let state: DurableWriteState = "ready";
        const fiber = yield* settleDurableWrite({
          name: "usage-accounting",
          classify,
          onState: (next) => {
            state = next;
          },
          operation: Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(new Error("private sql parameters"));
          }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              acknowledged = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* settle;
        yield* TestClock.adjust(60_000);
        assert.equal(attempts, 1);
        assert.equal(acknowledged, false);
        assert.equal(state, "blocked");
        yield* Fiber.interrupt(fiber);
      }),
  );

  it.effect("conclusively rejects poison input without parking later work", () =>
    Effect.gen(function* () {
      const result = yield* settleDurableWrite({
        name: "provider-journal",
        classify: () => Effect.succeed("reject"),
        operation: Effect.die("invalid"),
      });
      assert.isTrue(Option.isNone(result));
    }),
  );
});
