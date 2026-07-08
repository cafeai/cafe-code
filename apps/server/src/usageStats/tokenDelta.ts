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
 * - Gemini emits no token-usage events at all; its per-turn totals arrive on
 *   `turn.completed` and are counted separately by the service.
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

/** Pick the best available output-token counter from a usage snapshot. */
export function selectOutputCounter(snapshot: ThreadTokenUsageSnapshot): OutputCounter | undefined {
  if (snapshot.totalOutputTokens !== undefined) {
    return { value: snapshot.totalOutputTokens, kind: "session-cumulative" };
  }
  if (snapshot.outputTokens !== undefined) {
    return { value: snapshot.outputTokens, kind: "per-message" };
  }
  return undefined;
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
