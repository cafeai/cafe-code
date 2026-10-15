/**
 * Multi-instance validation slices for `ProviderInstanceRegistryLive`.
 *
 * Two axes of the driver/registry refactor are exercised here:
 *
 *  1. **Same driver, many instances** — the "multi-instance codex slice"
 *     describe block below configures two independent `codex` instances and
 *     asserts each gets its own closures and identity. This is the
 *     multi-codex capability the refactor exists to unlock.
 *
 *  2. **Many drivers, one registry** — the "all drivers slice" describe
 *     block below configures one instance of every shipped driver
 *     (`codex`, `claudeAgent`) in a single
 *     `ProviderInstanceConfigMap` and asserts the registry boots them all
 *     without cross-contamination. This proves the driver SPI is uniform
 *     across every provider — any driver plugs into the registry through
 *     the same `ProviderDriver` value contract.
 *
 * Every instance in these tests is configured with `enabled: false` so the
 * provider-status checks short-circuit to pending/disabled snapshots
 * without trying to spawn real `codex` / `claude`
 * binaries. That keeps the assertions focused on registry routing
 * behaviour rather than the runtime details of each provider.
 */
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ClaudeSettings,
  type CodexSettings,
  type ProviderInstanceConfig,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
  type ProviderSession,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { ClaudeDriver } from "../Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../Drivers/CodexDriver.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  runtimeSource: "system",
  homePath: "",
  shadowHomePath: "",
  customModels: [],
  ...overrides,
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  runtimeSource: "system",
  homePath: "",
  customModels: [],
  launchArgs: "",
  ...overrides,
});

/** An entirely in-memory driver: unexpected provider I/O fails the test. */
const unexpectedRegistryProviderOperation = () =>
  Effect.die(new Error("Unexpected provider operation in registry test"));

const makeLifecycleDriver = Effect.gen(function* () {
  const counters = { created: 0, closed: 0, subscribers: 0, refreshes: 0 };
  const subscribed = yield* Deferred.make<void>();
  const publications = yield* Queue.unbounded<Effect.Effect<boolean>>();
  const driverKind = ProviderDriverKind.make("registry_fixture");
  const driver: ProviderDriver<{ readonly binaryPath: string }> = {
    driverKind,
    metadata: { displayName: "Registry fixture" },
    configSchema: Schema.Struct({ binaryPath: Schema.String }),
    defaultConfig: () => ({ binaryPath: "fixture" }),
    create: (input) =>
      Effect.gen(function* () {
        counters.created += 1;
        const sessions = new Map<ThreadId, ProviderSession>();
        const changes = yield* PubSub.unbounded<ServerProvider>();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            counters.closed += 1;
            sessions.clear();
          }).pipe(Effect.andThen(PubSub.shutdown(changes))),
        );
        const initialSnapshot: ServerProvider = {
          instanceId: input.instanceId,
          driver: driverKind,
          displayName: input.displayName,
          accentColor: input.accentColor,
          enabled: input.enabled,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-09-16T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        };
        yield* Queue.offer(publications, PubSub.publish(changes, initialSnapshot));
        const adapter: ProviderAdapterShape<never> = {
          provider: driverKind,
          capabilities: { sessionModelSwitch: "in-session", liveSteer: "supported" },
          startSession: (start) =>
            Effect.sync(() => {
              const session: ProviderSession = {
                provider: driverKind,
                providerInstanceId: input.instanceId,
                threadId: start.threadId,
                runtimeMode: start.runtimeMode,
                status: "running",
                activeTurnId: TurnId.make("registry-active-turn"),
                createdAt: "2026-09-16T00:00:00.000Z",
                updatedAt: "2026-09-16T00:00:00.000Z",
              };
              sessions.set(start.threadId, session);
              return session;
            }),
          listSessions: () => Effect.sync(() => [...sessions.values()]),
          hasSession: (id) => Effect.sync(() => sessions.has(id)),
          stopSession: (id) =>
            Effect.sync(() => {
              sessions.delete(id);
            }),
          stopAll: () => Effect.sync(() => sessions.clear()),
          sendTurn: unexpectedRegistryProviderOperation,
          steerTurn: unexpectedRegistryProviderOperation,
          interruptTurn: unexpectedRegistryProviderOperation,
          respondToRequest: unexpectedRegistryProviderOperation,
          respondToUserInput: unexpectedRegistryProviderOperation,
          readThread: unexpectedRegistryProviderOperation,
          rollbackThread: unexpectedRegistryProviderOperation,
          streamEvents: Stream.never,
        };
        const refresh = Effect.sync(() => {
          counters.refreshes += 1;
          return initialSnapshot;
        });
        return {
          instanceId: input.instanceId,
          driverKind,
          continuationIdentity: { driverKind, continuationKey: "registry-fixture" },
          displayName: input.displayName,
          accentColor: input.accentColor,
          enabled: input.enabled,
          adapter,
          snapshot: {
            maintenanceCapabilities: { provider: driverKind, packageName: null, update: null },
            getSnapshot: Effect.succeed(initialSnapshot),
            getCurrentSnapshot: Effect.succeed(initialSnapshot),
            refresh,
            refreshAccountUsage: refresh,
            refreshModels: refresh,
            streamChanges: Stream.unwrap(
              Effect.gen(function* () {
                const subscription = yield* PubSub.subscribe(changes);
                counters.subscribers += 1;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    counters.subscribers -= 1;
                  }),
                );
                yield* Deferred.succeed(subscribed, undefined);
                return Stream.fromSubscription(subscription);
              }),
            ),
          },
          textGeneration: {
            generateCommitMessage: unexpectedRegistryProviderOperation,
            generatePrContent: unexpectedRegistryProviderOperation,
            generateBranchName: unexpectedRegistryProviderOperation,
            generateThreadTitle: unexpectedRegistryProviderOperation,
            generateThreadMetadata: unexpectedRegistryProviderOperation,
          },
        };
      }),
  };
  return { driver, counters, subscribed, publications };
});

