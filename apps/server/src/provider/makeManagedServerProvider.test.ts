import { describe, it, assert } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cafecode/contracts";
import { createModelCapabilities } from "@cafecode/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeManagedServerProvider } from "./makeManagedServerProvider.ts";
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
});
