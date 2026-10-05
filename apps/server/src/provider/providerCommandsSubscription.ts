import type {
  ProviderCommandCatalog,
  ProviderCommandsInput,
  ProviderSession,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { UNAVAILABLE_COMMAND_CATALOG } from "./claudeCommands.ts";

export interface ProviderCommandsAuthority {
  readonly cwd: string;
  /** Private admitted settings commitment, never returned by the picker API. */
  readonly configuration: string;
}

/** Recheck saved workspace/configuration on both sides of a possibly remote
 * daemon inventory read. The renderer never supplies native paths or sessions. */
export const readBoundProviderCommands = (
  input: ProviderCommandsInput,
  resolveAuthority: Effect.Effect<ProviderCommandsAuthority | undefined>,
  readSessions: Effect.Effect<ReadonlyArray<ProviderSession>>,
): Effect.Effect<ProviderCommandCatalog> =>
  Effect.gen(function* () {
    const before = yield* resolveAuthority;
    if (!before) return UNAVAILABLE_COMMAND_CATALOG;
    const sessions = yield* readSessions;
    const after = yield* resolveAuthority;
    if (!after || after.cwd !== before.cwd || after.configuration !== before.configuration)
      return UNAVAILABLE_COMMAND_CATALOG;
    const matching = sessions.filter(
      (session) =>
        session.threadId === input.threadId &&
        session.providerInstanceId === input.instanceId &&
        session.provider === "claudeAgent" &&
        session.subagentRuntimeId === input.runtimeId &&
        session.commandCatalogConfigurationKey === before.configuration &&
        session.cwd === before.cwd &&
        session.status !== "closed" &&
        session.status !== "error",
    );
    return matching.length === 1
      ? (matching[0]!.commandCatalog ?? UNAVAILABLE_COMMAND_CATALOG)
      : UNAVAILABLE_COMMAND_CATALOG;
  });

/** One volatile slot absorbs bursts while the bounded read is pending. Each
 * source starts before the initial read, so an update during that read leaves
 * a trailing invalidation. No catalog, command text, or credentials are queued.
 * Cancellation only retires this metadata subscriber, never the provider. */
export function subscribeProviderCommands(
  read: Effect.Effect<ProviderCommandCatalog>,
  invalidations: ReadonlyArray<Stream.Stream<unknown>>,
): Stream.Stream<ProviderCommandCatalog> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.sliding<void>(1);
      yield* Effect.addFinalizer(() => Queue.shutdown(queue));
      for (const source of invalidations) {
        yield* Stream.runForEach(source, () => Queue.offer(queue, undefined)).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
      }
      yield* Queue.offer(queue, undefined);
      return Stream.fromQueue(queue).pipe(
        Stream.mapEffect(() =>
          read.pipe(
            Effect.timeout(5_000),
            Effect.catchCause(() => Effect.succeed(UNAVAILABLE_COMMAND_CATALOG)),
          ),
        ),
        Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
      );
    }),
  );
}