describe("ProviderInstanceRegistryLive — non-runtime settings", () => {
  it.effect("retires the previous runtime when its driver changes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeLifecycleDriver;
      const id = ProviderInstanceId.make("registry_fixture");
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [fixture.driver],
        configMap: { [id]: { driver: fixture.driver.driverKind } },
      });
      const initial = (yield* registry.getInstance(id))!;
      yield* initial.adapter.startSession({
        threadId: ThreadId.make("registry-running-thread"),
        runtimeMode: "full-access",
      });
      // A different, unavailable driver must never inherit the old driver's
      // running process under the same routing id.
      yield* mutator.reconcile({ [id]: { driver: ProviderDriverKind.make("other_driver") } });
      expect(yield* registry.getInstance(id)).toBeUndefined();
      expect(yield* initial.adapter.listSessions()).toEqual([]);
      expect(fixture.counters.closed).toBe(1);
      expect(yield* registry.listUnavailable).toMatchObject([{ driver: "other_driver" }]);
    }),
  );

  it.effect(
    "preserves an active session and one subscription across presentation and default changes",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeLifecycleDriver;
        const id = ProviderInstanceId.make("registry_fixture");
        const initialEntry: ProviderInstanceConfig = {
          driver: fixture.driver.driverKind,
          displayName: "Initial",
          accentColor: "#111111",
          config: { binaryPath: "fixture" },
        };
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [fixture.driver],
          configMap: { [id]: initialEntry },
        });
        const initial = (yield* registry.getInstance(id))!;
        const session = yield* initial.adapter.startSession({
          threadId: ThreadId.make("registry-running-thread"),
          runtimeMode: "full-access",
        });
        const observed = yield* Queue.unbounded<ServerProvider>();
        const watch = yield* initial.snapshot.streamChanges.pipe(
          Stream.runForEach((snapshot) => Queue.offer(observed, snapshot)),
          Effect.forkChild,
        );
        yield* Deferred.await(fixture.subscribed);
        // Both merged stream branches must subscribe before the first rename.
        yield* Effect.yieldNow;
        const updates: readonly (
          | Partial<ProviderInstanceConfig>
          | "clear-subagent-default"
          | "clear-context-default"
        )[] = [
          { displayName: "Renamed" },
          { accentColor: "#222222" },
          { defaultModel: "gpt-6-astra" },
          { defaultModelOptions: [{ id: "reasoningEffort", value: "max" }] },
          { defaultModelOptions: [{ id: "reasoningEffort", value: "ultra" }] },
          // This default is inherited at a safe turn boundary. Saving or clearing it
          // must not retire a running provider or duplicate its subscription.
          { defaultMaxConcurrentSubagents: 4 },
          { defaultMaxConcurrentSubagents: 64 },
          "clear-subagent-default",
          { defaultCodexContextWindowOverride: 500_000 },
          { defaultCodexContextWindowOverride: 700_000 },
          "clear-context-default",
          { displayName: undefined, accentColor: undefined },
        ];
        let entry = initialEntry;
        for (const update of updates) {
          if (update === "clear-subagent-default") {
            // Reset uses real key omission, matching the settings schema's
            // exact optional field rather than retaining an undefined value.
            const { defaultMaxConcurrentSubagents: _previousDefault, ...resetEntry } = entry;
            entry = resetEntry;
            expect("defaultMaxConcurrentSubagents" in entry).toBe(false);
          } else if (update === "clear-context-default") {
            const { defaultCodexContextWindowOverride: _previousContextDefault, ...resetEntry } =
              entry;
            entry = resetEntry;
            expect("defaultCodexContextWindowOverride" in entry).toBe(false);
          } else {
            entry = Object.assign({}, entry, update);
          }
          yield* mutator.reconcile({ [id]: entry });
          const current = (yield* registry.getInstance(id))!;
          expect(current).toBe(initial);
          expect(current.adapter).toBe(initial.adapter);
          expect(current.snapshot).toBe(initial.snapshot);
          expect(yield* current.adapter.listSessions()).toEqual([session]);
          expect(current.displayName).toBe(entry.displayName);
          expect(current.accentColor).toBe(entry.accentColor);
          expect(yield* current.snapshot.getSnapshot).toMatchObject({
            displayName: entry.displayName ?? fixture.driver.metadata.displayName,
            accentColor: entry.accentColor,
          });
          // Registry catalogue synchronization reads this inert view directly.
          // It must receive the same live presentation without a health/model
          // refresh, including Reset and otherwise lifecycle-neutral defaults.
          expect(yield* current.snapshot.getCurrentSnapshot!).toMatchObject({
            displayName: entry.displayName ?? fixture.driver.metadata.displayName,
            accentColor: entry.accentColor,
          });
          if (
            update !== "clear-subagent-default" &&
            update !== "clear-context-default" &&
            ("displayName" in update || "accentColor" in update)
          ) {
            expect(yield* Queue.take(observed)).toMatchObject({
              displayName: entry.displayName ?? fixture.driver.metadata.displayName,
              accentColor: entry.accentColor,
            });
          }
        }
        expect(fixture.counters).toEqual({ created: 1, closed: 0, subscribers: 1, refreshes: 0 });
        // The underlying driver still stamps its original name. Every refresh
        // and delayed source event must be overlaid with current presentation,
        // including removing a previously configured name/color.
        for (const refresh of [
          initial.snapshot.refresh,
          initial.snapshot.refreshAccountUsage!,
          initial.snapshot.refreshModels!,
        ]) {
          expect(yield* refresh).toMatchObject({
            displayName: "Registry fixture",
            accentColor: undefined,
          });
        }
        const publishOriginalSnapshot = yield* Queue.take(fixture.publications);
        yield* publishOriginalSnapshot;
        expect(yield* Queue.take(observed)).toMatchObject({
          displayName: "Registry fixture",
          accentColor: undefined,
        });
        yield* mutator.reconcile({});
        yield* Fiber.join(watch);
        expect(fixture.counters.closed).toBe(1);
        expect(fixture.counters.subscribers).toBe(0);
      }),
  );

  for (const [field, change] of [
    ["config", { config: { binaryPath: "replacement" } }],
    [
      "environment",
      { environment: [{ name: "REGISTRY_FIXTURE", value: "changed", sensitive: false }] },
    ],
    ["enabled", { enabled: false }],
  ] as const) {
    it.effect(`still replaces the runtime when ${field} changes`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeLifecycleDriver;
        const id = ProviderInstanceId.make("registry_fixture");
        const entry: ProviderInstanceConfig = {
          driver: fixture.driver.driverKind,
          config: { binaryPath: "fixture" },
        };
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [fixture.driver],
          configMap: { [id]: entry },
        });
        const initial = (yield* registry.getInstance(id))!;
        yield* initial.adapter.startSession({
          threadId: ThreadId.make("registry-running-thread"),
          runtimeMode: "full-access",
        });
        yield* mutator.reconcile({ [id]: { ...entry, ...change } });
        const current = (yield* registry.getInstance(id))!;
        expect(current.adapter).not.toBe(initial.adapter);
        expect(yield* initial.adapter.listSessions()).toEqual([]);
        expect(yield* current.adapter.listSessions()).toEqual([]);
        expect(fixture.counters.created).toBe(2);
        expect(fixture.counters.closed).toBe(1);
      }),
    );
  }
});

