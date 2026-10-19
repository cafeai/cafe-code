/**
 * ProviderRegistryLive — aggregates per-instance snapshot streams into a
 * single materialized list.
 *
 * Historically this Layer composed four per-kind Live Layers
 * (`CodexProviderLive`, `ClaudeProviderLive`, …) that each exposed a
 * `ServerProviderShape`. Those Lives were deleted during the driver /
 * instance refactor — every driver now carries its `snapshot: ServerProviderShape`
 * bundled onto the `ProviderInstance` the registry produces.
 *
 * Each configured instance (including multi-instance setups like
 * `codex_personal` + `codex_work`) contributes one `ProviderSnapshotSource`,
 * keyed by `instanceId`. Instances whose driver is unavailable or whose
 * config failed to decode are merged from `instanceRegistry.listUnavailable`
 * as shadow snapshots so the UI can render their exact unavailable reason.
 *
 * Cache paths on disk are now keyed by `instanceId`. Because
 * `defaultInstanceIdForDriver(kind) === kind` for built-in kinds, existing
 * `<kind>.json` files remain the on-disk location for that driver's default
 * instance. Identity-less legacy cache contents are ignored and replaced by
 * the first live refresh.
 *
 * @module ProviderRegistryLive
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderAccountRateLimits,
  type ServerProviderAccountRateLimitSnapshot,
  type ServerProviderAccountRateLimitWindow,
  type ServerProviderUpdateState,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import { makeProviderUsageReset } from "../ProviderUsageReset.ts";
import { discoverBoundProviderSkills } from "../providerSkillsDiscovery.ts";
import { readBoundInstanceQuota } from "../providerQuotaSubscription.ts";
import { loginBoundProviderAccount } from "../providerAccountLogin.ts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import {
  hydrateCachedProvider,
  isCachedProviderCorrelated,
  orderProviderSnapshots,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ProviderSnapshotSource } from "../builtInProviderCatalog.ts";
import { codexAuthWithSubscriptionPlan } from "../codexSubscription.ts";
import { retainNativeCodexModelCatalog } from "../makeManagedServerProvider.ts";
import {
  DEFAULT_PROVIDER_INCONCLUSIVE_FAILURE_THRESHOLD,
  hasConclusiveProviderAuthState,
  reconcileInconclusiveProviderProbeStreak,
  retainConclusiveProviderState,
} from "../providerProbePolicy.ts";

/**
 * Status probes spawn provider-owned subprocesses and may read shared auth
 * homes. Bound startup/rebuild admission across the whole registry so a
 * multi-instance configuration cannot create a CPU/I/O thundering herd.
 */
export const INITIAL_PROVIDER_REFRESH_CONCURRENCY = 2;

const loadProviders = (
  providerSources: ReadonlyArray<ProviderSnapshotSource>,
): Effect.Effect<ReadonlyArray<ServerProvider>> =>
  Effect.forEach(
    providerSources,
    (providerSource) =>
      providerSource.getSnapshot.pipe(
        Effect.flatMap((snapshot) => correlateSnapshotWithSource(providerSource, snapshot)),
      ),
    {
      concurrency: "unbounded",
    },
  );

const makeManualProviderMaintenanceCapabilities = (provider: ProviderDriverKind) =>
  makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });

const hasModelCapabilities = (model: ServerProvider["models"][number]): boolean =>
  (model.capabilities?.optionDescriptors?.length ?? 0) > 0;

const isSameAuthenticatedProviderAccount = (
  previousProvider: ServerProvider,
  nextProvider: ServerProvider,
): boolean =>
  previousProvider.auth.status === "authenticated" &&
  nextProvider.auth.status === "authenticated" &&
  previousProvider.auth.type === nextProvider.auth.type &&
  previousProvider.auth.email === nextProvider.auth.email;

const mergeProviderModels = (
  previousModels: ReadonlyArray<ServerProvider["models"][number]>,
  nextModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  if (nextModels.length === 0 && previousModels.length > 0) {
    return previousModels;
  }

  const previousBySlug = new Map(previousModels.map((model) => [model.slug, model] as const));
  const mergedModels = nextModels.map((model) => {
    const previousModel = previousBySlug.get(model.slug);
    if (!previousModel || hasModelCapabilities(model) || !hasModelCapabilities(previousModel)) {
      return model;
    }
    return {
      ...model,
      capabilities: previousModel.capabilities,
    };
  });
  const nextSlugs = new Set(nextModels.map((model) => model.slug));
  return [...mergedModels, ...previousModels.filter((model) => !nextSlugs.has(model.slug))];
};

export const mergeProviderSnapshot = (
  previousProvider: ServerProvider | undefined,
  nextProvider: ServerProvider,
): ServerProvider => {
  // Usage-only refreshes carry a new plan alongside the prior auth label. Use
  // only this incoming snapshot's metadata, before any cached quota retention,
  // so an account switch without fresh usage cannot inherit another tier.
  if (nextProvider.driver === "codex") {
    const auth = codexAuthWithSubscriptionPlan(
      nextProvider.auth,
      nextProvider.accountRateLimits?.rateLimits.planType,
    );
    if (auth !== nextProvider.auth) nextProvider = { ...nextProvider, auth };
  }
  if (!previousProvider) {
    return nextProvider;
  }

  // A backend restart hydrates the last conclusive provider snapshot from the
  // private status cache, while the newly-created managed provider begins its
  // own consecutive-attempt counter at zero. Apply the same bounded retention
  // rule at this merge boundary so one or two startup timeouts do not create a
  // false auth-loss banner; the third timeout still becomes visible.
  const streakReconciledProvider = reconcileInconclusiveProviderProbeStreak(
    previousProvider,
    nextProvider,
  );
  const reconciledProvider =
    streakReconciledProvider.probeDiagnostics?.lastOutcome === "inconclusive" &&
    streakReconciledProvider.probeDiagnostics.consecutiveInconclusiveCount <
      DEFAULT_PROVIDER_INCONCLUSIVE_FAILURE_THRESHOLD &&
    hasConclusiveProviderAuthState(previousProvider)
      ? retainConclusiveProviderState(previousProvider, streakReconciledProvider)
      : streakReconciledProvider;

  const catalogueProvider = retainNativeCodexModelCatalog(previousProvider, reconciledProvider);
  return {
    ...catalogueProvider,
    // A trusted Codex producer explicitly distinguishes static fallback from
    // successful native discovery. Both are complete catalogues; a generic
    // union would revive retired fallback rows or native omissions. Older and
    // other-driver snapshots keep their established sparse merge behavior.
    models:
      catalogueProvider.driver === "codex" &&
      catalogueProvider.codexModelCatalogSource !== undefined
        ? catalogueProvider.models
        : mergeProviderModels(previousProvider.models, catalogueProvider.models),
    // Carry forward event-sourced account rate limits when an incoming snapshot
    // omits them. Claude's periodic probe never sends a prompt, so it produces no
    // `accountRateLimits`; without this, each refresh would wipe the limits accrued
    // from `rate_limit_event`s.
    //
    // Codex has both full probe snapshots and sparse live updates. Preserve the
    // latest redacted usage when the same authenticated account suffers a transient
    // probe failure, but clear it on auth/account churn so a percentage from one
    // account can never be presented as another account's quota. Grok's ACP auth
    // response does not currently expose a stable account identity, so an omitted
    // full-probe usage result must clear instead of guessing that cached-token auth
    // still represents the same person. Its usage-only prompt refresh independently
    // preserves a known-good snapshot on transient endpoint failure.
    ...(reconciledProvider.accountRateLimits === undefined &&
    previousProvider.accountRateLimits !== undefined &&
    reconciledProvider.driver !== ProviderDriverKind.make("grok") &&
    (reconciledProvider.driver !== ProviderDriverKind.make("codex") ||
      isSameAuthenticatedProviderAccount(previousProvider, reconciledProvider))
      ? { accountRateLimits: previousProvider.accountRateLimits }
      : {}),
  };
};

