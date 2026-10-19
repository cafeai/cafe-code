import type {
  ServerProvider,
  ServerProviderAccountRateLimits,
  ServerProviderProbeDiagnostics,
  ServerProviderProbeOutcome,
} from "@cafecode/contracts";
import * as Clock from "effect/Clock";
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
import {
  DEFAULT_PROVIDER_INCONCLUSIVE_FAILURE_THRESHOLD,
  deterministicProviderProbePhaseOffsetMs,
  hasConclusiveProviderAuthState,
  retainConclusiveProviderState,
} from "./providerProbePolicy.ts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
}

interface ProviderProbeState {
  readonly attemptCount: number;
  readonly consecutiveInconclusiveCount: number;
}

export interface ManagedProviderProbePolicy {
  /**
   * The ProviderRegistry owns initial refresh admission in production so it
   * can bound aggregate CLI process concurrency across configured instances.
   * Standalone users retain the historical background refresh by default.
   */
  readonly initialRefresh?: "background" | "external";
  /**
   * Classify only protocol outcomes where the probe could not determine
   * health (for example, a bounded auth-status subprocess timing out). A
   * conclusive unauthenticated or error result must return false.
   */
  readonly isInconclusiveSnapshot?: (snapshot: ServerProvider) => boolean;
  /**
   * Known-good state is retained before this many consecutive inconclusive
   * results. The threshold is intentionally bounded so repeated failures
   * eventually become visible rather than being masked forever.
   */
  readonly inconclusiveFailureThreshold?: number;
}

const toIsoDateTime = (epochMs: number): ServerProvider["checkedAt"] =>
  new Date(epochMs).toISOString();

const advancePeriodicTargetPast = (
  scheduledAtMs: number,
  observedAtMs: number,
  intervalMs: number,
): number => {
  if (scheduledAtMs > observedAtMs) {
    return scheduledAtMs;
  }
  const missedIntervals = Math.floor((observedAtMs - scheduledAtMs) / intervalMs) + 1;
  return scheduledAtMs + missedIntervals * intervalMs;
};

const classifyProbeOutcome = (
  snapshot: ServerProvider,
  policy: ManagedProviderProbePolicy,
): ServerProviderProbeOutcome => {
  if (policy.isInconclusiveSnapshot?.(snapshot) === true) {
    return "inconclusive";
  }
  return snapshot.status;
};

/**
 * A fallback health probe does not rediscover models. Retain native discovery
 * only when both observations explicitly identify the same authenticated
 * account. Missing identity is unknown, never evidence that two owners match.
 * This concerns catalogue provenance, not an entitlement or launch grant.
 */
