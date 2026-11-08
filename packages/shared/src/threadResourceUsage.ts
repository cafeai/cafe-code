import type {
  OrchestrationThreadActivity,
  ServerProviderAccountRateLimits,
  ServerProviderAccountRateLimitSnapshot,
  ThreadTokenUsageSnapshot,
} from "@cafecode/contracts";

/** Data shared by the renderer and read-only management tools. These facts are
 * observations, not permission to submit work or a promise of live capacity. */
type NullableTokenUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ThreadContextWindowUsage = Omit<
  NullableTokenUsage,
  "maxTokens" | "totalProcessedTokens" | "compactsAutomatically" | "autoCompactTokenLimit"
> & {
  readonly maxTokens: number | null;
  readonly totalProcessedTokens: number | null;
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  /** Missing native policy is unknown, not evidence that compaction is off. */
  readonly compactsAutomatically: boolean | null;
  readonly autoCompactTokenLimit: number | null;
};

export type ThreadContextWindowObservation = ThreadContextWindowUsage & {
  readonly updatedAt: string;
};

/** Read data properties only. Persisted legacy payloads are unknown, and a
 * received accessor or failed proxy observation must not execute a getter or
 * turn an opaque thrown value into presentation/log text. */
function field(value: unknown, name: string): unknown {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveCounter(value: unknown): number | null {
  const result = counter(value);
  return result !== null && result > 0 ? result : null;
}

function label(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Provider adapters have already normalized native context occupancy. Codex
 * last.totalTokens includes reasoning; cumulative processed tokens, a saved
 * context override and requested compaction policy must never replace/add to
 * usedTokens or the native maxTokens. Zero occupancy is not a usable snapshot,
 * matching the existing ingestion and renderer contract. */
export function deriveContextWindowUsage(payload: unknown): ThreadContextWindowUsage | null {
  const usedTokens = positiveCounter(field(payload, "usedTokens"));
  if (usedTokens === null) return null;
  const maxTokens = positiveCounter(field(payload, "maxTokens"));
  const usedPercentage = maxTokens === null ? null : Math.min(100, (usedTokens / maxTokens) * 100);
  const compacting = field(payload, "compactsAutomatically");
  return {
    usedTokens,
    maxTokens,
    totalProcessedTokens: counter(field(payload, "totalProcessedTokens")),
    remainingTokens: maxTokens === null ? null : Math.max(0, Math.round(maxTokens - usedTokens)),
    usedPercentage,
    remainingPercentage: usedPercentage === null ? null : Math.max(0, 100 - usedPercentage),
    inputTokens: counter(field(payload, "inputTokens")),
    cachedInputTokens: counter(field(payload, "cachedInputTokens")),
    cacheWriteInputTokens: counter(field(payload, "cacheWriteInputTokens")),
    totalCacheWriteInputTokens: counter(field(payload, "totalCacheWriteInputTokens")),
    outputTokens: counter(field(payload, "outputTokens")),
    reasoningOutputTokens: counter(field(payload, "reasoningOutputTokens")),
    lastUsedTokens: counter(field(payload, "lastUsedTokens")),
    lastInputTokens: counter(field(payload, "lastInputTokens")),
    lastCachedInputTokens: counter(field(payload, "lastCachedInputTokens")),
    lastCacheWriteInputTokens: counter(field(payload, "lastCacheWriteInputTokens")),
    lastOutputTokens: counter(field(payload, "lastOutputTokens")),
    lastReasoningOutputTokens: counter(field(payload, "lastReasoningOutputTokens")),
    toolUses: counter(field(payload, "toolUses")),
    durationMs: counter(field(payload, "durationMs")),
    compactsAutomatically: typeof compacting === "boolean" ? compacting : null,
    autoCompactTokenLimit: positiveCounter(field(payload, "autoCompactTokenLimit")),
  };
}

/** Callers supply canonical chronological order. Timestamp is the recorded
 * observation only: this helper does not claim freshness or infer an owner. */
export function deriveLatestContextWindowUsage(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload" | "createdAt">>,
): ThreadContextWindowObservation | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (field(activity, "kind") !== "context-window.updated") continue;
    const usage = deriveContextWindowUsage(field(activity, "payload"));
    const updatedAt = field(activity, "createdAt");
    if (!usage || typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt)))
      continue;
    return { ...usage, updatedAt };
  }
  return null;
}

export interface CodexRateLimitBucketData {
  readonly id: string;
  /** Null lets the renderer localize its generic legacy-account label. */
  readonly label: string | null;
  readonly snapshot: ServerProviderAccountRateLimitSnapshot;
}

/** Account quota is shared by every chat using that account. A named map is
 * authoritative for a represented identity; equal values or model labels do
 * not identify a bucket. Preserve all distinct buckets and the unrepresented
 * legacy view. Native timestamps may describe a sparse aggregate update, not
 * a fresh read of every retained window or credit field. */
export function deriveCodexRateLimitBuckets(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
): readonly CodexRateLimitBucketData[] {
  if (!rateLimits) return [];
  const byId = field(rateLimits, "rateLimitsByLimitId");
  let ids: readonly string[] = [];
  if (record(byId)) {
    try {
      ids = Object.keys(byId);
    } catch {
      ids = [];
    }
  }
  const buckets: CodexRateLimitBucketData[] = ids.flatMap((id) => {
    const snapshot = field(byId, id);
    return record(snapshot)
      ? [
          {
            id,
            label: label(field(snapshot, "limitName")) ?? label(field(snapshot, "limitId")) ?? id,
            snapshot: snapshot as ServerProviderAccountRateLimitSnapshot,
          },
        ]
      : [];
  });
  const legacy = field(rateLimits, "rateLimits");
  if (record(legacy)) {
    const legacyId = label(field(legacy, "limitId")) ?? "codex";
    if (
      !buckets.some(
        (bucket) => bucket.id === legacyId || field(bucket.snapshot, "limitId") === legacyId,
      )
    ) {
      buckets.unshift({
        id: legacyId,
        label: label(field(legacy, "limitName")) ?? label(field(legacy, "limitId")),
        snapshot: legacy as ServerProviderAccountRateLimitSnapshot,
      });
    }
  }
  return buckets.toSorted((left, right) =>
    left.id === "codex" ? (right.id === "codex" ? 0 : -1) : right.id === "codex" ? 1 : 0,
  );
}

export interface ProviderRateLimitWindowUsage {
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly windowDurationMins: number | null;
  /** Native epoch seconds; never milliseconds or an assumed weekly reset. */
  readonly resetsAt: number | null;
}

/** Missing utilization stays unknown even if a reset is known. In particular,
 * zero reported use is real 100% remaining; absence is not zero. */
export function deriveProviderRateLimitWindow(
  window: unknown,
): ProviderRateLimitWindowUsage | null {
  if (!record(window)) return null;
  const received = field(window, "usedPercent");
  const usedPercent =
    typeof received === "number" && Number.isFinite(received) && received >= 0
      ? Math.min(100, received)
      : null;
  return {
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    windowDurationMins: counter(field(window, "windowDurationMins")),
    resetsAt: counter(field(window, "resetsAt")),
  };
}

/** Upstream's aggregate remains authoritative when credit rows are omitted,
 * redacted or stale. Do not count rows or turn unknown availability into zero. */
export function deriveAvailableRateLimitResetCount(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
): number | null {
  return counter(field(field(rateLimits, "rateLimitResetCredits"), "availableCount"));
}
