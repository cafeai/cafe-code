import { randomUUID } from "node:crypto";
import type { UsageAccountingModel, UsageAccountingSnapshot } from "@cafecode/contracts";

/** Native identities never leave this bounded, exact-runtime accounting owner. */
export const CODEX_CHILD_USAGE_LIMIT = 4_096;
export const CODEX_CHILD_USAGE_ANCESTRY_LIMIT = 32;
const MODEL_LIMIT = 64;
const UNKNOWN_MODEL = "unknown";
const fields = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;
type Counts = Omit<UsageAccountingModel, "model">;
type DisjointCounts = readonly [number, number, number, number, number];
type Entry = {
  parent: string;
  model: string;
  owner?: string;
  baseline?: DisjointCounts;
  anchorNext: boolean;
  blocked: boolean;
  scopeId?: string;
  revision: number;
  totals: Map<string, UsageAccountingModel>;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function identity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/\p{Cc}/u.test(value)
    ? value
    : undefined;
}

function modelName(value: unknown): string {
  return typeof value === "string" &&
    value.length <= 256 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._[\]-]*$/.test(value)
    ? value
    : UNKNOWN_MODEL;
}

/** Copy only the small ancestry/model attestation, never a native transcript. */
export function codexChildUsageMetadata(thread: unknown):
  | {
      readonly id: string;
      readonly parentThreadId: string;
      readonly model: string;
    }
  | undefined {
  const row = record(thread);
  const id = identity(row?.id);
  const parent = identity(row?.parentThreadId);
  const source = record(record(record(row?.source)?.subAgent)?.thread_spawn);
  if (!id || !parent || id === parent || source?.parent_thread_id !== parent) return undefined;
  return { id, parentThreadId: parent, model: modelName(row?.model) };
}
export type CodexChildUsageMetadata = NonNullable<ReturnType<typeof codexChildUsageMetadata>>;

function disjointCounts(value: unknown): DisjointCounts | undefined {
  const row = record(value);
  if (!row) return undefined;
  const values = fields.map((field) =>
    field === "cacheWriteInputTokens" && row[field] === undefined ? 0 : row[field],
  );
  if (
    !values.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
  )
    return undefined;
  const [input, cached, write, output, reasoning] = values as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (cached > input - write || reasoning > output) return undefined;
  // Independent monotonic categories prevent a later cache/output correction
  // from reclassifying already settled spend. `totalTokens` is intentionally
  // ignored: native context-full recovery can synthesize that estimate.
  return [input - cached - write, cached, write, output - reasoning, reasoning];
}

function fromDisjoint(values: DisjointCounts): Counts | undefined {
  const [fresh, cached, write, generated, reasoning] = values;
  const inputTokens = fresh + cached + write;
  const outputTokens = generated + reasoning;
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(inputTokens + outputTokens)
  )
    return undefined;
  return {
    inputTokens,
    cachedInputTokens: cached,
    cacheWriteInputTokens: write,
    outputTokens,
    reasoningOutputTokens: reasoning,
  };
}

/**
 * Prospective child-only accounting. Root counters remain on the original path.
 * First observation anchors history; it never charges a resumed/forked total.
 * New runtime => new owner and baselines. Backend replay => same UUID/revision,
 * atomically deduplicated by the existing durable UsageStats ledger.
 */
