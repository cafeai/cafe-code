/**
 * UsageStatsServiceLive - In-memory usage accumulator with periodic SQLite flush.
 *
 * Building the layer hydrates lifetime counters from `usage_stats_days` and
 * provider/model token attribution from `usage_stats_token_breakdown_days`,
 * forks consumers of the domain-event and provider-runtime streams, and forks
 * a flush loop that accrues in-flight generating time and persists pending
 * per-day deltas every few seconds. A finalizer performs one last
 * accrue-and-flush on shutdown, so a clean stop loses nothing and a hard kill
 * loses at most one flush interval.
 *
 * Counting sources:
 * - user chats: domain `thread.message-sent` events with `role: "user"`.
 * - tokens: `thread.token-usage.updated` snapshots via the watermark helper
 *   (see tokenDelta.ts for the per-provider semantics), with a per-turn
 *   fallback on `turn.completed` for providers that report usage only in the
 *   terminal event.
 * - generating time: per-thread accrual between `turn.started` and the turn's
 *   terminal event, advanced on every flush tick so concurrent sessions each
 *   contribute their own wall clock and long turns split across local days.
 *
 * The `usageStatsEnabled` server setting gates additions only — watermarks
 * and accrual cursors always advance, so toggling collection partitions time
 * and tokens cleanly instead of retroactively counting the disabled period.
 */
import {
  USAGE_STATS_MODEL_MAX_CHARS,
  type OrchestrationEvent,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type UsageStatsTokenBreakdownEntry,
} from "@cafecode/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { UsageStatsRepository } from "../../persistence/Services/UsageStats.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { localDayKey, splitSpanIntoDays } from "../dayBuckets.ts";
import { selectOutputCounter, tokenDelta } from "../tokenDelta.ts";
import { UsageStatsService, type UsageStatsServiceShape } from "../Services/UsageStatsService.ts";

const FLUSH_INTERVAL_MS = 5_000;
const MODEL_RESOLUTION_TIMEOUT_MS = 1_000;
const UNKNOWN_USAGE_MODEL = "unknown";

interface MutableDayTotals {
  generatingMs: number;
  outputTokens: number;
  userMessages: number;
}

interface ThreadTracking {
  watermark: number | undefined;
  /**
   * Whether this process saw the session begin. Session-cumulative token
   * counters observed without it (e.g. after reattaching to a provider
   * daemon) only seed the watermark, so history that predates this process
   * is never recounted.
   */
  witnessedSessionStart: boolean;
  sawTokenUsageThisTurn: boolean;
  /** Set while the thread is generating; advanced on every accrual. */
  accrueFromMs: number | undefined;
  /**
   * Canonical driver only. `providerInstanceId` deliberately never enters
   * usage attribution because instances identify configured accounts.
   */
  provider: ProviderDriverKind | undefined;
  /** Selected/effective model for token deltas observed after this point. */
  model: string | undefined;
  /** Prevents a missing session model from causing a lookup on every token. */
  modelResolutionAttempted: boolean;
}

type PendingTokenBreakdowns = Map<string, Map<ProviderDriverKind, Map<string, number>>>;
type TokenBreakdownTotals = Map<ProviderDriverKind, Map<string, number>>;

/**
 * Best-effort output-token extraction from an opaque `turn.completed` usage
 * payload. Understands camelCase per-turn totals, where
 * `thoughtTokens` is reported separately from `outputTokens`, and Anthropic's
 * snake_case shape, where `output_tokens` already includes thinking.
 */
const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Model names are provider-controlled strings. Keep valid names verbatim for
 * future reporting, but reject empty/oversized values before they become
 * composite SQLite index keys.
 */
function normalizeUsageModel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= USAGE_STATS_MODEL_MAX_CHARS
    ? normalized
    : undefined;
}

function resetAttribution(tracking: ThreadTracking, provider: ProviderDriverKind): void {
  tracking.provider = provider;
  tracking.model = undefined;
  tracking.modelResolutionAttempted = false;
}

