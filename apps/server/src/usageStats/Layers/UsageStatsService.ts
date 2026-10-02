/**
 * UsageStatsServiceLive - In-memory usage accumulator with periodic SQLite flush.
 *
 * Building the layer hydrates lifetime counters from `usage_stats_days` and
 * provider/model token attribution from `usage_stats_token_breakdown_days`, and
 * the prospective model-time ledger plus its stable measurement boundary,
 * forks consumers of the domain-event and provider-runtime streams, and forks
 * a flush loop that accrues in-flight generating time and persists pending
 * per-day deltas every few seconds. A finalizer performs one last
 * accrue-and-flush on shutdown. With healthy storage, a successful clean stop
 * loses nothing and a hard kill loses at most one flush interval. Failed
 * transactions retain their exact pending batches for a later retry.
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
  UsageStatsModelGeneratingTimeStartedAt,
  type OrchestrationEvent,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type UsageStatsTokenBreakdownEntry,
  type UsageAccountingSnapshot,
  type UsageStatsTokenBreakdownDayEntry,
  type UsageStatsModelGeneratingTime,
  type UsageStatsModelGeneratingTimeEntry,
  type UsageStatsModelGeneratingTimeDayEntry,
} from "@cafecode/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { UsageAccountingSnapshot as UsageAccountingSnapshotSchema } from "@cafecode/contracts";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { UsageStatsRepository } from "../../persistence/Services/UsageStats.ts";
import { isSqliteLockTimeoutError } from "../../persistence/sqliteLockRetry.ts";
import { settleDurableWrite, singleDurableWriteError } from "../../persistence/durableWrite.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { localDayKey, splitSpanIntoDays } from "../dayBuckets.ts";
import {
  selectCounter,
  tokenDelta,
  USAGE_TOKEN_FIELDS,
  type UsageTokenField,
} from "../tokenDelta.ts";
import { UsageStatsService, type UsageStatsServiceShape } from "../Services/UsageStatsService.ts";
import { AuxiliaryUsage } from "../Services/AuxiliaryUsage.ts";

const FLUSH_INTERVAL_MS = 5_000;
const MODEL_RESOLUTION_TIMEOUT_MS = 1_000;
const UNKNOWN_USAGE_MODEL = "unknown";
const decodeAccountingSnapshot = Schema.decodeEffect(UsageAccountingSnapshotSchema);
const decodeModelGeneratingTimeStartedAt = Schema.decodeUnknownEffect(
  UsageStatsModelGeneratingTimeStartedAt,
);

type TokenCounts = Record<UsageTokenField, number>;

const zeroCounts = (): TokenCounts => ({
  outputTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

const addCounts = (target: TokenCounts, delta: TokenCounts): void => {
  for (const field of USAGE_TOKEN_FIELDS) target[field] += delta[field];
};

const hasCounts = (counts: TokenCounts): boolean =>
  USAGE_TOKEN_FIELDS.some((field) => counts[field] > 0);

interface MutableDayTotals extends TokenCounts {
  generatingMs: number;
  userMessages: number;
}

const zeroDayTotals = (): MutableDayTotals => ({
  ...zeroCounts(),
  generatingMs: 0,
  userMessages: 0,
});

interface ThreadTracking {
  /** Per-counter watermarks; see tokenDelta.ts for the reset semantics. */
  watermarks: Map<UsageTokenField, number>;
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
  /** Selected/effective model for token/time deltas observed after this point. */
  model: string | undefined;
  /** Prevents a missing session model from causing a lookup on every token. */
  modelResolutionAttempted: boolean;
  /** Fence asynchronous model reads against a newer attribution/session. */
  attributionGeneration: number;
}

type PendingTokenBreakdowns = Map<string, Map<ProviderDriverKind, Map<string, TokenCounts>>>;
type TokenBreakdownTotals = Map<ProviderDriverKind, Map<string, TokenCounts>>;
type ModelGeneratingTimeDays = Map<string, Map<ProviderDriverKind, Map<string, number>>>;
type ModelGeneratingTimeTotals = Map<ProviderDriverKind, Map<string, number>>;