export function makeCodexChildUsageAccounting() {
  const entries = new Map<string, Entry>();
  let root: string | undefined;
  let rootChanged = false;
  let runtimeProcessedTokens = 0;

  const bindRoot = (candidate: string | undefined): candidate is string => {
    if (!identity(candidate) || rootChanged) return false;
    if (root === undefined) root = candidate;
    if (root !== candidate) {
      rootChanged = true;
      return false;
    }
    return true;
  };

  const observeMetadata = (metadata: CodexChildUsageMetadata, rootId: string | undefined): void => {
    if (!bindRoot(rootId) || metadata.id === rootId) return;
    const existing = entries.get(metadata.id);
    if (existing) {
      // A rename/metadata replay cannot reset numeric history or change owner.
      // Model updates have their separate ordered native settings/reroute path.
      if (existing.parent !== metadata.parentThreadId) existing.blocked = true;
      return;
    }
    if (entries.size >= CODEX_CHILD_USAGE_LIMIT) return;
    entries.set(metadata.id, {
      parent: metadata.parentThreadId,
      model: metadata.model,
      anchorNext: false,
      blocked: false,
      revision: 0,
      totals: new Map(),
    });
  };

  const owned = (id: string, rootId: string, routes: ReadonlyMap<string, string>): boolean => {
    const seen = new Set<string>();
    let current = id;
    for (let depth = 0; depth < CODEX_CHILD_USAGE_ANCESTRY_LIMIT; depth += 1) {
      if (current === rootId) return true;
      if (seen.has(current) || !routes.has(current)) return false;
      seen.add(current);
      const entry = entries.get(current);
      if (!entry || entry.blocked) return false;
      current = entry.parent;
    }
    return current === rootId;
  };

  return {
    observeMetadata,
    observe(input: {
      readonly rootId: string | undefined;
      readonly routes: ReadonlyMap<string, string>;
      readonly method: string;
      readonly payload: unknown;
    }): UsageAccountingSnapshot | undefined {
      // This observer sits beside the native hot stream. Ordinary text/tool
      // deltas must not allocate ancestry sets or scan model counters.
      if (
        input.method !== "thread/started" &&
        input.method !== "thread/tokenUsage/updated" &&
        input.method !== "thread/settings/updated" &&
        input.method !== "model/rerouted"
      )
        return undefined;
      if (!bindRoot(input.rootId)) return undefined;
      const payload = record(input.payload);
      if (input.method === "thread/started") {
        const metadata = codexChildUsageMetadata(payload?.thread);
        if (metadata) observeMetadata(metadata, input.rootId);
        return undefined;
      }
      const id = identity(payload?.threadId);
      if (!id || id === input.rootId || !owned(id, input.rootId, input.routes)) return undefined;
      const entry = entries.get(id)!;
      const owner = input.routes.get(id)!;
      if (entry.owner !== undefined && entry.owner !== owner) {
        entry.blocked = true;
        return undefined;
      }
      entry.owner = owner;
      if (input.method === "thread/settings/updated" || input.method === "model/rerouted") {
        const next = modelName(
          input.method === "model/rerouted"
            ? payload?.toModel
            : record(payload?.threadSettings)?.model,
        );
        if (next !== entry.model) {
          entry.model = next;
          entry.anchorNext = true;
        }
        return undefined;
      }
      if (input.method !== "thread/tokenUsage/updated") return undefined;
      const counters = disjointCounts(record(payload?.tokenUsage)?.total);
      if (!counters) {
        entry.blocked = true;
        return undefined;
      }
      if (entry.baseline === undefined) {
        entry.baseline = counters;
        entry.anchorNext = false;
        return undefined;
      }
      if (counters.some((value, i) => value < entry.baseline![i]!)) {
        // Cannot distinguish a reset from late old snapshots. Never lower a
        // watermark or guess a new epoch and risk billing the same bytes twice.
        entry.blocked = true;
        return undefined;
      }
      if (entry.anchorNext) {
        entry.baseline = counters;
        entry.anchorNext = false;
        return undefined;
      }
      const delta = fromDisjoint(
        counters.map((value, i) => value - entry.baseline![i]!) as unknown as DisjointCounts,
      );
      if (!delta) {
        entry.blocked = true;
        return undefined;
      }
      if (delta.inputTokens === 0 && delta.outputTokens === 0) return undefined;
      const nextRuntimeProcessed = runtimeProcessedTokens + delta.inputTokens + delta.outputTokens;
      if (!Number.isSafeInteger(nextRuntimeProcessed)) {
        entry.blocked = true;
        return undefined;
      }
      if (!entry.totals.has(entry.model) && entry.totals.size >= MODEL_LIMIT) {
        entry.blocked = true;
        return undefined;
      }
      const previous = entry.totals.get(entry.model);
      const next = { model: entry.model, ...delta };
      for (const field of fields) next[field] = (previous?.[field] ?? 0) + delta[field];
      const totals = new Map(entry.totals).set(entry.model, next);
      // Enforce aggregate safe capacity before publication, not after a partial
      // update. Maps retain only canonical model labels, never native identities.
      for (const field of fields) {
        if (
          !Number.isSafeInteger(
            Array.from(totals.values()).reduce((sum, row) => sum + row[field], 0),
          )
        ) {
          entry.blocked = true;
          return undefined;
        }
      }
      // Each column can still be safe while their processed-token sum is not.
      // Validate the entire snapshot before assigning any new watermark/row.
      if (
        !Number.isSafeInteger(
          Array.from(totals.values()).reduce(
            (sum, row) => sum + row.inputTokens + row.outputTokens,
            0,
          ),
        )
      ) {
        entry.blocked = true;
        return undefined;
      }
      if (entry.revision >= Number.MAX_SAFE_INTEGER) {
        entry.blocked = true;
        return undefined;
      }
      entry.baseline = counters;
      entry.totals = totals;
      runtimeProcessedTokens = nextRuntimeProcessed;
      entry.scopeId ??= randomUUID();
      entry.revision += 1;
      return {
        scopeId: entry.scopeId,
        revision: entry.revision,
        models: Array.from(totals.values()),
        completeness: "partial",
      };
    },
  };
}
