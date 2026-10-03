import { afterAll, describe, expect, it, layer } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

// Cafe intentionally retains its qualified Effect runtime while adopting Vitest
// 5. Exercise the adapter's real public APIs instead of mocking the runner, so
// registration, effect scope ownership, shared layers and errors remain covered.
let scopedFinalizations = 0;

it.effect("runs scoped effects and drains their finalizers", () =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => scopedFinalizations++));
    expect(yield* Effect.succeed(42)).toBe(42);
  }),
);

it.effect("provides the deterministic virtual test clock", () =>
  Effect.gen(function* () {
    const before = yield* Clock.currentTimeMillis;
    yield* TestClock.adjust("2 seconds");
    expect(yield* Clock.currentTimeMillis).toBe(before + 2_000);
  }),
);

it.live("retains live scoped test execution", () =>
  Effect.gen(function* () {
    expect(yield* Effect.succeed("live")).toBe("live");
  }),
);

it.effect.each([1, 2])("passes each parameter to Effect cases %s", (value) =>
  Effect.sync(() => expect(value).toBeGreaterThan(0)),
);

class SharedTestValue extends Context.Service<SharedTestValue, Ref.Ref<number>>()(
  "test/EffectVitestCompatibility/SharedValue",
) {}

layer(Layer.effect(SharedTestValue, Ref.make(0)))("adapter shared layer lifetime", (test) => {
  test.effect("initializes one layer for the block", () =>
    Effect.gen(function* () {
      const ref = yield* SharedTestValue;
      yield* Ref.update(ref, (value) => value + 1);
      expect(yield* Ref.get(ref)).toBe(1);
    }),
  );

  test.effect("retains that layer until the next case completes", () =>
    Effect.gen(function* () {
      const ref = yield* SharedTestValue;
      expect(yield* Ref.get(ref)).toBe(1);
    }),
  );
});

describe("adapter failure propagation", () => {
  it.effect.fails("does not convert an Effect failure into success", () =>
    Effect.fail(new Error("isolated compatibility fixture failure")),
  );
});

afterAll(() => expect(scopedFinalizations).toBe(1));
