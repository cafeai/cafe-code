import type { UsageAccountingModel, UsageAccountingSnapshot } from "@cafecode/contracts";

/**
 * Official contract: https://code.claude.com/docs/en/agent-sdk/cost-tracking
 * `modelUsage` is cumulative for one query(), including children/sidechains;
 * a new query or conversation reset begins another epoch. Assistant message
 * IDs identify API responses, even when parallel tools produce several SDK
 * messages. Their input/cache counts are usable; their output is a placeholder.
 * Keep this billing state separate from the live primary context-window meter.
 */
const MAX_MODELS = 64;
const MAX_REQUEST_IDS = 16_384;
const FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;
type Counts = { -readonly [K in Exclude<keyof UsageAccountingModel, "model">]: number };
const zero = (): Counts => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
});
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
// Billing rows need a model slug, never an ARN, account-qualified endpoint,
// filesystem path, or arbitrary provider text. Gateway aliases that are not
// safe slugs can still settle through the SDK's canonicalModel metadata.
const modelName = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._[\]-]{0,255}$/.test(value.trim())
    ? value.trim()
    : undefined;
const add = (left: number, right: number) => Math.min(Number.MAX_SAFE_INTEGER, left + right);

export interface ClaudeUsageAccounting {
  readonly scopeId: string;
  revision: number;
  readonly seenRequestIds: Set<string>;
  readonly settled: Map<string, Counts>;
  readonly pending: Map<string, Counts>;
  readonly published: Map<string, Counts>;
  incomplete: boolean;
  completeness: UsageAccountingSnapshot["completeness"] | undefined;
}

export const makeClaudeUsageAccounting = (scopeId: string): ClaudeUsageAccounting => ({
  scopeId,
  revision: 0,
  seenRequestIds: new Set(),
  settled: new Map(),
  pending: new Map(),
  published: new Map(),
  incomplete: false,
  completeness: undefined,
});

function publish(
  state: ClaudeUsageAccounting,
  completeness: UsageAccountingSnapshot["completeness"],
): UsageAccountingSnapshot | undefined {
  const effectiveCompleteness = state.incomplete ? "input-only" : completeness;
  let changed = false;
  for (const model of new Set([...state.settled.keys(), ...state.pending.keys()])) {
    const prior = state.published.get(model) ?? zero();
    const settled = state.settled.get(model) ?? zero();
    const pending = state.pending.get(model) ?? zero();
    const next = zero();
    for (const field of FIELDS) {
      // A crash can emit zeroed results. Counter regressions are never a reset:
      // only the SDK's explicit conversation-reset edge changes the epoch.
      next[field] = Math.max(prior[field], add(settled[field], pending[field]));
      changed ||= next[field] !== prior[field];
    }
    state.published.set(model, next);
  }
  if (
    (!changed && effectiveCompleteness === state.completeness) ||
    state.published.size === 0 ||
    state.revision >= Number.MAX_SAFE_INTEGER
  )
    return undefined;
  state.revision += 1;
  state.completeness = effectiveCompleteness;
  return {
    scopeId: state.scopeId,
    revision: state.revision,
    models: Array.from(state.published, ([model, counts]) => ({ model, ...counts })).toSorted(
      (a, b) => a.model.localeCompare(b.model),
    ),
    completeness: effectiveCompleteness,
  };
}

/** Observe only primary assistant snapshots, not repeated partial text frames. */
export function observeClaudeAssistantUsage(
  state: ClaudeUsageAccounting,
  value: unknown,
): UsageAccountingSnapshot | undefined {
  const message = record(value);
  if (!message || message.parent_tool_use_id) return undefined;
  const assistant = record(message.message);
  const usage = record(assistant?.usage);
  const id = assistant?.id;
  const model = modelName(assistant?.model);
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 256 ||
    !model ||
    !usage ||
    state.seenRequestIds.has(id)
  )
    return undefined;
  const fresh = count(usage.input_tokens);
  const cached = count(usage.cache_read_input_tokens ?? 0);
  const written = count(usage.cache_creation_input_tokens ?? 0);
  if (fresh === undefined || cached === undefined || written === undefined) return undefined;
  const input = fresh + cached + written;
  if (!Number.isSafeInteger(input)) return undefined;
  if (
    !Number.isSafeInteger(
      Array.from(state.published.values()).reduce(
        (total, counts) => total + counts.inputTokens,
        0,
      ) + input,
    )
  )
    return undefined;
  // Never evict IDs and risk recounting late duplicates. If an exceptionally
  // long query exceeds the bound, stop the incomplete fallback; authoritative
  // result totals can still settle every token without retaining request IDs.
  if (
    state.seenRequestIds.size >= MAX_REQUEST_IDS ||
    (!state.published.has(model) && state.published.size >= MAX_MODELS)
  ) {
    state.incomplete = true;
    return undefined;
  }
  const pending = state.pending.get(model) ?? zero();
  if (
    !Number.isSafeInteger(
      pending.inputTokens + input + (state.settled.get(model)?.inputTokens ?? 0),
    )
  ) {
    state.incomplete = true;
    return undefined;
  }
  state.seenRequestIds.add(id);
  pending.inputTokens += input;
  pending.cachedInputTokens = add(pending.cachedInputTokens, cached);
  pending.cacheWriteInputTokens = add(pending.cacheWriteInputTokens, written);
  state.pending.set(model, pending);
  return publish(state, "input-only");
}

