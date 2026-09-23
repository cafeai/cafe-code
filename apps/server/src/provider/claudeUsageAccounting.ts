import type { UsageAccountingModel, UsageAccountingSnapshot } from "@cafecode/contracts";

/**
 * Official contract: https://code.claude.com/docs/en/agent-sdk/cost-tracking
 * `modelUsage` includes children/sidechains. Claude Code 2.1.277+ also restores
 * saved totals on resume/fork, so each Cafe query epoch subtracts its exact
 * pre-launch baseline. A conversation reset starts from zero. Assistant message
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
export type ClaudeUsageCounts = {
  -readonly [K in Exclude<keyof UsageAccountingModel, "model">]: number;
};
type Counts = ClaudeUsageCounts;
export type ClaudeUsageBaseline =
  | { readonly status: "known"; readonly models: ReadonlyMap<string, Counts> }
  | { readonly status: "unavailable" };
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
const attributedModelName = (
  rawModel: string,
  usage: Record<string, unknown>,
  published: ReadonlyMap<string, Counts>,
): string | undefined => {
  const rawName = modelName(rawModel);
  return rawName && published.has(rawName) ? rawName : (modelName(usage.canonicalModel) ?? rawName);
};
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
  /** Undefined means restored history has not yet been safely separated. */
  baseline: ReadonlyMap<string, Counts> | undefined;
  readonly resumeBaseline: ClaudeUsageBaseline | undefined;
  awaitingVersion: boolean;
  baselineIncomplete: boolean;
  readonly carried: Map<string, Counts>;
}

export const makeClaudeUsageAccounting = (
  scopeId: string,
  resumeBaseline?: ClaudeUsageBaseline,
): ClaudeUsageAccounting => ({
  scopeId,
  revision: 0,
  seenRequestIds: new Set(),
  settled: new Map(),
  pending: new Map(),
  published: new Map(),
  incomplete: false,
  completeness: undefined,
  baseline: resumeBaseline ? undefined : new Map(),
  resumeBaseline,
  awaitingVersion: resumeBaseline !== undefined,
  baselineIncomplete: false,
  carried: new Map(),
});

/** Use the configured CLI's own init version, never the imported SDK's pin. */
export function configureClaudeUsageVersion(state: ClaudeUsageAccounting, version: unknown): void {
  if (!state.awaitingVersion || typeof version !== "string") return;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return;
  const restoresHistory =
    major! > 2 || (major === 2 && (minor! > 1 || (minor === 1 && patch! >= 277)));
  state.baseline = restoresHistory
    ? state.resumeBaseline?.status === "known"
      ? state.resumeBaseline.models
      : undefined
    : new Map();
  state.awaitingVersion = false;
}

