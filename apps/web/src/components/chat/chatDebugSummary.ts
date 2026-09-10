import { type TurnId, OrchestrationThreadActivity } from "@cafecode/contracts";
import { CODEX_AUTO_COMPACT_POLICY_SOURCE } from "@cafecode/shared/codexCompaction";
import { derivePhase, isLatestTurnSettled } from "../../session-logic";
import { type ChatMessage, type Thread, type TurnDiffSummary } from "../../types";

/** Pure bounded diagnostic projections, isolated from composer and transport state. */
export const DEBUG_SNAPSHOT_VERSION = 13;
const DEBUG_TEXT_PREVIEW_LIMIT = 120;
const DEBUG_JSON_PREVIEW_LIMIT = 600;
export const DEBUG_RECENT_MESSAGE_LIMIT = 6;
export const DEBUG_RECENT_ACTIVITY_LIMIT = 10;
export const DEBUG_RECENT_RUNTIME_EVENT_LIMIT = 6;
const DEBUG_PROVIDER_CONTINUATION_SIGNAL_LIMIT = 8;
const DEBUG_PROVIDER_COMPLETION_BOUNDARY_LIMIT = 8;
export const DEBUG_INTERESTING_THREAD_LIMIT = 16;
export const DEBUG_THREAD_DETAIL_MESSAGE_LIMIT = 2_000;
export const DEBUG_THREAD_DETAIL_ACTIVITY_LIMIT = 500;
export const DEBUG_RENDERER_HEARTBEAT_INTERVAL_MS = 5_000;
// Snapshot construction traverses every retained thread and can produce a
// sizeable structured-clone payload under 16+ hour workloads. One update per
// second is still interactive for diagnostics while preventing debug mode from
// adding a four-times-per-second renderer/main-process serialization tax.
export const DEBUG_RENDERER_SNAPSHOT_MIN_INTERVAL_MS = 1_000;
const DEBUG_LARGE_THREAD_TEXT_CHARS = 1_000_000;
const DEBUG_LARGE_ACTIVITY_PAYLOAD_CHARS = 1_000_000;
export const DEBUG_TIMELINE_SCROLL_EVENT_LIMIT = 100;
const DEBUG_SECRET_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bnpm_[A-Za-z0-9]{8,}\b/g, "npm_[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, "gh[redacted]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, "xox[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g, "Bearer [redacted]"],
];

