import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDetailSubscriptionRegistry } from "../../orchestration/Services/ThreadDetailSubscriptionRegistry.ts";
import { reconcileStoppedRuntimeSessions } from "../../persistence/RuntimeSessionReconciliation.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const threadDetailSubscriptionRegistry = yield* ThreadDetailSubscriptionRegistry;
    const sql = yield* SqlClient.SqlClient;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const reconcileStoppedRuntimeProjection = reconcileStoppedRuntimeSessions.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.reaper.reconcile-stopped-runtime-failed", {
          cause,
        }),
      ),
    );

    const sweep = Effect.gen(function* () {
      yield* reconcileStoppedRuntimeProjection;

      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            provider: binding.provider,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        let reapReason = "inactivity_threshold";
        let noSubscriberDurationMs: number | null = null;
        if (String(binding.provider) === "codex") {
          const subscription = yield* threadDetailSubscriptionRegistry.snapshot(binding.threadId);
          if (subscription.subscriberCount > 0) {
            yield* Effect.logDebug("provider.session.reaper.skipped-codex-subscribed", {
              threadId: binding.threadId,
              subscriberCount: subscription.subscriberCount,
              idleDurationMs,
            });
            continue;
          }

          const noSubscribersSinceMs = subscription.noSubscribersSinceMs ?? now;
          noSubscriberDurationMs = now - noSubscribersSinceMs;
          const unloadEligibleAtMs =
            Math.max(lastSeenMs, noSubscribersSinceMs) + inactivityThresholdMs;

          // Upstream Codex app-server unloads TUI sessions only after both
          // conditions have been true for the unload window: no subscribers
          // and no thread activity. It computes the target as
          // max(no_subscribers_since, inactive_since) + THREAD_UNLOADING_DELAY.
          // Cafe's persisted `lastSeenAt` is the closest backend-side
          // equivalent of app-server thread activity, so Codex sessions use
          // that same two-clock gate instead of the generic provider reaper.
          if (now < unloadEligibleAtMs) {
            yield* Effect.logDebug("provider.session.reaper.skipped-codex-unload-window", {
              threadId: binding.threadId,
              idleDurationMs,
              noSubscriberDurationMs,
              unloadEligibleInMs: unloadEligibleAtMs - now,
            });
            continue;
          }

          reapReason = "codex_no_subscribers_inactive_threshold";
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              noSubscriberDurationMs,
              reason: reapReason,
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        // Repair stale projection state synchronously during startup so a
        // renderer reconnect cannot observe a stopped provider process as an
        // indefinitely running turn.
        yield* reconcileStoppedRuntimeProjection;
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      runSweepOnce: sweep,
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
