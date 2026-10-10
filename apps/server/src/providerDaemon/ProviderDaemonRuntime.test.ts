import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderDaemonHealth,
  PROVIDER_DAEMON_HEALTH_PATH,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import nodePath from "node:path";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";

import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { supportsSubagentConcurrency } from "../provider/Drivers/SubagentConcurrency.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../provider/Layers/ProviderEventLoggers.ts";
import { ProviderInstanceRegistryMutableLayer } from "../provider/Layers/ProviderInstanceRegistryLive.ts";
import { INITIAL_PROVIDER_REFRESH_CONCURRENCY } from "../provider/Layers/ProviderRegistry.ts";
import { makeManagedServerProvider } from "../provider/makeManagedServerProvider.ts";
import type { ProviderDriver } from "../provider/ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../provider/providerMaintenance.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../provider/Services/ProviderInstanceRegistryMutator.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderDaemonLocalRuntimeLive } from "./ProviderDaemonRuntime.ts";
import { runProviderDaemonServer } from "./ProviderDaemonServer.ts";
import { ProviderRuntimeInventory } from "./ProviderRuntimeInventory.ts";
import { requestProviderDaemonCapabilities } from "./RemoteProviderService.ts";

const SyntheticConfig = Schema.Struct({
  version: Schema.NullOr(Schema.String),
  fail: Schema.Boolean,
});
type SyntheticConfig = typeof SyntheticConfig.Type;
const decodeProviderDaemonHealth = Schema.decodeUnknownSync(ProviderDaemonHealth);

interface ProbeRecord {
  readonly instanceId: ProviderInstanceId;
  readonly version: string | null;
  readonly probed: Deferred.Deferred<void>;
  observedVersion: string | null;
  calls: number;
  snapshotReads: number;
}

/**
 * These synthetic drivers use the production managed-snapshot admission and
 * native-version qualification policy. Every inference/session mutation dies
 * immediately; no provider executable, credential, profile, or prompt is used.
 */