/** Pure map helpers are shared rather than recreated for every service scope. */
const addModelTimeDay = (
  target: ModelGeneratingTimeDays,
  day: string,
  provider: ProviderDriverKind,
  model: string,
  generatingMs: number,
): void => {
  if (generatingMs <= 0) return;
  let providers = target.get(day);
  if (providers === undefined) {
    providers = new Map();
    target.set(day, providers);
  }
  let models = providers.get(provider);
  if (models === undefined) {
    models = new Map();
    providers.set(provider, models);
  }
  models.set(model, (models.get(model) ?? 0) + generatingMs);
};

const modelTimeDayRows = (
  source: ModelGeneratingTimeDays,
): Array<UsageStatsModelGeneratingTimeDayEntry> =>
  Array.from(source.entries())
    .flatMap(([day, providers]) =>
      Array.from(providers.entries()).flatMap(([provider, models]) =>
        Array.from(models.entries(), ([model, generatingMs]) => ({
          day,
          provider,
          model,
          generatingMs,
        })),
      ),
    )
    .toSorted(
      (left, right) =>
        left.day.localeCompare(right.day) ||
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model),
    );

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
  tracking.attributionGeneration += 1;
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
  const flushAdmission = yield* Semaphore.make(1);

  // All state is confined to this closure and mutated only from synchronous
  // sections of the forked consumers below, so no Ref coordination is needed.
  const days = new Map<string, MutableDayTotals>();
  const pending = new Map<string, MutableDayTotals>();
  const pendingTokenBreakdowns: PendingTokenBreakdowns = new Map();
  const tokenBreakdownTotals: TokenBreakdownTotals = new Map();
  const tokenBreakdownDays: PendingTokenBreakdowns = new Map();
  const modelGeneratingTimeTotals: ModelGeneratingTimeTotals = new Map();
  const modelGeneratingTimeDays: ModelGeneratingTimeDays = new Map();
  const pendingModelGeneratingTimes: ModelGeneratingTimeDays = new Map();
  const threads = new Map<string, ThreadTracking>();
  const totals: MutableDayTotals = zeroDayTotals();
  let tokenBreakdownSnapshot: ReadonlyArray<UsageStatsTokenBreakdownEntry> = [];
  let tokenBreakdownSnapshotDirty = true;
  let tokenBreakdownDaySnapshot: ReadonlyArray<UsageStatsTokenBreakdownDayEntry> = [];
  let tokenBreakdownDaySnapshotDirty = true;
  let enabled = true;
  let modelGeneratingTimeStartedAt: string | undefined;
  let modelGeneratingTimeRecordedMs = 0;
  let modelGeneratingTimeOverflowed = false;
  let modelGeneratingTimeSnapshotDirty = true;
  let modelGeneratingTimeTotalSnapshot: ReadonlyArray<UsageStatsModelGeneratingTimeEntry> = [];
  let modelGeneratingTimeDaySnapshot: ReadonlyArray<UsageStatsModelGeneratingTimeDayEntry> = [];

  const addModelTimeTotal = (
    provider: ProviderDriverKind,
    model: string,
    generatingMs: number,
    day: string,
  ): void => {
    if (generatingMs <= 0) return;
    // Valid individual SQLite rows can still exceed JavaScript's exact range
    // when combined. Never round a model-time presentation total: keep writing
    // exact daily deltas but hide this optional detail until history is repaired
    // and the service rehydrates. Aggregate usage keeps its existing behavior.
    if (modelGeneratingTimeOverflowed) return;
    const nextRecordedMs = modelGeneratingTimeRecordedMs + generatingMs;
    if (!Number.isSafeInteger(nextRecordedMs)) {
      modelGeneratingTimeOverflowed = true;
      return;
    }
    modelGeneratingTimeRecordedMs = nextRecordedMs;
    let models = modelGeneratingTimeTotals.get(provider);
    if (models === undefined) {
      models = new Map();
      modelGeneratingTimeTotals.set(provider, models);
    }
    models.set(model, (models.get(model) ?? 0) + generatingMs);
    addModelTimeDay(modelGeneratingTimeDays, day, provider, model, generatingMs);
    modelGeneratingTimeSnapshotDirty = true;
  };

  /**
   * Detail-only materialization. Cached settled rows are rebuilt only after
   * accrual; live spans are overlaid without advancing cursors or pending
   * batches, so repeated get() reads can never bill time a second time.
   */
  const readModelGeneratingTime = (nowMs: number): UsageStatsModelGeneratingTime | undefined => {
    if (modelGeneratingTimeStartedAt === undefined || modelGeneratingTimeOverflowed)
      return undefined;
    if (modelGeneratingTimeSnapshotDirty) {
      modelGeneratingTimeTotalSnapshot = Array.from(modelGeneratingTimeTotals.entries())
        .flatMap(([provider, models]) =>
          Array.from(models.entries(), ([model, generatingMs]) => ({
            provider,
            model,
            generatingMs,
          })),
        )
        .toSorted(
          (left, right) =>
            left.provider.localeCompare(right.provider) ||
            right.generatingMs - left.generatingMs ||
            left.model.localeCompare(right.model),
        );
      modelGeneratingTimeDaySnapshot = modelTimeDayRows(modelGeneratingTimeDays);
      modelGeneratingTimeSnapshotDirty = false;
    }
    const liveDays: ModelGeneratingTimeDays = new Map();
    const liveTotals: ModelGeneratingTimeTotals = new Map();
    let combinedMs = modelGeneratingTimeRecordedMs;
    if (enabled) {
      for (const tracking of threads.values()) {
        if (tracking.accrueFromMs === undefined || tracking.provider === undefined) continue;
        const model = tracking.model ?? UNKNOWN_USAGE_MODEL;
        for (const span of splitSpanIntoDays(tracking.accrueFromMs, nowMs)) {
          combinedMs += span.ms;
          if (!Number.isSafeInteger(combinedMs)) return undefined;
          addModelTimeDay(liveDays, span.day, tracking.provider, model, span.ms);
          let models = liveTotals.get(tracking.provider);
          if (models === undefined) {
            models = new Map();
            liveTotals.set(tracking.provider, models);
          }
          models.set(model, (models.get(model) ?? 0) + span.ms);
        }
      }
    }
    if (liveDays.size === 0) {
      return {
        startedAt: modelGeneratingTimeStartedAt,
        totals: modelGeneratingTimeTotalSnapshot,
        days: modelGeneratingTimeDaySnapshot,
      };
    }
    const totals = modelGeneratingTimeTotalSnapshot.map((row) => {
      const models = liveTotals.get(row.provider);
      const liveMs = models?.get(row.model) ?? 0;
      models?.delete(row.model);
      return liveMs > 0
        ? { provider: row.provider, model: row.model, generatingMs: row.generatingMs + liveMs }
        : row;
    });
    for (const [provider, models] of liveTotals) {
      for (const [model, generatingMs] of models) totals.push({ provider, model, generatingMs });
    }
    const days = modelGeneratingTimeDaySnapshot.map((row) => {
      const models = liveDays.get(row.day)?.get(row.provider);
      const liveMs = models?.get(row.model) ?? 0;
      models?.delete(row.model);
      return liveMs > 0
        ? {
            day: row.day,
            provider: row.provider,
            model: row.model,
            generatingMs: row.generatingMs + liveMs,
          }
        : row;
    });
    days.push(...modelTimeDayRows(liveDays));
    return {
      startedAt: modelGeneratingTimeStartedAt,
      totals: totals.toSorted(
        (left, right) =>
          left.provider.localeCompare(right.provider) ||
          right.generatingMs - left.generatingMs ||
          left.model.localeCompare(right.model),
      ),
      days: days.toSorted(
        (left, right) =>
          left.day.localeCompare(right.day) ||
          left.provider.localeCompare(right.provider) ||
          left.model.localeCompare(right.model),
      ),
    };
  };

  const addTokenBreakdownTotal = (
    provider: ProviderDriverKind,
    model: string,
    counts: TokenCounts,
    day?: string,
  ): void => {
    if (!hasCounts(counts)) {
      return;
    }
    let models = tokenBreakdownTotals.get(provider);
    if (models === undefined) {
      models = new Map();
      tokenBreakdownTotals.set(provider, models);
    }
    let entry = models.get(model);
    if (entry === undefined) {
      entry = zeroCounts();
      models.set(model, entry);
    }
    addCounts(entry, counts);
    tokenBreakdownSnapshotDirty = true;
    if (day !== undefined) {
      let providers = tokenBreakdownDays.get(day);
      if (providers === undefined) {
        providers = new Map();
        tokenBreakdownDays.set(day, providers);
      }
      let dailyModels = providers.get(provider);
      if (dailyModels === undefined) {
        dailyModels = new Map();
        providers.set(provider, dailyModels);
      }
      let dailyCounts = dailyModels.get(model);
      if (dailyCounts === undefined) {
        dailyCounts = zeroCounts();
        dailyModels.set(model, dailyCounts);
      }
      addCounts(dailyCounts, counts);
      tokenBreakdownDaySnapshotDirty = true;
    }
  };

  // Reuse the hydrated attribution rows rather than adding a database scan
  // every time Atrium/Settings refreshes. This cached detail remains absent
  // from the high-frequency fixed-cardinality snapshot stream.
  const readTokenBreakdownDays = (): ReadonlyArray<UsageStatsTokenBreakdownDayEntry> => {
    if (tokenBreakdownDaySnapshotDirty) {
      tokenBreakdownDaySnapshot = Array.from(tokenBreakdownDays.entries())
        .toSorted(([left], [right]) => left.localeCompare(right))
        .flatMap(([day, providers]) =>
          Array.from(providers.entries()).flatMap(([provider, models]) =>
            Array.from(models.entries(), ([model, counts]) => ({
              day,
              provider,
              model,
              ...counts,
            })),
          ),
        );
      tokenBreakdownDaySnapshotDirty = false;
    }
    return tokenBreakdownDaySnapshot;
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
        Array.from(models.entries(), ([model, counts]) => ({
          provider,
          model,
          ...counts,
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
        const entry: MutableDayTotals = {
          ...zeroCounts(),
          generatingMs: row.generatingMs,
          userMessages: row.userMessages,
        };
        for (const field of USAGE_TOKEN_FIELDS) entry[field] = row[field];
        days.set(row.day, entry);
        totals.generatingMs += row.generatingMs;
        totals.userMessages += row.userMessages;
        addCounts(totals, entry);
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
        const counts = zeroCounts();
        for (const field of USAGE_TOKEN_FIELDS) counts[field] = row[field];
        addTokenBreakdownTotal(row.provider, row.model, counts, row.day);
      }
    }),
    // Aggregate usage remains useful if only the attribution ledger is
    // damaged. Keep this failure isolated and let current-session rows accrue.
    Effect.catch((error) =>
      Effect.logError("usage stats: failed to hydrate token breakdown", { error }),
    ),
  );

  yield* repository.readModelGeneratingTime.pipe(
    Effect.flatMap((history) =>
      decodeModelGeneratingTimeStartedAt(history.startedAt).pipe(
        Effect.map((startedAt) => ({ ...history, startedAt })),
      ),
    ),
    Effect.map((history) => {
      modelGeneratingTimeStartedAt = history.startedAt;
      for (const row of history.days)
        addModelTimeTotal(row.provider, row.model, row.generatingMs, row.day);
    }),
    // Do not invent a measurement boundary or empty historical ledger after
    // a failed read. Aggregate counters remain available and this process's
    // new numeric deltas can still be retried atomically on the normal flush.
    Effect.catch(() => Effect.logError("usage stats: failed to hydrate model generating time")),
  );

  enabled = yield* serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.usageStatsEnabled),
    Effect.catch(() => Effect.succeed(true)),
  );

  const addDelta = (day: string, delta: Partial<MutableDayTotals>): void => {
    const generatingMs = delta.generatingMs ?? 0;
    const userMessages = delta.userMessages ?? 0;
    const counts = zeroCounts();
    for (const field of USAGE_TOKEN_FIELDS) counts[field] = delta[field] ?? 0;
    if (generatingMs <= 0 && userMessages <= 0 && !hasCounts(counts)) {
      return;
    }
    for (const bucket of [days, pending]) {
      let entry = bucket.get(day);
      if (entry === undefined) {
        entry = zeroDayTotals();
        bucket.set(day, entry);
      }
      entry.generatingMs += generatingMs;
      entry.userMessages += userMessages;
      addCounts(entry, counts);
    }
    totals.generatingMs += generatingMs;
    totals.userMessages += userMessages;
    addCounts(totals, counts);
  };

  /**
   * Record the same output-token observation in the aggregate and attribution
   * accumulators. The repository later commits both maps atomically.
   */
  const addTokenDeltas = (
    day: string,
    counts: TokenCounts,
    provider: ProviderDriverKind,
    model: string | undefined,
  ): void => {
    if (!hasCounts(counts)) {
      return;
    }
    addDelta(day, counts);

    const modelKey = model ?? UNKNOWN_USAGE_MODEL;
    addTokenBreakdownTotal(provider, modelKey, counts, day);

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
    let entry = models.get(modelKey);
    if (entry === undefined) {
      entry = zeroCounts();
      models.set(modelKey, entry);
    }
    addCounts(entry, counts);
  };

  /**
   * Billing snapshots arrive once per API response/result, never per token.
   * SQLite owns their durable revision fence. Update the presentation cache
   * only with increments accepted by that same transaction, and do not queue
   * them in the legacy flush maps a second time.
   */
  type AccountingWork = {
    readonly provider: ProviderDriverKind;
    readonly snapshot: UsageAccountingSnapshot;
    readonly day: string;
    readonly enabled: boolean;
    readonly committed: Deferred.Deferred<void>;
  };
  const accountingQueue = yield* Queue.bounded<AccountingWork>(128);
  const pendingAccountingCommits = new Set<Deferred.Deferred<void>>();
  const handleUsageAccounting = (
    provider: ProviderDriverKind,
    snapshot: UsageAccountingSnapshot,
    observedAtMs: number,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const decoded = yield* decodeAccountingSnapshot(snapshot);
      if (!Number.isFinite(observedAtMs)) return;
      const committed = yield* Deferred.make<void>();
      pendingAccountingCommits.add(committed);
      yield* Queue.offer(accountingQueue, {
        provider,
        snapshot: decoded,
        day: localDayKey(observedAtMs),
        enabled,
        committed,
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            pendingAccountingCommits.delete(committed);
          }),
        ),
      );
      // The worker belongs to the service scope. A disconnected renderer/helper
      // can stop waiting without cancelling an already admitted transaction.
      yield* Deferred.await(committed);
    }).pipe(
      Effect.catch(() => Effect.logWarning("usage stats: rejected invalid accounting snapshot")),
    );

  yield* Effect.forever(
    Effect.gen(function* () {
      const work = yield* Queue.take(accountingQueue);
      const result = yield* settleDurableWrite({
        name: "usage-accounting",
        operation: repository.recordAccountingSnapshot(work),
        classify: (cause) => {
          const error = singleDurableWriteError(cause);
          return Effect.succeed(
            error instanceof PersistenceDecodeError
              ? "reject"
              : error instanceof PersistenceSqlError && isSqliteLockTimeoutError(error.cause)
                ? "retry"
                : "block",
          );
        },
      });
      if (Option.isSome(result)) {
        for (const delta of result.value) {
          const entry = days.get(delta.day) ?? zeroDayTotals();
          addCounts(entry, delta);
          days.set(delta.day, entry);
          addCounts(totals, delta);
          addTokenBreakdownTotal(work.provider, delta.model, delta, delta.day);
        }
      }
      yield* Deferred.succeed(work.committed, undefined);
      pendingAccountingCommits.delete(work.committed);
    }),
  ).pipe(Effect.forkScoped);

  const auxiliaryUsage = yield* Effect.serviceOption(AuxiliaryUsage);
  if (Option.isSome(auxiliaryUsage)) {
    yield* auxiliaryUsage.value.installSink(handleUsageAccounting);
  }

  const track = (threadId: string): ThreadTracking => {
    let tracking = threads.get(threadId);
    if (tracking === undefined) {
      tracking = {
        watermarks: new Map(),
        witnessedSessionStart: false,
        sawTokenUsageThisTurn: false,
        accrueFromMs: undefined,
        provider: undefined,
        model: undefined,
        modelResolutionAttempted: false,
        attributionGeneration: 0,
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
    const attributionGeneration = tracking.attributionGeneration;
    return providerService.listSessions().pipe(
      Effect.timeoutOption(MODEL_RESOLUTION_TIMEOUT_MS),
      Effect.catchCause(() => Effect.succeed(Option.none())),
      Effect.flatMap((sessionsOption) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          if (Option.isNone(sessionsOption)) {
            return;
          }
          if (
            threads.get(threadId) !== tracking ||
            tracking.provider !== provider ||
            tracking.attributionGeneration !== attributionGeneration
          )
            return;
          const session = sessionsOption.value.find(
            (candidate) => candidate.threadId === threadId && candidate.provider === provider,
          );
          // A delayed lookup identifies the model only from this boundary onward.
          // Credit the elapsed unresolved interval to unknown before replacing it;
          // never recolor already accrued time when a session read completes.
          accrue(tracking, now);
          tracking.model = normalizeUsageModel(session?.model);
        }),
      ),
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
        if (tracking.provider !== undefined) {
          const model = tracking.model ?? UNKNOWN_USAGE_MODEL;
          addModelTimeTotal(tracking.provider, model, span.ms, span.day);
          addModelTimeDay(pendingModelGeneratingTimes, span.day, tracking.provider, model, span.ms);
        }
      }
    }
    // A backwards wall-clock correction must not replay an already credited
    // interval when the clock catches up again.
    tracking.accrueFromMs = Math.max(tracking.accrueFromMs, nowMs);
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
      case "thread.usage-accounting.updated":
        // Required billing settlement is owned by ordered runtime ingestion,
        // not this independent presentation subscriber. Otherwise a crash can
        // persist the replay cursor before this subscriber commits the usage.
        return Effect.void;
      case "session.started":
      case "thread.started": {
        return Effect.map(Clock.currentTimeMillis, (now) => {
          const tracking = track(event.threadId);
          accrue(tracking, now);
          tracking.witnessedSessionStart = true;
          // Same-driver start notifications can be replayed after a turn or
          // reroute has already established its effective model. They carry no
          // replacement model, so do not erase active known attribution. A
          // different driver or an idle/new turn still receives a clean reset.
          if (tracking.accrueFromMs === undefined || tracking.provider !== event.provider) {
            resetAttribution(tracking, event.provider);
          }
        });
      }

      case "turn.started": {
        return Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const tracking = track(event.threadId);
          accrue(tracking, now);
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
        // Claude message counts describe one request/current context, not a
        // cumulative bill. Its dedicated accounting stream deduplicates exact
        // API message IDs and settles full per-model query totals instead.
        if (event.provider === "claudeAgent") return Effect.void;
        return Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const tracking = track(event.threadId);
          if (tracking.provider !== event.provider) {
            accrue(tracking, now);
            resetAttribution(tracking, event.provider);
          }
          tracking.sawTokenUsageThisTurn = true;
          // Each counter carries its own watermark: providers mix cumulative
          // and per-request semantics per field, so they cannot share one.
          const deltas = zeroCounts();
          for (const field of USAGE_TOKEN_FIELDS) {
            const counter = selectCounter(event.payload.usage, field);
            if (counter === undefined) {
              continue;
            }
            const countFirstObservation =
              counter.kind === "per-message" || tracking.witnessedSessionStart;
            const result = tokenDelta(
              tracking.watermarks.get(field),
              counter.value,
              countFirstObservation,
            );
            tracking.watermarks.set(field, result.watermark);
            deltas[field] = result.delta;
          }
          if (enabled && hasCounts(deltas)) {
            yield* resolveTrackingModel(event.threadId, event.provider, tracking);
            addTokenDeltas(localDayKey(now), deltas, event.provider, tracking.model);
          }
        });
      }

      case "turn.completed": {
        return Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const tracking = track(event.threadId);
          accrue(tracking, now);
          tracking.accrueFromMs = undefined;
          if (event.provider !== "claudeAgent" && !tracking.sawTokenUsageThisTurn) {
            const outputTokens = turnCompletedOutputTokens(event.payload.usage);
            if (enabled && outputTokens !== undefined && outputTokens > 0) {
              if (tracking.provider !== event.provider) {
                resetAttribution(tracking, event.provider);
              }
              yield* resolveTrackingModel(event.threadId, event.provider, tracking);
              addTokenDeltas(
                localDayKey(now),
                { ...zeroCounts(), outputTokens },
                event.provider,
                tracking.model,
              );
            }
          }
          tracking.sawTokenUsageThisTurn = false;
        });
      }

      case "model.rerouted": {
        return Effect.map(Clock.currentTimeMillis, (now) => {
          const tracking = track(event.threadId);
          accrue(tracking, now);
          resetAttribution(tracking, event.provider);
          tracking.model = normalizeUsageModel(event.payload.toModel);
          tracking.modelResolutionAttempted = true;
        });
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

  const flush: UsageStatsServiceShape["flush"] = flushAdmission
    .withPermits(1)(
      // Admission is cancellable, but a detached additive batch is not. SQLite
      // may commit just before cancellation reaches the caller; interrupting its
      // acknowledgement would make a committed batch look failed and replay it.
      // Decide success/requeue inside this mask before honoring interruption.
      Effect.uninterruptible(
        Effect.suspend(() => {
          if (
            pending.size === 0 &&
            pendingTokenBreakdowns.size === 0 &&
            pendingModelGeneratingTimes.size === 0
          ) {
            return Effect.void;
          }
          const dayBatch = Array.from(pending.entries(), ([day, delta]) => ({
            day,
            generatingMs: delta.generatingMs,
            userMessages: delta.userMessages,
            outputTokens: delta.outputTokens,
            inputTokens: delta.inputTokens,
            cachedInputTokens: delta.cachedInputTokens,
            cacheWriteInputTokens: delta.cacheWriteInputTokens,
            reasoningOutputTokens: delta.reasoningOutputTokens,
          }));
          const tokenBreakdownBatch = Array.from(pendingTokenBreakdowns.entries()).flatMap(
            ([day, providers]) =>
              Array.from(providers.entries()).flatMap(([provider, models]) =>
                Array.from(models.entries(), ([model, counts]) => ({
                  day,
                  provider,
                  model,
                  ...counts,
                })),
              ),
          );
          pending.clear();
          pendingTokenBreakdowns.clear();
          const modelTimeBatch = modelTimeDayRows(pendingModelGeneratingTimes);
          pendingModelGeneratingTimes.clear();
          return repository
            .flushDeltas({
              days: dayBatch,
              tokenBreakdowns: tokenBreakdownBatch,
              modelGeneratingTimes: modelTimeBatch,
            })
            .pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? Effect.sync(() => {
                      // The repository transaction commits all three ledgers or none. Merge
                      // the exact captured batches into any newly admitted pending work;
                      // live aggregate totals already include these deltas.
                      for (const row of dayBatch) {
                        const entry = pending.get(row.day) ?? zeroDayTotals();
                        entry.generatingMs += row.generatingMs;
                        entry.userMessages += row.userMessages;
                        for (const field of USAGE_TOKEN_FIELDS) entry[field] += row[field];
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
                        let entry = models.get(row.model);
                        if (entry === undefined) {
                          entry = zeroCounts();
                          models.set(row.model, entry);
                        }
                        for (const field of USAGE_TOKEN_FIELDS) entry[field] += row[field];
                      }
                      for (const row of modelTimeBatch)
                        addModelTimeDay(
                          pendingModelGeneratingTimes,
                          row.day,
                          row.provider,
                          row.model,
                          row.generatingMs,
                        );
                    })
                  : Effect.void,
              ),
            );
        }),
      ),
    )
    .pipe(Effect.catch(() => Effect.logError("usage stats: failed to flush deltas")));

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
    const todayCounts = zeroCounts();
    if (storedToday !== undefined) {
      for (const field of USAGE_TOKEN_FIELDS) todayCounts[field] = storedToday[field];
    }
    const totalCounts = zeroCounts();
    for (const field of USAGE_TOKEN_FIELDS) totalCounts[field] = totals[field];
    return {
      totals: {
        generatingMs: totals.generatingMs + liveMs,
        userMessages: totals.userMessages,
        ...totalCounts,
      },
      today: {
        day: todayKey,
        generatingMs: (storedToday?.generatingMs ?? 0) + todayLiveMs,
        userMessages: storedToday?.userMessages ?? 0,
        ...todayCounts,
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
    const modelGeneratingTime = readModelGeneratingTime(now);
    // A live interval may cross local midnight between ticks. Overlay every
    // split day, not only today, so aggregate detail and model-time detail
    // describe the same active wall clock without mutating either ledger.
    const liveDayMs = new Map<string, number>();
    if (enabled) {
      for (const tracking of threads.values()) {
        if (tracking.accrueFromMs === undefined) continue;
        for (const span of splitSpanIntoDays(tracking.accrueFromMs, now)) {
          liveDayMs.set(span.day, (liveDayMs.get(span.day) ?? 0) + span.ms);
        }
      }
    }
    const detailDays = new Map(days);
    for (const [day, generatingMs] of liveDayMs) {
      detailDays.set(day, {
        ...(days.get(day) ?? zeroDayTotals()),
        generatingMs: (days.get(day)?.generatingMs ?? 0) + generatingMs,
      });
    }
    const dayRows = Array.from(detailDays.entries(), ([day, dayTotals]) => {
      const counts = zeroCounts();
      for (const field of USAGE_TOKEN_FIELDS) counts[field] = dayTotals[field];
      return {
        day,
        generatingMs: dayTotals.generatingMs,
        userMessages: dayTotals.userMessages,
        ...counts,
      };
    }).toSorted((left, right) => (left.day < right.day ? -1 : 1));
    return {
      ...state,
      days: dayRows,
      tokenBreakdown: readTokenBreakdown(),
      tokenBreakdownDays: readTokenBreakdownDays(),
      ...(modelGeneratingTime !== undefined ? { modelGeneratingTime } : {}),
    };
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
      Effect.map(Clock.currentTimeMillis, (now) => {
        // Settle under the OLD collection setting before changing it. Otherwise
        // an off/on edit between flush ticks could erase enabled time or count
        // the disabled gap retroactively under the later setting.
        for (const tracking of threads.values()) accrue(tracking, now);
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

  // Register after the worker's scoped-fiber finalizer, so orderly shutdown
  // first gives already-admitted snapshots a bounded chance to commit. Never
  // hang desktop shutdown behind a broken/locked database. An unclean process
  // exit cannot promise observations it never durably accepted; committed
  // checkpoints remain exactly replay-safe on the next backend attachment.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(Array.from(pendingAccountingCommits), (committed) => Deferred.await(committed), {
      concurrency: "unbounded",
      discard: true,
    }).pipe(
      Effect.timeoutOption(2_000),
      Effect.tap((settled) =>
        Option.isNone(settled)
          ? Effect.logWarning("usage stats: shutdown left accounting settlement incomplete")
          : Effect.void,
      ),
    ),
  );

  return {
    recordAccounting: handleUsageAccounting,
    get,
    snapshot,
    flush,
  } satisfies UsageStatsServiceShape;
});

export const UsageStatsServiceLive = Layer.effect(UsageStatsService, makeUsageStatsService);