function turnCompletedOutputTokens(usage: unknown): number | undefined {
  if (usage === null || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const completionOutput = finiteNumber(record.outputTokens);
  if (completionOutput !== undefined) {
    return Math.round(completionOutput + (finiteNumber(record.thoughtTokens) ?? 0));
  }
  const anthropicOutput = finiteNumber(record.output_tokens);
  return anthropicOutput === undefined ? undefined : Math.round(anthropicOutput);
}

const makeUsageStatsService = Effect.gen(function* () {
  const repository = yield* UsageStatsRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const serverSettings = yield* ServerSettingsService;

  // All state is confined to this closure and mutated only from synchronous
  // sections of the forked consumers below, so no Ref coordination is needed.
  const days = new Map<string, MutableDayTotals>();
  const pending = new Map<string, MutableDayTotals>();
  const pendingTokenBreakdowns: PendingTokenBreakdowns = new Map();
  const tokenBreakdownTotals: TokenBreakdownTotals = new Map();
  const threads = new Map<string, ThreadTracking>();
  const totals: MutableDayTotals = { generatingMs: 0, outputTokens: 0, userMessages: 0 };
  let tokenBreakdownSnapshot: ReadonlyArray<UsageStatsTokenBreakdownEntry> = [];
  let tokenBreakdownSnapshotDirty = true;
  let enabled = true;

  const addTokenBreakdownTotal = (
    provider: ProviderDriverKind,
    model: string,
    outputTokens: number,
  ): void => {
    if (outputTokens <= 0) {
      return;
    }
    let models = tokenBreakdownTotals.get(provider);
    if (models === undefined) {
      models = new Map();
      tokenBreakdownTotals.set(provider, models);
    }
    models.set(model, (models.get(model) ?? 0) + outputTokens);
    tokenBreakdownSnapshotDirty = true;
  };

  /**
   * Materialize the RPC rows only after attribution changes. Usage snapshots
   * are read frequently, while model attribution changes only when a provider
   * reports additional output tokens.
   */
  const readTokenBreakdown = (): ReadonlyArray<UsageStatsTokenBreakdownEntry> => {
    if (!tokenBreakdownSnapshotDirty) {
      return tokenBreakdownSnapshot;
    }
    tokenBreakdownSnapshot = Array.from(tokenBreakdownTotals.entries())
      .flatMap(([provider, models]) =>
        Array.from(models.entries(), ([model, outputTokens]) => ({
          provider,
          model,
          outputTokens,
        })),
      )
      .toSorted((left, right) => {
        if (left.provider !== right.provider) {
          return left.provider < right.provider ? -1 : 1;
        }
        if (left.outputTokens !== right.outputTokens) {
          return right.outputTokens - left.outputTokens;
        }
        return left.model < right.model ? -1 : left.model > right.model ? 1 : 0;
      });
    tokenBreakdownSnapshotDirty = false;
    return tokenBreakdownSnapshot;
  };

  yield* repository.listDays.pipe(
    Effect.map((rows) => {
      for (const row of rows) {
        days.set(row.day, {
          generatingMs: row.generatingMs,
          outputTokens: row.outputTokens,
          userMessages: row.userMessages,
        });
        totals.generatingMs += row.generatingMs;
        totals.outputTokens += row.outputTokens;
        totals.userMessages += row.userMessages;
      }
    }),
    // Hydration failure degrades to session-local counters; flushed deltas
    // remain additive, so the stored history stays intact either way.
    Effect.catch((error) =>
      Effect.logError("usage stats: failed to hydrate day totals", { error }),
    ),
  );

  yield* repository.listTokenBreakdownDays.pipe(
    Effect.map((rows) => {
      for (const row of rows) {
        addTokenBreakdownTotal(row.provider, row.model, row.outputTokens);
      }
    }),
    // Aggregate usage remains useful if only the attribution ledger is
    // damaged. Keep this failure isolated and let current-session rows accrue.
    Effect.catch((error) =>
      Effect.logError("usage stats: failed to hydrate token breakdown", { error }),
    ),
  );

  enabled = yield* serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.usageStatsEnabled),
    Effect.catch(() => Effect.succeed(true)),
  );

  const addDelta = (day: string, delta: Partial<MutableDayTotals>): void => {
    const generatingMs = delta.generatingMs ?? 0;
    const outputTokens = delta.outputTokens ?? 0;
    const userMessages = delta.userMessages ?? 0;
    if (generatingMs <= 0 && outputTokens <= 0 && userMessages <= 0) {
      return;
    }
    for (const bucket of [days, pending]) {
      let entry = bucket.get(day);
      if (entry === undefined) {
        entry = { generatingMs: 0, outputTokens: 0, userMessages: 0 };
        bucket.set(day, entry);
      }
      entry.generatingMs += generatingMs;
      entry.outputTokens += outputTokens;
      entry.userMessages += userMessages;
    }
    totals.generatingMs += generatingMs;
    totals.outputTokens += outputTokens;
    totals.userMessages += userMessages;
  };

  /**
   * Record the same output-token observation in the aggregate and attribution
   * accumulators. The repository later commits both maps atomically.
   */
  const addOutputTokenDelta = (
    day: string,
    outputTokens: number,
    provider: ProviderDriverKind,
    model: string | undefined,
  ): void => {
    if (outputTokens <= 0) {
      return;
    }
    addDelta(day, { outputTokens });

    const modelKey = model ?? UNKNOWN_USAGE_MODEL;
    addTokenBreakdownTotal(provider, modelKey, outputTokens);

    let providers = pendingTokenBreakdowns.get(day);
    if (providers === undefined) {
      providers = new Map();
      pendingTokenBreakdowns.set(day, providers);
    }
    let models = providers.get(provider);
    if (models === undefined) {
      models = new Map();
      providers.set(provider, models);
    }
    models.set(modelKey, (models.get(modelKey) ?? 0) + outputTokens);
  };

  const track = (threadId: string): ThreadTracking => {
    let tracking = threads.get(threadId);
    if (tracking === undefined) {
      tracking = {
        watermark: undefined,
        witnessedSessionStart: false,
        sawTokenUsageThisTurn: false,
        accrueFromMs: undefined,
        provider: undefined,
        model: undefined,
        modelResolutionAttempted: false,
      };
      threads.set(threadId, tracking);
    }
    return tracking;
  };

  /**
   * Resolve a model once for a turn, never once per token. Some adapters put
   * the model directly on `turn.started`; Codex currently does not, so Cafe
   * consults the already-live provider session with a short timeout. Failure
   * degrades to the explicit `unknown` bucket and never blocks accounting or
   * the provider event stream indefinitely.
   */
  const resolveTrackingModel = (
    threadId: string,
    provider: ProviderDriverKind,
    tracking: ThreadTracking,
    explicitModel?: string,
  ): Effect.Effect<void> => {
    tracking.provider = provider;
    const normalizedExplicitModel = normalizeUsageModel(explicitModel);
    if (normalizedExplicitModel !== undefined) {
      tracking.model = normalizedExplicitModel;
      tracking.modelResolutionAttempted = true;
      return Effect.void;
    }
    if (tracking.modelResolutionAttempted) {
      return Effect.void;
    }

    // Mark before yielding so concurrent lifecycle events cannot schedule
    // duplicate all-provider session reads for the same turn.
    tracking.modelResolutionAttempted = true;
    return providerService.listSessions().pipe(
      Effect.timeoutOption(MODEL_RESOLUTION_TIMEOUT_MS),
      Effect.catchCause(() => Effect.succeed(Option.none())),
      Effect.map((sessionsOption) => {
        if (Option.isNone(sessionsOption)) {
          return;
        }
        const session = sessionsOption.value.find(
          (candidate) => candidate.threadId === threadId && candidate.provider === provider,
        );
        tracking.model = normalizeUsageModel(session?.model);
      }),
    );
  };

  /** Credit generating time up to `nowMs` and advance the accrual cursor. */
  const accrue = (tracking: ThreadTracking, nowMs: number): void => {
    if (tracking.accrueFromMs === undefined) {
      return;
    }
    if (enabled) {
      for (const span of splitSpanIntoDays(tracking.accrueFromMs, nowMs)) {
        addDelta(span.day, { generatingMs: span.ms });
      }
    }
    tracking.accrueFromMs = nowMs;
  };

  const handleDomainEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
    if (event.type !== "thread.message-sent" || event.payload.role !== "user" || !enabled) {
      return Effect.void;
    }
    return Effect.map(Clock.currentTimeMillis, (now) => {
      addDelta(localDayKey(now), { userMessages: 1 });
    });
  };

  const handleProviderEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "session.started":
      case "thread.started": {
        const tracking = track(event.threadId);
        tracking.witnessedSessionStart = true;
        resetAttribution(tracking, event.provider);
        return Effect.void;
      }

      case "turn.started": {
        return Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const tracking = track(event.threadId);
          tracking.sawTokenUsageThisTurn = false;
          if (tracking.accrueFromMs === undefined) {
            tracking.accrueFromMs = now;
          }
          resetAttribution(tracking, event.provider);
          yield* resolveTrackingModel(
            event.threadId,
            event.provider,
            tracking,
            event.payload.model,
          );
        });
      }

      case "thread.token-usage.updated": {
        return Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const tracking = track(event.threadId);
          tracking.sawTokenUsageThisTurn = true;
          const counter = selectOutputCounter(event.payload.usage);
          if (counter === undefined) {
            return;
          }
          const countFirstObservation =
            counter.kind === "per-message" || tracking.witnessedSessionStart;
          const result = tokenDelta(tracking.watermark, counter.value, countFirstObservation);
          tracking.watermark = result.watermark;
          if (enabled && result.delta > 0) {
            if (tracking.provider !== event.provider) {
              resetAttribution(tracking, event.provider);
            }
            yield* resolveTrackingModel(event.threadId, event.provider, tracking);
            addOutputTokenDelta(localDayKey(now), result.delta, event.provider, tracking.model);
          }
        });
      }

      case "turn.completed": {
        return Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const tracking = track(event.threadId);
          accrue(tracking, now);
          tracking.accrueFromMs = undefined;
          if (!tracking.sawTokenUsageThisTurn) {
            const outputTokens = turnCompletedOutputTokens(event.payload.usage);
            if (enabled && outputTokens !== undefined && outputTokens > 0) {
              if (tracking.provider !== event.provider) {
                resetAttribution(tracking, event.provider);
              }
              yield* resolveTrackingModel(event.threadId, event.provider, tracking);
              addOutputTokenDelta(localDayKey(now), outputTokens, event.provider, tracking.model);
            }
          }
          tracking.sawTokenUsageThisTurn = false;
        });
      }

      case "model.rerouted": {
        const tracking = track(event.threadId);
        tracking.provider = event.provider;
        tracking.model = normalizeUsageModel(event.payload.toModel);
        tracking.modelResolutionAttempted = true;
        return Effect.void;
      }

      case "turn.aborted": {
        return Effect.map(Clock.currentTimeMillis, (now) => {
          const tracking = track(event.threadId);
          accrue(tracking, now);
          tracking.accrueFromMs = undefined;
        });
      }

      case "session.exited": {
        return Effect.map(Clock.currentTimeMillis, (now) => {
          const tracking = threads.get(event.threadId);
          if (tracking !== undefined) {
            accrue(tracking, now);
            threads.delete(event.threadId);
          }
        });
      }

      default: {
        return Effect.void;
      }
    }
  };

  const flush: UsageStatsServiceShape["flush"] = Effect.suspend(() => {
    if (pending.size === 0 && pendingTokenBreakdowns.size === 0) {
      return Effect.void;
    }
    const dayBatch = Array.from(pending.entries(), ([day, delta]) => ({
      day,
      generatingMs: delta.generatingMs,
      outputTokens: delta.outputTokens,
      userMessages: delta.userMessages,
    }));
    const tokenBreakdownBatch = Array.from(pendingTokenBreakdowns.entries()).flatMap(
      ([day, providers]) =>
        Array.from(providers.entries()).flatMap(([provider, models]) =>
          Array.from(models.entries(), ([model, outputTokens]) => ({
            day,
            provider,
            model,
            outputTokens,
          })),
        ),
    );
    pending.clear();
    pendingTokenBreakdowns.clear();
    return repository.flushDeltas({ days: dayBatch, tokenBreakdowns: tokenBreakdownBatch }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          // The repository transaction commits both tables or neither. Merge
          // both snapshots back so retries preserve that same correspondence;
          // live aggregate totals already include these deltas.
          for (const row of dayBatch) {
            const entry = pending.get(row.day) ?? {
              generatingMs: 0,
              outputTokens: 0,
              userMessages: 0,
            };
            entry.generatingMs += row.generatingMs;
            entry.outputTokens += row.outputTokens;
            entry.userMessages += row.userMessages;
            pending.set(row.day, entry);
          }

          for (const row of tokenBreakdownBatch) {
            let providers = pendingTokenBreakdowns.get(row.day);
            if (providers === undefined) {
              providers = new Map();
              pendingTokenBreakdowns.set(row.day, providers);
            }
            let models = providers.get(row.provider);
            if (models === undefined) {
              models = new Map();
              providers.set(row.provider, models);
            }
            models.set(row.model, (models.get(row.model) ?? 0) + row.outputTokens);
          }
        }).pipe(
          Effect.flatMap(() => Effect.logError("usage stats: failed to flush deltas", { error })),
        ),
      ),
    );
  });

  /**
   * Accrue every generating thread up to now, drop accrual for threads whose
   * provider session is demonstrably gone (a lost terminal event would
   * otherwise count time forever), then persist.
   */
  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let accruing = false;
    for (const tracking of threads.values()) {
      if (tracking.accrueFromMs !== undefined) {
        accrue(tracking, now);
        accruing = true;
      }
    }

    if (accruing) {
      const sessions = yield* providerService.listSessions();
      const sessionsByThread = new Map<string, (typeof sessions)[number]>(
        sessions.map((session) => [session.threadId, session]),
      );
      for (const [threadId, tracking] of threads) {
        if (tracking.accrueFromMs === undefined) {
          continue;
        }
        const session = sessionsByThread.get(threadId);
        const stillActive =
          session !== undefined &&
          (session.status === "running" ||
            session.status === "connecting" ||
            session.activeTurnId !== undefined);
        if (!stillActive) {
          tracking.accrueFromMs = undefined;
          yield* Effect.logDebug("usage stats: dropped accrual for stale session", { threadId });
        }
      }
    }

    yield* flush;
  });

  const liveState = (nowMs: number) => {
    const todayKey = localDayKey(nowMs);
    let activeSessionCount = 0;
    let liveMs = 0;
    let todayLiveMs = 0;
    for (const tracking of threads.values()) {
      if (tracking.accrueFromMs === undefined) {
        continue;
      }
      activeSessionCount += 1;
      if (enabled) {
        for (const span of splitSpanIntoDays(tracking.accrueFromMs, nowMs)) {
          liveMs += span.ms;
          if (span.day === todayKey) {
            todayLiveMs += span.ms;
          }
        }
      }
    }
    const storedToday = days.get(todayKey);
    return {
      totals: {
        generatingMs: totals.generatingMs + liveMs,
        outputTokens: totals.outputTokens,
        userMessages: totals.userMessages,
      },
      today: {
        day: todayKey,
        generatingMs: (storedToday?.generatingMs ?? 0) + todayLiveMs,
        outputTokens: storedToday?.outputTokens ?? 0,
        userMessages: storedToday?.userMessages ?? 0,
      },
      activeSessionCount,
      collectionEnabled: enabled,
      asOfMs: nowMs,
    };
  };

  const snapshot: UsageStatsServiceShape["snapshot"] = Effect.map(
    Clock.currentTimeMillis,
    liveState,
  );

  const get: UsageStatsServiceShape["get"] = Effect.map(Clock.currentTimeMillis, (now) => {
    const state = liveState(now);
    const dayRows = Array.from(days.entries(), ([day, dayTotals]) => ({
      day,
      generatingMs: dayTotals.generatingMs,
      outputTokens: dayTotals.outputTokens,
      userMessages: dayTotals.userMessages,
    })).toSorted((left, right) => (left.day < right.day ? -1 : 1));
    // Present in-flight time on today's row so the heatmap cell matches the
    // headline counters without the client having to merge anything.
    const withLiveToday =
      state.today.generatingMs > 0 || state.today.outputTokens > 0 || state.today.userMessages > 0
        ? [...dayRows.filter((row) => row.day !== state.today.day), state.today].toSorted(
            (left, right) => (left.day < right.day ? -1 : 1),
          )
        : dayRows;
    return { ...state, days: withLiveToday, tokenBreakdown: readTokenBreakdown() };
  });

  yield* Effect.forkScoped(
    Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
      handleDomainEvent(event).pipe(Effect.ignoreCause({ log: true })),
    ),
  );

  yield* Effect.forkScoped(
    Stream.runForEach(providerService.streamEvents, (event) =>
      handleProviderEvent(event).pipe(Effect.ignoreCause({ log: true })),
    ),
  );

  yield* Effect.forkScoped(
    Stream.runForEach(serverSettings.streamChanges, (settings) =>
      Effect.sync(() => {
        enabled = settings.usageStatsEnabled;
      }),
    ),
  );

  yield* Effect.forever(
    Effect.sleep(FLUSH_INTERVAL_MS).pipe(
      Effect.flatMap(() => tick.pipe(Effect.ignoreCause({ log: true }))),
    ),
    { disableYield: true },
  ).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() => tick.pipe(Effect.ignoreCause({ log: true })));

  return {
    get,
    snapshot,
    flush,
  } satisfies UsageStatsServiceShape;
});

export const UsageStatsServiceLive = Layer.effect(UsageStatsService, makeUsageStatsService);
