import type {
  ProviderDriverKind,
  UsageStatsDay,
  UsageStatsGetResult,
  UsageStatsModelGeneratingTimeEntry,
  UsageStatsTokenBreakdownEntry,
  UsageStatsTotals,
} from "@cafecode/contracts";

export type UsageRangeKey = "7" | "30" | "90" | "all";

export const USAGE_RANGES = [
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "90", label: "90 days", days: 90 },
  { key: "all", label: "All", days: Infinity },
] as const satisfies ReadonlyArray<{ key: UsageRangeKey; label: string; days: number }>;

export interface UsageRangeBounds {
  readonly startDay: string;
  readonly endDay: string;
}

const UTC_DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Represent a server-local calendar key as an integer day for arithmetic.
 *
 * This UTC representation does not reinterpret the server's timezone or turn
 * the key into an observation timestamp. It only avoids the browser's timezone
 * and daylight-saving transitions while counting calendar dates. The shared
 * contract checks the spelling; the round trip additionally rejects impossible
 * dates instead of letting Date silently normalize February 30 into March.
 */
export function usageDayToUtcDayIndex(day: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return undefined;
  }
  const utcMs = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(utcMs) || new Date(utcMs).toISOString().slice(0, 10) !== day) {
    return undefined;
  }
  return utcMs / UTC_DAY_MS;
}

/** Inverse of the calendar representation above, with no client-local timezone conversion. */
export function utcDayIndexToUsageDay(dayIndex: number): string {
  return new Date(dayIndex * UTC_DAY_MS).toISOString().slice(0, 10);
}

function currentDayIndex(usage: Pick<UsageStatsGetResult, "today">): number {
  const dayIndex = usageDayToUtcDayIndex(usage.today.day);
  if (dayIndex === undefined) {
    // A client clock cannot safely repair an invalid server calendar anchor.
    // Keep the error fixed so corrupt server data is not copied into UI text.
    throw new Error("Usage statistics returned an invalid current day.");
  }
  return dayIndex;
}

/** Inclusive calendar bounds, anchored to the server's current local day. */
export function getUsageRangeBounds(
  usage: Pick<UsageStatsGetResult, "today" | "days" | "tokenBreakdownDays" | "modelGeneratingTime">,
  range: UsageRangeKey,
): UsageRangeBounds {
  const endIndex = currentDayIndex(usage);
  if (range !== "all") {
    return {
      startDay: utcDayIndexToUsageDay(endIndex - Number(range) + 1),
      endDay: usage.today.day,
    };
  }

  let startIndex = endIndex;
  for (const row of usage.days) {
    const dayIndex = usageDayToUtcDayIndex(row.day);
    if (dayIndex !== undefined && dayIndex < startIndex) {
      startIndex = dayIndex;
    }
  }
  for (const row of usage.tokenBreakdownDays ?? []) {
    const dayIndex = usageDayToUtcDayIndex(row.day);
    // A daily model observation can precede a retained aggregate day. Include
    // its date in the full-history calendar, but a zero row is not historical
    // activity and must not extend the view by itself.
    if (
      dayIndex !== undefined &&
      dayIndex < startIndex &&
      (row.inputTokens > 0 || row.outputTokens > 0)
    ) {
      startIndex = dayIndex;
    }
  }
  for (const row of usage.modelGeneratingTime?.days ?? []) {
    const dayIndex = usageDayToUtcDayIndex(row.day);
    // A turn can accrue time before it reports any tokens. Keep that history
    // reachable even when neither of the older ledgers has a row for its day.
    if (dayIndex !== undefined && dayIndex < startIndex && row.generatingMs > 0) {
      startIndex = dayIndex;
    }
  }
  return { startDay: utcDayIndexToUsageDay(startIndex), endDay: usage.today.day };
}

