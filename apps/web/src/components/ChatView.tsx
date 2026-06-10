import {
  type ApprovalRequestId,
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type DesktopRendererDebugSnapshot,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  type ServerProvider,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  ProviderDriverKind,
  RuntimeMode,
  type UploadChatAttachment as OrchestrationUploadChatAttachment,
} from "@cafecode/contracts";
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@cafecode/client-runtime";
import {
  applyClaudePromptEffortPrefix,
  createModelSelection,
  resolvePromptInjectedEffort,
} from "@cafecode/shared/model";
import {
  CODEX_AUTO_COMPACT_POLICY_SOURCE,
  CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
  CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_SCOPE,
} from "@cafecode/shared/codexCompaction";
import { truncate } from "@cafecode/shared/String";
import { Debouncer } from "@tanstack/react-pacer";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useGitStatus } from "~/lib/gitStatusState";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { readEnvironmentApi } from "../environmentApi";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import {
  collapseExpandedComposerCursor,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import {
  deriveCompletionDividerAfterEntryId,
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveHistoricalWorkLogSummaries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  formatElapsed,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import {
  selectProjectByRef,
  selectProjectsAcrossEnvironments,
  selectThreadByRef,
  selectThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type TurnDiffSummary,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { buildTemporaryWorktreeBranchName } from "@cafecode/shared/git";
import { useIsMobile, useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { BranchToolbar } from "./BranchToolbar";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import PlanSidebar from "./PlanSidebar";
import { ChevronDownIcon, TriangleAlertIcon, WifiOffIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { newCommandId, newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import { getProviderModelCapabilities, resolveSelectableProvider } from "../providerModels";
import { useSettings } from "../hooks/useSettings";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  reconnectSavedEnvironment,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { buildDraftThreadRouteParams } from "../threadRoutes";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import {
  ChatComposer,
  type ChatComposerHandle,
  type FollowUpQueueViewItem,
  type SteeringFollowUpViewItem,
} from "./chat/ChatComposer";
import {
  canExpandQueuedFollowUpText,
  canStartQueuedFollowUpTurn,
  decideQueuedFollowUpAction,
  decideFollowUpDelivery,
  hasQueuedFollowUpDispatchBeenObserved,
  isLiveSteerAvailableForThread,
  previewQueuedFollowUpText,
  queuedFollowUpActionLabel,
  queuedFollowUpActionTitle,
  rekeyQueuedFollowUpsForActiveThread,
  selectQueuedFollowUpDispatchCandidate,
} from "./chat/followUpQueue";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { ChatHeader } from "./chat/ChatHeader";
import { type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { NoActiveThreadState } from "./NoActiveThreadState";
import { resolveEffectiveEnvMode, resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { ProviderStatusBanner } from "./chat/ProviderStatusBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import {
  buildLocalDraftThread,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  hasServerAcknowledgedLocalDispatch,
  type LocalDispatchSnapshot,
  PullRequestDialogState,
  cloneComposerImageForRetry,
  deriveLockedProvider,
  mergePendingSteerSnapshotsForInterruptedTurn,
  readFileAsDataUrl,
  resolveFollowUpQueuePhase,
  resolveSendEnvMode,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  shouldReplayCodexPendingSteerAfterTerminal,
  shouldPinTimelineToEndForLocalMessage,
  shouldWriteThreadErrorToCurrentServerThread,
  waitForStartedServerThread,
} from "./ChatView.logic";
import { useComposerHandleContext } from "../composerHandleContext";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerKeybindings,
  useServerTerminal,
} from "~/rpc/serverState";
import { sanitizeThreadErrorMessage } from "~/rpc/transportError";
import { retainThreadDetailSubscription } from "../environments/runtime/service";
import { RightPanelSheet } from "./RightPanelSheet";
import { deriveDebugWaitReasons } from "./chat/debugWaitReasons";
import { Button } from "./ui/button";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
} from "../versionSkew";

const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROPOSED_PLANS: Thread["proposedPlans"] = [];
const DEBUG_SNAPSHOT_VERSION = 10;
const DEBUG_TEXT_PREVIEW_LIMIT = 120;
const DEBUG_JSON_PREVIEW_LIMIT = 600;
const DEBUG_RECENT_MESSAGE_LIMIT = 6;
const DEBUG_RECENT_ACTIVITY_LIMIT = 10;
const DEBUG_RECENT_RUNTIME_EVENT_LIMIT = 6;
const DEBUG_PROVIDER_CONTINUATION_SIGNAL_LIMIT = 8;
const DEBUG_PROVIDER_COMPLETION_BOUNDARY_LIMIT = 8;
const DEBUG_INTERESTING_THREAD_LIMIT = 16;
const DEBUG_THREAD_DETAIL_MESSAGE_LIMIT = 2_000;
const DEBUG_THREAD_DETAIL_ACTIVITY_LIMIT = 500;
const DEBUG_RENDERER_HEARTBEAT_INTERVAL_MS = 5_000;
const DEBUG_RENDERER_SNAPSHOT_MIN_INTERVAL_MS = 250;
const DEBUG_LARGE_THREAD_TEXT_CHARS = 1_000_000;
const DEBUG_LARGE_ACTIVITY_PAYLOAD_CHARS = 1_000_000;
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

function readDebugRecord(value: unknown): Record<string, unknown> | null {
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

function readDebugString(value: unknown): string | null {
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
    outputTokens: readDebugNumber(payload.outputTokens),
    reasoningOutputTokens: readDebugNumber(payload.reasoningOutputTokens),
    lastUsedTokens: readDebugNumber(payload.lastUsedTokens),
    lastInputTokens: readDebugNumber(payload.lastInputTokens),
    lastCachedInputTokens: readDebugNumber(payload.lastCachedInputTokens),
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
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
    },
    latestDelta: {
      usedTokens: usage.lastUsedTokens,
      inputTokens: usage.lastInputTokens,
      cachedInputTokens: usage.lastCachedInputTokens,
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

function threadHasActiveContextCompaction(thread: Thread, activeTurnId: TurnId | null): boolean {
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
      autoCompactTokenLimit: CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
      autoCompactTokenLimitScope: CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_SCOPE,
      appliesTo: ["thread/start", "thread/resume"],
      latestTokenUsagePayloadLimit: latestPayloadLimit,
    },
    latestContextWindow: {
      usedTokens: latestUsedTokens,
      inputTokens: latestInputTokens,
      maxTokens: readDebugNumber(latestContextWindowPayload?.maxTokens),
      abovePolicyLimit:
        latestUsedTokens !== null && latestUsedTokens >= CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
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

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function roundDebugMs(value: number): number {
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

function summarizeDebugMessage(message: ChatMessage) {
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

function summarizeDebugActivity(activity: OrchestrationThreadActivity) {
  return {
    id: activity.id,
    kind: activity.kind,
    tone: activity.tone,
    summaryLength: activity.summary.length,
    summaryPreview: truncateDebugText(activity.summary),
    turnId: activity.turnId,
    sequence: activity.sequence ?? null,
    createdAt: activity.createdAt,
    payloadKeys: payloadKeys(activity.payload),
    payloadPreview: stringifyDebugPreview(activity.payload),
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
    summary: activity.summary,
    payloadKeys: payloadKeys(activity.payload),
    payloadPreview: stringifyDebugPreview(activity.payload, 500),
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

function summarizeDebugTurnDiff(diff: TurnDiffSummary) {
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

function summarizeDebugThreadLifecycle(thread: Thread, nowMs: number) {
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

function summarizeDebugThreadPerformance(thread: Thread, nowMs: number) {
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

function summarizeDebugNotableThread(input: {
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

const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const EMPTY_FOLLOW_UP_QUEUE: FollowUpQueueItem[] = [];
const FOLLOW_UP_QUEUE_WATCHDOG_INTERVAL_MS = 1000;
type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: "connecting" | "disconnected" | "error";
};

function readComposerHandle(
  composerRef: RefObject<ChatComposerHandle | null>,
): ChatComposerHandle | null {
  return composerRef.current;
}

type ThreadPlanCatalogEntry = Pick<Thread, "id" | "proposedPlans">;

function useThreadPlanCatalog(threadIds: readonly ThreadId[]): ThreadPlanCatalogEntry[] {
  return useStore(
    useMemo(() => {
      let previousThreadIds: readonly ThreadId[] = [];
      let previousResult: ThreadPlanCatalogEntry[] = [];
      let previousEntries = new Map<
        ThreadId,
        {
          shell: object | null;
          proposedPlanIds: readonly string[] | undefined;
          proposedPlansById: Record<string, Thread["proposedPlans"][number]> | undefined;
          entry: ThreadPlanCatalogEntry;
        }
      >();

      return (state) => {
        const sameThreadIds =
          previousThreadIds.length === threadIds.length &&
          previousThreadIds.every((id, index) => id === threadIds[index]);
        const nextEntries = new Map<
          ThreadId,
          {
            shell: object | null;
            proposedPlanIds: readonly string[] | undefined;
            proposedPlansById: Record<string, Thread["proposedPlans"][number]> | undefined;
            entry: ThreadPlanCatalogEntry;
          }
        >();
        const nextResult: ThreadPlanCatalogEntry[] = [];
        let changed = !sameThreadIds;

        for (const threadId of threadIds) {
          let shell: object | undefined;
          let proposedPlanIds: readonly string[] | undefined;
          let proposedPlansById: Record<string, Thread["proposedPlans"][number]> | undefined;

          for (const environmentState of Object.values(state.environmentStateById)) {
            const matchedShell = environmentState.threadShellById[threadId];
            if (!matchedShell) {
              continue;
            }
            shell = matchedShell;
            proposedPlanIds = environmentState.proposedPlanIdsByThreadId[threadId];
            proposedPlansById = environmentState.proposedPlanByThreadId[threadId] as
              | Record<string, Thread["proposedPlans"][number]>
              | undefined;
            break;
          }

          if (!shell) {
            const previous = previousEntries.get(threadId);
            if (
              previous &&
              previous.shell === null &&
              previous.proposedPlanIds === undefined &&
              previous.proposedPlansById === undefined
            ) {
              nextEntries.set(threadId, previous);
              continue;
            }
            changed = true;
            nextEntries.set(threadId, {
              shell: null,
              proposedPlanIds: undefined,
              proposedPlansById: undefined,
              entry: { id: threadId, proposedPlans: EMPTY_PROPOSED_PLANS },
            });
            continue;
          }

          const previous = previousEntries.get(threadId);
          if (
            previous &&
            previous.shell === shell &&
            previous.proposedPlanIds === proposedPlanIds &&
            previous.proposedPlansById === proposedPlansById
          ) {
            nextEntries.set(threadId, previous);
            nextResult.push(previous.entry);
            continue;
          }

          changed = true;
          const proposedPlans =
            proposedPlanIds && proposedPlanIds.length > 0 && proposedPlansById
              ? proposedPlanIds.flatMap((planId) => {
                  const proposedPlan = proposedPlansById?.[planId];
                  return proposedPlan ? [proposedPlan] : [];
                })
              : EMPTY_PROPOSED_PLANS;
          const entry = { id: threadId, proposedPlans };
          nextEntries.set(threadId, {
            shell,
            proposedPlanIds,
            proposedPlansById,
            entry,
          });
          nextResult.push(entry);
        }

        if (!changed && previousResult.length === nextResult.length) {
          return previousResult;
        }

        previousThreadIds = threadIds;
        previousEntries = nextEntries;
        previousResult = nextResult;
        return nextResult;
      };
    }, [threadIds]),
  );
}

function formatOutgoingPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  const promptEffort = resolvePromptInjectedEffort(caps, params.effort);
  return applyClaudePromptEffortPrefix(params.text, promptEffort);
}
type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      routeKind: "draft";
      draftId: DraftId;
    };

interface ComposerSendSnapshot {
  promptText: string;
  images: ComposerImageAttachment[];
  provider: ProviderDriverKind;
  model: string | null;
  providerModels: ReadonlyArray<ServerProvider["models"][number]>;
  promptEffort: string | null;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
}

interface FollowUpQueueItem extends ComposerSendSnapshot {
  id: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  queuedAt: string;
  expanded: boolean;
  blockedReason: string | null;
  automaticSteerRetry?: {
    readonly nonSteerableTurnKind: CodexNonSteerableTurnKind;
    readonly sourceMessageId: MessageId;
  } | null;
}

interface QueuedFollowUpPendingDispatch {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  messageId: MessageId;
  dispatchedAt: string;
}

type CodexNonSteerableTurnKind = "review" | "compact";

interface PendingSteerDispatch {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly turnId: TurnId | null;
  readonly snapshot: ComposerSendSnapshot;
  readonly dispatchedAt: string;
}

interface PendingSteerInterruptRecovery {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly interruptedTurnId: TurnId | null;
  readonly pendingMessageIds: readonly MessageId[];
  readonly requestedAt: string;
}

function pendingSteerDispatchesForThread(
  current: Record<string, PendingSteerDispatch>,
  threadId: ThreadId,
): PendingSteerDispatch[] {
  return Object.values(current)
    .filter((pending) => pending.threadId === threadId)
    .toSorted((left, right) => left.dispatchedAt.localeCompare(right.dispatchedAt));
}

function threadHasProviderInterruptCompletedForRecovery(
  thread: Thread,
  recovery: PendingSteerInterruptRecovery,
): boolean {
  return thread.activities.some((activity) => {
    if (activity.kind !== "provider.turn.interrupt.completed") {
      return false;
    }
    if (activity.createdAt < recovery.requestedAt) {
      return false;
    }
    return recovery.interruptedTurnId === null || activity.turnId === recovery.interruptedTurnId;
  });
}

function threadHasProviderInterruptFailedForRecovery(
  thread: Thread,
  recovery: PendingSteerInterruptRecovery,
): boolean {
  return thread.activities.some((activity) => {
    if (activity.kind !== "provider.turn.interrupt.failed") {
      return false;
    }
    if (activity.createdAt < recovery.requestedAt) {
      return false;
    }
    return recovery.interruptedTurnId === null || activity.turnId === recovery.interruptedTurnId;
  });
}

function readRetryableSteerFailure(
  activity: OrchestrationThreadActivity,
): { readonly messageId: MessageId; readonly turnKind: CodexNonSteerableTurnKind } | null {
  if (activity.kind !== "provider.turn.steer.failed") {
    return null;
  }
  const payload = readDebugRecord(activity.payload);
  if (payload === null || readDebugBoolean(payload.retryableFollowUp) !== true) {
    return null;
  }
  const messageId = readDebugString(payload.messageId);
  const turnKind = readDebugString(payload.codexNonSteerableTurnKind);
  if (messageId === null || (turnKind !== "review" && turnKind !== "compact")) {
    return null;
  }
  return {
    messageId: MessageId.make(messageId),
    turnKind,
  };
}

function isAutomaticSteerRetryItem(item: FollowUpQueueItem): boolean {
  return item.automaticSteerRetry != null;
}

function resolveAutomaticSteerRetryBlocker(input: {
  readonly item: FollowUpQueueItem;
  readonly thread: Thread;
  readonly phase: SessionPhase;
}): "context-compaction-active" | "review-active-turn" | null {
  const retry = input.item.automaticSteerRetry ?? null;
  if (retry === null) {
    return null;
  }

  // Upstream Codex reports `activeTurnNotSteerable` for `/review` and
  // `/compact`. A compact-blocked steer should be retried only after the
  // compaction item finishes; a review-blocked steer must wait until the
  // current active turn is no longer running and can become the next turn.
  if (retry.nonSteerableTurnKind === "compact") {
    if (
      input.phase === "running" &&
      threadHasActiveContextCompaction(input.thread, input.thread.session?.activeTurnId ?? null)
    ) {
      return "context-compaction-active";
    }
    return null;
  }

  return input.phase === "running" ? "review-active-turn" : null;
}

function readSteerFailureMessageId(activity: OrchestrationThreadActivity): MessageId | null {
  if (activity.kind !== "provider.turn.steer.failed") {
    return null;
  }
  const payload = readDebugRecord(activity.payload);
  const messageId = readDebugString(payload?.messageId);
  return messageId === null ? null : MessageId.make(messageId);
}

function readSteerRecoveryMessageId(activity: OrchestrationThreadActivity): MessageId | null {
  if (activity.kind !== "runtime.warning") {
    return null;
  }
  const payload = readDebugRecord(activity.payload);
  if (readDebugString(payload?.recovery) !== "turn-start-after-no-active-turn") {
    return null;
  }
  const messageId = readDebugString(payload?.messageId);
  return messageId === null ? null : MessageId.make(messageId);
}

function threadHasAssistantResponseAfterSteer(thread: Thread, pending: PendingSteerDispatch) {
  return thread.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.createdAt > pending.dispatchedAt &&
      (pending.turnId === null || message.turnId === pending.turnId),
  );
}

function threadHasTerminalTurnAfterSteer(thread: Thread, pending: PendingSteerDispatch) {
  const latestTurn = thread.latestTurn;
  return (
    latestTurn !== null &&
    latestTurn.completedAt !== null &&
    latestTurn.completedAt > pending.dispatchedAt &&
    (pending.turnId === null || latestTurn.turnId === pending.turnId)
  );
}

function threadHasSteerFailureForMessage(thread: Thread, messageId: MessageId) {
  return thread.activities.some((activity) => readSteerFailureMessageId(activity) === messageId);
}

function threadHasSteerRecoveryForMessage(thread: Thread, messageId: MessageId) {
  return thread.activities.some((activity) => readSteerRecoveryMessageId(activity) === messageId);
}

function threadHasSteerProcessingStarted(thread: Thread, pending: PendingSteerDispatch) {
  return thread.activities.some((activity) => {
    if (activity.kind !== "task.progress") {
      return false;
    }
    if (activity.createdAt < pending.dispatchedAt) {
      return false;
    }

    const payload = readDebugRecord(activity.payload);
    const taskId = readDebugString(payload?.taskId);
    const description = readDebugString(payload?.description);
    const isSteerProcessingActivity =
      taskId?.startsWith("codex-turn-steer-processing:") === true ||
      description === "Codex app-server began processing turn/steer.";
    if (!isSteerProcessingActivity) {
      return false;
    }
    if (pending.turnId === null || activity.turnId === pending.turnId) {
      return true;
    }

    // Codex can ACK a turn/start or steer against Cafe's provisional active
    // turn id, then report the concrete app-server active turn under a
    // different id. The backend repairs that projection, but the renderer may
    // still be holding an older pending-steer marker from before the repair.
    // Treat the explicit Codex steer-processing marker as enough to clear that
    // marker when it lands on the current provider-owned turn for the same
    // thread; unrelated task.progress rows still cannot clear it.
    return (
      thread.session?.provider === "codex" &&
      activity.turnId !== null &&
      (activity.turnId === thread.session.activeTurnId ||
        activity.turnId === thread.latestTurn?.turnId)
    );
  });
}

function threadHasResolvedPendingSteer(thread: Thread, pending: PendingSteerDispatch) {
  const hasExplicitProcessingStarted = threadHasSteerProcessingStarted(thread, pending);
  if (
    threadHasSteerRecoveryForMessage(thread, pending.messageId) ||
    threadHasSteerFailureForMessage(thread, pending.messageId)
  ) {
    return true;
  }

  if (thread.session?.provider === "codex") {
    // Upstream Codex app-server ACKs `turn/steer` before the steer is visible in
    // the active turn. Keep Cafe's UI in a pending "steering" state until the
    // provider emits the explicit processing-start signal instead of clearing on
    // unrelated assistant text that was already in flight.
    return hasExplicitProcessingStarted;
  }

  return (
    hasExplicitProcessingStarted ||
    threadHasAssistantResponseAfterSteer(thread, pending) ||
    threadHasTerminalTurnAfterSteer(thread, pending)
  );
}

function threadShouldReplayUnprocessedTerminalCodexSteer(
  thread: Thread,
  pending: PendingSteerDispatch,
): boolean {
  return shouldReplayCodexPendingSteerAfterTerminal({
    provider: thread.session?.provider,
    terminalTurnAfterSteer: threadHasTerminalTurnAfterSteer(thread, pending),
    steerProcessingStarted: threadHasSteerProcessingStarted(thread, pending),
    steerFailureRecorded: threadHasSteerFailureForMessage(thread, pending.messageId),
    steerRecoveryRecorded: threadHasSteerRecoveryForMessage(thread, pending.messageId),
  });
}

function revokeQueuedFollowUpPreviewUrls(item: FollowUpQueueItem): void {
  for (const image of item.images) {
    revokeBlobPreviewUrl(image.previewUrl);
  }
}

function optimisticAttachmentsForSnapshot(snapshot: ComposerSendSnapshot) {
  return snapshot.images.map((image) => ({
    type: "image" as const,
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    previewUrl: image.previewUrl,
  }));
}

function useLocalDispatchState(input: {
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);

  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean }) => {
      const preparingWorktree = Boolean(options?.preparingWorktree);
      setLocalDispatch((current) => {
        if (current) {
          return current.preparingWorktree === preparingWorktree
            ? current
            : { ...current, preparingWorktree };
        }
        return createLocalDispatchSnapshot(input.activeThread, options);
      });
    },
    [input.activeThread],
  );

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, []);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        session: input.activeThread?.session ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeThread?.session,
      input.phase,
      input.threadError,
      localDispatch,
    ],
  );

  useEffect(() => {
    if (!serverAcknowledgedLocalDispatch) {
      return;
    }
    resetLocalDispatch();
  }, [resetLocalDispatch, serverAcknowledgedLocalDispatch]);

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: localDispatch?.startedAt ?? null,
    isPreparingWorktree: localDispatch?.preparingWorktree ?? false,
    isSendBusy: localDispatch !== null && !serverAcknowledgedLocalDispatch,
    serverAcknowledgedLocalDispatch,
  };
}

export default function ChatView(props: ChatViewProps) {
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    reserveTitleBarControlInset = true,
  } = props;
  const draftId = routeKind === "draft" ? props.draftId : null;
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef]);
  const composerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  const serverThread = useStore(
    useMemo(
      () => createThreadSelectorByRef(routeKind === "server" ? routeThreadRef : null),
      [routeKind, routeThreadRef],
    ),
  );
  const setStoreThreadError = useStore((store) => store.setError);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const activeThreadLastVisitedAt = useUiStateStore((store) =>
    routeKind === "server" ? store.threadLastVisitedAtById[routeThreadKey] : undefined,
  );
  const persistedPlanSidebarOpen = useUiStateStore((store) =>
    routeKind === "server" ? store.threadPlanSidebarOpenById[routeThreadKey] : undefined,
  );
  const setPersistedPlanSidebarOpen = useUiStateStore((store) => store.setThreadPlanSidebarOpen);
  const settings = useSettings();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const autoOpenPlanSidebar = settings.autoOpenPlanSidebar;
  const navigate = useNavigate();
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const { resolvedTheme } = useTheme();
  // Granular store selectors — avoid subscribing to prompt changes.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const [stickTimelineToEndRevision, setStickTimelineToEndRevision] = useState(0);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, string | null>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [draftPlanSidebarOpenByThreadKey, setDraftPlanSidebarOpenByThreadKey] = useState<
    Record<string, boolean>
  >({});
  const shouldUsePlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const isMobile = useIsMobile();
  const draftPlanSidebarOpen =
    routeKind === "draft" ? draftPlanSidebarOpenByThreadKey[routeThreadKey] : undefined;
  const planSidebarOpenPreference =
    routeKind === "server" ? persistedPlanSidebarOpen : draftPlanSidebarOpen;
  const planSidebarOpen = planSidebarOpenPreference === true;
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [pendingServerThreadEnvMode, setPendingServerThreadEnvMode] =
    useState<DraftThreadEnvMode | null>(null);
  const [pendingServerThreadBranch, setPendingServerThreadBranch] = useState<string | null>();
  const legendListRef = useRef<LegendListRef | null>(null);
  const isAtEndRef = useRef(true);
  const timelineUserScrollIntentSinceResetRef = useRef(false);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  const sendInFlightRef = useRef(false);
  const queueDispatchInFlightRef = useRef(false);
  const pendingSteerDispatchByMessageIdRef = useRef<Record<string, PendingSteerDispatch>>({});
  const [pendingSteerDispatchByMessageId, setPendingSteerDispatchByMessageId] = useState<
    Record<string, PendingSteerDispatch>
  >({});
  const pendingSteerInterruptRecoveryByThreadIdRef = useRef<
    Record<string, PendingSteerInterruptRecovery>
  >({});
  const [pendingSteerInterruptRecoveryByThreadId, setPendingSteerInterruptRecoveryByThreadId] =
    useState<Record<string, PendingSteerInterruptRecovery>>({});
  const [desktopDebugEnabled, setDesktopDebugEnabled] = useState(false);
  const [desktopDebugRevision, setDesktopDebugRevision] = useState(0);
  const lastDesktopDebugSnapshotPublishedAtMsRef = useRef(0);
  const desktopDebugSnapshotThrottleTimeoutRef = useRef<number | null>(null);
  const followUpQueueDebugRef = useRef({
    watchdogIntervalMs: FOLLOW_UP_QUEUE_WATCHDOG_INTERVAL_MS,
    watchdogTickCount: 0,
    lastTickAt: null as string | null,
    lastAttemptAt: null as string | null,
    lastAttemptSource: null as string | null,
    lastAttemptResult: null as string | null,
    lastAttemptThreadId: null as string | null,
    lastAttemptItemId: null as string | null,
  });
  const [dispatchGateRevision, setDispatchGateRevision] = useState(0);
  const setSendInFlight = useCallback((next: boolean) => {
    if (sendInFlightRef.current === next) return;
    sendInFlightRef.current = next;
    setDispatchGateRevision((revision) => revision + 1);
  }, []);
  const setQueueDispatchInFlight = useCallback((next: boolean) => {
    if (queueDispatchInFlightRef.current === next) return;
    queueDispatchInFlightRef.current = next;
    setDispatchGateRevision((revision) => revision + 1);
  }, []);
  const updatePendingSteerDispatches = useCallback(
    (
      updater: (
        current: Record<string, PendingSteerDispatch>,
      ) => Record<string, PendingSteerDispatch>,
    ) => {
      const current = pendingSteerDispatchByMessageIdRef.current;
      const next = updater(current);
      if (next === current) {
        return;
      }
      pendingSteerDispatchByMessageIdRef.current = next;
      setPendingSteerDispatchByMessageId(next);
      if (desktopDebugEnabled) {
        setDesktopDebugRevision((revision) => revision + 1);
      }
    },
    [desktopDebugEnabled],
  );
  const removePendingSteerDispatch = useCallback(
    (messageId: MessageId) => {
      updatePendingSteerDispatches((current) => {
        if (!(String(messageId) in current)) {
          return current;
        }
        const next = { ...current };
        delete next[String(messageId)];
        return next;
      });
    },
    [updatePendingSteerDispatches],
  );
  const updatePendingSteerInterruptRecoveries = useCallback(
    (
      updater: (
        current: Record<string, PendingSteerInterruptRecovery>,
      ) => Record<string, PendingSteerInterruptRecovery>,
    ) => {
      const current = pendingSteerInterruptRecoveryByThreadIdRef.current;
      const next = updater(current);
      if (next === current) {
        return;
      }
      pendingSteerInterruptRecoveryByThreadIdRef.current = next;
      setPendingSteerInterruptRecoveryByThreadId(next);
      if (desktopDebugEnabled) {
        setDesktopDebugRevision((revision) => revision + 1);
      }
    },
    [desktopDebugEnabled],
  );
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.getDebugEndpointState) {
      return;
    }

    let cancelled = false;
    void bridge
      .getDebugEndpointState()
      .then((debugState) => {
        if (!cancelled) {
          setDesktopDebugEnabled(debugState.enabled);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopDebugEnabled(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!desktopDebugEnabled) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setDesktopDebugRevision((revision) => revision + 1);
    }, DEBUG_RENDERER_HEARTBEAT_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [desktopDebugEnabled]);
  useEffect(
    () => () => {
      if (desktopDebugSnapshotThrottleTimeoutRef.current !== null) {
        window.clearTimeout(desktopDebugSnapshotThrottleTimeoutRef.current);
        desktopDebugSnapshotThrottleTimeoutRef.current = null;
      }
    },
    [],
  );
  const dispatchFollowUpTurnStartRef = useRef<((item: FollowUpQueueItem) => Promise<void>) | null>(
    null,
  );
  const dispatchQueuedSteerRetryRef = useRef<((item: FollowUpQueueItem) => Promise<void>) | null>(
    null,
  );
  const [followUpQueueByThreadId, setFollowUpQueueByThreadId] = useState<
    Record<string, FollowUpQueueItem[]>
  >({});
  const followUpQueueByThreadIdRef = useRef(followUpQueueByThreadId);
  followUpQueueByThreadIdRef.current = followUpQueueByThreadId;
  const [queuedFollowUpPendingDispatchByThreadId, setQueuedFollowUpPendingDispatchByThreadId] =
    useState<Record<string, QueuedFollowUpPendingDispatch>>({});
  const queuedFollowUpPendingDispatchByThreadIdRef = useRef<
    Record<string, QueuedFollowUpPendingDispatch>
  >(queuedFollowUpPendingDispatchByThreadId);
  queuedFollowUpPendingDispatchByThreadIdRef.current = queuedFollowUpPendingDispatchByThreadId;

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useStore(
    useMemo(() => createProjectSelectorByRef(fallbackDraftProjectRef), [fallbackDraftProjectRef]),
  );
  const localDraftError =
    routeKind === "server" && serverThread
      ? null
      : ((draftId ? localDraftErrorsByDraftId[draftId] : null) ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? {
              instanceId: ProviderInstanceId.make("codex"),
              model: DEFAULT_MODEL,
            },
            localDraftError,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, localDraftError, threadId],
  );
  const isServerThread = routeKind === "server" && serverThread !== undefined;
  const activeThread = isServerThread ? serverThread : localDraftThread;
  const runtimeMode = composerRuntimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const diffOpen = rawSearch.diff === "1";
  // Compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const allThreads = useStore(useShallow(selectThreadsAcrossEnvironments));
  const activeThreadId = activeThread?.id ?? null;
  const recordFollowUpQueueDebugAttempt = useCallback(
    (
      source: string,
      result: string,
      details: { readonly threadId?: ThreadId | null; readonly itemId?: string | null } = {},
    ) => {
      const now = new Date().toISOString();
      followUpQueueDebugRef.current = {
        ...followUpQueueDebugRef.current,
        watchdogTickCount:
          source === "watchdog"
            ? followUpQueueDebugRef.current.watchdogTickCount + 1
            : followUpQueueDebugRef.current.watchdogTickCount,
        lastTickAt: source === "watchdog" ? now : followUpQueueDebugRef.current.lastTickAt,
        lastAttemptAt: now,
        lastAttemptSource: source,
        lastAttemptResult: result,
        lastAttemptThreadId: details.threadId ?? activeThreadId,
        lastAttemptItemId: details.itemId ?? null,
      };
      if (desktopDebugEnabled) {
        setDesktopDebugRevision((revision) => revision + 1);
      }
    },
    [activeThreadId, desktopDebugEnabled],
  );
  const knownThreadIds = useMemo(
    () => new Set<string>(allThreads.map((thread) => thread.id)),
    [allThreads],
  );
  const previousActiveThreadIdRef = useRef<ThreadId | null>(null);
  useEffect(() => {
    if (!activeThreadId) {
      return;
    }

    const previousActiveThreadId = previousActiveThreadIdRef.current;
    if (previousActiveThreadId !== activeThreadId) {
      previousActiveThreadIdRef.current = activeThreadId;
    }

    setFollowUpQueueByThreadId((existing) =>
      rekeyQueuedFollowUpsForActiveThread({
        queuesByThreadId: existing,
        activeThreadId,
        previousActiveThreadId,
        knownThreadIds,
      }),
    );
  }, [activeThreadId, knownThreadIds]);
  const setQueuedFollowUpPendingDispatch = useCallback(
    (pending: QueuedFollowUpPendingDispatch | null, targetThreadId: ThreadId) => {
      const current = queuedFollowUpPendingDispatchByThreadIdRef.current;
      if (pending === null) {
        if (!(targetThreadId in current)) return;
        const next = { ...current };
        delete next[targetThreadId];
        queuedFollowUpPendingDispatchByThreadIdRef.current = next;
        setQueuedFollowUpPendingDispatchByThreadId(next);
        return;
      }

      const existing = current[targetThreadId];
      if (
        existing?.environmentId === pending.environmentId &&
        existing.threadId === pending.threadId &&
        existing.messageId === pending.messageId &&
        existing.dispatchedAt === pending.dispatchedAt
      ) {
        return;
      }
      queuedFollowUpPendingDispatchByThreadIdRef.current = {
        ...current,
        [targetThreadId]: pending,
      };
      setQueuedFollowUpPendingDispatchByThreadId(
        queuedFollowUpPendingDispatchByThreadIdRef.current,
      );
    },
    [],
  );
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  useEffect(() => {
    if (!activeThread) {
      return;
    }

    for (const activity of activeThread.activities) {
      const retryableFailure = readRetryableSteerFailure(activity);
      if (retryableFailure === null) {
        continue;
      }
      const pending =
        pendingSteerDispatchByMessageIdRef.current[String(retryableFailure.messageId)];
      if (!pending) {
        continue;
      }

      removePendingSteerDispatch(retryableFailure.messageId);
      setOptimisticUserMessages((existing) => {
        const removed = existing.filter((message) => message.id === retryableFailure.messageId);
        for (const message of removed) {
          revokeUserMessagePreviewUrls(message);
        }
        return existing.filter((message) => message.id !== retryableFailure.messageId);
      });

      const queuedItem: FollowUpQueueItem = {
        ...pending.snapshot,
        id: newMessageId(),
        environmentId: pending.environmentId,
        threadId: pending.threadId,
        queuedAt: activity.createdAt,
        expanded: false,
        blockedReason: null,
        automaticSteerRetry: {
          nonSteerableTurnKind: retryableFailure.turnKind,
          sourceMessageId: retryableFailure.messageId,
        },
      };
      setFollowUpQueueByThreadId((existing) => ({
        ...existing,
        [pending.threadId]: [...(existing[pending.threadId] ?? EMPTY_FOLLOW_UP_QUEUE), queuedItem],
      }));
    }
  }, [activeThread, removePendingSteerDispatch, setFollowUpQueueByThreadId]);
  useEffect(() => {
    const threadsById = new Map(allThreads.map((thread) => [thread.id, thread]));
    const pendingByThread = new Map<ThreadId, PendingSteerDispatch[]>();

    for (const [messageId, pending] of Object.entries(pendingSteerDispatchByMessageId)) {
      const thread = threadsById.get(pending.threadId);
      if (thread === undefined) {
        continue;
      }
      const interruptRecovery =
        pendingSteerInterruptRecoveryByThreadIdRef.current[pending.threadId];
      if (
        interruptRecovery?.pendingMessageIds.some((pendingMessageId) => {
          return String(pendingMessageId) === messageId;
        }) === true
      ) {
        continue;
      }
      if (!threadShouldReplayUnprocessedTerminalCodexSteer(thread, pending)) {
        continue;
      }

      const existing = pendingByThread.get(pending.threadId) ?? [];
      existing.push(pending);
      pendingByThread.set(pending.threadId, existing);
    }

    if (pendingByThread.size === 0) {
      return;
    }

    const replayedMessageIds = new Set<string>();
    const queuedItems: Array<{
      readonly threadId: ThreadId;
      readonly item: FollowUpQueueItem;
    }> = [];

    for (const [threadId, pendingSteers] of pendingByThread) {
      const orderedPendingSteers = pendingSteers.toSorted((left, right) =>
        left.dispatchedAt.localeCompare(right.dispatchedAt),
      );
      const merged = mergePendingSteerSnapshotsForInterruptedTurn(
        orderedPendingSteers.map((pending) => pending.snapshot),
      );
      if (merged === null || (merged.promptText.length === 0 && merged.images.length === 0)) {
        for (const pending of orderedPendingSteers) {
          replayedMessageIds.add(String(pending.messageId));
        }
        recordFollowUpQueueDebugAttempt("pending-steer-terminal-replay", "empty-merged-steers", {
          threadId,
        });
        continue;
      }

      const firstPendingSteer = orderedPendingSteers[0];
      if (firstPendingSteer === undefined) {
        continue;
      }
      for (const pending of orderedPendingSteers) {
        replayedMessageIds.add(String(pending.messageId));
      }

      const queuedItem: FollowUpQueueItem = {
        ...firstPendingSteer.snapshot,
        promptText: merged.promptText,
        images: merged.images,
        id: newMessageId(),
        environmentId: firstPendingSteer.environmentId,
        threadId,
        queuedAt: new Date().toISOString(),
        expanded: false,
        blockedReason: null,
      };
      queuedItems.push({ threadId, item: queuedItem });
      recordFollowUpQueueDebugAttempt("pending-steer-terminal-replay", "requeued-merged-steers", {
        threadId,
        itemId: queuedItem.id,
      });
    }

    if (replayedMessageIds.size === 0) {
      return;
    }

    updatePendingSteerDispatches((current) => {
      let next: Record<string, PendingSteerDispatch> | null = null;
      for (const messageId of replayedMessageIds) {
        if (!(messageId in current)) {
          continue;
        }
        next ??= { ...current };
        delete next[messageId];
      }
      return next ?? current;
    });
    setOptimisticUserMessages((existing) => {
      const removed = existing.filter((message) => replayedMessageIds.has(String(message.id)));
      for (const message of removed) {
        revokeUserMessagePreviewUrls(message);
      }
      return existing.filter((message) => !replayedMessageIds.has(String(message.id)));
    });
    if (queuedItems.length > 0) {
      setFollowUpQueueByThreadId((existing) => {
        const next = { ...existing };
        for (const { threadId, item } of queuedItems) {
          next[threadId] = [item, ...(next[threadId] ?? EMPTY_FOLLOW_UP_QUEUE)];
        }
        return next;
      });
    }
  }, [
    allThreads,
    pendingSteerDispatchByMessageId,
    recordFollowUpQueueDebugAttempt,
    setFollowUpQueueByThreadId,
    updatePendingSteerDispatches,
  ]);
  useEffect(() => {
    const recoveries = Object.values(pendingSteerInterruptRecoveryByThreadId);
    if (recoveries.length === 0) {
      return;
    }

    const threadsById = new Map(allThreads.map((thread) => [thread.id, thread]));

    for (const recovery of recoveries) {
      const thread = threadsById.get(recovery.threadId);
      if (thread === undefined) {
        continue;
      }

      if (threadHasProviderInterruptFailedForRecovery(thread, recovery)) {
        recordFollowUpQueueDebugAttempt("pending-steer-interrupt", "provider-interrupt-failed", {
          threadId: recovery.threadId,
        });
        updatePendingSteerInterruptRecoveries((current) => {
          if (!(recovery.threadId in current)) {
            return current;
          }
          const next = { ...current };
          delete next[recovery.threadId];
          return next;
        });
        continue;
      }

      if (!threadHasProviderInterruptCompletedForRecovery(thread, recovery)) {
        continue;
      }

      const pendingSteers = recovery.pendingMessageIds
        .map((messageId) => pendingSteerDispatchByMessageIdRef.current[String(messageId)])
        .filter((pending): pending is PendingSteerDispatch => pending !== undefined);
      const merged = mergePendingSteerSnapshotsForInterruptedTurn(
        pendingSteers.map((pending) => pending.snapshot),
      );

      updatePendingSteerInterruptRecoveries((current) => {
        if (!(recovery.threadId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[recovery.threadId];
        return next;
      });

      if (merged === null || (merged.promptText.length === 0 && merged.images.length === 0)) {
        recordFollowUpQueueDebugAttempt("pending-steer-interrupt", "no-pending-steers-to-replay", {
          threadId: recovery.threadId,
        });
        continue;
      }

      updatePendingSteerDispatches((current) => {
        let next: Record<string, PendingSteerDispatch> | null = null;
        for (const messageId of recovery.pendingMessageIds) {
          if (!(String(messageId) in current)) {
            continue;
          }
          next ??= { ...current };
          delete next[String(messageId)];
        }
        return next ?? current;
      });
      setOptimisticUserMessages((existing) => {
        const pendingIds = new Set(recovery.pendingMessageIds.map(String));
        const removed = existing.filter((message) => pendingIds.has(String(message.id)));
        for (const message of removed) {
          revokeUserMessagePreviewUrls(message);
        }
        return existing.filter((message) => !pendingIds.has(String(message.id)));
      });

      const firstPendingSteer = pendingSteers[0];
      if (firstPendingSteer === undefined) {
        recordFollowUpQueueDebugAttempt("pending-steer-interrupt", "pending-steers-already-clear", {
          threadId: recovery.threadId,
        });
        continue;
      }

      const queuedItem: FollowUpQueueItem = {
        ...firstPendingSteer.snapshot,
        promptText: merged.promptText,
        images: merged.images,
        id: newMessageId(),
        environmentId: recovery.environmentId,
        threadId: recovery.threadId,
        queuedAt: new Date().toISOString(),
        expanded: false,
        blockedReason: null,
      };

      // This mirrors upstream Codex TUI's Esc path: once the interrupted turn
      // reaches the UI, drain all pending steers and submit the merged steer
      // before ordinary queued follow-ups. The provider has already cleared its
      // pending input by this point, so the replay cannot duplicate an ACKed
      // steer still waiting inside Codex.
      setFollowUpQueueByThreadId((existing) => ({
        ...existing,
        [recovery.threadId]: [
          queuedItem,
          ...(existing[recovery.threadId] ?? EMPTY_FOLLOW_UP_QUEUE),
        ],
      }));
      recordFollowUpQueueDebugAttempt("pending-steer-interrupt", "requeued-merged-steers", {
        threadId: recovery.threadId,
        itemId: queuedItem.id,
      });
    }
  }, [
    allThreads,
    pendingSteerInterruptRecoveryByThreadId,
    recordFollowUpQueueDebugAttempt,
    setFollowUpQueueByThreadId,
    updatePendingSteerDispatches,
    updatePendingSteerInterruptRecoveries,
  ]);
  useEffect(() => {
    if (Object.keys(pendingSteerDispatchByMessageId).length === 0) {
      return;
    }

    const threadsById = new Map(allThreads.map((thread) => [thread.id, thread]));
    updatePendingSteerDispatches((current) => {
      let next: Record<string, PendingSteerDispatch> | null = null;
      for (const [messageId, pending] of Object.entries(current)) {
        const thread = threadsById.get(pending.threadId);
        const interruptRecovery =
          pendingSteerInterruptRecoveryByThreadIdRef.current[pending.threadId];
        if (
          interruptRecovery?.pendingMessageIds.some((pendingMessageId) => {
            return String(pendingMessageId) === messageId;
          }) === true
        ) {
          continue;
        }
        if (thread === undefined || !threadHasResolvedPendingSteer(thread, pending)) {
          continue;
        }
        next ??= { ...current };
        delete next[messageId];
      }
      return next ?? current;
    });
  }, [
    allThreads,
    pendingSteerDispatchByMessageId,
    pendingSteerInterruptRecoveryByThreadId,
    updatePendingSteerDispatches,
  ]);
  const threadPlanCatalog = useThreadPlanCatalog(
    useMemo(() => {
      const threadIds: ThreadId[] = [];
      if (activeThread?.id) {
        threadIds.push(activeThread.id);
      }
      const sourceThreadId = activeLatestTurn?.sourceProposedPlan?.threadId;
      if (sourceThreadId && sourceThreadId !== activeThread?.id) {
        threadIds.push(sourceThreadId);
      }
      return threadIds;
    }, [activeLatestTurn?.sourceProposedPlan?.threadId, activeThread?.id]),
  );
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProjectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : null;
  const activeProject = useStore(
    useMemo(() => createProjectSelectorByRef(activeProjectRef), [activeProjectRef]),
  );

  useEffect(() => {
    if (routeKind !== "server") {
      return;
    }
    return retainThreadDetailSubscription(environmentId, threadId);
  }, [environmentId, routeKind, threadId]);

  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const savedEnvironmentRegistryRef = useRef(savedEnvironmentRegistry);
  const savedEnvironmentRuntimeByIdRef = useRef(savedEnvironmentRuntimeById);
  savedEnvironmentRegistryRef.current = savedEnvironmentRegistry;
  savedEnvironmentRuntimeByIdRef.current = savedEnvironmentRuntimeById;
  const activeSavedEnvironmentRecord =
    activeThread && activeThread.environmentId !== primaryEnvironmentId
      ? (savedEnvironmentRegistry[activeThread.environmentId] ?? null)
      : null;
  const activeSavedEnvironmentRuntime = activeSavedEnvironmentRecord
    ? (savedEnvironmentRuntimeById[activeSavedEnvironmentRecord.environmentId] ?? null)
    : null;
  const activeSavedEnvironmentConnectionState = activeSavedEnvironmentRecord
    ? (activeSavedEnvironmentRuntime?.connectionState ?? "disconnected")
    : "connected";
  const activeEnvironmentUnavailable =
    activeSavedEnvironmentRecord !== null && activeSavedEnvironmentConnectionState !== "connected";
  const activeSavedEnvironmentId = activeSavedEnvironmentRecord?.environmentId ?? null;
  const activeEnvironmentUnavailableLabel = activeSavedEnvironmentRecord
    ? resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId: activeSavedEnvironmentRecord.environmentId,
        runtimeLabel: activeSavedEnvironmentRuntime?.descriptor?.label ?? null,
        savedLabel: activeSavedEnvironmentRecord.label,
      })
    : null;
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() => {
    if (
      !activeEnvironmentUnavailable ||
      !activeEnvironmentUnavailableLabel ||
      !activeSavedEnvironmentId
    ) {
      return null;
    }

    return {
      environmentId: activeSavedEnvironmentId,
      label: activeEnvironmentUnavailableLabel,
      connectionState:
        activeSavedEnvironmentConnectionState === "connecting" ||
        activeSavedEnvironmentConnectionState === "error"
          ? activeSavedEnvironmentConnectionState
          : "disconnected",
    };
  }, [
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    activeSavedEnvironmentConnectionState,
    activeSavedEnvironmentId,
  ]);
  const [reconnectingEnvironmentId, setReconnectingEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const handleReconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId, label: string) => {
      setReconnectingEnvironmentId(environmentId);
      try {
        await reconnectSavedEnvironment(environmentId);
        toastManager.add({
          type: "success",
          title: "Environment reconnected",
          description: `${label} is ready.`,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not reconnect environment",
            description: error instanceof Error ? error.message : "Failed to reconnect.",
          }),
        );
      } finally {
        setReconnectingEnvironmentId(null);
      }
    },
    [],
  );
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const logicalProjectEnvironments = useMemo(() => {
    if (!activeProject) return [];
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    const memberProjects = allProjects.filter(
      (p) => deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) === logicalKey,
    );
    const seen = new Set<string>();
    const envs: Array<{
      environmentId: EnvironmentId;
      projectId: ProjectId;
      label: string;
      isPrimary: boolean;
    }> = [];
    for (const p of memberProjects) {
      if (seen.has(p.environmentId)) continue;
      seen.add(p.environmentId);
      const isPrimary = p.environmentId === primaryEnvironmentId;
      const savedRecord = savedEnvironmentRegistry[p.environmentId];
      const runtimeState = savedEnvironmentRuntimeById[p.environmentId];
      const label = resolveEnvironmentOptionLabel({
        isPrimary,
        environmentId: p.environmentId,
        runtimeLabel: runtimeState?.descriptor?.label ?? null,
        savedLabel: savedRecord?.label ?? null,
      });
      envs.push({
        environmentId: p.environmentId,
        projectId: p.id,
        label,
        isPrimary,
      });
    }
    // Sort: primary first, then alphabetical
    envs.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return envs;
  }, [
    activeProject,
    allProjects,
    projectGroupingSettings,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
  ]);
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        activeProject,
        projectGroupingSettings,
      );
      const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (storedDraftSession) {
        setDraftThreadContext(storedDraftSession.draftId, input);
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          activeProjectRef,
          storedDraftSession.draftId,
          {
            threadId: storedDraftSession.threadId,
            ...input,
          },
        );
        if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
          await navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(storedDraftSession.draftId),
          });
        }
        return storedDraftSession.threadId;
      }

      const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
      if (
        !isServerThread &&
        activeDraftSession?.logicalProjectKey === logicalProjectKey &&
        draftId
      ) {
        setDraftThreadContext(draftId, input);
        setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
          threadId: activeDraftSession.threadId,
          createdAt: activeDraftSession.createdAt,
          runtimeMode: activeDraftSession.runtimeMode,
          interactionMode: activeDraftSession.interactionMode,
          ...input,
        });
        return activeDraftSession.threadId;
      }

      const nextDraftId = newDraftId();
      const nextThreadId = newThreadId();
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
        threadId: nextThreadId,
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(nextDraftId),
      });
      return nextThreadId;
    },
    [
      activeProject,
      draftId,
      getDraftSession,
      getDraftSessionByLogicalProjectKey,
      isServerThread,
      navigate,
      projectGroupingSettings,
      routeKind,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!serverThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      activeLatestTurn.completedAt,
    );
  }, [
    activeLatestTurn?.completedAt,
    activeThreadLastVisitedAt,
    latestTurnSettled,
    markThreadVisited,
    serverThread?.environmentId,
    serverThread?.id,
  ]);

  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
  });
  const primaryServerConfig = useServerConfig();
  const activeEnvRuntimeState = useSavedEnvironmentRuntimeStore((s) =>
    activeThread?.environmentId ? s.byId[activeThread.environmentId] : null,
  );
  // Use the server config for the thread's environment.  For the primary
  // environment fall back to the global atom; for remote environments use
  // the runtime state stored by the environment manager.
  const serverConfig =
    primaryEnvironmentId && activeThread?.environmentId === primaryEnvironmentId
      ? primaryServerConfig
      : (activeEnvRuntimeState?.serverConfig ?? primaryServerConfig);
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const versionMismatchDismissKey =
    versionMismatch && activeThread
      ? buildVersionMismatchDismissalKey(activeThread.environmentId, versionMismatch)
      : null;
  const [dismissedVersionMismatchKey, setDismissedVersionMismatchKey] = useState<string | null>(
    null,
  );
  const versionMismatchDismissed =
    versionMismatchDismissKey === dismissedVersionMismatchKey ||
    isVersionMismatchDismissed(versionMismatchDismissKey);
  const showVersionMismatchBanner =
    versionMismatch !== null && versionMismatchDismissKey !== null && !versionMismatchDismissed;
  const hasMultipleRegisteredEnvironments = Object.keys(savedEnvironmentRegistry).length > 0;
  const versionMismatchServerLabel = useMemo(() => {
    if (!hasMultipleRegisteredEnvironments || !activeThread) {
      return "server";
    }

    const isPrimary = activeThread.environmentId === primaryEnvironmentId;
    const savedRecord = savedEnvironmentRegistry[activeThread.environmentId];
    const runtimeState = savedEnvironmentRuntimeById[activeThread.environmentId];
    return `${resolveEnvironmentOptionLabel({
      isPrimary,
      environmentId: activeThread.environmentId,
      runtimeLabel: runtimeState?.descriptor?.label ?? serverConfig?.environment.label ?? null,
      savedLabel: savedRecord?.label ?? null,
    })} server`;
  }, [
    activeThread,
    hasMultipleRegisteredEnvironments,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
    serverConfig?.environment.label,
  ]);
  const composerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    if (activeEnvironmentUnavailableState) {
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        variant:
          activeEnvironmentUnavailableState.connectionState === "error" ? "error" : "warning",
        icon: <WifiOffIcon />,
        title: (
          <>
            {activeEnvironmentUnavailableState.label} is{" "}
            {activeEnvironmentUnavailableState.connectionState === "connecting"
              ? "connecting"
              : "disconnected"}
          </>
        ),
        description: "Reconnect this environment before sending messages or running actions.",
        actions: (
          <>
            <Button
              size="xs"
              disabled={
                activeEnvironmentUnavailableState.connectionState === "connecting" ||
                reconnectingEnvironmentId === activeEnvironmentUnavailableState.environmentId
              }
              onClick={() =>
                void handleReconnectActiveEnvironment(
                  activeEnvironmentUnavailableState.environmentId,
                  activeEnvironmentUnavailableState.label,
                )
              }
            >
              {activeEnvironmentUnavailableState.connectionState === "connecting" ||
              reconnectingEnvironmentId === activeEnvironmentUnavailableState.environmentId
                ? "Reconnecting..."
                : "Reconnect"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/connections" })}
            >
              WebUI
            </Button>
          </>
        ),
      });
    }
    if (showVersionMismatchBanner && versionMismatch && versionMismatchDismissKey) {
      items.push({
        id: `version-mismatch:${versionMismatchDismissKey}`,
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: "Client and server versions differ",
        description: (
          <>
            Client {versionMismatch.clientVersion} is connected to {versionMismatchServerLabel}{" "}
            {versionMismatch.serverVersion}. Sync them if RPC calls or reconnects fail.
          </>
        ),
        dismissLabel: "Dismiss version mismatch warning",
        onDismiss: () => {
          dismissVersionMismatch(versionMismatchDismissKey);
          setDismissedVersionMismatchKey(versionMismatchDismissKey);
        },
      });
    }
    return items;
  }, [
    activeEnvironmentUnavailableState,
    handleReconnectActiveEnvironment,
    navigate,
    reconnectingEnvironmentId,
    showVersionMismatchBanner,
    versionMismatch,
    versionMismatchDismissKey,
    versionMismatchServerLabel,
  ]);
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    selectedProviderByThreadId ?? threadProvider ?? ProviderDriverKind.make("codex"),
  );
  const selectedProvider: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const phase = derivePhase(activeThread?.session ?? null);
  const isProviderConnecting = phase === "connecting";
  const isComposerConnecting = isConnecting || isProviderConnecting;
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const latestTurnHasToolActivity = useMemo(
    () => hasToolActivityForTurn(threadActivities, activeLatestTurn?.turnId),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: threadPlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThread?.id ?? null,
      }),
    [activeLatestTurn, activeThread?.id, latestTurnSettled, threadPlanCatalog],
  );
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const hasPlanSidebarContent = Boolean(activePlan || sidebarProposedPlan);
  const planSidebarLabel = sidebarProposedPlan || interactionMode === "plan" ? "Plan" : "Tasks";
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
    serverAcknowledgedLocalDispatch,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError: activeThread?.error,
  });
  useEffect(() => {
    if (serverAcknowledgedLocalDispatch) {
      setSendInFlight(false);
      setQueueDispatchInFlight(false);
    }
  }, [serverAcknowledgedLocalDispatch, setQueueDispatchInFlight, setSendInFlight]);
  const isWorking =
    phase === "running" || isSendBusy || isComposerConnecting || isRevertingCheckpoint;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
  );
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = useCallback(
    (messageId: MessageId, previewUrls?: ReadonlyArray<string>) => {
      delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
      const currentPreviewUrls =
        previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) {
          return existing;
        }
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      for (const previewUrl of currentPreviewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    },
    [],
  );
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
      for (const items of Object.values(followUpQueueByThreadIdRef.current)) {
        for (const item of items) {
          revokeQueuedFollowUpPreviewUrls(item);
        }
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    for (const previewUrl of previousPreviewUrls) {
      if (!previewUrls.includes(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  }, []);
  const serverMessages = activeThread?.messages;
  useEffect(() => {
    if (typeof Image === "undefined" || !serverMessages || serverMessages.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = serverMessages.find(
        (message) => message.id === messageId && message.role === "user",
      );
      if (!serverMessage?.attachments || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image" && attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [attachmentPreviewHandoffByMessageId, clearAttachmentPreviewHandoff, serverMessages]);
  const timelineMessages = useMemo(() => {
    const messages = serverMessages ?? [];
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [serverMessages, attachmentPreviewHandoffByMessageId, optimisticUserMessages]);
  const historicalWorkLogSummariesByTurnId = useMemo(
    () =>
      deriveHistoricalWorkLogSummaries({
        messages: timelineMessages,
        activities: threadActivities,
        latestTurnId: activeLatestTurn?.turnId ?? null,
      }),
    [activeLatestTurn?.turnId, threadActivities, timelineMessages],
  );
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(timelineMessages, activeThread?.proposedPlans ?? [], workLogEntries),
    [activeThread?.proposedPlans, timelineMessages, workLogEntries],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!latestTurnHasToolActivity) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);
  const completionDividerAfterEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!completionSummary) return null;
    return deriveCompletionDividerAfterEntryId(timelineEntries, activeLatestTurn);
  }, [activeLatestTurn, completionSummary, latestTurnSettled, timelineEntries]);
  const gitCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const gitStatusQuery = useGitStatus({ environmentId, cwd: gitCwd });
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  const terminal = useServerTerminal();
  // Prefer an instance-id match so a custom Codex instance (e.g.
  // `codex_personal`) surfaces its own status/message in the banner rather
  // than the default Codex's. Falls back to first-match-by-kind when no
  // saved instance id is available or the instance no longer exists.
  const activeProviderInstanceId =
    activeThread?.session?.providerInstanceId ??
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const activeProviderStatus = useMemo(() => {
    if (activeProviderInstanceId) {
      return (
        providerStatuses.find((status) => status.instanceId === activeProviderInstanceId) ?? null
      );
    }
    const defaultInstanceId = defaultInstanceIdForDriver(selectedProvider);
    return providerStatuses.find((status) => status.instanceId === defaultInstanceId) ?? null;
  }, [activeProviderInstanceId, providerStatuses, selectedProvider]);
  const activeProviderLiveSteerSupported =
    activeProviderStatus?.runtimeCapabilities?.liveSteer === "supported";
  const activeProviderLiveSteerAvailable = isLiveSteerAvailableForThread({
    liveSteerSupported: activeProviderLiveSteerSupported,
    provider: activeThread?.session?.provider ?? null,
    activeTurnId: activeThread?.session?.activeTurnId ?? null,
    latestTurn: activeLatestTurn,
  });
  const resolveQueuedFollowUpThread = useCallback((item: FollowUpQueueItem): Thread | undefined => {
    return selectThreadByRef(
      useStore.getState(),
      scopeThreadRef(item.environmentId, item.threadId),
    );
  }, []);
  const resolveProjectForThread = useCallback(
    (thread: Thread) =>
      selectProjectByRef(
        useStore.getState(),
        scopeProjectRef(thread.environmentId, thread.projectId),
      ),
    [],
  );
  const isThreadEnvironmentUnavailable = useCallback(
    (thread: Thread): boolean => {
      if (thread.environmentId === primaryEnvironmentId) {
        return false;
      }
      const savedEnvironment = savedEnvironmentRegistryRef.current[thread.environmentId] ?? null;
      if (savedEnvironment === null) {
        return false;
      }
      const runtime =
        savedEnvironmentRuntimeByIdRef.current[savedEnvironment.environmentId] ?? null;
      return (runtime?.connectionState ?? "disconnected") !== "connected";
    },
    [primaryEnvironmentId],
  );
  const activeFollowUpQueue =
    activeThreadId !== null
      ? (followUpQueueByThreadId[activeThreadId] ?? EMPTY_FOLLOW_UP_QUEUE)
      : EMPTY_FOLLOW_UP_QUEUE;
  const retainedFollowUpThreadRefs = useMemo(() => {
    const refs: ScopedThreadRef[] = [];
    const seen = new Set<string>();
    const pushRef = (ref: ScopedThreadRef) => {
      const key = scopedThreadKey(ref);
      if (seen.has(key)) return;
      seen.add(key);
      refs.push(ref);
    };

    for (const items of Object.values(followUpQueueByThreadId)) {
      const firstItem = items[0];
      if (firstItem) {
        pushRef(scopeThreadRef(firstItem.environmentId, firstItem.threadId));
      }
    }
    for (const pending of Object.values(queuedFollowUpPendingDispatchByThreadId)) {
      pushRef(scopeThreadRef(pending.environmentId, pending.threadId));
    }
    return refs;
  }, [followUpQueueByThreadId, queuedFollowUpPendingDispatchByThreadId]);
  const totalFollowUpQueueLength = useMemo(
    () => Object.values(followUpQueueByThreadId).reduce((total, items) => total + items.length, 0),
    [followUpQueueByThreadId],
  );
  useEffect(() => {
    if (retainedFollowUpThreadRefs.length === 0) {
      return;
    }
    const releases = retainedFollowUpThreadRefs.map((ref) =>
      retainThreadDetailSubscription(ref.environmentId, ref.threadId),
    );
    return () => {
      for (const release of releases) {
        release();
      }
    };
  }, [retainedFollowUpThreadRefs]);
  useEffect(() => {
    const pendingEntries = Object.entries(queuedFollowUpPendingDispatchByThreadId);
    if (pendingEntries.length === 0) {
      return;
    }

    let changed = false;
    const nextPending: Record<string, QueuedFollowUpPendingDispatch> = {};
    const state = useStore.getState();
    for (const [threadId, pending] of pendingEntries) {
      const thread = selectThreadByRef(
        state,
        scopeThreadRef(pending.environmentId, pending.threadId),
      );
      if (
        !thread ||
        hasQueuedFollowUpDispatchBeenObserved({
          messageId: pending.messageId,
          dispatchedAt: pending.dispatchedAt,
          thread,
        })
      ) {
        changed = true;
        continue;
      }
      nextPending[threadId] = pending;
    }

    if (!changed) {
      return;
    }
    queuedFollowUpPendingDispatchByThreadIdRef.current = nextPending;
    setQueuedFollowUpPendingDispatchByThreadId(nextPending);
  }, [allThreads, queuedFollowUpPendingDispatchByThreadId]);
  const activeQueueTurnId = activeThread?.session?.activeTurnId ?? null;
  const followUpQueuePhase = resolveFollowUpQueuePhase({
    phase,
    latestTurn: activeLatestTurn,
    activeTurnId: activeQueueTurnId,
    sessionUpdatedAt: activeThread?.session?.updatedAt ?? null,
  });
  const followUpQueueUiIdle = followUpQueuePhase !== "running";
  const followUpQueueVisibleWorking =
    followUpQueuePhase === "running" || isComposerConnecting || isRevertingCheckpoint;
  const firstActiveFollowUpQueueItem = activeFollowUpQueue[0] ?? null;
  const firstActiveAutomaticSteerRetryBlocker =
    activeThread !== undefined && firstActiveFollowUpQueueItem !== null
      ? resolveAutomaticSteerRetryBlocker({
          item: firstActiveFollowUpQueueItem,
          thread: activeThread,
          phase: followUpQueuePhase,
        })
      : null;
  const followUpQueueDispatchInFlight = queueDispatchInFlightRef.current;
  const activeQueuedFollowUpPendingDispatch =
    activeThreadId !== null &&
    queuedFollowUpPendingDispatchByThreadId[activeThreadId] !== undefined;
  const followUpQueueCanStartTurn = canStartQueuedFollowUpTurn({
    queueLength: activeFollowUpQueue.length,
    firstItemBlocked: firstActiveFollowUpQueueItem?.blockedReason != null,
    isWorking: followUpQueueVisibleWorking,
    isConnecting: isComposerConnecting,
    isEnvironmentUnavailable: activeEnvironmentUnavailable,
    isDispatchInFlight: followUpQueueDispatchInFlight || activeQueuedFollowUpPendingDispatch,
  });
  const followUpQueueViewItems = useMemo<readonly FollowUpQueueViewItem[]>(
    () =>
      activeFollowUpQueue.map((item) => ({
        id: item.id,
        preview: previewQueuedFollowUpText(item.promptText),
        promptText: item.promptText,
        images: item.images,
        queuedAt: item.queuedAt,
        expanded: item.expanded,
        canExpand: canExpandQueuedFollowUpText(item.promptText) || item.images.length > 0,
        blockedReason: item.blockedReason,
        automaticSteerRetry:
          item.automaticSteerRetry === undefined ? null : item.automaticSteerRetry,
      })),
    [activeFollowUpQueue],
  );
  const steeringFollowUpViewItems = useMemo<readonly SteeringFollowUpViewItem[]>(
    () =>
      Object.values(pendingSteerDispatchByMessageId)
        .filter((pending) => activeThreadId !== null && pending.threadId === activeThreadId)
        .toSorted((left, right) => left.dispatchedAt.localeCompare(right.dispatchedAt))
        .map((pending) => ({
          id: pending.messageId,
          preview: previewQueuedFollowUpText(pending.snapshot.promptText),
          promptText: pending.snapshot.promptText,
          dispatchedAt: pending.dispatchedAt,
        })),
    [activeThreadId, pendingSteerDispatchByMessageId],
  );
  const activeSteeringFollowUpInFlight = steeringFollowUpViewItems.length > 0;
  const canSteerFollowUpQueue =
    followUpQueuePhase === "running" &&
    activeProviderLiveSteerAvailable &&
    firstActiveAutomaticSteerRetryBlocker === null &&
    !isComposerConnecting &&
    !activeEnvironmentUnavailable &&
    !followUpQueueDispatchInFlight &&
    !activeQueuedFollowUpPendingDispatch &&
    !activeSteeringFollowUpInFlight;
  const canActivateRunningFollowUpQueueAction =
    followUpQueuePhase === "running" &&
    activeThread?.session?.status === "running" &&
    firstActiveAutomaticSteerRetryBlocker === null &&
    !isComposerConnecting &&
    !activeEnvironmentUnavailable &&
    !followUpQueueDispatchInFlight &&
    !activeQueuedFollowUpPendingDispatch &&
    !activeSteeringFollowUpInFlight;
  const followUpQueueActionLabel = queuedFollowUpActionLabel({
    phase: followUpQueuePhase,
    liveSteerSupported: activeProviderLiveSteerAvailable,
  });
  const followUpQueueActionTitle = queuedFollowUpActionTitle({
    phase: followUpQueuePhase,
    liveSteerSupported: activeProviderLiveSteerAvailable,
  });
  useEffect(() => {
    if (activeFollowUpQueue.length > 0 && followUpQueueUiIdle && sendInFlightRef.current) {
      setSendInFlight(false);
    }
  }, [activeFollowUpQueue.length, followUpQueueUiIdle, setSendInFlight]);
  useEffect(() => {
    if (!desktopDebugEnabled) {
      return;
    }
    const bridge = window.desktopBridge;
    if (!bridge?.publishDebugSnapshot) {
      return;
    }

    const nowMs = performance.now();
    const msSinceLastPublish = nowMs - lastDesktopDebugSnapshotPublishedAtMsRef.current;
    if (
      lastDesktopDebugSnapshotPublishedAtMsRef.current > 0 &&
      msSinceLastPublish < DEBUG_RENDERER_SNAPSHOT_MIN_INTERVAL_MS
    ) {
      if (desktopDebugSnapshotThrottleTimeoutRef.current === null) {
        desktopDebugSnapshotThrottleTimeoutRef.current = window.setTimeout(
          () => {
            desktopDebugSnapshotThrottleTimeoutRef.current = null;
            setDesktopDebugRevision((revision) => revision + 1);
          },
          Math.max(0, DEBUG_RENDERER_SNAPSHOT_MIN_INTERVAL_MS - msSinceLastPublish),
        );
      }
      return;
    }

    if (desktopDebugSnapshotThrottleTimeoutRef.current !== null) {
      window.clearTimeout(desktopDebugSnapshotThrottleTimeoutRef.current);
      desktopDebugSnapshotThrottleTimeoutRef.current = null;
    }
    lastDesktopDebugSnapshotPublishedAtMsRef.current = nowMs;

    const snapshotBuildStartedAt = performance.now();
    const capturedAtMs = Date.now();
    const capturedAt = new Date(capturedAtMs).toISOString();
    const localApi = readLocalApi();
    const composerDebugState = readComposerHandle(composerRef)?.readDebugState() ?? null;
    const firstItem = firstActiveFollowUpQueueItem;
    const activePendingSteerInterruptRecovery =
      activeThreadId !== null
        ? (pendingSteerInterruptRecoveryByThreadIdRef.current[activeThreadId] ?? null)
        : null;
    const queueBlockers: string[] = [];
    if (activeFollowUpQueue.length === 0) {
      queueBlockers.push("queue-empty");
    }
    if (firstItem?.blockedReason) {
      queueBlockers.push("first-item-blocked");
    }
    if (firstActiveAutomaticSteerRetryBlocker !== null) {
      queueBlockers.push(firstActiveAutomaticSteerRetryBlocker);
    }
    if (activeSteeringFollowUpInFlight) {
      queueBlockers.push("steer-dispatch-in-flight");
    }
    if (activePendingSteerInterruptRecovery !== null) {
      queueBlockers.push("pending-steer-interrupt-recovery");
    }
    if (followUpQueueVisibleWorking) {
      queueBlockers.push("thread-visible-working");
    }
    if (isProviderConnecting) {
      queueBlockers.push("provider-connecting");
    }
    if (isConnecting) {
      queueBlockers.push("environment-connecting");
    }
    if (activeEnvironmentUnavailable) {
      queueBlockers.push("environment-unavailable");
    }
    if (followUpQueueDispatchInFlight) {
      queueBlockers.push("queue-dispatch-in-flight");
    }
    if (activeQueuedFollowUpPendingDispatch) {
      queueBlockers.push("queued-turn-start-awaiting-thread-update");
    }

    const recentMessages = activeThread?.messages.slice(-DEBUG_RECENT_MESSAGE_LIMIT) ?? [];
    const recentActivities = activeThread?.activities.slice(-DEBUG_RECENT_ACTIVITY_LIMIT) ?? [];
    const runtimeActivities =
      activeThread?.activities.filter(
        (activity) => activity.kind === "runtime.warning" || activity.kind === "runtime.error",
      ) ?? [];
    const queueEntries = Object.entries(followUpQueueByThreadIdRef.current);
    const orphanQueueEntries = queueEntries.filter(
      ([queuedThreadId, items]) =>
        queuedThreadId !== activeThreadId &&
        !knownThreadIds.has(queuedThreadId) &&
        items.length > 0,
    );
    const staleCompletedActiveTurn =
      activeThread?.session?.status === "running" &&
      activeThread.session.activeTurnId != null &&
      activeLatestTurn?.turnId === activeThread.session.activeTurnId &&
      activeLatestTurn.state === "completed" &&
      activeLatestTurn.completedAt != null;
    const latestTurnId = activeLatestTurn?.turnId ?? null;
    const latestTurnCompletedAt = activeLatestTurn?.completedAt ?? null;
    const activitiesAfterLatestTurnCompleted =
      activeThread && latestTurnId !== null && latestTurnCompletedAt !== null
        ? activeThread.activities.filter(
            (activity) =>
              activity.turnId === latestTurnId && activity.createdAt > latestTurnCompletedAt,
          )
        : [];
    const latestActivityAfterLatestTurnCompleted =
      activitiesAfterLatestTurnCompleted.at(-1) ?? null;
    const queuedThreadIds = new Set(
      queueEntries
        .filter(([, items]) => items.length > 0)
        .map(([queuedThreadId]) => queuedThreadId),
    );
    const lifecycleByThreadId = new Map(
      allThreads.map(
        (thread) => [thread.id, summarizeDebugThreadLifecycle(thread, capturedAtMs)] as const,
      ),
    );
    const activeLifecycleSummary = activeThread
      ? (lifecycleByThreadId.get(activeThread.id) ?? null)
      : null;
    const activeThreadPerformance =
      activeThread == null ? null : summarizeDebugThreadPerformance(activeThread, capturedAtMs);
    const activeWaitReasons = deriveDebugWaitReasons({
      lifecycle: activeLifecycleSummary,
      performance: activeThreadPerformance,
      activeQueueLength: activeFollowUpQueue.length,
      activeSteeringFollowUpCount: steeringFollowUpViewItems.length,
      followUpQueueVisibleWorking,
      followUpQueueDispatchInFlight,
      activeTurnInProgress: isWorking || !latestTurnSettled,
    });
    const activeProviderContinuation = activeLifecycleSummary?.providerContinuation ?? null;
    const lifecycleSummaries = Array.from(lifecycleByThreadId.values());
    const lifecycleRedFlagCounts = countBy(
      lifecycleSummaries.flatMap((thread) => thread.redFlags),
      (redFlag) => redFlag,
    );
    const maxThreadMessageCount = allThreads.reduce(
      (max, thread) => Math.max(max, thread.messages.length),
      0,
    );
    const maxThreadActivityCount = allThreads.reduce(
      (max, thread) => Math.max(max, thread.activities.length),
      0,
    );
    const interestingLifecycleThreads = lifecycleSummaries
      .filter(
        (thread) =>
          thread.id === activeThreadId ||
          queuedThreadIds.has(thread.id) ||
          thread.redFlags.length > 0 ||
          thread.isSessionRunning ||
          thread.isLatestTurnRunning ||
          thread.hasUnsettledLatestTurn ||
          thread.streamingMessageCount > 0 ||
          thread.session?.status === "error",
      )
      .slice(0, DEBUG_INTERESTING_THREAD_LIMIT);
    const notablePerformanceThreads = allThreads
      .filter((thread) => {
        const lifecycle = lifecycleByThreadId.get(thread.id);
        return (
          thread.id === activeThreadId ||
          queuedThreadIds.has(thread.id) ||
          thread.session?.status === "running" ||
          thread.session?.status === "error" ||
          thread.error !== null ||
          thread.latestTurn?.state === "running" ||
          (lifecycle?.redFlags.length ?? 0) > 0
        );
      })
      .slice(0, DEBUG_INTERESTING_THREAD_LIMIT)
      .map((thread) =>
        summarizeDebugNotableThread({
          thread,
          lifecycle: lifecycleByThreadId.get(thread.id) ?? null,
          nowMs: capturedAtMs,
        }),
      );
    const lifecycleQueueRedFlags = [
      activeFollowUpQueue.length > 0 && followUpQueueUiIdle && !followUpQueueCanStartTurn
        ? "queue-has-items-but-cannot-start-while-idle"
        : null,
      activeLifecycleSummary?.phase === "running" && !isWorking
        ? "ui-idle-while-session-running"
        : null,
      activeLifecycleSummary !== null &&
      activeLifecycleSummary.streamingMessageCount > 0 &&
      followUpQueueUiIdle
        ? "queue-sees-idle-while-message-streaming"
        : null,
    ].filter((value): value is string => value !== null);

    const snapshot: DesktopRendererDebugSnapshot = {
      debugSnapshotVersion: DEBUG_SNAPSHOT_VERSION,
      source: "ChatView",
      capturedAt,
      debugPublisher: {
        heartbeatIntervalMs: DEBUG_RENDERER_HEARTBEAT_INTERVAL_MS,
        minSnapshotIntervalMs: DEBUG_RENDERER_SNAPSHOT_MIN_INTERVAL_MS,
        revision: desktopDebugRevision,
      },
      diagnostics: {
        location: {
          pathname: window.location.pathname,
          search: window.location.search,
          hash: window.location.hash,
        },
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        online: navigator.onLine,
        localApi: {
          available: localApi !== undefined,
          traceDiagnosticsAvailable: typeof localApi?.server.getTraceDiagnostics === "function",
          processDiagnosticsAvailable: typeof localApi?.server.getProcessDiagnostics === "function",
          resourceHistoryAvailable:
            typeof localApi?.server.getProcessResourceHistory === "function",
        },
      },
      composer: composerDebugState,
      performance: {
        rendererSnapshotBuildDurationMs: null,
        capturedAtEpochMs: capturedAtMs,
        activeThread: activeThreadPerformance,
        notableThreads: notablePerformanceThreads,
        storePressure: {
          threadCount: allThreads.length,
          maxThreadMessageCount,
          maxThreadActivityCount,
          threadsAtMessageLimit: allThreads.filter(
            (thread) => thread.messages.length >= DEBUG_THREAD_DETAIL_MESSAGE_LIMIT,
          ).length,
          threadsAtActivityLimit: allThreads.filter(
            (thread) => thread.activities.length >= DEBUG_THREAD_DETAIL_ACTIVITY_LIMIT,
          ).length,
          lifecycleRedFlagCounts,
        },
      },
      store: {
        projectCount: allProjects.length,
        threadCount: allThreads.length,
        activeThreadCount: allThreads.filter((thread) => thread.archivedAt === null).length,
        archivedThreadCount: allThreads.filter((thread) => thread.archivedAt !== null).length,
        threadsWithSessions: allThreads.filter((thread) => thread.session !== null).length,
        runningThreadIds: allThreads
          .filter((thread) => thread.session?.status === "running")
          .map((thread) => thread.id),
        errorThreadIds: allThreads
          .filter((thread) => thread.session?.status === "error" || thread.error !== null)
          .map((thread) => thread.id),
        messageRoleCounts: activeThread
          ? countBy(activeThread.messages, (message) => message.role)
          : {},
        activityKindCounts: activeThread
          ? countBy(activeThread.activities, (activity) => activity.kind)
          : {},
      },
      route: {
        routeKind,
        environmentId,
        routeThreadId: threadId,
        activeThreadId,
        isServerThread,
        isLocalDraftThread,
      },
      project: activeProject
        ? {
            id: activeProject.id,
            name: activeProject.name,
            cwd: activeProject.cwd,
          }
        : null,
      thread: activeThread
        ? {
            id: activeThread.id,
            title: activeThread.title,
            projectId: activeThread.projectId,
            worktreePath: activeThread.worktreePath,
            modelSelection: activeThread.modelSelection,
            runtimeMode: activeThread.runtimeMode,
            interactionMode: activeThread.interactionMode,
            error: activeThread.error ?? null,
            messageCount: activeThread.messages.length,
            activityCount: activeThread.activities.length,
            session: activeThread.session,
            latestTurn: activeLatestTurn,
            latestTurnSettled,
            consistency: {
              staleCompletedActiveTurn,
              sessionActiveTurnMatchesLatestTurn:
                activeThread.session?.activeTurnId != null &&
                activeLatestTurn?.turnId === activeThread.session.activeTurnId,
              latestTurnCompletedButSessionRunning:
                activeLatestTurn?.completedAt != null && activeThread.session?.status === "running",
              messageAfterLatestTurnCompletedCount:
                activeLifecycleSummary?.messageAfterLatestTurnCompletedCount ?? 0,
              latestMessageAfterLatestTurnCompleted:
                activeLifecycleSummary?.latestMessageAfterLatestTurnCompleted ?? null,
              activityAfterLatestTurnCompletedCount: activitiesAfterLatestTurnCompleted.length,
              latestActivityAfterLatestTurnCompleted:
                latestActivityAfterLatestTurnCompleted !== null
                  ? summarizeDebugActivity(latestActivityAfterLatestTurnCompleted)
                  : null,
              providerContinuation: activeProviderContinuation,
            },
            recentMessages: recentMessages.map(summarizeDebugMessage),
            recentActivities: recentActivities.map(summarizeDebugActivity),
            recentRuntimeEvents: runtimeActivities
              .slice(-DEBUG_RECENT_RUNTIME_EVENT_LIMIT)
              .map(summarizeDebugActivity),
            turnDiffSummaries: activeThread.turnDiffSummaries
              .slice(-10)
              .map(summarizeDebugTurnDiff),
          }
        : null,
      lifecycle: {
        active: activeLifecycleSummary,
        waitReasons: activeWaitReasons,
        counts: {
          sessionsRunning: lifecycleSummaries.filter((thread) => thread.isSessionRunning).length,
          sessionsWithActiveTurn: lifecycleSummaries.filter(
            (thread) => thread.activeTurnId !== null,
          ).length,
          latestTurnsRunning: lifecycleSummaries.filter((thread) => thread.isLatestTurnRunning)
            .length,
          unsettledLatestTurns: lifecycleSummaries.filter((thread) => thread.hasUnsettledLatestTurn)
            .length,
          threadsWithStreamingMessages: lifecycleSummaries.filter(
            (thread) => thread.streamingMessageCount > 0,
          ).length,
          streamingMessages: lifecycleSummaries.reduce(
            (total, thread) => total + thread.streamingMessageCount,
            0,
          ),
          staleCompletedActiveTurns: lifecycleSummaries.filter(
            (thread) => thread.staleCompletedActiveTurn,
          ).length,
          latestCompletedButSessionRunning: lifecycleSummaries.filter(
            (thread) => thread.latestTurnCompletedButSessionRunning,
          ).length,
          latestRunningButSessionNotRunning: lifecycleSummaries.filter(
            (thread) => thread.latestTurnRunningButSessionNotRunning,
          ).length,
          providerContinuationAfterLatestTurnCompleted: lifecycleSummaries.filter(
            (thread) => (thread.providerContinuation?.afterLatestTurnCompletedCount ?? 0) > 0,
          ).length,
          providerContinuationAfterEarliestCompletionSignal: lifecycleSummaries.filter(
            (thread) => (thread.providerContinuation?.afterEarliestCompletionSignalCount ?? 0) > 0,
          ).length,
          tokenUsageAfterCompletionSignal: lifecycleSummaries.filter(
            (thread) =>
              (thread.providerContinuation?.tokenUsageAfterEarliestCompletionSignalCount ?? 0) > 0,
          ).length,
          redFlagThreads: lifecycleSummaries.filter((thread) => thread.redFlags.length > 0).length,
        },
        interestingThreadLimit: DEBUG_INTERESTING_THREAD_LIMIT,
        interestingThreads: interestingLifecycleThreads,
        queueCoupling: {
          activeThreadId,
          activeQueueTurnId,
          activeQueueLength: activeFollowUpQueue.length,
          activeSteeringFollowUpCount: steeringFollowUpViewItems.length,
          activeSteeringFollowUpInFlight,
          queueBlockers,
          firstActiveAutomaticSteerRetryBlocker,
          activePendingSteerInterruptRecovery:
            activePendingSteerInterruptRecovery === null
              ? null
              : {
                  threadId: activePendingSteerInterruptRecovery.threadId,
                  interruptedTurnId: activePendingSteerInterruptRecovery.interruptedTurnId,
                  pendingMessageCount: activePendingSteerInterruptRecovery.pendingMessageIds.length,
                  requestedAt: activePendingSteerInterruptRecovery.requestedAt,
                },
          followUpQueuePhase,
          followUpQueueUiIdle,
          followUpQueueVisibleWorking,
          followUpQueueCanStartTurn,
          followUpQueueDispatchInFlight,
          canSteerFollowUpQueue,
          canActivateRunningFollowUpQueueAction,
          followUpQueueActionLabel,
          waitReasons: activeWaitReasons,
          activeProviderLiveSteerSupported,
          activeProviderLiveSteerAvailable,
          uiWorking: isWorking,
          activeTurnInProgress: isWorking || !latestTurnSettled,
          isComposerConnecting,
          isProviderConnecting,
          isConnecting,
          isRevertingCheckpoint,
          activeEnvironmentUnavailable,
          redFlags: lifecycleQueueRedFlags,
        },
        localDispatch: {
          isSendBusy,
          sendInFlightRef: sendInFlightRef.current,
          queueDispatchInFlightRef: queueDispatchInFlightRef.current,
          dispatchGateRevision,
          desktopDebugRevision,
          serverAcknowledgedLocalDispatch,
          localDispatchStartedAt,
          activePendingApprovalRequestId: activePendingApproval?.requestId ?? null,
          activePendingUserInputRequestId: activePendingUserInput?.requestId ?? null,
        },
      },
      provider: {
        selectedProvider,
        activeProviderInstanceId,
        activeProviderLiveSteerSupported,
        activeProviderLiveSteerAvailable,
        activeProviderStatus: activeProviderStatus
          ? {
              instanceId: activeProviderStatus.instanceId,
              driver: activeProviderStatus.driver,
              displayName: activeProviderStatus.displayName ?? null,
              enabled: activeProviderStatus.enabled,
              installed: activeProviderStatus.installed,
              status: activeProviderStatus.status,
              availability: activeProviderStatus.availability ?? "available",
              unavailableReason: activeProviderStatus.unavailableReason ?? null,
              message: activeProviderStatus.message ?? null,
              checkedAt: activeProviderStatus.checkedAt,
              runtimeCapabilities: activeProviderStatus.runtimeCapabilities ?? null,
            }
          : null,
      },
      queue: {
        activeThreadId,
        length: activeFollowUpQueue.length,
        steeringLength: steeringFollowUpViewItems.length,
        firstItemId: firstItem?.id ?? null,
        firstItemBlockedReason: firstItem?.blockedReason ?? null,
        canStartTurn: followUpQueueCanStartTurn,
        blockers: queueBlockers,
        orphanQueues: Object.fromEntries(
          orphanQueueEntries.map(([queuedThreadId, items]) => [
            queuedThreadId,
            {
              length: items.length,
              itemIds: items.map((item) => item.id),
              promptPreviews: items.map((item) =>
                previewQueuedFollowUpText(item.promptText).slice(0, 240),
              ),
            },
          ]),
        ),
        allQueues: Object.fromEntries(
          Object.entries(followUpQueueByThreadIdRef.current).map(([queuedThreadId, items]) => [
            queuedThreadId,
            {
              length: items.length,
              firstItemId: items[0]?.id ?? null,
              blockedReasons: items.map((item) => item.blockedReason),
              items: items.map((item, index) => ({
                index,
                id: item.id,
                environmentId: item.environmentId,
                threadId: item.threadId,
                queuedAt: item.queuedAt,
                blockedReason: item.blockedReason,
                promptLength: item.promptText.length,
                promptPreview: previewQueuedFollowUpText(item.promptText).slice(0, 240),
                imageCount: item.images.length,
                provider: item.provider,
                model: item.model,
                automaticSteerRetry: item.automaticSteerRetry ?? null,
              })),
            },
          ]),
        ),
        steering: {
          length: Object.keys(pendingSteerDispatchByMessageId).length,
          activeThreadLength: steeringFollowUpViewItems.length,
          interruptRecoveries: Object.fromEntries(
            Object.entries(pendingSteerInterruptRecoveryByThreadIdRef.current).map(
              ([recoveryThreadId, recovery]) => [
                recoveryThreadId,
                {
                  environmentId: recovery.environmentId,
                  threadId: recovery.threadId,
                  interruptedTurnId: recovery.interruptedTurnId,
                  pendingMessageIds: recovery.pendingMessageIds,
                  pendingMessageCount: recovery.pendingMessageIds.length,
                  requestedAt: recovery.requestedAt,
                },
              ],
            ),
          ),
          items: Object.values(pendingSteerDispatchByMessageId)
            .toSorted((left, right) => left.dispatchedAt.localeCompare(right.dispatchedAt))
            .map((pending) => ({
              environmentId: pending.environmentId,
              threadId: pending.threadId,
              messageId: pending.messageId,
              turnId: pending.turnId,
              dispatchedAt: pending.dispatchedAt,
              promptLength: pending.snapshot.promptText.length,
              promptPreview: previewQueuedFollowUpText(pending.snapshot.promptText).slice(0, 240),
              imageCount: pending.snapshot.images.length,
              provider: pending.snapshot.provider,
              model: pending.snapshot.model,
            })),
        },
        dispatchDebug: followUpQueueDebugRef.current,
        items: activeFollowUpQueue.map((item, index) => ({
          index,
          id: item.id,
          environmentId: item.environmentId,
          threadId: item.threadId,
          queuedAt: item.queuedAt,
          blockedReason: item.blockedReason,
          expanded: item.expanded,
          promptLength: item.promptText.length,
          promptPreview: previewQueuedFollowUpText(item.promptText).slice(0, 240),
          imageCount: item.images.length,
          provider: item.provider,
          model: item.model,
          modelSelection: item.modelSelection,
          runtimeMode: item.runtimeMode,
          interactionMode: item.interactionMode,
          automaticSteerRetry: item.automaticSteerRetry ?? null,
        })),
      },
      gates: {
        phase,
        followUpQueuePhase,
        followUpQueueUiIdle,
        followUpQueueVisibleWorking,
        followUpQueueCanStartTurn,
        followUpQueueDispatchInFlight,
        canSteerFollowUpQueue,
        canActivateRunningFollowUpQueueAction,
        firstActiveAutomaticSteerRetryBlocker,
        followUpQueueActionLabel,
        waitReasons: activeWaitReasons,
        isWorking,
        isSendBusy,
        hasEnvironmentApi: readEnvironmentApi(environmentId) !== null,
        hasDispatchFollowUpTurnStart: dispatchFollowUpTurnStartRef.current !== null,
        sendInFlightRef: sendInFlightRef.current,
        queueDispatchInFlightRef: queueDispatchInFlightRef.current,
        queuedFollowUpPendingDispatchByThreadId,
        pendingSteerDispatchByMessageId,
        dispatchGateRevision,
        desktopDebugRevision,
        isComposerConnecting,
        isProviderConnecting,
        isConnecting,
        isRevertingCheckpoint,
        activeEnvironmentUnavailable,
        serverAcknowledgedLocalDispatch,
        localDispatchStartedAt,
        activeQueueTurnId,
        activePendingApprovalRequestId: activePendingApproval?.requestId ?? null,
        activePendingUserInputRequestId: activePendingUserInput?.requestId ?? null,
      },
    };

    (
      snapshot.performance as {
        rendererSnapshotBuildDurationMs: number;
      }
    ).rendererSnapshotBuildDurationMs = roundDebugMs(performance.now() - snapshotBuildStartedAt);

    void bridge.publishDebugSnapshot(snapshot).catch(() => undefined);
  }, [
    activeEnvironmentUnavailable,
    activeFollowUpQueue,
    activeLatestTurn,
    activePendingApproval?.requestId,
    activePendingUserInput?.requestId,
    activeProject,
    activeProviderInstanceId,
    activeProviderLiveSteerAvailable,
    activeProviderLiveSteerSupported,
    activeProviderStatus,
    activeQueueTurnId,
    activeThread,
    activeThreadId,
    activeQueuedFollowUpPendingDispatch,
    activeSteeringFollowUpInFlight,
    allProjects,
    allThreads,
    canActivateRunningFollowUpQueueAction,
    canSteerFollowUpQueue,
    composerRef,
    desktopDebugEnabled,
    desktopDebugRevision,
    dispatchGateRevision,
    environmentId,
    firstActiveAutomaticSteerRetryBlocker,
    firstActiveFollowUpQueueItem,
    followUpQueueActionLabel,
    followUpQueueCanStartTurn,
    followUpQueueDispatchInFlight,
    followUpQueuePhase,
    followUpQueueUiIdle,
    followUpQueueVisibleWorking,
    isComposerConnecting,
    isConnecting,
    isProviderConnecting,
    isLocalDraftThread,
    isRevertingCheckpoint,
    isSendBusy,
    isServerThread,
    isWorking,
    knownThreadIds,
    latestTurnSettled,
    localDispatchStartedAt,
    phase,
    pendingSteerDispatchByMessageId,
    queuedFollowUpPendingDispatchByThreadId,
    routeKind,
    selectedProvider,
    serverAcknowledgedLocalDispatch,
    steeringFollowUpViewItems,
    threadId,
  ]);
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const shortcutLabelOptions = useMemo(() => ({ context: {} }), []);
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle", shortcutLabelOptions),
    [keybindings, shortcutLabelOptions],
  );
  const onToggleDiff = useCallback(() => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId,
      },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen ? { ...rest, diff: undefined } : { ...rest, diff: "1" };
      },
    });
  }, [diffOpen, environmentId, isServerThread, navigate, onDiffPanelOpen, threadId]);

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );

  // Handle environment change for draft threads.  When the user picks a
  // different environment we update the draft context to point at the physical
  // project in that environment while keeping the same logical project.
  const onEnvironmentChange = useCallback(
    (nextEnvironmentId: EnvironmentId) => {
      if (envLocked || !draftId) return;
      const target = logicalProjectEnvironments.find(
        (env) => env.environmentId === nextEnvironmentId,
      );
      if (!target) return;
      setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(target.environmentId, target.projectId),
      });
    },
    [draftId, envLocked, logicalProjectEnvironments, setDraftThreadContext],
  );

  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      const isCurrentServerThread = shouldWriteThreadErrorToCurrentServerThread({
        serverThread,
        routeThreadRef,
        targetThreadId,
      });
      if (isCurrentServerThread) {
        setStoreThreadError(targetThreadId, nextError);
        return;
      }
      const localDraftErrorKey = draftId ?? targetThreadId;
      setLocalDraftErrorsByDraftId((existing) => {
        if ((existing[localDraftErrorKey] ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [localDraftErrorKey]: nextError,
        };
      });
    },
    [draftId, routeThreadRef, serverThread, setStoreThreadError],
  );

  const focusComposer = useCallback(() => {
    readComposerHandle(composerRef)?.focusAtEnd();
  }, [composerRef]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);

  const setPlanSidebarOpenForCurrentThread = useCallback(
    (open: boolean) => {
      if (routeKind === "server") {
        setPersistedPlanSidebarOpen(routeThreadKey, open);
        return;
      }
      setDraftPlanSidebarOpenByThreadKey((previous) =>
        previous[routeThreadKey] === open
          ? previous
          : {
              ...previous,
              [routeThreadKey]: open,
            },
      );
    },
    [routeKind, routeThreadKey, setPersistedPlanSidebarOpen],
  );

  const togglePlanSidebar = useCallback(() => {
    setPlanSidebarOpenForCurrentThread(!planSidebarOpen);
  }, [planSidebarOpen, setPlanSidebarOpenForCurrentThread]);
  const closePlanSidebar = useCallback(() => {
    setPlanSidebarOpenForCurrentThread(false);
  }, [setPlanSidebarOpenForCurrentThread]);

  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      thread: Thread;
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => {
      const api = readEnvironmentApi(input.thread.environmentId);
      if (!api) {
        return;
      }

      if (
        input.modelSelection !== undefined &&
        (input.modelSelection.model !== input.thread.modelSelection.model ||
          input.modelSelection.instanceId !== input.thread.modelSelection.instanceId ||
          JSON.stringify(input.modelSelection.options ?? null) !==
            JSON.stringify(input.thread.modelSelection.options ?? null))
      ) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: input.threadId,
          modelSelection: input.modelSelection,
        });
      }

      if (input.runtimeMode !== input.thread.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (input.interactionMode !== input.thread.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [],
  );

  // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches.  LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const hideScrollToBottom = useCallback(() => {
    isAtEndRef.current = true;
    timelineUserScrollIntentSinceResetRef.current = false;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
  }, []);

  // Scroll helpers — LegendList handles auto-scroll via maintainScrollAtEnd.
  const scrollToEnd = useCallback(
    (animated = false) => {
      hideScrollToBottom();
      void legendListRef.current?.scrollToEnd?.({ animated });
    },
    [hideScrollToBottom],
  );
  const pinTimelineToEndForLocalMessage = useCallback(() => {
    // Sending a local user message is an explicit request to move to the new
    // conversation tail. Do not trust LegendList's last scroll measurement
    // here: composer resize, virtual row replacement, and pending work rows can
    // briefly report "not at end" even though the user's next action should be
    // anchored to the prompt they just submitted.
    shouldPinTimelineToEndForLocalMessage();
    hideScrollToBottom();
    setStickTimelineToEndRevision((revision) => revision + 1);
    void legendListRef.current?.scrollToEnd?.({ animated: false });
    window.requestAnimationFrame(() => {
      void legendListRef.current?.scrollToEnd?.({ animated: false });
      window.requestAnimationFrame(() => {
        void legendListRef.current?.scrollToEnd?.({ animated: false });
      });
    });
  }, [hideScrollToBottom]);
  const onTimelineUserScrollIntent = useCallback(() => {
    timelineUserScrollIntentSinceResetRef.current = true;
  }, []);
  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean) => {
      if (isAtEnd) {
        hideScrollToBottom();
        return;
      }

      if (!timelineUserScrollIntentSinceResetRef.current) {
        showScrollDebouncer.current.cancel();
        setShowScrollToBottom(false);
        return;
      }

      if (isAtEndRef.current === false) return;
      isAtEndRef.current = false;
      showScrollDebouncer.current.maybeExecute();
    },
    [hideScrollToBottom],
  );

  useEffect(() => {
    setPullRequestDialogState(null);
    isAtEndRef.current = true;
    timelineUserScrollIntentSinceResetRef.current = false;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    if (planSidebarOpenOnNextThreadRef.current) {
      planSidebarOpenOnNextThreadRef.current = false;
      setPlanSidebarOpenForCurrentThread(true);
    }
  }, [activeThread?.id, setPlanSidebarOpenForCurrentThread]);

  // Auto-open the plan sidebar when plan/todo steps arrive for the current turn.
  // Don't auto-open for plans carried over from a previous turn (the user can open manually).
  useEffect(() => {
    if (!autoOpenPlanSidebar) return;
    if (!activePlan) return;
    if (!hasPlanSidebarContent) return;
    if (planSidebarOpen) return;
    // Once the user has explicitly opened or closed the sidebar for this
    // thread, that thread-local preference wins over later task updates.
    if (planSidebarOpenPreference !== undefined) return;
    const latestTurnId = activeLatestTurn?.turnId ?? null;
    if (latestTurnId && activePlan.turnId !== latestTurnId) return;
    setPlanSidebarOpenForCurrentThread(true);
  }, [
    activePlan,
    activeLatestTurn?.turnId,
    autoOpenPlanSidebar,
    hasPlanSidebarContent,
    planSidebarOpen,
    planSidebarOpenPreference,
    setPlanSidebarOpenForCurrentThread,
  ]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  // Auto-focusing the composer when a thread opens pops the on-screen keyboard
  // on mobile, which is disruptive when the user is just browsing threads. Skip
  // auto-focus on mobile; the user can tap the composer to focus it (the mobile
  // composer stays collapsed until then). Desktop behavior is unchanged.
  useEffect(() => {
    if (!activeThread?.id) return;
    if (isMobile) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, isMobile]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setExpandedImage(null);
  }, [draftId, resetLocalDispatch, threadId]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeThread.messages.length === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranch !== undefined
      ? pendingServerThreadBranch
      : (activeThread?.branch ?? null);
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });

  useEffect(() => {
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [activeThread?.id]);

  useEffect(() => {
    if (canOverrideServerThreadEnvMode) {
      return;
    }
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [canOverrideServerThreadEnvMode]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || useCommandPaletteStore.getState().open || event.defaultPrevented) {
        return;
      }
      const shortcutContext = {
        modelPickerOpen: readComposerHandle(composerRef)?.isModelPickerOpen() ?? false,
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        readComposerHandle(composerRef)?.toggleModelPicker();
        return;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeThreadId, composerRef, keybindings, onToggleDiff]);

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readEnvironmentApi(environmentId);
      const localApi = readLocalApi();
      if (!api || !localApi || !activeThread || isRevertingCheckpoint) return;

      if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
        setThreadError(
          activeThread.id,
          `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
        );
        return;
      }
      if (phase === "running" || isSendBusy || isComposerConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await localApi.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [
      activeThread,
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      environmentId,
      isComposerConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      phase,
      setThreadError,
    ],
  );

  const readComposerSnapshotForDispatch = (): ComposerSendSnapshot | null => {
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx) return null;
    return {
      promptText: promptRef.current,
      images: [...sendCtx.images],
      provider: sendCtx.selectedProvider,
      model: sendCtx.selectedModel,
      providerModels: sendCtx.selectedProviderModels,
      promptEffort: sendCtx.selectedPromptEffort,
      modelSelection: sendCtx.selectedModelSelection,
      runtimeMode,
      interactionMode,
    };
  };

  const buildAttachmentsForSnapshot = async (
    snapshot: ComposerSendSnapshot,
  ): Promise<OrchestrationUploadChatAttachment[]> =>
    Promise.all(
      snapshot.images.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    );

  const outgoingTextForSnapshot = (snapshot: ComposerSendSnapshot): string =>
    formatOutgoingPrompt({
      provider: snapshot.provider,
      model: snapshot.model,
      models: snapshot.providerModels,
      effort: snapshot.promptEffort,
      text: snapshot.promptText || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    });

  const clearActiveComposerContent = () => {
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();
    scheduleComposerFocus();
  };

  const restoreComposerSnapshotForRetry = (snapshot: ComposerSendSnapshot) => {
    const retryComposerImages = snapshot.images.map(cloneComposerImageForRetry);
    promptRef.current = snapshot.promptText;
    composerImagesRef.current = retryComposerImages;
    setComposerDraftPrompt(composerDraftTarget, snapshot.promptText);
    addComposerDraftImages(composerDraftTarget, retryComposerImages);
    composerRef.current?.resetCursorState({
      cursor: collapseExpandedComposerCursor(snapshot.promptText, snapshot.promptText.length),
      prompt: snapshot.promptText,
      detectTrigger: true,
    });
    scheduleComposerFocus();
  };

  const enqueueFollowUpSnapshot = (snapshot: ComposerSendSnapshot) => {
    if (!activeThread) return;
    const queuedAt = new Date().toISOString();
    const item: FollowUpQueueItem = {
      ...snapshot,
      id: newMessageId(),
      environmentId: activeThread.environmentId,
      threadId: activeThread.id,
      queuedAt,
      expanded: false,
      blockedReason: null,
    };
    setFollowUpQueueByThreadId((existing) => ({
      ...existing,
      [activeThread.id]: [...(existing[activeThread.id] ?? EMPTY_FOLLOW_UP_QUEUE), item],
    }));
    setThreadError(activeThread.id, null);
    clearActiveComposerContent();
    scheduleComposerFocus();
  };

  const removeFollowUpQueueItem = (targetThreadId: ThreadId, itemId: string, revoke: boolean) => {
    const removed = followUpQueueByThreadIdRef.current[targetThreadId]?.find(
      (item) => item.id === itemId,
    );
    if (removed && revoke) {
      revokeQueuedFollowUpPreviewUrls(removed);
    }
    setFollowUpQueueByThreadId((existing) => {
      const current = existing[targetThreadId] ?? EMPTY_FOLLOW_UP_QUEUE;
      const nextItems = current.filter((item) => item.id !== itemId);
      if (nextItems.length === current.length) return existing;
      const next = { ...existing };
      if (nextItems.length === 0) {
        delete next[targetThreadId];
      } else {
        next[targetThreadId] = nextItems;
      }
      return next;
    });
  };

  const blockFollowUpQueueItem = (targetThreadId: ThreadId, itemId: string, reason: string) => {
    setFollowUpQueueByThreadId((existing) => {
      const current = existing[targetThreadId] ?? EMPTY_FOLLOW_UP_QUEUE;
      let changed = false;
      const nextItems: FollowUpQueueItem[] = [];
      for (const item of current) {
        if (item.id !== itemId || item.blockedReason === reason) {
          nextItems.push(item);
          continue;
        }
        changed = true;
        nextItems.push({ ...item, blockedReason: reason });
      }
      if (!changed) return existing;
      return {
        ...existing,
        [targetThreadId]: nextItems,
      };
    });
  };

  const dispatchFollowUpTurnStart = async (item: FollowUpQueueItem) => {
    const queuedThread = resolveQueuedFollowUpThread(item);
    if (!queuedThread) {
      blockFollowUpQueueItem(item.threadId, item.id, "Thread is not loaded yet.");
      return;
    }
    const api = readEnvironmentApi(queuedThread.environmentId);
    if (!api) {
      blockFollowUpQueueItem(item.threadId, item.id, "Cafe Code is not connected.");
      return;
    }
    if (isThreadEnvironmentUnavailable(queuedThread)) {
      blockFollowUpQueueItem(item.threadId, item.id, "Cafe Code is not connected.");
      return;
    }
    const queuedProject = resolveProjectForThread(queuedThread);
    if (!queuedProject) {
      blockFollowUpQueueItem(item.threadId, item.id, "Project metadata is not loaded yet.");
      return;
    }
    if (
      queueDispatchInFlightRef.current ||
      queuedFollowUpPendingDispatchByThreadIdRef.current[item.threadId] !== undefined
    ) {
      return;
    }

    const isVisibleThread =
      activeThread?.environmentId === queuedThread.environmentId &&
      activeThread.id === queuedThread.id;
    setQueueDispatchInFlight(true);
    if (isVisibleThread) {
      setSendInFlight(true);
      beginLocalDispatch({ preparingWorktree: false });
    }

    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = outgoingTextForSnapshot(item);
    const optimisticAttachments = optimisticAttachmentsForSnapshot(item);
    const turnAttachmentsPromise = buildAttachmentsForSnapshot(item);

    setQueuedFollowUpPendingDispatch(
      {
        environmentId: queuedThread.environmentId,
        threadId: queuedThread.id,
        messageId: messageIdForSend,
        dispatchedAt: messageCreatedAt,
      },
      item.threadId,
    );
    removeFollowUpQueueItem(item.threadId, item.id, false);
    if (isVisibleThread) {
      pinTimelineToEndForLocalMessage();
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);
    }

    let turnStartSucceeded = false;
    try {
      await persistThreadSettingsForNextTurn({
        thread: queuedThread,
        threadId: item.threadId,
        createdAt: messageCreatedAt,
        modelSelection: item.modelSelection,
        runtimeMode: item.runtimeMode,
        interactionMode: item.interactionMode,
      });
      const turnAttachments = await turnAttachmentsPromise;
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: item.threadId,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        modelSelection: item.modelSelection,
        titleSeed: queuedThread.title,
        runtimeMode: item.runtimeMode,
        interactionMode: item.interactionMode,
        createdAt: messageCreatedAt,
      });
      turnStartSucceeded = true;
      setThreadError(item.threadId, null);
    } catch (err) {
      if (isVisibleThread) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          return existing.filter((message) => message.id !== messageIdForSend);
        });
      }
      setFollowUpQueueByThreadId((existing) => ({
        ...existing,
        [item.threadId]: [
          {
            ...item,
            blockedReason: err instanceof Error ? err.message : "Failed to send queued follow-up.",
          },
          ...(existing[item.threadId] ?? EMPTY_FOLLOW_UP_QUEUE),
        ],
      }));
      setThreadError(
        item.threadId,
        err instanceof Error ? err.message : "Failed to send queued follow-up.",
      );
    } finally {
      setQueueDispatchInFlight(false);
      if (isVisibleThread) {
        setSendInFlight(false);
      }
      if (!turnStartSucceeded) {
        setQueuedFollowUpPendingDispatch(null, item.threadId);
        if (isVisibleThread) {
          resetLocalDispatch();
        }
      } else if (!isVisibleThread) {
        revokeQueuedFollowUpPreviewUrls(item);
      }
    }
  };
  dispatchFollowUpTurnStartRef.current = dispatchFollowUpTurnStart;

  const dispatchSteerSnapshot = async (
    snapshot: ComposerSendSnapshot,
    options?: { queuedItem?: FollowUpQueueItem },
  ) => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !activeThread) return;
    if (!options?.queuedItem && sendInFlightRef.current) return;
    if (!activeProviderLiveSteerAvailable || phase !== "running") {
      if (!options?.queuedItem) {
        enqueueFollowUpSnapshot(snapshot);
      }
      return;
    }

    setSendInFlight(true);
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = outgoingTextForSnapshot(snapshot);
    const optimisticAttachments = optimisticAttachmentsForSnapshot(snapshot);
    const turnAttachmentsPromise = buildAttachmentsForSnapshot(snapshot);

    updatePendingSteerDispatches((current) => {
      const next = {
        ...current,
        [String(messageIdForSend)]: {
          environmentId: activeThread.environmentId,
          threadId: activeThread.id,
          messageId: messageIdForSend,
          turnId: activeThread.session?.activeTurnId ?? activeThread.latestTurn?.turnId ?? null,
          snapshot,
          dispatchedAt: messageCreatedAt,
        },
      };
      const pendingSteerEntries = Object.entries(next);
      if (pendingSteerEntries.length <= 64) {
        return next;
      }
      for (const [messageId] of pendingSteerEntries
        .toSorted(([, left], [, right]) => left.dispatchedAt.localeCompare(right.dispatchedAt))
        .slice(0, pendingSteerEntries.length - 64)) {
        delete next[messageId];
      }
      return next;
    });

    if (options?.queuedItem) {
      removeFollowUpQueueItem(options.queuedItem.threadId, options.queuedItem.id, false);
    }

    pinTimelineToEndForLocalMessage();
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        createdAt: messageCreatedAt,
        streaming: false,
      },
    ]);

    try {
      const turnAttachments = await turnAttachmentsPromise;
      await api.orchestration.dispatchCommand({
        type: "thread.turn.steer",
        commandId: newCommandId(),
        threadId: activeThread.id,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        createdAt: messageCreatedAt,
      });
      setThreadError(activeThread.id, null);
      if (!options?.queuedItem) {
        clearActiveComposerContent();
      }
    } catch (err) {
      removePendingSteerDispatch(messageIdForSend);
      setOptimisticUserMessages((existing) => {
        const removed = existing.filter((message) => message.id === messageIdForSend);
        for (const message of removed) {
          revokeUserMessagePreviewUrls(message);
        }
        return existing.filter((message) => message.id !== messageIdForSend);
      });
      if (options?.queuedItem) {
        setFollowUpQueueByThreadId((existing) => ({
          ...existing,
          [options.queuedItem!.threadId]: [
            options.queuedItem!,
            ...(existing[options.queuedItem!.threadId] ?? EMPTY_FOLLOW_UP_QUEUE),
          ],
        }));
      } else if (promptRef.current.length === 0 && composerImagesRef.current.length === 0) {
        restoreComposerSnapshotForRetry(snapshot);
      }
      setThreadError(activeThread.id, err instanceof Error ? err.message : "Failed to steer turn.");
    } finally {
      setSendInFlight(false);
    }
  };
  dispatchQueuedSteerRetryRef.current = (item) => dispatchSteerSnapshot(item, { queuedItem: item });

  useEffect(() => {
    if (!canSteerFollowUpQueue || !activeThread) {
      return;
    }

    const firstItem = followUpQueueByThreadIdRef.current[activeThread.id]?.[0] ?? null;
    if (firstItem === null || !isAutomaticSteerRetryItem(firstItem)) {
      return;
    }

    const retryBlocker = resolveAutomaticSteerRetryBlocker({
      item: firstItem,
      thread: activeThread,
      phase: followUpQueuePhase,
    });
    if (retryBlocker !== null) {
      recordFollowUpQueueDebugAttempt("automatic-steer-retry", retryBlocker, {
        threadId: firstItem.threadId,
        itemId: firstItem.id,
      });
      return;
    }

    const dispatchQueuedSteerRetry = dispatchQueuedSteerRetryRef.current;
    if (dispatchQueuedSteerRetry === null) {
      recordFollowUpQueueDebugAttempt("automatic-steer-retry", "dispatch-ref-missing", {
        threadId: firstItem.threadId,
        itemId: firstItem.id,
      });
      return;
    }

    recordFollowUpQueueDebugAttempt("automatic-steer-retry", "dispatch-started", {
      threadId: firstItem.threadId,
      itemId: firstItem.id,
    });
    void dispatchQueuedSteerRetry(firstItem);
  }, [
    activeThread,
    canSteerFollowUpQueue,
    followUpQueueByThreadId,
    followUpQueuePhase,
    recordFollowUpQueueDebugAttempt,
  ]);

  const onSend = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    const api = readEnvironmentApi(environmentId);
    if (
      !api ||
      !activeThread ||
      isSendBusy ||
      isComposerConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    )
      return;
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return;
    }
    const snapshot = readComposerSnapshotForDispatch();
    if (!snapshot) return;
    const {
      images: composerImages,
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      providerModels: ctxSelectedProviderModels,
      promptEffort: ctxSelectedPromptEffort,
      modelSelection: ctxSelectedModelSelection,
    } = snapshot;
    const promptForSend = snapshot.promptText;
    const { trimmedPrompt: trimmed, hasSendableContent } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
    });
    const delivery = decideFollowUpDelivery({
      phase: followUpQueuePhase,
      requestedSteer: false,
      liveSteerSupported: activeProviderLiveSteerAvailable,
    });
    if (delivery === "queue") {
      if (!hasSendableContent) return;
      pinTimelineToEndForLocalMessage();
      enqueueFollowUpSnapshot(snapshot);
      return;
    }
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      scheduleComposerFocus();
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    const standaloneSlashCommand =
      composerImages.length === 0 ? parseStandaloneComposerSlashCommand(trimmed) : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      scheduleComposerFocus();
      return;
    }
    if (!hasSendableContent) return;
    if (!activeProject) return;
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath
        ? activeThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThreadBranch) {
      setThreadError(threadIdForSend, "Select a base branch before sending in New worktree mode.");
      return;
    }

    setSendInFlight(true);
    beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });

    const composerImagesSnapshot = [...composerImages];
    const messageTextForSend = promptForSend;
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    });
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));
    pinTimelineToEndForLocalMessage();

    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        createdAt: messageCreatedAt,
        streaming: false,
      },
    ]);

    setThreadError(threadIdForSend, null);
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();
    scheduleComposerFocus();

    let turnStartSucceeded = false;
    await (async () => {
      let firstComposerImageName: string | null = null;
      if (composerImagesSnapshot.length > 0) {
        const firstComposerImage = composerImagesSnapshot[0];
        if (firstComposerImage) {
          firstComposerImageName = firstComposerImage.name;
        }
      }
      let titleSeed = trimmed;
      if (!titleSeed) {
        if (firstComposerImageName) {
          titleSeed = `Image: ${firstComposerImageName}`;
        } else {
          titleSeed = "New thread";
        }
      }
      const title = truncate(titleSeed);
      const threadCreateModelSelection = createModelSelection(
        ctxSelectedModelSelection.instanceId,
        ctxSelectedModel || activeProject.defaultModelSelection?.model || DEFAULT_MODEL,
        ctxSelectedModelSelection.options,
      );

      // Auto-title from first message
      if (isFirstMessage && isServerThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          title,
        });
      }

      if (isServerThread) {
        await persistThreadSettingsForNextTurn({
          thread: activeThread,
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          ...(ctxSelectedModel ? { modelSelection: ctxSelectedModelSelection } : {}),
          runtimeMode,
          interactionMode,
        });
      }

      const turnAttachments = await turnAttachmentsPromise;
      const bootstrap =
        isLocalDraftThread || baseBranchForWorktree
          ? {
              ...(isLocalDraftThread
                ? {
                    createThread: {
                      projectId: activeProject.id,
                      title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode,
                      interactionMode,
                      branch: activeThreadBranch,
                      worktreePath: activeThread.worktreePath,
                      createdAt: activeThread.createdAt,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.cwd,
                      baseBranch: baseBranchForWorktree,
                      branch: buildTemporaryWorktreeBranchName(),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      beginLocalDispatch({ preparingWorktree: false });
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        modelSelection: ctxSelectedModelSelection,
        titleSeed: title,
        runtimeMode,
        interactionMode,
        ...(bootstrap ? { bootstrap } : {}),
        createdAt: messageCreatedAt,
      });
      turnStartSucceeded = true;
    })().catch(async (err: unknown) => {
      if (
        !turnStartSucceeded &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = promptForSend;
        const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
        composerImagesRef.current = retryComposerImages;
        setComposerDraftPrompt(composerDraftTarget, promptForSend);
        addComposerDraftImages(composerDraftTarget, retryComposerImages);
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(promptForSend, promptForSend.length),
          prompt: promptForSend,
          detectTrigger: true,
        });
        scheduleComposerFocus();
      }
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    });
    setSendInFlight(false);
    if (!turnStartSucceeded) {
      resetLocalDispatch();
    }
  };

  const onSteer = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    if (
      !activeThread ||
      isSendBusy ||
      isComposerConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return;
    }
    const snapshot = readComposerSnapshotForDispatch();
    if (!snapshot) return;
    const { hasSendableContent } = deriveComposerSendState({
      prompt: snapshot.promptText,
      imageCount: snapshot.images.length,
    });
    if (!hasSendableContent) return;
    const delivery = decideFollowUpDelivery({
      phase: followUpQueuePhase,
      requestedSteer: true,
      liveSteerSupported: activeProviderLiveSteerAvailable,
    });
    if (delivery === "send") {
      await onSend(e);
      return;
    }
    if (delivery === "queue") {
      pinTimelineToEndForLocalMessage();
      enqueueFollowUpSnapshot(snapshot);
      return;
    }
    await dispatchSteerSnapshot(snapshot);
  };

  const onToggleFollowUpQueueItem = (itemId: string) => {
    if (!activeThreadId) return;
    setFollowUpQueueByThreadId((existing) => {
      const current = existing[activeThreadId] ?? EMPTY_FOLLOW_UP_QUEUE;
      if (current.length === 0) return existing;
      let changed = false;
      const nextItems: FollowUpQueueItem[] = [];
      for (const item of current) {
        if (item.id !== itemId) {
          nextItems.push(item);
          continue;
        }
        if (!canExpandQueuedFollowUpText(item.promptText)) {
          changed = changed || item.expanded;
          nextItems.push({ ...item, expanded: false });
          continue;
        }
        changed = true;
        nextItems.push({
          ...item,
          expanded: !item.expanded,
        });
      }
      if (!changed) return existing;
      return {
        ...existing,
        [activeThreadId]: nextItems,
      };
    });
  };

  const armPendingSteerInterruptRecovery = (thread: Thread): void => {
    if (thread.session?.provider !== "codex") {
      return;
    }
    const pendingSteers = pendingSteerDispatchesForThread(
      pendingSteerDispatchByMessageIdRef.current,
      thread.id,
    );
    if (pendingSteers.length === 0) {
      return;
    }

    const requestedAt = new Date().toISOString();
    const recovery: PendingSteerInterruptRecovery = {
      environmentId: thread.environmentId,
      threadId: thread.id,
      interruptedTurnId: thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null,
      pendingMessageIds: pendingSteers.map((pending) => pending.messageId),
      requestedAt,
    };
    updatePendingSteerInterruptRecoveries((current) => ({
      ...current,
      [thread.id]: recovery,
    }));
    recordFollowUpQueueDebugAttempt("pending-steer-interrupt", "armed", {
      threadId: thread.id,
    });
  };

  const dispatchFollowUpQueueInterrupt = async (item: FollowUpQueueItem) => {
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      recordFollowUpQueueDebugAttempt("manual-interrupt", "environment-api-missing", {
        threadId: item.threadId,
        itemId: item.id,
      });
      toastManager.add({
        type: "error",
        title: "Could not interrupt turn",
        description: "Cafe Code is not connected.",
      });
      return;
    }
    if (!activeThread || activeThread.id !== item.threadId) {
      recordFollowUpQueueDebugAttempt("manual-interrupt", "thread-not-active", {
        threadId: item.threadId,
        itemId: item.id,
      });
      return;
    }

    const turnId = activeThread.session?.activeTurnId ?? undefined;
    armPendingSteerInterruptRecovery(activeThread);
    recordFollowUpQueueDebugAttempt("manual-interrupt", "interrupt-requested", {
      threadId: item.threadId,
      itemId: item.id,
    });

    try {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId: item.threadId,
        ...(turnId !== undefined ? { turnId } : {}),
        createdAt: new Date().toISOString(),
      });
      setThreadError(item.threadId, null);
    } catch (error) {
      updatePendingSteerInterruptRecoveries((current) => {
        if (!(item.threadId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[item.threadId];
        return next;
      });
      const message = error instanceof Error ? error.message : "Failed to interrupt active turn.";
      recordFollowUpQueueDebugAttempt("manual-interrupt", "interrupt-failed", {
        threadId: item.threadId,
        itemId: item.id,
      });
      setThreadError(item.threadId, message);
      toastManager.add({
        type: "error",
        title: "Could not interrupt turn",
        description: message,
      });
    }
  };

  const onActivateFollowUpQueueItem = (itemId: string) => {
    if (!activeThreadId) return;
    const item = followUpQueueByThreadIdRef.current[activeThreadId]?.find(
      (entry) => entry.id === itemId,
    );
    if (!item) return;

    const action = decideQueuedFollowUpAction({
      phase: followUpQueuePhase,
      liveSteerSupported: activeProviderLiveSteerAvailable,
      canDispatchNow:
        followUpQueuePhase === "running"
          ? canActivateRunningFollowUpQueueAction
          : followUpQueueCanStartTurn,
    });

    if (action === "send") {
      void dispatchFollowUpTurnStartRef.current?.(item);
      return;
    }

    if (action === "steer") {
      const retryBlocker =
        activeThread !== undefined
          ? resolveAutomaticSteerRetryBlocker({
              item,
              thread: activeThread,
              phase: followUpQueuePhase,
            })
          : "review-active-turn";
      if (retryBlocker !== null) {
        recordFollowUpQueueDebugAttempt("manual-activate", retryBlocker, {
          threadId: item.threadId,
          itemId: item.id,
        });
        return;
      }
      void dispatchSteerSnapshot(item, { queuedItem: item });
      return;
    }

    if (action === "interrupt") {
      void dispatchFollowUpQueueInterrupt(item);
      return;
    }

    recordFollowUpQueueDebugAttempt("manual-activate", "queued-follow-up-not-ready", {
      threadId: item.threadId,
      itemId: item.id,
    });
  };

  const onRemoveFollowUpQueueItem = (itemId: string) => {
    if (!activeThreadId) return;
    removeFollowUpQueueItem(activeThreadId, itemId, true);
  };

  const onClearFollowUpQueue = () => {
    if (!activeThreadId) return;
    const current = followUpQueueByThreadIdRef.current[activeThreadId] ?? EMPTY_FOLLOW_UP_QUEUE;
    for (const item of current) {
      revokeQueuedFollowUpPreviewUrls(item);
    }
    setFollowUpQueueByThreadId((existing) => {
      if (!(activeThreadId in existing)) return existing;
      const next = { ...existing };
      delete next[activeThreadId];
      return next;
    });
  };

  const tryDispatchNextQueuedFollowUp = useCallback(
    (source = "state-change") => {
      const queuesByThreadId = followUpQueueByThreadIdRef.current;
      const queuedCount = Object.values(queuesByThreadId).reduce(
        (total, items) => total + items.length,
        0,
      );
      if (queuedCount === 0) {
        recordFollowUpQueueDebugAttempt(source, "queue-empty");
        return false;
      }

      const candidate = selectQueuedFollowUpDispatchCandidate<ThreadId, FollowUpQueueItem>({
        queuesByThreadId,
        preferredThreadId: activeThreadId,
        canStart: ({ item, queueLength }) => {
          const queuedThread = resolveQueuedFollowUpThread(item);
          if (!queuedThread) {
            return false;
          }
          const queuedPhase = resolveFollowUpQueuePhase({
            phase: derivePhase(queuedThread.session),
            latestTurn: queuedThread.latestTurn,
            activeTurnId: queuedThread.session?.activeTurnId ?? null,
            sessionUpdatedAt: queuedThread.session?.updatedAt ?? null,
          });
          return canStartQueuedFollowUpTurn({
            queueLength,
            firstItemBlocked: item.blockedReason != null,
            isWorking: queuedPhase === "running",
            isConnecting: queuedPhase === "connecting",
            isEnvironmentUnavailable: isThreadEnvironmentUnavailable(queuedThread),
            isDispatchInFlight:
              queueDispatchInFlightRef.current ||
              queuedFollowUpPendingDispatchByThreadIdRef.current[item.threadId] !== undefined,
          });
        },
      });
      if (!candidate) {
        recordFollowUpQueueDebugAttempt(source, "no-dispatchable-queued-thread");
        return false;
      }
      const dispatchFollowUpTurnStart = dispatchFollowUpTurnStartRef.current;
      if (dispatchFollowUpTurnStart === null) {
        recordFollowUpQueueDebugAttempt(source, "dispatch-ref-missing", {
          threadId: candidate.threadId,
          itemId: candidate.item.id,
        });
        return false;
      }
      recordFollowUpQueueDebugAttempt(source, "dispatch-started", {
        threadId: candidate.threadId,
        itemId: candidate.item.id,
      });
      void dispatchFollowUpTurnStart(candidate.item);
      return true;
    },
    [
      activeThreadId,
      isThreadEnvironmentUnavailable,
      recordFollowUpQueueDebugAttempt,
      resolveQueuedFollowUpThread,
    ],
  );

  useEffect(() => {
    tryDispatchNextQueuedFollowUp();
  }, [
    allThreads,
    dispatchGateRevision,
    followUpQueueByThreadId,
    queuedFollowUpPendingDispatchByThreadId,
    savedEnvironmentRuntimeById,
    tryDispatchNextQueuedFollowUp,
  ]);

  useEffect(() => {
    if (totalFollowUpQueueLength === 0) {
      return;
    }
    const intervalId = window.setInterval(() => {
      tryDispatchNextQueuedFollowUp("watchdog");
    }, FOLLOW_UP_QUEUE_WATCHDOG_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [totalFollowUpQueueLength, tryDispatchNextQueuedFollowUp]);

  const onInterrupt = async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !activeThread) return;
    const turnId = activeThread.session?.activeTurnId ?? undefined;
    armPendingSteerInterruptRecovery(activeThread);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId: activeThread.id,
        ...(turnId !== undefined ? { turnId } : {}),
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      updatePendingSteerInterruptRecoveries((current) => {
        if (!(activeThread.id in current)) {
          return current;
        }
        const next = { ...current };
        delete next[activeThread.id];
        return next;
      });
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to interrupt active turn.",
      );
    }
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit approval decision.",
          );
        });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, environmentId, setThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit user input.",
          );
        });
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, environmentId, setThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) {
          return existing;
        }

        return {
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingUserInput.requestId]?.[questionId],
              optionLabel,
            ),
          },
        };
      });
      promptRef.current = "";
      readComposerHandle(composerRef)?.resetCursorState({ cursor: 0 });
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, composerRef],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      const snapshot = readComposerHandle(composerRef)?.readSnapshot();
      if (
        snapshot?.value !== value ||
        snapshot.cursor !== nextCursor ||
        snapshot.expandedCursor !== expandedCursor
      ) {
        readComposerHandle(composerRef)?.focusAt(nextCursor);
      }
    },
    [activePendingUserInput, composerRef],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      const api = readEnvironmentApi(environmentId);
      if (
        !api ||
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isComposerConnecting ||
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const sendCtx = readComposerHandle(composerRef)?.getSendContext();
      if (!sendCtx) {
        return;
      }
      const {
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
      } = sendCtx;

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: trimmed,
      });

      setSendInFlight(true);
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);

      pinTimelineToEndForLocalMessage();

      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);

      try {
        await persistThreadSettingsForNextTurn({
          thread: activeThread,
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          modelSelection: ctxSelectedModelSelection,
          runtimeMode,
          interactionMode: nextInteractionMode,
        });

        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          nextInteractionMode,
        );

        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: activeThread.title,
          runtimeMode,
          interactionMode: nextInteractionMode,
          ...(nextInteractionMode === "default" && activeProposedPlan
            ? {
                sourceProposedPlan: {
                  threadId: activeThread.id,
                  planId: activeProposedPlan.id,
                },
              }
            : {}),
          createdAt: messageCreatedAt,
        });
        // Optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (
          nextInteractionMode === "default" &&
          autoOpenPlanSidebar &&
          planSidebarOpenPreference === undefined
        ) {
          setPlanSidebarOpenForCurrentThread(true);
        }
        setSendInFlight(false);
      } catch (err) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send plan follow-up.",
        );
        setSendInFlight(false);
        resetLocalDispatch();
      }
    },
    [
      activeThread,
      activeProposedPlan,
      beginLocalDispatch,
      isComposerConnecting,
      isSendBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      pinTimelineToEndForLocalMessage,
      resetLocalDispatch,
      runtimeMode,
      setComposerDraftInteractionMode,
      setSendInFlight,
      setThreadError,
      autoOpenPlanSidebar,
      planSidebarOpenPreference,
      setPlanSidebarOpenForCurrentThread,
      composerRef,
      environmentId,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    if (
      !api ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isComposerConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }

    const sendCtx = readComposerHandle(composerRef)?.getSendContext();
    if (!sendCtx) {
      return;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection;

    setSendInFlight(true);
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      setSendInFlight(false);
      resetLocalDispatch();
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      })
      .then(() => {
        return api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        });
      })
      .then(() => {
        return waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId));
      })
      .then(() => {
        // Signal that the plan sidebar should open on the new thread when enabled.
        planSidebarOpenOnNextThreadRef.current = autoOpenPlanSidebar;
        return navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        });
      })
      .catch(async (err: unknown) => {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch(() => undefined);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start implementation thread",
            description:
              err instanceof Error
                ? err.message
                : "An error occurred while creating the new thread.",
          }),
        );
      })
      .then(finish, finish);
  }, [
    activeProject,
    activeProposedPlan,
    activeThreadBranch,
    activeThread,
    beginLocalDispatch,
    activeEnvironmentUnavailable,
    isComposerConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetLocalDispatch,
    runtimeMode,
    setSendInFlight,
    autoOpenPlanSidebar,
    composerRef,
    environmentId,
  ]);

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!activeThread) return;
      // Look up the configured instance so model normalization and custom
      // model lookup stay scoped to that exact instance. Unknown instance ids
      // are rejected by returning early; the server remains authoritative too.
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      const resolvedDriverKind = entry?.driver ?? null;
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        scheduleComposerFocus();
        return;
      }
      if (lockedProvider !== null && activeThread.session?.providerInstanceId) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
        );
        if (
          currentEntry?.continuation?.groupKey &&
          entry?.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        ) {
          scheduleComposerFocus();
          return;
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        scheduleComposerFocus();
        return;
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
      };
      setComposerDraftModelSelection(
        scopeThreadRef(activeThread.environmentId, activeThread.id),
        nextModelSelection,
      );
      setStickyComposerModelSelection(nextModelSelection);
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (canOverrideServerThreadEnvMode) {
        setPendingServerThreadEnvMode(mode);
        scheduleComposerFocus();
        return;
      }
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, {
          envMode: mode,
          ...(mode === "worktree" && draftThread?.worktreePath ? { worktreePath: null } : {}),
        });
      }
      scheduleComposerFocus();
    },
    [
      canOverrideServerThreadEnvMode,
      composerDraftTarget,
      draftThread?.worktreePath,
      isLocalDraftThread,
      setPendingServerThreadEnvMode,
      scheduleComposerFocus,
      setDraftThreadContext,
    ],
  );

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  // Both the Map and the revert handler are read from refs at call-time so
  // the callback reference is fully stable and never busts context identity.
  const revertTurnCountRef = useRef(revertTurnCountByUserMessageId);
  revertTurnCountRef.current = revertTurnCountByUserMessageId;
  const onRevertToTurnCountRef = useRef(onRevertToTurnCount);
  onRevertToTurnCountRef.current = onRevertToTurnCount;
  const onRevertUserMessage = useCallback((messageId: MessageId) => {
    const targetTurnCount = revertTurnCountRef.current.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCountRef.current(targetTurnCount);
  }, []);

  // Empty state: no active thread
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  const shouldRenderPlanSidebar = planSidebarOpen && hasPlanSidebarContent;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      {/* Top bar */}
      <header
        className={cn(
          "border-b border-border",
          isElectron
            ? cn(
                "drag-region flex h-[52px] items-center px-3 sm:px-5 wco:h-[env(titlebar-area-height)]",
                reserveTitleBarControlInset &&
                  "wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              )
            : "pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-2 sm:pb-3 sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)] sm:pt-3",
        )}
      >
        <ChatHeader
          activeThreadEnvironmentId={activeThread.environmentId}
          activeThreadTitle={activeThread.title}
          activeProjectName={activeProject?.name}
          isGitRepo={isGitRepo}
          openInCwd={gitCwd}
          keybindings={keybindings}
          availableEditors={availableEditors}
          terminal={terminal}
          diffToggleShortcutLabel={diffPanelShortcutLabel}
          diffOpen={diffOpen}
          onToggleDiff={onToggleDiff}
        />
      </header>

      {/* Error banner */}
      <ProviderStatusBanner status={activeProviderStatus} />
      <ThreadErrorBanner
        error={activeThread.error}
        onDismiss={() => setThreadError(activeThread.id, null)}
      />
      {/* Main content area with optional plan sidebar */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Chat column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Messages Wrapper */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Messages — LegendList handles virtualization and scrolling internally */}
            <MessagesTimeline
              key={activeThread.id}
              isWorking={isWorking}
              activeTurnInProgress={isWorking || !latestTurnSettled}
              activeTurnId={activeLatestTurn?.turnId ?? null}
              activeTurnStartedAt={activeWorkStartedAt}
              listRef={legendListRef}
              timelineEntries={timelineEntries}
              historicalWorkLogSummariesByTurnId={historicalWorkLogSummariesByTurnId}
              completionDividerAfterEntryId={completionDividerAfterEntryId}
              completionSummary={completionSummary}
              activeThreadId={activeThread.id}
              activeThreadEnvironmentId={activeThread.environmentId}
              revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
              onRevertUserMessage={onRevertUserMessage}
              isRevertingCheckpoint={isRevertingCheckpoint}
              onImageExpand={onExpandTimelineImage}
              activeProvider={activeThread.session?.provider ?? null}
              markdownCwd={gitCwd ?? undefined}
              additionalWorkspaceRoots={activeProject?.additionalWorkspaceRoots ?? []}
              timestampFormat={timestampFormat}
              workspaceRoot={activeWorkspaceRoot}
              skills={activeProviderStatus?.skills ?? EMPTY_PROVIDER_SKILLS}
              stickToEndRevision={stickTimelineToEndRevision}
              onIsAtEndChange={onIsAtEndChange}
              onUserScrollIntent={onTimelineUserScrollIntent}
            />

            {/* scroll to bottom pill — shown when user has scrolled away from the bottom */}
            {showScrollToBottom && (
              <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
                <button
                  type="button"
                  onClick={() => scrollToEnd(true)}
                  className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
                >
                  <ChevronDownIcon className="size-3.5" />
                  Scroll to bottom
                </button>
              </div>
            )}
          </div>

          {/* Input bar */}
          <div
            className={cn(
              "pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-1.5 sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)] sm:pt-2",
              isGitRepo
                ? "pb-[calc(env(safe-area-inset-bottom)+0.25rem)]"
                : "pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:pb-[calc(env(safe-area-inset-bottom)+1rem)]",
            )}
          >
            <div className="relative isolate">
              <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
              <div className="relative z-10">
                <ChatComposer
                  composerRef={composerRef}
                  composerDraftTarget={composerDraftTarget}
                  environmentId={environmentId}
                  routeKind={routeKind}
                  routeThreadRef={routeThreadRef}
                  draftId={draftId}
                  activeThreadId={activeThreadId}
                  activeThreadEnvironmentId={activeThread?.environmentId}
                  activeThread={activeThread}
                  isServerThread={isServerThread}
                  isLocalDraftThread={isLocalDraftThread}
                  phase={phase}
                  isConnecting={isComposerConnecting}
                  isSendBusy={isSendBusy}
                  isPreparingWorktree={isPreparingWorktree}
                  environmentUnavailable={activeEnvironmentUnavailableState}
                  activePendingApproval={activePendingApproval}
                  pendingApprovals={pendingApprovals}
                  pendingUserInputs={pendingUserInputs}
                  activePendingProgress={activePendingProgress}
                  activePendingResolvedAnswers={activePendingResolvedAnswers}
                  activePendingIsResponding={activePendingIsResponding}
                  activePendingDraftAnswers={activePendingDraftAnswers}
                  activePendingQuestionIndex={activePendingQuestionIndex}
                  respondingRequestIds={respondingRequestIds}
                  showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                  activeProposedPlan={activeProposedPlan}
                  activePlan={activePlan as { turnId?: TurnId } | null}
                  sidebarProposedPlan={sidebarProposedPlan as { turnId?: TurnId } | null}
                  planSidebarLabel={planSidebarLabel}
                  planSidebarOpen={shouldRenderPlanSidebar}
                  runtimeMode={runtimeMode}
                  interactionMode={interactionMode}
                  lockedProvider={lockedProvider}
                  providerStatuses={providerStatuses as ServerProvider[]}
                  activeProjectDefaultModelSelection={activeProject?.defaultModelSelection}
                  activeThreadModelSelection={activeThread?.modelSelection}
                  activeThreadActivities={activeThread?.activities}
                  resolvedTheme={resolvedTheme}
                  settings={settings}
                  keybindings={keybindings}
                  gitCwd={gitCwd}
                  followUpQueueItems={followUpQueueViewItems}
                  steeringFollowUpItems={steeringFollowUpViewItems}
                  followUpQueueActionLabel={followUpQueueActionLabel}
                  followUpQueueActionTitle={followUpQueueActionTitle}
                  promptRef={promptRef}
                  composerImagesRef={composerImagesRef}
                  shouldAutoScrollRef={isAtEndRef}
                  scheduleStickToBottom={scrollToEnd}
                  onSend={onSend}
                  onSteer={onSteer}
                  onToggleFollowUpQueueItem={onToggleFollowUpQueueItem}
                  onActivateFollowUpQueueItem={onActivateFollowUpQueueItem}
                  onRemoveFollowUpQueueItem={onRemoveFollowUpQueueItem}
                  onClearFollowUpQueue={onClearFollowUpQueue}
                  onInterrupt={onInterrupt}
                  onImplementPlanInNewThread={onImplementPlanInNewThread}
                  onRespondToApproval={onRespondToApproval}
                  onSelectActivePendingUserInputOption={onSelectActivePendingUserInputOption}
                  onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                  onPreviousActivePendingUserInputQuestion={
                    onPreviousActivePendingUserInputQuestion
                  }
                  onChangeActivePendingUserInputCustomAnswer={
                    onChangeActivePendingUserInputCustomAnswer
                  }
                  onProviderModelSelect={onProviderModelSelect}
                  toggleInteractionMode={toggleInteractionMode}
                  handleRuntimeModeChange={handleRuntimeModeChange}
                  handleInteractionModeChange={handleInteractionModeChange}
                  togglePlanSidebar={togglePlanSidebar}
                  focusComposer={focusComposer}
                  scheduleComposerFocus={scheduleComposerFocus}
                  setThreadError={setThreadError}
                  onExpandImage={onExpandTimelineImage}
                />
              </div>
            </div>
            {isGitRepo && (
              <BranchToolbar
                environmentId={activeThread.environmentId}
                threadId={activeThread.id}
                {...(routeKind === "draft" && draftId ? { draftId } : {})}
                onEnvModeChange={onEnvModeChange}
                {...(canOverrideServerThreadEnvMode ? { effectiveEnvModeOverride: envMode } : {})}
                {...(canOverrideServerThreadEnvMode
                  ? {
                      activeThreadBranchOverride: activeThreadBranch,
                      onActiveThreadBranchOverrideChange: setPendingServerThreadBranch,
                    }
                  : {})}
                envLocked={envLocked}
                onComposerFocusRequest={scheduleComposerFocus}
                {...(canCheckoutPullRequestIntoThread
                  ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                  : {})}
                {...(hasMultipleEnvironments ? { onEnvironmentChange } : {})}
                availableEnvironments={logicalProjectEnvironments}
              />
            )}
          </div>

          {pullRequestDialogState ? (
            <PullRequestThreadDialog
              key={pullRequestDialogState.key}
              open
              environmentId={activeThread.environmentId}
              threadId={activeThread.id}
              cwd={activeProject?.cwd ?? null}
              initialReference={pullRequestDialogState.initialReference}
              onOpenChange={(open) => {
                if (!open) {
                  closePullRequestDialog();
                }
              }}
              onPrepared={handlePreparedPullRequestThread}
            />
          ) : null}
        </div>
        {/* end chat column */}

        {/* Plan sidebar */}
        {shouldRenderPlanSidebar && !shouldUsePlanSidebarSheet ? (
          <PlanSidebar
            activePlan={activePlan}
            activeProposedPlan={sidebarProposedPlan}
            label={planSidebarLabel}
            environmentId={environmentId}
            markdownCwd={gitCwd ?? undefined}
            workspaceRoot={activeWorkspaceRoot}
            timestampFormat={timestampFormat}
            mode="sidebar"
            onClose={closePlanSidebar}
          />
        ) : null}
      </div>
      {/* end horizontal flex container */}

      {shouldUsePlanSidebarSheet && hasPlanSidebarContent ? (
        <RightPanelSheet open={shouldRenderPlanSidebar} onClose={closePlanSidebar}>
          <PlanSidebar
            activePlan={activePlan}
            activeProposedPlan={sidebarProposedPlan}
            label={planSidebarLabel}
            environmentId={environmentId}
            markdownCwd={gitCwd ?? undefined}
            workspaceRoot={activeWorkspaceRoot}
            timestampFormat={timestampFormat}
            mode="sheet"
            onClose={closePlanSidebar}
          />
        </RightPanelSheet>
      ) : null}

      {expandedImage && (
        <ExpandedImageDialog preview={expandedImage} onClose={closeExpandedImage} />
      )}
    </div>
  );
}