const makeFixture = (
  configMap: ProviderInstanceConfigMap,
  gated = false,
  setupDefectAfterBoot = false,
  earlyListDefect = false,
) =>
  Effect.gen(function* () {
    const records: ProbeRecord[] = [];
    const admittedTwo = yield* Deferred.make<void>();
    const releaseProbes = yield* Deferred.make<void>();
    let active = 0;
    let maximumActive = 0;
    let totalStarted = 0;
    let registryBuilds = 0;
    let forbiddenCalls = 0;
    let stopAllCalls = 0;
    let capabilityReads = 0;
    let nextProbeGate: Deferred.Deferred<void> | undefined;

    const unexpected = (operation: string) =>
      Effect.sync(() => {
        forbiddenCalls += 1;
      }).pipe(Effect.andThen(Effect.die(`Unexpected synthetic provider operation: ${operation}`)));

    const makeDriver = (kind: "codex" | "claudeAgent"): ProviderDriver<SyntheticConfig> => ({
      driverKind: ProviderDriverKind.make(kind),
      metadata: { displayName: `Synthetic ${kind}` },
      configSchema: SyntheticConfig,
      defaultConfig: () => ({ version: null, fail: false }),
      create: ({ instanceId, displayName, enabled, config }) =>
        Effect.gen(function* () {
          const record: ProbeRecord = {
            instanceId,
            version: config.version,
            probed: yield* Deferred.make<void>(),
            observedVersion: null,
            calls: 0,
            snapshotReads: 0,
          };
          records.push(record);
          const pending: ServerProvider = {
            instanceId,
            driver: ProviderDriverKind.make(kind),
            enabled,
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            checkedAt: "2026-10-10T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          };
          const snapshot = yield* makeManagedServerProvider({
            maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
              provider: ProviderDriverKind.make(kind),
              packageName: null,
            }),
            getSettings: Effect.succeed(config),
            streamSettings: Stream.never,
            haveSettingsChanged: () => false,
            initialSnapshot: () => Effect.succeed(pending),
            checkProvider: Effect.gen(function* () {
              active += 1;
              maximumActive = Math.max(maximumActive, active);
              totalStarted += 1;
              record.calls += 1;
              if (totalStarted === INITIAL_PROVIDER_REFRESH_CONCURRENCY) {
                yield* Deferred.succeed(admittedTwo, undefined);
              }
              if (gated) yield* Deferred.await(releaseProbes);
              const replacementGate = nextProbeGate;
              nextProbeGate = undefined;
              if (replacementGate) yield* Deferred.await(replacementGate);
              if (config.fail) return yield* Effect.die("Synthetic bounded probe failure");
              record.observedVersion = config.version;
              yield* Deferred.succeed(record.probed, undefined);
              return {
                ...pending,
                version: config.version,
                status: config.version === null ? "warning" : "ready",
                auth: { status: "authenticated" },
                checkedAt: "2026-10-10T00:00:01.000Z",
              } satisfies ServerProvider;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  active -= 1;
                }),
              ),
            ),
            refreshInterval: "5 minutes",
            probePolicy: { initialRefresh: "external" },
          }).pipe(Effect.orDie);
          return {
            instanceId,
            driverKind: ProviderDriverKind.make(kind),
            continuationIdentity: {
              driverKind: ProviderDriverKind.make(kind),
              continuationKey: `synthetic:${kind}:${instanceId}`,
            },
            displayName,
            enabled,
            snapshot: {
              ...snapshot,
              getSnapshot: Effect.suspend(() => {
                record.snapshotReads += 1;
                // The first read is the real boot fallback. Defect during the
                // next background setup read before the refresh foreach, so the
                // fixture exercises the outer pass-failure boundary itself.
                return setupDefectAfterBoot && record.snapshotReads > 1
                  ? Effect.die("synthetic-private-setup-defect-marker")
                  : snapshot.getSnapshot;
              }),
            },
            adapter: {
              provider: ProviderDriverKind.make(kind),
              capabilities: {
                get subagentConcurrency() {
                  capabilityReads += 1;
                  return supportsSubagentConcurrency(kind, record.observedVersion);
                },
                sessionModelSwitch: "in-session",
                liveSteer: "supported",
              },
              startSession: () => unexpected("startSession"),
              sendTurn: () => unexpected("sendTurn"),
              steerTurn: () => unexpected("steerTurn"),
              interruptTurn: () => unexpected("interruptTurn"),
              respondToRequest: () => unexpected("respondToRequest"),
              respondToUserInput: () => unexpected("respondToUserInput"),
              stopSession: () => unexpected("stopSession"),
              readThread: () => unexpected("readThread"),
              rollbackThread: () => unexpected("rollbackThread"),
              listSessions: () => Effect.succeed([]),
              hasSession: () => Effect.succeed(false),
              stopAll: () =>
                Effect.sync(() => {
                  // The real ProviderService finalizer invokes this only when
                  // its test-owned scope closes; qualification must not do so.
                  stopAllCalls += 1;
                }),
              streamEvents: Stream.never,
            },
            textGeneration: {
              generateCommitMessage: () => unexpected("generateCommitMessage"),
              generatePrContent: () => unexpected("generatePrContent"),
              generateBranchName: () => unexpected("generateBranchName"),
              generateThreadTitle: () => unexpected("generateThreadTitle"),
              generateThreadMetadata: () => unexpected("generateThreadMetadata"),
            },
          };
        }),
    });

    const instanceLayerBase = Layer.effectDiscard(
      Effect.sync(() => {
        registryBuilds += 1;
      }),
    ).pipe(
      Layer.provideMerge(
        ProviderInstanceRegistryMutableLayer({
          drivers: [makeDriver("codex"), makeDriver("claudeAgent")],
          configMap,
        }),
      ),
    );
    const instanceLayer = earlyListDefect
      ? Layer.effectContext(
          Effect.gen(function* () {
            const registry = yield* ProviderInstanceRegistry;
            const mutator = yield* ProviderInstanceRegistryMutator;
            return Context.make(ProviderInstanceRegistry, {
              ...registry,
              // Fail the background pass's first enumeration before it can
              // append discovered instances to the per-pass admission set.
              listUnavailable: Effect.die("synthetic-private-early-list-defect-marker"),
            }).pipe(Context.add(ProviderInstanceRegistryMutator, mutator));
          }),
        ).pipe(Layer.provide(instanceLayerBase))
      : instanceLayerBase;

    return {
      records,
      admittedTwo,
      releaseProbes,
      instanceLayer,
      holdNextProbe: (gate: Deferred.Deferred<void>) => {
        nextProbeGate = gate;
      },
      get counts() {
        return {
          active,
          maximumActive,
          totalStarted,
          registryBuilds,
          forbiddenCalls,
          stopAllCalls,
          capabilityReads,
        };
      },
    };
  });