export const retainNativeCodexModelCatalog = (
  previous: ServerProvider,
  next: ServerProvider,
): ServerProvider => {
  if (
    previous.driver !== "codex" ||
    next.driver !== "codex" ||
    previous.instanceId !== next.instanceId ||
    previous.codexModelCatalogSource !== "native" ||
    next.codexModelCatalogSource !== "fallback" ||
    previous.auth.status !== "authenticated" ||
    next.auth.status !== "authenticated" ||
    typeof previous.auth.type !== "string" ||
    previous.auth.type.length === 0 ||
    previous.auth.type !== next.auth.type ||
    typeof previous.auth.email !== "string" ||
    previous.auth.email.length === 0 ||
    previous.auth.email !== next.auth.email
  ) {
    return next;
  }
  return {
    ...next,
    models: previous.models,
    codexModelCatalogSource: "native",
  };
};

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

          yield* Effect.uninterruptibleMask((restoreWorker) =>
            Effect.exit(restoreWorker(Effect.interruptible(operation))).pipe(
              // Cancellation must reach the provider operation, but must not
              // cancel delivery of its captured Exit to every shared waiter.
              // Otherwise scope retirement can close the worker successfully
              // while leaving callers suspended on an uncompleted Deferred.
              Effect.flatMap((exit) =>
                // Completing a Deferred can synchronously resume a waiter.
                // Retire this exact flight first, so its next explicit request
                // cannot borrow the settled result instead of starting fresh.
                // The identity check cannot erase a newer admission.
                Ref.update(inFlightRef, (current) => (current === candidate ? null : current)).pipe(
                  Effect.andThen(Deferred.done(candidate, exit)),
                ),
              ),
            ),
          ).pipe(
            // Establish protected bookkeeping before the first worker step.
            // A scope already closed at fork admission immediately interrupts
            // the explicit provider operation above, producing a failed Exit
            // without invoking it. Ownership, budgets and concurrency stay in
            // the same scope; native work itself is never made uninterruptible.
            Effect.forkIn(scope, { uninterruptible: true }),
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
  readonly refreshModels?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
  }) => Effect.Effect<ServerProvider["models"] | undefined, ServerSettingsError>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input | null;
  readonly probePolicy?: ManagedProviderProbePolicy;
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
  const rawInitialSnapshot = yield* input.initialSnapshot(initialSettings);
  const normalizedRefreshInterval =
    input.refreshInterval === null
      ? null
      : Duration.fromInputUnsafe(input.refreshInterval ?? "60 seconds");
  const refreshIntervalMs =
    normalizedRefreshInterval === null
      ? null
      : Math.max(1, Math.floor(Duration.toMillis(normalizedRefreshInterval)));
  const periodicPhaseOffsetMs =
    refreshIntervalMs === null
      ? null
      : deterministicProviderProbePhaseOffsetMs(rawInitialSnapshot.instanceId, refreshIntervalMs);
  const initialPeriodicDelayMs =
    refreshIntervalMs === null || periodicPhaseOffsetMs === null
      ? null
      : refreshIntervalMs + periodicPhaseOffsetMs;
  const waitsForExternalInitialRefresh = input.probePolicy?.initialRefresh === "external";
  const initializedAtMs = yield* Clock.currentTimeMillis;
  const initialPeriodicScheduledAtMs =
    initialPeriodicDelayMs === null || waitsForExternalInitialRefresh
      ? null
      : initializedAtMs + initialPeriodicDelayMs;
  const nextScheduledAtRef = yield* Ref.make<number | null>(initialPeriodicScheduledAtMs);
  const externalInitialRefreshCompletedAt = yield* Deferred.make<number>();
  const externalInitialRefreshRegisteredRef = yield* Ref.make(false);
  const probeStateRef = yield* Ref.make<ProviderProbeState>({
    attemptCount: 0,
    consecutiveInconclusiveCount: 0,
  });
  const initialSnapshot: ServerProvider = input.probePolicy
    ? {
        ...rawInitialSnapshot,
        probeDiagnostics: {
          attemptCount: 0,
          consecutiveInconclusiveCount: 0,
          lastOutcome: "pending",
          lastStartedAt: null,
          lastFinishedAt: null,
          lastDurationMs: null,
          periodicIntervalMs: refreshIntervalMs,
          periodicPhaseOffsetMs,
          nextScheduledAt:
            initialPeriodicScheduledAtMs === null
              ? null
              : toIsoDateTime(initialPeriodicScheduledAtMs),
        },
      }
    : rawInitialSnapshot;
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
  const modelListSingleFlight = yield* makeSingleFlight<ServerProvider, ServerSettingsError>(scope);

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation) {
        return [null, state] as const;
      }
      // Enrichment starts from the just-probed base snapshot. A pathologically
      // slow probe can make the scheduler skip one or more fixed-rate slots
      // immediately afterward; preserve that newer schedule metadata when the
      // asynchronous enrichment callback eventually lands.
      const correlatedSnapshot = state.snapshot.probeDiagnostics
        ? { ...nextSnapshot, probeDiagnostics: state.snapshot.probeDiagnostics }
        : nextSnapshot;
      if (Equal.equals(state.snapshot, correlatedSnapshot)) {
        return [null, state] as const;
      }
      return [
        correlatedSnapshot,
        {
          ...state,
          snapshot: correlatedSnapshot,
        },
      ] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  });

  const publishNextScheduledAt = Effect.fn("publishNextScheduledAt")(function* (
    nextScheduledAtMs: number,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (!state.snapshot.probeDiagnostics) {
        return [null, state] as const;
      }
      const nextScheduledAt = toIsoDateTime(nextScheduledAtMs);
      if (state.snapshot.probeDiagnostics.nextScheduledAt === nextScheduledAt) {
        return [null, state] as const;
      }
      const nextSnapshot: ServerProvider = {
        ...state.snapshot,
        probeDiagnostics: {
          ...state.snapshot.probeDiagnostics,
          nextScheduledAt,
        },
      };
      return [nextSnapshot, { ...state, snapshot: nextSnapshot }] as const;
    });
    if (snapshotToPublish !== null) {
      yield* PubSub.publish(changesPubSub, snapshotToPublish);
    }
  });

  const registerExternalInitialRefreshCompletion = Effect.fn(
    "registerExternalInitialRefreshCompletion",
  )(function* () {
    const isFirstCompletion = yield* Ref.modify(
      externalInitialRefreshRegisteredRef,
      (alreadyRegistered) => [!alreadyRegistered, true] as const,
    );
    if (!isFirstCompletion) {
      return;
    }

    const completedAtMs = yield* Clock.currentTimeMillis;
    // Establish and publish the first periodic target before releasing either
    // the registry caller or the periodic fiber. Otherwise the schedule-only
    // stream update can race with the direct refresh return and be overwritten
    // by that return's older `nextScheduledAt: null` snapshot.
    if (initialPeriodicDelayMs !== null) {
      const scheduledAtMs = completedAtMs + initialPeriodicDelayMs;
      yield* Ref.set(nextScheduledAtRef, scheduledAtMs);
      yield* publishNextScheduledAt(scheduledAtMs);
    }
    yield* Deferred.succeed(externalInitialRefreshCompletedAt, completedAtMs).pipe(Effect.ignore);
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

    const previousSnapshot = (yield* Ref.get(snapshotStateRef)).snapshot;
    const startedAtMs = yield* Clock.currentTimeMillis;
    const checkedSnapshot = yield* input.checkProvider;
    const finishedAtMs = yield* Clock.currentTimeMillis;
    const nextScheduledAtMs = yield* Ref.get(nextScheduledAtRef);
    const probedSnapshot = input.probePolicy
      ? yield* Effect.gen(function* () {
          const outcome = classifyProbeOutcome(checkedSnapshot, input.probePolicy!);
          const probeState = yield* Ref.modify(probeStateRef, (previous) => {
            const next: ProviderProbeState = {
              attemptCount: previous.attemptCount + 1,
              consecutiveInconclusiveCount:
                outcome === "inconclusive" ? previous.consecutiveInconclusiveCount + 1 : 0,
            };
            return [next, next] as const;
          });
          const threshold = Math.max(
            1,
            Math.floor(
              input.probePolicy?.inconclusiveFailureThreshold ??
                DEFAULT_PROVIDER_INCONCLUSIVE_FAILURE_THRESHOLD,
            ),
          );
          const shouldRetainConclusiveState =
            outcome === "inconclusive" &&
            probeState.consecutiveInconclusiveCount < threshold &&
            hasConclusiveProviderAuthState(previousSnapshot);
          const reconciledSnapshot = shouldRetainConclusiveState
            ? retainConclusiveProviderState(previousSnapshot, checkedSnapshot)
            : checkedSnapshot;
          const probeDiagnostics: ServerProviderProbeDiagnostics = {
            attemptCount: probeState.attemptCount,
            consecutiveInconclusiveCount: probeState.consecutiveInconclusiveCount,
            lastOutcome: outcome,
            lastStartedAt: toIsoDateTime(startedAtMs),
            lastFinishedAt: toIsoDateTime(finishedAtMs),
            lastDurationMs: Math.max(0, Math.floor(finishedAtMs - startedAtMs)),
            periodicIntervalMs: refreshIntervalMs,
            periodicPhaseOffsetMs,
            nextScheduledAt: nextScheduledAtMs === null ? null : toIsoDateTime(nextScheduledAtMs),
          };
          return {
            ...reconciledSnapshot,
            probeDiagnostics,
          } satisfies ServerProvider;
        })
      : checkedSnapshot;
    // Adapters also read this managed snapshot directly, bypassing the
    // registry. A same-account CLI health result must not restore static rows
    // omitted by the last successful native catalogue, including an empty one.
    const nextSnapshot = retainNativeCodexModelCatalog(previousSnapshot, probedSnapshot);
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
    const operation = input.getSettings.pipe(
      Effect.flatMap((nextSettings) => applySnapshot(nextSettings, { forceRefresh: true })),
    );
    const externallyAdmittedOperation = waitsForExternalInitialRefresh
      ? operation.pipe(
          Effect.ensuring(registerExternalInitialRefreshCompletion()),
          // The operation's original return value was created before the
          // completion finalizer installed the periodic target. Correlate the
          // direct result with the authoritative in-memory snapshot so every
          // delivery path carries the same schedule metadata.
          Effect.andThen(Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot))),
        )
      : operation;
    return yield* fullRefreshSingleFlight.run(externallyAdmittedOperation);
  });

  const applyAccountUsageBase = Effect.fn("applyAccountUsage")(function* (
    provided?: ServerProviderAccountRateLimits,
  ) {
    if (!input.refreshAccountUsage && provided === undefined) {
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    const settings = yield* input.getSettings;
    const currentState = yield* Ref.get(snapshotStateRef);
    const accountRateLimits =
      provided ??
      (yield* input.refreshAccountUsage!({
        settings,
        snapshot: currentState.snapshot,
      }));
    // A transient usage endpoint failure must not erase a known-good usage
    // snapshot. Full provider health refreshes remain authoritative for
    // clearing account-bound data after logout or account replacement.
    if (accountRateLimits === undefined) {
      return currentState.snapshot;
    }

    // Explicit reset reads run outside this mutation lock. A newer completed
    // usage read must win if it lands before this supplied snapshot is applied.
    if (
      provided &&
      currentState.snapshot.accountRateLimits &&
      currentState.snapshot.accountRateLimits.checkedAt > provided.checkedAt
    ) {
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

  const applyModelsBase = Effect.fn("applyModels")(function* () {
    if (!input.refreshModels) {
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    const settings = yield* input.getSettings;
    const currentState = yield* Ref.get(snapshotStateRef);
    const models = yield* input.refreshModels({
      settings,
      snapshot: currentState.snapshot,
    });
    // A picker-open refresh is opportunistic. A timeout, provider restart, or
    // transient model/list failure must leave the last known-good catalogue
    // and the user's current selection intact instead of flashing an empty
    // picker. The producer decides which discovery outcomes are inconclusive;
    // a defined empty catalogue remains a successful, authoritative result.
    if (models === undefined) {
      return currentState.snapshot;
    }

    // The callback may be held while settings change. Its result belongs only
    // to the settings admitted before the await, not to a replacement account
    // or configuration waiting on this mutation semaphore. No new probe is
    // needed for this final identity check.
    const currentSettings = yield* input.getSettings;
    if (input.haveSettingsChanged(settings, currentSettings)) {
      return currentState.snapshot;
    }

    // Enrichment and schedule-only publications are inert writes outside the
    // probe semaphore. Preserve their latest metadata rather than replaying
    // the pre-await copy while installing this catalogue.
    const latestState = yield* Ref.get(snapshotStateRef);

    const nextSnapshot: ServerProvider = {
      ...latestState.snapshot,
      models,
      // Stamp before equality comparison: identical rows still establish the
      // first native observation. Other drivers never acquire Codex proof.
      ...(latestState.snapshot.driver === "codex"
        ? { codexModelCatalogSource: "native" as const }
        : {}),
    };
    if (Equal.equals(latestState.snapshot, nextSnapshot)) {
      return latestState.snapshot;
    }

    // Model refreshes can race asynchronous version enrichment in the same
    // way as usage-only refreshes. Advance the generation and restart that
    // enrichment from the new snapshot so a stale callback cannot restore an
    // older model catalogue.
    const nextGeneration = input.enrichSnapshot
      ? latestState.enrichmentGeneration + 1
      : latestState.enrichmentGeneration;
    yield* Ref.set(snapshotStateRef, {
      snapshot: nextSnapshot,
      enrichmentGeneration: nextGeneration,
    });
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    yield* restartSnapshotEnrichment(settings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });

  const refreshModelsSnapshot = Effect.fn("refreshModelsSnapshot")(function* () {
    // Unlike account usage, a full health refresh does not necessarily query
    // app-server model/list. Serialize the mutation but keep a dedicated
    // single flight so overlapping picker opens share exactly one bounded
    // provider request without skipping the catalogue refresh.
    return yield* modelListSingleFlight.run(
      snapshotMutationSemaphore.withPermits(1)(applyModelsBase()),
    );
  });

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  if (
    normalizedRefreshInterval !== null &&
    refreshIntervalMs !== null &&
    initialPeriodicDelayMs !== null
  ) {
    yield* Effect.gen(function* () {
      // Production Codex/Claude providers delegate their first refresh to the
      // registry's two-wide admission queue. Do not start this provider's
      // periodic clock until that admitted operation actually settles; with an
      // unbounded instance registry, construction-relative timers could
      // otherwise bypass the queue while later instances were still waiting.
      const periodicBaselineAtMs = waitsForExternalInitialRefresh
        ? yield* Deferred.await(externalInitialRefreshCompletedAt)
        : initializedAtMs;
      let scheduledAtMs = periodicBaselineAtMs + initialPeriodicDelayMs;
      while (true) {
        const beforeSleepMs = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Duration.millis(Math.max(0, scheduledAtMs - beforeSleepMs)));
        const startedAtMs = yield* Clock.currentTimeMillis;
        // Advance from the prior target, not from completion time, so probe
        // duration cannot gradually synchronize otherwise-staggered workers.
        // If the event loop or a previous probe missed whole periods, skip
        // those slots instead of launching a catch-up burst.
        let nextScheduledAtMs = advancePeriodicTargetPast(
          scheduledAtMs + refreshIntervalMs,
          startedAtMs,
          refreshIntervalMs,
        );
        yield* Ref.set(nextScheduledAtRef, nextScheduledAtMs);
        yield* refreshSnapshot().pipe(Effect.ignoreCause({ log: true }));
        const finishedAtMs = yield* Clock.currentTimeMillis;
        const advancedScheduledAtMs = advancePeriodicTargetPast(
          nextScheduledAtMs,
          finishedAtMs,
          refreshIntervalMs,
        );
        if (advancedScheduledAtMs !== nextScheduledAtMs) {
          nextScheduledAtMs = advancedScheduledAtMs;
          yield* Ref.set(nextScheduledAtRef, nextScheduledAtMs);
          // The completed probe published the pre-overrun target. Correct it
          // immediately so diagnostics describe the actual next wakeup.
          yield* publishNextScheduledAt(nextScheduledAtMs);
        }
        scheduledAtMs = nextScheduledAtMs;
      }
    }).pipe(Effect.forkScoped);
  }

  if (input.probePolicy?.initialRefresh !== "external") {
    yield* refreshSnapshot().pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
  }

  return {
    maintenanceCapabilities: input.maintenanceCapabilities,
    setAccountUsage: (rateLimits: ServerProviderAccountRateLimits) =>
      snapshotMutationSemaphore
        .withPermits(1)(applyAccountUsageBase(rateLimits))
        .pipe(Effect.orDie),
    getSnapshot: input.getSettings.pipe(
      Effect.flatMap(applySnapshot),
      Effect.tapError(Effect.logError),
      Effect.orDie,
    ),
    getCurrentSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    refreshAfterAccountChange: Effect.gen(function* () {
      // Ordinary refreshes deliberately coalesce. After a native credential
      // commit, drain any earlier flight before requesting a new observation;
      // a pre-login signed-out response cannot satisfy this invalidation.
      const previous = yield* fullRefreshSingleFlight.current;
      if (previous) yield* Deferred.await(previous).pipe(Effect.ignore);
      return yield* refreshSnapshot();
    }).pipe(Effect.tapError(Effect.logError), Effect.orDie),
    ...(input.refreshAccountUsage
      ? {
          refreshAccountUsage: refreshAccountUsageSnapshot().pipe(
            Effect.tapError(Effect.logError),
            Effect.orDie,
          ),
        }
      : {}),
    ...(input.refreshModels
      ? {
          refreshModels: refreshModelsSnapshot().pipe(
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
