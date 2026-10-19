import { describe, it, assert } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cafecode/contracts";
import { createModelCapabilities } from "@cafecode/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  makeManagedServerProvider,
  retainNativeCodexModelCatalog,
} from "./makeManagedServerProvider.ts";
import { deterministicProviderProbePhaseOffsetMs } from "./providerProbePolicy.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });
const fastModeCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

interface TestSettings {
  readonly enabled: boolean;
}

const maintenanceCapabilities = {
  provider: ProviderDriverKind.make("codex"),
  packageName: "@openai/codex",
  update: {
    command: "npm install -g @openai/codex@latest",

    executable: "npm",

    args: ["install", "-g", "@openai/codex@latest"],

    lockKey: "npm-global",
  },
} as const;

const initialSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  message: "Checking provider availability...",
  models: [],
  slashCommands: [],
  skills: [],
};

const refreshedSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const enrichedSnapshot: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:02.000Z",
  models: [
    {
      slug: "composer-2",
      name: "Composer 2",
      isCustom: false,
      capabilities: fastModeCapabilities,
    },
  ],
};

const refreshedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:03.000Z",
  message: "Refreshed provider availability again.",
};

const refreshedAccountRateLimits = {
  rateLimits: {
    primary: {
      usedPercent: 35,
      windowDurationMins: 300,
      resetsAt: 1_780_000_000,
    },
    secondary: {
      usedPercent: 60,
      windowDurationMins: 10_080,
      resetsAt: 1_780_100_000,
    },
  },
  checkedAt: "2026-04-10T00:00:05.000Z",
} as const;

const enrichedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshotSecond,
  checkedAt: "2026-04-10T00:00:04.000Z",
  models: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: emptyCapabilities,
    },
  ],
};