function emptyTotals(): UsageStatsTotals {
  return {
    generatingMs: 0,
    userMessages: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

/** Sum each recorded dimension independently; cache and reasoning are subsets. */
function addTokens(
  sum: UsageStatsTokenBreakdownEntry,
  row: UsageStatsTokenBreakdownEntry,
): UsageStatsTokenBreakdownEntry {
  return {
    provider: sum.provider,
    model: sum.model,
    inputTokens: sum.inputTokens + row.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + row.cachedInputTokens,
    cacheWriteInputTokens: sum.cacheWriteInputTokens + row.cacheWriteInputTokens,
    outputTokens: sum.outputTokens + row.outputTokens,
    reasoningOutputTokens: sum.reasoningOutputTokens + row.reasoningOutputTokens,
  };
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * One atomic range view for every Usage dashboard surface.
 *
 * Finite ranges derive counters and provider/model attribution only from their
 * own calendar days. Lifetime attribution is deliberately never a substitute
 * when an older server has no daily model ledger. All time keeps authoritative
 * lifetime totals because discarded historical dimensions cannot be recovered
 * honestly by resumming day rows.
 */
export function selectUsageRange(
  usage: UsageStatsGetResult,
  range: UsageRangeKey,
): UsageStatsGetResult {
  const { startDay, endDay } = getUsageRangeBounds(usage, range);
  const startIndex = usageDayToUtcDayIndex(startDay)!;
  const endIndex = currentDayIndex(usage);
  const byDay = new Map<string, UsageStatsDay>();
  for (const row of usage.days) {
    const dayIndex = usageDayToUtcDayIndex(row.day);
    if (dayIndex !== undefined && dayIndex >= startIndex && dayIndex <= endIndex) {
      byDay.set(row.day, row);
    }
  }
  // The full detail response's today row includes in-flight generating time.
  // Replace an existing persisted day instead of adding it twice; also admit
  // today when sparse history does not yet contain a committed row for it.
  byDay.set(endDay, usage.today);

  if (range === "all") {
    return {
      ...usage,
      days: Array.from(byDay.values()).toSorted((left, right) => compareText(left.day, right.day)),
    };
  }

  // At most ninety rows are materialized. Filling calendar gaps here makes all
  // dashboard consumers agree on inactive days instead of treating N recorded
  // rows as an N-day window or averaging away a quiet period.
  const days: UsageStatsDay[] = [];
  let totals = emptyTotals();
  for (let dayIndex = startIndex; dayIndex <= endIndex; dayIndex += 1) {
    const day = utcDayIndexToUsageDay(dayIndex);
    const row = byDay.get(day) ?? { day, ...emptyTotals() };
    days.push(row);
    totals = {
      generatingMs: totals.generatingMs + row.generatingMs,
      userMessages: totals.userMessages + row.userMessages,
      inputTokens: totals.inputTokens + row.inputTokens,
      cachedInputTokens: totals.cachedInputTokens + row.cachedInputTokens,
      cacheWriteInputTokens: totals.cacheWriteInputTokens + row.cacheWriteInputTokens,
      outputTokens: totals.outputTokens + row.outputTokens,
      reasoningOutputTokens: totals.reasoningOutputTokens + row.reasoningOutputTokens,
    };
  }

  const tokenBreakdownDays = usage.tokenBreakdownDays?.filter((row) => {
    const dayIndex = usageDayToUtcDayIndex(row.day);
    return dayIndex !== undefined && dayIndex >= startIndex && dayIndex <= endIndex;
  });
  // Structured keys avoid collisions and prototype interpretation even when a
  // provider supplies unusual but contract-valid model names.
  const byProvider = new Map<ProviderDriverKind, Map<string, UsageStatsTokenBreakdownEntry>>();
  for (const row of tokenBreakdownDays ?? []) {
    let models = byProvider.get(row.provider);
    if (models === undefined) {
      models = new Map();
      byProvider.set(row.provider, models);
    }
    const previous = models.get(row.model);
    models.set(
      row.model,
      previous === undefined
        ? {
            provider: row.provider,
            model: row.model,
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            cacheWriteInputTokens: row.cacheWriteInputTokens,
            outputTokens: row.outputTokens,
            reasoningOutputTokens: row.reasoningOutputTokens,
          }
        : addTokens(previous, row),
    );
  }
  const tokenBreakdown = Array.from(byProvider.values()).flatMap((models) =>
    Array.from(models.values()),
  );
  tokenBreakdown.sort(
    (left, right) =>
      compareText(left.provider, right.provider) ||
      right.outputTokens - left.outputTokens ||
      compareText(left.model, right.model),
  );

  const modelTime = usage.modelGeneratingTime;
  let modelGeneratingTime = modelTime;
  if (modelTime !== undefined) {
    let timeAvailable = true;
    const timeDays = modelTime.days.filter((row) => {
      const dayIndex = usageDayToUtcDayIndex(row.day);
      return dayIndex !== undefined && dayIndex >= startIndex && dayIndex <= endIndex;
    });
    // Time is its own prospective ledger. Token-day availability, aggregate
    // generating time and current activity counts cannot supply model time.
    // Nested maps preserve exact identities without delimiter collisions or
    // interpreting provider-controlled model strings as object properties.
    const byTimeProvider = new Map<
      ProviderDriverKind,
      Map<string, UsageStatsModelGeneratingTimeEntry>
    >();
    for (const row of timeDays) {
      let models = byTimeProvider.get(row.provider);
      if (models === undefined) {
        models = new Map();
        byTimeProvider.set(row.provider, models);
      }
      const previous = models.get(row.model);
      const previousMs = previous?.generatingMs ?? 0;
      if (
        !Number.isSafeInteger(row.generatingMs) ||
        row.generatingMs < 0 ||
        row.generatingMs > Number.MAX_SAFE_INTEGER - previousMs
      ) {
        // Match the server's all-or-unavailable policy. A rounded or partial
        // duration is not an honest recorded total, even if each row decoded.
        timeAvailable = false;
        break;
      }
      models.set(row.model, {
        provider: row.provider,
        model: row.model,
        generatingMs: previousMs + row.generatingMs,
      });
    }
    const timeTotals = Array.from(byTimeProvider.values()).flatMap((models) =>
      Array.from(models.values()),
    );
    timeTotals.sort(
      (left, right) =>
        compareText(left.provider, right.provider) ||
        right.generatingMs - left.generatingMs ||
        compareText(left.model, right.model),
    );
    modelGeneratingTime = timeAvailable
      ? { ...modelTime, days: timeDays, totals: timeTotals }
      : undefined;
  }

  const { modelGeneratingTime: _originalModelTime, ...usageWithoutModelTime } = usage;

  return {
    ...usageWithoutModelTime,
    totals,
    days,
    tokenBreakdown,
    // Preserve unavailable attribution as absent so callers can distinguish an
    // older server from an available daily ledger with no observations here.
    ...(tokenBreakdownDays === undefined ? {} : { tokenBreakdownDays }),
    // An older response has no container at all; do not turn unavailable
    // recording into an available but zero-valued time ledger.
    ...(modelGeneratingTime === undefined ? {} : { modelGeneratingTime }),
  };
}
