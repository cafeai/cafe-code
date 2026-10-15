import {
  CODEX_COMPACTION_DIAGNOSTIC_ITEM_LIMIT,
  CODEX_COMPACTION_DIAGNOSTIC_SOURCE_LIMIT,
  type CodexCompactionObservation,
  type CodexCompactionOpeningRequests,
  type CodexCompactionUsageObservation,
  type ProviderTaskOwner,
} from "@cafecode/contracts";

/** Diagnostics never execute received accessors or traverse inherited fields.
 * Reconstructing a fixed field set also prevents arbitrary native content from
 * escaping through an otherwise valid observation. Descriptor traps can fail;
 * their failure is absence of evidence, not a reason to disrupt native work. */
function own(value: unknown, key: string): unknown {
  try {
    // Even array discrimination throws for a revoked proxy. Keep every
    // received-object operation inside this refusal boundary.
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\p{Cc}\p{Bidi_Control}]/u.test(value)
  );
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function time(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function owner(value: unknown): ProviderTaskOwner | null {
  const type = own(value, "type");
  if (type === "root") return { type };
  const id = own(value, "id");
  return type === "child" && identity(id) ? { type, id } : null;
}

function sameOwner(left: ProviderTaskOwner, right: ProviderTaskOwner): boolean {
  return (
    left.type === right.type &&
    (left.type === "root" || (right.type === "child" && left.id === right.id))
  );
}

function opening(value: unknown): CodexCompactionOpeningRequests | null {
  const contextWindow = own(value, "contextWindow");
  const autoCompactTokenLimit = own(value, "autoCompactTokenLimit");
  return (contextWindow === null || integer(contextWindow)) &&
    (autoCompactTokenLimit === null || integer(autoCompactTokenLimit))
    ? { contextWindow, autoCompactTokenLimit }
    : null;
}

function usage(value: unknown): CodexCompactionUsageObservation | null {
  const observedAt = own(value, "observedAt");
  const order = own(value, "order");
  const nativeTurnId = own(value, "nativeTurnId");
  const usedTokens = own(value, "usedTokens");
  const inputTokens = own(value, "inputTokens");
  const cachedInputTokens = own(value, "cachedInputTokens");
  const outputTokens = own(value, "outputTokens");
  const reasoningOutputTokens = own(value, "reasoningOutputTokens");
  const totalProcessedTokens = own(value, "totalProcessedTokens");
  const reportedUsableContextWindow = own(value, "reportedUsableContextWindow");
  if (
    !time(observedAt) ||
    !integer(order) ||
    !(nativeTurnId === null || identity(nativeTurnId)) ||
    !integer(usedTokens) ||
    !integer(inputTokens) ||
    !integer(cachedInputTokens) ||
    !integer(outputTokens) ||
    !integer(reasoningOutputTokens) ||
    !integer(totalProcessedTokens) ||
    !(reportedUsableContextWindow === null || integer(reportedUsableContextWindow))
  )
    return null;
  return {
    observedAt,
    order,
    nativeTurnId,
    usedTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalProcessedTokens,
    reportedUsableContextWindow,
  };
}

/** Validate and copy only the inert diagnostic contract. Missing legacy proof,
 * impossible calendar dates, unsafe counters and inconsistent ordering remain
 * unknown. Wall-clock comparisons are deliberately not used as ordering proof. */
export function readCodexCompactionObservation(value: unknown): CodexCompactionObservation | null {
  const phase = own(value, "phase");
  const sourceOwner = owner(own(value, "sourceOwner"));
  const observedAt = own(value, "observedAt");
  const order = own(value, "order");
  const nativeTurnId = own(value, "nativeTurnId");
  const nativeItemId = own(value, "nativeItemId");
  const startObservedAt = own(value, "startObservedAt");
  const rawOpening = own(value, "rootOpeningRequests");
  const rootOpeningRequests = rawOpening === null ? null : opening(rawOpening);
  const rawUsage = own(value, "lastReportedUsageBeforeStart");
  const lastReportedUsageBeforeStart = rawUsage === null ? null : usage(rawUsage);
  const usageEvidence = own(value, "usageEvidence");
  const evictedSourceCount = own(value, "evictedSourceCount");
  const evictedItemCount = own(value, "evictedItemCount");
  if (
    own(value, "version") !== 1 ||
    (phase !== "started" && phase !== "completed") ||
    sourceOwner === null ||
    !time(observedAt) ||
    !integer(order) ||
    !(nativeTurnId === null || identity(nativeTurnId)) ||
    !identity(nativeItemId) ||
    !(startObservedAt === null || time(startObservedAt)) ||
    (rawOpening !== null && rootOpeningRequests === null) ||
    (rawUsage !== null && lastReportedUsageBeforeStart === null) ||
    !integer(evictedSourceCount) ||
    !integer(evictedItemCount) ||
    own(value, "triggerReason") !== "unreported" ||
    own(value, "accountingScope") !== "unreported" ||
    own(value, "resolvedThreshold") !== null
  )
    return null;
  if (usageEvidence === "received-before-start") {
    if (
      startObservedAt === null ||
      lastReportedUsageBeforeStart === null ||
      lastReportedUsageBeforeStart.order >= order
    )
      return null;
  } else if (usageEvidence === "not-observed") {
    if (startObservedAt === null || lastReportedUsageBeforeStart !== null) return null;
  } else if (usageEvidence === "start-not-observed") {
    if (phase !== "completed" || startObservedAt !== null || lastReportedUsageBeforeStart !== null)
      return null;
  } else return null;
  return {
    version: 1,
    phase,
    sourceOwner,
    observedAt,
    order,
    nativeTurnId,
    nativeItemId,
    startObservedAt,
    rootOpeningRequests,
    lastReportedUsageBeforeStart,
    usageEvidence,
    evictedSourceCount,
    evictedItemCount,
    triggerReason: "unreported",
    accountingScope: "unreported",
    resolvedThreshold: null,
  };
}

/** Consumers bind to an admitted lifecycle edge, never to an observation's
 * self-declared target. Parent Cafe turn IDs differ from child native turn IDs;
 * callers supply a native turn only where that coordinate is actually known. */
export function readMatchingCodexCompactionObservation(
  value: unknown,
  expected: {
    phase: "started" | "completed";
    nativeItemId: string;
    nativeTurnId?: string | null;
    sourceOwner: ProviderTaskOwner;
  },
): CodexCompactionObservation | null {
  const observation = readCodexCompactionObservation(value);
  const expectedOwner = owner(expected.sourceOwner);
  return observation &&
    expectedOwner &&
    observation.phase === expected.phase &&
    observation.nativeItemId === expected.nativeItemId &&
    (expected.nativeTurnId === undefined || observation.nativeTurnId === expected.nativeTurnId) &&
    sameOwner(observation.sourceOwner, expectedOwner)
    ? observation
    : null;
}

/** The observation field is outside native payloads at the runtime edge and
 * inside the finite lifecycle payload thereafter. Neither position may use an
 * inherited/accessor field as evidence. */
export function readMatchingCodexCompactionObservationField(
  container: unknown,
  expected: Parameters<typeof readMatchingCodexCompactionObservation>[1],
): CodexCompactionObservation | null {
  return readMatchingCodexCompactionObservation(
    own(container, "codexCompactionObservation"),
    expected,
  );
}

interface SourceInput {
  sourceId: string;
  sourceOwner: ProviderTaskOwner;
  observedAt: string;
  nativeTurnId: string | null;
}

/** Per-runtime, bounded, content-free receipt tracker. It observes no providers
 * and grants no admission, control or policy authority. Its caller must supply
 * the exact already-admitted source inside the existing route mutation fence. */
export function makeCodexCompactionDiagnosticsTracker() {
  const sources = new Map<string, CodexCompactionUsageObservation | null>();
  const items = new Map<string, { sourceKey: string; start: CodexCompactionObservation }>();
  let rootOpeningRequests: CodexCompactionOpeningRequests | null = null;
  let order = 0;
  let evictedSourceCount = 0;
  let evictedItemCount = 0;
  let retired = false;
  const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  const retire = () => {
    retired = true;
    sources.clear();
    items.clear();
    rootOpeningRequests = null;
  };
  const nextOrder = (): number | null => {
    if (retired || order === Number.MAX_SAFE_INTEGER) {
      retire();
      return null;
    }
    return ++order;
  };
  const readSource = (
    input: SourceInput,
  ): { key: string; sourceOwner: ProviderTaskOwner } | null => {
    const sourceOwner = owner(input.sourceOwner);
    if (
      retired ||
      !identity(input.sourceId) ||
      !sourceOwner ||
      !time(input.observedAt) ||
      !(input.nativeTurnId === null || identity(input.nativeTurnId)) ||
      (sourceOwner.type === "child" && sourceOwner.id !== input.sourceId)
    )
      return null;
    return { key: JSON.stringify([sourceOwner.type, input.sourceId]), sourceOwner };
  };
  const touchSource = (key: string) => {
    const sample = sources.get(key) ?? null;
    sources.delete(key);
    if (sources.size === CODEX_COMPACTION_DIAGNOSTIC_SOURCE_LIMIT) {
      const oldest = sources.keys().next().value;
      if (oldest !== undefined) {
        sources.delete(oldest);
        evictedSourceCount = increment(evictedSourceCount);
        for (const [itemKey, item] of items) {
          if (item.sourceKey === oldest) {
            items.delete(itemKey);
            evictedItemCount = increment(evictedItemCount);
          }
        }
      }
    }
    sources.set(key, sample);
  };
  return {
    /** Mint root nominal evidence only after the actual native opening ACK.
     * The copy cannot be retargeted by mutable options or a child item. */
    setRootOpeningRequests(value: unknown): void {
      if (retired) return;
      // A new successful root opening is a new sampling interval even when
      // the native thread spelling is reused. No old pre-start proof survives.
      sources.clear();
      items.clear();
      order = 0;
      evictedSourceCount = 0;
      evictedItemCount = 0;
      const admitted = opening(value);
      rootOpeningRequests = admitted ? Object.freeze(admitted) : null;
    },
    observeUsage(input: SourceInput & { tokenUsage: unknown }): void {
      const admittedSource = readSource(input);
      if (admittedSource === null) return;
      const key = admittedSource.key;
      const last = own(input.tokenUsage, "last");
      const total = own(input.tokenUsage, "total");
      const modelContextWindow = own(input.tokenUsage, "modelContextWindow");
      // Native last.totalTokens already owns reasoning accounting. Never add
      // reasoningOutputTokens again or substitute the lifetime total here.
      const sample = usage({
        observedAt: input.observedAt,
        order: 0,
        nativeTurnId: input.nativeTurnId,
        usedTokens: own(last, "totalTokens"),
        inputTokens: own(last, "inputTokens"),
        cachedInputTokens: own(last, "cachedInputTokens"),
        outputTokens: own(last, "outputTokens"),
        reasoningOutputTokens: own(last, "reasoningOutputTokens"),
        totalProcessedTokens: own(total, "totalTokens"),
        reportedUsableContextWindow: modelContextWindow === undefined ? null : modelContextWindow,
      });
      if (!sample) return;
      const receivedOrder = nextOrder();
      if (receivedOrder === null) return;
      touchSource(key);
      sources.set(key, Object.freeze({ ...sample, order: receivedOrder }));
    },
    observeCompaction(
      input: SourceInput & {
        phase: "started" | "completed";
        nativeItemId: string;
      },
    ): CodexCompactionObservation | null {
      const admittedSource = readSource(input);
      if (
        admittedSource === null ||
        !identity(input.nativeItemId) ||
        (input.phase !== "started" && input.phase !== "completed")
      )
        return null;
      const key = admittedSource.key;
      const receivedOrder = nextOrder();
      if (receivedOrder === null) return null;
      touchSource(key);
      const itemKey = JSON.stringify([key, input.nativeTurnId, input.nativeItemId]);
      const original = items.get(itemKey)?.start;
      // Native item identity is an immutable tuple. A late start after a
      // completion whose start was never seen cannot manufacture pre-start
      // proof from the current sample or reopen a completed diagnostic item.
      if (original?.startObservedAt === null && input.phase === "started") return null;
      const sample =
        original?.lastReportedUsageBeforeStart ??
        (input.phase === "started" ? (sources.get(key) ?? null) : null);
      const startObservedAt =
        original?.startObservedAt ?? (input.phase === "started" ? input.observedAt : null);
      // A duplicate start retains the first pre-start snapshot, including an
      // original null sample. Post-start usage cannot manufacture that proof.
      const retainedSample = original ? original.lastReportedUsageBeforeStart : sample;
      if (!original && items.size === CODEX_COMPACTION_DIAGNOSTIC_ITEM_LIMIT) {
        const oldest = items.keys().next().value;
        if (oldest !== undefined) {
          items.delete(oldest);
          evictedItemCount = increment(evictedItemCount);
        }
      }
      const observation: CodexCompactionObservation = Object.freeze({
        version: 1,
        phase: input.phase,
        sourceOwner: Object.freeze(admittedSource.sourceOwner),
        observedAt: input.observedAt,
        order: receivedOrder,
        nativeTurnId: input.nativeTurnId,
        nativeItemId: input.nativeItemId,
        startObservedAt,
        rootOpeningRequests: original ? original.rootOpeningRequests : rootOpeningRequests,
        lastReportedUsageBeforeStart: retainedSample,
        usageEvidence:
          startObservedAt === null
            ? "start-not-observed"
            : retainedSample
              ? "received-before-start"
              : "not-observed",
        evictedSourceCount,
        evictedItemCount,
        triggerReason: "unreported",
        accountingScope: "unreported",
        resolvedThreshold: null,
      });
      // Retain terminal receipts within the same eight-item budget. Duplicate
      // completion (or duplicate start after completion) must not replace the
      // original sample with post-compaction usage or an unknown synthetic one.
      if (!original) items.set(itemKey, { sourceKey: key, start: observation });
      return observation;
    },
    retire,
  };
}
