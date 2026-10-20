/**
 * ProviderInstanceRegistryLive — runtime implementation of
 * `ProviderInstanceRegistry` plus its sibling mutator.
 *
 * Materializes every entry in a `ProviderInstanceConfigMap`:
 *
 *   - When the entry's `driver` matches a registered driver, the registry
 *     decodes the opaque `config` envelope through `driver.configSchema`
 *     and calls `driver.create()` inside a fresh child scope. The
 *     resulting `ProviderInstance` is stored keyed by instance id,
 *     alongside its scope so the entry can be torn down independently.
 *   - When the entry's `driver` is unknown to this build (fork, rollback,
 *     in-flight PR branch), the registry emits an `"unavailable"` shadow
 *     `ServerProvider` snapshot instead of failing. This is what makes
 *     downgrades and fork-hopping safe per the
 *     `forward/backward compatibility invariant` in
 *     `packages/contracts/src/providerInstance.ts`.
 *   - When the entry's config fails schema decode, the registry logs and
 *     emits a shadow snapshot with the schema detail — same bucket as an
 *     unknown driver.
 *
 * Unlike the pre-Slice-D layer, the registry now holds mutable state
 * (`Ref`s + `PubSub`) and exposes an internal mutator
 * (`ProviderInstanceRegistryMutator`) whose `reconcile` method diffs a
 * fresh config map against the live state, tearing down removed instances
 * and building new ones without disturbing unaffected instances.
 *
 * Every live instance runs inside its own child `Scope`. The registry's
 * own scope owns all child scopes via finalizers, so closing the registry
 * tears every instance down in reverse order; closing a single instance
 * (via `reconcile` removing it) leaves the rest untouched.
 *
 * @module provider/Layers/ProviderInstanceRegistryLive
 */
import {
  defaultInstanceIdForDriver,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderDriverKind,
  type ServerProvider,
} from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { buildUnavailableProviderSnapshot } from "../unavailableProviderSnapshot.ts";
import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderInstanceRegistryMutator,
  type ProviderInstanceRegistryMutatorShape,
} from "../Services/ProviderInstanceRegistryMutator.ts";
import type { AnyProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import {
  prepareDebugProviderHome,
  resolveProviderProfileAdmission,
  type ProviderDataProfile,
} from "../debugProviderProfile.ts";

/**
 * Live registry entry: the materialized `ProviderInstance` + the fresh
 * child scope its `create` effect ran in + the original `entry` envelope
 * so `reconcile` can cheaply detect "no-op" updates.
 */
interface LiveEntry {
  readonly instance: ProviderInstance;
  readonly scope: Scope.Closeable;
  readonly close: Effect.Effect<void>;
  readonly entry: ProviderInstanceConfig;
  readonly updatePresentation: (entry: ProviderInstanceConfig) => Effect.Effect<void>;
}

/**
 * Internal state shared between the public registry service and the
 * mutator service. Both services are thin shells around these refs.
 */
interface RegistryState {
  readonly entries: Ref.Ref<ReadonlyMap<ProviderInstanceId, LiveEntry>>;
  readonly unavailable: Ref.Ref<ReadonlyMap<ProviderInstanceId, ServerProvider>>;
  readonly changes: PubSub.PubSub<void>;
  /** Exact retiring owners stay available for teardown, never for routing. */
  readonly retiring: WeakSet<ProviderInstance>;
  readonly reconcileSemaphore: Semaphore.Semaphore;
  /** Unpublished scopes must finish cleanup before their routing id is reused. */
  readonly unpublishedScopes: Map<ProviderInstanceId, Effect.Effect<void>>;
}

/**
 * Scope.close marks a scope Closed before its asynchronous finalizers finish.
 * Closing it a second time therefore does not join the first cleanup, and a
 * defective cleanup must not turn into a successful no-op on retry. Every
 * owner has one shared, immutable close receipt used by reconciliation and by
 * the enclosing scope. Only the cleanup/receipt publication is protected;
 * provider construction and provider operations remain interruptible.
 */
const makeJoinedScopeClose = (scope: Scope.Closeable) =>
  Effect.gen(function* () {
    const completion = yield* Deferred.make<void>();
    let started = false;
    return Effect.uninterruptible(
      Effect.suspend(() => {
        if (started) return Deferred.await(completion);
        started = true;
        return Effect.exit(Scope.close(scope, Exit.void)).pipe(
          Effect.flatMap((exit) => Deferred.done(completion, exit)),
          Effect.andThen(Deferred.await(completion)),
        );
      }),
    );
  });

/** Join every provisional owner, retaining any failed receipt as a reuse veto. */
const closeUnpublishedScopes = (state: RegistryState) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      let firstFailure: Exit.Exit<void, never> | undefined;
      for (const [id, close] of state.unpublishedScopes) {
        const exit = yield* Effect.exit(close);
        if (Exit.isSuccess(exit)) {
          // The reconcile permit makes this exact-effect comparison sufficient:
          // no other mutator can replace this id while cleanup is being joined.
          if (state.unpublishedScopes.get(id) === close) state.unpublishedScopes.delete(id);
        } else if (firstFailure === undefined) {
          firstFailure = exit;
        }
      }
      if (firstFailure !== undefined) yield* firstFailure;
    }),
  );