describe("ProviderInstanceRegistryLive — owner retirement", () => {
  for (const action of ["remove", "replace"] as const) {
    it.effect(
      `revokes an exact owner before held ${action} cleanup and serializes its replacement`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeLifecycleDriver;
          const closing = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const id = ProviderInstanceId.make("registry_retiring");
          const otherId = ProviderInstanceId.make("registry_retained");
          const entry: ProviderInstanceConfig = {
            driver: fixture.driver.driverKind,
            config: { binaryPath: "original" },
          };
          const otherEntry: ProviderInstanceConfig = {
            driver: fixture.driver.driverKind,
            config: { binaryPath: "other" },
          };
          const driver: typeof fixture.driver = {
            ...fixture.driver,
            create: (input) =>
              Effect.gen(function* () {
                const instance = yield* fixture.driver.create(input);
                if (input.instanceId === id && input.config.binaryPath === "original") {
                  yield* Effect.addFinalizer(() =>
                    Deferred.succeed(closing, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    ),
                  );
                }
                return instance;
              }),
          };
          yield* Effect.gen(function* () {
            const { registry, mutator } = yield* makeProviderInstanceRegistry({
              drivers: [driver],
              configMap: { [id]: entry, [otherId]: otherEntry },
            });
            const original = (yield* registry.getInstance(id))!;
            const retained = (yield* registry.getInstance(otherId))!;
            const session = yield* original.adapter.startSession({
              threadId: ThreadId.make("retiring-native-session"),
              runtimeMode: "full-access",
            });
            const changes = yield* registry.subscribeChanges;
            const next: ProviderInstanceConfigMap =
              action === "remove"
                ? { [otherId]: otherEntry }
                : {
                    [id]: { ...entry, config: { binaryPath: "replacement" } },
                    [otherId]: otherEntry,
                  };
            const first = yield* mutator.reconcile(next).pipe(Effect.forkChild);
            yield* Deferred.await(closing);
            // This publication precedes the old finalizer's completion, exactly
            // when an interrupted registry admission can wake its pending reader.
            yield* PubSub.take(changes);
            expect(yield* registry.getInstance(id)).toBeUndefined();
            expect(yield* registry.listInstances).toEqual([retained]);
            expect(yield* registry.getInstance(otherId)).toBe(retained);
            expect(yield* original.adapter.listSessions()).toEqual([session]);
            expect(fixture.counters.created).toBe(2);
            expect(fixture.counters.closed).toBe(0);
            // Starting this exact concurrent invocation is not a cleanup receipt:
            // it must wait for the first reconcile permit, never spawn a competitor.
            const second = yield* mutator
              .reconcile(next)
              .pipe(Effect.forkChild({ startImmediately: true }));
            expect(fixture.counters.created).toBe(2);
            expect(yield* registry.getInstance(id)).toBeUndefined();
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(first);
            yield* Fiber.join(second);
            expect(fixture.counters.closed).toBe(1);
            expect(fixture.counters.created).toBe(action === "replace" ? 3 : 2);
            expect(yield* original.adapter.listSessions()).toEqual([]);
            expect(yield* registry.getInstance(otherId)).toBe(retained);
            const replacement = yield* registry.getInstance(id);
            if (action === "replace") {
              expect(replacement).toBeDefined();
              expect(replacement).not.toBe(original);
              expect(yield* replacement!.adapter.listSessions()).toEqual([]);
            } else {
              expect(replacement).toBeUndefined();
            }
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        }),
    );
  }

  it.effect(
    "joins cancelled retirement before an unchanged-config retry can rebuild its owner",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeLifecycleDriver;
        const closing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let held = false;
        const id = ProviderInstanceId.make("registry_retirement_cancel");
        const entry: ProviderInstanceConfig = {
          driver: fixture.driver.driverKind,
          config: { binaryPath: "original" },
        };
        const driver: typeof fixture.driver = {
          ...fixture.driver,
          create: (input) =>
            Effect.gen(function* () {
              const instance = yield* fixture.driver.create(input);
              if (!held) {
                held = true;
                yield* Effect.addFinalizer(() =>
                  Deferred.succeed(closing, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                );
              }
              return instance;
            }),
        };
        yield* Effect.gen(function* () {
          const { registry, mutator } = yield* makeProviderInstanceRegistry({
            drivers: [driver],
            configMap: { [id]: entry },
          });
          const original = (yield* registry.getInstance(id))!;
          const retirement = yield* mutator.reconcile({}).pipe(Effect.forkChild);
          yield* Deferred.await(closing);
          // startImmediately dispatches the real interruption before returning;
          // its join remains blocked on the exact masked old-owner cleanup.
          const cancellation = yield* Fiber.interrupt(retirement).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          const retry = yield* mutator
            .reconcile({ [id]: entry })
            .pipe(Effect.forkChild({ startImmediately: true }));
          expect(yield* registry.getInstance(id)).toBeUndefined();
          expect(yield* registry.listInstances).toEqual([]);
          expect(fixture.counters.created).toBe(1);
          expect(fixture.counters.closed).toBe(0);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(cancellation);
          expect(Exit.isFailure(yield* Fiber.await(retirement))).toBe(true);
          yield* Fiber.join(retry);
          expect(fixture.counters.created).toBe(2);
          expect(fixture.counters.closed).toBe(1);
          expect(yield* registry.getInstance(id)).not.toBe(original);
          expect(yield* registry.listInstances).toHaveLength(1);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      }),
  );

  it.effect(
    "cleans all unpublished creates before cancellation releases the reconcile permit",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeLifecycleDriver;
        const created = yield* Deferred.make<void>();
        const creationGate = yield* Deferred.make<void>();
        const cleanupStarted = yield* Deferred.make<void>();
        const cleanupGate = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const firstId = ProviderInstanceId.make("registry_provisional_first");
        const secondId = ProviderInstanceId.make("registry_provisional_second");
        let held = false;
        const driver: typeof fixture.driver = {
          ...fixture.driver,
          create: (input) =>
            Effect.gen(function* () {
              const instance = yield* fixture.driver.create(input);
              if (input.instanceId === secondId && !held) {
                held = true;
                yield* Effect.addFinalizer(() =>
                  Deferred.succeed(cleanupStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(cleanupGate)),
                  ),
                );
                // Install cancellation observation before publishing readiness:
                // Deferred completion can synchronously resume the cancelling test.
                yield* Deferred.succeed(created, undefined).pipe(
                  Effect.andThen(Deferred.await(creationGate)),
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                );
              }
              return instance;
            }),
        };
        const configMap: ProviderInstanceConfigMap = {
          [firstId]: { driver: driver.driverKind },
          [secondId]: { driver: driver.driverKind },
        };
        yield* Effect.gen(function* () {
          const { registry, mutator } = yield* makeProviderInstanceRegistry({
            drivers: [driver],
            configMap: {},
          });
          const pending = yield* mutator.reconcile(configMap).pipe(Effect.forkChild);
          yield* Deferred.await(created);
          expect(fixture.counters.created).toBe(2);
          expect(yield* registry.listInstances).toEqual([]);
          const cancellation = yield* Fiber.interrupt(pending).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(interrupted);
          yield* Deferred.await(cleanupStarted);
          // The first complete create was never published either. Its scope has
          // already closed; the later partial create is still joining cleanup.
          expect(fixture.counters.closed).toBe(1);
          const retry = yield* mutator
            .reconcile(configMap)
            .pipe(Effect.forkChild({ startImmediately: true }));
          expect(fixture.counters.created).toBe(2);
          expect(yield* registry.getInstance(firstId)).toBeUndefined();
          expect(yield* registry.getInstance(secondId)).toBeUndefined();
          yield* Deferred.succeed(cleanupGate, undefined);
          yield* Fiber.join(cancellation);
          expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true);
          yield* Fiber.join(retry);
          expect(fixture.counters.created).toBe(4);
          expect(fixture.counters.closed).toBe(2);
          expect((yield* registry.listInstances).map((instance) => instance.instanceId)).toEqual([
            firstId,
            secondId,
          ]);
        }).pipe(
          Effect.ensuring(
            Deferred.succeed(creationGate, undefined).pipe(
              Effect.andThen(Deferred.succeed(cleanupGate, undefined)),
            ),
          ),
        );
      }),
  );

  it.effect("refuses an unpublished create that finishes after its registry parent closes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeLifecycleDriver;
      const ownerScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
      const created = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const id = ProviderInstanceId.make("registry_shutdown_create");
      const driver: typeof fixture.driver = {
        ...fixture.driver,
        create: (input) =>
          Effect.gen(function* () {
            const instance = yield* fixture.driver.create(input);
            yield* Deferred.succeed(created, undefined);
            yield* Deferred.await(release);
            return instance;
          }),
      };
      const configMap: ProviderInstanceConfigMap = { [id]: { driver: driver.driverKind } };
      yield* Effect.gen(function* () {
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: {},
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        // This caller is test-owned, not a worker in the registry's child scope.
        // Closing the registry therefore must refuse its later local adoption.
        const pending = yield* mutator.reconcile(configMap).pipe(Effect.forkChild);
        yield* Deferred.await(created);
        expect(fixture.counters.created).toBe(1);
        expect(yield* registry.listInstances).toEqual([]);
        yield* Scope.close(ownerScope, Exit.void);
        expect(fixture.counters.closed).toBe(1);
        yield* Deferred.succeed(release, undefined);
        expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true);
        expect(yield* registry.getInstance(id)).toBeUndefined();
        expect(yield* registry.listInstances).toEqual([]);
        expect(Exit.isFailure(yield* Effect.exit(mutator.reconcile(configMap)))).toBe(true);
        expect(fixture.counters.created).toBe(1);
        expect(fixture.counters.closed).toBe(1);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    }),
  );

  for (const phase of ["published", "provisional"] as const) {
    it.effect(`never treats a defective ${phase} cleanup as a successful closed-scope retry`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeLifecycleDriver;
        const ownerScope = yield* Scope.make();
        // This exact synthetic owner's deliberately defective finalizer must
        // be observed, not leak a defect into the enclosing test's teardown.
        yield* Effect.addFinalizer(() =>
          Scope.close(ownerScope, Exit.void).pipe(Effect.exit, Effect.asVoid),
        );
        let cleanupCalls = 0;
        const driver: typeof fixture.driver = {
          ...fixture.driver,
          create: (input) =>
            Effect.gen(function* () {
              const instance = yield* fixture.driver.create(input);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  cleanupCalls += 1;
                }).pipe(
                  Effect.andThen(Effect.die(new Error("Synthetic exact-owner cleanup failure"))),
                ),
              );
              if (phase === "provisional") yield* Effect.die(new Error("Synthetic create failure"));
              return instance;
            }),
        };
        const id = ProviderInstanceId.make("registry_cleanup_refusal");
        const entry: ProviderInstanceConfig = {
          driver: driver.driverKind,
          config: { binaryPath: "original" },
        };
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: phase === "published" ? { [id]: entry } : {},
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const desired: ProviderInstanceConfigMap = {
          [id]: { ...entry, config: { binaryPath: "replacement" } },
        };
        expect(Exit.isFailure(yield* Effect.exit(mutator.reconcile(desired)))).toBe(true);
        expect(yield* registry.getInstance(id)).toBeUndefined();
        expect(yield* registry.listInstances).toEqual([]);
        expect(fixture.counters.created).toBe(1);
        expect(cleanupCalls).toBe(1);
        // Both the attempted replacement and the original saved envelope must
        // remain refused. Scope.closed alone cannot qualify physical teardown.
        for (const retry of [desired, { [id]: entry }, {}]) {
          expect(Exit.isFailure(yield* Effect.exit(mutator.reconcile(retry)))).toBe(true);
          expect(fixture.counters.created).toBe(1);
          expect(cleanupCalls).toBe(1);
          expect(yield* registry.listInstances).toEqual([]);
        }
      }),
    );
  }
});