export const mergeProviderSnapshots = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> => {
  const mergedProviders = new Map(
    previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
  );

  for (const provider of nextProviders) {
    mergedProviders.set(
      snapshotInstanceKey(provider),
      mergeProviderSnapshot(mergedProviders.get(snapshotInstanceKey(provider)), provider),
    );
  }

  return orderProviderSnapshots([...mergedProviders.values()]);
};

export const selectProvidersByKind = (
  providers: ReadonlyArray<ServerProvider>,
  providerKinds: ReadonlySet<ProviderDriverKind>,
): ReadonlyArray<ServerProvider> =>
  providers.filter((provider) => providerKinds.has(provider.driver));

/**
 * Merge one sparse, named rate-limit snapshot into a provider's most recent full
 * account-usage read. Codex rolling notifications omit unavailable fields rather than
 * clearing them, so top-level metadata and untouched windows must survive. The canonical
 * `codex` bucket is mirrored into the backward-compatible single-bucket field consumed by
 * older renderer code.
 */
export const mergeProviderAccountRateLimitSnapshot = (input: {
  readonly previous: ServerProviderAccountRateLimits | undefined;
  readonly limitId: string;
  readonly snapshot: ServerProviderAccountRateLimitSnapshot;
  readonly checkedAt: string;
}): ServerProviderAccountRateLimits => {
  const previousByLimitId = input.previous?.rateLimitsByLimitId ?? {};
  const previousSnapshot =
    previousByLimitId[input.limitId] ??
    (input.limitId === "codex" ? input.previous?.rateLimits : undefined);
  const mergedSnapshot: ServerProviderAccountRateLimitSnapshot = {
    ...previousSnapshot,
    ...input.snapshot,
  };
  const rateLimits =
    input.limitId === "codex" ? mergedSnapshot : (input.previous?.rateLimits ?? mergedSnapshot);

  return {
    rateLimits,
    rateLimitsByLimitId: {
      ...previousByLimitId,
      [input.limitId]: mergedSnapshot,
    },
    ...(input.previous?.rateLimitResetCredits !== undefined
      ? { rateLimitResetCredits: input.previous.rateLimitResetCredits }
      : {}),
    checkedAt: input.checkedAt,
  };
};

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

const correlateSnapshotWithSource = (
  source: ProviderSnapshotSource,
  snapshot: ServerProvider,
): Effect.Effect<ServerProvider> => {
  if (snapshot.instanceId !== source.instanceId) {
    return Effect.die(
      new Error(
        `Provider snapshot instance mismatch: source '${source.instanceId}' emitted '${snapshot.instanceId}'.`,
      ),
    );
  }
  if (snapshot.driver !== source.driverKind) {
    return Effect.die(
      new Error(
        `Provider snapshot driver mismatch for instance '${source.instanceId}': source '${source.driverKind}' emitted '${snapshot.driver}'.`,
      ),
    );
  }
  return Effect.succeed(snapshot);
};

/**
 * Key a snapshot for aggregation and persistence. Snapshot sources
 * must be correlated by instance id before reaching this map; missing
 * identities are defects, not runtime routing fallbacks.
 */
const snapshotInstanceKey = (provider: ServerProvider): ProviderInstanceId => {
  return provider.instanceId;
};

// Project a live `ProviderInstance` into the aggregator's consumption
// shape. Each call re-captures the instance's `snapshot` closures, so
// after `ProviderInstanceRegistry` rebuilds an instance (e.g. because
// its settings changed), a fresh source rides the new PubSub instead
// of a closed one.
const buildSnapshotSource = (instance: ProviderInstance): ProviderSnapshotSource => ({
  instanceId: instance.instanceId,
  driverKind: instance.driverKind,
  getSnapshot: instance.snapshot.getSnapshot,
  refresh: instance.snapshot.refresh,
  refreshAccountUsage: instance.snapshot.refreshAccountUsage,
  refreshModels: instance.snapshot.refreshModels,
  streamChanges: instance.snapshot.streamChanges,
});

/**
 * Every process owning native adapters must admit their initial status probes
 * through this same bounded registry. The backend owns the durable presentation
 * cache; detached runtime owners need only volatile, locally observed status.
 * Disabling the cache skips both reads and writes, so an independent daemon
 * cannot borrow backend evidence or race its persisted probe-history counters.
 */
interface ProviderRegistryOptions {
  readonly statusCache?: "disabled";
  /** Detached owners expose HTTP readiness while the same bounded queue runs. */
  readonly initialAdmission?: "background";
}