function redactDebugSecrets(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of DEBUG_SECRET_REDACTIONS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function truncateDebugText(value: string, limit = DEBUG_TEXT_PREVIEW_LIMIT): string {
  const redacted = redactDebugSecrets(value);
  if (redacted.length <= limit) {
    return redacted;
  }
  return `${redacted.slice(0, Math.max(0, limit - 1))}…`;
}

function stringifyDebugPreview(value: unknown, limit = DEBUG_JSON_PREVIEW_LIMIT): string {
  try {
    return truncateDebugText(JSON.stringify(value), limit);
  } catch {
    return "[unserializable]";
  }
}

function payloadKeys(payload: unknown): readonly string[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  return Object.keys(payload).toSorted();
}

export function readDebugRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readDebugNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readDebugBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function readDebugString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function summarizeDebugContextWindowUsagePayload(payloadValue: unknown) {
  const payload = readDebugRecord(payloadValue);
  if (payload === null) {
    return null;
  }

  const usage = {
    usedTokens: readDebugNumber(payload.usedTokens),
    totalProcessedTokens: readDebugNumber(payload.totalProcessedTokens),
    maxTokens: readDebugNumber(payload.maxTokens),
    inputTokens: readDebugNumber(payload.inputTokens),
    cachedInputTokens: readDebugNumber(payload.cachedInputTokens),
    cacheWriteInputTokens: readDebugNumber(payload.cacheWriteInputTokens),
    totalCacheWriteInputTokens: readDebugNumber(payload.totalCacheWriteInputTokens),
    outputTokens: readDebugNumber(payload.outputTokens),
    reasoningOutputTokens: readDebugNumber(payload.reasoningOutputTokens),
    lastUsedTokens: readDebugNumber(payload.lastUsedTokens),
    lastInputTokens: readDebugNumber(payload.lastInputTokens),
    lastCachedInputTokens: readDebugNumber(payload.lastCachedInputTokens),
    lastCacheWriteInputTokens: readDebugNumber(payload.lastCacheWriteInputTokens),
    lastOutputTokens: readDebugNumber(payload.lastOutputTokens),
    lastReasoningOutputTokens: readDebugNumber(payload.lastReasoningOutputTokens),
    toolUses: readDebugNumber(payload.toolUses),
    durationMs: readDebugNumber(payload.durationMs),
    compactsAutomatically: readDebugBoolean(payload.compactsAutomatically),
    autoCompactTokenLimit: readDebugNumber(payload.autoCompactTokenLimit),
  };
  const tokenTypesPresent = [
    usage.inputTokens !== null || usage.lastInputTokens !== null ? "input" : null,
    usage.cachedInputTokens !== null || usage.lastCachedInputTokens !== null
      ? "cached-input"
      : null,
    usage.cacheWriteInputTokens !== null || usage.lastCacheWriteInputTokens !== null
      ? "cache-write-input"
      : null,
    usage.outputTokens !== null || usage.lastOutputTokens !== null ? "output" : null,
    usage.reasoningOutputTokens !== null || usage.lastReasoningOutputTokens !== null
      ? "reasoning-output"
      : null,
  ].filter((value): value is string => value !== null);

  return {
    ...usage,
    tokenTypesPresent,
    totals: {
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      totalCacheWriteInputTokens: usage.totalCacheWriteInputTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
    },
    latestDelta: {
      usedTokens: usage.lastUsedTokens,
      inputTokens: usage.lastInputTokens,
      cachedInputTokens: usage.lastCachedInputTokens,
      cacheWriteInputTokens: usage.lastCacheWriteInputTokens,
      outputTokens: usage.lastOutputTokens,
      reasoningOutputTokens: usage.lastReasoningOutputTokens,
    },
  };
}

function summarizeDebugContextWindowActivity(activity: OrchestrationThreadActivity | null) {
  if (activity === null) {
    return null;
  }
  return {
    ...summarizeDebugActivity(activity),
    usage: summarizeDebugContextWindowUsagePayload(activity.payload),
  };
}

function isDebugCodexThread(thread: Thread): boolean {
  return (
    String(thread.session?.provider ?? "") === "codex" ||
    String(thread.modelSelection.instanceId).startsWith("codex")
  );
}

function isContextCompactionActivity(activity: OrchestrationThreadActivity): boolean {
  const payload = readDebugRecord(activity.payload);
  return activity.kind === "context-compaction" || payload?.itemType === "context_compaction";
}

function contextCompactionActivityItemId(activity: OrchestrationThreadActivity): string {
  const payload = readDebugRecord(activity.payload);
  return readDebugString(payload?.itemId) ?? activity.id;
}

export function threadHasActiveContextCompaction(
  thread: Thread,
  activeTurnId: TurnId | null,
): boolean {
  const activeCompactionsByItemId = new Map<string, OrchestrationThreadActivity>();

  for (const activity of thread.activities) {
    if (!isContextCompactionActivity(activity)) {
      continue;
    }
    if (activeTurnId !== null && activity.turnId !== activeTurnId) {
      continue;
    }

    const itemId = contextCompactionActivityItemId(activity);
    if (activity.kind === "tool.started") {
      activeCompactionsByItemId.set(itemId, activity);
      continue;
    }

    if (activity.kind === "tool.completed" || activity.kind === "context-compaction") {
      activeCompactionsByItemId.delete(itemId);
    }
  }

  return activeCompactionsByItemId.size > 0;
}

function summarizeDebugCodexCompaction(
  thread: Thread,
  latestContextWindowPayload: Record<string, unknown> | null,
) {
  if (!isDebugCodexThread(thread)) {
    return null;
  }

  const compactionActivities = thread.activities.filter(isContextCompactionActivity);
  const activeCompactionsByItemId = new Map<string, OrchestrationThreadActivity>();
  let startedCount = 0;
  let completedCount = 0;

  for (const activity of compactionActivities) {
    const itemId = contextCompactionActivityItemId(activity);
    if (activity.kind === "tool.started") {
      startedCount += 1;
      activeCompactionsByItemId.set(itemId, activity);
      continue;
    }
    if (activity.kind === "tool.completed" || activity.kind === "context-compaction") {
      completedCount += 1;
      activeCompactionsByItemId.delete(itemId);
    }
  }

  const latestUsedTokens =
    readDebugNumber(latestContextWindowPayload?.lastUsedTokens) ??
    readDebugNumber(latestContextWindowPayload?.usedTokens);
  const latestInputTokens =
    readDebugNumber(latestContextWindowPayload?.lastInputTokens) ??
    readDebugNumber(latestContextWindowPayload?.inputTokens);
  const latestPayloadLimit = readDebugNumber(latestContextWindowPayload?.autoCompactTokenLimit);
  const latestCompactionActivity = compactionActivities.at(-1) ?? null;

  return {
    policy: {
      enabled: true,
      source: CODEX_AUTO_COMPACT_POLICY_SOURCE,
      thresholdResolution:
        latestPayloadLimit === null
          ? "upstream-model-metadata-or-codex-config"
          : "explicit-cafe-provider-override",
      explicitCafeOverride: latestPayloadLimit,
      // App-server owns the default threshold and scope. Cafe cannot infer a
      // precise resolved threshold from the effective-window token event
      // without duplicating model metadata logic that changes upstream.
      resolvedThresholdReportedByProvider: false,
    },
    latestContextWindow: {
      usedTokens: latestUsedTokens,
      inputTokens: latestInputTokens,
      maxTokens: readDebugNumber(latestContextWindowPayload?.maxTokens),
      aboveExplicitCafeOverride:
        latestPayloadLimit !== null && latestUsedTokens !== null
          ? latestUsedTokens >= latestPayloadLimit
          : null,
    },
    activity: {
      contextCompactionActivityCount: compactionActivities.length,
      startedCount,
      completedCount,
      activeCount: activeCompactionsByItemId.size,
      latest:
        latestCompactionActivity === null ? null : summarizeDebugActivity(latestCompactionActivity),
      active: [...activeCompactionsByItemId.values()].slice(-3).map(summarizeDebugActivity),
    },
  };
}

export function countBy<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): Record<string, number> {
  // Provider-derived diagnostic labels are data, including prototype names.
  const counts: Record<string, number> = Object.create(null);
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function roundDebugMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseDebugTimestamp(value: string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsedDebugMs(nowMs: number, value: string | null | undefined): number | null {
  const timestampMs = parseDebugTimestamp(value);
  return timestampMs === null ? null : Math.max(0, nowMs - timestampMs);
}

function durationDebugMs(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  const startMs = parseDebugTimestamp(start);
  const endMs = parseDebugTimestamp(end);
  return startMs === null || endMs === null ? null : Math.max(0, endMs - startMs);
}

function estimateDebugJsonChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function summarizeDebugMessage(message: ChatMessage) {
  return {
    id: message.id,
    role: message.role,
    turnId: message.turnId ?? null,
    createdAt: message.createdAt,
    completedAt: message.completedAt ?? null,
    streaming: message.streaming,
    textLength: message.text.length,
    textPreview: truncateDebugText(message.text),
    attachmentCount: message.attachments?.length ?? 0,
  };
}

export function summarizeDebugActivity(activity: OrchestrationThreadActivity) {
  const payload = activityPayloadForDebug(activity);
  return {
    id: activity.id,
    kind: activity.kind,
    tone: activity.tone,
    summaryLength: activity.summary.length,
    summaryPreview:
      activity.kind === "provider.async-questions"
        ? "Optional Codex questions"
        : truncateDebugText(activity.summary),
    turnId: activity.turnId,
    sequence: activity.sequence ?? null,
    createdAt: activity.createdAt,
    payloadKeys: payloadKeys(payload),
    payloadPreview: stringifyDebugPreview(payload),
  };
}

/**
 * Inline question metadata is authenticated transcript content, not diagnostic
 * text. Redact before building either regular or continuation snapshots, even
 * though the desktop's compact endpoint also strips its preview fields. Only
 * bounded counts leave this boundary; do not serialize provider titles/options
 * or an unknown payload key into a raw renderer debug snapshot.
 */
function activityPayloadForDebug(activity: OrchestrationThreadActivity): unknown {
  if (activity.kind !== "provider.async-questions") return activity.payload;
  const value = readDebugRecord(activity.payload)?.questions;
  const questions = Array.isArray(value) ? value.slice(0, 16) : [];
  return {
    questionCount: questions.length,
    optionCount: questions.reduce((count: number, question: unknown) => {
      const options = readDebugRecord(question)?.options;
      return count + (Array.isArray(options) ? Math.min(options.length, 32) : 0);
    }, 0),
  };
}

function compareDebugIso(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function messageDebugEventAt(message: ChatMessage): string {
  return message.completedAt ?? message.createdAt;
}

function isAfterDebugBoundary(eventAt: string, boundaryAt: string | null): boolean {
  return boundaryAt !== null && eventAt > boundaryAt;
}

function classifyDebugMessageContinuationSignal(message: ChatMessage): string {
  switch (message.role) {
    case "assistant":
      return message.streaming ? "assistant-streaming-message" : "assistant-message";
    case "user":
      return "user-message";
    case "system":
      return "system-message";
  }
}

function classifyDebugActivityContinuationSignal(activity: OrchestrationThreadActivity): string {
  if (activity.kind === "context-window.updated") {
    return "token-usage";
  }
  if (
    activity.kind === "runtime.warning" ||
    activity.kind === "runtime.error" ||
    activity.kind === "turn.plan.updated" ||
    activity.kind === "approval.requested" ||
    activity.kind === "approval.resolved" ||
    activity.kind === "user-input.requested" ||
    activity.kind === "user-input.resolved"
  ) {
    return activity.kind.replaceAll(".", "-");
  }
  if (
    activity.kind.startsWith("tool.") ||
    activity.kind.startsWith("task.") ||
    activity.kind.startsWith("mcp.")
  ) {
    return activity.kind.replaceAll(".", "-");
  }
  return activity.kind;
}

function classifyDebugProviderSurfaceForActivity(activity: OrchestrationThreadActivity): string {
  if (activity.kind === "context-window.updated") {
    return "token-usage-meter";
  }
  if (activity.kind.startsWith("task.")) {
    return "background-task-monitor";
  }
  if (activity.kind.startsWith("tool.")) {
    return "tool-lifecycle";
  }
  if (activity.kind.startsWith("runtime.")) {
    return "runtime-transport";
  }
  if (activity.kind.startsWith("approval.") || activity.kind.startsWith("user-input.")) {
    return "human-input-gate";
  }
  if (activity.kind === "turn.plan.updated") {
    return "plan-projection";
  }
  return "provider-activity";
}

function activityIsProviderContinuationRelevant(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "context-window.updated" ||
    activity.kind === "runtime.warning" ||
    activity.kind === "runtime.error" ||
    activity.kind === "turn.plan.updated" ||
    activity.kind === "approval.requested" ||
    activity.kind === "approval.resolved" ||
    activity.kind === "user-input.requested" ||
    activity.kind === "user-input.resolved" ||
    activity.kind.startsWith("tool.") ||
    activity.kind.startsWith("task.") ||
    activity.kind.startsWith("mcp.")
  );
}

function summarizeDebugContinuationMessage(
  message: ChatMessage,
  latestTurnCompletedAt: string | null,
  earliestCompletionSignalAt: string | null,
) {
  const eventAt = messageDebugEventAt(message);
  return {
    source: "message" as const,
    id: message.id,
    turnId: message.turnId ?? null,
    createdAt: message.createdAt,
    eventAt,
    completedAt: message.completedAt ?? null,
    signalKind: classifyDebugMessageContinuationSignal(message),
    providerSurface: "assistant-output",
    afterLatestTurnCompleted: isAfterDebugBoundary(eventAt, latestTurnCompletedAt),
    afterEarliestCompletionSignal: isAfterDebugBoundary(eventAt, earliestCompletionSignalAt),
    role: message.role,
    streaming: message.streaming,
    textLength: message.text.length,
    textPreview: truncateDebugText(message.text),
    attachmentCount: message.attachments?.length ?? 0,
  };
}

function summarizeDebugContinuationActivity(
  activity: OrchestrationThreadActivity,
  latestTurnCompletedAt: string | null,
  earliestCompletionSignalAt: string | null,
) {
  const payload = activityPayloadForDebug(activity);
  const tokenUsage =
    activity.kind === "context-window.updated"
      ? summarizeDebugContextWindowUsagePayload(activity.payload)
      : null;
  return {
    source: "activity" as const,
    id: activity.id,
    turnId: activity.turnId,
    sequence: activity.sequence ?? null,
    createdAt: activity.createdAt,
    eventAt: activity.createdAt,
    signalKind: classifyDebugActivityContinuationSignal(activity),
    providerSurface: classifyDebugProviderSurfaceForActivity(activity),
    afterLatestTurnCompleted: isAfterDebugBoundary(activity.createdAt, latestTurnCompletedAt),
    afterEarliestCompletionSignal: isAfterDebugBoundary(
      activity.createdAt,
      earliestCompletionSignalAt,
    ),
    kind: activity.kind,
    tone: activity.tone,
    summary:
      activity.kind === "provider.async-questions" ? "Optional Codex questions" : activity.summary,
    payloadKeys: payloadKeys(payload),
    payloadPreview: stringifyDebugPreview(payload, 500),
    tokenUsage,
  };
}

function summarizeDebugProviderContinuation(thread: Thread, nowMs: number) {
  const latestTurn = thread.latestTurn;
  const latestTurnId = latestTurn?.turnId ?? null;
  if (latestTurnId === null) {
    return null;
  }

  const latestTurnCompletedAt = latestTurn?.completedAt ?? null;
  const sameTurnMessages = thread.messages.filter((message) => message.turnId === latestTurnId);
  const sameTurnActivities = thread.activities.filter(
    (activity) => activity.turnId === latestTurnId,
  );
  const sameTurnDiffSummaries = thread.turnDiffSummaries.filter(
    (summary) => summary.turnId === latestTurnId,
  );
  const completionBoundaries = [
    latestTurnCompletedAt === null
      ? null
      : {
          source: "latestTurn.completedAt" as const,
          completedAt: latestTurnCompletedAt,
          state: latestTurn?.state ?? null,
          status: null,
          checkpointRef: null,
          assistantMessageId: latestTurn?.assistantMessageId ?? null,
          fileCount: null,
        },
    // `missing` provider-diff rows are mid-turn placeholders emitted before a
    // durable checkpoint exists; treating them as completion boundaries makes
    // ordinary later tool events look like post-completion lifecycle corruption.
    ...sameTurnDiffSummaries
      .filter(
        (summary) =>
          summary.status !== "missing" &&
          // The provider turn terminal event is the authoritative lifecycle
          // boundary. Checkpoint summaries can be captured, replayed, or
          // backfilled with older timestamps while Codex is still producing
          // tools and assistant items; those older summaries are useful
          // artifact metadata but not a provider-completion boundary.
          (latestTurnCompletedAt === null || summary.completedAt >= latestTurnCompletedAt),
      )
      .map((summary) => ({
        source: "turnDiff.completedAt" as const,
        completedAt: summary.completedAt,
        state: null,
        status: summary.status ?? null,
        checkpointRef: summary.checkpointRef ?? null,
        assistantMessageId: summary.assistantMessageId ?? null,
        fileCount: summary.files.length,
      })),
  ]
    .filter((boundary): boundary is NonNullable<typeof boundary> => boundary !== null)
    .toSorted((left, right) => compareDebugIso(left.completedAt, right.completedAt));
  const earliestCompletionSignalAt = completionBoundaries.at(0)?.completedAt ?? null;
  const latestCompletionSignalAt = completionBoundaries.at(-1)?.completedAt ?? null;
  const signals = [
    ...sameTurnMessages
      .filter((message) => message.role === "assistant")
      .map((message) =>
        summarizeDebugContinuationMessage(
          message,
          latestTurnCompletedAt,
          earliestCompletionSignalAt,
        ),
      ),
    ...sameTurnActivities
      .filter(activityIsProviderContinuationRelevant)
      .map((activity) =>
        summarizeDebugContinuationActivity(
          activity,
          latestTurnCompletedAt,
          earliestCompletionSignalAt,
        ),
      ),
  ].toSorted((left, right) => {
    const eventOrder = compareDebugIso(left.eventAt, right.eventAt);
    if (eventOrder !== 0) {
      return eventOrder;
    }
    return left.id.localeCompare(right.id);
  });
  const signalsAfterLatestTurnCompleted = signals.filter(
    (signal) => signal.afterLatestTurnCompleted,
  );
  const signalsAfterEarliestCompletionSignal = signals.filter(
    (signal) => signal.afterEarliestCompletionSignal,
  );
  const tokenUsageSignals = signals.filter((signal) => signal.signalKind === "token-usage");
  const tokenUsageSignalsAfterLatestTurnCompleted = signalsAfterLatestTurnCompleted.filter(
    (signal) => signal.signalKind === "token-usage",
  );
  const tokenUsageSignalsAfterEarliestCompletionSignal =
    signalsAfterEarliestCompletionSignal.filter((signal) => signal.signalKind === "token-usage");
  const latestSignal = signals.at(-1) ?? null;
  const latestSignalAfterEarliestCompletion = signalsAfterEarliestCompletionSignal.at(-1) ?? null;
  const latestSignalAfterLatestTurnCompleted = signalsAfterLatestTurnCompleted.at(-1) ?? null;

  return {
    provider: thread.session?.provider ?? null,
    providerInstanceId: thread.session?.providerInstanceId ?? null,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    latestTurnId,
    latestTurnState: latestTurn?.state ?? null,
    latestTurnCompletedAt,
    sameTurnMessageCount: sameTurnMessages.length,
    sameTurnActivityCount: sameTurnActivities.length,
    sameTurnDiffSummaryCount: sameTurnDiffSummaries.length,
    completionBoundaries: completionBoundaries.slice(-DEBUG_PROVIDER_COMPLETION_BOUNDARY_LIMIT),
    earliestCompletionSignalAt,
    latestCompletionSignalAt,
    signalCount: signals.length,
    signalCountsByKind: countBy(signals, (signal) => signal.signalKind),
    signalCountsByProviderSurface: countBy(signals, (signal) => signal.providerSurface),
    afterLatestTurnCompletedCount: signalsAfterLatestTurnCompleted.length,
    afterLatestTurnCompletedCountsByKind: countBy(
      signalsAfterLatestTurnCompleted,
      (signal) => signal.signalKind,
    ),
    afterEarliestCompletionSignalCount: signalsAfterEarliestCompletionSignal.length,
    afterEarliestCompletionSignalCountsByKind: countBy(
      signalsAfterEarliestCompletionSignal,
      (signal) => signal.signalKind,
    ),
    tokenUsageSignalCount: tokenUsageSignals.length,
    tokenUsageAfterLatestTurnCompletedCount: tokenUsageSignalsAfterLatestTurnCompleted.length,
    tokenUsageAfterEarliestCompletionSignalCount:
      tokenUsageSignalsAfterEarliestCompletionSignal.length,
    latestSignalAt: latestSignal?.eventAt ?? null,
    latestSignalAgeMs: elapsedDebugMs(nowMs, latestSignal?.eventAt),
    latestSignalKind: latestSignal?.signalKind ?? null,
    latestSignalProviderSurface: latestSignal?.providerSurface ?? null,
    latestSignalAfterEarliestCompletionAt: latestSignalAfterEarliestCompletion?.eventAt ?? null,
    latestSignalAfterEarliestCompletionKind:
      latestSignalAfterEarliestCompletion?.signalKind ?? null,
    latestSignalAfterLatestTurnCompletedAt: latestSignalAfterLatestTurnCompleted?.eventAt ?? null,
    latestSignalAfterLatestTurnCompletedKind:
      latestSignalAfterLatestTurnCompleted?.signalKind ?? null,
    latestTokenUsageSignal: tokenUsageSignals.at(-1) ?? null,
    latestTokenUsageAfterEarliestCompletionSignal:
      tokenUsageSignalsAfterEarliestCompletionSignal.at(-1) ?? null,
    latestTokenUsageAfterLatestTurnCompleted:
      tokenUsageSignalsAfterLatestTurnCompleted.at(-1) ?? null,
    recentSignals: signals.slice(-DEBUG_PROVIDER_CONTINUATION_SIGNAL_LIMIT),
    recentSignalsAfterEarliestCompletionSignal: signalsAfterEarliestCompletionSignal.slice(
      -DEBUG_PROVIDER_CONTINUATION_SIGNAL_LIMIT,
    ),
    recentSignalsAfterLatestTurnCompleted: signalsAfterLatestTurnCompleted.slice(
      -DEBUG_PROVIDER_CONTINUATION_SIGNAL_LIMIT,
    ),
  };
}

function parseDebugRetryProgress(message: string | null): {
  readonly retryAttempt: number | null;
  readonly retryLimit: number | null;
} {
  if (message === null) {
    return { retryAttempt: null, retryLimit: null };
  }
  const match = /(?:^|\b)Reconnecting\.\.\.\s+(\d+)\/(\d+)(?:\b|$)/.exec(message);
  if (!match) {
    return { retryAttempt: null, retryLimit: null };
  }
  const retryAttempt = Number.parseInt(match[1] ?? "", 10);
  const retryLimit = Number.parseInt(match[2] ?? "", 10);
  return {
    retryAttempt: Number.isFinite(retryAttempt) ? retryAttempt : null,
    retryLimit: Number.isFinite(retryLimit) ? retryLimit : null,
  };
}

function summarizeDebugProviderTransportActivity(activity: OrchestrationThreadActivity) {
  if (activity.kind !== "runtime.warning" && activity.kind !== "runtime.error") {
    return null;
  }

  const payload = readDebugRecord(activity.payload);
  const detail = readDebugRecord(payload?.detail);
  const error = readDebugRecord(detail?.error);
  const codexErrorInfo = readDebugRecord(error?.codexErrorInfo);
  const responseStreamDisconnected = readDebugRecord(codexErrorInfo?.responseStreamDisconnected);
  const message =
    readDebugString(payload?.message) ??
    readDebugString(error?.message) ??
    readDebugString(activity.summary);
  const additionalDetails = readDebugString(error?.additionalDetails);
  const retryProgress = parseDebugRetryProgress(message);
  const retrying = readDebugBoolean(payload?.retrying) ?? false;
  const willRetry = readDebugBoolean(detail?.willRetry);
  const isResponseStreamDisconnected =
    responseStreamDisconnected !== null ||
    additionalDetails?.includes("stream disconnected before completion") === true;
  const isWebsocketTransportIssue =
    additionalDetails?.toLowerCase().includes("websocket") === true ||
    message?.toLowerCase().includes("websocket") === true;
  const isRetryEvent =
    retrying ||
    willRetry === true ||
    retryProgress.retryAttempt !== null ||
    message?.startsWith("Reconnecting...") === true;

  if (!isRetryEvent && !isResponseStreamDisconnected && !isWebsocketTransportIssue) {
    return null;
  }

  return {
    id: activity.id,
    kind: activity.kind,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    message,
    retrying,
    willRetry,
    retryAttempt: retryProgress.retryAttempt,
    retryLimit: retryProgress.retryLimit,
    atRetryLimit:
      retryProgress.retryAttempt !== null &&
      retryProgress.retryLimit !== null &&
      retryProgress.retryAttempt >= retryProgress.retryLimit,
    responseStreamDisconnected: isResponseStreamDisconnected,
    httpStatusCode: readDebugNumber(responseStreamDisconnected?.httpStatusCode),
    additionalDetails:
      additionalDetails === null ? null : truncateDebugText(additionalDetails, 500),
  };
}

function summarizeDebugProviderTransport(
  activities: readonly OrchestrationThreadActivity[],
  nowMs: number,
) {
  const events = activities
    .map(summarizeDebugProviderTransportActivity)
    .filter((event): event is NonNullable<typeof event> => event !== null);
  const latest = events.at(-1) ?? null;
  const responseStreamDisconnectedCount = events.filter(
    (event) => event.responseStreamDisconnected,
  ).length;
  const retryEventCount = events.filter(
    (event) =>
      event.retrying ||
      event.willRetry === true ||
      event.retryAttempt !== null ||
      event.message?.startsWith("Reconnecting...") === true,
  ).length;
  const retryAttempts = events
    .map((event) => event.retryAttempt)
    .filter((value): value is number => value !== null);
  const retryLimits = events
    .map((event) => event.retryLimit)
    .filter((value): value is number => value !== null);

  return {
    eventCount: events.length,
    retryEventCount,
    responseStreamDisconnectedCount,
    maxRetryAttempt: retryAttempts.length > 0 ? Math.max(...retryAttempts) : null,
    retryLimit: retryLimits.length > 0 ? Math.max(...retryLimits) : null,
    atRetryLimit: events.some((event) => event.atRetryLimit),
    latest,
    latestEventAgeMs: elapsedDebugMs(nowMs, latest?.createdAt),
    events: events.slice(-DEBUG_RECENT_RUNTIME_EVENT_LIMIT),
  };
}

export function summarizeDebugTurnDiff(diff: TurnDiffSummary) {
  return {
    turnId: diff.turnId,
    completedAt: diff.completedAt,
    status: diff.status ?? null,
    checkpointRef: diff.checkpointRef ?? null,
    assistantMessageId: diff.assistantMessageId ?? null,
    checkpointTurnCount: diff.checkpointTurnCount ?? null,
    fileCount: diff.files.length,
    files: diff.files.slice(0, 20),
  };
}

function summarizeDebugLatestTurn(latestTurn: Thread["latestTurn"]) {
  if (!latestTurn) {
    return null;
  }
  return {
    turnId: latestTurn.turnId,
    state: latestTurn.state,
    requestedAt: latestTurn.requestedAt,
    startedAt: latestTurn.startedAt,
    completedAt: latestTurn.completedAt,
    assistantMessageId: latestTurn.assistantMessageId,
    sourceProposedPlan: latestTurn.sourceProposedPlan ?? null,
  };
}

function summarizeDebugSession(session: Thread["session"]) {
  if (!session) {
    return null;
  }
  return {
    provider: session.provider,
    providerInstanceId: session.providerInstanceId ?? null,
    status: session.status,
    orchestrationStatus: session.orchestrationStatus,
    activeTurnId: session.activeTurnId ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastError: session.lastError ?? null,
  };
}

function summarizeDebugGoal(goal: Thread["goal"]) {
  if (!goal) {
    return null;
  }
  // Goal objectives are user-authored prompt content. The debug endpoint only
  // needs lifecycle/accounting fields to diagnose continuation behavior.
  return {
    status: goal.status,
    tokenBudgetConfigured: goal.tokenBudget !== null,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

function activityIsLifecycleRelevant(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "runtime.warning" ||
    activity.kind === "runtime.error" ||
    activity.kind === "tool.started" ||
    activity.kind === "tool.updated" ||
    activity.kind === "tool.completed" ||
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.completed" ||
    activity.kind === "turn.plan.updated" ||
    activity.kind === "approval.requested" ||
    activity.kind === "approval.resolved" ||
    activity.kind === "user-input.requested" ||
    activity.kind === "user-input.resolved"
  );
}

export function summarizeDebugThreadLifecycle(thread: Thread, nowMs: number) {
  const session = thread.session;
  const latestTurn = thread.latestTurn;
  const activeTurnId = session?.activeTurnId ?? null;
  const latestTurnId = latestTurn?.turnId ?? null;
  const phase = derivePhase(session);
  const latestTurnSettled = isLatestTurnSettled(latestTurn, session);
  const activeTurnMessages =
    latestTurnId === null
      ? []
      : thread.messages.filter((message) => message.turnId === latestTurnId);
  const activeTurnActivities =
    latestTurnId === null
      ? []
      : thread.activities.filter((activity) => activity.turnId === latestTurnId);
  const streamingMessages = thread.messages.filter((message) => message.streaming);
  const latestTurnCompletedAt = latestTurn?.completedAt ?? null;
  const activitiesAfterLatestTurnCompleted =
    latestTurnId !== null && latestTurnCompletedAt !== null
      ? activeTurnActivities.filter((activity) => activity.createdAt > latestTurnCompletedAt)
      : [];
  const messagesAfterLatestTurnCompleted =
    latestTurnId !== null && latestTurnCompletedAt !== null
      ? activeTurnMessages.filter((message) => messageDebugEventAt(message) > latestTurnCompletedAt)
      : [];
  const providerContinuation = summarizeDebugProviderContinuation(thread, nowMs);
  const sessionActiveTurnMatchesLatestTurn =
    activeTurnId !== null && latestTurnId !== null && activeTurnId === latestTurnId;
  const staleCompletedActiveTurn =
    session?.status === "running" &&
    activeTurnId !== null &&
    sessionActiveTurnMatchesLatestTurn &&
    latestTurn?.state === "completed" &&
    latestTurn.completedAt !== null;
  const latestTurnCompletedButSessionRunning =
    latestTurn?.completedAt != null && session?.status === "running";
  const latestTurnReadyButSessionOwnsActiveTurn =
    latestTurn?.completedAt != null &&
    activeTurnId !== null &&
    sessionActiveTurnMatchesLatestTurn &&
    session?.orchestrationStatus !== "error" &&
    session?.orchestrationStatus !== "interrupted" &&
    session?.orchestrationStatus !== "stopped";
  const latestTurnRunningButSessionNotRunning =
    latestTurn?.state === "running" && session?.status !== "running";
  const hasStreamingMessagesButNotRunning = streamingMessages.length > 0 && phase !== "running";
  const redFlags = [
    staleCompletedActiveTurn ? "stale-completed-active-turn" : null,
    latestTurnCompletedButSessionRunning ? "latest-turn-completed-but-session-running" : null,
    latestTurnReadyButSessionOwnsActiveTurn ? "completed-turn-still-owned-by-session" : null,
    latestTurnRunningButSessionNotRunning ? "latest-turn-running-session-not-running" : null,
    hasStreamingMessagesButNotRunning ? "streaming-message-while-not-running" : null,
    messagesAfterLatestTurnCompleted.length > 0 ? "message-after-latest-turn-completed" : null,
    activitiesAfterLatestTurnCompleted.length > 0 ? "activity-after-latest-turn-completed" : null,
    (providerContinuation?.afterLatestTurnCompletedCount ?? 0) > 0
      ? "provider-signal-after-latest-turn-completed"
      : null,
    (providerContinuation?.afterEarliestCompletionSignalCount ?? 0) > 0
      ? "provider-signal-after-earliest-completion-signal"
      : null,
    (providerContinuation?.tokenUsageAfterEarliestCompletionSignalCount ?? 0) > 0
      ? "token-usage-after-completion-signal"
      : null,
  ].filter((value): value is string => value !== null);

  return {
    id: thread.id,
    title: thread.title,
    projectId: thread.projectId,
    phase,
    session: summarizeDebugSession(session),
    goal: summarizeDebugGoal(thread.goal),
    latestTurn: summarizeDebugLatestTurn(latestTurn),
    latestTurnSettled,
    activeTurnId,
    latestTurnId,
    sessionActiveTurnMatchesLatestTurn,
    isSessionRunning: session?.status === "running",
    isLatestTurnRunning: latestTurn?.state === "running",
    hasUnsettledLatestTurn: latestTurn !== null && !latestTurnSettled,
    staleCompletedActiveTurn,
    latestTurnCompletedButSessionRunning,
    latestTurnReadyButSessionOwnsActiveTurn,
    latestTurnRunningButSessionNotRunning,
    streamingMessageCount: streamingMessages.length,
    streamingMessageIds: streamingMessages.map((message) => message.id),
    hasStreamingMessagesButNotRunning,
    activeTurnMessageCount: activeTurnMessages.length,
    activeTurnActivityCount: activeTurnActivities.length,
    messageAfterLatestTurnCompletedCount: messagesAfterLatestTurnCompleted.length,
    activityAfterLatestTurnCompletedCount: activitiesAfterLatestTurnCompleted.length,
    redFlags,
    providerContinuation,
    latestActiveTurnMessage:
      activeTurnMessages.length > 0 ? summarizeDebugMessage(activeTurnMessages.at(-1)!) : null,
    latestActiveTurnActivity:
      activeTurnActivities.length > 0 ? summarizeDebugActivity(activeTurnActivities.at(-1)!) : null,
    latestMessageAfterLatestTurnCompleted:
      messagesAfterLatestTurnCompleted.length > 0
        ? summarizeDebugMessage(messagesAfterLatestTurnCompleted.at(-1)!)
        : null,
    latestActivityAfterLatestTurnCompleted:
      activitiesAfterLatestTurnCompleted.length > 0
        ? summarizeDebugActivity(activitiesAfterLatestTurnCompleted.at(-1)!)
        : null,
    recentLifecycleActivities: activeTurnActivities
      .filter(activityIsLifecycleRelevant)
      .slice(-12)
      .map(summarizeDebugActivity),
  };
}

export function summarizeDebugThreadPerformance(thread: Thread, nowMs: number) {
  const latestTurn = thread.latestTurn;
  const latestTurnId = latestTurn?.turnId ?? null;
  const latestTurnMessages =
    latestTurnId === null
      ? []
      : thread.messages.filter((message) => message.turnId === latestTurnId);
  const latestTurnActivities =
    latestTurnId === null
      ? []
      : thread.activities.filter((activity) => activity.turnId === latestTurnId);
  const firstAssistantMessage =
    latestTurnMessages.find((message) => message.role === "assistant") ?? null;
  const lastAssistantMessage =
    latestTurnMessages.findLast((message) => message.role === "assistant") ?? null;
  const latestMessage = thread.messages.at(-1) ?? null;
  const latestActivity = thread.activities.at(-1) ?? null;
  const latestTurnRuntimeActivities = latestTurnActivities.filter(
    (activity) => activity.kind === "runtime.warning" || activity.kind === "runtime.error",
  );
  const latestRuntimeActivity = latestTurnRuntimeActivities.at(-1) ?? null;
  const providerTransport = summarizeDebugProviderTransport(latestTurnRuntimeActivities, nowMs);
  const contextWindowActivities = thread.activities.filter(
    (activity) => activity.kind === "context-window.updated",
  );
  const latestContextWindowActivity = contextWindowActivities.at(-1) ?? null;
  const latestContextWindowPayload = readDebugRecord(latestContextWindowActivity?.payload);
  const codexCompaction = summarizeDebugCodexCompaction(thread, latestContextWindowPayload);
  const latestContextInputTokens =
    readDebugNumber(latestContextWindowPayload?.lastInputTokens) ??
    readDebugNumber(latestContextWindowPayload?.inputTokens);
  const messageTextChars = thread.messages.reduce(
    (total, message) => total + message.text.length,
    0,
  );
  const activitySummaryChars = thread.activities.reduce(
    (total, activity) => total + activity.summary.length,
    0,
  );
  const activityPayloadJsonChars = thread.activities.reduce(
    (total, activity) => total + estimateDebugJsonChars(activity.payload),
    0,
  );
  const streamingMessageCount = thread.messages.filter((message) => message.streaming).length;
  const activeTurnElapsedMs =
    latestTurn?.state === "running" ? elapsedDebugMs(nowMs, latestTurn.requestedAt) : null;
  const firstAssistantLatencyMs = durationDebugMs(
    latestTurn?.requestedAt,
    firstAssistantMessage?.createdAt,
  );
  const startedToFirstAssistantMs = durationDebugMs(
    latestTurn?.startedAt,
    firstAssistantMessage?.createdAt,
  );
  const assistantCompletionLatencyMs = durationDebugMs(
    latestTurn?.requestedAt,
    lastAssistantMessage?.completedAt ?? latestTurn?.completedAt,
  );
  const pressureFlags = [
    thread.messages.length >= DEBUG_THREAD_DETAIL_MESSAGE_LIMIT
      ? "message-window-at-server-limit"
      : null,
    thread.activities.length >= DEBUG_THREAD_DETAIL_ACTIVITY_LIMIT
      ? "activity-window-at-server-limit"
      : null,
    messageTextChars >= DEBUG_LARGE_THREAD_TEXT_CHARS ? "large-message-text-window" : null,
    activityPayloadJsonChars >= DEBUG_LARGE_ACTIVITY_PAYLOAD_CHARS
      ? "large-activity-payload-window"
      : null,
    streamingMessageCount > 0 && latestTurn?.state !== "running"
      ? "streaming-message-without-running-latest-turn"
      : null,
    latestTurnRuntimeActivities.length > 0 ? "latest-turn-runtime-warnings" : null,
    providerTransport.retryEventCount > 0 ? "provider-transport-retries" : null,
    providerTransport.responseStreamDisconnectedCount > 0
      ? "provider-response-stream-disconnects"
      : null,
    providerTransport.atRetryLimit ? "provider-transport-at-retry-limit" : null,
    latestTurn?.state === "running" &&
    providerTransport.latestEventAgeMs !== null &&
    providerTransport.latestEventAgeMs >= 60_000
      ? "running-turn-stalled-after-provider-transport-warning"
      : null,
    latestContextInputTokens !== null && latestContextInputTokens >= 100_000
      ? "large-context-input-token-count"
      : null,
  ].filter((flag): flag is string => flag !== null);

  return {
    modelSelection: thread.modelSelection,
    limits: {
      threadDetailMessageLimit: DEBUG_THREAD_DETAIL_MESSAGE_LIMIT,
      threadDetailActivityLimit: DEBUG_THREAD_DETAIL_ACTIVITY_LIMIT,
      recentMessageLimit: DEBUG_RECENT_MESSAGE_LIMIT,
      recentActivityLimit: DEBUG_RECENT_ACTIVITY_LIMIT,
      providerContinuationSignalLimit: DEBUG_PROVIDER_CONTINUATION_SIGNAL_LIMIT,
      providerCompletionBoundaryLimit: DEBUG_PROVIDER_COMPLETION_BOUNDARY_LIMIT,
    },
    counts: {
      messages: thread.messages.length,
      activities: thread.activities.length,
      latestTurnMessages: latestTurnMessages.length,
      latestTurnActivities: latestTurnActivities.length,
      latestTurnRuntimeActivities: latestTurnRuntimeActivities.length,
      contextWindowUpdates: contextWindowActivities.length,
      streamingMessages: streamingMessageCount,
    },
    approximateChars: {
      messageText: messageTextChars,
      activitySummaries: activitySummaryChars,
      activityPayloadJson: activityPayloadJsonChars,
    },
    latency: {
      latestTurnState: latestTurn?.state ?? null,
      latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
      latestTurnStartedAt: latestTurn?.startedAt ?? null,
      latestTurnCompletedAt: latestTurn?.completedAt ?? null,
      requestedToStartedMs: durationDebugMs(latestTurn?.requestedAt, latestTurn?.startedAt),
      requestedToFirstAssistantMs: firstAssistantLatencyMs,
      startedToFirstAssistantMs,
      requestedToAssistantCompletedMs: assistantCompletionLatencyMs,
      activeTurnElapsedMs,
      lastMessageAgeMs: elapsedDebugMs(nowMs, latestMessage?.createdAt),
      lastActivityAgeMs: elapsedDebugMs(nowMs, latestActivity?.createdAt),
    },
    latestMessage: latestMessage === null ? null : summarizeDebugMessage(latestMessage),
    latestActivity: latestActivity === null ? null : summarizeDebugActivity(latestActivity),
    latestRuntimeActivity:
      latestRuntimeActivity === null ? null : summarizeDebugActivity(latestRuntimeActivity),
    providerTransport,
    latestContextWindowActivity: summarizeDebugContextWindowActivity(latestContextWindowActivity),
    compaction: codexCompaction,
    pressureFlags,
  };
}

export function summarizeDebugNotableThread(input: {
  readonly thread: Thread;
  readonly lifecycle: ReturnType<typeof summarizeDebugThreadLifecycle> | null;
  readonly nowMs: number;
}) {
  return {
    id: input.thread.id,
    title: input.thread.title,
    projectId: input.thread.projectId,
    worktreePath: input.thread.worktreePath,
    error: input.thread.error ?? null,
    session: summarizeDebugSession(input.thread.session),
    latestTurn: summarizeDebugLatestTurn(input.thread.latestTurn),
    lifecycle: input.lifecycle,
    performance: summarizeDebugThreadPerformance(input.thread, input.nowMs),
  };
}
