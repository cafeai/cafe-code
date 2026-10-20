import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";
import { ProviderTaskOwner } from "./providerTaskOwnership.ts";

/** Diagnostic storage limits, not provider policy or native work budgets. */
export const CODEX_COMPACTION_DIAGNOSTIC_SOURCE_LIMIT = 32;
export const CODEX_COMPACTION_DIAGNOSTIC_ITEM_LIMIT = 8;

const ObservationTime = Schema.String.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.makeFilter((value) => {
    const milliseconds = Date.parse(value);
    return (
      Number.isFinite(milliseconds) &&
      DateTime.formatIso(DateTime.makeUnsafe(milliseconds)) === value
    );
  }),
);
const NativeIdentity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\p{Cc}\p{Bidi_Control}]+$/u),
);
// Received counters remain JSON-safe across native, daemon and renderer hops.
// This is diagnostic admission only; it does not change native token accounting.
const SafeNonNegativeInt = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const ReportedTokens = Schema.NullOr(SafeNonNegativeInt);

/** A received native usage sample. Lifetime totals and the last request are
 * deliberately distinct. Neither is asserted to be the exact trigger count. */
export const CodexCompactionUsageObservation = Schema.Struct({
  observedAt: ObservationTime,
  order: SafeNonNegativeInt,
  nativeTurnId: Schema.NullOr(NativeIdentity),
  usedTokens: SafeNonNegativeInt,
  inputTokens: SafeNonNegativeInt,
  cachedInputTokens: SafeNonNegativeInt,
  outputTokens: SafeNonNegativeInt,
  reasoningOutputTokens: SafeNonNegativeInt,
  totalProcessedTokens: SafeNonNegativeInt,
  reportedUsableContextWindow: ReportedTokens,
});
export type CodexCompactionUsageObservation = typeof CodexCompactionUsageObservation.Type;

/** These are the root runtime's actual-opening nominal requests. A child's
 * inherited/effective policy is not reported by an ordinary child item. */
export const CodexCompactionOpeningRequests = Schema.Struct({
  contextWindow: ReportedTokens,
  autoCompactTokenLimit: ReportedTokens,
});
export type CodexCompactionOpeningRequests = typeof CodexCompactionOpeningRequests.Type;

/** Small, inert evidence on an already-admitted compaction lifecycle edge.
 * It grants no control, liveness, retry, configuration or history authority.
 * Native reason/scope/threshold remain explicitly unreported; no local estimate
 * or post-compaction usage may be relabeled as a provider trigger. */
export const CodexCompactionObservation = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals(["started", "completed"]),
  sourceOwner: ProviderTaskOwner,
  observedAt: ObservationTime,
  order: SafeNonNegativeInt,
  nativeTurnId: Schema.NullOr(NativeIdentity),
  nativeItemId: NativeIdentity,
  startObservedAt: Schema.NullOr(ObservationTime),
  rootOpeningRequests: Schema.NullOr(CodexCompactionOpeningRequests),
  lastReportedUsageBeforeStart: Schema.NullOr(CodexCompactionUsageObservation),
  usageEvidence: Schema.Literals(["received-before-start", "not-observed", "start-not-observed"]),
  evictedSourceCount: SafeNonNegativeInt,
  evictedItemCount: SafeNonNegativeInt,
  triggerReason: Schema.Literal("unreported"),
  accountingScope: Schema.Literal("unreported"),
  resolvedThreshold: Schema.Null,
});
export type CodexCompactionObservation = typeof CodexCompactionObservation.Type;
