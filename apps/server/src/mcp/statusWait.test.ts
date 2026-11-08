import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { MAX_STATUS_WAITERS, withStatusWait } from "./statusWait.ts";

it.effect("refuses excess status waits and joins cancellation before admitting replacements", () =>
  Effect.gen(function* () {
    yield* Effect.acquireUseRelease(
      Effect.forEach(Array.from({ length: MAX_STATUS_WAITERS }), () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const fiber = yield* Effect.forkChild(
            withStatusWait(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
          );
          return { fiber, entered };
        }),
      ),
      (held) =>
        Effect.gen(function* () {
          yield* Effect.forEach(held, ({ entered }) => Deferred.await(entered));
          const refused = yield* withStatusWait(Effect.succeed("unexpected")).pipe(Effect.flip);
          expect(refused.code).toBe("capacity");
        }),
      (held) => Fiber.interruptAll(held.map(({ fiber }) => fiber)),
    );
    expect(yield* withStatusWait(Effect.succeed("replacement"))).toBe("replacement");
  }),
);