describe("ProviderInstanceRegistryLive — multi-instance codex slice", () => {
  // `ServerConfig.layerTest` needs `FileSystem` to materialize its scratch
  // directory. `Layer.merge` just unions requirements, so we have to push
  // `NodeServices.layer` through `Layer.provideMerge` to satisfy that
  // dependency while still surfacing NodeServices to the test body (the
  // codex driver's `create` yields `ChildProcessSpawner` directly).
  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-test",
  }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  );

  it.live("boots two independent codex instances from a ProviderInstanceConfigMap", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const personalId = ProviderInstanceId.make("codex_personal");
      const workId = ProviderInstanceId.make("codex_work");
      const codexDriverKind = ProviderDriverKind.make("codex");

      const configMap: ProviderInstanceConfigMap = {
        [personalId]: {
          driver: codexDriverKind,
          displayName: "Codex (personal)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-personal/bin/codex",
            homePath: "/home/julius/.codex_personal",
            customModels: ["personal-preview"],
          }),
        },
        [workId]: {
          driver: codexDriverKind,
          displayName: "Codex (work)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-work/bin/codex",
            homePath: "/home/julius/.codex",
            customModels: ["work-preview"],
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instances = yield* registry.listInstances;
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [personalId, workId].toSorted(),
      );
      expect(instances.every((instance) => instance.driverKind === codexDriverKind)).toBe(true);
      expect(instances.map((instance) => instance.displayName).toSorted()).toEqual(
        ["Codex (personal)", "Codex (work)"].toSorted(),
      );

      // Each instance must be retrievable by id and carry its *own* closures.
      const personal = yield* registry.getInstance(personalId);
      const work = yield* registry.getInstance(workId);
      expect(personal).toBeDefined();
      expect(work).toBeDefined();
      expect(personal!.adapter).not.toBe(work!.adapter);
      expect(personal!.textGeneration).not.toBe(work!.textGeneration);
      expect(personal!.snapshot).not.toBe(work!.snapshot);

      // Snapshots identify themselves by instanceId + driver — this is
      // what makes per-instance routing distinguishable downstream.
      const personalSnapshot = yield* personal!.snapshot.getSnapshot;
      expect(personalSnapshot.instanceId).toBe(personalId);
      expect(personalSnapshot.driver).toBe(codexDriverKind);
      expect(personalSnapshot.enabled).toBe(false);
      expect(personalSnapshot.continuation?.groupKey).toBe(
        `codex:home:${path.resolve("/home/julius/.codex_personal")}`,
      );

      const workSnapshot = yield* work!.snapshot.getSnapshot;
      expect(workSnapshot.instanceId).toBe(workId);
      expect(workSnapshot.driver).toBe(codexDriverKind);
      expect(workSnapshot.enabled).toBe(false);
      expect(workSnapshot.continuation?.groupKey).toBe(
        `codex:home:${path.resolve("/home/julius/.codex")}`,
      );

      // Nothing goes to the unavailable bucket — both drivers are registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const codexId = ProviderInstanceId.make("codex_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: makeCodexConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [CodexDriver],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(codexId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.provide(testLayer)),
  );
});