describe("makeManagedServerProvider", () => {
  it.effect("observes credentials afresh after an older probe that overlaps native login", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let checks = 0;
      const provider = yield* makeManagedServerProvider<TestSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed({ enabled: true }),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: () => Effect.succeed(initialSnapshot),
        checkProvider: Effect.suspend(() => {
          checks++;
          return checks === 1
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(initialSnapshot),
              )
            : Effect.succeed(refreshedSnapshot);
        }),
        refreshInterval: "1 hour",
      });
      yield* Deferred.await(entered);
      const afterLogin = yield* Effect.forkChild(provider.refreshAfterAccountChange!, {
        startImmediately: true,
      });
      yield* Deferred.succeed(release, undefined);
      const snapshot = yield* Fiber.join(afterLogin);
      assert.strictEqual(snapshot.auth.status, "authenticated");
      assert.strictEqual(checks, 2);
    }),
  );
  it("never retains native catalogues using missing, changed, or foreign owner metadata", () => {
    const native: ServerProvider = {
      ...refreshedSnapshot,
      auth: { status: "authenticated", type: "chatgpt", email: "owner@example.test" },
      codexModelCatalogSource: "native",
      models: enrichedSnapshotSecond.models,
    };
    const fallback: ServerProvider = {
      ...native,
      codexModelCatalogSource: "fallback",
      models: enrichedSnapshot.models,
    };
    const { codexModelCatalogSource: _legacySource, ...legacyFallback } = fallback;
    for (const next of [
      {
        ...fallback,
        auth: { status: "authenticated", type: "chatgpt", email: "other@example.test" },
      },
      { ...fallback, auth: { status: "authenticated", type: "chatgpt" } },
      { ...fallback, auth: { status: "authenticated", email: "owner@example.test" } },
      {
        ...fallback,
        auth: { status: "authenticated", type: "apiKey", email: "owner@example.test" },
      },
      { ...fallback, auth: { status: "unknown" } },
      { ...fallback, auth: { status: "unauthenticated" } },
      { ...fallback, instanceId: ProviderInstanceId.make("codex_other") },
      { ...fallback, driver: ProviderDriverKind.make("externalDriver") },
      legacyFallback,
    ] satisfies ReadonlyArray<ServerProvider>) {
      assert.strictEqual(retainNativeCodexModelCatalog(native, next), next);
    }
    const unidentifiedFallback: ServerProvider = { ...fallback, auth: { status: "authenticated" } };
    // Two omitted identities are not matching identities.
    assert.strictEqual(
      retainNativeCodexModelCatalog(
        { ...native, auth: { status: "authenticated" } },
        unidentifiedFallback,
      ),
      unidentifiedFallback,
    );
  });
  it("derives stable, distributed periodic phases from public instance ids", () => {
    const intervalMs = 300_000;
    const codexPhase = deterministicProviderProbePhaseOffsetMs(
      ProviderInstanceId.make("codex"),
      intervalMs,
    );
    const workPhase = deterministicProviderProbePhaseOffsetMs(
      ProviderInstanceId.make("codex_work"),
      intervalMs,
    );
    const claudePhase = deterministicProviderProbePhaseOffsetMs(
      ProviderInstanceId.make("claudeAgent"),
      intervalMs,
    );

    assert.strictEqual(
      codexPhase,
      deterministicProviderProbePhaseOffsetMs(ProviderInstanceId.make("codex"), intervalMs),
    );
    assert.isAtLeast(codexPhase, 0);
    assert.isBelow(codexPhase, intervalMs);
    assert.notStrictEqual(codexPhase, workPhase);
    assert.notStrictEqual(codexPhase, claudePhase);
    assert.notStrictEqual(workPhase, claudePhase);
  });

  it.effect("lets the registry own initial refresh admission and records redacted timing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "5 minutes",
          probePolicy: { initialRefresh: "external" },
        });

        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 0);
        const pending = yield* provider.getSnapshot;
        assert.strictEqual(pending.probeDiagnostics?.attemptCount, 0);
        assert.strictEqual(pending.probeDiagnostics?.lastOutcome, "pending");
        assert.strictEqual(pending.probeDiagnostics?.periodicIntervalMs, 300_000);
        assert.isNumber(pending.probeDiagnostics?.periodicPhaseOffsetMs);
        assert.isNull(pending.probeDiagnostics?.nextScheduledAt);

        const refreshed = yield* provider.refresh;
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
        assert.strictEqual(refreshed.probeDiagnostics?.attemptCount, 1);
        assert.strictEqual(refreshed.probeDiagnostics?.lastOutcome, "ready");
        assert.strictEqual(refreshed.probeDiagnostics?.consecutiveInconclusiveCount, 0);
        assert.strictEqual(refreshed.probeDiagnostics?.lastDurationMs, 0);
        assert.isString(refreshed.probeDiagnostics?.nextScheduledAt);
        assert.strictEqual(
          (yield* provider.getSnapshot).probeDiagnostics?.nextScheduledAt,
          refreshed.probeDiagnostics?.nextScheduledAt,
        );
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("starts periodic probing only after external admission and the instance phase", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const intervalMs = 1_000;
        const phaseOffsetMs = deterministicProviderProbePhaseOffsetMs(
          initialSnapshot.instanceId,
          intervalMs,
        );
        const checkCalls = yield* Ref.make(0);
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "1 second",
          probePolicy: { initialRefresh: "external" },
        });

        yield* Effect.yieldNow;
        // Even a pathologically long registry queue cannot be bypassed by the
        // construction-relative periodic timer.
        yield* TestClock.adjust(`${intervalMs * 10 + phaseOffsetMs} millis`);
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 0);

        yield* provider.refresh;
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
        yield* TestClock.adjust(`${intervalMs + phaseOffsetMs - 1} millis`);
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 1);

        yield* TestClock.adjust("1 millis");
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
        assert.strictEqual(
          (yield* provider.getSnapshot).probeDiagnostics?.periodicPhaseOffsetMs,
          phaseOffsetMs,
        );
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("skips missed fixed-rate slots when a probe exceeds its interval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const intervalMs = 1_000;
        const phaseOffsetMs = deterministicProviderProbePhaseOffsetMs(
          initialSnapshot.instanceId,
          intervalMs,
        );
        const checkCalls = yield* Ref.make(0);
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.succeed(refreshedSnapshot)
                : Effect.sleep("1500 millis").pipe(Effect.as(refreshedSnapshot)),
            ),
          ),
          refreshInterval: "1 second",
          probePolicy: { initialRefresh: "external" },
        });
        assert.isNull((yield* provider.getSnapshot).probeDiagnostics?.nextScheduledAt);
        yield* provider.refresh;
        yield* Effect.yieldNow;
        const pending = yield* provider.getSnapshot;
        const firstScheduledAtMs = Date.parse(
          pending.probeDiagnostics?.nextScheduledAt ?? "invalid",
        );
        assert.isTrue(Number.isFinite(firstScheduledAtMs));
        assert.strictEqual(yield* Ref.get(checkCalls), 1);

        yield* TestClock.adjust(`${intervalMs + phaseOffsetMs} millis`);
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 2);

        yield* TestClock.adjust("1500 millis");
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
        assert.strictEqual(
          (yield* provider.getSnapshot).probeDiagnostics?.nextScheduledAt,
          new Date(firstScheduledAtMs + intervalMs * 2).toISOString(),
        );

        yield* TestClock.adjust("499 millis");
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
        yield* TestClock.adjust("1 millis");
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 3);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect(
    "retains conclusive auth for two inconclusive probes, degrades on the third, and resets",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const inconclusiveSnapshot: ServerProvider = {
            ...refreshedSnapshot,
            checkedAt: "2026-04-10T00:00:05.000Z",
            status: "warning",
            auth: { status: "unknown" },
            message: "probe timed out",
          };
          const snapshots = [
            refreshedSnapshot,
            inconclusiveSnapshot,
            inconclusiveSnapshot,
            inconclusiveSnapshot,
            refreshedSnapshotSecond,
          ];
          let index = 0;
          const provider = yield* makeManagedServerProvider<TestSettings>({
            maintenanceCapabilities,
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Effect.sync(() => snapshots[index++] ?? refreshedSnapshotSecond),
            refreshInterval: null,
            probePolicy: {
              initialRefresh: "external",
              isInconclusiveSnapshot: (snapshot) => snapshot.message === "probe timed out",
              inconclusiveFailureThreshold: 3,
            },
          });

          const healthy = yield* provider.refresh;
          assert.strictEqual(healthy.status, "ready");
          assert.strictEqual(healthy.auth.status, "authenticated");
          yield* Effect.yieldNow;

          const firstTimeout = yield* provider.refresh;
          assert.strictEqual(firstTimeout.status, "ready");
          assert.strictEqual(firstTimeout.auth.status, "authenticated");
          assert.strictEqual(firstTimeout.checkedAt, refreshedSnapshot.checkedAt);
          assert.isUndefined(firstTimeout.message);
          assert.strictEqual(firstTimeout.probeDiagnostics?.lastOutcome, "inconclusive");
          assert.strictEqual(firstTimeout.probeDiagnostics?.consecutiveInconclusiveCount, 1);
          yield* Effect.yieldNow;

          const secondTimeout = yield* provider.refresh;
          assert.strictEqual(secondTimeout.status, "ready");
          assert.strictEqual(secondTimeout.auth.status, "authenticated");
          assert.strictEqual(secondTimeout.probeDiagnostics?.consecutiveInconclusiveCount, 2);
          yield* Effect.yieldNow;

          const persistentTimeout = yield* provider.refresh;
          assert.strictEqual(persistentTimeout.status, "warning");
          assert.strictEqual(persistentTimeout.auth.status, "unknown");
          assert.strictEqual(persistentTimeout.message, "probe timed out");
          assert.strictEqual(persistentTimeout.probeDiagnostics?.consecutiveInconclusiveCount, 3);
          yield* Effect.yieldNow;

          const recovered = yield* provider.refresh;
          assert.strictEqual(recovered.status, "ready");
          assert.strictEqual(recovered.auth.status, "authenticated");
          assert.strictEqual(recovered.probeDiagnostics?.lastOutcome, "ready");
          assert.strictEqual(recovered.probeDiagnostics?.consecutiveInconclusiveCount, 0);
          assert.strictEqual(recovered.probeDiagnostics?.attemptCount, 5);
        }),
      ),
  );

  it.effect(
    "runs the initial provider check in the background and streams the refreshed snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const checkCalls = yield* Ref.make(0);
          const releaseCheck = yield* Deferred.make<void>();
          const provider = yield* makeManagedServerProvider<TestSettings>({
            maintenanceCapabilities,
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
              Effect.flatMap(() => Deferred.await(releaseCheck)),
              Effect.as(refreshedSnapshot),
            ),
            refreshInterval: "1 hour",
          });

          const initial = yield* provider.getSnapshot;
          assert.deepStrictEqual(initial, initialSnapshot);

          const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;

          yield* Deferred.succeed(releaseCheck, undefined);

          const updates = Array.from(yield* Fiber.join(updatesFiber));
          const latest = yield* provider.getSnapshot;

          assert.deepStrictEqual(updates, [refreshedSnapshot]);
          assert.deepStrictEqual(latest, refreshedSnapshot);
          assert.strictEqual(yield* Ref.get(checkCalls), 1);
        }),
      ),
  );

  it.effect("reruns the provider check when streamed settings change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsRef = yield* Ref.make<TestSettings>({ enabled: true });
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const releaseSettingsCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Ref.get(settingsRef),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(releaseInitialCheck).pipe(Effect.as(refreshedSnapshot))
                : Deferred.await(releaseSettingsCheck).pipe(Effect.as(refreshedSnapshotSecond)),
            ),
          ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseInitialCheck, undefined);
        yield* Ref.set(settingsRef, { enabled: false });
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Deferred.succeed(releaseSettingsCheck, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, refreshedSnapshotSecond]);
        assert.deepStrictEqual(latest, refreshedSnapshotSecond);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ),
  );

  it.effect("streams supplemental snapshot updates after the base provider check completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseEnrichment = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Deferred.await(releaseCheck).pipe(Effect.as(refreshedSnapshot)),
          enrichSnapshot: ({ publishSnapshot }) =>
            Deferred.await(releaseEnrichment).pipe(
              Effect.flatMap(() => publishSnapshot(enrichedSnapshot)),
            ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseCheck, undefined);

        yield* Deferred.succeed(releaseEnrichment, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, enrichedSnapshot]);
        assert.deepStrictEqual(latest, enrichedSnapshot);
      }),
    ),
  );

  it.effect("ignores stale enrichment callbacks after a newer refresh advances generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const publishCallbacks: Array<(snapshot: ServerProvider) => Effect.Effect<void>> = [];
        const refreshCount = yield* Ref.make(0);
        const firstCallbackReady = yield* Deferred.make<void>();
        const secondCallbackReady = yield* Deferred.make<void>();
        const allowFirstRefresh = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(refreshCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(allowFirstRefresh).pipe(Effect.as(refreshedSnapshot))
                : Effect.succeed(refreshedSnapshotSecond),
            ),
          ),
          enrichSnapshot: ({ publishSnapshot }) =>
            Effect.gen(function* () {
              publishCallbacks.push(publishSnapshot);
              if (publishCallbacks.length === 1) {
                yield* Deferred.succeed(firstCallbackReady, undefined).pipe(Effect.ignore);
              } else if (publishCallbacks.length === 2) {
                yield* Deferred.succeed(secondCallbackReady, undefined).pipe(Effect.ignore);
              }
            }),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(allowFirstRefresh, undefined);
        yield* Deferred.await(firstCallbackReady);

        yield* provider.refresh;
        yield* Deferred.await(secondCallbackReady);

        yield* publishCallbacks[0]!(enrichedSnapshot);
        yield* publishCallbacks[1]!(enrichedSnapshotSecond);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [
          refreshedSnapshot,
          refreshedSnapshotSecond,
          enrichedSnapshotSecond,
        ]);
        assert.deepStrictEqual(latest, enrichedSnapshotSecond);
      }),
    ),
  );

  it.effect("can disable periodic refresh while preserving manual refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckStarted = yield* Deferred.make<void>();
        const releaseInitialCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap(() => Deferred.succeed(initialCheckStarted, undefined).pipe(Effect.ignore)),
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(releaseInitialCheck).pipe(Effect.as(refreshedSnapshot))
                : Effect.succeed(refreshedSnapshotSecond),
            ),
          ),
          refreshInterval: null,
        });

        yield* Deferred.await(initialCheckStarted);
        assert.strictEqual(yield* Ref.get(checkCalls), 1);

        const initialUpdateFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseInitialCheck, undefined);
        const initialUpdate = yield* Fiber.join(initialUpdateFiber);
        assert.deepStrictEqual(Array.from(initialUpdate), [refreshedSnapshot]);

        yield* TestClock.adjust("2 hours");
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 1);

        const manualRefresh = yield* provider.refresh;
        assert.deepStrictEqual(manualRefresh, refreshedSnapshotSecond);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("coalesces overlapping full refreshes into one provider check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const checkStarted = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
            Effect.tap(() => Deferred.succeed(checkStarted, undefined).pipe(Effect.ignore)),
            Effect.flatMap(() => Deferred.await(releaseCheck)),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "1 hour",
        });

        yield* Deferred.await(checkStarted);
        const refreshes = yield* Effect.all([provider.refresh, provider.refresh], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        // The initial background probe owns the single flight. Both manual
        // callers wait on it instead of queueing two more CLI checks behind it.
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
        yield* Deferred.succeed(releaseCheck, undefined);

        assert.deepStrictEqual(yield* Fiber.join(refreshes), [
          refreshedSnapshot,
          refreshedSnapshot,
        ]);
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ),
  );

  it.effect("coalesces usage-only refreshes without rerunning the full provider check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const usageCalls = yield* Ref.make(0);
        const usageStarted = yield* Deferred.make<void>();
        const releaseUsage = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap(() => Deferred.await(releaseInitialCheck)),
            Effect.as(refreshedSnapshot),
          ),
          refreshAccountUsage: () =>
            Ref.update(usageCalls, (count) => count + 1).pipe(
              Effect.tap(() => Deferred.succeed(usageStarted, undefined).pipe(Effect.ignore)),
              Effect.flatMap(() => Deferred.await(releaseUsage)),
              Effect.as(refreshedAccountRateLimits),
            ),
          refreshInterval: "1 hour",
        });

        const initialUpdate = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseInitialCheck, undefined);
        yield* Fiber.join(initialUpdate);

        const refreshAccountUsage = provider.refreshAccountUsage;
        assert.isDefined(refreshAccountUsage);
        if (!refreshAccountUsage) {
          return;
        }

        const usageRefreshes = yield* Effect.all([refreshAccountUsage, refreshAccountUsage], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(usageStarted);

        assert.strictEqual(yield* Ref.get(checkCalls), 1);
        assert.strictEqual(yield* Ref.get(usageCalls), 1);
        yield* Deferred.succeed(releaseUsage, undefined);

        const refreshed = yield* Fiber.join(usageRefreshes);
        assert.deepStrictEqual(refreshed, [
          { ...refreshedSnapshot, accountRateLimits: refreshedAccountRateLimits },
          { ...refreshedSnapshot, accountRateLimits: refreshedAccountRateLimits },
        ]);
        assert.strictEqual((yield* provider.getSnapshot).version, refreshedSnapshot.version);
        assert.deepStrictEqual(
          (yield* provider.getSnapshot).accountRateLimits,
          refreshedAccountRateLimits,
        );
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ),
  );

  it.effect("coalesces model-only refreshes and preserves health metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const modelCalls = yield* Ref.make(0);
        const modelsStarted = yield* Deferred.make<void>();
        const releaseModels = yield* Deferred.make<void>();
        const refreshedModels: ServerProvider["models"] = [
          {
            slug: "gpt-picker-refresh",
            name: "GPT Picker Refresh",
            isCustom: false,
            capabilities: emptyCapabilities,
          },
        ];
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap(() => Deferred.await(releaseInitialCheck)),
            Effect.as(refreshedSnapshot),
          ),
          refreshModels: () =>
            Ref.update(modelCalls, (count) => count + 1).pipe(
              Effect.tap(() => Deferred.succeed(modelsStarted, undefined).pipe(Effect.ignore)),
              Effect.flatMap(() => Deferred.await(releaseModels)),
              Effect.as(refreshedModels),
            ),
          refreshInterval: "1 hour",
        });

        const initialUpdate = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseInitialCheck, undefined);
        yield* Fiber.join(initialUpdate);

        const refreshModels = provider.refreshModels;
        assert.isDefined(refreshModels);
        if (!refreshModels) {
          return;
        }

        const refreshes = yield* Effect.all([refreshModels, refreshModels], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(modelsStarted);
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
        assert.strictEqual(yield* Ref.get(modelCalls), 1);
        yield* Deferred.succeed(releaseModels, undefined);

        const results = yield* Fiber.join(refreshes);
        assert.deepStrictEqual(
          results.map((snapshot) => snapshot.models),
          [refreshedModels, refreshedModels],
        );
        const latest = yield* provider.getSnapshot;
        assert.deepStrictEqual(latest.models, refreshedModels);
        assert.strictEqual(latest.codexModelCatalogSource, "native");
        assert.strictEqual(latest.version, refreshedSnapshot.version);
        assert.deepStrictEqual(latest.auth, refreshedSnapshot.auth);
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ),
  );

  for (const models of [enrichedSnapshotSecond.models, []] satisfies ReadonlyArray<
    ServerProvider["models"]
  >) {
    it.effect(
      `qualifies ${models.length === 0 ? "empty" : "identical"} native models before equality and retains them through same-account health`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fallback: ServerProvider = {
              ...refreshedSnapshot,
              auth: { status: "authenticated", type: "chatgpt", email: "owner@example.test" },
              codexModelCatalogSource: "fallback",
              models,
            };
            const healthCalls = yield* Ref.make(0);
            const modelCalls = yield* Ref.make(0);
            const provider = yield* makeManagedServerProvider<TestSettings>({
              maintenanceCapabilities,
              getSettings: Effect.succeed({ enabled: true }),
              streamSettings: Stream.never,
              haveSettingsChanged: () => false,
              initialSnapshot: () => Effect.succeed(fallback),
              checkProvider: Ref.update(healthCalls, (count) => count + 1).pipe(
                Effect.as({ ...fallback, models: enrichedSnapshot.models }),
              ),
              refreshModels: () =>
                Ref.update(modelCalls, (count) => count + 1).pipe(Effect.as(models)),
              refreshInterval: null,
              probePolicy: { initialRefresh: "external" },
            });
            assert.strictEqual(
              (yield* provider.getCurrentSnapshot!).codexModelCatalogSource,
              "fallback",
            );
            const native = yield* provider.refreshModels!;
            assert.strictEqual(native.codexModelCatalogSource, "native");
            assert.deepStrictEqual(native.models, models);
            assert.strictEqual(yield* Ref.get(healthCalls), 0);
            assert.strictEqual(yield* Ref.get(modelCalls), 1);
            const health = yield* provider.refresh;
            assert.strictEqual(health.codexModelCatalogSource, "native");
            assert.deepStrictEqual(health.models, models);
            assert.strictEqual(yield* Ref.get(healthCalls), 1);
          }),
        ),
    );
  }

  it.effect("does not stamp native provenance for an undefined or failed model refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const fail of [false, true]) {
          const fallback: ServerProvider = {
            ...refreshedSnapshot,
            codexModelCatalogSource: "fallback",
            models: enrichedSnapshotSecond.models,
          };
          const provider = yield* makeManagedServerProvider<TestSettings>({
            maintenanceCapabilities,
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.never,
            haveSettingsChanged: () => false,
            initialSnapshot: () => Effect.succeed(fallback),
            checkProvider: Effect.succeed(fallback),
            refreshModels: () =>
              fail ? Effect.die(new Error("synthetic model failure")) : Effect.succeed(undefined),
            refreshInterval: null,
            probePolicy: { initialRefresh: "external" },
          });
          const admitted = yield* provider.getCurrentSnapshot!;
          const result = yield* Effect.exit(provider.refreshModels!);
          assert.strictEqual(Exit.isFailure(result), fail);
          assert.strictEqual(yield* provider.getCurrentSnapshot!, admitted);
        }
      }),
    ),
  );

  it.effect("does not grant Codex provenance to another driver's successful model refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const foreign: ServerProvider = {
          ...refreshedSnapshot,
          driver: ProviderDriverKind.make("externalDriver"),
        };
        const provider = yield* makeManagedServerProvider<TestSettings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.never,
          haveSettingsChanged: () => false,
          initialSnapshot: () => Effect.succeed(foreign),
          checkProvider: Effect.succeed(foreign),
          refreshModels: () => Effect.succeed(enrichedSnapshot.models),
          refreshInterval: null,
          probePolicy: { initialRefresh: "external" },
        });
        const refreshed = yield* provider.refreshModels!;
        assert.deepStrictEqual(refreshed.models, enrichedSnapshot.models);
        assert.strictEqual(refreshed.codexModelCatalogSource, undefined);
      }),
    ),
  );

  it.effect(
    "rejects an old enrichment callback after native empty discovery changes the managed generation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fallback: ServerProvider = {
            ...refreshedSnapshot,
            auth: { status: "authenticated", type: "chatgpt", email: "owner@example.test" },
            codexModelCatalogSource: "fallback",
            models: enrichedSnapshot.models,
          };
          const callbacks: Array<(snapshot: ServerProvider) => Effect.Effect<void>> = [];
          const firstReady = yield* Deferred.make<void>();
          const secondReady = yield* Deferred.make<void>();
          const modelsStarted = yield* Deferred.make<void>();
          const releaseModels = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(releaseModels, undefined).pipe(Effect.ignore),
          );
          const provider = yield* makeManagedServerProvider<TestSettings>({
            maintenanceCapabilities,
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.never,
            haveSettingsChanged: () => false,
            initialSnapshot: () => Effect.succeed(fallback),
            checkProvider: Effect.succeed(fallback),
            refreshModels: () =>
              Deferred.succeed(modelsStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseModels)),
                Effect.as([]),
              ),
            enrichSnapshot: ({ publishSnapshot }) =>
              Effect.gen(function* () {
                callbacks.push(publishSnapshot);
                yield* Deferred.succeed(
                  callbacks.length === 1 ? firstReady : secondReady,
                  undefined,
                );
              }),
            refreshInterval: null,
            probePolicy: { initialRefresh: "external" },
          });
          yield* provider.refresh;
          yield* Deferred.await(firstReady);
          const refresh = yield* provider.refreshModels!.pipe(Effect.forkChild);
          yield* Deferred.await(modelsStarted);
          yield* callbacks[0]!({ ...fallback, version: "0.162.2" });
          yield* Deferred.succeed(releaseModels, undefined);
          const native = yield* Fiber.join(refresh);
          yield* Deferred.await(secondReady);
          assert.strictEqual(callbacks.length, 2);
          yield* callbacks[0]!(fallback);
          const current = yield* provider.getCurrentSnapshot!;
          assert.strictEqual(current.codexModelCatalogSource, "native");
          assert.strictEqual(current.version, "0.162.2");
          assert.deepStrictEqual(current.models, []);
          assert.strictEqual(current, native);
        }),
      ),
  );

  it.effect(
    "discards a held model result when its settings change without reading or probing from the inert accessor",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const settings = yield* Ref.make<TestSettings>({ enabled: true });
          const settingsReads = yield* Ref.make(0);
          const healthCalls = yield* Ref.make(0);
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(release, undefined).pipe(Effect.ignore),
          );
          const fallback: ServerProvider = {
            ...refreshedSnapshot,
            codexModelCatalogSource: "fallback",
          };
          const provider = yield* makeManagedServerProvider<TestSettings>({
            maintenanceCapabilities,
            getSettings: Ref.update(settingsReads, (count) => count + 1).pipe(
              Effect.andThen(Ref.get(settings)),
            ),
            streamSettings: Stream.never,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(fallback),
            checkProvider: Ref.update(healthCalls, (count) => count + 1).pipe(
              Effect.as(initialSnapshot),
            ),
            refreshModels: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(enrichedSnapshot.models),
              ),
            refreshInterval: null,
            probePolicy: { initialRefresh: "external" },
          });
          const admitted = yield* provider.getCurrentSnapshot!;
          const refresh = yield* provider.refreshModels!.pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Ref.set(settings, { enabled: false });
          const beforeReads = yield* Ref.get(settingsReads);
          assert.strictEqual(yield* provider.getCurrentSnapshot!, admitted);
          assert.strictEqual(yield* Ref.get(settingsReads), beforeReads);
          assert.strictEqual(yield* Ref.get(healthCalls), 0);
          yield* Deferred.succeed(release, undefined);
          assert.strictEqual(yield* Fiber.join(refresh), admitted);
          assert.strictEqual(yield* provider.getCurrentSnapshot!, admitted);
          assert.strictEqual(yield* Ref.get(healthCalls), 0);
        }),
      ),
  );

  it.effect(
    "completes a model waiter admitted after scope closure without invoking the provider",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const modelCalls = yield* Ref.make(0);
          const fallback: ServerProvider = {
            ...refreshedSnapshot,
            codexModelCatalogSource: "fallback",
          };
          const provider = yield* makeManagedServerProvider<TestSettings>({
            maintenanceCapabilities,
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.never,
            haveSettingsChanged: () => false,
            initialSnapshot: () => Effect.succeed(fallback),
            checkProvider: Effect.succeed(fallback),
            refreshModels: () =>
              Ref.update(modelCalls, (count) => count + 1).pipe(Effect.as(enrichedSnapshot.models)),
            refreshInterval: null,
            probePolicy: { initialRefresh: "external" },
          }).pipe(Scope.provide(scope));
          const admitted = yield* provider.getCurrentSnapshot!;
          yield* Scope.close(scope, Exit.void);
          const result = yield* Effect.exit(provider.refreshModels!);
          assert.isTrue(Exit.isFailure(result));
          assert.strictEqual(yield* Ref.get(modelCalls), 0);
          assert.strictEqual(yield* provider.getCurrentSnapshot!, admitted);
        }),
      ),
  );

  it.effect(
    "does not cancel a shared model worker when one caller disconnects and retires the completed flight",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const modelCalls = yield* Ref.make(0);
          const workerInterruptions = yield* Ref.make(0);
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(release, undefined).pipe(Effect.ignore),
          );
          const fallback: ServerProvider = {
            ...refreshedSnapshot,
            codexModelCatalogSource: "fallback",
          };
          const provider = yield* makeManagedServerProvider<TestSettings>({
            maintenanceCapabilities,
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.never,
            haveSettingsChanged: () => false,
            initialSnapshot: () => Effect.succeed(fallback),
            checkProvider: Effect.succeed(fallback),
            refreshModels: () =>
              Ref.update(modelCalls, (count) => count + 1).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.as(enrichedSnapshot.models),
                Effect.onInterrupt(() => Ref.update(workerInterruptions, (count) => count + 1)),
              ),
            refreshInterval: null,
            probePolicy: { initialRefresh: "external" },
          });
          const admitted = yield* provider.getCurrentSnapshot!;
          const disconnected = yield* provider.refreshModels!.pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const survivor = yield* provider.refreshModels!.pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Fiber.interrupt(disconnected);
          assert.isTrue(Exit.isFailure(yield* Fiber.await(disconnected)));
          assert.strictEqual(yield* Ref.get(modelCalls), 1);
          assert.strictEqual(yield* Ref.get(workerInterruptions), 0);
          assert.strictEqual(yield* provider.getCurrentSnapshot!, admitted);
          yield* Deferred.succeed(release, undefined);
          const accepted = yield* Fiber.join(survivor);
          assert.deepStrictEqual(accepted.models, enrichedSnapshot.models);
          assert.strictEqual(accepted.codexModelCatalogSource, "native");
          assert.strictEqual(yield* Ref.get(modelCalls), 1);
          assert.strictEqual(yield* Ref.get(workerInterruptions), 0);
          // A later independent request must not remain attached to a retired
          // Deferred, even when its identical result needs no new publication.
          const next = yield* provider.refreshModels!;
          assert.deepStrictEqual(next.models, enrichedSnapshot.models);
          assert.strictEqual(yield* Ref.get(modelCalls), 2);
          assert.strictEqual(yield* Ref.get(workerInterruptions), 0);
        }),
      ),
  );

  it.effect(
    "does not publish native provenance when the owning scope closes during discovery",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const interruptionObserved = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(release, undefined).pipe(Effect.ignore),
          );
          const fallback: ServerProvider = {
            ...refreshedSnapshot,
            codexModelCatalogSource: "fallback",
          };
          const provider = yield* makeManagedServerProvider<TestSettings>({
            maintenanceCapabilities,
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.never,
            haveSettingsChanged: () => false,
            initialSnapshot: () => Effect.succeed(fallback),
            checkProvider: Effect.succeed(fallback),
            refreshModels: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(enrichedSnapshot.models),
                Effect.onInterrupt(() =>
                  Deferred.succeed(interruptionObserved, undefined).pipe(
                    // The fixture owns this cleanup hold. Scope closure must
                    // request cancellation before the test releases it, then
                    // join the completed cleanup before examining provenance.
                    Effect.andThen(Deferred.await(release)),
                  ),
                ),
              ),
            refreshInterval: null,
            probePolicy: { initialRefresh: "external" },
          }).pipe(Scope.provide(scope));
          const admitted = yield* provider.getCurrentSnapshot!;
          const refresh = yield* Effect.exit(provider.refreshModels!).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const closing = yield* Scope.close(scope, Exit.void).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(interruptionObserved);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(closing);
          assert.isTrue(Exit.isFailure(yield* Fiber.join(refresh)));
          assert.strictEqual(yield* provider.getCurrentSnapshot!, admitted);
        }),
      ),
  );

  it.effect(
    "publishes confirmed reset usage without a health probe and ignores an older delayed read",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const checkCalls = yield* Ref.make(0);
          const provider = yield* makeManagedServerProvider<TestSettings>({
            maintenanceCapabilities,
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: () => false,
            initialSnapshot: () => Effect.succeed(refreshedSnapshot),
            checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
              Effect.as(refreshedSnapshot),
            ),
            probePolicy: { initialRefresh: "external" },
          });
          const fresh = {
            ...refreshedAccountRateLimits,
            checkedAt: "2026-09-09T00:00:01.000Z",
            rateLimitResetCredits: { availableCount: 1 },
          };
          const stale = {
            ...fresh,
            checkedAt: "2026-09-09T00:00:00.000Z",
            rateLimitResetCredits: { availableCount: 2 },
          };
          yield* provider.setAccountUsage!(fresh);
          yield* provider.setAccountUsage!(stale);
          assert.deepStrictEqual((yield* provider.getSnapshot).accountRateLimits, fresh);
          assert.strictEqual(yield* Ref.get(checkCalls), 0);
        }),
      ),
  );
});