/**
 * Exercise the exported production service/inventory graph, replacing only its
 * configured drivers and outer infrastructure with scoped, credential-free
 * fixtures. The tracked filesystem refuses to hide second-owner cache reads or
 * writes, including reads that would return a correlated legacy snapshot.
 */
const makeRuntimeLayer = (fixture: Effect.Success<ReturnType<typeof makeFixture>>) =>
  Effect.gen(function* () {
    const infrastructure = yield* Layer.build(
      ServerConfig.layerTest(process.cwd(), { prefix: "cafe-daemon-owner-admission-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const fs = Context.get(infrastructure, FileSystem.FileSystem);
    const config = Context.get(infrastructure, ServerConfig);
    const cacheCalls: string[] = [];
    const recordCacheCall = (operation: string, path: string) => {
      if (
        path === config.providerStatusCacheDir ||
        path.startsWith(`${config.providerStatusCacheDir}${nodePath.sep}`)
      ) {
        cacheCalls.push(operation);
      }
    };
    const trackedFs: FileSystem.FileSystem = {
      ...fs,
      exists: (path) => {
        recordCacheCall("exists", path);
        return fs.exists(path);
      },
      readFileString: (path, ...args) => {
        recordCacheCall("readFileString", path);
        return fs.readFileString(path, ...args);
      },
      makeDirectory: (path, ...args) => {
        recordCacheCall("makeDirectory", path);
        return fs.makeDirectory(path, ...args);
      },
      writeFileString: (path, ...args) => {
        recordCacheCall("writeFileString", path);
        return fs.writeFileString(path, ...args);
      },
      rename: (from, to) => {
        recordCacheCall("rename", to);
        return fs.rename(from, to);
      },
    };
    const layer = ProviderDaemonLocalRuntimeLive.pipe(
      Layer.provideMerge(fixture.instanceLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, trackedFs)),
      Layer.provideMerge(Layer.succeedContext(infrastructure)),
    );
    return { layer, cacheCalls };
  });

const configMap = (
  entries: ReadonlyArray<{
    readonly id: string;
    readonly kind?: "codex" | "claudeAgent";
    readonly version: string | null;
    readonly fail?: boolean;
  }>,
) =>
  Object.fromEntries(
    entries.map((entry) => [
      ProviderInstanceId.make(entry.id),
      {
        driver: ProviderDriverKind.make(entry.kind ?? "codex"),
        enabled: true,
        config: { version: entry.version, fail: entry.fail ?? false },
      },
    ]),
  ) as ProviderInstanceConfigMap;

describe("ProviderDaemonLocalRuntimeLive", () => {
  it.effect(
    "returns the exact owner-observed capability over authenticated daemon RPC without dispatching provider work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture(
            configMap([
              { id: "codex_rpc_qualified", version: "0.159.2" },
              { id: "codex_rpc_unknown", version: null },
            ]),
          );
          const { layer, cacheCalls } = yield* makeRuntimeLayer(fixture);
          const runtime = yield* Layer.build(
            layer.pipe(Layer.provideMerge(ServerSettingsService.layerTest())),
          );
          yield* Effect.gen(function* () {
            const token = "synthetic-daemon-owner-capability-test-token-00000000";
            const server = yield* runProviderDaemonServer(
              {
                mode: "provider-daemon",
                transport: "tcp",
                host: "127.0.0.1",
                port: 0,
                token,
                version: "0.0.0-test",
              },
              { platform: "linux" },
            );
            assert.isNumber(server.port);
            const endpoint = {
              transport: "tcp" as const,
              httpBaseUrl: `http://127.0.0.1:${server.port!}`,
              token,
            };
            assert.strictEqual(
              (yield* requestProviderDaemonCapabilities(
                endpoint,
                ProviderInstanceId.make("codex_rpc_qualified"),
              )).subagentConcurrency,
              true,
            );
            assert.strictEqual(
              (yield* requestProviderDaemonCapabilities(
                endpoint,
                ProviderInstanceId.make("codex_rpc_unknown"),
              )).subagentConcurrency,
              false,
            );
            assert.strictEqual(fixture.counts.totalStarted, 2);
            assert.strictEqual(fixture.counts.registryBuilds, 1);
            assert.strictEqual(fixture.counts.forbiddenCalls, 0);
            assert.strictEqual(fixture.counts.stopAllCalls, 0);
            assert.deepStrictEqual(cacheCalls, []);
          }).pipe(Effect.provideContext(runtime));
        }),
      ),
  );

  it.effect(
    "awaits one shared two-wide owner admission and never reads or writes backend status cache",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const entries = [
            { id: "codex_qualified", version: "0.159.2" },
            { id: "codex_old", version: "0.158.9" },
            { id: "codex_unknown", version: null },
            { id: "codex_failed", version: "0.159.2", fail: true },
            { id: "codex_prerelease", version: "0.159.2-alpha.1" },
            { id: "claude_qualified", kind: "claudeAgent" as const, version: "2.1.217" },
          ];
          const fixture = yield* makeFixture(configMap(entries), true);
          const { layer, cacheCalls } = yield* makeRuntimeLayer(fixture);
          const runtime = yield* Layer.build(
            layer.pipe(Layer.provideMerge(ServerSettingsService.layerTest())),
          );
          yield* Deferred.await(fixture.admittedTwo);
          const service = Context.get(runtime, ProviderService);
          const inventory = Context.get(runtime, ProviderRuntimeInventory);
          const token = "synthetic-daemon-background-readiness-token-0000000000";
          const endpoint = yield* Effect.gen(function* () {
            const server = yield* runProviderDaemonServer(
              {
                mode: "provider-daemon",
                transport: "tcp",
                host: "127.0.0.1",
                port: 0,
                token,
                version: "0.0.0-test",
              },
              { platform: "linux" },
            );
            assert.isNumber(server.port);
            return {
              transport: "tcp" as const,
              httpBaseUrl: `http://127.0.0.1:${server.port!}`,
              token,
            };
          }).pipe(Effect.provideContext(runtime));
          const pendingHealthResponse = yield* Effect.promise(() =>
            requestProviderDaemonJson(endpoint, PROVIDER_DAEMON_HEALTH_PATH),
          );
          assert.strictEqual(pendingHealthResponse.statusCode, 200);
          const pendingHealth = decodeProviderDaemonHealth(JSON.parse(pendingHealthResponse.body));
          assert.deepStrictEqual(pendingHealth.providerQualification, {
            versionKnownCount: 0,
            versionUnknownCount: entries.length,
            pendingCount: entries.length,
          });
          const capabilityReturned = yield* Deferred.make<void>();
          const pendingCapability = yield* requestProviderDaemonCapabilities(
            endpoint,
            ProviderInstanceId.make("codex_qualified"),
          ).pipe(
            Effect.tap(() => Deferred.succeed(capabilityReturned, undefined)),
            Effect.forkChild,
          );
          const cancelledWaiter = yield* service
            .getCapabilities(ProviderInstanceId.make("codex_qualified"))
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(cancelledWaiter);
          // External managed providers cannot bypass the queue through their own
          // timers, even while a long admission keeps all service callers waiting.
          yield* TestClock.adjust("20 minutes");
          assert.strictEqual(fixture.counts.totalStarted, INITIAL_PROVIDER_REFRESH_CONCURRENCY);
          assert.strictEqual(fixture.counts.maximumActive, INITIAL_PROVIDER_REFRESH_CONCURRENCY);
          assert.strictEqual(fixture.counts.registryBuilds, 1);
          assert.strictEqual(fixture.records.length, entries.length);
          assert.isTrue(fixture.records.every((record) => record.observedVersion === null));
          assert.isFalse(yield* Deferred.isDone(capabilityReturned));
          yield* Deferred.succeed(fixture.releaseProbes, undefined);
          assert.strictEqual((yield* Fiber.join(pendingCapability)).subagentConcurrency, true);
          assert.strictEqual((yield* inventory.snapshot).configuredInstanceCount, entries.length);
          for (const entry of entries) {
            const actual = yield* service.getCapabilities(ProviderInstanceId.make(entry.id));
            assert.strictEqual(
              actual.subagentConcurrency,
              entry.id === "codex_qualified" || entry.id === "claude_qualified",
            );
            assert.strictEqual(actual.sessionModelSwitch, "in-session");
            assert.strictEqual(actual.liveSteer, "supported");
          }
          assert.strictEqual(fixture.counts.totalStarted, entries.length);
          assert.isTrue(fixture.records.every((record) => record.calls === 1));
          assert.strictEqual(fixture.counts.forbiddenCalls, 0);
          assert.strictEqual(fixture.counts.stopAllCalls, 0);
          assert.deepStrictEqual(cacheCalls, []);
          const qualifiedHealthResponse = yield* Effect.promise(() =>
            requestProviderDaemonJson(endpoint, PROVIDER_DAEMON_HEALTH_PATH),
          );
          const qualifiedHealth = decodeProviderDaemonHealth(
            JSON.parse(qualifiedHealthResponse.body),
          );
          assert.deepStrictEqual(qualifiedHealth.providerQualification, {
            versionKnownCount: 4,
            versionUnknownCount: 2,
            // The deliberate unchecked probe defect never publishes a completed
            // lastOutcome. Admission still settles unknown/false; health reports
            // the managed owner's received diagnostic instead of inventing one.
            pendingCount: 1,
          });
        }),
      ),
  );

  it.effect(
    "retains default-only/no-op owner identity and qualifies replacement versions without borrowing another account",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const original = configMap([
            { id: "codex_exact_owner", version: "0.159.2" },
            { id: "codex_other_owner", version: "0.159.2" },
          ]);
          const fixture = yield* makeFixture(original);
          const { layer, cacheCalls } = yield* makeRuntimeLayer(fixture);
          const runtime = yield* Layer.build(layer);
          const registry = Context.get(runtime, ProviderInstanceRegistry);
          const mutator = Context.get(runtime, ProviderInstanceRegistryMutator);
          const service = Context.get(runtime, ProviderService);
          const exactId = ProviderInstanceId.make("codex_exact_owner");
          const otherId = ProviderInstanceId.make("codex_other_owner");
          assert.strictEqual((yield* service.getCapabilities(exactId)).subagentConcurrency, true);
          assert.strictEqual((yield* service.getCapabilities(otherId)).subagentConcurrency, true);
          const exact = yield* registry.getInstance(exactId);
          const other = yield* registry.getInstance(otherId);
          yield* mutator.reconcile(original);
          yield* mutator.reconcile({
            ...original,
            [exactId]: {
              ...original[exactId]!,
              defaultMaxConcurrentSubagents: 15,
            },
          });
          for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
          assert.strictEqual(yield* registry.getInstance(exactId), exact);
          assert.strictEqual(yield* registry.getInstance(otherId), other);
          assert.strictEqual(fixture.records.length, 2);
          assert.strictEqual(fixture.counts.totalStarted, 2);

          const replacementMap = configMap([
            { id: "codex_exact_owner", version: null },
            { id: "codex_other_owner", version: "0.159.2" },
          ]);
          const replacementGate = yield* Deferred.make<void>();
          fixture.holdNextProbe(replacementGate);
          yield* mutator.reconcile(replacementMap);
          const replacement = fixture.records.at(-1)!;
          const replacementReturned = yield* Deferred.make<void>();
          const replacementCapability = yield* service.getCapabilities(exactId).pipe(
            Effect.tap(() => Deferred.succeed(replacementReturned, undefined)),
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          assert.isFalse(yield* Deferred.isDone(replacementReturned));
          // The other account remains usable while this replacement is pending.
          assert.strictEqual((yield* service.getCapabilities(otherId)).subagentConcurrency, true);
          yield* Deferred.succeed(replacementGate, undefined);
          yield* Deferred.await(replacement.probed);
          assert.strictEqual((yield* Fiber.join(replacementCapability)).subagentConcurrency, false);
          assert.notStrictEqual(yield* registry.getInstance(exactId), exact);
          assert.strictEqual(yield* registry.getInstance(otherId), other);
          assert.strictEqual((yield* service.getCapabilities(exactId)).subagentConcurrency, false);
          assert.strictEqual((yield* service.getCapabilities(otherId)).subagentConcurrency, true);
          assert.strictEqual(replacement.calls, 1);
          assert.strictEqual(fixture.counts.registryBuilds, 1);
          assert.strictEqual(fixture.counts.forbiddenCalls, 0);
          assert.strictEqual(fixture.counts.stopAllCalls, 0);
          assert.deepStrictEqual(cacheCalls, []);
        }),
      ),
  );

  it.effect(
    "fails incomplete owner setup finitely without reading capability getters or hiding health readiness",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const exactId = ProviderInstanceId.make("codex_setup_failure");
          const fixture = yield* makeFixture(
            configMap([{ id: exactId, version: "0.159.2" }]),
            false,
            true,
          );
          const { layer, cacheCalls } = yield* makeRuntimeLayer(fixture);
          const runtime = yield* Layer.build(
            layer.pipe(Layer.provideMerge(ServerSettingsService.layerTest())),
          );
          const service = Context.get(runtime, ProviderService);
          const mutator = Context.get(runtime, ProviderInstanceRegistryMutator);
          for (let index = 0; index < 2; index += 1) {
            const failure = yield* service.getCapabilities(exactId).pipe(Effect.flip);
            assert.strictEqual(failure._tag, "ProviderAdapterRequestError");
            assert.strictEqual(
              failure.message,
              "Provider adapter request failed (codex) for getCapabilities: Provider runtime capability qualification did not complete.",
            );
            assert.notInclude(failure.message, "synthetic-private-setup-defect-marker");
            assert.isUndefined(failure.cause);
          }
          assert.strictEqual(fixture.counts.capabilityReads, 0);
          assert.strictEqual(fixture.counts.totalStarted, 0);
          const health = yield* Effect.gen(function* () {
            const token = "synthetic-daemon-setup-failure-health-token-0000000000";
            const server = yield* runProviderDaemonServer(
              {
                mode: "provider-daemon",
                transport: "tcp",
                host: "127.0.0.1",
                port: 0,
                token,
                version: "0.0.0-test",
              },
              { platform: "linux" },
            );
            const endpoint = {
              transport: "tcp" as const,
              httpBaseUrl: `http://127.0.0.1:${server.port!}`,
              token,
            };
            const remoteFailure = yield* requestProviderDaemonCapabilities(endpoint, exactId).pipe(
              Effect.flip,
            );
            assert.strictEqual(remoteFailure._tag, "ProviderAdapterRequestError");
            assert.include(
              remoteFailure.message,
              "Provider runtime capability qualification did not complete.",
            );
            assert.notInclude(remoteFailure.message, "synthetic-private-setup-defect-marker");
            assert.strictEqual(fixture.counts.capabilityReads, 0);
            const response = yield* Effect.promise(() =>
              requestProviderDaemonJson(endpoint, PROVIDER_DAEMON_HEALTH_PATH),
            );
            assert.strictEqual(response.statusCode, 200);
            assert.notInclude(response.body, "synthetic-private-setup-defect-marker");
            return decodeProviderDaemonHealth(JSON.parse(response.body));
          }).pipe(Effect.provideContext(runtime));
          assert.deepStrictEqual(health.providerQualification, {
            versionKnownCount: 0,
            versionUnknownCount: 1,
            pendingCount: 1,
          });
          // A new exact generation gets a fresh barrier and its own probe; the
          // failed predecessor neither grants support nor poisons its successor.
          yield* mutator.reconcile(configMap([{ id: exactId, version: "0.159.3" }]));
          assert.strictEqual((yield* service.getCapabilities(exactId)).subagentConcurrency, true);
          assert.strictEqual(fixture.records.length, 2);
          assert.strictEqual(fixture.counts.totalStarted, 1);
          assert.strictEqual(fixture.counts.forbiddenCalls, 0);
          assert.strictEqual(fixture.counts.stopAllCalls, 0);
          assert.deepStrictEqual(cacheCalls, []);
        }),
      ),
  );

  it.effect(
    "fails boot-generation waiters finitely when owner enumeration defects before admission collection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const exactId = ProviderInstanceId.make("codex_early_list_failure");
          const fixture = yield* makeFixture(
            configMap([{ id: exactId, version: "0.159.2" }]),
            false,
            false,
            true,
          );
          const { layer, cacheCalls } = yield* makeRuntimeLayer(fixture);
          const runtime = yield* Layer.build(layer);
          const service = Context.get(runtime, ProviderService);
          const inventory = Context.get(runtime, ProviderRuntimeInventory);
          for (let index = 0; index < 2; index += 1) {
            const failure = yield* service.getCapabilities(exactId).pipe(Effect.flip);
            assert.strictEqual(failure._tag, "ProviderAdapterRequestError");
            assert.strictEqual(
              failure.message,
              "Provider adapter request failed (codex) for getCapabilities: Provider runtime capability qualification did not complete.",
            );
            assert.isUndefined(failure.cause);
            assert.notInclude(failure.message, "synthetic-private-early-list-defect-marker");
          }
          assert.deepStrictEqual((yield* inventory.snapshot).providerQualification, {
            versionKnownCount: 0,
            versionUnknownCount: 1,
            pendingCount: 1,
          });
          assert.strictEqual(fixture.counts.capabilityReads, 0);
          assert.strictEqual(fixture.counts.totalStarted, 0);
          assert.strictEqual(fixture.counts.registryBuilds, 1);
          assert.strictEqual(fixture.counts.forbiddenCalls, 0);
          assert.strictEqual(fixture.counts.stopAllCalls, 0);
          assert.deepStrictEqual(cacheCalls, []);
        }),
      ),
  );

  it.effect(
    "wakes a pending old-generation capability reader when its exact account is removed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const exactId = ProviderInstanceId.make("codex_pending_removal");
          const fixture = yield* makeFixture(configMap([{ id: exactId, version: "0.159.2" }]));
          const { layer, cacheCalls } = yield* makeRuntimeLayer(fixture);
          const runtime = yield* Layer.build(layer);
          const service = Context.get(runtime, ProviderService);
          const mutator = Context.get(runtime, ProviderInstanceRegistryMutator);
          assert.strictEqual((yield* service.getCapabilities(exactId)).subagentConcurrency, true);
          const replacementGate = yield* Deferred.make<void>();
          fixture.holdNextProbe(replacementGate);
          yield* mutator.reconcile(configMap([{ id: exactId, version: null }]));
          yield* Deferred.await(fixture.admittedTwo);
          const removedReturned = yield* Deferred.make<void>();
          const pendingReader = yield* service.getCapabilities(exactId).pipe(
            Effect.flip,
            Effect.tap(() => Deferred.succeed(removedReturned, undefined)),
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          assert.isFalse(yield* Deferred.isDone(removedReturned));
          const readsBeforeRemoval = fixture.counts.capabilityReads;
          yield* mutator.reconcile({});
          const failure = yield* Fiber.join(pendingReader);
          assert.strictEqual(failure._tag, "ProviderUnsupportedError");
          assert.strictEqual(fixture.counts.capabilityReads, readsBeforeRemoval);
          yield* Deferred.succeed(replacementGate, undefined);
          assert.strictEqual(fixture.records.length, 2);
          assert.strictEqual(fixture.counts.totalStarted, 2);
          assert.strictEqual(fixture.counts.forbiddenCalls, 0);
          assert.strictEqual(fixture.counts.stopAllCalls, 0);
          assert.deepStrictEqual(cacheCalls, []);
        }),
      ),
  );

  it.effect(
    "releases the managed owner periodic clock only after its admitted initial refresh",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture(
            configMap([{ id: "codex_periodic", version: "0.159.2" }]),
          );
          const { layer, cacheCalls } = yield* makeRuntimeLayer(fixture);
          const runtime = yield* Layer.build(layer);
          const registry = Context.get(runtime, ProviderInstanceRegistry);
          const service = Context.get(runtime, ProviderService);
          yield* service.getCapabilities(ProviderInstanceId.make("codex_periodic"));
          const instance = yield* registry.getInstance(ProviderInstanceId.make("codex_periodic"));
          assert.isDefined(instance);
          const snapshot = yield* instance!.snapshot.getSnapshot;
          const scheduled = snapshot.probeDiagnostics?.nextScheduledAt;
          assert.isString(scheduled);
          const untilScheduled = Date.parse(scheduled!) - (yield* Clock.currentTimeMillis);
          assert.isAtLeast(untilScheduled, 300_000);
          assert.strictEqual(fixture.counts.totalStarted, 1);
          yield* TestClock.adjust(`${untilScheduled - 1} millis`);
          assert.strictEqual(fixture.counts.totalStarted, 1);
          yield* TestClock.adjust("1 millis");
          for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
          assert.strictEqual(fixture.counts.totalStarted, 2);
          assert.strictEqual(fixture.counts.forbiddenCalls, 0);
          assert.strictEqual(fixture.counts.stopAllCalls, 0);
          assert.deepStrictEqual(cacheCalls, []);
        }),
      ),
  );
});
