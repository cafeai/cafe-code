import {
  type ApprovalRequestId,
  type CodexReviewTarget,
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type DesktopRendererDebugSnapshot,
  MessageId,
  CommandId,
  EventId,
  type ModelSelection,
  type ProjectId,
  type ProviderApprovalDecision,
  type ProviderInteractionResponse,
  ProviderInstanceId,
  type ServerProvider,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  ProviderDriverKind,
  RuntimeMode,
  type SubagentLimits,
  SubagentRuntimeId,
  type UploadChatAttachment as OrchestrationUploadChatAttachment,
} from "@cafecode/contracts";
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@cafecode/client-runtime";
import {
  applyClaudePromptEffortPrefix,
  createModelSelection,
  resolvePromptInjectedEffort,
  modelAcceptsImages,
  UNSUPPORTED_MODEL_IMAGES_MESSAGE,
} from "@cafecode/shared/model";

import { truncate } from "@cafecode/shared/String";
import { CLAUDE_SHORTER_CONTINUATION_PROMPT } from "@cafecode/shared/claudeResponseLimits";
import { Debouncer } from "@tanstack/react-pacer";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useGitStatus } from "~/lib/gitStatusState";
import { supportsStandaloneChats } from "../lib/standaloneChats";
import { subagentConcurrencyAdmissionError } from "../lib/subagentConcurrencyAdmission";
import {
  getSavedEnvironmentRuntimeState,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime/catalog";
import {
  configuredInstanceSubagentLimit,
  deriveSubagentConcurrencyPresentation,
  subagentLimitKey,
  validSubagentLimit,
} from "../subagentConcurrency";
import { useDesktopDebugEnabled } from "~/lib/desktopDebugState";
import { useWorkspaceProjects, useWorkspaceThreads } from "../environments/workspaceData";
import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import { getWsConnectionStatus, useWsConnectionStatus } from "../rpc/wsConnectionState";
import { providerSkillsScopeRevision } from "./chat/useProviderSkills";
import type { ProviderQuotaContext } from "./chat/useProviderQuota";
import { selectedQuotaDriver } from "../lib/claudeSessionQuota";
import { readEnvironmentApi } from "../environmentApi";
import { getWorkspaceServerConfig } from "../environments/workspaceApi";
import { MessageForkDialog } from "./chat/MessageForkDialog";
import { isElectron } from "../env";
import { useMacDesktopTitlebar } from "../hooks/useMacDesktopTitlebar";
import { readLocalApi } from "../localApi";
import {
  collapseExpandedComposerCursor,
  parseComposerCompactionCommand,
  parseStandaloneComposerGoalCommand,
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
  deriveActiveSubagentWorkEntries,
  deriveWorkLogEntries,
  deriveSubagentWorkEntries,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  formatElapsed,
  type WorkLogEntry,
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
  selectThreadByRef,
  selectThreadDetailHydratedByRef,
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
import { useHasOnScreenKeyboard, useIsMobile, useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { deriveLatestContextWindowSnapshot } from "../lib/contextWindow";
import { shouldSurfaceProviderAccountRateLimits } from "../lib/codexRateLimits";
import { BranchToolbar } from "./BranchToolbar";
import { resolveShortcutCommand } from "../keybindings";
import PlanSidebar from "./PlanSidebar";
import { SessionRail } from "./chat/SessionRail";
import { ComposerAsyncQuestionsPanel } from "./chat/ComposerAsyncQuestionsPanel";
import { persistExactAsyncQuestionAnswer, type AsyncQuestion } from "./chat/asyncQuestions";
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { newCommandId, newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import {
  claimMessageFork,
  messageForkAdmissionKey,
  useMessageForkAdmission,
} from "../lib/messageForkAdmission";
import { getProviderModelCapabilities, resolveSelectableProvider } from "../providerModels";
import { useSettings } from "../hooks/useSettings";
import { getWsConnectionDiagnostics } from "../rpc/wsConnectionState";
import { getUsageStatsDetailDiagnostics } from "./stats/usageStatsDetailResource";
import { getDictationDiagnosticSnapshot } from "../dictation/diagnostics";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildDraftThreadRouteParams } from "../threadRoutes";
import {
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  flushComposerDraftPersistence,
  type DraftId,
} from "../composerDraftStore";
import {
  ChatComposer,
  type ChatComposerHandle,
  type FollowUpQueueViewItem,
  type SteeringFollowUpViewItem,
} from "./chat/ChatComposer";
import { readyComposerFiles, composerFileFromAttachment } from "../attachments/composerFiles";
import {
  createFollowUpQueuePersistence,
  type FollowUpQueueClaim,
} from "./chat/followUpQueuePersistence";
import {
  canAutoStartQueuedFollowUpTurn,
  canDispatchRunningQueuedFollowUp,
  canExpandQueuedFollowUpText,
  canStartQueuedFollowUpTurn,
  canSteerPriorityToSession,
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
import type { SubagentDetailSelection } from "./chat/SubagentDetailView";
import { useTaskAtriumStore } from "./atrium/taskAtriumStore";
import {
  isTimelineScrolledToEnd,
  shouldPreserveTimelineScrollReviewIntent,
} from "./chat/MessagesTimeline.helpers";
import { ChatHeader } from "./chat/ChatHeader";
import { type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import {
  ThreadGoalDialog,
  type ThreadGoalDialogMode,
  type ThreadGoalSetPatch,
} from "./chat/ThreadGoalControl";
import { NoActiveThreadState } from "./NoActiveThreadState";
import { resolveEffectiveEnvMode, resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { ProviderStatusBanner } from "./chat/ProviderStatusBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import {
  captureClaudeResponseLimitFailure,
  isClaudeContinuationDraftEmpty,
  isClaudeResponseLimitFailureCurrent,
} from "./chat/claudeResponseLimitRecovery";
import { useThreadActions } from "../hooks/useThreadActions";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import {
  buildLocalDraftThread,
  canRetryLegacyCodexRootCompletion,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveRetryableSteerReplayCandidates,
  deriveComposerSendState,
  doesSteerFailureActivityMatchPending,
  doesSteerProcessingActivityMatchPending,
  hasServerAcknowledgedLocalDispatch,
  isSteerProcessingActivityTimely,
  type LocalDispatchSnapshot,
  type LegacyRootCompletionRetry,
  PullRequestDialogState,
  cloneComposerImageForRetry,
  deriveLockedProvider,
  mergePendingSteerSnapshotsForInterruptedTurn,
  readDeliveredSteerMessageId,
  readRecoveredSteerMessageId,
  readFileAsDataUrl,
  readSteerProcessingMessageId,
  restoreCanonicalRetryImages,
  resolveFollowUpQueuePhase,
  resolveSendEnvMode,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  shouldResolvePendingSteerDispatch,
  shouldBackpressurePendingSteerDispatch,
  shouldPinTimelineToEndForLocalMessage,
  shouldWriteThreadErrorToCurrentServerThread,
  waitForStartedServerThread,
} from "./ChatView.logic";
import { useComposerHandleContext } from "../composerHandleContext";
import type { TimelineViewPosition } from "./chat/timelineViewState";
import {
  useChatPane,
  useChatPaneQueueOwnership,
  useChatPaneResource,
  useChatPaneSharedState,
  useHasSharedChatRuntime,
} from "../chatPaneContext";
import {
  useServerAvailableEditors,
  useServerConfig,
  getServerConfig,
  useServerKeybindings,
  useServerTerminal,
} from "~/rpc/serverState";
import {
  describeSendFailureMessage,
  isIndeterminateTransportError,
  sanitizeThreadErrorMessage,
} from "~/rpc/transportError";
import { retainThreadDetailSubscription } from "../environments/runtime/service";
import { requireEnvironmentConnection } from "../environments/runtime";
import { ProviderUsageResetButton } from "./ProviderUsageResetButton";
import { RightPanelSheet } from "./RightPanelSheet";
import { deriveDebugWaitReasons } from "./chat/debugWaitReasons";
import { summarizeProviderDebugFleet } from "./chat/providerDebugSummary";
import {
  summarizeTimelineScrollMetrics,
  type TimelineScrollDebugEvent,
  type TimelineScrollDebugEventInput,
  type TimelineScrollDebugSnapshot,
} from "./chat/timelineScrollDebug";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
} from "../versionSkew";

import {
  DEBUG_SNAPSHOT_VERSION,
  DEBUG_RECENT_MESSAGE_LIMIT,
  DEBUG_RECENT_ACTIVITY_LIMIT,
  DEBUG_RECENT_RUNTIME_EVENT_LIMIT,
  DEBUG_INTERESTING_THREAD_LIMIT,
  DEBUG_THREAD_DETAIL_MESSAGE_LIMIT,
  DEBUG_THREAD_DETAIL_ACTIVITY_LIMIT,
  DEBUG_RENDERER_HEARTBEAT_INTERVAL_MS,
  DEBUG_RENDERER_SNAPSHOT_MIN_INTERVAL_MS,
  DEBUG_TIMELINE_SCROLL_EVENT_LIMIT,
  readDebugRecord,
  readDebugString,
  threadHasActiveContextCompaction,
  countBy,
  roundDebugMs,
  summarizeDebugMessage,
  summarizeDebugActivity,
  summarizeDebugTurnDiff,
  summarizeDebugThreadLifecycle,
  summarizeDebugThreadPerformance,
  summarizeDebugNotableThread,
} from "./chat/chatDebugSummary";

const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const FILE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached files without additional text. Use the conversation context and the attached file copies.]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROPOSED_PLANS: Thread["proposedPlans"] = [];
const TIMELINE_USER_SCROLL_INTENT_SETTLE_MS = 250;

interface ThreadGoalDialogRequest {
  readonly open: boolean;
  readonly revision: number;
  readonly mode: ThreadGoalDialogMode;
  readonly seedObjective: string | null;
  readonly confirmReplacement: boolean;
}

const CLOSED_THREAD_GOAL_DIALOG: ThreadGoalDialogRequest = {
  open: false,
  revision: 0,
  mode: "summary",
  seedObjective: null,
  confirmReplacement: false,
};

const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_ADDITIONAL_WORKSPACE_ROOTS: ReadonlyArray<string> = [];
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

function useThreadPlanCatalog(
  environmentId: EnvironmentId,
  threadIds: readonly ThreadId[],
): ThreadPlanCatalogEntry[] {
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

          for (const environmentState of [state.environmentStateById[environmentId]]) {
            if (!environmentState) continue;
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
    }, [environmentId, threadIds]),
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
type ChatViewProps = {
  readonly navigationSlot?: ((controls: ReactNode) => ReactNode) | undefined;
} & (
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      routeKind: "draft";
      draftId: DraftId;
    }
);

interface ComposerSendSnapshot {
  readonly deliveryPriority?: import("@cafecode/contracts").ProviderDeliveryPriority;
  readonly subagentLimits?: SubagentLimits;
  promptText: string;
  images: ComposerImageAttachment[];
  files: import("@cafecode/contracts").ChatFileAttachment[];
  provider: ProviderDriverKind;
  model: string | null;
  providerModels: ReadonlyArray<ServerProvider["models"][number]>;
  promptEffort: string | null;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
}

/** Read capability authority at admission, never from a captured picker snapshot. */
function readSubagentConcurrencyAdmissionError(input: {
  readonly environmentId: EnvironmentId;
  readonly modelSelection: ModelSelection;
  readonly provider: ProviderDriverKind;
  readonly limits: SubagentLimits | undefined;
}): string | null {
  const primary = getServerConfig();
  const configuration =
    primary?.environment.environmentId === input.environmentId
      ? primary
      : getSavedEnvironmentRuntimeState(input.environmentId)?.serverConfig;
  return subagentConcurrencyAdmissionError({
    environmentId: input.environmentId,
    instanceId: input.modelSelection.instanceId,
    provider: input.provider,
    limits: input.limits,
    configuration,
  });
}

interface FollowUpQueueItem extends ComposerSendSnapshot {
  id: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  queuedAt: string;
  expanded: boolean;
  blockedReason: string | null;
  dispatchState?: "pending" | "claimed";
  claimedDispatch?: { readonly commandId: CommandId; readonly messageId: MessageId };
  automaticSteerRetry?: {
    readonly nonSteerableTurnKind: CodexNonSteerableTurnKind | null;
    readonly sourceMessageId: MessageId;
    readonly legacyRootCompletionRetry?: LegacyRootCompletionRetry;
    /** Only an explicit retry may clear a settled dispatch failure. */
    readonly dispatchFailed?: true;
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
  readonly intentSequence: number | null;
}

interface PendingSteerInterruptRecovery {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly interruptedTurnId: TurnId | null;
  readonly pendingMessageIds: readonly MessageId[];
  readonly requestedAt: string;
}

interface ManualStopBarrier {
  readonly threadId: ThreadId;
  readonly interruptedTurnId: TurnId | null;
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

function isAutomaticSteerRetryItem(item: FollowUpQueueItem): boolean {
  return item.automaticSteerRetry != null;
}

function resolveAutomaticSteerRetryBlocker(input: {
  readonly item: FollowUpQueueItem;
  readonly thread: Thread;
  readonly phase: SessionPhase;
}): "context-compaction-active" | "provider-steer-rejected" | "review-active-turn" | null {
  const retry = input.item.automaticSteerRetry ?? null;
  if (retry === null) {
    return null;
  }

  // A generic provider rejection is retryable only as the next turn. Retrying
  // it while the same turn is still active would immediately call the same
  // rejected extension again and could spin an unbounded steer/requeue loop.
  if (retry.nonSteerableTurnKind === null) {
    if (
      input.phase === "running" &&
      !threadHasActiveContextCompaction(input.thread, input.thread.session?.activeTurnId ?? null) &&
      canRetryLegacyCodexRootCompletion({
        thread: input.thread,
        retry: retry.legacyRootCompletionRetry,
      })
    ) {
      return null;
    }
    return input.phase === "running" ? "provider-steer-rejected" : null;
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

function readSteerRecoveryMessageId(activity: OrchestrationThreadActivity): MessageId | null {
  const messageId =
    readRecoveredSteerMessageId({
      activityKind: activity.kind,
      payload: activity.payload,
    }) ??
    readDeliveredSteerMessageId({
      activityKind: activity.kind,
      payload: activity.payload,
    });
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

function threadHasSteerFailureForPending(thread: Thread, pending: PendingSteerDispatch) {
  return thread.activities.some((activity) =>
    doesSteerFailureActivityMatchPending({
      activity,
      pendingMessageId: pending.messageId,
      pendingIntentSequence: pending.intentSequence,
      dispatchedAt: pending.dispatchedAt,
    }),
  );
}

function threadHasSteerRecoveryForMessage(thread: Thread, messageId: MessageId) {
  return thread.activities.some((activity) => readSteerRecoveryMessageId(activity) === messageId);
}

function threadHasSteerProcessingStarted(thread: Thread, pending: PendingSteerDispatch) {
  return thread.activities.some((activity) => {
    if (activity.kind !== "task.progress") {
      return false;
    }

    const payload = readDebugRecord(activity.payload);
    const taskId = readDebugString(payload?.taskId);
    const description = readDebugString(payload?.description);
    const detail = readDebugString(payload?.detail);
    const isSteerProcessingActivity =
      taskId?.startsWith("codex-turn-steer-processing:") === true ||
      description === "Codex app-server began processing turn/steer." ||
      detail === "Codex app-server began processing turn/steer.";
    if (!isSteerProcessingActivity) {
      return false;
    }
    const processingMessageId = readSteerProcessingMessageId(payload);
    if (
      !isSteerProcessingActivityTimely({
        processingMessageId,
        activityCreatedAt: activity.createdAt,
        dispatchedAt: pending.dispatchedAt,
      })
    ) {
      return false;
    }
    // Codex can ACK a turn/start or steer against Cafe's provisional active
    // turn id, then report the concrete app-server active turn under a
    // different id. The backend repairs that projection, but the renderer may
    // still be holding an older pending-steer marker from before the repair.
    // Treat the explicit Codex steer-processing marker as enough to clear that
    // marker when it lands on the current provider-owned turn for the same
    // thread; unrelated task.progress rows still cannot clear it.
    const legacyTurnMatches =
      pending.turnId === null ||
      activity.turnId === pending.turnId ||
      (thread.session?.provider === "codex" &&
        activity.turnId !== null &&
        (activity.turnId === thread.session.activeTurnId ||
          activity.turnId === thread.latestTurn?.turnId));

    return doesSteerProcessingActivityMatchPending({
      pendingMessageId: pending.messageId,
      processingMessageId,
      legacyTurnMatches,
    });
  });
}

function threadHasResolvedPendingSteer(thread: Thread, pending: PendingSteerDispatch) {
  return shouldResolvePendingSteerDispatch({
    provider: thread.session?.provider,
    terminalTurnAfterSteer: threadHasTerminalTurnAfterSteer(thread, pending),
    steerProcessingStarted: threadHasSteerProcessingStarted(thread, pending),
    steerFailureRecorded: threadHasSteerFailureForPending(thread, pending),
    steerRecoveryRecorded: threadHasSteerRecoveryForMessage(thread, pending.messageId),
    assistantResponseAfterSteer: threadHasAssistantResponseAfterSteer(thread, pending),
  });
}

function revokeQueuedFollowUpPreviewUrls(item: FollowUpQueueItem): void {
  for (const image of item.images) {
    revokeBlobPreviewUrl(image.previewUrl);
  }
}

function optimisticAttachmentsForSnapshot(snapshot: ComposerSendSnapshot) {
  return [
    ...snapshot.images.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    })),
    ...snapshot.files,
  ];
}

async function buildAttachmentsForSnapshot(
  snapshot: ComposerSendSnapshot,
): Promise<OrchestrationUploadChatAttachment[]> {
  return [
    ...(await Promise.all(
      snapshot.images.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    )),
    ...snapshot.files,
  ];
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
  const { environmentId, threadId, routeKind } = props;
  const pane = useChatPane();
  const currentPaneRef = useRef(pane);
  currentPaneRef.current = pane;
  const { continueInNewChat } = useThreadActions();
  const onContinueInNewChat = useCallback(async () => {
    if (routeKind !== "server") return;
    await continueInNewChat(
      scopeThreadRef(environmentId, threadId),
      () => currentPaneRef.current.active && currentPaneRef.current.visible,
    );
  }, [continueInNewChat, environmentId, routeKind, threadId]);
  const sharedChatRuntime = useHasSharedChatRuntime();
  const { owns: ownsQueuedThread, revision: queueOwnershipRevision } = useChatPaneQueueOwnership(
    environmentId,
    threadId,
  );
  const runtimeKey = `chat-runtime:${environmentId}:`;
  const draftId = routeKind === "draft" ? props.draftId : null;
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef]);
  const timelineViews = useChatPaneResource(
    "timeline-views",
    () => new Map<string, TimelineViewPosition>(),
  );
  const initialTimelinePosition = useMemo(
    () => timelineViews.get(routeThreadKey) ?? null,
    [timelineViews, routeThreadKey],
  );
  const composerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  const serverThread = useStore(
    useMemo(
      () => createThreadSelectorByRef(routeKind === "server" ? routeThreadRef : null),
      [routeKind, routeThreadRef],
    ),
  );
  const serverThreadDetailHydrated = useStore((store) =>
    routeKind === "server" ? selectThreadDetailHydratedByRef(store, routeThreadRef) : true,
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
  const globalSessionRailDocked = useUiStateStore((store) => store.sessionRailDocked);
  const setGlobalSessionRailDocked = useUiStateStore((store) => store.setSessionRailDocked);
  const sessionRailDocked = pane.sessionRailDocked ?? globalSessionRailDocked;
  const setSessionRailDocked = pane.onSessionRailDockedChange ?? setGlobalSessionRailDocked;
  const settings = useSettings();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const autoOpenPlanSidebar = settings.autoOpenPlanSidebar;
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  // Granular store selectors — avoid subscribing to prompt changes.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerSubagentLimits = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.subagentLimits,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const restoreComposerDraftContentIfEmpty = useComposerDraftStore(
    (store) => store.restoreComposerContentIfEmpty,
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
  const queueEditingItemId = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.queueEditingItemId,
  );
  // A Boolean selector changes only when eligibility changes, keeping ordinary
  // composer keystrokes off this large chat view's render path.
  const shorterContinuationDraftEmpty = useComposerDraftStore((store) =>
    isClaudeContinuationDraftEmpty(store.getComposerDraft(composerDraftTarget)),
  );
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const activeComposerHandle = useComposerHandleContext();
  // Every pane owns its editor. Only the active pane publishes an alias for the
  // global palette; sharing the actual ref lets a sibling send the wrong draft.
  const composerRef = localComposerRef;
  useLayoutEffect(() => {
    if (!pane.active || !pane.visible || !activeComposerHandle) return;
    const handle = composerRef.current;
    activeComposerHandle.current = handle;
    return () => {
      if (activeComposerHandle.current === handle) activeComposerHandle.current = null;
    };
  });
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [timelineAutoFollowTail, setTimelineAutoFollowTail] = useState(
    initialTimelinePosition?.following ?? true,
  );
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [selectedSubagent, setSelectedSubagent] = useState<SubagentDetailSelection | null>(null);
  const selectedSubagentTriggerRef = useRef<HTMLButtonElement | null>(null);
  const taskAtriumOpen = useTaskAtriumStore((state) => state.open);
  const [threadGoalDialog, setThreadGoalDialog] =
    useState<ThreadGoalDialogRequest>(CLOSED_THREAD_GOAL_DIALOG);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const [stickTimelineToEndRevision, setStickTimelineToEndRevision] = useState(0);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const optimisticUserMessagesOwnerThreadKeyRef = useRef(routeThreadKey);
  const currentRouteThreadKeyRef = useRef(routeThreadKey);
  currentRouteThreadKeyRef.current = routeThreadKey;
  const chatViewMountedRef = useRef(false);
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, string | null>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const snoozedUserInputRequestIdsRef = useRef<Set<string>>(new Set());
  const [snoozedUserInputRequestIds, setSnoozedUserInputRequestIds] = useState<ApprovalRequestId[]>(
    [],
  );
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [draftPlanSidebarOpenByThreadKey, setDraftPlanSidebarOpenByThreadKey] = useState<
    Record<string, boolean>
  >({});
  const viewportNeedsPlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const paneElementRef = useRef<HTMLDivElement | null>(null);
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const shouldUsePlanSidebarSheet =
    sharedChatRuntime && paneWidth !== null ? paneWidth <= 980 : viewportNeedsPlanSidebarSheet;
  const isMobile = useIsMobile();
  const isMacDesktopTitlebar = useMacDesktopTitlebar();
  const hasOnScreenKeyboard = useHasOnScreenKeyboard();
  const draftPlanSidebarOpen =
    routeKind === "draft" ? draftPlanSidebarOpenByThreadKey[routeThreadKey] : undefined;
  const planSidebarOpenPreference =
    routeKind === "server" ? persistedPlanSidebarOpen : draftPlanSidebarOpen;
  const planSidebarOpen = planSidebarOpenPreference === true;
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
  const timelineUserScrollIntentSettleUntilMsRef = useRef(0);
  const timelineUserScrollIntentSettleTimeoutRef = useRef<number | null>(null);
  const timelineForcedScrollGenerationRef = useRef(0);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  const sendInFlightByThread = useChatPaneResource(
    `${runtimeKey}send-gates`,
    () => new Map<string, { current: boolean }>(),
  );
  const sendInFlightRef = useMemo(() => {
    const existing = sendInFlightByThread.get(threadId);
    if (existing) return existing;
    const gate = { current: false };
    sendInFlightByThread.set(threadId, gate);
    return gate;
  }, [sendInFlightByThread, threadId]);
  const directSendFailureToastIdByThreadKeyRef = useRef<
    Map<string, ReturnType<typeof toastManager.add>>
  >(new Map());
  const queueDispatchInFlightRef = useChatPaneResource(`${runtimeKey}queue-io`, () => ({
    current: false,
  }));
  const [
    pendingSteerDispatchByMessageId,
    setPendingSteerDispatchByMessageId,
    pendingSteerDispatchByMessageIdRef,
  ] = useChatPaneSharedState<Record<string, PendingSteerDispatch>>(
    `${runtimeKey}steers`,
    () => ({}),
  );
  // Durable retryable-failure activities can outlive this component. Track
  // which source messages this mount has already reconstructed or explicitly
  // dismissed so snapshot refreshes remain idempotent, while a real reload can
  // rebuild unresolved entries from canonical thread state again.
  const handledRetryableSteerSourceMessageIdsRef = useChatPaneResource(
    `${runtimeKey}handled-retries`,
    () => ({ current: new Set<string>() }),
  );
  const legacyRootRecheckSourceMessageIdsRef = useChatPaneResource(
    `${runtimeKey}legacy-retries`,
    () => ({ current: new Set<string>() }),
  );
  const retryableSteerReconstructionInFlightRef = useChatPaneResource(
    `${runtimeKey}retry-io`,
    () => ({ current: new Set<string>() }),
  );
  const [
    pendingSteerInterruptRecoveryByThreadId,
    setPendingSteerInterruptRecoveryByThreadId,
    pendingSteerInterruptRecoveryByThreadIdRef,
  ] = useChatPaneSharedState<Record<string, PendingSteerInterruptRecovery>>(
    `${runtimeKey}recoveries`,
    () => ({}),
  );
  // The main Stop control is not the queue row's interrupt-and-submit action.
  // Keep recovered and ordinary queued input available, but prevent the queue
  // watchdog from converting a user cancellation into a fresh provider turn.
  const manualStopBarrierByThreadIdRef = useChatPaneResource(`${runtimeKey}stops`, () => ({
    current: {} as Record<string, ManualStopBarrier>,
  }));
  const manualStopGenerationByThreadIdRef = useChatPaneResource(
    `${runtimeKey}stop-generations`,
    () => ({
      current: {} as Record<string, number>,
    }),
  );
  const debugEnabled = useDesktopDebugEnabled();
  const desktopDebugEnabled = debugEnabled && pane.active && pane.visible;
  const [desktopDebugRevision, setDesktopDebugRevision] = useState(0);
  const lastDesktopDebugSnapshotPublishedAtMsRef = useRef(0);
  const desktopDebugSnapshotThrottleTimeoutRef = useRef<number | null>(null);
  const timelineScrollDebugSequenceRef = useRef(0);
  const timelineScrollDebugEventsRef = useRef<TimelineScrollDebugEvent[]>([]);
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
  const setSendInFlight = useCallback(
    (next: boolean) => {
      if (sendInFlightRef.current === next) return;
      sendInFlightRef.current = next;
      setDispatchGateRevision((revision) => revision + 1);
    },
    [sendInFlightRef],
  );
  const setQueueDispatchInFlight = useCallback(
    (next: boolean) => {
      if (queueDispatchInFlightRef.current === next) return;
      queueDispatchInFlightRef.current = next;
      setDispatchGateRevision((revision) => revision + 1);
    },
    [queueDispatchInFlightRef],
  );
  useEffect(() => {
    chatViewMountedRef.current = true;
    return () => {
      chatViewMountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    // Toasts live in the root provider, while the IDs that let a successful
    // retry retire them belong to this ChatView. Close the scoped occurrence
    // when its route leaves so global toast state cannot outlive its owner or
    // reappear when another environment later reuses the same ThreadId.
    const failureToastIds = directSendFailureToastIdByThreadKeyRef.current;
    return () => {
      const toastId = failureToastIds.get(routeThreadKey);
      if (toastId === undefined) return;
      failureToastIds.delete(routeThreadKey);
      toastManager.close(toastId);
    };
  }, [routeThreadKey]);
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
    [desktopDebugEnabled, pendingSteerDispatchByMessageIdRef, setPendingSteerDispatchByMessageId],
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
    [
      desktopDebugEnabled,
      pendingSteerInterruptRecoveryByThreadIdRef,
      setPendingSteerInterruptRecoveryByThreadId,
    ],
  );
  const updateManualStopBarrier = useCallback(
    (threadId: ThreadId, barrier: ManualStopBarrier | null) => {
      const current = manualStopBarrierByThreadIdRef.current;
      if (barrier === null) {
        if (!(threadId in current)) {
          return;
        }
        const next = { ...current };
        delete next[threadId];
        manualStopBarrierByThreadIdRef.current = next;
      } else {
        manualStopBarrierByThreadIdRef.current = {
          ...current,
          [threadId]: barrier,
        };
      }
      // A later explicit resume may remove the barrier, but must not revive
      // pre-Stop asynchronous preparation from an older send attempt.
      manualStopGenerationByThreadIdRef.current[threadId] =
        (manualStopGenerationByThreadIdRef.current[threadId] ?? 0) + 1;
      if (desktopDebugEnabled) {
        setDesktopDebugRevision((revision) => revision + 1);
      }
    },
    [desktopDebugEnabled, manualStopBarrierByThreadIdRef, manualStopGenerationByThreadIdRef],
  );
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
  const dispatchFollowUpTurnStartRef = useRef<
    ((item: FollowUpQueueItem, options?: { independentAnswer?: boolean }) => Promise<void>) | null
  >(null);
  const dispatchQueuedSteerRetryRef = useRef<((item: FollowUpQueueItem) => Promise<void>) | null>(
    null,
  );
  const queuePersistence = useChatPaneResource(
    `${runtimeKey}persistence`,
    createFollowUpQueuePersistence,
  );
  const initialQueueLoadErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialQueueLoadErrorRef.current)
      toastManager.add({
        type: "error",
        title: "Queue could not be restored",
        description: initialQueueLoadErrorRef.current,
      });
  }, []);
  const [followUpQueueByThreadId, setFollowUpQueueState, followUpQueueByThreadIdRef] =
    useChatPaneSharedState<Record<string, FollowUpQueueItem[]>>(
      `${runtimeKey}queues`,
      () => {
        const loaded = queuePersistence.load(environmentId);
        if (!loaded.ok) {
          initialQueueLoadErrorRef.current = loaded.error;
          return {};
        }
        const result: Record<string, FollowUpQueueItem[]> = {};
        for (const item of [...loaded.value.pending, ...loaded.value.claimed])
          (result[item.threadId] ??= []).push(item);
        return result;
      },
      (queues) => {
        // Shared queue previews belong to the layout runtime, not whichever tab
        // happens to be selected. Closing a pane must not revoke another pane's image.
        for (const items of Object.values(queues)) {
          for (const item of items) revokeQueuedFollowUpPreviewUrls(item);
        }
      },
    );
  const queuePersistenceTailRef = useChatPaneResource(`${runtimeKey}persistence-tail`, () => ({
    current: Promise.resolve() as Promise<unknown>,
  }));
  const persistFollowUpQueues = useCallback(
    (targetEnvironmentId: EnvironmentId, queues: Record<string, FollowUpQueueItem[]>) => {
      const entries = Object.values(queues)
        .flat()
        .filter((item) => item.environmentId === targetEnvironmentId);
      const operation = queuePersistenceTailRef.current.then(() =>
        queuePersistence.save(targetEnvironmentId, entries),
      );
      queuePersistenceTailRef.current = operation;
      return operation;
    },
    [queuePersistence, queuePersistenceTailRef],
  );
  const setFollowUpQueueByThreadId = useCallback(
    (
      update: (current: Record<string, FollowUpQueueItem[]>) => Record<string, FollowUpQueueItem[]>,
    ) => {
      const next = update(followUpQueueByThreadIdRef.current);
      // Dispatch and edit admission read this ref synchronously, not React's
      // next paint. A row cannot be claimed twice in the same event window.
      followUpQueueByThreadIdRef.current = next;
      setFollowUpQueueState(next);
    },
    [followUpQueueByThreadIdRef, setFollowUpQueueState],
  );
  const loadedQueueEnvironmentsRef = useChatPaneResource(`${runtimeKey}loaded`, () => ({
    current: new Set([environmentId]),
  }));
  useEffect(() => {
    if (loadedQueueEnvironmentsRef.current.has(environmentId)) return;
    loadedQueueEnvironmentsRef.current.add(environmentId);
    const loaded = queuePersistence.load(environmentId);
    if (!loaded.ok) {
      toastManager.add({
        type: "error",
        title: "Queue could not be restored",
        description: loaded.error,
      });
      return;
    }
    setFollowUpQueueByThreadId((existing) => {
      const next = { ...existing };
      for (const item of [...loaded.value.pending, ...loaded.value.claimed])
        next[item.threadId] = [
          ...(next[item.threadId] ?? []).filter((entry) => entry.id !== item.id),
          item,
        ];
      return next;
    });
  }, [environmentId, queuePersistence, setFollowUpQueueByThreadId, loadedQueueEnvironmentsRef]);
  const [
    queuedFollowUpPendingDispatchByThreadId,
    setQueuedFollowUpPendingDispatchByThreadId,
    queuedFollowUpPendingDispatchByThreadIdRef,
  ] = useChatPaneSharedState<Record<string, QueuedFollowUpPendingDispatch>>(
    `${runtimeKey}pending-queue`,
    () => ({}),
  );
  const desktopDebugEnabledRef = useRef(desktopDebugEnabled);
  desktopDebugEnabledRef.current = desktopDebugEnabled;

  const fallbackDraftProjectRef = draftThread?.projectId
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
  const canCheckoutPullRequestIntoThread = isLocalDraftThread && activeThread?.projectId != null;
  // Catalog and diagnostics belong to this pane's server, including when
  // another server has imported the same project or thread IDs.
  const allProjects = useWorkspaceProjects(environmentId);
  const allThreads = useWorkspaceThreads(environmentId);
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
    // The old single-route migration guessed that one orphan queue belonged to
    // the newly opened chat. In a Desk that can silently retarget another tab's
    // input. Draft promotion retains its explicit thread identity; unknown rows
    // stay attached to their original identity instead of guessing a recipient.
    if (sharedChatRuntime) return;
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
  }, [activeThreadId, knownThreadIds, setFollowUpQueueByThreadId, sharedChatRuntime]);
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
    [queuedFollowUpPendingDispatchByThreadIdRef, setQueuedFollowUpPendingDispatchByThreadId],
  );
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const recordTimelineScrollDebugEvent = useCallback((input: TimelineScrollDebugEventInput) => {
    if (!desktopDebugEnabledRef.current) {
      return;
    }

    const event: TimelineScrollDebugEvent = {
      ...input,
      sequence: timelineScrollDebugSequenceRef.current + 1,
      capturedAt: new Date().toISOString(),
    };
    timelineScrollDebugSequenceRef.current = event.sequence;
    timelineScrollDebugEventsRef.current = [
      ...timelineScrollDebugEventsRef.current.slice(1 - DEBUG_TIMELINE_SCROLL_EVENT_LIMIT),
      event,
    ];
    setDesktopDebugRevision((revision) => revision + 1);
  }, []);
  const recordChatViewTimelineScrollDebugEvent = useCallback(
    (reason: string, details?: Record<string, unknown>) => {
      recordTimelineScrollDebugEvent({
        source: "ChatView",
        reason,
        activeThreadId,
        activeTurnId: activeLatestTurn?.turnId ?? null,
        ...(details ? { details } : {}),
      });
    },
    [activeLatestTurn?.turnId, activeThreadId, recordTimelineScrollDebugEvent],
  );
  useEffect(() => {
    if (!activeThread) {
      return;
    }

    const queuedSourceMessageIds = new Set<string>(
      Object.values(followUpQueueByThreadIdRef.current)
        .flat()
        .flatMap((item) =>
          item.automaticSteerRetry === null || item.automaticSteerRetry === undefined
            ? []
            : [String(item.automaticSteerRetry.sourceMessageId)],
        ),
    );
    const candidates = deriveRetryableSteerReplayCandidates({
      thread: activeThread,
      existingSourceMessageIds: queuedSourceMessageIds,
    });

    for (const candidate of candidates) {
      const sourceMessageKey = String(candidate.failure.messageId);
      // A legacy root-idle recheck can be declined by the corrected server.
      // Restore that distinct, non-retrying result once so the saved message
      // remains visible. Keep the ordinary per-message deduplication: changing
      // it for every failure generation could reopen rejected compact loops.
      const restoreBlockedRootRecheck =
        legacyRootRecheckSourceMessageIdsRef.current.has(sourceMessageKey) &&
        candidate.failure.rootIdleRecheckBlocked === true;
      if (
        handledRetryableSteerSourceMessageIdsRef.current.has(sourceMessageKey) &&
        !restoreBlockedRootRecheck
      )
        continue;
      if (retryableSteerReconstructionInFlightRef.current.has(sourceMessageKey)) {
        continue;
      }
      retryableSteerReconstructionInFlightRef.current.add(sourceMessageKey);

      const pending = pendingSteerDispatchByMessageIdRef.current[sourceMessageKey];
      if (pending) {
        removePendingSteerDispatch(candidate.failure.messageId);
      }
      setOptimisticUserMessages((existing) => {
        const removed = existing.filter((message) => message.id === candidate.failure.messageId);
        // A live pending snapshot transfers ownership of its blob previews to
        // the retry shelf. Reload reconstruction has no such renderer-owned
        // File, so any stale optimistic previews can be released normally.
        if (!pending) {
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
        }
        return existing.filter((message) => message.id !== candidate.failure.messageId);
      });

      void (async () => {
        try {
          const restored = pending
            ? {
                images: pending.snapshot.images,
                files: pending.snapshot.files,
                unavailableCount: 0,
              }
            : await restoreCanonicalRetryImages(candidate.message.attachments);
          const snapshot: ComposerSendSnapshot = pending?.snapshot ?? {
            // Image-only canonical messages contain Cafe's transport bootstrap
            // text. Restore the original empty composer text when images are
            // still present so retries do not expose or duplicate that marker.
            promptText:
              candidate.message.text === IMAGE_ONLY_BOOTSTRAP_PROMPT &&
              (candidate.message.attachments?.length ?? 0) > 0
                ? ""
                : candidate.message.text,
            images: restored.images,
            files: restored.files,
            provider: activeThread.session?.provider ?? ProviderDriverKind.make("codex"),
            model: activeThread.modelSelection.model,
            // Canonical message text is already provider-formatted. Keeping
            // capabilities empty avoids injecting a second Claude effort
            // prefix when reconstructing historical provider input.
            providerModels: [],
            promptEffort: null,
            modelSelection: activeThread.modelSelection,
            runtimeMode: activeThread.runtimeMode,
            interactionMode: activeThread.interactionMode,
          };
          const queuedItem: FollowUpQueueItem = {
            ...snapshot,
            id: newMessageId(),
            environmentId: pending?.environmentId ?? activeThread.environmentId,
            threadId: pending?.threadId ?? activeThread.id,
            queuedAt: candidate.failedAt,
            expanded: false,
            blockedReason:
              restored.unavailableCount > 0
                ? `${restored.unavailableCount} attachment${restored.unavailableCount === 1 ? "" : "s"} could not be restored after reconnecting. Remove this retry and resend the missing attachment${restored.unavailableCount === 1 ? "" : "s"}.`
                : null,
            automaticSteerRetry: {
              nonSteerableTurnKind: candidate.failure.turnKind,
              sourceMessageId: candidate.failure.messageId,
              ...(candidate.failure.legacyRootCompletionRetry
                ? { legacyRootCompletionRetry: candidate.failure.legacyRootCompletionRetry }
                : {}),
            },
          };

          handledRetryableSteerSourceMessageIdsRef.current.add(sourceMessageKey);
          if (candidate.failure.legacyRootCompletionRetry) {
            legacyRootRecheckSourceMessageIdsRef.current.add(sourceMessageKey);
          } else {
            legacyRootRecheckSourceMessageIdsRef.current.delete(sourceMessageKey);
          }
          setFollowUpQueueByThreadId((existing) => {
            const current = existing[queuedItem.threadId] ?? EMPTY_FOLLOW_UP_QUEUE;
            if (
              current.some(
                (item) => item.automaticSteerRetry?.sourceMessageId === candidate.failure.messageId,
              )
            ) {
              return existing;
            }
            return {
              ...existing,
              [queuedItem.threadId]: [...current, queuedItem],
            };
          });
        } finally {
          retryableSteerReconstructionInFlightRef.current.delete(sourceMessageKey);
        }
      })();
    }
  }, [
    activeThread,
    removePendingSteerDispatch,
    setFollowUpQueueByThreadId,
    followUpQueueByThreadIdRef,
    pendingSteerDispatchByMessageIdRef,
    handledRetryableSteerSourceMessageIdsRef,
    retryableSteerReconstructionInFlightRef,
    legacyRootRecheckSourceMessageIdsRef,
  ]);
  useEffect(() => {
    const recoveries = Object.values(pendingSteerInterruptRecoveryByThreadId);
    if (recoveries.length === 0) {
      return;
    }

    const threadsById = new Map(allThreads.map((thread) => [thread.id, thread]));

    for (const recovery of recoveries) {
      if (!ownsQueuedThread(recovery.environmentId, recovery.threadId)) continue;
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

      if (
        merged === null ||
        (merged.promptText.length === 0 && merged.images.length === 0 && merged.files.length === 0)
      ) {
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
        files: merged.files,
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
    ownsQueuedThread,
    queueOwnershipRevision,
    pendingSteerDispatchByMessageIdRef,
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
    pendingSteerInterruptRecoveryByThreadIdRef,
  ]);
  const threadPlanCatalog = useThreadPlanCatalog(
    environmentId,
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
  const activeProjectRef = activeThread?.projectId
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
  const quotaConnectionStatus = useWsConnectionStatus();
  const primaryEnvironmentLabel = readPrimaryEnvironmentDescriptor()?.label ?? null;
  const savedRuntime = useSavedEnvironmentRuntimeStore((s) => s.byId[environmentId]);
  const activeEnvironmentUnavailable =
    environmentId !== primaryEnvironmentId && savedRuntime?.connectionState !== "connected";
  const activeEnvironmentUnavailableLabel = activeEnvironmentUnavailable
    ? (savedRuntime?.descriptor?.label ?? "remote server")
    : null;
  const activeEnvironmentUnavailableState: EnvironmentUnavailableState | null =
    activeEnvironmentUnavailable
      ? {
          environmentId,
          label: activeEnvironmentUnavailableLabel!,
          connectionState:
            savedRuntime?.connectionState === "connecting"
              ? "connecting"
              : savedRuntime?.connectionState === "error"
                ? "error"
                : "disconnected",
        }
      : null;
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
      const label = resolveEnvironmentOptionLabel({
        isPrimary,
        environmentId: p.environmentId,
        runtimeLabel: isPrimary ? primaryEnvironmentLabel : null,
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
    primaryEnvironmentLabel,
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
      const logicalDraft = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const storedDraftSession =
        logicalDraft?.environmentId === environmentId
          ? logicalDraft
          : useComposerDraftStore.getState().getDraftSessionByProjectRef(activeProjectRef);
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
        activeDraftSession.environmentId === environmentId &&
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
      // This PR-specific creation path intentionally keeps its existing project
      // model resolution (no sticky picker changes), but must still copy that
      // exact initial account's numeric new-chat default once. Reused drafts
      // above never revisit settings or erase an intentional reset.
      const initialInstanceId =
        activeProject.defaultModelSelection?.instanceId ?? ProviderInstanceId.make("codex");
      const initialInstance = settings.providerInstances?.[initialInstanceId];
      const limitKey = initialInstance ? subagentLimitKey(initialInstance.driver) : null;
      if (
        initialInstance?.enabled !== false &&
        limitKey &&
        validSubagentLimit(initialInstance?.defaultMaxConcurrentSubagents)
      ) {
        useComposerDraftStore.getState().setSubagentLimits(nextDraftId, {
          [limitKey]: initialInstance.defaultMaxConcurrentSubagents,
        });
      }
      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(nextDraftId),
      });
      return nextThreadId;
    },
    [
      activeProject,
      draftId,
      environmentId,
      getDraftSession,
      getDraftSessionByLogicalProjectKey,
      isServerThread,
      navigate,
      projectGroupingSettings,
      routeKind,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
      settings.providerInstances,
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
    if (!pane.active || !pane.visible) return;
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
    pane.active,
    pane.visible,
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
  const primaryServerConfig = useServerConfig(environmentId);
  const serverConfig = primaryServerConfig;
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
  const versionMismatchServerLabel = "server";
  const composerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
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
  // Native runtime identity survives renderer reconnects but changes when the
  // provider process is replaced. Do not use connection banners or parent-turn
  // completion as evidence that independently running children have ended.
  const subagentRuntimeId = activeThread?.session?.subagentRuntimeId;
  const subagentSessionStatus = activeThread?.session?.orchestrationStatus;
  const subagentRuntimeSession = useMemo(
    () =>
      subagentSessionStatus
        ? {
            subagentRuntimeId,
            orchestrationStatus: subagentSessionStatus,
          }
        : null,
    [subagentRuntimeId, subagentSessionStatus],
  );
  const workLogEntries = useMemo(() => {
    const turnId = activeLatestTurn?.turnId;
    return deriveWorkLogEntries(threadActivities, turnId, { includeUnscopedCompaction: true });
  }, [activeLatestTurn?.turnId, threadActivities]);
  const subagentEntries = useMemo(() => {
    const turnId = activeLatestTurn?.turnId;
    return deriveSubagentWorkEntries(threadActivities, turnId, {
      runtimeSession: subagentRuntimeSession,
      ...(turnId && activeLatestTurn?.state !== "running"
        ? { terminalTurnIds: new Set([turnId]) }
        : {}),
    });
  }, [activeLatestTurn?.state, activeLatestTurn?.turnId, threadActivities, subagentRuntimeSession]);
  const activeSubagentEntries = useMemo(
    () =>
      deriveActiveSubagentWorkEntries(
        threadActivities,
        activeLatestTurn?.state === "running" ? activeLatestTurn.turnId : null,
        { runtimeSession: subagentRuntimeSession },
      ),
    [activeLatestTurn?.state, activeLatestTurn?.turnId, threadActivities, subagentRuntimeSession],
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
  const activePendingAutoResolutionSnoozed = activePendingUserInput
    ? snoozedUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;

  useEffect(() => {
    const liveRequestIds = new Set(pendingUserInputs.map((request) => String(request.requestId)));
    for (const requestId of snoozedUserInputRequestIdsRef.current) {
      if (!liveRequestIds.has(requestId)) {
        snoozedUserInputRequestIdsRef.current.delete(requestId);
      }
    }
    setSnoozedUserInputRequestIds((existing) =>
      existing.filter((requestId) => liveRequestIds.has(String(requestId))),
    );
  }, [pendingUserInputs]);
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
  // Match the provider's dedicated todo chip semantics: the latest non-empty
  // checklist is visible only for its currently running turn and yields to
  // blocking approval/question UI. Completed steps remain visible until the
  // turn settles, at which point the compact control disappears entirely.
  const composerActivePlan =
    phase === "running" &&
    activeLatestTurn?.turnId != null &&
    activePlan?.turnId === activeLatestTurn.turnId &&
    pendingApprovals.length === 0 &&
    pendingUserInputs.length === 0
      ? activePlan
      : null;
  const planSidebarLabel = "Plan";
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
  // Authored plan documents retain their exportable side panel only while the
  // thread is idle. Local dispatch covers the projection-acknowledgement gap;
  // after acknowledgement, the canonical session/latest-turn state keeps an
  // old or source plan hidden for the entire runtime turn. This is deliberately
  // presentation-only: it must not persist an explicit `false` preference that
  // would disable auto-open for a future authored plan.
  const runtimeTurnBlocksPlanSidebar =
    isSendBusy || phase === "running" || (activeLatestTurn !== null && !latestTurnSettled);
  const visibleSidebarProposedPlan = runtimeTurnBlocksPlanSidebar ? null : sidebarProposedPlan;
  const hasPlanSidebarContent = visibleSidebarProposedPlan !== null;
  useEffect(() => {
    if (serverAcknowledgedLocalDispatch && !sharedChatRuntime) {
      setSendInFlight(false);
      // The queue IO owner releases its shared gate in finally. A projection
      // ACK can precede completion and must not unlock another pane's dispatch.
    }
  }, [serverAcknowledgedLocalDispatch, setSendInFlight, sharedChatRuntime]);
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
      if (!sharedChatRuntime) {
        for (const items of Object.values(followUpQueueByThreadIdRef.current)) {
          for (const item of items) {
            revokeQueuedFollowUpPreviewUrls(item);
          }
        }
      }
    };
  }, [clearAttachmentPreviewHandoffs, sharedChatRuntime, followUpQueueByThreadIdRef]);
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

    // Optimistic rows are renderer-local and therefore need the same canonical
    // environment/thread ownership as persisted messages. Route effects run
    // after paint, so gate synchronously here as well: two environments may
    // legitimately reuse the same provider-independent ThreadId.
    if (
      optimisticUserMessagesOwnerThreadKeyRef.current !== routeThreadKey ||
      optimisticUserMessages.length === 0
    ) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [serverMessages, attachmentPreviewHandoffByMessageId, optimisticUserMessages, routeThreadKey]);
  const historicalWorkLogSummariesByTurnId = useMemo(
    () =>
      deriveHistoricalWorkLogSummaries({
        messages: timelineMessages,
        activities: threadActivities,
        latestTurnId: activeLatestTurn?.turnId ?? null,
        runtimeSession: subagentRuntimeSession,
      }),
    [activeLatestTurn?.turnId, threadActivities, timelineMessages, subagentRuntimeSession],
  );
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(timelineMessages, activeThread?.proposedPlans ?? [], [
        ...workLogEntries,
        ...subagentEntries,
      ]),
    [activeThread?.proposedPlans, timelineMessages, workLogEntries, subagentEntries],
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
    // Detached transcripts keep historical checkpoint summaries for reading,
    // not authority to restore files. Never surface their repository action.
    if (activeThread?.projectId == null) return byUserMessageId;
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
  }, [
    activeThread?.projectId,
    inferredCheckpointTurnCountByTurnId,
    timelineEntries,
    turnDiffSummaryByAssistantMessageId,
  ]);

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
  const gitCwd =
    activeThread?.projectId === null
      ? null
      : (activeThread?.worktreePath ?? activeProject?.cwd ?? null);
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
  const goalControlsSupported =
    isServerThread &&
    activeProviderStatus?.driver === "codex" &&
    activeProviderStatus.runtimeCapabilities?.threadGoals === "supported";
  const openThreadGoalDialog = useCallback(
    (input?: {
      readonly mode?: ThreadGoalDialogMode;
      readonly seedObjective?: string | null;
      readonly confirmReplacement?: boolean;
    }) => {
      if (!goalControlsSupported) return;
      setThreadGoalDialog((current) => ({
        open: true,
        revision: current.revision + 1,
        mode: input?.mode ?? ((activeThread?.goal ?? null) === null ? "edit" : "summary"),
        seedObjective: input?.seedObjective ?? null,
        confirmReplacement: input?.confirmReplacement ?? false,
      }));
    },
    [activeThread?.goal, goalControlsSupported],
  );
  const closeThreadGoalDialog = useCallback(() => {
    setThreadGoalDialog((current) =>
      current.open
        ? {
            ...current,
            open: false,
          }
        : current,
    );
  }, []);

  useEffect(() => {
    closeThreadGoalDialog();
  }, [closeThreadGoalDialog, routeThreadKey]);

  const setThreadGoal = useCallback(
    async (patch: ThreadGoalSetPatch) => {
      if (!activeThread || !goalControlsSupported) {
        throw new Error("The current provider does not support thread goals.");
      }
      const api = readEnvironmentApi(activeThread.environmentId);
      if (!api) {
        throw new Error("Cafe Code is not connected.");
      }
      await api.orchestration.dispatchCommand({
        type: "thread.goal.set",
        commandId: newCommandId(),
        threadId: activeThread.id,
        ...(patch.objective !== undefined ? { objective: patch.objective } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.tokenBudget !== undefined ? { tokenBudget: patch.tokenBudget } : {}),
        ...(patch.replaceExisting !== undefined ? { replaceExisting: patch.replaceExisting } : {}),
        expectedUpdatedAt: activeThread.goal?.updatedAt ?? null,
        createdAt: new Date().toISOString(),
      });
    },
    [activeThread, goalControlsSupported],
  );

  const clearThreadGoal = useCallback(async () => {
    if (!activeThread || !goalControlsSupported) {
      throw new Error("The current provider does not support thread goals.");
    }
    const api = readEnvironmentApi(activeThread.environmentId);
    if (!api) {
      throw new Error("Cafe Code is not connected.");
    }
    await api.orchestration.dispatchCommand({
      type: "thread.goal.clear",
      commandId: newCommandId(),
      threadId: activeThread.id,
      expectedUpdatedAt: activeThread.goal?.updatedAt ?? null,
      createdAt: new Date().toISOString(),
    });
  }, [activeThread, goalControlsSupported]);
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
      thread.projectId === null
        ? undefined
        : selectProjectByRef(
            useStore.getState(),
            scopeProjectRef(thread.environmentId, thread.projectId),
          ),
    [],
  );
  const isThreadEnvironmentUnavailable = useCallback(
    (thread: Thread): boolean =>
      thread.environmentId !== primaryEnvironmentId &&
      getSavedEnvironmentRuntimeState(thread.environmentId)?.connectionState !== "connected",
    [primaryEnvironmentId],
  );
  const activeFollowUpQueue = useMemo(
    () =>
      activeThreadId !== null
        ? (followUpQueueByThreadId[activeThreadId] ?? EMPTY_FOLLOW_UP_QUEUE).filter(
            (item) => item.environmentId === environmentId,
          )
        : EMPTY_FOLLOW_UP_QUEUE,
    [activeThreadId, environmentId, followUpQueueByThreadId],
  );
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
  }, [
    allThreads,
    queuedFollowUpPendingDispatchByThreadId,
    queuedFollowUpPendingDispatchByThreadIdRef,
    setQueuedFollowUpPendingDispatchByThreadId,
  ]);
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
  const canRetryAutomaticSteerItem = useCallback(
    (item: FollowUpQueueItem): boolean => {
      if (
        !item.automaticSteerRetry?.dispatchFailed ||
        !activeThread ||
        item.environmentId !== activeThread.environmentId ||
        item.threadId !== activeThread.id ||
        item.dispatchState === "claimed" ||
        queueEditingItemId ||
        sendInFlightRef.current ||
        queueDispatchInFlightRef.current ||
        activeQueuedFollowUpPendingDispatch ||
        isComposerConnecting ||
        activeEnvironmentUnavailable ||
        resolveAutomaticSteerRetryBlocker({ item, thread: activeThread, phase: followUpQueuePhase })
      ) {
        return false;
      }
      return followUpQueuePhase === "running"
        ? activeThread.session?.status === "running" && activeProviderLiveSteerAvailable
        : !followUpQueueVisibleWorking;
    },
    [
      activeThread,
      queueEditingItemId,
      activeQueuedFollowUpPendingDispatch,
      isComposerConnecting,
      activeEnvironmentUnavailable,
      followUpQueuePhase,
      activeProviderLiveSteerAvailable,
      followUpQueueVisibleWorking,
      queueDispatchInFlightRef,
      sendInFlightRef,
    ],
  );
  const followUpQueueViewItems = useMemo<readonly FollowUpQueueViewItem[]>(() => {
    // This mutable gate deliberately avoids broadcasting every dispatch to
    // all panes; its local revision refreshes row affordances when it changes.
    void dispatchGateRevision;
    return activeFollowUpQueue.map((item) => ({
      id: item.id,
      preview: previewQueuedFollowUpText(item.promptText),
      promptText: item.promptText,
      images: item.images,
      files: item.files,
      environmentId: item.environmentId,
      canEdit:
        item.dispatchState !== "claimed" &&
        !queueEditingItemId &&
        !sendInFlightRef.current &&
        !queueDispatchInFlightRef.current,
      canDispatch: item.dispatchState !== "claimed" && !queueEditingItemId,
      canRetryDelivery: canRetryAutomaticSteerItem(item),
      queuedAt: item.queuedAt,
      expanded: item.expanded,
      canExpand:
        canExpandQueuedFollowUpText(item.promptText) ||
        item.images.length > 0 ||
        item.files.length > 0,
      blockedReason: item.blockedReason,
      automaticSteerRetry: item.automaticSteerRetry === undefined ? null : item.automaticSteerRetry,
    }));
  }, [
    activeFollowUpQueue,
    queueEditingItemId,
    canRetryAutomaticSteerItem,
    dispatchGateRevision,
    queueDispatchInFlightRef,
    sendInFlightRef,
  ]);
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
          files: pending.snapshot.files,
          environmentId: pending.environmentId,
        })),
    [activeThreadId, pendingSteerDispatchByMessageId],
  );
  const canActivateRunningFollowUpQueueAction = canDispatchRunningQueuedFollowUp({
    phase: followUpQueuePhase,
    sessionRunning: activeThread?.session?.status === "running",
    firstItemBlocked: Boolean(
      firstActiveFollowUpQueueItem?.automaticSteerRetry &&
      firstActiveFollowUpQueueItem.blockedReason !== null,
    ),
    automaticSteerRetryBlocked: firstActiveAutomaticSteerRetryBlocker !== null,
    isConnecting: isComposerConnecting,
    isEnvironmentUnavailable: activeEnvironmentUnavailable,
    isDispatchInFlight:
      sendInFlightRef.current ||
      queueDispatchInFlightRef.current ||
      Boolean(activeQueuedFollowUpPendingDispatch),
  });
  const canSteerFollowUpQueue =
    canActivateRunningFollowUpQueueAction && activeProviderLiveSteerAvailable;
  const activeSteeringFollowUpInFlight = steeringFollowUpViewItems.length > 0;
  const followUpQueueActionLabel = queuedFollowUpActionLabel({
    phase: followUpQueuePhase,
    liveSteerSupported: activeProviderLiveSteerAvailable,
  });
  const followUpQueueActionTitle = queuedFollowUpActionTitle({
    phase: followUpQueuePhase,
    liveSteerSupported: activeProviderLiveSteerAvailable,
  });
  useEffect(() => {
    // A Desk tab can remount while its previous submission is awaiting an ACK.
    // Only that submission's finally/ack path may release the shared lock.
    if (sharedChatRuntime) return;
    if (activeFollowUpQueue.length > 0 && followUpQueueUiIdle && sendInFlightRef.current) {
      setSendInFlight(false);
    }
  }, [
    activeFollowUpQueue.length,
    followUpQueueUiIdle,
    setSendInFlight,
    sharedChatRuntime,
    sendInFlightRef,
  ]);
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
    const wsConnectionDiagnostics = getWsConnectionDiagnostics();
    const usageDetailDiagnostics = getUsageStatsDetailDiagnostics();
    const composerDebugState = readComposerHandle(composerRef)?.readDebugState() ?? null;
    const firstItem = firstActiveFollowUpQueueItem;
    const activePendingSteerInterruptRecovery =
      activeThreadId !== null
        ? (pendingSteerInterruptRecoveryByThreadIdRef.current[activeThreadId] ?? null)
        : null;
    const activeManualStopBarrier =
      activeThreadId !== null
        ? (manualStopBarrierByThreadIdRef.current[activeThreadId] ?? null)
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
    if (activePendingSteerInterruptRecovery !== null) {
      queueBlockers.push("pending-steer-interrupt-recovery");
    }
    if (activeManualStopBarrier !== null) {
      queueBlockers.push("manual-stop-barrier");
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
    const currentTimelineListState = legendListRef.current?.getState?.() ?? null;
    const timelineScrollDebug: TimelineScrollDebugSnapshot = {
      state: {
        isAtEnd: isAtEndRef.current,
        userScrollIntentSinceReset: timelineUserScrollIntentSinceResetRef.current,
        autoFollowTail: timelineAutoFollowTail,
        showScrollToBottom,
        stickToEndRevision: stickTimelineToEndRevision,
      },
      currentListMetrics: summarizeTimelineScrollMetrics({
        state: currentTimelineListState,
        rowCount: timelineEntries.length,
        autoFollowTail: timelineAutoFollowTail,
        stickToEndRevision: stickTimelineToEndRevision,
        nowMs: capturedAtMs,
      }),
      latest: timelineScrollDebugEventsRef.current.at(-1) ?? null,
      recent: timelineScrollDebugEventsRef.current,
    };

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
      connection: {
        ...wsConnectionDiagnostics,
        connected: wsConnectionDiagnostics.phase === "connected",
      },
      usage: {
        detail: usageDetailDiagnostics,
      },
      // Dictation diagnostics are deliberately content-free. The source module
      // exposes only bounded lifecycle metadata: never audio, transcripts, SDP,
      // credentials, provider response bodies, or raw errors.
      dictation: getDictationDiagnosticSnapshot(),
      timelineScroll: timelineScrollDebug,
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
          activeManualStopBarrier,
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
        fleet: summarizeProviderDebugFleet(providerStatuses),
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
        manualStopBarriers: manualStopBarrierByThreadIdRef.current,
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
    providerStatuses,
    queuedFollowUpPendingDispatchByThreadId,
    routeKind,
    selectedProvider,
    serverAcknowledgedLocalDispatch,
    showScrollToBottom,
    steeringFollowUpViewItems,
    threadId,
    timelineAutoFollowTail,
    timelineEntries.length,
    stickTimelineToEndRevision,
    manualStopBarrierByThreadIdRef,
    pendingSteerInterruptRecoveryByThreadIdRef,
    followUpQueueByThreadIdRef,
    queueDispatchInFlightRef,
    sendInFlightRef,
  ]);
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath =
    activeThread?.projectId === null ? null : (activeThread?.worktreePath ?? null);
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = activeThread?.projectId != null && (gitStatusQuery.data?.isRepo ?? true);
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
    (
      targetThreadId: ThreadId | null,
      error: string | null,
      targetThreadRef: ScopedThreadRef = routeThreadRef,
    ) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      const isCurrentServerThread = shouldWriteThreadErrorToCurrentServerThread({
        serverThread,
        routeThreadRef: targetThreadRef,
        targetThreadId,
      });
      if (isCurrentServerThread) {
        // The route-owned environment is part of thread identity. An RPC can
        // settle after the user navigates to another environment, so writing
        // through the store's mutable active-environment pointer could clear or
        // replace an unrelated thread that happens to reuse this ThreadId.
        setStoreThreadError(targetThreadRef, nextError);
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
    if (!currentPaneRef.current.active || !currentPaneRef.current.visible) return;
    readComposerHandle(composerRef)?.focusAtEnd();
  }, [composerRef]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);

  const claudeResponseLimitFailure = captureClaudeResponseLimitFailure(
    isServerThread ? activeThread : undefined,
    composerActiveProvider ?? activeThread?.modelSelection.instanceId ?? null,
  );
  const canPrepareShorterResponse =
    claudeResponseLimitFailure !== null &&
    selectedProvider === "claudeAgent" &&
    activeProviderStatus?.driver === "claudeAgent" &&
    activeProviderStatus.enabled &&
    pane.active &&
    pane.visible &&
    !isWorking &&
    !activeEnvironmentUnavailable &&
    (environmentId === primaryEnvironmentId
      ? quotaConnectionStatus.phase === "connected"
      : savedRuntime?.connectionState === "connected") &&
    shorterContinuationDraftEmpty &&
    activeFollowUpQueue.length === 0 &&
    activePendingApproval === null &&
    activePendingUserInput === null;
  const prepareShorterResponse = () => {
    // No awaits or provider I/O belong here. Bind the click to its rendered
    // failure, then re-read every mutable owner/content gate synchronously.
    // The ordinary Send gesture retains all existing provider validation and
    // paid-inference authority after the user has reviewed this editable text.
    if (
      !canPrepareShorterResponse ||
      !claudeResponseLimitFailure ||
      !chatViewMountedRef.current ||
      currentRouteThreadKeyRef.current !== routeThreadKey ||
      !currentPaneRef.current.active ||
      !currentPaneRef.current.visible ||
      sendInFlightRef.current ||
      queueDispatchInFlightRef.current ||
      !getWorkspaceServerConfig(environmentId)?.providers.some(
        (provider) =>
          provider.instanceId === claudeResponseLimitFailure.instanceId &&
          provider.driver === "claudeAgent" &&
          provider.enabled,
      ) ||
      (followUpQueueByThreadIdRef.current[threadId] ?? []).some(
        (item) => item.environmentId === environmentId,
      ) ||
      (environmentId === primaryEnvironmentId
        ? getWsConnectionStatus().phase !== "connected"
        : getSavedEnvironmentRuntimeState(environmentId)?.connectionState !== "connected")
    ) {
      return;
    }
    const currentThread = selectThreadByRef(useStore.getState(), routeThreadRef);
    const draftStore = useComposerDraftStore.getState();
    const draft = draftStore.getComposerDraft(composerDraftTarget);
    const sendContext = readComposerHandle(composerRef)?.getSendContext();
    if (
      !currentThread ||
      derivePendingApprovals(currentThread.activities).length !== 0 ||
      derivePendingUserInputs(currentThread.activities).some((request) => request.isBlocking) ||
      !isClaudeContinuationDraftEmpty(draft) ||
      promptRef.current.length !== 0 ||
      composerImagesRef.current.length !== 0 ||
      !sendContext ||
      sendContext.prompt.length !== 0 ||
      sendContext.images.length !== 0 ||
      sendContext.files.length !== 0 ||
      sendContext.selectedProvider !== "claudeAgent" ||
      !isClaudeResponseLimitFailureCurrent(
        claudeResponseLimitFailure,
        currentThread,
        draft?.activeProvider ?? currentThread?.modelSelection.instanceId ?? null,
      ) ||
      sendContext.selectedModelSelection.instanceId !== claudeResponseLimitFailure.instanceId
    ) {
      return;
    }
    // The existing atomic empty-content transition preserves model/effort,
    // account, permission mode and all other composer settings verbatim.
    if (
      !draftStore.restoreComposerContentIfEmpty(composerDraftTarget, {
        prompt: CLAUDE_SHORTER_CONTINUATION_PROMPT,
        images: [],
        files: [],
      })
    ) {
      return;
    }
    promptRef.current = CLAUDE_SHORTER_CONTINUATION_PROMPT;
    composerRef.current?.resetCursorState({
      cursor: collapseExpandedComposerCursor(
        CLAUDE_SHORTER_CONTINUATION_PROMPT,
        CLAUDE_SHORTER_CONTINUATION_PROMPT.length,
      ),
      prompt: CLAUDE_SHORTER_CONTINUATION_PROMPT,
      detectTrigger: true,
    });
    // Focus is deferred until the editor reflects its new draft. Revalidate
    // that same failure and draft on the frame too, so navigation, a new turn
    // or user edits cannot make this older action steal another editor's focus.
    window.requestAnimationFrame(() => {
      const current = selectThreadByRef(useStore.getState(), routeThreadRef);
      const currentDraft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
      if (
        chatViewMountedRef.current &&
        currentRouteThreadKeyRef.current === routeThreadKey &&
        currentDraft?.prompt === CLAUDE_SHORTER_CONTINUATION_PROMPT &&
        isClaudeResponseLimitFailureCurrent(
          claudeResponseLimitFailure,
          current,
          currentDraft.activeProvider ?? current?.modelSelection.instanceId ?? null,
        )
      ) {
        focusComposer();
      }
    });
  };

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
  const showSessionRail = useCallback(() => {
    setSessionRailDocked(true);
  }, [setSessionRailDocked]);
  const hideSessionRail = useCallback(() => {
    setSessionRailDocked(false);
  }, [setSessionRailDocked]);

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
  const clearTimelineUserScrollIntentSettle = useCallback(() => {
    timelineUserScrollIntentSettleUntilMsRef.current = 0;
    if (timelineUserScrollIntentSettleTimeoutRef.current !== null) {
      window.clearTimeout(timelineUserScrollIntentSettleTimeoutRef.current);
      timelineUserScrollIntentSettleTimeoutRef.current = null;
    }
  }, []);
  const hideScrollToBottom = useCallback(
    (reason = "hide-scroll-to-bottom") => {
      const isStateChanging =
        !isAtEndRef.current ||
        timelineUserScrollIntentSinceResetRef.current ||
        !timelineAutoFollowTail ||
        showScrollToBottom;
      if (isStateChanging || reason.startsWith("local-message-submit")) {
        recordChatViewTimelineScrollDebugEvent(reason, {
          previousIsAtEnd: isAtEndRef.current,
          previousUserScrollIntentSinceReset: timelineUserScrollIntentSinceResetRef.current,
          previousAutoFollowTail: timelineAutoFollowTail,
          previousShowScrollToBottom: showScrollToBottom,
        });
      }
      isAtEndRef.current = true;
      timelineUserScrollIntentSinceResetRef.current = false;
      clearTimelineUserScrollIntentSettle();
      setTimelineAutoFollowTail(true);
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    },
    [
      clearTimelineUserScrollIntentSettle,
      recordChatViewTimelineScrollDebugEvent,
      showScrollToBottom,
      timelineAutoFollowTail,
    ],
  );

  // Scroll helpers — LegendList handles auto-scroll via maintainScrollAtEnd.
  const scrollToEnd = useCallback(
    (animated = false) => {
      timelineForcedScrollGenerationRef.current += 1;
      recordChatViewTimelineScrollDebugEvent("scroll-to-end-requested", { animated });
      hideScrollToBottom("scroll-to-end-hide-pill");
      void legendListRef.current?.scrollToEnd?.({ animated });
    },
    [hideScrollToBottom, recordChatViewTimelineScrollDebugEvent],
  );
  const pinTimelineToEndForLocalMessage = useCallback(() => {
    // Sending a local user message is an explicit request to move to the new
    // conversation tail. Do not trust LegendList's last scroll measurement
    // here: composer resize, virtual row replacement, and pending work rows can
    // briefly report "not at end" even though the user's next action should be
    // anchored to the prompt they just submitted.
    shouldPinTimelineToEndForLocalMessage();
    const forcedScrollGeneration = timelineForcedScrollGenerationRef.current + 1;
    timelineForcedScrollGenerationRef.current = forcedScrollGeneration;
    recordChatViewTimelineScrollDebugEvent("local-message-submit-pin-start", {
      previousIsAtEnd: isAtEndRef.current,
      previousUserScrollIntentSinceReset: timelineUserScrollIntentSinceResetRef.current,
      previousAutoFollowTail: timelineAutoFollowTail,
      previousShowScrollToBottom: showScrollToBottom,
      listAvailable: legendListRef.current !== null,
    });
    hideScrollToBottom("local-message-submit-hide-pill");
    setStickTimelineToEndRevision((revision) => revision + 1);
    void legendListRef.current?.scrollToEnd?.({ animated: false });
    window.requestAnimationFrame(() => {
      if (forcedScrollGeneration !== timelineForcedScrollGenerationRef.current) {
        return;
      }
      recordChatViewTimelineScrollDebugEvent("local-message-submit-pin-raf-1");
      void legendListRef.current?.scrollToEnd?.({ animated: false });
      window.requestAnimationFrame(() => {
        if (forcedScrollGeneration !== timelineForcedScrollGenerationRef.current) {
          return;
        }
        recordChatViewTimelineScrollDebugEvent("local-message-submit-pin-raf-2");
        void legendListRef.current?.scrollToEnd?.({ animated: false });
      });
    });
  }, [
    hideScrollToBottom,
    recordChatViewTimelineScrollDebugEvent,
    showScrollToBottom,
    timelineAutoFollowTail,
  ]);
  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean) => {
      if (isAtEnd) {
        if (
          shouldPreserveTimelineScrollReviewIntent({
            lastKnownAtEnd: isAtEndRef.current,
            userScrollIntentSinceReset: timelineUserScrollIntentSinceResetRef.current,
            userScrollIntentSettleUntilMs: timelineUserScrollIntentSettleUntilMsRef.current,
            nowMs: Date.now(),
          })
        ) {
          recordChatViewTimelineScrollDebugEvent("timeline-is-at-end-change", {
            isAtEnd,
            action: "preserve-user-scroll-intent-during-settle",
            settleUntilMs: timelineUserScrollIntentSettleUntilMsRef.current,
          });
          showScrollDebouncer.current.cancel();
          setShowScrollToBottom(false);
          setTimelineAutoFollowTail(false);
          return;
        }
        if (
          !isAtEndRef.current ||
          timelineUserScrollIntentSinceResetRef.current ||
          !timelineAutoFollowTail ||
          showScrollToBottom
        ) {
          recordChatViewTimelineScrollDebugEvent("timeline-is-at-end-change", {
            isAtEnd,
            action: "hide-pill",
          });
        }
        hideScrollToBottom("timeline-reported-at-end");
        return;
      }

      if (!timelineUserScrollIntentSinceResetRef.current) {
        recordChatViewTimelineScrollDebugEvent("timeline-is-at-end-change", {
          isAtEnd,
          action: "ignore-without-user-scroll-intent",
        });
        showScrollDebouncer.current.cancel();
        setShowScrollToBottom(false);
        return;
      }

      if (isAtEndRef.current === false) return;
      clearTimelineUserScrollIntentSettle();
      recordChatViewTimelineScrollDebugEvent("timeline-is-at-end-change", {
        isAtEnd,
        action: "show-pill-after-debounce",
      });
      isAtEndRef.current = false;
      showScrollDebouncer.current.maybeExecute();
    },
    [
      clearTimelineUserScrollIntentSettle,
      hideScrollToBottom,
      recordChatViewTimelineScrollDebugEvent,
      showScrollToBottom,
      timelineAutoFollowTail,
    ],
  );
  const onTimelineUserScrollIntent = useCallback(() => {
    timelineForcedScrollGenerationRef.current += 1;
    clearTimelineUserScrollIntentSettle();
    const settleUntilMs = Date.now() + TIMELINE_USER_SCROLL_INTENT_SETTLE_MS;
    timelineUserScrollIntentSettleUntilMsRef.current = settleUntilMs;
    recordChatViewTimelineScrollDebugEvent("timeline-user-scroll-intent", {
      previousAutoFollowTail: timelineAutoFollowTail,
      previousShowScrollToBottom: showScrollToBottom,
      settleUntilMs,
    });
    timelineUserScrollIntentSinceResetRef.current = true;
    setTimelineAutoFollowTail(false);

    // A wheel event can precede LegendList's updated measurement. Re-read once
    // the gesture has settled: a real upward move becomes detached, while a
    // no-op gesture at the physical tail safely resumes normal following.
    timelineUserScrollIntentSettleTimeoutRef.current = window.setTimeout(() => {
      timelineUserScrollIntentSettleTimeoutRef.current = null;
      timelineUserScrollIntentSettleUntilMsRef.current = 0;
      if (!timelineUserScrollIntentSinceResetRef.current || isAtEndRef.current === false) {
        return;
      }
      const state = legendListRef.current?.getState?.();
      if (state) {
        onIsAtEndChange(isTimelineScrolledToEnd(state));
      }
    }, TIMELINE_USER_SCROLL_INTENT_SETTLE_MS);
  }, [
    clearTimelineUserScrollIntentSettle,
    onIsAtEndChange,
    recordChatViewTimelineScrollDebugEvent,
    showScrollToBottom,
    timelineAutoFollowTail,
  ]);

  useEffect(
    () => () => {
      clearTimelineUserScrollIntentSettle();
    },
    [clearTimelineUserScrollIntentSettle],
  );

  useEffect(() => {
    recordTimelineScrollDebugEvent({
      source: "ChatView",
      reason: "active-thread-scroll-state-reset",
      activeThreadId: activeThread?.id ?? null,
      activeTurnId: null,
      details: {
        activeThreadId: activeThread?.id ?? null,
      },
    });
    setPullRequestDialogState(null);
    timelineForcedScrollGenerationRef.current += 1;
    const following = initialTimelinePosition?.following ?? true;
    isAtEndRef.current = following;
    timelineUserScrollIntentSinceResetRef.current = !following;
    clearTimelineUserScrollIntentSettle();
    setTimelineAutoFollowTail(following);
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(!following);
  }, [
    activeThread?.id,
    clearTimelineUserScrollIntentSettle,
    recordTimelineScrollDebugEvent,
    initialTimelinePosition,
  ]);

  // The optional side panel is now reserved for a completed, authored plan
  // document. Runtime todo snapshots stay in the composer progress popover and
  // must never create a side panel or steal horizontal space from the chat.
  useEffect(() => {
    if (!autoOpenPlanSidebar) return;
    if (!visibleSidebarProposedPlan) return;
    if (!latestTurnSettled) return;
    if (!hasPlanSidebarContent) return;
    if (planSidebarOpen) return;
    // Once the user has explicitly opened or closed the plan panel for this
    // thread, that thread-local preference wins over later authored plans.
    if (planSidebarOpenPreference !== undefined) return;
    const latestTurnId = activeLatestTurn?.turnId ?? null;
    if (!latestTurnId || visibleSidebarProposedPlan.turnId !== latestTurnId) return;
    setPlanSidebarOpenForCurrentThread(true);
  }, [
    activeLatestTurn?.turnId,
    autoOpenPlanSidebar,
    hasPlanSidebarContent,
    latestTurnSettled,
    planSidebarOpen,
    planSidebarOpenPreference,
    setPlanSidebarOpenForCurrentThread,
    visibleSidebarProposedPlan,
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
    if (pane.autoFocusComposer === false) return;
    if (!pane.active || !pane.visible) return;
    if (isMobile || hasOnScreenKeyboard) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    activeThread?.id,
    focusComposer,
    hasOnScreenKeyboard,
    isMobile,
    pane.active,
    pane.visible,
    pane.autoFocusComposer,
  ]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (optimisticUserMessagesOwnerThreadKeyRef.current !== routeThreadKey) return;
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
  }, [
    activeThread?.id,
    activeThread?.messages,
    handoffAttachmentPreviews,
    optimisticUserMessages,
    routeThreadKey,
  ]);

  useEffect(() => {
    optimisticUserMessagesOwnerThreadKeyRef.current = routeThreadKey;
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setExpandedImage(null);
  }, [draftId, resetLocalDispatch, routeThreadKey]);

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
    activeThread.projectId !== null &&
    activeThread.messages.length === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    activeThread?.projectId === null
      ? null
      : canOverrideServerThreadEnvMode && pendingServerThreadBranch !== undefined
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
      if (!pane.active || !pane.visible) return;
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

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        readComposerHandle(composerRef)?.toggleModelPicker();
        return;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeThreadId, composerRef, keybindings, pane.active, pane.visible]);

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readEnvironmentApi(environmentId);
      const localApi = readLocalApi();
      if (
        !api ||
        !localApi ||
        !activeThread ||
        activeThread.projectId === null ||
        isRevertingCheckpoint
      )
        return;

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

  const admitComposerTurnPolicy = (input: {
    modelSelection: ModelSelection;
    provider: ProviderDriverKind;
    subagentLimits?: SubagentLimits | undefined;
  }): boolean => {
    if (!activeThread) return false;
    const concurrencyIssue = readSubagentConcurrencyAdmissionError({
      environmentId,
      modelSelection: input.modelSelection,
      provider: input.provider,
      limits: input.subagentLimits ?? activeThread.subagentLimits,
    });
    if (concurrencyIssue) {
      setThreadError(activeThread.id, concurrencyIssue);
      return false;
    }
    return true;
  };

  const readComposerSnapshotForDispatch = (checkTurnPolicy = true): ComposerSendSnapshot | null => {
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx || !activeThread) return null;
    if (
      checkTurnPolicy &&
      !admitComposerTurnPolicy({
        modelSelection: sendCtx.selectedModelSelection,
        provider: sendCtx.selectedProvider,
        subagentLimits: sendCtx.subagentLimits,
      })
    ) {
      return null;
    }
    if (
      sendCtx.images.length > 0 &&
      !modelAcceptsImages(
        getProviderModelCapabilities(
          sendCtx.selectedProviderModels,
          sendCtx.selectedModel,
          sendCtx.selectedProvider,
        ),
        sendCtx.selectedModel,
      )
    ) {
      setThreadError(activeThread.id, UNSUPPORTED_MODEL_IMAGES_MESSAGE);
      return null;
    }
    let files: import("@cafecode/contracts").ChatFileAttachment[];
    try {
      files = readyComposerFiles(sendCtx.files, environmentId, activeThread.id);
    } catch {
      setThreadError(
        activeThread.id,
        "Finish or remove every file upload before sending. Files must belong to this thread and environment.",
      );
      return null;
    }
    return {
      promptText: promptRef.current,
      images: [...sendCtx.images],
      files,
      provider: sendCtx.selectedProvider,
      model: sendCtx.selectedModel,
      providerModels: sendCtx.selectedProviderModels,
      promptEffort: sendCtx.selectedPromptEffort,
      modelSelection: sendCtx.selectedModelSelection,
      ...(sendCtx.selectedProvider === "claudeAgent" && sendCtx.deliveryPriority !== undefined
        ? { deliveryPriority: sendCtx.deliveryPriority }
        : {}),
      ...(sendCtx.subagentLimits !== undefined
        ? { subagentLimits: { ...sendCtx.subagentLimits } }
        : {}),
      runtimeMode,
      interactionMode,
    };
  };

  const outgoingTextForSnapshot = (snapshot: ComposerSendSnapshot): string =>
    formatOutgoingPrompt({
      provider: snapshot.provider,
      model: snapshot.model,
      models: snapshot.providerModels,
      effort: snapshot.promptEffort,
      text:
        snapshot.promptText ||
        (snapshot.files.length > 0 ? FILE_ONLY_BOOTSTRAP_PROMPT : IMAGE_ONLY_BOOTSTRAP_PROMPT),
    });

  const clearActiveComposerContent = (expected: ComposerThreadDraftState | null) => {
    const current = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
    // Persistence and steering ACKs may resolve after this view has closed and
    // the same chat has reopened. Only consume the content this attempt read;
    // a stale component must never erase the reopened editor's newer draft.
    // Content arrays are immutable in the draft store. Provider/default edits
    // may change the surrounding record without changing this exact payload.
    if (
      current?.prompt !== expected?.prompt ||
      current?.images !== expected?.images ||
      current?.files !== expected?.files ||
      current?.queueEditingItemId !== expected?.queueEditingItemId
    )
      return;
    clearComposerDraftContent(composerDraftTarget);
    if (!chatViewMountedRef.current || currentRouteThreadKeyRef.current !== routeThreadKey) return;
    promptRef.current = "";
    composerRef.current?.resetCursorState();
    // Desktop keeps its efficient type-send-type loop. On touch devices,
    // however, the primary action intentionally dismisses the software
    // keyboard after sending; scheduling focus here would race that dismissal
    // and reopen the mobile composer over the newly queued message.
    if (!hasOnScreenKeyboard) {
      scheduleComposerFocus();
    }
  };

  const restoreComposerSnapshotForRetry = (snapshot: ComposerSendSnapshot) => {
    const retryComposerImages = snapshot.images.map(cloneComposerImageForRetry);
    const restored = restoreComposerDraftContentIfEmpty(composerDraftTarget, {
      prompt: snapshot.promptText,
      images: retryComposerImages,
      files: snapshot.files.map((file) =>
        composerFileFromAttachment(environmentId, activeThread!.id, file),
      ),
    });
    if (!restored) {
      for (const image of retryComposerImages) revokeBlobPreviewUrl(image.previewUrl);
      return;
    }
    promptRef.current = snapshot.promptText;
    composerImagesRef.current = retryComposerImages;
    composerRef.current?.resetCursorState({
      cursor: collapseExpandedComposerCursor(snapshot.promptText, snapshot.promptText.length),
      prompt: snapshot.promptText,
      detectTrigger: true,
    });
    scheduleComposerFocus();
  };

  const enqueueFollowUpSnapshot = async (
    snapshot: ComposerSendSnapshot,
    options: {
      readonly preserveComposer?: boolean;
      readonly id?: string;
      readonly activate?: boolean;
    } = {},
  ): Promise<boolean> => {
    if (!activeThread || sendInFlightRef.current || queueDispatchInFlightRef.current) return false;
    const stopGenerationAtAdmission =
      manualStopGenerationByThreadIdRef.current[activeThread.id] ?? 0;
    const composerContentAtAdmission = useComposerDraftStore
      .getState()
      .getComposerDraft(composerDraftTarget);
    if (parseComposerCompactionCommand(snapshot.provider, snapshot.promptText) !== null) {
      setThreadError(
        activeThread.id,
        "Run /compact directly after the current turn finishes; compaction commands cannot be queued.",
      );
      return false;
    }
    // Async answers use a stable, scoped question identity as the durable queue
    // and eventual command/message id. A lost local ACK therefore cannot turn
    // an explicit answer into two provider submissions after reload.
    if (options.id) {
      const committed = activeThread.messages.find((message) => message.id === options.id);
      if (committed) return committed.text === outgoingTextForSnapshot(snapshot);
      const saved = queuePersistence.load(activeThread.environmentId);
      if (!saved.ok) {
        setThreadError(activeThread.id, saved.error);
        return false;
      }
      const existing = [...saved.value.pending, ...saved.value.claimed].find(
        (item) => item.threadId === activeThread.id && item.id === options.id,
      );
      // An uncertain answer receipt permits only an exact text retry. A second
      // view must never overwrite another answer or reuse its accepted command
      // identity with changed text, even when that item is already claimed.
      if (existing) {
        if (existing.promptText !== snapshot.promptText) return false;
        if (options.activate && existing.dispatchState === "pending" && phase === "running") {
          const item: FollowUpQueueItem = {
            ...snapshot,
            id: existing.id,
            environmentId: activeThread.environmentId,
            threadId: activeThread.id,
            queuedAt: existing.queuedAt,
            expanded: false,
            blockedReason: existing.blockedReason,
          };
          await dispatchSteerSnapshot(item, { queuedItem: item, independentAnswer: true });
        }
        return true;
      }
    }
    const queuedAt = new Date().toISOString();
    const item: FollowUpQueueItem = {
      ...snapshot,
      id: options.id ?? newMessageId(),
      environmentId: activeThread.environmentId,
      threadId: activeThread.id,
      queuedAt,
      expanded: false,
      blockedReason: null,
    };
    setSendInFlight(true);
    const save = () =>
      persistFollowUpQueues(activeThread.environmentId, { [item.threadId]: [item] });
    const saved = options.id
      ? await persistExactAsyncQuestionAnswer({
          id: item.id,
          threadId: item.threadId,
          text: item.promptText,
          save,
          read: () => queuePersistence.load(item.environmentId),
        })
      : await save();
    setSendInFlight(false);
    if (!saved.ok) {
      setThreadError(activeThread.id, saved.error);
      return false;
    }
    if (options.id && saved.value === "claimed") return true;
    const stoppedDuringPersistence =
      options.activate &&
      (manualStopGenerationByThreadIdRef.current[item.threadId] ?? 0) !== stopGenerationAtAdmission;
    let acceptedItem: FollowUpQueueItem = { ...item, dispatchState: "pending" };
    if (stoppedDuringPersistence) {
      acceptedItem = {
        ...acceptedItem,
        blockedReason: "Stopped before sending. Select this queued message to send it.",
      };
      const parked = await queuePersistence.replacePending(item, acceptedItem);
      if (!parked.ok) {
        setThreadError(item.threadId, parked.error);
        return false;
      }
    }
    // The saved queue remains authoritative if routing changed during storage
    // I/O. Its normal hydration owns the next view's environment-specific state.
    if (currentRouteThreadKeyRef.current !== routeThreadKey) return true;
    setFollowUpQueueByThreadId((current) => ({
      ...current,
      [activeThread.id]: [...(current[activeThread.id] ?? []), acceptedItem],
    }));
    setThreadError(activeThread.id, null);
    if (!options.preserveComposer) clearActiveComposerContent(composerContentAtAdmission);
    if (options.activate && !stoppedDuringPersistence) {
      updateManualStopBarrier(item.threadId, null);
      if (phase === "running")
        await dispatchSteerSnapshot(acceptedItem, {
          queuedItem: acceptedItem,
          independentAnswer: true,
        });
      else await dispatchFollowUpTurnStartRef.current?.(acceptedItem, { independentAnswer: true });
    }
    return true;
  };

  const enqueueAsyncQuestionAnswer = async (text: string, messageId: string): Promise<boolean> => {
    if (
      !activeThread ||
      !isServerThread ||
      isComposerConnecting ||
      activeEnvironmentUnavailable ||
      currentRouteThreadKeyRef.current !== routeThreadKey
    )
      return false;
    const sendCtx = readComposerHandle(composerRef)?.getSendContext();
    if (
      !sendCtx ||
      sendCtx.selectedProvider !== "codex" ||
      activeThread.session?.provider !== "codex"
    )
      return false;
    // Read only provider/model choices. Do not inspect or move main-draft
    // attachments, pending uploads, cursor state, or queue-editing state. This
    // enters the ordinary durable queue directly, bypassing slash-command
    // parsing; its dispatcher selects start/steer from authoritative lifecycle.
    return enqueueFollowUpSnapshot(
      {
        promptText: text,
        images: [],
        files: [],
        provider: sendCtx.selectedProvider,
        model: sendCtx.selectedModel,
        providerModels: sendCtx.selectedProviderModels,
        promptEffort: sendCtx.selectedPromptEffort,
        modelSelection: sendCtx.selectedModelSelection,
        runtimeMode,
        interactionMode,
      },
      { preserveComposer: true, id: messageId, activate: true },
    );
  };

  const resolveAsyncQuestions = async (questions: readonly AsyncQuestion[]): Promise<boolean> => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !activeThread || !isServerThread) return false;
    const groups = new Map<string, number[]>();
    for (const question of questions) {
      if (!question.activityId || question.questionIndex === undefined) return false;
      const indexes = groups.get(question.activityId) ?? [];
      indexes.push(question.questionIndex);
      groups.set(question.activityId, indexes);
    }
    try {
      for (const [activityId, questionIndexes] of groups)
        await api.orchestration.dispatchCommand({
          type: "thread.async-questions.resolve",
          commandId: newCommandId(),
          threadId: activeThread.id,
          activityId: EventId.make(activityId),
          questionIndexes,
          createdAt: new Date().toISOString(),
        });
      return true;
    } catch {
      return false;
    }
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

  const dispatchFollowUpTurnStart = async (
    item: FollowUpQueueItem,
    options?: { independentAnswer?: boolean },
  ) => {
    if (!ownsQueuedThread(item.environmentId, item.threadId)) return;
    if (manualStopBarrierByThreadIdRef.current[item.threadId] !== undefined) return;
    // A Stop followed by a newer explicit input may clear the visible barrier
    // while this older attempt is still preparing attachments/settings. The
    // monotonic, shared thread generation fences that old continuation even
    // across a pane close/remount; checking only the current boolean cannot.
    const stopGeneration = manualStopGenerationByThreadIdRef.current[item.threadId] ?? 0;
    const wasStoppedDuringPreparation = () =>
      manualStopBarrierByThreadIdRef.current[item.threadId] !== undefined ||
      (manualStopGenerationByThreadIdRef.current[item.threadId] ?? 0) !== stopGeneration;
    const stoppedBeforeSubmissionMessage =
      "Stopped before sending. Select this queued message to send it.";
    if (
      item.dispatchState === "claimed" ||
      (item.automaticSteerRetry && item.blockedReason !== null)
    )
      return;
    if (
      !options?.independentAnswer &&
      useComposerDraftStore
        .getState()
        .getComposerDraft(scopeThreadRef(item.environmentId, item.threadId))?.queueEditingItemId
    )
      return;
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
    if (queuedThread.projectId === null && !supportsStandaloneChats(queuedThread.environmentId)) {
      blockFollowUpQueueItem(
        item.threadId,
        item.id,
        "Update the server to send messages in standalone chats.",
      );
      return;
    }
    if (queuedThread.projectId !== null && !queuedProject) {
      blockFollowUpQueueItem(item.threadId, item.id, "Project metadata is not loaded yet.");
      return;
    }
    const concurrencyIssue = readSubagentConcurrencyAdmissionError({
      environmentId: queuedThread.environmentId,
      modelSelection: item.modelSelection,
      provider: item.provider,
      // Queued input intentionally does not replace durable policy with a
      // captured old preference. The current owning thread is authoritative.
      limits: queuedThread.subagentLimits,
    });
    if (concurrencyIssue) {
      blockFollowUpQueueItem(item.threadId, item.id, concurrencyIssue);
      return;
    }
    if (
      sendInFlightRef.current ||
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

    // Automatic retry items retain the original durable message identity.
    // This lets a successful provider receipt or turn retarget survive reload
    // and prevents the old failure activity from manufacturing another copy.
    const messageIdForSend = item.automaticSteerRetry?.sourceMessageId ?? MessageId.make(item.id);
    const commandIdForSend = item.automaticSteerRetry ? newCommandId() : CommandId.make(item.id);
    const claim: FollowUpQueueClaim = {
      environmentId: item.environmentId,
      threadId: item.threadId,
      itemId: item.id,
      messageId: messageIdForSend,
      commandId: commandIdForSend,
    };
    const parkUnattemptedItem = async (reason: string) => {
      if (item.automaticSteerRetry) return;
      // A pending item is safe to retry, but retry is still explicit after a
      // Stop or preparation failure. Persist its blocked flag through exact
      // compare-and-replace so reloading cannot silently resume stopped work.
      const parked = await queuePersistence.replacePending(item, {
        ...item,
        blockedReason: reason,
      });
      if (!parked.ok)
        toastManager.add({
          type: "error",
          title: "Queued message was not sent, but its paused state could not be saved",
          description: parked.error,
        });
    };
    if (!item.automaticSteerRetry) {
      const saved =
        item.dispatchState === undefined
          ? await persistFollowUpQueues(item.environmentId, { [item.threadId]: [item] })
          : { ok: true as const };
      if (!saved.ok) {
        blockFollowUpQueueItem(item.threadId, item.id, saved.error);
        setQueueDispatchInFlight(false);
        if (isVisibleThread) {
          setSendInFlight(false);
          resetLocalDispatch();
        }
        return;
      }
      if (wasStoppedDuringPreparation()) {
        await parkUnattemptedItem(stoppedBeforeSubmissionMessage);
        blockFollowUpQueueItem(item.threadId, item.id, stoppedBeforeSubmissionMessage);
        setQueueDispatchInFlight(false);
        if (isVisibleThread) {
          setSendInFlight(false);
          resetLocalDispatch();
        }
        return;
      }
    }
    const messageCreatedAt = item.automaticSteerRetry ? new Date().toISOString() : item.queuedAt;
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
    let providerSubmissionAttempted = false;
    let stoppedBeforeSubmission = false;
    try {
      // Observe both parallel preparations immediately so an early attachment
      // rejection cannot become unhandled while settings persistence is slow.
      const [, turnAttachments] = await Promise.all([
        persistThreadSettingsForNextTurn({
          thread: queuedThread,
          threadId: item.threadId,
          createdAt: messageCreatedAt,
          modelSelection: item.modelSelection,
          runtimeMode: item.runtimeMode,
          interactionMode: item.interactionMode,
        }),
        turnAttachmentsPromise,
      ]);
      if (wasStoppedDuringPreparation()) {
        stoppedBeforeSubmission = true;
        throw new Error(stoppedBeforeSubmissionMessage);
      }
      // Claim only at the actual delivery boundary, after all awaited setup.
      // Stop during setup leaves a definitely unattempted durable pending item,
      // rather than manufacturing an ambiguous claim that cannot be retried.
      // Keep claim + provider submission in the same synchronous continuation:
      // no user Stop event can interleave between the final fence and I/O.
      if (!item.automaticSteerRetry) {
        const claimed = queuePersistence.claim(claim, item);
        if (!claimed.ok) throw new Error(claimed.error);
      }
      providerSubmissionAttempted = true;
      // Concurrency belongs to the chat, not the queued message. Omit the
      // optional replacement here so the server reads its current durable
      // policy; an edit made during awaited attachment preparation must not
      // be overwritten by the older queuedThread snapshot.
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: commandIdForSend,
        threadId: item.threadId,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        modelSelection: item.modelSelection,
        ...(item.deliveryPriority !== undefined ? { deliveryPriority: item.deliveryPriority } : {}),
        titleSeed: queuedThread.title,
        runtimeMode: item.runtimeMode,
        interactionMode: item.interactionMode,
        createdAt: messageCreatedAt,
      });

      turnStartSucceeded = true;
      if (!item.automaticSteerRetry) {
        const settled = queuePersistence.settleClaim(claim);
        if (!settled.ok)
          toastManager.add({
            type: "error",
            title: "Message accepted, but queue cleanup failed",
            description: settled.error,
          });
      }
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
      const queuedFollowUpError = describeSendFailureMessage(
        err,
        "Failed to send queued follow-up.",
      );
      if (!providerSubmissionAttempted) await parkUnattemptedItem(queuedFollowUpError);
      setFollowUpQueueByThreadId((existing) => ({
        ...existing,
        [item.threadId]: [
          {
            ...item,
            blockedReason:
              item.automaticSteerRetry && isIndeterminateTransportError(err)
                ? "Delivery status is unknown. Inspect the timeline before removing this queued message."
                : queuedFollowUpError,
            ...(item.automaticSteerRetry
              ? isIndeterminateTransportError(err)
                ? {
                    dispatchState: "claimed" as const,
                    claimedDispatch: { commandId: commandIdForSend, messageId: messageIdForSend },
                  }
                : {
                    automaticSteerRetry: {
                      ...item.automaticSteerRetry,
                      dispatchFailed: true as const,
                    },
                  }
              : {}),
            ...(!item.automaticSteerRetry && providerSubmissionAttempted
              ? {
                  dispatchState: "claimed" as const,
                  claimedDispatch: { commandId: commandIdForSend, messageId: messageIdForSend },
                }
              : {}),
          },
          ...(existing[item.threadId] ?? EMPTY_FOLLOW_UP_QUEUE),
        ],
      }));
      // A user cancellation is a parked queue item, not a failed provider turn.
      // Its visible row explains how to resume without adding an error banner.
      if (!stoppedBeforeSubmission) setThreadError(item.threadId, queuedFollowUpError);
      if (item.automaticSteerRetry) {
        recordFollowUpQueueDebugAttempt(
          "automatic-steer-retry",
          isIndeterminateTransportError(err)
            ? "dispatch-unknown-blocked"
            : "dispatch-failed-blocked",
          {
            threadId: item.threadId,
            itemId: item.id,
          },
        );
      }
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
    options?: { queuedItem?: FollowUpQueueItem; independentAnswer?: boolean },
  ) => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !activeThread) return;
    if (
      options?.queuedItem?.dispatchState === "claimed" ||
      (options?.queuedItem?.automaticSteerRetry && options.queuedItem.blockedReason !== null)
    )
      return;
    if (
      !options?.independentAnswer &&
      useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.queueEditingItemId
    )
      return;
    if (sendInFlightRef.current || queueDispatchInFlightRef.current) return;
    const composerContentAtAdmission = useComposerDraftStore
      .getState()
      .getComposerDraft(composerDraftTarget);
    // A native steer has no model/account selection: it always reaches the
    // existing session. Priority from a newly selected Claude account must
    // wait in its captured queue snapshot until that account can start.
    const priorityAdmissionSession =
      snapshot.deliveryPriority !== undefined
        ? selectThreadByRef(
            useStore.getState(),
            scopeThreadRef(activeThread.environmentId, activeThread.id),
          )?.session
        : undefined;
    const priorityMatchesSession =
      snapshot.deliveryPriority === undefined ||
      (priorityAdmissionSession?.activeTurnId !== undefined &&
        canSteerPriorityToSession(snapshot, priorityAdmissionSession));
    if (!activeProviderLiveSteerAvailable || phase !== "running" || !priorityMatchesSession) {
      if (!options?.queuedItem) {
        await enqueueFollowUpSnapshot(snapshot);
      }
      return;
    }

    if (
      shouldBackpressurePendingSteerDispatch(
        Object.keys(pendingSteerDispatchByMessageIdRef.current).length,
      )
    ) {
      // Keep the pending index bounded without discarding its oldest entries.
      // New direct input moves to the visible follow-up shelf; an item already
      // on that shelf stays in place until earlier steers settle.
      if (!options?.queuedItem) {
        await enqueueFollowUpSnapshot(snapshot);
      }
      recordFollowUpQueueDebugAttempt("steer-backpressure", "pending-capacity-reached", {
        threadId: activeThread.id,
        itemId: options?.queuedItem?.id ?? null,
      });
      return;
    }

    setSendInFlight(true);
    // Finish asynchronous priority preparation before taking a durable claim.
    // A local account/runtime change is definitely unsubmitted, so it must not
    // become an ambiguous claimed row merely because file reading took time.
    let priorityTurnAttachments: OrchestrationUploadChatAttachment[] | undefined;
    if (snapshot.deliveryPriority !== undefined) {
      try {
        priorityTurnAttachments = await buildAttachmentsForSnapshot(snapshot);
      } catch (error) {
        const message = describeSendFailureMessage(error, "Failed to prepare the message.");
        if (options?.queuedItem) {
          blockFollowUpQueueItem(options.queuedItem.threadId, options.queuedItem.id, message);
        } else {
          setThreadError(activeThread.id, message);
        }
        setSendInFlight(false);
        return;
      }
    }
    const messageIdForSend =
      options?.queuedItem?.automaticSteerRetry?.sourceMessageId ??
      (options?.queuedItem ? MessageId.make(options.queuedItem.id) : newMessageId());
    const commandIdForSend =
      options?.queuedItem && !options.queuedItem.automaticSteerRetry
        ? CommandId.make(options.queuedItem.id)
        : newCommandId();
    const claim: FollowUpQueueClaim | null =
      options?.queuedItem && !options.queuedItem.automaticSteerRetry
        ? {
            environmentId: options.queuedItem.environmentId,
            threadId: options.queuedItem.threadId,
            itemId: options.queuedItem.id,
            messageId: messageIdForSend,
            commandId: commandIdForSend,
          }
        : null;
    if (claim) {
      const saved =
        options?.queuedItem?.dispatchState === undefined
          ? await persistFollowUpQueues(claim.environmentId, {
              [claim.threadId]: [options!.queuedItem!],
            })
          : { ok: true as const };
      if (!saved.ok) {
        blockFollowUpQueueItem(claim.threadId, claim.itemId, saved.error);
        setSendInFlight(false);
        return;
      }
    }
    if (snapshot.deliveryPriority !== undefined) {
      const currentSession = selectThreadByRef(
        useStore.getState(),
        scopeThreadRef(activeThread.environmentId, activeThread.id),
      )?.session;
      if (
        !priorityAdmissionSession ||
        currentSession?.status !== "running" ||
        !canSteerPriorityToSession(snapshot, currentSession, priorityAdmissionSession)
      ) {
        setSendInFlight(false);
        // Existing queued input has not been claimed or removed. Direct input
        // becomes that same immutable queue snapshot, preserving its account
        // and priority while protecting any composer text typed during prep.
        if (!options?.queuedItem) {
          const queued = await enqueueFollowUpSnapshot(snapshot, { preserveComposer: true });
          if (queued) clearActiveComposerContent(composerContentAtAdmission);
        }
        return;
      }
    }
    if (claim) {
      const claimed = queuePersistence.claim(claim, options!.queuedItem!);
      if (!claimed.ok) {
        blockFollowUpQueueItem(claim.threadId, claim.itemId, claimed.error);
        setSendInFlight(false);
        return;
      }
    }
    const messageCreatedAt =
      claim && options?.queuedItem ? options.queuedItem.queuedAt : new Date().toISOString();
    const outgoingMessageText = outgoingTextForSnapshot(snapshot);
    const optimisticAttachments = optimisticAttachmentsForSnapshot(snapshot);
    const turnAttachmentsPromise =
      priorityTurnAttachments === undefined ? buildAttachmentsForSnapshot(snapshot) : undefined;

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
          intentSequence: null,
        },
      };
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
      // Priority's reads completed before the canonical admission above; do
      // not introduce another await between that check and command dispatch.
      const turnAttachments = priorityTurnAttachments ?? (await turnAttachmentsPromise!);
      const receipt = await api.orchestration.dispatchCommand({
        type: "thread.turn.steer",
        commandId: commandIdForSend,
        threadId: activeThread.id,
        ...(snapshot.deliveryPriority !== undefined
          ? {
              deliveryPriority: snapshot.deliveryPriority,
              expectedPrioritySession: {
                providerInstanceId: snapshot.modelSelection.instanceId,
                subagentRuntimeId: priorityAdmissionSession?.subagentRuntimeId
                  ? SubagentRuntimeId.make(priorityAdmissionSession.subagentRuntimeId)
                  : null,
                activeTurnId: priorityAdmissionSession!.activeTurnId!,
              },
            }
          : {}),
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        createdAt: messageCreatedAt,
      });
      if (claim) {
        const settled = queuePersistence.settleClaim(claim);
        if (!settled.ok)
          toastManager.add({
            type: "error",
            title: "Message accepted, but queue cleanup failed",
            description: settled.error,
          });
      }
      updatePendingSteerDispatches((current) => {
        const pending = current[String(messageIdForSend)];
        if (pending?.dispatchedAt !== messageCreatedAt) {
          return current;
        }
        return {
          ...current,
          [String(messageIdForSend)]: { ...pending, intentSequence: receipt.sequence },
        };
      });
      setThreadError(activeThread.id, null);
      if (!options?.queuedItem) {
        clearActiveComposerContent(composerContentAtAdmission);
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
            {
              ...options.queuedItem!,
              // The RPC layer already exhausts its exact-command reconnect
              // recovery before rejecting. Re-admitting this unchanged row
              // on every render would create new command IDs indefinitely.
              // Preserve the durable source message and require explicit retry.
              ...(options.queuedItem!.automaticSteerRetry
                ? isIndeterminateTransportError(err)
                  ? {
                      dispatchState: "claimed" as const,
                      claimedDispatch: { commandId: commandIdForSend, messageId: messageIdForSend },
                      blockedReason:
                        "Delivery status is unknown. Inspect the timeline before removing this queued message.",
                    }
                  : {
                      blockedReason:
                        "Delivery paused. Your message and attachments are preserved. You can retry delivery.",
                      automaticSteerRetry: {
                        ...options.queuedItem!.automaticSteerRetry,
                        dispatchFailed: true as const,
                      },
                    }
                : {}),
              ...(claim
                ? {
                    dispatchState: "claimed" as const,
                    claimedDispatch: { commandId: claim.commandId, messageId: claim.messageId },
                    blockedReason:
                      "Delivery status is unknown. Inspect the timeline before removing this queued message.",
                  }
                : {}),
            },
            ...(existing[options.queuedItem!.threadId] ?? EMPTY_FOLLOW_UP_QUEUE),
          ],
        }));
        if (options.queuedItem.automaticSteerRetry) {
          recordFollowUpQueueDebugAttempt(
            "automatic-steer-retry",
            isIndeterminateTransportError(err)
              ? "dispatch-unknown-blocked"
              : "dispatch-failed-blocked",
            {
              threadId: options.queuedItem.threadId,
              itemId: options.queuedItem.id,
            },
          );
        }
      } else if (promptRef.current.length === 0 && composerImagesRef.current.length === 0) {
        restoreComposerSnapshotForRetry(snapshot);
      }
      setThreadError(activeThread.id, describeSendFailureMessage(err, "Failed to steer turn."));
    } finally {
      setSendInFlight(false);
    }
  };
  dispatchQueuedSteerRetryRef.current = (item) => dispatchSteerSnapshot(item, { queuedItem: item });

  useEffect(() => {
    if (!canSteerFollowUpQueue || !activeThread) {
      return;
    }
    // A queued retry is automatic, so it cannot clear or race the user's Stop
    // barrier. Explicit send actions remain the only renderer path that clears it.
    if (manualStopBarrierByThreadIdRef.current[activeThread.id] !== undefined) return;

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
    followUpQueueByThreadIdRef,
    manualStopBarrierByThreadIdRef,
  ]);

  const onSend = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    if (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.queueEditingItemId)
      return;
    const api = readEnvironmentApi(environmentId);
    if (
      !api ||
      !activeThread ||
      isSendBusy ||
      isComposerConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current ||
      queueDispatchInFlightRef.current
    )
      return;
    if (activePendingUserInput?.interaction) return;
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return;
    }
    // Control-only commands do not request a new numeric process policy. Keep
    // /compact and goal inspection/editing available while a pending override
    // needs Reset; ordinary sends are admitted below before any dispatch.
    const snapshot = readComposerSnapshotForDispatch(false);
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
      fileCount: snapshot.files.length,
    });
    const compactionCommand = parseComposerCompactionCommand(ctxSelectedProvider, trimmed);
    if (compactionCommand !== null) {
      const issue =
        compactionCommand === "invalid-arguments"
          ? "Use /compact on its own, without additional instructions."
          : composerImages.length || snapshot.files.length
            ? "Remove attachments before running /compact."
            : followUpQueuePhase === "running" || followUpQueuePhase === "connecting"
              ? "Wait for the current turn to finish before compacting."
              : followUpQueuePhase === "disconnected"
                ? "Resume this conversation before running /compact."
                : !activeThread.session ||
                    activeThread.session.providerInstanceId !== ctxSelectedModelSelection.instanceId
                  ? "Start a conversation with the selected provider before compacting."
                  : null;
      if (issue) {
        setThreadError(activeThread.id, issue);
        return;
      }
      sendInFlightRef.current = true;
      const commandId = newCommandId();
      const createdAt = new Date().toISOString();
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.compact",
          commandId,
          threadId: activeThread.id,
          providerInstanceId: ctxSelectedModelSelection.instanceId,
          createdAt,
        });
        // Do not erase text or attachments added while the request was pending.
        const current = readComposerSnapshotForDispatch(false);
        if (
          current?.promptText === promptForSend &&
          current.images.length === 0 &&
          current.files.length === 0
        ) {
          promptRef.current = "";
          clearComposerDraftContent(composerDraftTarget);
          composerRef.current?.resetCursorState();
        }
        scheduleComposerFocus();
      } catch (cause) {
        setThreadError(
          activeThread.id,
          cause instanceof Error ? cause.message : "Compaction could not be requested.",
        );
      } finally {
        sendInFlightRef.current = false;
      }
      return;
    }
    const standaloneGoalCommand =
      composerImages.length === 0 && snapshot.files.length === 0 && goalControlsSupported
        ? parseStandaloneComposerGoalCommand(trimmed)
        : null;
    if (standaloneGoalCommand !== null) {
      if (standaloneGoalCommand.action === "set" || standaloneGoalCommand.action === "resume") {
        updateManualStopBarrier(activeThread.id, null);
      }
      try {
        const goal = activeThread.goal ?? null;
        switch (standaloneGoalCommand.action) {
          case "show":
            openThreadGoalDialog();
            break;
          case "edit":
            openThreadGoalDialog({ mode: "edit" });
            break;
          case "set":
            if (goal === null) {
              await setThreadGoal({
                objective: standaloneGoalCommand.objective,
                status: "active",
                tokenBudget: null,
              });
            } else if (goal.status === "complete") {
              await setThreadGoal({
                objective: standaloneGoalCommand.objective,
                replaceExisting: true,
              });
            } else {
              openThreadGoalDialog({
                mode: "replace",
                seedObjective: standaloneGoalCommand.objective,
                confirmReplacement: true,
              });
            }
            break;
          case "pause":
            if (goal === null) {
              openThreadGoalDialog({ mode: "edit" });
            } else {
              await setThreadGoal({ status: "paused" });
            }
            break;
          case "resume":
            if (goal === null) {
              openThreadGoalDialog({ mode: "edit" });
            } else {
              await setThreadGoal({ status: "active" });
            }
            break;
          case "clear":
            if (goal !== null) {
              await clearThreadGoal();
            }
            break;
        }
      } catch (cause) {
        setThreadError(
          activeThread.id,
          cause instanceof Error ? cause.message : "The goal command could not be queued.",
        );
        return;
      }
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      scheduleComposerFocus();
      return;
    }
    if (!admitComposerTurnPolicy(snapshot)) return;
    // Sending new user intent explicitly releases a prior Stop barrier. The
    // queue watchdog itself never clears this state.
    updateManualStopBarrier(activeThread.id, null);
    const delivery = decideFollowUpDelivery({
      phase: followUpQueuePhase,
      requestedSteer: snapshot.deliveryPriority !== undefined,
      liveSteerSupported:
        activeProviderLiveSteerAvailable &&
        canSteerPriorityToSession(snapshot, activeThread.session),
    });
    if (delivery === "queue") {
      if (!hasSendableContent) return;
      pinTimelineToEndForLocalMessage();
      await enqueueFollowUpSnapshot(snapshot);
      return;
    }
    if (delivery === "steer") {
      await dispatchSteerSnapshot(snapshot);
      return;
    }
    if (
      showPlanFollowUpPrompt &&
      activeProposedPlan &&
      snapshot.files.length === 0 &&
      snapshot.images.length === 0
    ) {
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
      composerImages.length === 0 && snapshot.files.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      scheduleComposerFocus();
      return;
    }
    if (!hasSendableContent) return;
    if (activeThread.projectId !== null && !activeProject) return;
    if (activeThread.projectId === null && !supportsStandaloneChats(activeThread.environmentId)) {
      setThreadError(activeThread.id, "Update the server to send messages in standalone chats.");
      return;
    }
    const threadIdForSend = activeThread.id;
    // Everything below may settle after a route transition. Capture the exact
    // environment/thread and composer target that owned this attempt instead
    // of consulting the then-current ChatView props from asynchronous cleanup.
    const sendAttemptThreadRef = routeThreadRef;
    const sendAttemptThreadKey = routeThreadKey;
    const sendAttemptComposerDraftTarget = composerDraftTarget;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const baseBranchForWorktree =
      activeThread.projectId !== null &&
      isFirstMessage &&
      sendEnvMode === "worktree" &&
      !activeThread.worktreePath
        ? activeThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      activeThread.projectId !== null &&
      isFirstMessage &&
      sendEnvMode === "worktree" &&
      !activeThread.worktreePath;
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
      text:
        messageTextForSend ||
        (snapshot.files.length > 0 ? FILE_ONLY_BOOTSTRAP_PROMPT : IMAGE_ONLY_BOOTSTRAP_PROMPT),
    });
    const turnAttachmentsPromise = buildAttachmentsForSnapshot(snapshot);
    const optimisticAttachments = optimisticAttachmentsForSnapshot(snapshot);
    pinTimelineToEndForLocalMessage();

    setOptimisticUserMessages((existing) => {
      const ownsExistingMessages =
        optimisticUserMessagesOwnerThreadKeyRef.current === sendAttemptThreadKey;
      if (!ownsExistingMessages) {
        for (const message of existing) {
          revokeUserMessagePreviewUrls(message);
        }
      }
      optimisticUserMessagesOwnerThreadKeyRef.current = sendAttemptThreadKey;
      return [
        ...(ownsExistingMessages ? existing : []),
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ];
    });

    setThreadError(threadIdForSend, null);
    promptRef.current = "";
    clearComposerDraftContent(sendAttemptComposerDraftTarget);
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
        } else if (snapshot.files[0]) {
          titleSeed = `File: ${snapshot.files[0].name}`;
        } else {
          titleSeed = "New chat";
        }
      }
      const title = truncate(titleSeed);
      const threadCreateModelSelection = createModelSelection(
        ctxSelectedModelSelection.instanceId,
        ctxSelectedModel || activeProject?.defaultModelSelection?.model || DEFAULT_MODEL,
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
                      projectId: activeThread.projectId,
                      title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode,
                      interactionMode,
                      ...(snapshot.subagentLimits !== undefined
                        ? { subagentLimits: snapshot.subagentLimits }
                        : {}),
                      branch: activeThread.projectId === null ? null : activeThreadBranch,
                      worktreePath:
                        activeThread.projectId === null ? null : activeThread.worktreePath,
                      createdAt: activeThread.createdAt,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree && activeProject
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
        ...(snapshot.deliveryPriority !== undefined
          ? { deliveryPriority: snapshot.deliveryPriority }
          : {}),
        ...(snapshot.subagentLimits !== undefined
          ? { subagentLimits: snapshot.subagentLimits }
          : {}),
        runtimeMode,
        interactionMode,
        ...(bootstrap ? { bootstrap } : {}),
        createdAt: messageCreatedAt,
      });

      // A successful direct retry supersedes the prior delivery failure.
      // Remove the occurrence notification immediately instead of leaving
      // stale failure feedback beside an optimistic message now admitted by
      // the server. The route key is the same canonical environment/thread
      // identity used when the failure toast was created below.
      const previousFailureToastId =
        directSendFailureToastIdByThreadKeyRef.current.get(sendAttemptThreadKey);
      if (previousFailureToastId !== undefined) {
        directSendFailureToastIdByThreadKeyRef.current.delete(sendAttemptThreadKey);
        toastManager.close(previousFailureToastId);
      }
      setThreadError(threadIdForSend, null, sendAttemptThreadRef);
      turnStartSucceeded = true;
    })().catch((err: unknown) => {
      const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
      const draftRestored =
        !turnStartSucceeded &&
        restoreComposerDraftContentIfEmpty(sendAttemptComposerDraftTarget, {
          prompt: promptForSend,
          images: retryComposerImages,
          files: snapshot.files.map((file) =>
            composerFileFromAttachment(sendAttemptThreadRef.environmentId, threadIdForSend, file),
          ),
        });
      const restoredPreviewUrls = new Set(
        draftRestored ? retryComposerImages.map((image) => image.previewUrl) : [],
      );

      // Rejection is conclusive: the optimistic row must always disappear,
      // even when newer content prevents the original draft from being put
      // back. Preview ownership transfers to the restored draft only when the
      // compare-and-swap above succeeds.
      setOptimisticUserMessages((existing) => {
        const removed = existing.filter((message) => message.id === messageIdForSend);
        for (const message of removed) {
          for (const previewUrl of collectUserMessageBlobPreviewUrls(message)) {
            if (!restoredPreviewUrls.has(previewUrl)) {
              revokeBlobPreviewUrl(previewUrl);
            }
          }
        }
        const next = existing.filter((message) => message.id !== messageIdForSend);
        return next.length === existing.length ? existing : next;
      });
      if (!draftRestored) {
        for (const image of retryComposerImages) {
          revokeBlobPreviewUrl(image.previewUrl);
        }
      }

      const sendAttemptIsStillVisible =
        chatViewMountedRef.current && currentRouteThreadKeyRef.current === sendAttemptThreadKey;
      if (draftRestored && sendAttemptIsStillVisible) {
        promptRef.current = promptForSend;
        composerImagesRef.current = retryComposerImages;
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(promptForSend, promptForSend.length),
          prompt: promptForSend,
          detectTrigger: true,
        });
        scheduleComposerFocus();
      }
      const sendFailureMessage = describeSendFailureMessage(err, "Failed to send message.");
      setThreadError(threadIdForSend, sendFailureMessage, sendAttemptThreadRef);

      // ThreadErrorBanner deliberately remembers an exact dismissed provider
      // error so an unchanged authoritative snapshot cannot nag the user on
      // every poll. A local send rejection is different: every press is a new
      // delivery attempt, and silently restoring the draft can look exactly
      // like the button did nothing when the same failure repeats. Emit an
      // occurrence-based toast for each rejected turn/start while retaining
      // the thread error above for durable context. Scope the toast to this
      // thread so it cannot expose an operational failure after navigation.
      const previousFailureToastId =
        directSendFailureToastIdByThreadKeyRef.current.get(sendAttemptThreadKey);
      if (previousFailureToastId !== undefined) {
        directSendFailureToastIdByThreadKeyRef.current.delete(sendAttemptThreadKey);
        toastManager.close(previousFailureToastId);
      }

      if (!sendAttemptIsStillVisible) return;

      let failureToastId!: ReturnType<typeof toastManager.add>;
      failureToastId = toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Message was not sent",
          description: sendFailureMessage,
          data: {
            // Use the route-owned canonical ref rather than rebuilding scope
            // from projected thread data. Toast filtering and navigation both
            // derive identity from this exact environment/thread pair.
            threadRef: sendAttemptThreadRef,
            onClose: () => {
              if (
                directSendFailureToastIdByThreadKeyRef.current.get(sendAttemptThreadKey) ===
                failureToastId
              ) {
                directSendFailureToastIdByThreadKeyRef.current.delete(sendAttemptThreadKey);
              }
            },
          },
        }),
      );
      directSendFailureToastIdByThreadKeyRef.current.set(sendAttemptThreadKey, failureToastId);
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
    if (activePendingUserInput?.interaction) return;
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return;
    }
    const snapshot = readComposerSnapshotForDispatch(false);
    if (!snapshot) return;
    if (parseComposerCompactionCommand(snapshot.provider, snapshot.promptText) !== null) {
      await onSend(e);
      return;
    }
    if (!admitComposerTurnPolicy(snapshot)) return;
    const { hasSendableContent } = deriveComposerSendState({
      prompt: snapshot.promptText,
      imageCount: snapshot.images.length,
      fileCount: snapshot.files.length,
    });
    if (!hasSendableContent) return;
    updateManualStopBarrier(activeThread.id, null);
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
      await enqueueFollowUpSnapshot(snapshot);
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
        if (
          !canExpandQueuedFollowUpText(item.promptText) &&
          item.images.length === 0 &&
          item.files.length === 0
        ) {
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
    updateManualStopBarrier(item.threadId, null);
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
    if (
      !item ||
      item.environmentId !== environmentId ||
      queueEditingItemId ||
      item.dispatchState === "claimed"
    )
      return;

    if (item.automaticSteerRetry?.dispatchFailed) {
      if (!canRetryAutomaticSteerItem(item)) return;
      // Retrying is a new delivery attempt for the exact durable input, never
      // an edited/new message. The server remains the final content-identity
      // and retry-authority guard, including races with another renderer.
      const retryItem: FollowUpQueueItem = {
        ...item,
        blockedReason: null,
        automaticSteerRetry: {
          sourceMessageId: item.automaticSteerRetry.sourceMessageId,
          nonSteerableTurnKind: item.automaticSteerRetry.nonSteerableTurnKind,
          ...(item.automaticSteerRetry.legacyRootCompletionRetry
            ? { legacyRootCompletionRetry: item.automaticSteerRetry.legacyRootCompletionRetry }
            : {}),
        },
      };
      recordFollowUpQueueDebugAttempt("manual-steer-retry", "dispatch-requested", {
        threadId: item.threadId,
        itemId: item.id,
      });
      updateManualStopBarrier(item.threadId, null);
      if (followUpQueuePhase === "running") {
        void dispatchSteerSnapshot(retryItem, { queuedItem: retryItem });
      } else {
        void dispatchFollowUpTurnStartRef.current?.(retryItem);
      }
      return;
    }

    // Clicking a specific queued row is explicit delivery intent and is the
    // renderer equivalent of upstream's interrupt-and-submit path.
    updateManualStopBarrier(item.threadId, null);
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
    if (queueEditingItemId || sendInFlightRef.current || queueDispatchInFlightRef.current) return;
    const item = followUpQueueByThreadIdRef.current[activeThreadId]?.find(
      (entry) => entry.id === itemId,
    );
    if (!item) return;
    if (!item.automaticSteerRetry) {
      const scope = { environmentId: item.environmentId, threadId: item.threadId, itemId: item.id };
      const removed = item.claimedDispatch
        ? queuePersistence.settleClaim({ ...scope, ...item.claimedDispatch })
        : queuePersistence.removePending(scope);
      if (!removed.ok) {
        setThreadError(activeThreadId, removed.error);
        return;
      }
    }
    removeFollowUpQueueItem(activeThreadId, itemId, true);
  };

  const onEditFollowUpQueueItem = async (itemId: string) => {
    if (
      !activeThread ||
      sendInFlightRef.current ||
      queueDispatchInFlightRef.current ||
      queueEditingItemId
    )
      return;
    const item = followUpQueueByThreadIdRef.current[activeThread.id]?.find(
      (entry) => entry.id === itemId,
    );
    if (
      !item ||
      item.automaticSteerRetry ||
      item.dispatchState === "claimed" ||
      item.environmentId !== activeThread.environmentId ||
      activeThread.messages.some((message) => message.id === item.id)
    )
      return;
    const persisted = queuePersistence.load(item.environmentId);
    if (
      !persisted.ok ||
      !persisted.value.pending.some(
        (entry) => entry.id === item.id && entry.threadId === item.threadId,
      )
    ) {
      setThreadError(
        activeThread.id,
        "This queued message is no longer safely editable. Reload to check its delivery status.",
      );
      return;
    }
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(composerDraftTarget);
    setSendInFlight(true);
    setQueueDispatchInFlight(true);
    try {
      if (draft && draft.images.length > 0) {
        // Finish encoding the parked draft before switching the composer: its
        // old persistence effect is cancelled when the editable images change.
        const persisted = await Promise.all(
          draft.images.map(async (image) => ({
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl: await readFileAsDataUrl(image.file),
          })),
        );
        store.syncPersistedAttachments(composerDraftTarget, persisted);
      }
      if (!flushComposerDraftPersistence()) throw new Error("draft persistence failed");
    } catch {
      setThreadError(
        activeThread.id,
        "The current draft could not be saved. Keep it open and retry editing the queue after freeing browser storage.",
      );
      return;
    } finally {
      setSendInFlight(false);
      setQueueDispatchInFlight(false);
    }
    if (
      !store.beginQueueEdit(composerDraftTarget, item.id, {
        prompt: item.promptText,
        images: item.images.map(cloneComposerImageForRetry),
        files: item.files.map((attachment) =>
          composerFileFromAttachment(item.environmentId, item.threadId, attachment),
        ),
        modelSelection: item.modelSelection,
        runtimeMode: item.runtimeMode,
        interactionMode: item.interactionMode,
      })
    )
      return;
    if (!flushComposerDraftPersistence()) {
      store.finishQueueEdit(composerDraftTarget);
      setThreadError(
        activeThread.id,
        "The current draft could not be saved. Queue editing was cancelled; your draft is still here.",
      );
      return;
    }
    if (currentRouteThreadKeyRef.current !== routeThreadKey) return;
    promptRef.current = item.promptText;
    composerImagesRef.current = store.getComposerDraft(composerDraftTarget)?.images ?? [];
    composerRef.current?.resetCursorState({ prompt: item.promptText });
    scheduleComposerFocus();
  };

  const finishQueueEditing = (retainImages: boolean) => {
    if (sendInFlightRef.current || queueDispatchInFlightRef.current) return;
    const store = useComposerDraftStore.getState();
    store.finishQueueEdit(composerDraftTarget, retainImages);
    if (!flushComposerDraftPersistence())
      toastManager.add({
        type: "error",
        title: "Your restored draft could not be saved",
        description: "Keep this page open and free browser storage before reloading.",
      });
    if (currentRouteThreadKeyRef.current !== routeThreadKey) return;
    const restored = store.getComposerDraft(composerDraftTarget);
    promptRef.current = restored?.prompt ?? "";
    composerImagesRef.current = restored?.images ?? [];
    composerRef.current?.resetCursorState({ prompt: promptRef.current });
    scheduleComposerFocus();
  };

  const onSaveQueueEdit = async () => {
    if (
      !activeThread ||
      !queueEditingItemId ||
      sendInFlightRef.current ||
      queueDispatchInFlightRef.current
    )
      return;
    const snapshot = readComposerSnapshotForDispatch();
    if (
      !snapshot ||
      (!snapshot.promptText.trim() && snapshot.images.length === 0 && snapshot.files.length === 0)
    )
      return;
    if (parseComposerCompactionCommand(snapshot.provider, snapshot.promptText) !== null) {
      setThreadError(
        activeThread.id,
        "Run /compact directly after the current turn finishes; compaction commands cannot be queued.",
      );
      return;
    }
    const current = followUpQueueByThreadIdRef.current[activeThread.id] ?? [];
    if (
      !current.some(
        (item) =>
          item.id === queueEditingItemId &&
          !item.automaticSteerRetry &&
          item.dispatchState !== "claimed",
      ) ||
      activeThread.messages.some((message) => message.id === queueEditingItemId)
    ) {
      setThreadError(
        activeThread.id,
        "This queued message is no longer pending. Cancel editing to restore your previous draft.",
      );
      return;
    }
    const original = current.find((item) => item.id === queueEditingItemId)!;
    const replacement: FollowUpQueueItem = {
      ...original,
      ...snapshot,
      blockedReason: null,
      dispatchState: "pending",
    };
    setSendInFlight(true);
    const saved = await queuePersistence.replacePending(original, replacement);
    setSendInFlight(false);
    if (!saved.ok) {
      setThreadError(activeThread.id, saved.error);
      return;
    }
    revokeQueuedFollowUpPreviewUrls(original);
    setFollowUpQueueByThreadId((latest) => ({
      ...latest,
      [activeThread.id]: (latest[activeThread.id] ?? []).map((item) =>
        item.id === queueEditingItemId && item.dispatchState !== "claimed" ? replacement : item,
      ),
    }));
    finishQueueEditing(true);
  };

  const onClearFollowUpQueue = () => {
    if (!activeThreadId) return;
    if (queueEditingItemId || sendInFlightRef.current || queueDispatchInFlightRef.current) return;
    const current = followUpQueueByThreadIdRef.current[activeThreadId] ?? EMPTY_FOLLOW_UP_QUEUE;
    for (const item of current) onRemoveFollowUpQueueItem(item.id);
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
          if (!ownsQueuedThread(item.environmentId, item.threadId)) return false;
          if (sendInFlightByThread.get(item.threadId)?.current) return false;
          if (item.dispatchState === "claimed") return false;
          if (
            useComposerDraftStore
              .getState()
              .getComposerDraft(scopeThreadRef(item.environmentId, item.threadId))
              ?.queueEditingItemId
          )
            return false;
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
          return canAutoStartQueuedFollowUpTurn({
            queueLength,
            firstItemBlocked: item.blockedReason != null,
            isWorking: queuedPhase === "running",
            isConnecting: queuedPhase === "connecting",
            isEnvironmentUnavailable: isThreadEnvironmentUnavailable(queuedThread),
            isDispatchInFlight:
              queueDispatchInFlightRef.current ||
              queuedFollowUpPendingDispatchByThreadIdRef.current[item.threadId] !== undefined,
            manualStopBarrierActive:
              manualStopBarrierByThreadIdRef.current[item.threadId] !== undefined,
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
      ownsQueuedThread,
      sendInFlightByThread,
      followUpQueueByThreadIdRef,
      queuedFollowUpPendingDispatchByThreadIdRef,
      queueDispatchInFlightRef,
      manualStopBarrierByThreadIdRef,
    ],
  );

  useEffect(() => {
    tryDispatchNextQueuedFollowUp();
  }, [
    allThreads,
    dispatchGateRevision,
    followUpQueueByThreadId,
    queuedFollowUpPendingDispatchByThreadId,
    tryDispatchNextQueuedFollowUp,
    queueOwnershipRevision,
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
    updateManualStopBarrier(activeThread.id, {
      threadId: activeThread.id,
      interruptedTurnId: turnId ?? activeThread.latestTurn?.turnId ?? null,
      requestedAt: new Date().toISOString(),
    });
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

  // MCP answers can contain credentials. Send only through the authenticated
  // live callback transport, never the durable orchestration command ledger.
  const onRespondToInteraction = useCallback(
    async (requestId: ApprovalRequestId, response: ProviderInteractionResponse) => {
      const api = readEnvironmentApi(environmentId);
      if (!activeThreadId || !api?.providerInteractions) {
        throw new Error("Private provider interactions are unavailable.");
      }
      await api.providerInteractions.respond({ threadId: activeThreadId, requestId, response });
    },
    [activeThreadId, environmentId],
  );

  const onResolveInteractionUrl = useCallback(
    async (requestId: ApprovalRequestId) => {
      const api = readEnvironmentApi(environmentId);
      if (!activeThreadId || !api?.providerInteractions) {
        throw new Error("Private provider interactions are unavailable.");
      }
      return api.providerInteractions.resolveUrl({ threadId: activeThreadId, requestId });
    },
    [activeThreadId, environmentId],
  );

  const onSnoozeActivePendingUserInput = useCallback(() => {
    const requestId = activePendingUserInput?.requestId;
    const api = readEnvironmentApi(environmentId);
    if (!requestId || !activeThreadId || !api || activePendingUserInput.isBlocking) {
      return;
    }
    const requestKey = String(requestId);
    if (snoozedUserInputRequestIdsRef.current.has(requestKey)) {
      return;
    }

    snoozedUserInputRequestIdsRef.current.add(requestKey);
    setSnoozedUserInputRequestIds((existing) =>
      existing.includes(requestId) ? existing : [...existing, requestId],
    );
    void api.orchestration
      .dispatchCommand({
        type: "thread.user-input.snooze",
        commandId: newCommandId(),
        threadId: activeThreadId,
        requestId,
        createdAt: new Date().toISOString(),
      })
      .catch(() => {
        // The request may have auto-resolved before the command reached the
        // provider. Remove the optimistic marker so a still-live request can
        // retry on the next interaction; stale requests disappear via events.
        snoozedUserInputRequestIdsRef.current.delete(requestKey);
        setSnoozedUserInputRequestIds((existing) =>
          existing.filter((candidate) => candidate !== requestId),
        );
      });
  }, [activePendingUserInput, activeThreadId, environmentId]);

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      onSnoozeActivePendingUserInput();
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput, onSnoozeActivePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      onSnoozeActivePendingUserInput();
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
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      composerRef,
      onSnoozeActivePendingUserInput,
    ],
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
      onSnoozeActivePendingUserInput();
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
    [activePendingUserInput, composerRef, onSnoozeActivePendingUserInput],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || activePendingUserInput.interaction || !activePendingProgress) {
      return;
    }
    onSnoozeActivePendingUserInput();
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
    onSnoozeActivePendingUserInput,
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
          ...(sendCtx.subagentLimits !== undefined
            ? { subagentLimits: sendCtx.subagentLimits }
            : {}),
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
        setSendInFlight(false);
      } catch (err) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        setThreadError(
          threadIdForSend,
          describeSendFailureMessage(err, "Failed to send plan follow-up."),
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
      composerRef,
      environmentId,
      sendInFlightRef,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    if (
      !api ||
      !activeThread ||
      (activeThread.projectId !== null && !activeProject) ||
      (activeThread.projectId === null && !supportsStandaloneChats(activeThread.environmentId)) ||
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

    // The plan implementation button bypasses the ordinary composer send path.
    // Check its exact owning runtime before creating a thread, so an older
    // server cannot silently discard a remembered numeric execution policy.
    const concurrencyIssue = readSubagentConcurrencyAdmissionError({
      environmentId,
      modelSelection: ctxSelectedModelSelection,
      provider: ctxSelectedProvider,
      limits: sendCtx.subagentLimits ?? activeThread.subagentLimits,
    });
    if (concurrencyIssue) {
      setThreadError(activeThread.id, concurrencyIssue);
      return;
    }

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
    const nextRuntimeMode = runtimeMode;

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
        projectId: activeThread.projectId,
        title: nextThreadTitle,
        ...(sendCtx.subagentLimits !== undefined ? { subagentLimits: sendCtx.subagentLimits } : {}),
        modelSelection: nextThreadModelSelection,
        runtimeMode: nextRuntimeMode,
        interactionMode: "default",
        branch: activeThread.projectId === null ? null : activeThreadBranch,
        worktreePath: activeThread.projectId === null ? null : activeThread.worktreePath,
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
          ...(sendCtx.subagentLimits !== undefined
            ? { subagentLimits: sendCtx.subagentLimits }
            : {}),
          runtimeMode: nextRuntimeMode,
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
    setThreadError,
    composerRef,
    environmentId,
    sendInFlightRef,
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
  const openSubagentDetail = useCallback(
    (workEntry: WorkLogEntry, trigger: HTMLButtonElement) => {
      if (!workEntry.subagent || !activeThread) return;
      selectedSubagentTriggerRef.current = trigger;
      setSelectedSubagent({
        environmentId: activeThread.environmentId,
        threadId: activeThread.id,
        rowId: workEntry.id,
        turnId: workEntry.turnId ?? null,
        workEntry: { ...workEntry, subagent: workEntry.subagent },
      });
    },
    [activeThread],
  );
  const closeSubagentDetail = useCallback(() => {
    const trigger = selectedSubagentTriggerRef.current;
    setSelectedSubagent(null);
    selectedSubagentTriggerRef.current = null;
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }, []);
  useEffect(() => {
    // The selected provider child is authorized within one exact Cafe thread.
    // Clear it across navigation before another environment can reuse a
    // provider-native id with unrelated history.
    setSelectedSubagent(null);
    selectedSubagentTriggerRef.current = null;
  }, [activeThread?.environmentId, activeThread?.id]);
  useEffect(() => {
    if (!taskAtriumOpen) return;
    // Atrium is a full-screen navigation surface, not a layer within subagent
    // detail. Clear the thread-local selection without restoring trigger focus
    // so closing Atrium returns to the ordinary conversation and cannot reveal
    // a stale detail panel underneath it.
    setSelectedSubagent(null);
    selectedSubagentTriggerRef.current = null;
  }, [taskAtriumOpen]);
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

  const [messageForkSelection, setMessageForkSelection] = useState<{
    environmentId: EnvironmentId;
    threadId: ThreadId;
    instanceId: ProviderInstanceId;
    messageId: MessageId;
  } | null>(null);
  const currentForkOwner = useRef({
    thread: activeThread,
    foreground: pane.active && pane.visible,
    available: false,
  });
  const forkOwnerMounted = useRef(true);
  useEffect(() => {
    forkOwnerMounted.current = true;
    // A closed pane's late acknowledgement has no navigation authority.
    return () => {
      forkOwnerMounted.current = false;
    };
  }, []);
  const isForkingMessage = useMessageForkAdmission((pending) =>
    activeThread
      ? pending.has(messageForkAdmissionKey(activeThread.environmentId, activeThread.id))
      : false,
  );
  const messageForkAvailable =
    isServerThread &&
    activeThread?.session?.provider === "claudeAgent" &&
    activeThread.session.status === "ready" &&
    activeThread.session.providerInstanceId === activeThread.modelSelection.instanceId &&
    !activeEnvironmentUnavailable &&
    !isWorking &&
    latestTurnSettled &&
    !isForkingMessage &&
    activeSubagentEntries.length === 0 &&
    pendingApprovals.length === 0 &&
    pendingUserInputs.length === 0;
  currentForkOwner.current = {
    thread: activeThread,
    foreground: pane.active && pane.visible,
    available: messageForkAvailable,
  };
  const onSelectForkMessage = useCallback((messageId: MessageId) => {
    const { thread, foreground, available } = currentForkOwner.current;
    if (
      !foreground ||
      !available ||
      !thread ||
      thread.session?.provider !== "claudeAgent" ||
      useMessageForkAdmission
        .getState()
        .has(messageForkAdmissionKey(thread.environmentId, thread.id))
    )
      return;
    setMessageForkSelection({
      environmentId: thread.environmentId,
      threadId: thread.id,
      instanceId: thread.modelSelection.instanceId,
      messageId,
    });
  }, []);
  const onForkSelectedMessage = useCallback(
    async (messageId: MessageId) => {
      const selection = messageForkSelection;
      if (!selection || selection.messageId !== messageId)
        throw new Error("Fork selection changed.");
      const sourceRef = scopeThreadRef(selection.environmentId, selection.threadId);
      // Re-read current ownership at the gesture, not the dialog's earlier render.
      // Provider-native validation remains the authority for historical messages.
      const source = selectThreadByRef(useStore.getState(), sourceRef);
      const api = readEnvironmentApi(selection.environmentId);
      const owner = currentForkOwner.current;
      if (
        !forkOwnerMounted.current ||
        !owner.foreground ||
        !owner.available ||
        owner.thread?.id !== selection.threadId ||
        owner.thread.environmentId !== selection.environmentId ||
        !api ||
        !source ||
        source.session?.provider !== "claudeAgent" ||
        source.modelSelection.instanceId !== selection.instanceId ||
        !isLatestTurnSettled(source.latestTurn, source.session)
      )
        throw new Error("Fork source is unavailable.");
      const targetThreadId = newThreadId();
      const release = claimMessageFork(
        messageForkAdmissionKey(selection.environmentId, selection.threadId),
      );
      if (!release) throw new Error("A fork is already pending.");
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.fork",
          commandId: newCommandId(),
          sourceThreadId: selection.threadId,
          sourceMessageId: messageId,
          targetThreadId,
          title: truncate(`${source.title} (fork)`),
          createdAt: new Date().toISOString(),
        });
        // A slow response must not navigate a different pane/chat the owner opened
        // while this operation was in flight. The committed fork remains in Desk.
        const { thread: current, foreground } = currentForkOwner.current;
        if (
          forkOwnerMounted.current &&
          foreground &&
          current?.id === selection.threadId &&
          current.environmentId === selection.environmentId &&
          current.modelSelection.instanceId === selection.instanceId
        ) {
          await navigate({
            to: "/$environmentId/$threadId",
            params: {
              environmentId: selection.environmentId,
              threadId: targetThreadId,
            },
          });
        }
      } finally {
        release();
      }
    },
    [messageForkSelection, navigate],
  );
  useEffect(() => {
    setMessageForkSelection(null);
  }, [activeThread?.environmentId, activeThread?.id, activeThread?.modelSelection.instanceId]);

  // Empty state: no active thread
  useLayoutEffect(() => {
    if (!sharedChatRuntime) return;
    const element = paneElementRef.current;
    if (!element) return;
    const measure = () => setPaneWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sharedChatRuntime, activeThread?.id]);

  // Scheduling is a low-rate independent projection. Stable context keeps
  // token-by-token conversation renders out of its editor/list hot path.
  const scheduledThreadId = isServerThread ? activeThread?.id : undefined;
  const scheduledModelSelection = activeThread?.modelSelection;
  const scheduledFollowupsContext = useMemo(
    () =>
      scheduledThreadId && scheduledModelSelection
        ? {
            environmentId,
            threadId: scheduledThreadId,
            modelSelection: scheduledModelSelection,
            provider: activeProviderStatus ?? null,
            unavailable: activeEnvironmentUnavailable,
          }
        : undefined,
    [
      environmentId,
      scheduledThreadId,
      scheduledModelSelection,
      activeProviderStatus,
      activeEnvironmentUnavailable,
    ],
  );
  const providerTasksContext = useMemo(
    () =>
      scheduledThreadId && scheduledModelSelection
        ? {
            environmentId,
            threadId: scheduledThreadId,
            providerInstanceId: scheduledModelSelection.instanceId,
            activities: threadActivities,
            runtimeSession: subagentRuntimeSession,
          }
        : undefined,
    [
      environmentId,
      scheduledThreadId,
      scheduledModelSelection,
      threadActivities,
      subagentRuntimeSession,
    ],
  );

  const reviewDisabled =
    activeThread?.session?.status !== "ready" ||
    isSendBusy ||
    isComposerConnecting ||
    isWorking ||
    isRevertingCheckpoint ||
    activeEnvironmentUnavailable;
  const startCodeReview = useCallback(
    async (codexReview: CodexReviewTarget) => {
      const sendContext = readComposerHandle(composerRef)?.getSendContext();
      const currentThread = activeThread
        ? selectThreadByRef(
            useStore.getState(),
            scopeThreadRef(activeThread.environmentId, activeThread.id),
          )
        : undefined;
      // The menu and dialog follow the effective picker selection. Recheck the
      // current handle and canonical session immediately before dispatch too:
      // a stale menu callback must never submit to a previously selected account.
      if (
        !isServerThread ||
        !chatViewMountedRef.current ||
        currentRouteThreadKeyRef.current !== routeThreadKey ||
        reviewDisabled ||
        !currentThread ||
        !sendContext ||
        sendContext.selectedProvider !== "codex" ||
        currentThread.session?.provider !== "codex" ||
        currentThread.session.status !== "ready" ||
        currentThread.session.providerInstanceId !==
          sendContext.selectedModelSelection.instanceId ||
        currentThread.modelSelection.instanceId !== sendContext.selectedModelSelection.instanceId ||
        currentThread.runtimeMode !== activeThread?.runtimeMode ||
        currentThread.interactionMode !== activeThread?.interactionMode ||
        currentThread.session.createdAt !== activeThread?.session?.createdAt ||
        currentThread.session.subagentRuntimeId !== activeThread?.session?.subagentRuntimeId
      ) {
        throw new Error("The selected Codex account or session changed. Reopen the review.");
      }
      const api = readEnvironmentApi(currentThread.environmentId);
      if (!api) throw new Error("The chat is disconnected.");
      const text =
        codexReview.type === "uncommittedChanges"
          ? "Code review: uncommitted changes"
          : codexReview.type === "baseBranch"
            ? `Code review against ${codexReview.branch}`
            : codexReview.type === "commit"
              ? `Code review of commit ${codexReview.sha}`
              : `Code review: ${codexReview.instructions}`;
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: currentThread.id,
        message: {
          messageId: MessageId.make(crypto.randomUUID()),
          role: "user",
          text,
          attachments: [],
        },
        codexReview,
        // Native review uses the admitted saved session's review settings. The
        // exact selected account was checked above; unsent model traits stay inert.
        modelSelection: currentThread.modelSelection,
        runtimeMode: currentThread.runtimeMode,
        interactionMode: currentThread.interactionMode,
        createdAt: new Date().toISOString(),
      });
    },
    [activeThread, composerRef, isServerThread, reviewDisabled, routeThreadKey],
  );

  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  const shouldRenderPlanSidebar = planSidebarOpen && hasPlanSidebarContent;
  // The former viewport breakpoint assumed one chat. Desk panes use their own
  // width; preserve the saved pin on narrow panes while the composer popovers
  // remain available, and restore the rail as soon as there is usable room.
  const canDockSessionRail = sharedChatRuntime
    ? (paneWidth ?? 0) >= 540
    : !shouldUsePlanSidebarSheet;
  const sessionRailVisible = sessionRailDocked && canDockSessionRail;
  const sessionRailUsage = deriveLatestContextWindowSnapshot(threadActivities);
  const sessionRailRateLimits = shouldSurfaceProviderAccountRateLimits(activeProviderStatus)
    ? (activeProviderStatus?.accountRateLimits ?? null)
    : null;
  const sessionRailQuotaContext: ProviderQuotaContext | undefined =
    selectedQuotaDriver({
      instanceId: activeThread.modelSelection.instanceId,
      configuredDriver: settings.providerInstances[activeThread.modelSelection.instanceId]?.driver,
      snapshot: activeProviderStatus,
      session: activeThread.session,
    }) === "claudeAgent"
      ? {
          environmentId,
          input:
            activeThread.session?.provider === "claudeAgent" &&
            activeThread.session.providerInstanceId === activeThread.modelSelection.instanceId &&
            activeThread.session.subagentRuntimeId
              ? {
                  instanceId: activeThread.modelSelection.instanceId,
                  session: {
                    threadId: activeThread.id,
                    runtimeId: activeThread.session.subagentRuntimeId,
                  },
                }
              : null,
          scopeRevision: providerSkillsScopeRevision({
            cwd: gitCwd,
            instanceId: activeThread.modelSelection.instanceId,
            settings,
            snapshot: activeProviderStatus ?? null,
          }),
          connected:
            environmentId === primaryEnvironmentId
              ? quotaConnectionStatus.phase === "connected"
              : savedRuntime?.connectionState === "connected",
        }
      : undefined;
  const shouldRenderRightColumn =
    (shouldRenderPlanSidebar && !shouldUsePlanSidebarSheet) || sessionRailVisible;

  const headerControls = (
    <ChatHeader
      compact={Boolean(props.navigationSlot)}
      activeThreadEnvironmentId={activeThread.environmentId}
      activeThreadTitle={activeThread.title}
      activeProjectName={activeProject?.name}
      isGitRepo={isGitRepo}
      openInCwd={gitCwd}
      keybindings={keybindings}
      availableEditors={availableEditors}
      terminal={terminal}
    />
  );

  return (
    <div
      ref={paneElementRef}
      className="group/chat-view flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background"
    >
      {/* Top bar — hidden while the mobile composer has the on-screen keyboard
          open (data attribute set by ChatComposer) to maximize vertical room. */}
      <header
        data-chat-view-header="true"
        data-mac-titlebar={!props.navigationSlot && isMacDesktopTitlebar}
        className={cn(
          "group-has-[[data-chat-composer-keyboard-open=true]]/chat-view:hidden",
          props.navigationSlot
            ? "shrink-0"
            : isElectron
              ? "border-b border-border drag-region flex h-[52px] items-center px-3 sm:px-5 wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
              : "border-b border-border pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-2 sm:pb-3 sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)] sm:pt-3",
        )}
      >
        {props.navigationSlot ? props.navigationSlot(headerControls) : headerControls}
      </header>
      {pane.active &&
      pane.visible &&
      messageForkSelection &&
      messageForkSelection.environmentId === activeThread.environmentId &&
      messageForkSelection.threadId === activeThread.id &&
      messageForkSelection.instanceId === activeThread.modelSelection.instanceId ? (
        <MessageForkDialog
          key={`${activeThread.environmentId}:${activeThread.id}:${activeThread.modelSelection.instanceId}:${messageForkSelection.messageId}`}
          messageId={messageForkSelection.messageId}
          accountLabel={activeProviderStatus?.displayName ?? "this Claude account"}
          busy={isForkingMessage}
          disabled={!messageForkAvailable}
          onClose={() =>
            setMessageForkSelection((current) =>
              current === messageForkSelection ? null : current,
            )
          }
          onFork={onForkSelectedMessage}
        />
      ) : null}

      {/* Error banner */}
      <ProviderStatusBanner status={activeProviderStatus} />
      <ThreadErrorBanner
        error={activeThread.error}
        scopeKey={`${activeThread.environmentId}\u0000${activeThread.id}`}
        environmentId={activeThread.environmentId}
        threadId={activeThread.id}
        canContinueInNewChat={
          isServerThread &&
          pane.active &&
          pane.visible &&
          !activeEnvironmentUnavailable &&
          !isWorking &&
          latestTurnSettled
        }
        onContinueInNewChat={onContinueInNewChat}
        canPrepareShorterResponse={canPrepareShorterResponse}
        onPrepareShorterResponse={
          claudeResponseLimitFailure && selectedProvider === "claudeAgent"
            ? prepareShorterResponse
            : undefined
        }
      />
      {/* Main content area with optional plan / session rail */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Chat column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Messages Wrapper */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Messages — LegendList handles virtualization and scrolling internally */}
            <MessagesTimeline
              key={activeThread.id}
              {...(pane.visible && scheduledFollowupsContext
                ? { scheduledFollowups: scheduledFollowupsContext }
                : {})}
              isThreadHistoryHydrating={isServerThread && !serverThreadDetailHydrated}
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
              onForkMessage={
                isServerThread && activeThread.session?.provider === "claudeAgent"
                  ? onSelectForkMessage
                  : undefined
              }
              messageForkDisabled={!messageForkAvailable}
              isRevertingCheckpoint={isRevertingCheckpoint}
              onImageExpand={onExpandTimelineImage}
              activeProvider={activeThread.session?.provider ?? null}
              subagentRuntimeSession={subagentRuntimeSession}
              markdownCwd={gitCwd ?? undefined}
              additionalWorkspaceRoots={
                activeProject?.additionalWorkspaceRoots ?? EMPTY_ADDITIONAL_WORKSPACE_ROOTS
              }
              timestampFormat={timestampFormat}
              workspaceRoot={activeWorkspaceRoot}
              skills={activeProviderStatus?.skills ?? EMPTY_PROVIDER_SKILLS}
              stickToEndRevision={stickTimelineToEndRevision}
              autoFollowTail={timelineAutoFollowTail}
              initialViewPosition={initialTimelinePosition}
              viewPositionCache={timelineViews}
              viewPositionKey={routeThreadKey}
              onIsAtEndChange={onIsAtEndChange}
              onUserScrollIntent={onTimelineUserScrollIntent}
              selectedSubagent={selectedSubagent}
              onOpenSubagentDetail={openSubagentDetail}
              onCloseSubagentDetail={closeSubagentDetail}
              {...(desktopDebugEnabled
                ? { onDebugScrollEvent: recordTimelineScrollDebugEvent }
                : {})}
            />

            {/* scroll to bottom pill — shown when user has scrolled away from the bottom */}
            {showScrollToBottom && (
              <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
                <button
                  type="button"
                  onClick={() => scrollToEnd(true)}
                  // The rise lives on the button, not the wrapper: the wrapper's
                  // -translate-x-1/2 centring uses the same `translate` property.
                  className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-raised px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors duration-(--duration-fast) hover:border-border-strong hover:text-foreground hover:cursor-pointer animate-enter-rise"
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
              // NOTE: intentionally NOT adding env(safe-area-inset-bottom) here.
              // Mobile browsers (e.g. Firefox Android) already exclude the system
              // nav bar from the viewport yet still report a non-zero
              // safe-area-inset-bottom, so adding it inserts ~48px of phantom empty
              // space below the composer. On desktop the inset is 0, so this is
              // identical to the previous behavior there.
              isGitRepo ? "pb-1" : "pb-3 sm:pb-4",
            )}
          >
            {isServerThread && activeThread.session?.provider === "codex" && (
              <ComposerAsyncQuestionsPanel
                environmentId={activeThread.environmentId}
                threadId={activeThread.id}
                activities={activeThread.activities}
                deliveryDisabled={
                  isSendBusy || isComposerConnecting || activeEnvironmentUnavailable
                }
                onAnswer={enqueueAsyncQuestionAnswer}
                onResolve={resolveAsyncQuestions}
              />
            )}
            <div className="relative isolate">
              <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
              <div className="relative z-10">
                <ChatComposer
                  onStartCodeReview={startCodeReview}
                  codeReviewDisabled={reviewDisabled}
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
                  activePendingAutoResolutionSnoozed={activePendingAutoResolutionSnoozed}
                  activePendingDraftAnswers={activePendingDraftAnswers}
                  activePendingQuestionIndex={activePendingQuestionIndex}
                  respondingRequestIds={respondingRequestIds}
                  showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                  activeProposedPlan={activeProposedPlan}
                  activePlan={composerActivePlan}
                  activeSubagents={activeSubagentEntries}
                  scheduledFollowups={scheduledFollowupsContext}
                  providerTasks={providerTasksContext}
                  onOpenSubagentDetail={openSubagentDetail}
                  sidebarProposedPlan={visibleSidebarProposedPlan}
                  planSidebarLabel={planSidebarLabel}
                  planSidebarOpen={shouldRenderPlanSidebar}
                  sessionRailVisible={sessionRailVisible}
                  {...(canDockSessionRail ? { onShowSessionRail: showSessionRail } : {})}
                  goalControlsSupported={goalControlsSupported}
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
                  skillsProjectId={gitCwd === activeProject?.cwd ? activeProject.id : null}
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
                  onEditFollowUpQueueItem={onEditFollowUpQueueItem}
                  queueEditing={Boolean(queueEditingItemId)}
                  onSaveQueueEdit={onSaveQueueEdit}
                  onCancelQueueEdit={() => finishQueueEditing(false)}
                  onClearFollowUpQueue={onClearFollowUpQueue}
                  onInterrupt={onInterrupt}
                  onImplementPlanInNewThread={onImplementPlanInNewThread}
                  onRespondToApproval={onRespondToApproval}
                  onSelectActivePendingUserInputOption={onSelectActivePendingUserInputOption}
                  onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                  onRespondToInteraction={onRespondToInteraction}
                  onResolveInteractionUrl={onResolveInteractionUrl}
                  onPreviousActivePendingUserInputQuestion={
                    onPreviousActivePendingUserInputQuestion
                  }
                  onChangeActivePendingUserInputCustomAnswer={
                    onChangeActivePendingUserInputCustomAnswer
                  }
                  onSnoozeActivePendingUserInput={onSnoozeActivePendingUserInput}
                  onProviderModelSelect={onProviderModelSelect}
                  toggleInteractionMode={toggleInteractionMode}
                  handleRuntimeModeChange={handleRuntimeModeChange}
                  handleInteractionModeChange={handleInteractionModeChange}
                  togglePlanSidebar={togglePlanSidebar}
                  onOpenGoalDialog={openThreadGoalDialog}
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

        {shouldRenderRightColumn ? (
          <div
            className="flex min-h-0 w-[340px] shrink-0 flex-col border-l border-border-subtle bg-card animate-enter-from-end"
            style={
              sharedChatRuntime
                ? { width: Math.min(340, Math.max(220, (paneWidth ?? 660) / 3)) }
                : undefined
            }
            data-chat-right-column="true"
          >
            {shouldRenderPlanSidebar ? (
              <PlanSidebar
                activeProposedPlan={visibleSidebarProposedPlan}
                label={planSidebarLabel}
                environmentId={environmentId}
                markdownCwd={gitCwd ?? undefined}
                workspaceRoot={activeWorkspaceRoot}
                mode="sidebar"
                framed={false}
                className={
                  sessionRailVisible ? "min-h-0 flex-1 border-b border-border/60" : "min-h-0 flex-1"
                }
                onClose={closePlanSidebar}
              />
            ) : null}
            {sessionRailVisible ? (
              <SessionRail
                scheduledFollowups={scheduledFollowupsContext}
                providerTasks={providerTasksContext}
                plan={composerActivePlan}
                subagents={activeSubagentEntries}
                onOpenSubagentDetail={openSubagentDetail}
                usage={sessionRailUsage}
                rateLimits={sessionRailRateLimits}
                quotaContext={sessionRailQuotaContext}
                subagentConcurrency={
                  activeThread
                    ? deriveSubagentConcurrencyPresentation({
                        provider:
                          activeProviderStatus?.driver ?? activeThread.session?.provider ?? "codex",
                        limits: composerSubagentLimits ?? activeThread.subagentLimits,
                        inheritedLimit: configuredInstanceSubagentLimit(
                          settings,
                          activeThread.modelSelection.instanceId,
                        ),
                        configuredLimit: activeThread.session?.maxConcurrentSubagents,
                      })
                    : null
                }
                usageResetAction={
                  <ProviderUsageResetButton
                    key={`${environmentId}:${activeProviderStatus?.instanceId ?? ""}`}
                    provider={activeProviderStatus}
                    request={(input) =>
                      requireEnvironmentConnection(environmentId).client.server.usageReset(input)
                    }
                  />
                }
                onShowInComposer={hideSessionRail}
                className="min-h-0 flex-1"
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {/* end horizontal flex container */}

      {shouldUsePlanSidebarSheet && hasPlanSidebarContent ? (
        <RightPanelSheet open={shouldRenderPlanSidebar} onClose={closePlanSidebar}>
          <PlanSidebar
            activeProposedPlan={visibleSidebarProposedPlan}
            label={planSidebarLabel}
            environmentId={environmentId}
            markdownCwd={gitCwd ?? undefined}
            workspaceRoot={activeWorkspaceRoot}
            mode="sheet"
            onClose={closePlanSidebar}
          />
        </RightPanelSheet>
      ) : null}

      {expandedImage && (
        <ExpandedImageDialog preview={expandedImage} onClose={closeExpandedImage} />
      )}
      {activeThread && goalControlsSupported ? (
        <ThreadGoalDialog
          open={threadGoalDialog.open}
          requestRevision={threadGoalDialog.revision}
          mode={threadGoalDialog.mode}
          seedObjective={threadGoalDialog.seedObjective}
          confirmReplacement={threadGoalDialog.confirmReplacement}
          goal={activeThread.goal ?? null}
          activeTurnStartedAt={activeThread.latestTurn?.startedAt ?? null}
          isTurnRunning={phase === "running"}
          onOpenChange={(open) => {
            if (!open) {
              closeThreadGoalDialog();
            }
          }}
          onSetGoal={setThreadGoal}
          onClearGoal={clearThreadGoal}
        />
      ) : null}
    </div>
  );
}
