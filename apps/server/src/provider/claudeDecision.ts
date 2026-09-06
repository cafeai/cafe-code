import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/**
 * Claude cancels host permission/question callbacks through AbortSignal only;
 * the SDK still awaits the callback promise. Register before publishing the UI
 * request and inspect the latched state, since abort events are not replayed to
 * late listeners. Always release both the listener and host pending entry.
 * Source: Agent SDK CanUseTool.signal and Query.handleControlCancelRequest.
 */
export function awaitClaudeDecision<A>(input: {
  readonly signal: AbortSignal;
  readonly decision: Deferred.Deferred<A>;
  readonly cancelled: A;
  readonly publish: Effect.Effect<void>;
  readonly onAbort?: () => void;
  readonly onClose: () => void;
}): Effect.Effect<A> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const onAbort = () => {
        input.onAbort?.();
        // Resolving this in-memory Deferred is synchronous and cannot perform
        // provider I/O. Do not fork an unowned callback that can outlive Stop.
        Effect.runSync(Deferred.succeed(input.decision, input.cancelled));
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) onAbort();
      return () => input.signal.removeEventListener("abort", onAbort);
    }),
    () => input.publish.pipe(Effect.andThen(Deferred.await(input.decision))),
    (removeListener) =>
      Effect.sync(() => {
        removeListener();
        input.onClose();
      }),
  );
}