/** Every result settles the query so far, including intermediate steer results. */
export function observeClaudeResultUsage(
  state: ClaudeUsageAccounting,
  value: unknown,
): UsageAccountingSnapshot | undefined {
  const result = record(value);
  const modelUsage = record(result?.modelUsage);
  if (!modelUsage) return undefined;
  const entries = Object.entries(modelUsage);
  if (entries.length === 0 || entries.length > MAX_MODELS) return undefined;
  const settled = new Map<string, Counts>();
  for (const [rawModel, rawUsage] of entries) {
    const usage = record(rawUsage);
    if (!usage) return undefined;
    const rawName = modelName(rawModel);
    const canonical = modelName(usage.canonicalModel);
    // SDK ModelUsage.canonicalModel is the pricing lookup slug and may differ
    // from its raw provider/alias map key. Match a prior assistant observation
    // via that explicit alias, while retaining any already-published raw key:
    // historical attribution cannot be silently moved between model buckets.
    const model = rawName && state.published.has(rawName) ? rawName : (canonical ?? rawName);
    if (!model) return undefined;
    const fresh = count(usage.inputTokens);
    const cached = count(usage.cacheReadInputTokens);
    const written = count(usage.cacheCreationInputTokens);
    const output = count(usage.outputTokens);
    const reasoning = count(usage.thinkingTokens ?? 0);
    if (
      fresh === undefined ||
      cached === undefined ||
      written === undefined ||
      output === undefined ||
      reasoning === undefined ||
      reasoning > output
    )
      return undefined;
    const input = fresh + cached + written;
    if (!Number.isSafeInteger(input)) return undefined;
    const combined = settled.get(model) ?? zero();
    const incoming = {
      inputTokens: input,
      cachedInputTokens: cached,
      cacheWriteInputTokens: written,
      outputTokens: output,
      reasoningOutputTokens: reasoning,
    };
    for (const field of FIELDS) {
      if (!Number.isSafeInteger(combined[field] + incoming[field])) return undefined;
      combined[field] += incoming[field];
    }
    settled.set(model, combined);
  }
  for (const field of FIELDS) {
    if (
      !Number.isSafeInteger(
        Array.from(settled.values()).reduce((total, counts) => total + counts[field], 0),
      )
    )
      return undefined;
  }
  // Missing/regressing model rows cannot prove settlement. In particular a
  // zeroed error result after a crash must retain the last successful result
  // plus deduplicated main-loop input observed since then.
  for (const [model, previous] of state.settled) {
    const next = settled.get(model);
    if (!next || FIELDS.some((field) => next[field] < previous[field])) return undefined;
  }
  for (const [model, previous] of state.published) {
    const next = settled.get(model);
    if (
      !next ||
      next.inputTokens < previous.inputTokens ||
      next.cachedInputTokens < previous.cachedInputTokens ||
      next.cacheWriteInputTokens < previous.cacheWriteInputTokens
    )
      return undefined;
    if (
      next.inputTokens - next.cachedInputTokens - next.cacheWriteInputTokens <
        previous.inputTokens - previous.cachedInputTokens - previous.cacheWriteInputTokens ||
      next.outputTokens - next.reasoningOutputTokens <
        previous.outputTokens - previous.reasoningOutputTokens
    )
      return undefined;
  }
  state.settled.clear();
  for (const [model, counts] of settled) state.settled.set(model, counts);
  state.pending.clear();
  state.incomplete = false;
  return publish(state, "complete");
}
