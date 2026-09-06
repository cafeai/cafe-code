import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { awaitClaudeDecision } from "./claudeDecision.ts";

it.effect("settles a pre-aborted Claude decision and cleans up", () =>
  Effect.gen(function* () {
    const controller = new AbortController();
    controller.abort();
    const decision = yield* Deferred.make<string>();
    let closed = false;
    const result = yield* awaitClaudeDecision({
      signal: controller.signal,
      decision,
      cancelled: "cancel",
      publish: Effect.void,
      onClose: () => {
        closed = true;
      },
    });
    assert.equal(result, "cancel");
    assert.equal(closed, true);
  }),
);

it.effect("retains cancellation while request publication is suspended", () =>
  Effect.gen(function* () {
    const controller = new AbortController();
    const decision = yield* Deferred.make<string>();
    const publishing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let closed = false;
    const fiber = yield* awaitClaudeDecision({
      signal: controller.signal,
      decision,
      cancelled: "cancel",
      publish: Deferred.succeed(publishing, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
      onClose: () => {
        closed = true;
      },
    }).pipe(Effect.forkChild);
    yield* Deferred.await(publishing);
    controller.abort();
    yield* Deferred.succeed(release, undefined);
    assert.equal(yield* Fiber.join(fiber), "cancel");
    assert.equal(closed, true);
  }),
);

it.effect("removes cancellation listeners after a normal decision", () =>
  Effect.gen(function* () {
    const controller = new AbortController();
    const decision = yield* Deferred.make<string>();
    let aborted = false;
    const result = yield* awaitClaudeDecision({
      signal: controller.signal,
      decision,
      cancelled: "cancel",
      publish: Deferred.succeed(decision, "accept").pipe(Effect.asVoid),
      onAbort: () => {
        aborted = true;
      },
      onClose: () => {},
    });
    controller.abort();
    assert.equal(result, "accept");
    assert.equal(aborted, false);
  }),
);
