import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

export type DurableWriteFailure = "retry" | "reject" | "block";
export type DurableWriteState = "ready" | "retrying" | "blocked";

/** Only unwrap a single failure; composite causes must not be retried blindly. */
export function singleDurableWriteError<E>(cause: Cause.Cause<E>): unknown {
  if (cause.reasons.length !== 1) return undefined;
  const reason = cause.reasons[0];
  if (reason === undefined) return undefined;
  if (Cause.isFailReason(reason)) return reason.error;
  return Cause.isDieReason(reason) ? reason.defect : undefined;
}

/**
 * Retain an exact local write at the head of its ordered consumer until it is
 * durable. Only explicitly classified transient errors retry, with bounded
 * backoff. Invalid input can be rejected; permanent storage errors park the
 * lane until repair/restart rather than falsely acknowledging missing data.
 * This helper must never wrap provider requests, prompts, or approval delivery.
 *
 * Diagnostics intentionally contain only fixed phase names: SQL exceptions
 * can contain parameters (including prompts, paths, or credentials).
 */
export const settleDurableWrite = <A, E, R, R2>(options: {
  readonly operation: Effect.Effect<A, E, R>;
  readonly classify: (cause: Cause.Cause<E>) => Effect.Effect<DurableWriteFailure, never, R2>;
  readonly name: "provider-journal" | "usage-accounting";
  readonly onState?: (state: DurableWriteState) => void;
}): Effect.Effect<Option.Option<A>, never, R | R2> =>
  Effect.gen(function* () {
    let delayMs = 100;
    let waiting = false;
    while (true) {
      const result = yield* options.operation.pipe(Effect.exit);
      if (Exit.isSuccess(result)) {
        options.onState?.("ready");
        return Option.some(result.value);
      }
      if (Cause.hasInterruptsOnly(result.cause))
        return yield* Effect.failCause(result.cause).pipe(Effect.orDie);
      const failure = yield* options.classify(result.cause);
      if (failure === "reject") {
        options.onState?.("ready");
        yield* Effect.logWarning("durable write rejected invalid or retired input", {
          component: options.name,
        });
        return Option.none();
      }
      if (failure === "block") {
        options.onState?.("blocked");
        yield* Effect.logError("durable write blocked; storage repair is required", {
          component: options.name,
        });
        return yield* Effect.never;
      }
      options.onState?.("retrying");
      if (!waiting) {
        yield* Effect.logWarning("durable write waiting for transient storage contention", {
          component: options.name,
        });
        waiting = true;
      }
      yield* Effect.sleep(delayMs);
      delayMs = Math.min(5_000, delayMs * 2);
    }
  });