/**
 * Only settings consumed by the driver may replace its process-owning scope.
 * Presentation and lifecycle-neutral defaults can change during a multi-hour turn;
 * closing that scope would kill the turn merely to rename its provider or
 * change reasoning or inherited subagent preferences. Keep opaque driver config and
 * environment comparisons structural, including credential-bearing values,
 * so a real runtime change still follows the existing reload boundary.
 */
const runtimeEntryEqual = (a: ProviderInstanceConfig, b: ProviderInstanceConfig): boolean =>
  a.driver === b.driver &&
  a.enabled === b.enabled &&
  a.debugStateSharing === b.debugStateSharing &&
  Equal.equals(a.environment, b.environment) &&
  Equal.equals(a.config, b.config);

/**
 * Keep the instance and snapshot wrapper identities stable across cosmetic
 * edits. ProviderService and ProviderRegistry key their subscriptions by those
 * identities; replacing wrappers on each rename would leave duplicate stream
 * subscribers alive until the runtime itself eventually shuts down.
 */
const withLivePresentation = (
  instance: ProviderInstance,
  entry: ProviderInstanceConfig,
  defaultDisplayName: string,
) =>
  Effect.gen(function* () {
    const presentation = yield* Ref.make({
      displayName: entry.displayName,
      accentColor: entry.accentColor,
    });
    const changes = yield* PubSub.unbounded<void>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
    const decorate = (snapshot: ServerProvider): ServerProvider => {
      const current = Ref.getUnsafe(presentation);
      return {
        ...snapshot,
        // The source snapshot may retain the custom name captured at driver
        // creation. Removing that override must restore the driver's label.
        displayName: current.displayName ?? defaultDisplayName,
        accentColor: current.accentColor,
      };
    };
    const snapshot = instance.snapshot;
    const getSnapshot = snapshot.getSnapshot.pipe(Effect.map(decorate));
    const presented: ProviderInstance = {
      ...instance,
      get displayName() {
        return Ref.getUnsafe(presentation).displayName;
      },
      get accentColor() {
        return Ref.getUnsafe(presentation).accentColor;
      },
      snapshot: {
        ...snapshot,
        getSnapshot,
        ...(snapshot.getCurrentSnapshot
          ? { getCurrentSnapshot: snapshot.getCurrentSnapshot.pipe(Effect.map(decorate)) }
          : {}),
        refresh: snapshot.refresh.pipe(Effect.map(decorate)),
        ...(snapshot.refreshAccountUsage
          ? { refreshAccountUsage: snapshot.refreshAccountUsage.pipe(Effect.map(decorate)) }
          : {}),
        ...(snapshot.refreshModels
          ? { refreshModels: snapshot.refreshModels.pipe(Effect.map(decorate)) }
          : {}),
        get streamChanges() {
          // A rename must become visible even while the provider is silent.
          // Both sources read the current presentation at delivery time, so a
          // delayed probe cannot restore a previous name or accent color.
          return Stream.merge(
            snapshot.streamChanges.pipe(Stream.map(decorate)),
            Stream.fromPubSub(changes).pipe(Stream.mapEffect(() => getSnapshot)),
            { haltStrategy: "either" },
          );
        },
      },
    };
    const updatePresentation = (next: ProviderInstanceConfig) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(presentation);
        if (current.displayName === next.displayName && current.accentColor === next.accentColor) {
          return;
        }
        yield* Ref.set(presentation, {
          displayName: next.displayName,
          accentColor: next.accentColor,
        });
        yield* PubSub.publish(changes, undefined);
      });
    return { instance: presented, updatePresentation };
  });

