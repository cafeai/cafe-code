/**
 * Model pricing and cost computation for the Usage page.
 *
 * Two sources, in order: a rate the user entered in Settings, then the bundled
 * table below. A model matched by neither is **unpriced** — its tokens are
 * still counted, but its cost is not guessed. The Usage page reports the
 * unpriced share so a number that only covers part of the spend can never be
 * mistaken for the whole of it.
 *
 * Rates are USD per million tokens, matching how every provider publishes them.
 * They move: the bundled table is a convenience so the page works out of the
 * box, not a source of truth, and a user override always wins.
 *
 * Cost is computed from four separate counters because cache reads and cache
 * writes are priced very differently from fresh input — on a long-running
 * agent session cached reads dominate token volume, so folding them into one
 * input rate would overstate spend by roughly an order of magnitude.
 */

export interface ModelRate {
  /** USD per million fresh (uncached) input tokens. */
  readonly input: number;
  /** USD per million cached input tokens read back. */
  readonly cachedInput: number;
  /** USD per million tokens written into the cache. */
  readonly cacheWrite: number;
  /** USD per million output tokens, reasoning included. */
  readonly output: number;
}

export interface TokenCountsForCost {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
}

/**
 * Bundled rates, keyed by a normalized model id. Entries are matched by exact
 * id first, then by longest matching prefix, so dated releases
 * (`claude-opus-4-5-20260101`) inherit their family's rate without an entry
 * each. Keep prefixes specific enough that a cheaper sibling cannot absorb an
 * expensive model's traffic.
 */
const BUNDLED_RATES: ReadonlyArray<readonly [prefix: string, rate: ModelRate]> = [
  // Anthropic
  ["claude-opus-4", { input: 15, cachedInput: 1.5, cacheWrite: 18.75, output: 75 }],
  ["claude-opus", { input: 15, cachedInput: 1.5, cacheWrite: 18.75, output: 75 }],
  ["claude-sonnet", { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }],
  ["claude-haiku", { input: 0.8, cachedInput: 0.08, cacheWrite: 1, output: 4 }],
  // Fable 5.1 cuts cache reads from 0.1x to 0.025x of base input, so keep its
  // longer prefix separate from the Fable 5 family fallback.
  ["claude-fable-5-1", { input: 10, cachedInput: 0.25, cacheWrite: 12.5, output: 50 }],
  ["claude-fable", { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 }],
  ["claude", { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }],
  // OpenAI
  ["gpt-5", { input: 1.25, cachedInput: 0.125, cacheWrite: 1.25, output: 10 }],
  ["gpt-4.1", { input: 2, cachedInput: 0.5, cacheWrite: 2, output: 8 }],
  ["gpt-4o", { input: 2.5, cachedInput: 1.25, cacheWrite: 2.5, output: 10 }],
  ["o3", { input: 2, cachedInput: 0.5, cacheWrite: 2, output: 8 }],
  ["gpt", { input: 1.25, cachedInput: 0.125, cacheWrite: 1.25, output: 10 }],
  // xAI
  ["grok", { input: 3, cachedInput: 0.75, cacheWrite: 3, output: 15 }],
];

export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * Resolve a rate for `model`, preferring a user override. Returns undefined
 * when nothing matches; callers must treat that as unpriced rather than free.
 */
export function resolveModelRate(
  model: string,
  overrides?: Readonly<Record<string, ModelRate>>,
): ModelRate | undefined {
  const id = normalizeModelId(model);
  if (id.length === 0) return undefined;

  if (overrides) {
    const exact = overrides[id];
    if (exact) return exact;
    // Overrides match by prefix too, so one entry can cover a whole family.
    let best: { length: number; rate: ModelRate } | undefined;
    for (const [key, rate] of Object.entries(overrides)) {
      const normalized = normalizeModelId(key);
      if (normalized.length > 0 && id.startsWith(normalized)) {
        if (!best || normalized.length > best.length) {
          best = { length: normalized.length, rate };
        }
      }
    }
    if (best) return best.rate;
  }

  let match: { length: number; rate: ModelRate } | undefined;
  for (const [prefix, rate] of BUNDLED_RATES) {
    if (id.startsWith(prefix) && (!match || prefix.length > match.length)) {
      match = { length: prefix.length, rate };
    }
  }
  return match?.rate;
}

const PER_MILLION = 1_000_000;

/**
 * Cost in USD for one model's counters.
 *
 * `cachedInputTokens` and `cacheWriteInputTokens` are subsets of
 * `inputTokens`, so fresh input is the remainder. Clamping at zero keeps a
 * provider that reports a cache figure larger than its own input total (or a
 * day recorded before the token-detail migration) from producing a negative
 * charge.
 */
export function computeModelCost(counts: TokenCountsForCost, rate: ModelRate): number {
  const cached = Math.max(0, counts.cachedInputTokens);
  const written = Math.max(0, counts.cacheWriteInputTokens);
  const fresh = Math.max(0, counts.inputTokens - cached - written);
  return (
    (fresh * rate.input +
      cached * rate.cachedInput +
      written * rate.cacheWrite +
      Math.max(0, counts.outputTokens) * rate.output) /
    PER_MILLION
  );
}

export interface CostRollup {
  /** Total USD across every priced model. */
  readonly cost: number;
  /** Tokens belonging to models we could price. */
  readonly pricedTokens: number;
  /** Tokens belonging to models we could not price. */
  readonly unpricedTokens: number;
  /**
   * What a run would have cost with no cache at all, minus what it did cost.
   * This is the headline saving figure and is only meaningful for rows that
   * actually carry cache counters.
   */
  readonly cacheSavings: number;
}

const EMPTY_ROLLUP: CostRollup = {
  cost: 0,
  pricedTokens: 0,
  unpricedTokens: 0,
  cacheSavings: 0,
};

export interface CostableEntry extends TokenCountsForCost {
  readonly model: string;
}

/** Sum cost across entries, tracking how much of the volume we could price. */
export function rollUpCost(
  entries: readonly CostableEntry[],
  overrides?: Readonly<Record<string, ModelRate>>,
): CostRollup {
  if (entries.length === 0) return EMPTY_ROLLUP;

  let cost = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  let cacheSavings = 0;

  for (const entry of entries) {
    const tokens =
      Math.max(0, entry.inputTokens) +
      Math.max(0, entry.outputTokens) -
      // inputTokens already contains the cache subsets; do not count twice.
      0;
    const rate = resolveModelRate(entry.model, overrides);
    if (rate === undefined) {
      unpricedTokens += tokens;
      continue;
    }
    pricedTokens += tokens;
    const actual = computeModelCost(entry, rate);
    cost += actual;

    // Everything the cache served, charged as if it had been fresh input.
    const cached = Math.max(0, entry.cachedInputTokens);
    if (cached > 0) {
      cacheSavings += (cached * (rate.input - rate.cachedInput)) / PER_MILLION;
    }
  }

  return { cost, pricedTokens, unpricedTokens, cacheSavings };
}

/** Share of token volume we could attach a rate to, 0..1. `null` when empty. */
export function pricedShare(rollup: CostRollup): number | null {
  const total = rollup.pricedTokens + rollup.unpricedTokens;
  return total === 0 ? null : rollup.pricedTokens / total;
}