describe("ProviderInstanceRegistryLive — all drivers slice", () => {
  // The shipped drivers need `NodeServices` (ChildProcessSpawner + FileSystem
  // + Path). Every instance is disabled, so status checks short-circuit before
  // spawning real provider binaries.
  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-all-drivers-test",
  }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  );

  it.live("boots one instance of every shipped driver from a single config map", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const codexId = ProviderInstanceId.make("codex_default");
      const claudeId = ProviderInstanceId.make("claude_default");

      const codexDriverKind = ProviderDriverKind.make("codex");
      const claudeDriverKind = ProviderDriverKind.make("claudeAgent");

      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: codexDriverKind,
          displayName: "Codex",
          enabled: false,
          config: makeCodexConfig({ homePath: "/home/julius/.codex" }),
        },
        [claudeId]: {
          driver: claudeDriverKind,
          displayName: "Claude",
          enabled: false,
          config: makeClaudeConfig({
            homePath: "/home/julius/.claude-work",
            launchArgs: "--verbose",
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver, ClaudeDriver],
        configMap,
      });

      // Every configured instance must materialize — none downgraded to a
      // shadow snapshot, because every driver in the map is registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);

      const instances = yield* registry.listInstances;
      expect(instances).toHaveLength(2);
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [codexId, claudeId].toSorted(),
      );

      // Instance lookup by id resolves each instance to its own bundle —
      // this is how rest-of-server routes turn/session calls in the new
      // model. Each driver's bundle carries its advertised `driverKind`.
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      expect(codex?.driverKind).toBe(codexDriverKind);
      expect(claude?.driverKind).toBe(claudeDriverKind);
      expect(codex?.displayName).toBe("Codex");
      expect(claude?.displayName).toBe("Claude");

      // Every instance owns its own set of closures — no sharing across
      // drivers. `adapter` / `textGeneration` / `snapshot` are all distinct
      // references, so routing can safely key by provider instance.
      const adapters = [codex!.adapter, claude!.adapter];
      expect(new Set(adapters).size).toBe(adapters.length);
      const textGenerations = [codex!.textGeneration, claude!.textGeneration];
      expect(new Set(textGenerations).size).toBe(textGenerations.length);
      const snapshots = [codex!.snapshot, claude!.snapshot];
      expect(new Set(snapshots).size).toBe(snapshots.length);

      // Snapshots identify themselves by `instanceId` + `driver` so
      // downstream aggregation in `ProviderRegistry` can tell instances
      // apart even when two share a driver. With `enabled: false`, the
      // check short-circuits and we get a disabled/pending snapshot back
      // — that's enough signal to validate the stamping wrapper without
      // spawning real binaries.
      const codexSnapshot = yield* codex!.snapshot.getSnapshot;
      expect(codexSnapshot.instanceId).toBe(codexId);
      expect(codexSnapshot.driver).toBe(codexDriverKind);
      expect(codexSnapshot.enabled).toBe(false);
      expect(codexSnapshot.continuation?.groupKey).toBe(
        `codex:home:${path.resolve("/home/julius/.codex")}`,
      );
      expect(codexSnapshot.runtimeCapabilities?.liveSteer).toBe("supported");

      const claudeSnapshot = yield* claude!.snapshot.getSnapshot;
      expect(claudeSnapshot.instanceId).toBe(claudeId);
      expect(claudeSnapshot.driver).toBe(claudeDriverKind);
      expect(claudeSnapshot.enabled).toBe(false);
      expect(claudeSnapshot.continuation?.groupKey).toBe(
        `claude:home:${path.resolve("/home/julius/.claude-work")}`,
      );
      // The renderer reads this snapshot capability when deciding whether a
      // running-turn follow-up is safe to steer. It cannot see the adapter's
      // private capability object, so both surfaces must agree even for the
      // initial disabled/pending snapshot before a CLI probe has completed.
      expect(claudeSnapshot.runtimeCapabilities?.liveSteer).toBe("supported");
      expect(claude!.adapter.capabilities.liveSteer).toBe("supported");
    }).pipe(Effect.provide(testLayer)),
  );
});