const decodedConfigEnabled = (config: unknown): boolean | undefined => {
  if (!config || typeof config !== "object" || globalThis.Array.isArray(config)) {
    return undefined;
  }
  const enabled = (config as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

/**
 * Build one live entry from a raw config envelope. Returns either a
 * `LiveEntry` plus undefined unavailable shadow, or a shadow snapshot and
 * undefined entry — callers dispatch to the appropriate Ref bucket.
 */
const buildEntry = <R>(input: {
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
  readonly instanceId: ProviderInstanceId;
  readonly rawInstanceId: string;
  readonly entry: ProviderInstanceConfig;
  readonly profile?: ProviderDataProfile | undefined;
  readonly registerUnpublishedScope: (close: Effect.Effect<void>) => void;
}): Effect.Effect<
  | { readonly kind: "live"; readonly live: LiveEntry }
  | { readonly kind: "unavailable"; readonly snapshot: ServerProvider },
  never,
  R
> =>
  Effect.gen(function* () {
    const { driversById, parentScope, instanceId, rawInstanceId, entry } = input;
    const driver = driversById.get(entry.driver);
    if (!driver) {
      return {
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Driver '${entry.driver}' is not registered in this build.`,
        }),
      };
    }

    const decoder = Schema.decodeUnknownEffect(driver.configSchema);
    const decodeResult = yield* decoder(entry.config ?? driver.defaultConfig()).pipe(Effect.result);
    if (decodeResult._tag === "Failure") {
      const issue = decodeResult.failure;
      const detail = issue.message ?? String(issue);
      yield* Effect.logError("Failed to decode provider instance config", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        detail,
      });
      return {
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Invalid config for instance '${rawInstanceId}': ${detail}`,
        }),
      };
    }

    const typedConfig = decodeResult.success;
    const enabled = entry.enabled ?? decodedConfigEnabled(typedConfig) ?? true;
    const admission = resolveProviderProfileAdmission({
      profile: input.profile,
      instanceId,
      entry,
      config: typedConfig,
      enabled,
    });
    if (admission.kind === "refused") {
      return {
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: admission.reason,
        }),
      };
    }
    if (admission.nativeHome && input.profile) {
      const prepared = yield* Effect.tryPromise({
        try: () => prepareDebugProviderHome(input.profile!, admission.nativeHome!),
        catch: () => "Debug provider home could not be prepared safely. No provider was started.",
      }).pipe(Effect.result);
      if (prepared._tag === "Failure") {
        return {
          kind: "unavailable" as const,
          snapshot: yield* buildUnavailableProviderSnapshot({
            driverKind: entry.driver,
            instanceId,
            displayName: entry.displayName,
            accentColor: entry.accentColor,
            reason: prepared.failure,
          }),
        };
      }
    }
    // Reserve cleanup ownership before entering interruptible driver code. A
    // cancelled/defective create may already own resources even though it never
    // returns an instance. The reconcile permit cannot be released until every
    // such provisional scope has been joined (including earlier successful
    // creates in the same not-yet-published batch).
    const { childScope, close } = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const childScope = yield* Scope.make();
        const close = yield* makeJoinedScopeClose(childScope);
        input.registerUnpublishedScope(close);
        yield* Scope.addFinalizer(parentScope, close);
        return { childScope, close };
      }),
    );
    // A parent which already closed may have run the newly registered finalizer
    // synchronously. Closed is a refusal signal, never a successful cleanup
    // witness authorizing a replacement or a provider call.
    if (childScope.state._tag === "Closed") return yield* Effect.interrupt;

    const createResult = yield* driver
      .create({
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        environment: entry.environment ?? [],
        processEnvironment: admission.processEnvironment,
        enabled,
        config: admission.config,
      })
      .pipe(Effect.provideService(Scope.Scope, childScope), Effect.result);
    if (createResult._tag === "Failure") {
      yield* Effect.logError("Failed to create provider instance", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        detail: createResult.failure.detail,
      });
      yield* close;
      return {
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Driver '${entry.driver}' failed to create instance: ${createResult.failure.detail}`,
        }),
      };
    }

    const presented = yield* withLivePresentation(
      createResult.success,
      entry,
      driver.metadata.displayName,
    ).pipe(Effect.provideService(Scope.Scope, childScope));
    return {
      kind: "live" as const,
      live: {
        ...presented,
        scope: childScope,
        close,
        entry,
      },
    };
  });

/**
 * Reconcile-only implementation of the mutator. Exposed to the hydration
 * layer; never called directly by the rest of the server.
 */
const makeReconcile = <R>(input: {
  readonly state: RegistryState;
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
  readonly profile?: ProviderDataProfile | undefined;
}): ((configMap: ProviderInstanceConfigMap) => Effect.Effect<void, never, R>) => {
  const { state, driversById, parentScope } = input;
  return (configMap: ProviderInstanceConfigMap) =>
    state.reconcileSemaphore.withPermits(1)(
      Effect.gen(function* () {
        // A previous cancelled batch can leave only completed refusal receipts,
        // never an unjoined owner. Failed cleanup blocks reuse on every retry.
        yield* closeUnpublishedScopes(state);
        const previousEntries = yield* Ref.get(state.entries);
        const previousUnavailable = yield* Ref.get(state.unavailable);
        const nextRaw = Object.entries(configMap);
        const nextKeys = new Set<ProviderInstanceId>(
          nextRaw.map(([raw]) => ProviderInstanceId.make(raw)),
        );

        // 1. Close scopes for instances that disappeared or whose config
        //    changed. Do this BEFORE creating replacements so ids map 1-to-1
        //    to live scopes at all times.
        const removedIds: Array<ProviderInstanceId> = [];
        const replacedIds = new Set<ProviderInstanceId>();
        for (const [instanceId, live] of previousEntries) {
          if (!nextKeys.has(instanceId)) {
            removedIds.push(instanceId);
            continue;
          }
          const nextEntry = configMap[instanceId];
          if (
            state.retiring.has(live.instance) ||
            (nextEntry !== undefined && !runtimeEntryEqual(live.entry, nextEntry))
          ) {
            replacedIds.add(instanceId);
          }
        }
        const retiringEntries = [...removedIds, ...replacedIds]
          .map((id) => previousEntries.get(id))
          .filter((live): live is LiveEntry => live !== undefined);
        if (retiringEntries.length > 0) {
          // Revocation precedes any awaited finalizer. A cancelled admission can
          // now complete its waiters during Scope.close without exposing the
          // obsolete adapter/capability getter as a still-current owner.
          // Keep entries internally until their teardown is joined, and serialize
          // reconciliations so no concurrent caller can create a competitor.
          // This protected region is only retirement bookkeeping/cleanup; driver
          // construction below retains its original interruptibility and bounds.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              for (const live of retiringEntries) state.retiring.add(live.instance);
              yield* PubSub.publish(state.changes, undefined);
              let firstFailure: Exit.Exit<void, never> | undefined;
              for (const live of retiringEntries) {
                const exit = yield* Effect.exit(live.close);
                if (Exit.isFailure(exit) && firstFailure === undefined) firstFailure = exit;
              }
              if (firstFailure !== undefined) yield* firstFailure;
            }),
          );
        }

        // 2. Build additions and replacements. Walk `nextRaw` so the final
        //    entry order follows settings-author order.
        const builtEntries = new Map<ProviderInstanceId, LiveEntry>();
        const builtUnavailable = new Map<ProviderInstanceId, ServerProvider>();
        let orderChanged = false;
        let presentationOrDefaultsChanged = false;
        const previousOrder = [...previousEntries.keys()];
        const nextOrder: Array<ProviderInstanceId> = [];

        for (const [rawInstanceId, entry] of nextRaw) {
          const instanceId = ProviderInstanceId.make(rawInstanceId);
          nextOrder.push(instanceId);

          const existing = previousEntries.get(instanceId);
          if (existing !== undefined && !replacedIds.has(instanceId)) {
            // Defaults are read from ServerSettings by the composer/turn reactor,
            // not by the driver. Retain the newest envelope for comparisons without
            // changing the process, session inventory, or subscription identity.
            if (!Equal.equals(existing.entry, entry)) {
              presentationOrDefaultsChanged = true;
              yield* existing.updatePresentation(entry);
            }
            builtEntries.set(instanceId, { ...existing, entry });
            continue;
          }

          const result = yield* buildEntry({
            profile: input.profile,
            driversById,
            parentScope,
            instanceId,
            rawInstanceId,
            entry,
            registerUnpublishedScope: (close) => state.unpublishedScopes.set(instanceId, close),
          });
          if (result.kind === "live") {
            builtEntries.set(instanceId, result.live);
          } else {
            builtUnavailable.set(instanceId, result.snapshot);
          }
        }

        if (previousOrder.length === nextOrder.length) {
          for (let i = 0; i < previousOrder.length; i++) {
            if (previousOrder[i] !== nextOrder[i]) {
              orderChanged = true;
              break;
            }
          }
        } else {
          orderChanged = true;
        }

        const entriesChanged =
          orderChanged ||
          presentationOrDefaultsChanged ||
          removedIds.length > 0 ||
          replacedIds.size > 0 ||
          builtEntries.size !== previousEntries.size;
        const unavailableChanged =
          builtUnavailable.size !== previousUnavailable.size ||
          [...builtUnavailable].some(([id, snapshot]) => {
            const prev = previousUnavailable.get(id);
            return prev === undefined || !Equal.equals(prev, snapshot);
          }) ||
          [...previousUnavailable].some(([id]) => !builtUnavailable.has(id));

        // Transfer only a complete batch into the routing map. Cancellation
        // between these local writes must not publish an owner and then have the
        // provisional cleanup finalizer retire that now-visible owner.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const admitted = yield* Ref.modify(state.entries, (current) => {
              // A separately owned caller may finish an interruptible create after
              // the registry parent has shut down. Check and publish synchronously
              // inside this exact local mutation; a Closed scope is only a veto,
              // never the joined-success receipt used for owner replacement.
              if (
                parentScope.state._tag === "Closed" ||
                Array.from(builtEntries.values()).some((live) => live.scope.state._tag === "Closed")
              )
                return [false, current] as const;
              return [true, builtEntries] as const;
            });
            if (!admitted) return yield* Effect.interrupt;
            yield* Ref.set(state.unavailable, builtUnavailable);
            state.unpublishedScopes.clear();
            if (entriesChanged || unavailableChanged) {
              yield* PubSub.publish(state.changes, undefined);
            }
          }),
        );
      }).pipe(Effect.ensuring(closeUnpublishedScopes(state))),
    );
};

/**
 * Build the registry's runtime state from a concrete configMap. Returns a
 * record containing:
 *
 *   - `registry`: the read-only `ProviderInstanceRegistryShape` to expose
 *     under `ProviderInstanceRegistry`.
 *   - `mutator`: the `ProviderInstanceRegistryMutatorShape` to expose
 *     under `ProviderInstanceRegistryMutator`.
 *   - `reconcile`: the raw reconcile function, provided for convenience so
 *     boot-time layers can hydrate an initial map before publishing the
 *     services.
 *
 * The scope that this effect runs in owns every per-instance child scope
 * created during `reconcile`. Closing that scope closes every live
 * instance.
 */
export const makeProviderInstanceRegistry = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
  readonly profile?: ProviderDataProfile | undefined;
}): Effect.Effect<
  {
    readonly registry: ProviderInstanceRegistryShape;
    readonly mutator: ProviderInstanceRegistryMutatorShape;
  },
  never,
  R | Scope.Scope
> =>
  Effect.gen(function* () {
    const driversById = new Map<ProviderDriverKind, AnyProviderDriver<R>>(
      input.drivers.map((driver) => [driver.driverKind, driver]),
    );

    // Capture the enclosing scope so per-instance child scopes can be
    // attached to it at `reconcile` time. Without this, `reconcile`
    // called later (e.g. from the hydration layer) would attach child
    // scopes to the *caller's* scope instead of the registry's.
    const parentScope = yield* Scope.Scope;

    // Capture the driver R context at construction time so `reconcile`
    // can be invoked later without re-providing driver dependencies.
    // The service tag's declared `reconcile: Effect<void>` hides R from
    // consumers — we materialize that here.
    const driverContext = yield* Effect.context<R>();

    const entries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, LiveEntry>>(new Map());
    const unavailable = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ServerProvider>>(new Map());
    const changes = yield* PubSub.unbounded<void>();
    const retiring = new WeakSet<ProviderInstance>();
    const reconcileSemaphore = yield* Semaphore.make(1);
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

    const state: RegistryState = {
      entries,
      unavailable,
      changes,
      retiring,
      reconcileSemaphore,
      unpublishedScopes: new Map(),
    };
    const reconcileWithR = makeReconcile({
      state,
      driversById,
      parentScope,
      profile: input.profile,
    });
    const reconcile: ProviderInstanceRegistryMutatorShape["reconcile"] = (configMap) =>
      reconcileWithR(configMap).pipe(Effect.provideContext(driverContext));

    // Hydrate the initial configMap synchronously so callers can read
    // `listInstances` immediately after this effect completes.
    yield* reconcile(input.configMap);

    const registry: ProviderInstanceRegistryShape = {
      getInstance: (id) =>
        Ref.get(entries).pipe(
          Effect.map((map) => {
            const live = map.get(id);
            return parentScope.state._tag !== "Closed" &&
              live?.scope.state._tag !== "Closed" &&
              live &&
              !retiring.has(live.instance)
              ? live.instance
              : undefined;
          }),
        ),
      listInstances: Ref.get(entries).pipe(
        Effect.map((map) =>
          parentScope.state._tag === "Closed"
            ? []
            : (Array.from(map.values())
                .filter(
                  (live) => live.scope.state._tag !== "Closed" && !retiring.has(live.instance),
                )
                .map((live) => live.instance) as ReadonlyArray<ProviderInstance>),
        ),
      ),
      listUnavailable: Ref.get(unavailable).pipe(
        Effect.map((map) => Array.from(map.values()) as ReadonlyArray<ServerProvider>),
      ),
      // Getters: each read constructs a fresh Stream / Effect descriptor
      // so multiple consumers don't share a single already-started
      // Channel or subscription. Matches the pattern `ProviderRegistry`
      // uses for its own `streamChanges`.
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      // Synchronous subscribe — callers that need to consume changes
      // from a forked fibre must acquire the subscription in their own
      // fibre first (via `yield* registry.subscribeChanges`) and only
      // then fork a consumer loop on `Stream.fromSubscription(...)` /
      // `PubSub.take(...)`. See the shape docs for the race this avoids.
      get subscribeChanges() {
        return PubSub.subscribe(changes);
      },
    };

    const mutator: ProviderInstanceRegistryMutatorShape = { reconcile };

    return { registry, mutator };
  });

/**
 * Assemble a `ProviderInstanceRegistry` Layer bound to a fixed set of
 * drivers and a pre-resolved `ProviderInstanceConfigMap`. Used by tests
 * that want explicit control over the registry's source-of-truth without
 * wiring up the settings watcher.
 *
 * Only exposes the public registry tag — hot-reload consumers should use
 * `ProviderInstanceRegistryMutableLayer` (below) or the hydration layer.
 */
export const ProviderInstanceRegistryLayer = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
  readonly profile?: ProviderDataProfile | undefined;
}): Layer.Layer<ProviderInstanceRegistry, never, R> =>
  Layer.effect(
    ProviderInstanceRegistry,
    makeProviderInstanceRegistry(input).pipe(Effect.map((built) => built.registry)),
  ) as Layer.Layer<ProviderInstanceRegistry, never, R>;

/**
 * Layer variant that also exposes the mutator tag. Consumed by
 * `ProviderInstanceRegistryHydrationLive` to reconcile on settings
 * changes. Tests that exercise the mutator directly can pair this Layer
 * with a test-local `ServerSettingsService`.
 */
export const ProviderInstanceRegistryMutableLayer = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
  readonly profile?: ProviderDataProfile | undefined;
}): Layer.Layer<ProviderInstanceRegistry | ProviderInstanceRegistryMutator, never, R> =>
  Layer.effectContext(
    makeProviderInstanceRegistry(input).pipe(
      Effect.map(({ registry, mutator }) =>
        Context.make(ProviderInstanceRegistry, registry).pipe(
          Context.add(ProviderInstanceRegistryMutator, mutator),
        ),
      ),
    ),
  ) as Layer.Layer<ProviderInstanceRegistry | ProviderInstanceRegistryMutator, never, R>;

export { defaultInstanceIdForDriver };
