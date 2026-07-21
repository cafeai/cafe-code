import type { ServerProvider, ServerProviderAccountRateLimits } from "@cafecode/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import type { ServerProviderShape } from "./Services/ServerProvider.ts";
import { ServerSettingsError } from "@cafecode/contracts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
}

interface SingleFlight<A, E> {
  readonly current: Effect.Effect<Deferred.Deferred<A, E> | null>;
  readonly run: (operation: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

type SingleFlightAdmission<A, E> =
  | { readonly deferred: Deferred.Deferred<A, E>; readonly leader: true }
  | { readonly deferred: Deferred.Deferred<A, E>; readonly leader: false };

/**
 * Share one provider probe among every caller that arrives while that probe is
 * running. A semaphore alone is insufficient here: it serializes duplicate
 * work, which means an initial refresh, a periodic refresh, and a manual
 * refresh can all execute back-to-back after one slow CLI invocation.
 *
 * The worker is forked into the managed provider's owning scope. Callers may
 * therefore stop waiting without interrupting the shared probe for all other
 * callers. The admission transition and worker fork are uninterruptible so an
 * interrupt cannot leave an uncompleted Deferred installed in `inFlightRef`;
 * the provider operation itself remains interruptible and is always converted
 * to an Exit that completes every waiter.
 */
const makeSingleFlight = <A, E>(scope: Scope.Scope): Effect.Effect<SingleFlight<A, E>> =>
  Effect.gen(function* () {
    const inFlightRef = yield* Ref.make<Deferred.Deferred<A, E> | null>(null);

    const run = (operation: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<A, E>();
          const admission = yield* Ref.modify<
            Deferred.Deferred<A, E> | null,
            SingleFlightAdmission<A, E>
          >(
            inFlightRef,
            (current): readonly [SingleFlightAdmission<A, E>, Deferred.Deferred<A, E>] => {
              if (current !== null) {
                return [{ deferred: current, leader: false }, current];
              }
              return [{ deferred: candidate, leader: true }, candidate];
            },
          );

          if (!admission.leader) {
            return yield* restore(Deferred.await(admission.deferred));
          }

          yield* Effect.exit(Effect.interruptible(operation)).pipe(
            Effect.flatMap((exit) => Deferred.done(candidate, exit)),
            Effect.ensuring(
              Ref.update(inFlightRef, (current) => (current === candidate ? null : current)),
            ),
            Effect.forkIn(scope),
          );

          return yield* restore(Deferred.await(candidate));
        }),
      );

    return {
      current: Ref.get(inFlightRef),
      run,
    };
  });

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly maintenanceCapabilities: ServerProviderShape["maintenanceCapabilities"];
  readonly getSettings: Effect.Effect<Settings>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly refreshAccountUsage?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
  }) => Effect.Effect<ServerProviderAccountRateLimits | undefined, ServerSettingsError>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input | null;
}): Effect.fn.Return<ServerProviderShape, ServerSettingsError, Scope.Scope> {
  // Full probes, settings changes, and usage-only updates all mutate the same
  // snapshot. Keep those writes serialized even though duplicate calls of the
  // same operation are coalesced independently below.
  const snapshotMutationSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = yield* input.initialSnapshot(initialSettings);
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const scope = yield* Effect.scope;
  const fullRefreshSingleFlight = yield* makeSingleFlight<ServerProvider, ServerSettingsError>(
    scope,
  );
  const accountUsageSingleFlight = yield* makeSingleFlight<ServerProvider, ServerSettingsError>(
    scope,
  );

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation || Equal.equals(state.snapshot, nextSnapshot)) {
        return [null, state] as const;
      }
      return [
        nextSnapshot,
        {
          ...state,
          snapshot: nextSnapshot,
        },
      ] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    if (!input.enrichSnapshot) {
      return;
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
        publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    const nextSnapshot = yield* input.checkProvider;
    const nextGeneration = yield* Ref.modify(snapshotStateRef, (state) => {
      const generation = input.enrichSnapshot
        ? state.enrichmentGeneration + 1
        : state.enrichmentGeneration;
      return [
        generation,
        {
          snapshot: nextSnapshot,
          enrichmentGeneration: generation,
        },
      ] as const;
    });
    yield* Ref.set(settingsRef, nextSettings);
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    snapshotMutationSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    return yield* fullRefreshSingleFlight.run(
      input.getSettings.pipe(
        Effect.flatMap((nextSettings) => applySnapshot(nextSettings, { forceRefresh: true })),
      ),
    );
  });

  const applyAccountUsageBase = Effect.fn("applyAccountUsage")(function* () {
    if (!input.refreshAccountUsage) {
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    const settings = yield* input.getSettings;
    const currentState = yield* Ref.get(snapshotStateRef);
    const accountRateLimits = yield* input.refreshAccountUsage({
      settings,
      snapshot: currentState.snapshot,
    });
    // A transient usage endpoint failure must not erase a known-good usage
    // snapshot. Full provider health refreshes remain authoritative for
    // clearing account-bound data after logout or account replacement.
    if (accountRateLimits === undefined) {
      return currentState.snapshot;
    }

    const nextSnapshot: ServerProvider = {
      ...currentState.snapshot,
      accountRateLimits,
    };
    if (Equal.equals(currentState.snapshot, nextSnapshot)) {
      return currentState.snapshot;
    }

    // Usage can land while asynchronous version enrichment is still working
    // from an older base snapshot. Advance the generation and restart that
    // enrichment so its eventual full-snapshot publish cannot overwrite the
    // newer account usage.
    const nextGeneration = input.enrichSnapshot
      ? currentState.enrichmentGeneration + 1
      : currentState.enrichmentGeneration;
    yield* Ref.set(snapshotStateRef, {
      snapshot: nextSnapshot,
      enrichmentGeneration: nextGeneration,
    });
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    yield* restartSnapshotEnrichment(settings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });

  const refreshAccountUsageSnapshot = Effect.fn("refreshAccountUsageSnapshot")(function* () {
    // A full status refresh includes account usage. If one is already active,
    // share its result instead of issuing a second authenticated HTTP request.
    const activeFullRefresh = yield* fullRefreshSingleFlight.current;
    if (activeFullRefresh !== null) {
      return yield* Deferred.await(activeFullRefresh);
    }
    return yield* accountUsageSingleFlight.run(
      snapshotMutationSemaphore.withPermits(1)(applyAccountUsageBase()),
    );
  });

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  if (input.refreshInterval !== null) {
    yield* Effect.forever(
      Effect.sleep(input.refreshInterval ?? "60 seconds").pipe(
        Effect.flatMap(() => refreshSnapshot()),
        Effect.ignoreCause({ log: true }),
      ),
    ).pipe(Effect.forkScoped);
  }

  yield* refreshSnapshot().pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  return {
    maintenanceCapabilities: input.maintenanceCapabilities,
    getSnapshot: input.getSettings.pipe(
      Effect.flatMap(applySnapshot),
      Effect.tapError(Effect.logError),
      Effect.orDie,
    ),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    ...(input.refreshAccountUsage
      ? {
          refreshAccountUsage: refreshAccountUsageSnapshot().pipe(
            Effect.tapError(Effect.logError),
            Effect.orDie,
          ),
        }
      : {}),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
