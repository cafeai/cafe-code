/**
 * Watermark-based token delta extraction for usage stats.
 *
 * `thread.token-usage.updated` snapshots carry different counter semantics per
 * provider adapter, so lifetime "tokens generated" cannot be a plain sum:
 *
 * - Claude sets `outputTokens` to the current API message's `output_tokens`,
 *   which grows while a message streams and resets when the next message
 *   starts. Thinking tokens are already included. `usedTokens` is the whole
 *   context window, so it is useless here.
 * - Codex sets `outputTokens` to the *previous request's* final count (its
 *   `usage.last`), which neither grows nor resets predictably — but it also
 *   reports a session-cumulative `totalOutputTokens`, which does. Its
 *   `reasoningOutputTokens` is a subset of output; adding it would double
 *   count.
 * - Providers that emit no token-usage snapshots can report per-turn totals
 *   on `turn.completed`; the service counts that fallback separately.
 *
 * The watermark rule below turns any monotone-with-resets counter into exact
 * deltas: growth is counted as the difference, and a drop is treated as a
 * counter reset whose new value is counted in full. Known residual error:
 * a reset to a value at or above the previous watermark is indistinguishable
 * from growth and undercounts by the previous watermark — for Claude this
 * requires a new message's first snapshot to already exceed the previous
 * message's final count, which streaming makes rare and small.
 */
import type { ThreadTokenUsageSnapshot } from "@cafecode/contracts";

export interface OutputCounter {
  readonly value: number;
  /**
   * `session-cumulative` counters survive turn boundaries, so their first
   * observation after a process restart may already include history that was
   * counted before; `per-message` counters are short-lived and safe to count
   * from zero.
   */
  readonly kind: "session-cumulative" | "per-message";
}

/**
 * The counters usage accounting tracks. Cost is dominated by input on every
 * provider we ship, and cached reads price differently from fresh input, so the
 * ledger needs each of these separately rather than output alone.
 *
 * `cachedInputTokens` and `cacheWriteInputTokens` are subsets of
 * `inputTokens`; `reasoningOutputTokens` is a subset of `outputTokens`.
 * Consumers must not add subsets to their parent or they will double count.
 */
export const USAGE_TOKEN_FIELDS = [
  "outputTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "reasoningOutputTokens",
] as const;
export type UsageTokenField = (typeof USAGE_TOKEN_FIELDS)[number];

/**
 * Session-cumulative counterpart for each field, when the adapter reports one.
 * A cumulative counter is always preferred: the per-request values neither grow
 * nor reset predictably, so they cannot be summed or watermarked safely.
 */
const CUMULATIVE_FIELD: Record<UsageTokenField, keyof ThreadTokenUsageSnapshot> = {
  outputTokens: "totalOutputTokens",
  inputTokens: "totalInputTokens",
  cachedInputTokens: "totalCachedInputTokens",
  cacheWriteInputTokens: "totalCacheWriteInputTokens",
  reasoningOutputTokens: "totalReasoningOutputTokens",
};

/** Pick the best available counter for `field` from a usage snapshot. */
export function selectCounter(
  snapshot: ThreadTokenUsageSnapshot,
  field: UsageTokenField,
): OutputCounter | undefined {
  const cumulative = snapshot[CUMULATIVE_FIELD[field]];
  if (typeof cumulative === "number") {
    return { value: cumulative, kind: "session-cumulative" };
  }
  const perMessage = snapshot[field];
  if (typeof perMessage === "number") {
    return { value: perMessage, kind: "per-message" };
  }
  return undefined;
}

/** Pick the best available output-token counter from a usage snapshot. */
export function selectOutputCounter(snapshot: ThreadTokenUsageSnapshot): OutputCounter | undefined {
  return selectCounter(snapshot, "outputTokens");
}

export interface TokenDeltaResult {
  readonly delta: number;
  readonly watermark: number;
}

/**
 * Compute how many new output tokens `next` represents relative to the last
 * observed watermark. `countFirstObservation` decides whether a thread's very
 * first snapshot is counted in full (true for fresh sessions) or only used to
 * seed the watermark (false when attaching to a session whose earlier output
 * may already have been counted, e.g. a provider-daemon reattach).
 */
export function tokenDelta(
  previous: number | undefined,
  next: number,
  countFirstObservation: boolean,
): TokenDeltaResult {
  if (previous === undefined) {
    return { delta: countFirstObservation ? next : 0, watermark: next };
  }
  if (next >= previous) {
    return { delta: next - previous, watermark: next };
  }
  return { delta: next, watermark: next };
}