function publish(
  state: ClaudeUsageAccounting,
  completeness: UsageAccountingSnapshot["completeness"],
): UsageAccountingSnapshot | undefined {
  const effectiveCompleteness =
    state.incomplete || state.baselineIncomplete ? "input-only" : completeness;
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

/** Decode only bounded numeric/model metadata; transcript content never escapes. */
export function decodeClaudeCumulativeUsage(
  value: unknown,
  published: ReadonlyMap<string, Counts> = new Map(),
): Map<string, Counts> | undefined {
  const modelUsage = record(value);
  if (!modelUsage) return undefined;
  const entries = Object.entries(modelUsage);
  if (entries.length > MAX_MODELS) return undefined;
  const settled = new Map<string, Counts>();
  for (const [rawModel, rawUsage] of entries) {
    const usage = record(rawUsage);
    if (!usage) return undefined;
    // SDK ModelUsage.canonicalModel is the pricing lookup slug and may differ
    // from its raw provider/alias map key. Match a prior assistant observation
    // via that explicit alias, while retaining any already-published raw key:
    // historical attribution cannot be silently moved between model buckets.
    const model = attributedModelName(rawModel, usage, published);
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
  return settled;
}

/**
 * The native cost-state writer keeps raw model map keys but omits each row's
 * canonicalModel. Restore that attribution only from this result's exact raw
 * key and explicit canonical metadata, using the same published-key preference
 * as live totals. Several gateway aliases can name one model and must be added
 * before subtraction. Never guess an alias from its spelling, move already
 * published usage, or rewrite the saved map: a later result must still prove
 * its own raw-to-canonical mapping.
 */
function attributeRestoredBaseline(
  baseline: ReadonlyMap<string, Counts>,
  rawUsage: unknown,
  published: ReadonlyMap<string, Counts>,
): ReadonlyMap<string, Counts> | undefined {
  const rows = record(rawUsage);
  if (!rows) return undefined;
  const aliases = new Map<string, { model: string; counts: Counts }>();
  for (const [rawModel, value] of Object.entries(rows)) {
    const rawName = modelName(rawModel);
    const usage = record(value);
    if (!rawName || !usage) continue;
    const model = attributedModelName(rawModel, usage, published);
    const counts = model
      ? decodeClaudeCumulativeUsage({ [rawModel]: value }, published)?.get(model)
      : undefined;
    // A normalized-key collision cannot identify which saved row a live row
    // extends. Refuse settlement rather than hiding a reset inside an alias sum.
    if (aliases.has(rawName)) return undefined;
    if (model && counts) aliases.set(rawName, { model, counts });
  }
  const normalized = new Map<string, Counts>();
  for (const [rawModel, counts] of baseline) {
    const current = aliases.get(rawModel);
    if (
      !current ||
      FIELDS.some((field) => current.counts[field] < counts[field]) ||
      current.counts.inputTokens -
        current.counts.cachedInputTokens -
        current.counts.cacheWriteInputTokens <
        counts.inputTokens - counts.cachedInputTokens - counts.cacheWriteInputTokens ||
      current.counts.outputTokens - current.counts.reasoningOutputTokens <
        counts.outputTokens - counts.reasoningOutputTokens
    )
      return undefined;
    const model = current.model;
    const combined = normalized.get(model) ?? zero();
    for (const field of FIELDS) {
      combined[field] += counts[field];
      if (!Number.isSafeInteger(combined[field])) return undefined;
    }
    normalized.set(model, combined);
  }
  return normalized;
}

/** Every result settles the query so far, including intermediate steer results. */
export function observeClaudeResultUsage(
  state: ClaudeUsageAccounting,
  value: unknown,
): UsageAccountingSnapshot | undefined {
  const result = record(value);
  const cumulative = decodeClaudeCumulativeUsage(result?.modelUsage, state.published);
  if (!cumulative || cumulative.size === 0) return undefined;
  if (!state.baseline) {
    // A missing/unsafe baseline or unknown CLI version is not permission to
    // charge a resumed transcript again. Preserve the new primary input we
    // actually observed, anchor future deltas here, and keep the epoch marked
    // incomplete because this first segment's child/output totals are unknown.
    // Zeroed crash results cannot establish an offset over pending input.
    for (const [model, observed] of state.published) {
      const total = cumulative.get(model);
      if (!total || FIELDS.some((field) => total[field] < observed[field])) return undefined;
    }
    if ([...cumulative.values()].every((counts) => FIELDS.every((field) => counts[field] === 0)))
      return undefined;
    state.awaitingVersion = false;
    state.baseline = cumulative;
    state.baselineIncomplete = true;
    for (const [model, counts] of state.published) {
      state.carried.set(model, { ...counts });
      state.settled.set(model, { ...counts });
    }
    state.pending.clear();
    return publish(state, "input-only");
  }
  const settled = new Map<string, Counts>();
  const baseline =
    state.resumeBaseline?.status === "known" && state.baseline === state.resumeBaseline.models
      ? attributeRestoredBaseline(state.baseline, result?.modelUsage, state.published)
      : state.baseline;
  if (!baseline) return undefined;
  // Saved and live alias maps must agree. Missing/regressing rows cannot prove
  // that the CLI restored the snapshot we inspected; retain the lower bound.
  for (const [model, previous] of baseline) {
    const total = cumulative.get(model);
    if (!total || FIELDS.some((field) => total[field] < previous[field])) return undefined;
  }
  for (const [model, total] of cumulative) {
    const offset = baseline.get(model) ?? zero();
    const carried = state.carried.get(model) ?? zero();
    const current = zero();
    for (const field of FIELDS) {
      current[field] = total[field] - offset[field] + carried[field];
      if (!Number.isSafeInteger(current[field])) return undefined;
    }
    if (
      current.cachedInputTokens + current.cacheWriteInputTokens > current.inputTokens ||
      current.reasoningOutputTokens > current.outputTokens
    )
      return undefined;
    settled.set(model, current);
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
