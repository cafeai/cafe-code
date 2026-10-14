import type { ProviderSecurityInput, ProviderSecurityResult } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export interface ProviderSecurityAuthority {
  readonly key: string;
  readonly configuration: string;
}

/** Exact-owner reads avoid copying every session's potentially large public
 * evidence through the daemon on a small composer-status update. */
export const readOwnedProviderSecurity = (
  input: ProviderSecurityInput,
  authority: Effect.Effect<ProviderSecurityAuthority | undefined>,
  read: (configurationKey: string) => Effect.Effect<ProviderSecurityResult>,
) =>
  Effect.gen(function* () {
    const before = yield* authority;
    if (!before) return { report: null };
    const result = yield* read(before.configuration);
    const after = yield* authority;
    if (
      !after ||
      after.key !== before.key ||
      after.configuration !== before.configuration ||
      result.report?.runtimeId !== input.runtimeId ||
      result.report.modelId !== input.modelId
    )
      return { report: null };
    return result;
  });

export const subscribeProviderSecurity = (
  read: Effect.Effect<ProviderSecurityResult>,
  invalidations: readonly Stream.Stream<unknown>[],
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.sliding<void>(1);
      yield* Effect.addFinalizer(() => Queue.shutdown(queue));
      let generation = 0;
      for (const source of invalidations)
        yield* Stream.runForEach(source, () =>
          Effect.sync(() => {
            generation++;
          }).pipe(Effect.andThen(Queue.offer(queue, undefined))),
        ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Queue.offer(queue, undefined);
      return Stream.fromQueue(queue).pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const started = generation;
            const result = yield* read.pipe(
              Effect.timeout(5_000),
              Effect.catchCause(() => Effect.succeed({ report: null })),
            );
            return started === generation ? result : { report: null };
          }),
        ),
        Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      );
    }),
  );
