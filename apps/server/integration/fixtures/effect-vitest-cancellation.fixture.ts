// This deliberately uses the host clock and fixed console markers to qualify
// teardown ordering in the child runner, outside the virtual Effect test clock.
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalConsole:off
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";

let retired = false;

// This intentionally failing child fixture must never enter default discovery.
// Its timeout proves that the adapter waits for asynchronous finalizers before
// allowing the next test to reuse resources. No provider or profile is involved.
it.live(
  "times out while a delayed scoped finalizer retires",
  () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          retired = true;
          console.log("FINALIZER_RETIRED");
        }),
      );
      yield* Effect.never;
    }),
  20,
);

test("the next case starts after finalization", () => {
  console.log(retired ? "NEXT_CASE_AFTER_RETIREMENT" : "NEXT_CASE_BEFORE_RETIREMENT");
  expect(retired).toBe(true);
});