const makeProviderRegistry = (options?: ProviderRegistryOptions) =>
  Effect.gen(function* () {
    const instanceRegistry = yield* ProviderInstanceRegistry;
    const usageReset = yield* makeProviderUsageReset;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Aggregator PubSub — consumers (WS gateway, etc.) subscribe here for
    // coalesced updates across every instance.
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

    // Boot-only: hydrate `providersRef` from the on-disk per-instance
    // cache so the UI has something to render during the first refresh.
    // Instances added post-boot skip this path; their first entry in
    // `providersRef` comes from the reactive `syncLiveSources` pass
    // below.
    const bootInstances = yield* instanceRegistry.listInstances;
    // Barriers are keyed by the exact process-owning instance object, not its
    // reusable account id. Weak keys avoid retaining retired generations. A
    // capability reader can create a missing barrier but never starts a probe;
    // the sole serialized registry queue is responsible for settling it.
    const initialAdmissionBarriers = new WeakMap<
      ProviderInstance,
      Deferred.Deferred<void, ProviderAdapterRequestError>
    >();
    // Retain only unsettled exact generations, allowing an early pass setup
    // defect to fail boot/read-created barriers even before instance enumeration.
    // Every settlement removes the strong reference; historical keys remain weak.
    const pendingAdmissionInstances = new Set<ProviderInstance>();
    const barrierFor = (instance: ProviderInstance) =>
      Effect.gen(function* () {
        const existing = initialAdmissionBarriers.get(instance);
        if (existing) return existing;
        const created = yield* Deferred.make<void, ProviderAdapterRequestError>();
        // Deferred creation can yield. Preserve any exact-generation barrier
        // installed by another reader before this operation resumes.
        const retained = initialAdmissionBarriers.get(instance) ?? created;
        initialAdmissionBarriers.set(instance, retained);
        if (retained === created) pendingAdmissionInstances.add(instance);
        return retained;
      });
    const failIncompleteAdmissions = (instances: ReadonlySet<ProviderInstance>) =>
      Effect.forEach(
        instances,
        (instance) =>
          barrierFor(instance).pipe(
            Effect.flatMap((barrier) =>
              Deferred.fail(
                barrier,
                new ProviderAdapterRequestError({
                  provider: instance.driverKind,
                  method: "getCapabilities",
                  detail: "Provider runtime capability qualification did not complete.",
                }),
              ),
            ),
            Effect.andThen(
              Effect.sync(() => {
                pendingAdmissionInstances.delete(instance);
              }),
            ),
          ),
        { discard: true },
      );
    for (const instance of bootInstances) yield* barrierFor(instance);
    const awaitInstanceInitialRefresh = (instanceId: ProviderInstanceId) =>
      Effect.scoped(
        Effect.gen(function* () {
          // Register before observing the current owner so replacement cannot be
          // lost between the read and waiting on that generation's barrier.
          const changes = yield* instanceRegistry.subscribeChanges;
          while (true) {
            const instance = yield* instanceRegistry.getInstance(instanceId);
            if (!instance) return undefined;
            const barrier = yield* barrierFor(instance);
            if (yield* Deferred.isDone(barrier)) {
              const completion = yield* Effect.exit(Deferred.await(barrier));
              if ((yield* instanceRegistry.getInstance(instanceId)) !== instance) continue;
              if (Exit.isFailure(completion)) return yield* Effect.failCause(completion.cause);
              return instance;
            }
            // Only these read-only waits are raced/cancelled, never the owner
            // queue or its provider operation. Unrelated changes simply recheck.
            const wakeup = yield* Effect.exit(
              Effect.raceFirst(Deferred.await(barrier), PubSub.take(changes)),
            );
            // A failed retired generation is not authority over a replacement
            // or removed account. Re-observe ownership before propagating it.
            if ((yield* instanceRegistry.getInstance(instanceId)) !== instance) continue;
            if (Exit.isFailure(wakeup)) return yield* Effect.failCause(wakeup.cause);
          }
        }),
      );
    const bootSources = bootInstances.map(buildSnapshotSource);
    const fallbackProviders = yield* loadProviders(bootSources);
    const fallbackByInstance = new Map<ProviderInstanceId, ServerProvider>();
    for (let index = 0; index < fallbackProviders.length; index++) {
      const provider = fallbackProviders[index];
      const source = bootSources[index];
      if (provider === undefined || source === undefined) {
        continue;
      }
      fallbackByInstance.set(source.instanceId, provider);
    }

    const cachedProviders =
      options?.statusCache === "disabled"
        ? []
        : yield* Effect.forEach(
            bootSources,
            (source) =>
              Effect.gen(function* () {
                // One cache file per configured instance. For the default
                // instance of a built-in kind the path equals `<kind>.json` —
                // identical to the legacy filename. We still require the cache
                // payload to carry matching instance id + driver kind; old
                // identity-less payloads are discarded and the awaited refresh
                // below repopulates the cache.
                const filePath = yield* resolveProviderStatusCachePath({
                  cacheDir: config.providerStatusCacheDir,
                  instanceId: source.instanceId,
                }).pipe(Effect.provideService(Path.Path, path));
                const fallbackProvider = fallbackByInstance.get(source.instanceId);
                if (fallbackProvider === undefined) {
                  return undefined;
                }
                return yield* readProviderStatusCache(filePath).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.flatMap((cachedProvider) => {
                    if (cachedProvider === undefined) {
                      return Effect.void.pipe(Effect.as(undefined as ServerProvider | undefined));
                    }
                    const correlation = {
                      cachedProvider,
                      fallbackProvider,
                    } as const;
                    if (!isCachedProviderCorrelated(correlation)) {
                      return Effect.logWarning(
                        "provider status cache identity mismatch, ignoring",
                        {
                          path: filePath,
                          instanceId: source.instanceId,
                          cachedInstanceId: cachedProvider.instanceId ?? null,
                          driver: source.driverKind,
                          cachedDriver: cachedProvider.driver ?? null,
                        },
                      ).pipe(Effect.as(undefined as ServerProvider | undefined));
                    }
                    return Effect.succeed(hydrateCachedProvider(correlation));
                  }),
                );
              }),
            { concurrency: "unbounded" },
          ).pipe(
            Effect.map((providers) =>
              orderProviderSnapshots(
                providers.filter((provider): provider is ServerProvider => provider !== undefined),
              ),
            ),
          );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(cachedProviders);
    // Catalogue qualification belongs to an exact live provider object, not
    // its reusable account id. This volatile map never hydrates from disk.
    // A rebuilt owner must discover its own native catalogue even when its
    // configuration/account spelling matches the retired owner exactly.
    const catalogueOwners = new Map<ProviderInstanceId, ProviderInstance>();
    const maintenanceActionStatesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, { readonly update?: ServerProviderUpdateState | undefined }>
    >(new Map());

    // Live-source registry — the dynamic counterpart to the boot-time
    // `bootSources`. Keyed by `instanceId`; the stored `ProviderInstance`
    // reference is used for identity equality so "no-op" reconciles
    // (settings unchanged) skip re-subscribing + re-probing.
    const liveSubsRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ProviderInstance>>(
      new Map(),
    );
    // Serialize `syncLiveSources` so a rapid burst of reconciles doesn't
    // interleave two passes clobbering each other's fiber bookkeeping.
    const syncSemaphore = yield* Semaphore.make(1);
    // Catalogue admission is one ordered metadata transaction across direct,
    // stream and startup delivery. Even inert Effect reads can yield, so exact
    // owner identity alone cannot stop an older read overwriting a newer upsert.
    // Provider refreshes remain outside this permit with their existing caps.
    const upsertSemaphore = yield* Semaphore.make(1);

    const getLiveSources: Effect.Effect<ReadonlyArray<ProviderSnapshotSource>> = Ref.get(
      liveSubsRef,
    ).pipe(Effect.map((map) => Array.from(map.values(), buildSnapshotSource)));

    const persistProvider = (provider: ServerProvider) =>
      Effect.gen(function* () {
        if (options?.statusCache === "disabled") {
          return;
        }
        // Persist every instance — the file name is the instance id, so
        // multi-instance setups (e.g. `codex_personal`, `codex_work`) each
        // get their own cache. We resolve the path fresh so snapshots
        // produced by newly-added instances post-boot still land on disk
        // without the aggregator holding a stale `cachePathByInstance`
        // entry.
        const key = snapshotInstanceKey(provider);
        const filePath = yield* resolveProviderStatusCachePath({
          cacheDir: config.providerStatusCacheDir,
          instanceId: key,
        }).pipe(Effect.provideService(Path.Path, path));
        yield* writeProviderStatusCache({ filePath, provider }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.tapError(Effect.logError),
          Effect.ignore,
        );
      });

    const applyProviderUpdateState = Effect.fn("applyProviderUpdateState")(function* (
      provider: ServerProvider,
    ) {
      const maintenanceActionStates = yield* Ref.get(maintenanceActionStatesRef);
      const updateState = maintenanceActionStates.get(provider.instanceId)?.update;
      if (!updateState) {
        const { updateState: _updateState, ...providerWithoutUpdateState } = provider;
        return providerWithoutUpdateState;
      }
      return {
        ...provider,
        updateState,
      };
    });

    const upsertProvidersBody = Effect.fn("upsertProvidersBody")(function* (
      nextProviders: ReadonlyArray<ServerProvider>,
      options?: {
        readonly publish?: boolean;
        readonly persist?: boolean;
        readonly replace?: boolean;
        readonly replaceModels?: boolean;
        readonly instance?: ProviderInstance;
      },
    ) {
      let nextProvidersWithUpdateState: ReadonlyArray<ServerProvider> = yield* Effect.forEach(
        nextProviders,
        applyProviderUpdateState,
        {
          concurrency: "unbounded",
        },
      );
      if (options?.instance?.snapshot.getCurrentSnapshot) {
        // Preparation above can yield to a newer model refresh. Read the
        // inert owner view at the final boundary rather than admitting the
        // historical copy captured before that preparation.
        const current = yield* options.instance.snapshot.getCurrentSnapshot;
        const correlated = yield* correlateSnapshotWithSource(
          buildSnapshotSource(options.instance),
          current,
        );
        const preparedUpdate = nextProvidersWithUpdateState[0]?.updateState;
        const { updateState: _currentUpdate, ...currentWithoutUpdate } = correlated;
        nextProvidersWithUpdateState = [
          preparedUpdate
            ? { ...currentWithoutUpdate, updateState: preparedUpdate }
            : currentWithoutUpdate,
        ];
      }
      if (
        options?.instance &&
        (yield* instanceRegistry.getInstance(options.instance.instanceId)) !== options.instance
      ) {
        // Update-state preparation can yield. Recheck the owner at the final
        // mutation boundary, not merely before reading its current snapshot.
        return yield* Ref.get(providersRef);
      }
      const [previousProviders, providers, providersToPersist] = yield* Ref.modify(
        providersRef,
        (previousProviders) => {
          const mergedProviders = new Map(
            previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
          );
          const updatedKeys = new Set<ProviderInstanceId>();

          for (const provider of nextProvidersWithUpdateState) {
            const key = snapshotInstanceKey(provider);
            updatedKeys.add(key);
            let previousProvider = mergedProviders.get(key);
            if (options?.instance) {
              if (
                previousProvider?.driver === "codex" &&
                previousProvider.codexModelCatalogSource === "native" &&
                catalogueOwners.get(key) !== options.instance
              ) {
                const { codexModelCatalogSource: _retiredSource, ...historicalProvider } =
                  previousProvider;
                previousProvider = historicalProvider;
              }
              catalogueOwners.set(key, options.instance);
            }
            const mergedProvider =
              options?.replace === true
                ? provider
                : mergeProviderSnapshot(previousProvider, provider);
            mergedProviders.set(
              key,
              options?.replaceModels === true &&
                (provider.driver !== "codex" || provider.codexModelCatalogSource === undefined)
                ? {
                    ...mergedProvider,
                    // A successful provider-owned model/list response is the
                    // authoritative catalogue. Do not let the generic sparse
                    // snapshot merge resurrect retired fallback/static slugs.
                    // Legacy sources have no finite provenance and retain this
                    // historical direct-refresh policy. Proven Codex catalogues
                    // use the source-aware merge above, including native empty.
                    models: provider.models,
                  }
                : mergedProvider,
            );
          }

          const providers = orderProviderSnapshots([...mergedProviders.values()]);
          const providersToPersist = providers.filter((provider) =>
            updatedKeys.has(snapshotInstanceKey(provider)),
          );
          return [[previousProviders, providers, providersToPersist] as const, providers];
        },
      );

      if (haveProvidersChanged(previousProviders, providers)) {
        if (options?.persist !== false) {
          yield* Effect.forEach(providersToPersist, persistProvider, {
            concurrency: "unbounded",
            discard: true,
          });
        }
        if (options?.publish !== false) {
          yield* PubSub.publish(changesPubSub, providers);
        }
      }

      return providers;
    });

    // Keep cache/publication ordering inside the same permit too: publishing an
    // old captured array after a newer mutation would regress its consumers even
    // when the final providersRef was correct. This body performs no probe.
    const upsertProviders: typeof upsertProvidersBody = (nextProviders, options) =>
      upsertSemaphore.withPermits(1)(upsertProvidersBody(nextProviders, options));

    const syncProvider = Effect.fn("syncProvider")(function* (
      provider: ServerProvider,
      options?: {
        readonly publish?: boolean;
        readonly replaceModels?: boolean;
        readonly instance?: ProviderInstance;
      },
    ) {
      return yield* upsertProviders([provider], options);
    });

    const syncOwnedProvider = Effect.fn("syncOwnedProvider")(function* (
      instance: ProviderInstance,
      published: ServerProvider,
      options?: { readonly replaceModels?: boolean },
    ) {
      if ((yield* instanceRegistry.getInstance(instance.instanceId)) !== instance) {
        return yield* Ref.get(providersRef);
      }
      const source = buildSnapshotSource(instance);
      // Validate even a stale delivery's routing tuple before replacing it
      // with the owner's inert current view. Never conceal an invalid producer.
      yield* correlateSnapshotWithSource(source, published);
      return yield* syncProvider(published, { ...options, instance });
    });

    const updateProviderAccountRateLimitsBody = Effect.fn("updateProviderAccountRateLimitsBody")(
      function* (
        input:
          | {
              readonly instanceId: ProviderInstanceId;
              readonly slot: "primary" | "secondary";
              readonly window: ServerProviderAccountRateLimitWindow;
              readonly checkedAt: string;
            }
          | {
              readonly instanceId: ProviderInstanceId;
              readonly limitId: string;
              readonly snapshot: ServerProviderAccountRateLimitSnapshot;
              readonly checkedAt: string;
            },
      ) {
        type RateLimitUpdateResult =
          | { readonly changed: false }
          | { readonly changed: true; readonly providers: ReadonlyArray<ServerProvider> };

        const result = yield* Ref.modify(
          providersRef,
          (previousProviders): readonly [RateLimitUpdateResult, ReadonlyArray<ServerProvider>] => {
            const provider = previousProviders.find(
              (candidate) => candidate.instanceId === input.instanceId,
            );
            if (provider === undefined) {
              // Event arrived for an instance the aggregator isn't tracking (e.g. a
              // race at boot). Drop it — the next event will land once it's registered.
              return [{ changed: false }, previousProviders];
            }
            const previousRateLimits = provider.accountRateLimits;
            const nextRateLimits: ServerProviderAccountRateLimits =
              "snapshot" in input
                ? mergeProviderAccountRateLimitSnapshot({
                    previous: previousRateLimits,
                    limitId: input.limitId,
                    snapshot: input.snapshot,
                    checkedAt: input.checkedAt,
                  })
                : {
                    rateLimits:
                      input.slot === "primary"
                        ? { ...previousRateLimits?.rateLimits, primary: input.window }
                        : { ...previousRateLimits?.rateLimits, secondary: input.window },
                    ...(previousRateLimits?.rateLimitsByLimitId != null
                      ? { rateLimitsByLimitId: previousRateLimits.rateLimitsByLimitId }
                      : {}),
                    ...(previousRateLimits?.rateLimitResetCredits !== undefined
                      ? { rateLimitResetCredits: previousRateLimits.rateLimitResetCredits }
                      : {}),
                    checkedAt: input.checkedAt,
                  };
            const nextProvider: ServerProvider = {
              ...provider,
              accountRateLimits: nextRateLimits,
              // Only a fresh canonical Codex bucket can update the subscription
              // label. Sparse quota-only or auxiliary-model updates keep it intact.
              ...(provider.driver === "codex" && "snapshot" in input && input.limitId === "codex"
                ? { auth: codexAuthWithSubscriptionPlan(provider.auth, input.snapshot.planType) }
                : {}),
            };
            if (Equal.equals(provider, nextProvider)) {
              return [{ changed: false }, previousProviders];
            }
            const nextProviders: ReadonlyArray<ServerProvider> = previousProviders.map(
              (candidate) => (candidate.instanceId === input.instanceId ? nextProvider : candidate),
            );
            return [{ changed: true, providers: nextProviders }, nextProviders];
          },
        );
        if (result.changed) {
          yield* PubSub.publish(changesPubSub, result.providers);
        }
      },
    );
    // Quota receipts alter the same published array. They cannot overtake a
    // catalogue mutation still persisting its prior publication under this lock.
    const updateProviderAccountRateLimits: typeof updateProviderAccountRateLimitsBody = (input) =>
      upsertSemaphore.withPermits(1)(updateProviderAccountRateLimitsBody(input));

    const setProviderMaintenanceActionStateBody = Effect.fn(
      "setProviderMaintenanceActionStateBody",
    )(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: "update";
      readonly state: ServerProviderUpdateState | null;
    }) {
      yield* Ref.update(maintenanceActionStatesRef, (previous) => {
        const previousActions = previous.get(input.instanceId);
        const nextActions = { ...previousActions };
        if (input.state === null || input.state.status === "idle") {
          delete nextActions[input.action];
        } else {
          nextActions[input.action] = input.state;
        }

        const next = new Map(previous);
        if (Object.keys(nextActions).length === 0) {
          next.delete(input.instanceId);
        } else {
          next.set(input.instanceId, nextActions);
        }
        return next;
      });

      const existingProviders = yield* Ref.get(providersRef);
      const matchingProvider = existingProviders.find(
        (candidate) => candidate.instanceId === input.instanceId,
      );
      if (!matchingProvider) {
        return existingProviders;
      }

      const nextProvider = yield* applyProviderUpdateState(matchingProvider);
      // The caller already owns the upsert permit. Read the latest row only
      // after acquiring it, then patch presentation without recursively taking
      // the same permit or replaying a previously captured native catalogue.
      return yield* upsertProvidersBody([nextProvider], {
        persist: false,
      });
    });
    const setProviderMaintenanceActionState: typeof setProviderMaintenanceActionStateBody = (
      input,
    ) => upsertSemaphore.withPermits(1)(setProviderMaintenanceActionStateBody(input));

    const refreshOneSource = Effect.fn("refreshOneSource")(function* (
      providerSource: ProviderSnapshotSource,
    ) {
      const instance = yield* instanceRegistry.getInstance(providerSource.instanceId);
      if (!instance || instance.snapshot.refresh !== providerSource.refresh) {
        return yield* Ref.get(providersRef);
      }
      return yield* providerSource.refresh.pipe(
        Effect.flatMap((nextProvider) => syncOwnedProvider(instance, nextProvider)),
      );
    });

    const refreshAll = Effect.fn("refreshAll")(function* () {
      const sources = yield* getLiveSources;
      return yield* Effect.forEach(sources, (source) => refreshOneSource(source), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.andThen(Ref.get(providersRef)));
    });

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderDriverKind) {
      if (provider === undefined) {
        return yield* refreshAll();
      }
      // Kind-scoped refreshes target the default instance for that driver.
      const defaultInstanceId = defaultInstanceIdForDriver(provider);
      const sources = yield* getLiveSources;
      const providerSource = sources.find(
        (candidate) => candidate.instanceId === defaultInstanceId,
      );
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const refreshInstance = Effect.fn("refreshInstance")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const sources = yield* getLiveSources;
      const providerSource = sources.find((candidate) => candidate.instanceId === instanceId);
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const refreshInstanceAccountUsage = Effect.fn("refreshInstanceAccountUsage")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const sources = yield* getLiveSources;
      const providerSource = sources.find((candidate) => candidate.instanceId === instanceId);
      if (!providerSource?.refreshAccountUsage) {
        return yield* Ref.get(providersRef);
      }
      const instance = yield* instanceRegistry.getInstance(instanceId);
      if (
        !instance ||
        instance.snapshot.refreshAccountUsage !== providerSource.refreshAccountUsage
      ) {
        return yield* Ref.get(providersRef);
      }
      return yield* providerSource.refreshAccountUsage.pipe(
        Effect.flatMap((nextProvider) => syncOwnedProvider(instance, nextProvider)),
      );
    });

    const refreshInstanceModels = Effect.fn("refreshInstanceModels")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const instance = yield* instanceRegistry.getInstance(instanceId);
      const refreshModels = instance?.snapshot.refreshModels;
      if (!instance || !refreshModels) {
        return yield* Ref.get(providersRef);
      }

      // The driver operation is independently bounded and owned by the
      // provider scope. Once admitted, finish the authoritative sync even if a
      // short-lived WebSocket caller disconnects; otherwise the provider's
      // normal snapshot stream can land first and the generic merge can retain
      // slugs that Codex just retired. Exact instance identity below prevents
      // this bounded uninterruptible wait from writing through a rebuild.
      return yield* Effect.uninterruptible(
        refreshModels.pipe(
          Effect.flatMap((nextProvider) =>
            instanceRegistry.getInstance(instanceId).pipe(
              Effect.flatMap((currentInstance) => {
                if (currentInstance !== instance) {
                  return Ref.get(providersRef);
                }
                return syncOwnedProvider(instance, nextProvider, { replaceModels: true });
              }),
            ),
          ),
        ),
      );
    });

    const getProviderMaintenanceCapabilitiesForInstance = Effect.fn(
      "getProviderMaintenanceCapabilitiesForInstance",
    )(function* (instanceId: ProviderInstanceId, provider: ProviderDriverKind) {
      const instance = Array.from((yield* Ref.get(liveSubsRef)).values()).find(
        (candidate) => candidate.instanceId === instanceId,
      );
      return (
        instance?.snapshot.maintenanceCapabilities ??
        makeManualProviderMaintenanceCapabilities(provider)
      );
    });

    /**
     * Diff the aggregator's live-source set against the current
     * `ProviderInstanceRegistry` and:
     *   - subscribe to each newly-added or rebuilt instance's
     *     `streamChanges` (so periodic + enrichment refreshes land in
     *     `providersRef`);
     *   - force-refresh each newly-added/rebuilt instance and feed the
     *     result directly into `providersRef`, bypassing the PubSub
     *     attachment race that otherwise drops the initial probe;
     *   - prune `providersRef` of instances that no longer exist.
     *
     * Each serialized pass awaits its bounded initial refreshes. The backend's
     * default layer awaits the boot pass too, so immediate consumers retain
     * fully-probed startup state. The daemon forks that same pass in its owner
     * scope to keep listener readiness independent of the account count;
     * native capability reads await the exact instance's admission barrier.
     *
     * Per-instance subscription fibers are not tracked explicitly. When
     * a rebuilt instance's old child scope closes, its PubSub shuts
     * down and our `Stream.runForEach` fiber exits naturally.
     */
    const syncLiveSourcesBody = (admissions: Set<ProviderInstance>) =>
      Effect.gen(function* () {
        const instances = yield* instanceRegistry.listInstances;
        // Preserve admission's early metadata qualification: an unavailable
        // inventory defect must fail pending barriers before any health work
        // starts. This observation is not reusable after those awaited probes;
        // the final publication transaction obtains its own current inventory.
        yield* instanceRegistry.listUnavailable;
        const nextByInstance = new Map<ProviderInstanceId, ProviderInstance>(
          instances.map((instance) => [instance.instanceId, instance] as const),
        );
        const previousSubs = yield* Ref.get(liveSubsRef);

        // Carry over subscriptions for instances whose identity is
        // unchanged (reconcile treated them as no-op). Instances that
        // disappeared, or were rebuilt with a different reference,
        // fall through to the "newly-added" branch below.
        const carriedOver = new Map<ProviderInstanceId, ProviderInstance>();
        for (const [instanceId, previousInstance] of previousSubs) {
          const nextInstance = nextByInstance.get(instanceId);
          if (nextInstance !== undefined && nextInstance === previousInstance) {
            carriedOver.set(instanceId, previousInstance);
          }
        }

        // Collect new/rebuilt instances in `nextByInstance` insertion
        // order (which preserves settings-author order).
        const newlyAdded: Array<readonly [ProviderInstanceId, ProviderInstance]> = [];
        for (const [instanceId, instance] of nextByInstance) {
          if (carriedOver.has(instanceId)) {
            continue;
          }
          newlyAdded.push([instanceId, instance] as const);
          yield* barrierFor(instance);
          admissions.add(instance);
          yield* upsertSemaphore.withPermits(1)(
            Effect.gen(function* () {
              // Do not retire a newer owner's proof if this serialized sync pass
              // was itself replaced while waiting for a preceding publication.
              if ((yield* instanceRegistry.getInstance(instanceId)) !== instance) return;
              if (catalogueOwners.get(instanceId) === instance) return;
              // Replacement itself retires native proof, even if the new
              // owner's initial health probe later fails. Historical rows may
              // remain visible, but they cannot qualify the new scope.
              catalogueOwners.delete(instanceId);
              const [changed, providers] = yield* Ref.modify(providersRef, (previous) => {
                let changed = false;
                const providers = previous.map((provider) => {
                  if (
                    provider.instanceId !== instanceId ||
                    provider.driver !== "codex" ||
                    provider.codexModelCatalogSource !== "native"
                  )
                    return provider;
                  changed = true;
                  const { codexModelCatalogSource: _retiredSource, ...historical } = provider;
                  return historical;
                });
                return [[changed, providers] as const, providers] as const;
              });
              if (changed) yield* PubSub.publish(changesPubSub, providers);
            }),
          );
        }

        if (options?.initialAdmission === "background") {
          // Rich health must describe this owner's pending generation rather
          // than retaining a replaced runtime's known version during admission.
          // A getSnapshot result can be delayed behind a newer native catalogue
          // or a replacement. Preserve the original snapshot-read concurrency,
          // but admit each result through its exact owner's current-view fence.
          yield* Effect.forEach(
            newlyAdded,
            ([, instance]) =>
              Effect.gen(function* () {
                if ((yield* instanceRegistry.getInstance(instance.instanceId)) !== instance) return;
                const source = buildSnapshotSource(instance);
                const snapshot = yield* source.getSnapshot;
                const correlated = yield* correlateSnapshotWithSource(source, snapshot);
                yield* upsertProviders([correlated], {
                  persist: false,
                  replace: true,
                  instance,
                });
              }),
            { concurrency: "unbounded", discard: true },
          );
        }

        // Fork long-lived subscriptions to each new/rebuilt instance's
        // change stream BEFORE kicking off refreshes. ProviderRegistry is the
        // sole owner of production initial-refresh admission; managed Codex
        // and Claude snapshots intentionally disable their old independent
        // startup fibers so this global bound cannot be bypassed.
        for (const [, instance] of newlyAdded) {
          const source = buildSnapshotSource(instance);
          yield* Stream.runForEach(source.streamChanges, (provider) =>
            instanceRegistry.getInstance(instance.instanceId).pipe(
              Effect.flatMap((currentInstance) => {
                if (currentInstance !== instance) {
                  // A closing provider scope can have one already-buffered
                  // publication. Never let that stale generation overwrite
                  // the replacement instance that now owns this routing key.
                  return Effect.void;
                }
                return syncOwnedProvider(instance, provider);
              }),
            ),
          ).pipe(Effect.forkScoped);
        }

        // Force-refresh every new/rebuilt instance with a small global
        // concurrency bound and wait for them all to complete. The refresh's result is piped
        // directly into `syncProvider`, so `providersRef` is populated
        // deterministically by the time this block returns — regardless
        // of PubSub subscription timing. Failures are logged and
        // swallowed so one bad driver can't wedge the whole registry.
        yield* Effect.forEach(
          newlyAdded,
          ([, instance]) =>
            Effect.gen(function* () {
              const barrier = yield* barrierFor(instance);
              yield* Effect.gen(function* () {
                if ((yield* instanceRegistry.getInstance(instance.instanceId)) !== instance) return;
                const source = buildSnapshotSource(instance);
                const provider = yield* source.refresh;
                // The instance may be replaced while its probe is in flight.
                // Direct startup results need the same generation fence as the
                // stream subscription; a stale result cannot qualify its heir.
                if ((yield* instanceRegistry.getInstance(instance.instanceId)) !== instance) return;
                yield* syncOwnedProvider(instance, provider);
              }).pipe(
                Effect.ignoreCause({ log: true }),
                Effect.ensuring(
                  Deferred.succeed(barrier, undefined).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        pendingAdmissionInstances.delete(instance);
                      }),
                    ),
                  ),
                ),
              );
            }),
          { concurrency: INITIAL_PROVIDER_REFRESH_CONCURRENCY, discard: true },
        );

        const nextSubs = new Map(carriedOver);
        for (const [instanceId, instance] of newlyAdded) {
          nextSubs.set(instanceId, instance);
        }
        yield* Ref.set(liveSubsRef, nextSubs);

        // Drop aggregator state for instances that have disappeared —
        // otherwise the UI would keep rendering ghosts.
        // Hold only local metadata cleanup/publication here. Initial refreshes,
        // subscription construction and admission barriers above stay outside.
        yield* upsertSemaphore.withPermits(1)(
          Effect.gen(function* () {
            // Health above can outlive this pass's captured owner inventory.
            // Re-read only the inert registry view after acquiring publication
            // ownership: a newer directly admitted catalogue must not be pruned
            // or lose its private owner proof because the old health was slow.
            // Subscription bookkeeping deliberately remains the captured pass's
            // responsibility; the queued next pass attaches the current sources.
            const currentInstances = yield* instanceRegistry.listInstances;
            const currentUnavailable = yield* instanceRegistry.listUnavailable;
            const currentByInstance = new Map<ProviderInstanceId, ProviderInstance>(
              currentInstances.map((instance) => [instance.instanceId, instance] as const),
            );
            const knownInstanceIds = new Set<ProviderInstanceId>(currentByInstance.keys());
            for (const provider of currentUnavailable) {
              knownInstanceIds.add(snapshotInstanceKey(provider));
            }
            // This transaction already holds the permit. A stale unavailable
            // snapshot from before health cannot overwrite a now-live owner;
            // publish only the freshly received unavailable inventory here.
            yield* upsertProvidersBody(currentUnavailable, { persist: false, replace: true });
            const [previousProviders, providers] = yield* Ref.modify(
              providersRef,
              (previousProviders) => {
                const providers = orderProviderSnapshots(
                  previousProviders.filter((provider) =>
                    knownInstanceIds.has(snapshotInstanceKey(provider)),
                  ),
                );
                return [[previousProviders, providers] as const, providers];
              },
            );
            if (haveProvidersChanged(previousProviders, providers)) {
              yield* PubSub.publish(changesPubSub, providers);
            }
            yield* Ref.update(maintenanceActionStatesRef, (previous) => {
              const next = new Map(previous);
              for (const instanceId of previous.keys()) {
                if (!knownInstanceIds.has(instanceId)) {
                  next.delete(instanceId);
                }
              }
              return next;
            });
            for (const instanceId of catalogueOwners.keys()) {
              if (currentByInstance.get(instanceId) !== catalogueOwners.get(instanceId)) {
                catalogueOwners.delete(instanceId);
              }
            }
          }),
        );
      });
    const syncLiveSources = syncSemaphore.withPermits(1)(
      Effect.suspend(() => {
        // Snapshot before any registry reads. A later replacement/read-created
        // generation belongs to the next serialized pass, not this failure.
        const admissions = new Set(pendingAdmissionInstances);
        return syncLiveSourcesBody(admissions).pipe(
          // Setup/identity defects cannot hang readers or release uncertified
          // getters. Completed outcomes are immutable. A successful pass also
          // retires seeded candidates removed before its enumeration.
          Effect.onError(() => failIncompleteAdmissions(admissions)),
          Effect.tap(() => failIncompleteAdmissions(admissions)),
        );
      }),
    );
    const syncLiveSourcesAndContinue = syncLiveSources.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logError(
          "provider registry instance sync failed; keeping subscription alive",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );

    // Seed `providersRef` with the boot-time fallback snapshots so
    // consumers calling `getProviders` immediately after layer build see
    // a populated list — even before the first `syncLiveSources` refresh
    // resolves. Cached snapshots (already in `providersRef`) merge with
    // these via `upsertProviders` so on-disk state wins where present
    // and pending fallbacks fill the gaps.
    yield* upsertProviders(fallbackProviders, { publish: false });
    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the dequeue synchronously in this
    // fibre; the subscription is active the instant this `yield*`
    // returns. Forking the consumer loop later cannot lose a publish
    // because no publish can reach a not-yet-subscribed dequeue.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `Stream.fromPubSub` defers `PubSub.subscribe` to stream start,
    // and `forkScoped` only schedules the fibre — so a reconcile that
    // published between "fibre scheduled" and "fibre starts running"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the `PubSub.Subscription` synchronously
    // in this fibre; the subscription is registered with the PubSub the
    // instant this `yield*` returns, so any subsequent publish is
    // buffered in the subscription regardless of when the consumer
    // fibre below actually starts running.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `instanceRegistry.streamChanges` is `Stream.fromPubSub(changes)`,
    // which defers `PubSub.subscribe` to stream start. `forkScoped` only
    // schedules the consumer fibre — so a reconcile that published
    // between "fibre scheduled" and "fibre starts running + subscribes"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    const instanceChanges = yield* instanceRegistry.subscribeChanges;
    // Initial sync subscribes and admits every boot instance. The backend
    // waits for the resulting aggregate; the daemon publishes pending status
    // immediately and lets exact-generation capability readers await admission.
    if (options?.initialAdmission === "background") {
      // All boot barriers and the mutation subscription already exist. Keep
      // owner admission scoped and serialized, but do not hold daemon listener
      // readiness behind an unbounded number of two-wide health-check waves.
      yield* syncLiveSourcesAndContinue.pipe(Effect.forkScoped);
    } else {
      yield* syncLiveSources;
    }
    // React to registry mutations — instance added / removed / rebuilt.
    // `Stream.fromSubscription` builds a stream over the pre-acquired
    // subscription rather than subscribing on stream start, which is
    // what closes the race.
    yield* Stream.runForEach(
      Stream.fromSubscription(instanceChanges),
      () => syncLiveSourcesAndContinue,
    ).pipe(Effect.forkScoped);

    const recoverRefreshFailure = Effect.fn("recoverRefreshFailure")(function* (
      cause: Cause.Cause<unknown>,
    ) {
      if (Cause.hasInterruptsOnly(cause)) {
        return yield* Effect.interrupt;
      }
      yield* Effect.logError("provider registry refresh failed; preserving cached providers", {
        cause: Cause.pretty(cause),
      });
      return yield* Ref.get(providersRef);
    });

    return {
      getProviders: Ref.get(providersRef),
      loginProvider: (input, listSessions) =>
        loginBoundProviderAccount({
          instanceId: input.instanceId,
          getInstance: () => instanceRegistry.getInstance(input.instanceId),
          listSessions,
        }),
      readInstanceAccountQuota: (instanceId) =>
        readBoundInstanceQuota(instanceRegistry.getInstance(instanceId)),
      awaitInstanceInitialRefresh,
      discoverSkills: (instanceId, cwd) =>
        discoverBoundProviderSkills(instanceRegistry.getInstance(instanceId), cwd),
      usageReset,
      refresh: (provider?: ProviderDriverKind) =>
        refresh(provider).pipe(Effect.catchCause(recoverRefreshFailure)),
      refreshInstance: (instanceId: ProviderInstanceId) =>
        refreshInstance(instanceId).pipe(Effect.catchCause(recoverRefreshFailure)),
      refreshInstanceAccountUsage: (instanceId: ProviderInstanceId) =>
        refreshInstanceAccountUsage(instanceId).pipe(Effect.catchCause(recoverRefreshFailure)),
      refreshInstanceModels: (instanceId: ProviderInstanceId) =>
        refreshInstanceModels(instanceId).pipe(Effect.catchCause(recoverRefreshFailure)),
      getProviderMaintenanceCapabilitiesForInstance,
      setProviderMaintenanceActionState,
      updateProviderAccountRateLimits,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  });

export const makeProviderRegistryLive = (options?: ProviderRegistryOptions) =>
  Layer.effect(ProviderRegistry, makeProviderRegistry(options));

// Preserve the backend's existing cache-enabled layer identity and behavior.
export const ProviderRegistryLive = makeProviderRegistryLive();
