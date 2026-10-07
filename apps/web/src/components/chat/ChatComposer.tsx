import { providerSkillsScopeRevision, useProviderSkills } from "./useProviderSkills";
import { useProviderCommands } from "./useProviderCommands";
import { useWsConnectionStatus } from "../../rpc/wsConnectionState";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import type { ScheduledFollowupsContext } from "./ScheduledFollowups";
import type { ProviderTasksContext } from "./ProviderTasks";
import type {
  ApprovalRequestId,
  ChatFileAttachment,
  CodexReviewTarget,
  DictationTranscriptionModel,
  EnvironmentId,
  ModelSelection,
  ProjectEntry,
  ProjectId,
  ProviderSkillsInput,
  ProviderCommandsInput,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderDeliveryPriority,
  ResolvedKeybindingsConfig,
  RuntimeMode,
  ScopedThreadRef,
  ServerProvider,
  SubagentLimits,
  ThreadId,
} from "@cafecode/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_TOTAL_ATTACHMENT_BYTES,
} from "@cafecode/contracts";
import { createModelSelection, normalizeModelSlug } from "@cafecode/shared/model";
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
} from "../../composer-logic";
import { deriveComposerSendState, readFileAsDataUrl } from "../ChatView.logic";
import {
  type ComposerImageAttachment,
  type DraftId,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
  flushComposerDraftPersistence,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import {
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "../composerFooterLayout";
import { type ComposerPromptEditorHandle, ComposerPromptEditor } from "../ComposerPromptEditor";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { NativeCodexReview } from "./NativeCodexReview";
import {
  ClaudeDeliveryPriorityPicker,
  ClaudeDeliveryPriorityControl,
} from "./ClaudeDeliveryPriorityPicker";
import { ComposerTab } from "./ComposerTab";
import { useUiStateStore } from "../../uiStateStore";
import { ComposerAttachImageButton } from "./ComposerAttachImageButton";
import { FileAttachmentPendingPill, FileAttachmentPill } from "./FileAttachmentPill";
import { uploadFileAttachment } from "../../attachments/fileAttachments";
import { isComposerImageFile, type ComposerFileAttachment } from "../../attachments/composerFiles";
import { ComposerDictationButton } from "./ComposerDictationButton";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { ComposerInteractionCallbacks } from "./ComposerInteractionCard";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { ComposerTaskProgress } from "./ComposerTaskProgress";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import { getComposerProviderState, renderProviderTraitsMenuContent } from "./composerProviderState";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { SubagentConcurrencyControl } from "./SubagentConcurrencyControl";
import {
  configuredInstanceSubagentLimit,
  deriveSubagentConcurrencyPresentation,
  subagentLimitKey,
  subagentLimitsEqual,
  withSubagentLimit,
  type SubagentConcurrencyPresentation,
} from "../../subagentConcurrency";
import { ComputerUseButton } from "./ComputerUseButton";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { basenameOfPath } from "../../vscode-icons";
import { cn, newCommandId, randomUUID } from "~/lib/utils";
import { MenuItem } from "../ui/menu";
import { resolveShortcutCommand } from "../../keybindings";
import { Separator } from "../ui/separator";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  ImageIcon,
  LoaderCircleIcon,
  FileSearchIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { proposedPlanTitle } from "../../proposedPlan";
import { getProviderInteractionModeToggle } from "../../providerModels";
import {
  deriveProviderInstanceEntries,
  resolveProviderDriverKindForInstanceSelection,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import type { UnifiedSettings } from "@cafecode/contracts/settings";
import type { SessionPhase, Thread } from "../../types";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type {
  ActivePlanState,
  LatestProposedPlanState,
  PendingApproval,
  PendingUserInput,
  WorkLogEntry,
} from "../../session-logic";
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";
import { shouldSurfaceProviderAccountRateLimits } from "../../lib/codexRateLimits";
import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useHasOnScreenKeyboard } from "../../hooks/useMediaQuery";
import { useSettings } from "../../hooks/useSettings";
import { useComposerDictation } from "../../hooks/useComposerDictation";
import { readDictationBrowserCapability } from "../../dictation/realtimeTranscription";
import { requireEnvironmentConnection } from "../../environments/runtime";
import { useStore } from "../../store";
import { ProviderUsageResetButton } from "../ProviderUsageResetButton";
import { dictationStatusQueryOptions } from "../../lib/dictationReactQuery";
import { domSnapshot, mobileDebugLog } from "../../lib/mobileDebugLog";
import {
  applyClaudePermissionMode,
  type ClaudePermissionMode,
  deriveClaudePermissionMode,
  getNextClaudePermissionMode,
} from "./claudePermissionMode";

const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;

const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const PENDING_ANSWER_PLACEHOLDER = "Type an answer, or leave blank to use the selection";
/** Add/remove motion for composer-owned lists (queued messages, attachments).
 * Matches --duration-base with the style guide's ease-out curve; auto-animate
 * already honours prefers-reduced-motion. */
/** In-composer panels (approval, question, plan ready) share one surface and
 * one entrance; keyed wrappers replay it when a new request replaces the last. */
const COMPOSER_PANEL_CLASS_NAME =
  "animate-enter-rise rounded-t-[calc(var(--radius-2xl)-2px)] border-b border-border-subtle bg-muted/20";
const COMPOSER_LIST_ANIMATION = {
  duration: 160,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
} as const;

/** Exact ownership identity for an editor and every asynchronous save it starts. */
export function buildSubagentConcurrencyEditorKey(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  instanceId: ProviderInstanceId;
  draftId: DraftId | null | undefined;
  isServerThread: boolean;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.threadId,
    input.instanceId,
    input.draftId ?? null,
    input.isServerThread,
  ]);
}
// React clears a queued follow-up draft immediately after submit. Retain the
// harmless Send affordance across the ordinary double-click/tap window so the
// same pointer coordinates cannot turn into the destructive Stop action
// between clicks. This state belongs to ChatComposer because mobile submission
// swaps the keyboard overlay action for the footer action without unmounting
// the composer itself.
const POST_SUBMIT_INTERRUPT_GUARD_MS = 500;
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-slot="popover-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

function isInsideComposerFloatingLayer(element: Element): boolean {
  return element.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  activeContextWindow: ReturnType<typeof deriveLatestContextWindowSnapshot>;
  codexRateLimits: ServerProvider["accountRateLimits"] | null;
  usageResetAction: ReactNode;
  subagentConcurrency?: SubagentConcurrencyPresentation | null;
  sessionRailVisible: boolean;
  onShowSessionRail?: () => void;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  hasSendableContent: boolean;
  postSubmitInterruptGuardActive: boolean;
  pendingStatusLabel: string | null;
  isQueueEditing?: boolean;
  dictationAction: ReactNode;
  preserveComposerFocusOnPointerDown?: boolean;
  onArmPostSubmitInterruptGuard: () => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}) {
  return (
    <>
      {props.activeContextWindow && !props.sessionRailVisible ? (
        <ContextWindowMeter
          usage={props.activeContextWindow}
          codexRateLimits={props.codexRateLimits}
          subagentConcurrency={props.subagentConcurrency}
          {...(props.onShowSessionRail ? { onShowOnSide: props.onShowSessionRail } : {})}
        />
      ) : null}
      {props.pendingStatusLabel ? (
        <span className="text-muted-foreground text-xs">{props.pendingStatusLabel}</span>
      ) : null}
      {!props.sessionRailVisible ? props.usageResetAction : null}
      {props.dictationAction}
      <ComposerPrimaryActions
        compact={props.compact}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        isSendBusy={props.isSendBusy}
        isQueueEditing={props.isQueueEditing ?? false}
        isConnecting={props.isConnecting}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        postSubmitInterruptGuardActive={props.postSubmitInterruptGuardActive}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        onArmPostSubmitInterruptGuard={props.onArmPostSubmitInterruptGuard}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        onImplementPlanInNewThread={props.onImplementPlanInNewThread}
      />
    </>
  );
});

// --------------------------------------------------------------------------
// Handle exposed to ChatView
// --------------------------------------------------------------------------

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  openModelPicker: () => void;
  toggleModelPicker: () => void;
  isModelPickerOpen: () => boolean;
  readDebugState: () => {
    activeThreadId: ThreadId | null;
    phase: SessionPhase;
    selectedProvider: ProviderDriverKind;
    selectedInstanceId: ProviderInstanceId;
    selectedModelSelection: ModelSelection;
    composerEditorDisabled: boolean;
    composerFocusRequestRevision: number;
    isComposerFocused: boolean;
    isOnScreenKeyboardDevice: boolean;
    isComposerCollapsedMobile: boolean;
    isSendBusy: boolean;
    isConnecting: boolean;
    editor: ReturnType<ComposerPromptEditorHandle["readDebugState"]> | null;
  };
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
  };
  /** Reset composer cursor/trigger/highlight after external prompt mutations (e.g. onSend). */
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  /** Get the current prompt/effort/model state for use in send. */
  getSendContext: () => {
    prompt: string;
    images: ComposerImageAttachment[];
    files: ComposerFileAttachment[];
    selectedPromptEffort: string | null;
    selectedModelOptionsForDispatch: unknown;
    selectedModelSelection: ModelSelection;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
    subagentLimits?: SubagentLimits;
    deliveryPriority?: ProviderDeliveryPriority;
  };
}

export interface FollowUpQueueViewItem {
  id: string;
  preview: string;
  promptText: string;
  images: readonly ComposerImageAttachment[];
  files?: readonly ChatFileAttachment[];
  environmentId?: EnvironmentId;
  canEdit?: boolean;
  canDispatch?: boolean;
  canRetryDelivery?: boolean;
  queuedAt: string;
  expanded: boolean;
  canExpand: boolean;
  blockedReason: string | null;
  automaticSteerRetry?: {
    readonly nonSteerableTurnKind: "review" | "compact" | null;
    readonly dispatchFailed?: true;
  } | null;
}

export interface SteeringFollowUpViewItem {
  id: string;
  preview: string;
  promptText: string;
  dispatchedAt: string;
  files?: readonly ChatFileAttachment[];
  environmentId?: EnvironmentId;
}

function queuedMessageCountLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 message queued" : `${count} messages queued`;
}

function queuedAutomaticSteerCountLabel(items: readonly FollowUpQueueViewItem[]): string | null {
  const automaticSteerItems = items.filter((item) => item.automaticSteerRetry != null);
  if (automaticSteerItems.length === 0) {
    return null;
  }

  if (automaticSteerItems.length === 1) {
    if (automaticSteerItems[0]?.blockedReason) return "1 steer needs attention";
    const kind = automaticSteerItems[0]?.automaticSteerRetry?.nonSteerableTurnKind;
    return kind === "compact"
      ? "1 steer waiting for compact"
      : kind === "review"
        ? "1 steer waiting for review"
        : "1 follow-up requeued";
  }

  return `${automaticSteerItems.length} steers waiting`;
}

function steeringCountLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 message steering" : `${count} messages steering`;
}

function automaticSteerRetryStatus(item: FollowUpQueueViewItem): {
  readonly ariaLabel: string;
  readonly label: string;
  readonly title: string;
} | null {
  if (item.automaticSteerRetry && item.blockedReason !== null) {
    return {
      ariaLabel: "Steer delivery paused",
      label: "Delivery paused",
      title:
        "Your message and attachments are preserved. Review the delivery error before retrying.",
    };
  }
  const kind = item.automaticSteerRetry?.nonSteerableTurnKind ?? null;
  if (kind === null && item.automaticSteerRetry != null) {
    return {
      ariaLabel: "Follow-up requeued after provider steer rejection",
      label: "Requeued",
      title:
        "The provider did not accept this live steer. Cafe Code preserved it and will send it automatically when the active turn is ready.",
    };
  }
  if (kind === null) {
    return null;
  }

  if (kind === "compact") {
    return {
      ariaLabel: "Queued steer waiting for Codex context compaction",
      label: "Waiting for compact",
      title:
        "Codex is compacting the active turn; Cafe Code will retry this steer automatically when compaction finishes.",
    };
  }

  return {
    ariaLabel: "Queued steer waiting for Codex review",
    label: "Waiting for review",
    title:
      "Codex is reviewing the active turn; Cafe Code will send this follow-up automatically when the active turn is ready.",
  };
}

export function FollowUpQueueShelf(props: {
  attached?: boolean;
  items: readonly FollowUpQueueViewItem[];
  steeringItems?: readonly SteeringFollowUpViewItem[];
  actionLabel: string;
  actionTitle: string;
  onToggleExpanded: (itemId: string) => void;
  onAction: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  onEdit?: ((itemId: string) => void) | undefined;
  onClear: () => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
}) {
  const steeringItems = props.steeringItems ?? [];
  const [rowsRef] = useAutoAnimate<HTMLDivElement>(COMPOSER_LIST_ANIMATION);
  if (props.items.length === 0 && steeringItems.length === 0) {
    return null;
  }
  const automaticSteerCount = props.items.filter((item) => item.automaticSteerRetry != null).length;
  const shelfLabel = [
    queuedMessageCountLabel(props.items.length - automaticSteerCount),
    queuedAutomaticSteerCountLabel(props.items),
    steeringCountLabel(steeringItems.length),
  ]
    .filter((label): label is string => label !== null)
    .join(", ");

  return (
    <div
      className={cn(
        "cafe-followup-queue relative animate-enter-rise overflow-hidden rounded-2xl border border-border bg-card/80 px-3 py-2 text-sm backdrop-blur-sm",
        props.attached ? "rounded-b-none border-b-0" : "mb-2",
      )}
      data-cafe-followup-queue="true"
    >
      <div className="relative z-10 flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0 text-muted-foreground text-xs font-medium">{shelfLabel}</div>
        {props.items.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-muted-foreground hover:text-foreground"
            onClick={props.onClear}
          >
            Clear
          </Button>
        ) : null}
      </div>
      <div ref={rowsRef} className="relative z-10 mt-1.5 grid gap-1">
        {steeringItems.map((item) => (
          <div
            key={item.id}
            className="rounded-xl border border-border-subtle bg-muted/20 p-2"
            data-cafe-followup-steering="true"
          >
            <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
              <span
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground"
                aria-hidden="true"
              >
                <LoaderCircleIcon className="size-4 animate-spin" />
              </span>
              <div
                className="min-w-0 truncate text-left text-muted-foreground"
                title={item.promptText.trim().length > 0 ? item.promptText : item.preview}
              >
                {item.preview}
              </div>
              <span
                className="h-7 shrink-0 rounded-md border border-border px-2 py-1 text-muted-foreground text-xs"
                aria-label="Follow-up steering into active turn"
                title="Follow-up accepted for the active turn; waiting for the provider to act on it."
              >
                Steering
              </span>
            </div>
            {item.files && item.environmentId && item.files.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {item.files.map((attachment) => (
                  <FileAttachmentPill
                    key={attachment.id}
                    attachment={attachment}
                    environmentId={item.environmentId!}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {props.items.map((item) => {
          const retryStatus = automaticSteerRetryStatus(item);
          return (
            <div
              key={item.id}
              className="rounded-xl border border-border-subtle bg-background/40 p-2"
            >
              <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-2">
                {item.canExpand ? (
                  <button
                    type="button"
                    className="focus-ring inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground"
                    aria-label={item.expanded ? "Collapse queued message" : "Expand queued message"}
                    aria-expanded={item.expanded}
                    onClick={() => props.onToggleExpanded(item.id)}
                  >
                    <ChevronRightIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 transition-transform duration-(--duration-fast) ease-out",
                        item.expanded && "rotate-90",
                      )}
                    />
                  </button>
                ) : (
                  <span className="size-6 shrink-0" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className="min-w-0 truncate text-left text-muted-foreground transition-colors data-[expandable=false]:cursor-default data-[expandable=true]:hover:text-foreground"
                  data-expandable={item.canExpand ? "true" : "false"}
                  onClick={() => {
                    if (item.canExpand) {
                      props.onToggleExpanded(item.id);
                    }
                  }}
                  title={item.canExpand ? item.preview : undefined}
                >
                  {item.preview}
                </button>
                {item.automaticSteerRetry?.dispatchFailed ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 px-2"
                    title="Retry delivery of this exact message and its attachments."
                    disabled={item.canRetryDelivery !== true}
                    onClick={() => props.onAction(item.id)}
                  >
                    Retry delivery
                  </Button>
                ) : retryStatus ? (
                  <span
                    className="h-7 shrink-0 whitespace-nowrap rounded-md border border-border px-2 py-1 text-muted-foreground text-xs"
                    aria-label={retryStatus.ariaLabel}
                    title={retryStatus.title}
                  >
                    {retryStatus.label}
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="cafe-followup-steer-button h-7 shrink-0 px-2 transition-colors"
                    title={props.actionTitle}
                    disabled={item.canDispatch === false}
                    onClick={() => props.onAction(item.id)}
                  >
                    {props.actionLabel}
                  </Button>
                )}
                {!retryStatus && item.canEdit !== false && props.onEdit ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 shrink-0"
                    aria-label="Edit queued message"
                    onClick={() => props.onEdit?.(item.id)}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                ) : (
                  <span />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 shrink-0 text-muted-foreground hover:text-destructive-foreground"
                  aria-label="Remove queued message"
                  onClick={() => props.onRemove(item.id)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
              {item.files && item.environmentId && item.files.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {item.files.map((attachment) => (
                    <FileAttachmentPill
                      key={attachment.id}
                      attachment={attachment}
                      environmentId={item.environmentId!}
                    />
                  ))}
                </div>
              ) : null}
              {item.canExpand && item.expanded ? (
                <div className="mt-2 grid animate-enter-rise gap-2 rounded-lg border border-border-subtle bg-background/60 p-2">
                  {item.images.length > 0 ? (
                    <div className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3">
                      {item.images.map((image) => (
                        <div
                          key={image.id}
                          className="overflow-hidden rounded-lg border border-border bg-background"
                        >
                          {image.previewUrl ? (
                            <button
                              type="button"
                              className="block h-full w-full cursor-zoom-in"
                              aria-label={`Preview queued image ${image.name}`}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(item.images, image.id);
                                if (!preview) return;
                                props.onExpandImage(preview);
                              }}
                            >
                              <img
                                src={image.previewUrl}
                                alt={image.name}
                                className="block h-24 w-full object-cover"
                              />
                            </button>
                          ) : (
                            <div className="flex min-h-20 items-center justify-center px-2 py-3 text-center text-2xs text-muted-foreground">
                              {image.name}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <textarea
                    readOnly
                    aria-label="Queued message prompt"
                    value={item.promptText.trim().length > 0 ? item.promptText : item.preview}
                    className="max-h-36 min-h-20 w-full resize-none overflow-y-auto rounded-md border border-border-subtle bg-background/40 p-2 text-muted-foreground text-xs leading-5 outline-none [overflow-wrap:anywhere]"
                    onChange={() => undefined}
                  />
                </div>
              ) : null}
              {item.blockedReason ? (
                <div className="mt-2 text-2xs text-destructive-foreground">
                  {item.blockedReason}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Props
// --------------------------------------------------------------------------

export interface ChatComposerProps extends ComposerInteractionCallbacks {
  /** The native review dispatch remains owned by the active chat. */
  onStartCodeReview?: (target: CodexReviewTarget) => Promise<void>;
  codeReviewDisabled?: boolean;
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
  routeKind: "server" | "draft";
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;

  // Thread context
  activeThreadId: ThreadId | null;
  activeThreadEnvironmentId: EnvironmentId | undefined;
  activeThread: Thread | undefined;
  isServerThread: boolean;
  isLocalDraftThread: boolean;

  // Session phase
  phase: SessionPhase;
  isConnecting: boolean;
  isSendBusy: boolean;
  isPreparingWorktree: boolean;
  environmentUnavailable: {
    readonly label: string;
    readonly connectionState: "connecting" | "disconnected" | "error";
  } | null;

  // Pending approvals / inputs
  activePendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  activePendingProgress: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    customAnswer: string;
    activeQuestion: { id: string; multiSelect?: boolean | undefined } | null;
  } | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  activePendingIsResponding: boolean;
  activePendingAutoResolutionSnoozed: boolean;
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  respondingRequestIds: ApprovalRequestId[];

  // Plan
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: Thread["proposedPlans"][number] | null;
  activePlan: ActivePlanState | null;
  activeSubagents?: ReadonlyArray<WorkLogEntry>;
  sidebarProposedPlan: LatestProposedPlanState | null;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  sessionRailVisible?: boolean;
  onShowSessionRail?: () => void;
  goalControlsSupported: boolean;
  scheduledFollowups?: ScheduledFollowupsContext | undefined;
  providerTasks?: ProviderTasksContext | undefined;

  // Mode
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;

  // Provider / model
  lockedProvider: ProviderDriverKind | null;
  providerStatuses: ServerProvider[];
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  skillsProjectId?: ProjectId | null;
  activeThreadModelSelection: ModelSelection | null | undefined;

  // Context window
  activeThreadActivities: Thread["activities"] | undefined;

  // Misc
  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  gitCwd: string | null;
  followUpQueueItems: readonly FollowUpQueueViewItem[];
  steeringFollowUpItems: readonly SteeringFollowUpViewItem[];
  followUpQueueActionLabel: string;
  followUpQueueActionTitle: string;

  // Refs the parent needs kept in sync
  promptRef: React.RefObject<string>;
  composerImagesRef: React.RefObject<ComposerImageAttachment[]>;
  composerRef: React.RefObject<ChatComposerHandle | null>;

  // Scroll
  shouldAutoScrollRef: React.RefObject<boolean>;
  scheduleStickToBottom: () => void;

  // Callbacks
  onSend: (e?: { preventDefault: () => void }) => void | Promise<void>;
  onSteer: (e?: { preventDefault: () => void }) => void | Promise<void>;
  onToggleFollowUpQueueItem: (itemId: string) => void;
  onActivateFollowUpQueueItem: (itemId: string) => void;
  onRemoveFollowUpQueueItem: (itemId: string) => void;
  onEditFollowUpQueueItem?: (itemId: string) => void;
  queueEditing?: boolean;
  onSaveQueueEdit?: () => void;
  onCancelQueueEdit?: () => void;
  onClearFollowUpQueue: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;
  onSnoozeActivePendingUserInput: () => void;

  onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;
  toggleInteractionMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  togglePlanSidebar: () => void;
  onOpenGoalDialog: () => void;
  onOpenSubagentDetail?: (workEntry: WorkLogEntry, trigger: HTMLButtonElement) => void;

  focusComposer: () => void;
  scheduleComposerFocus: () => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    onStartCodeReview,
    codeReviewDisabled,
    composerDraftTarget,
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    activeThreadId,
    activeThreadEnvironmentId: _activeThreadEnvironmentId,
    activeThread,
    isServerThread,
    isLocalDraftThread: _isLocalDraftThread,
    phase,
    isConnecting,
    isSendBusy,
    isPreparingWorktree,
    environmentUnavailable,
    activePendingApproval,
    pendingApprovals,
    pendingUserInputs,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    activePendingAutoResolutionSnoozed,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    respondingRequestIds,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    activePlan,
    activeSubagents = [],
    sidebarProposedPlan,
    planSidebarLabel,
    planSidebarOpen,
    sessionRailVisible = false,
    onShowSessionRail,
    scheduledFollowups,
    providerTasks,
    goalControlsSupported,
    runtimeMode,
    interactionMode,
    lockedProvider,
    providerStatuses,
    activeProjectDefaultModelSelection,
    skillsProjectId,
    activeThreadModelSelection,
    activeThreadActivities,
    resolvedTheme,
    settings,
    keybindings,
    gitCwd,
    followUpQueueItems,
    steeringFollowUpItems,
    followUpQueueActionLabel,
    followUpQueueActionTitle,
    promptRef,
    composerRef,
    composerImagesRef,
    shouldAutoScrollRef,
    scheduleStickToBottom,
    onSend,
    onSteer,
    onToggleFollowUpQueueItem,
    onActivateFollowUpQueueItem,
    onRemoveFollowUpQueueItem,
    onClearFollowUpQueue,
    onInterrupt,
    onImplementPlanInNewThread,
    onRespondToApproval,
    onRespondToInteraction,
    onResolveInteractionUrl,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
    onSnoozeActivePendingUserInput,
    onProviderModelSelect,
    toggleInteractionMode,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    togglePlanSidebar,
    onOpenGoalDialog,
    onOpenSubagentDetail,
    focusComposer,
    scheduleComposerFocus,
    setThreadError,
    onExpandImage,
  } = props;

  // ------------------------------------------------------------------
  // Store subscriptions (prompt / images)
  // ------------------------------------------------------------------
  const composerDraft = useComposerThreadDraft(composerDraftTarget);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerFiles = composerDraft.files;
  const [fileDraftPersistenceFailed, setFileDraftPersistenceFailed] = useState(false);
  useEffect(() => {
    if (composerFiles.length === 0) {
      setFileDraftPersistenceFailed(false);
      return;
    }
    setFileDraftPersistenceFailed(!flushComposerDraftPersistence());
  }, [composerFiles]);
  const blockedComposerFiles = composerFiles.some(
    (file) =>
      file.status !== "ready" ||
      file.environmentId !== environmentId ||
      file.targetThreadId !== activeThreadId,
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;

  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

  // ------------------------------------------------------------------
  // Model state
  // ------------------------------------------------------------------
  // Instance-aware projection of the wire provider list. One entry per
  // configured instance (default built-in + any custom `providerInstances.*`),
  // sorted default-first per driver kind for a stable picker order.
  const providerInstanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(providerStatuses)),
    [providerStatuses],
  );
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  const threadProvider =
    activeThread?.session?.providerInstanceId ??
    activeThreadModelSelection?.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null;
  const explicitSelectedInstanceId = selectedProviderByThreadId ?? threadProvider;

  const unlockedSelectedProvider =
    resolveProviderDriverKindForInstanceSelection(
      providerInstanceEntries,
      providerStatuses,
      explicitSelectedInstanceId,
    ) ?? ProviderDriverKind.make("codex");
  const selectedProvider: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const lockedContinuationGroupKey = useMemo((): string | null => {
    if (!lockedProvider || !activeThread) return null;
    const lockedInstanceId =
      activeThread.session?.providerInstanceId ?? activeThreadModelSelection?.instanceId;
    if (!lockedInstanceId) return null;
    return (
      providerInstanceEntries.find((entry) => entry.instanceId === lockedInstanceId)
        ?.continuationGroupKey ?? null
    );
  }, [
    activeThread,
    activeThreadModelSelection?.instanceId,
    lockedProvider,
    providerInstanceEntries,
  ]);

  // Resolve which configured instance the composer is currently targeting.
  // Priority:
  //   1. The composer draft's `activeProvider` — the user's unsaved pick
  //      from the model picker (must win, otherwise the UI appears to
  //      ignore picker selections).
  //   2. Thread's persisted instance id (server-side saved selection).
  //   3. The global default provider from settings.
  //   4. Project default's instance id.
  //   5. First enabled entry matching the current driver kind.
  //   6. First enabled entry overall / default instance for the kind.
  //
  const selectedInstanceId = useMemo<ProviderInstanceId>(() => {
    const candidates: Array<string | null | undefined> = [
      composerDraft.activeProvider,
      activeThread?.session?.providerInstanceId,
      activeThreadModelSelection?.instanceId,
      settings.defaultProviderInstanceId,
      activeProjectDefaultModelSelection?.instanceId,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const match = providerInstanceEntries.find(
        (entry) => entry.instanceId === candidate && entry.enabled,
      );
      if (match) {
        // When locked to a specific driver kind, ignore persisted instance
        // ids from a different kind or continuation group.
        if (lockedProvider && match.driverKind !== lockedProvider) continue;
        if (
          lockedContinuationGroupKey &&
          match.continuationGroupKey !== lockedContinuationGroupKey
        ) {
          continue;
        }
        return match.instanceId;
      }
    }
    if (explicitSelectedInstanceId) {
      return ProviderInstanceId.make(explicitSelectedInstanceId);
    }
    const byKind = providerInstanceEntries.find(
      (entry) =>
        entry.enabled &&
        entry.driverKind === selectedProvider &&
        (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey),
    );
    if (byKind) return byKind.instanceId;
    const anyEnabled = providerInstanceEntries.find((entry) => entry.enabled);
    return (
      anyEnabled?.instanceId ??
      providerInstanceEntries[0]?.instanceId ??
      activeThreadModelSelection?.instanceId ??
      activeProjectDefaultModelSelection?.instanceId ??
      ProviderInstanceId.make("codex")
    );
  }, [
    activeProjectDefaultModelSelection?.instanceId,
    activeThread?.session?.providerInstanceId,
    activeThreadModelSelection?.instanceId,
    composerDraft.activeProvider,
    explicitSelectedInstanceId,
    lockedContinuationGroupKey,
    lockedProvider,
    providerInstanceEntries,
    selectedProvider,
    settings.defaultProviderInstanceId,
  ]);

  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadRef: composerDraftTarget,
    providers: providerStatuses,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection: activeThreadModelSelection,
    projectModelSelection: activeProjectDefaultModelSelection,
    settings,
  });
  // Model traits are scoped to the configured provider instance, not merely
  // the driver kind. Two Codex accounts may intentionally use different Sol
  // efforts; reading the default `codex` bucket for a custom account can show
  // Ultra while dispatching that account's default Low effort after a refresh.
  // Exact lookup keeps display and outbound `ModelSelection` aligned.
  const selectedComposerModelOptions = composerModelOptions?.[selectedInstanceId];

  // Resolve the active instance's snapshot by `instanceId` so a custom
  // instance gets its own slash commands, skills, and model list — not
  // the first snapshot for the same driver kind.
  const selectedProviderEntry = useMemo(
    () => providerInstanceEntries.find((entry) => entry.instanceId === selectedInstanceId),
    [providerInstanceEntries, selectedInstanceId],
  );
  const selectedProviderStatus = useMemo(
    () => selectedProviderEntry?.snapshot ?? null,
    [selectedProviderEntry],
  );
  // Priority belongs to the effective picker account, not the last saved
  // session. Reset on a switch so returning to an account cannot revive a
  // hidden urgency setting; queue snapshots keep their already captured value.
  const deliveryChoiceKey = JSON.stringify([
    environmentId,
    isServerThread ? activeThreadId : draftId,
    selectedProvider,
    selectedInstanceId,
  ]);
  const deliveryPriorityAvailable =
    selectedProvider === "claudeAgent" &&
    selectedProviderStatus?.driver === "claudeAgent" &&
    selectedProviderStatus.runtimeCapabilities?.deliveryPriority === true;
  const [deliveryChoice, setDeliveryChoice] = useState<{
    key: string;
    priority: ProviderDeliveryPriority | undefined;
  }>({ key: deliveryChoiceKey, priority: undefined });
  if (deliveryChoice.key !== deliveryChoiceKey) {
    setDeliveryChoice({ key: deliveryChoiceKey, priority: undefined });
  }
  const deliveryPriority =
    deliveryPriorityAvailable && deliveryChoice.key === deliveryChoiceKey
      ? deliveryChoice.priority
      : undefined;

  const nativeReviewAvailable =
    onStartCodeReview !== undefined &&
    isServerThread &&
    selectedProvider === "codex" &&
    selectedProviderStatus?.driver === "codex" &&
    activeThread?.session?.provider === "codex" &&
    activeThread.session.providerInstanceId === selectedInstanceId &&
    activeThread.modelSelection.instanceId === selectedInstanceId;
  const nativeReviewDisabled =
    codeReviewDisabled === true ||
    activeThread?.session?.status !== "ready" ||
    phase === "running" ||
    isSendBusy ||
    isConnecting ||
    environmentUnavailable !== null;
  // The menu is transient, but the dialog must survive its closure and an ACK
  // that makes the session busy. Identity/mode changes invalidate it instead;
  // do not use updatedAt, which advances during ordinary review submission.
  const nativeReviewKey = JSON.stringify([
    environmentId,
    activeThreadId,
    selectedProvider,
    selectedInstanceId,
    runtimeMode,
    interactionMode,
    activeThread?.runtimeMode,
    activeThread?.interactionMode,
    activeThread?.session?.createdAt,
    activeThread?.session?.subagentRuntimeId,
    nativeReviewAvailable,
  ]);
  const [nativeReviewState, setNativeReviewState] = useState({
    key: nativeReviewKey,
    open: false,
  });
  if (nativeReviewState.key !== nativeReviewKey) {
    setNativeReviewState({ key: nativeReviewKey, open: false });
  }
  const nativeReviewOpen = nativeReviewState.key === nativeReviewKey && nativeReviewState.open;
  const composerTabCollapsed = useUiStateStore((state) => state.composerTabCollapsed);
  // Provider-owned controls stay discoverable while their actions are blocked.
  // Eligibility still binds dispatch to the exact account and session above.
  const showNativeReviewControl = selectedProvider === "codex";
  const showDeliveryPriorityControl = selectedProvider === "claudeAgent";
  const hasComposerTab = showNativeReviewControl || showDeliveryPriorityControl;
  const nativeReviewControlDisabled = !nativeReviewAvailable || nativeReviewDisabled;
  const nativeReviewDisabledReason =
    environmentUnavailable !== null || isConnecting
      ? "Reconnect to this server before starting a review."
      : !isServerThread
        ? "Send a message to start a Codex session before reviewing code."
        : onStartCodeReview === undefined
          ? "Code review is unavailable in this view."
          : !selectedProviderStatus
            ? "Waiting for the selected Codex account’s provider information."
            : !nativeReviewAvailable
              ? "Start a Codex session with the selected account before reviewing code."
              : nativeReviewDisabled
                ? "Wait for the current work to finish and the Codex session to be ready."
                : undefined;
  const deliveryPriorityDisabled =
    !deliveryPriorityAvailable || isSendBusy || isConnecting || environmentUnavailable !== null;
  const deliveryPriorityDisabledReason =
    environmentUnavailable !== null || isConnecting
      ? "Reconnect to this server to change message delivery."
      : !selectedProviderStatus
        ? "Waiting for the selected Claude account’s provider information."
        : !deliveryPriorityAvailable
          ? "Message delivery options require a supported Claude version for this account."
          : isSendBusy
            ? "Wait for the current message to finish sending before changing delivery."
            : undefined;
  const providerActions =
    nativeReviewAvailable && !nativeReviewDisabled ? (
      <MenuItem
        aria-haspopup="dialog"
        className="[&>svg]:mx-0"
        onClick={() => setNativeReviewState({ key: nativeReviewKey, open: true })}
      >
        <FileSearchIcon aria-hidden="true" className="size-4 shrink-0" />
        Codex review
      </MenuItem>
    ) : deliveryPriorityAvailable ? (
      <ClaudeDeliveryPriorityPicker
        value={deliveryPriority}
        onChange={(priority) => setDeliveryChoice({ key: deliveryChoiceKey, priority })}
        disabled={isSendBusy || isConnecting || environmentUnavailable !== null}
      />
    ) : null;
  const selectedCodexRateLimits = shouldSurfaceProviderAccountRateLimits(selectedProviderStatus)
    ? (selectedProviderStatus?.accountRateLimits ?? null)
    : null;
  const requestProviderModelsRefresh = useCallback(
    (instanceId: ProviderInstanceId) => {
      const entry = providerInstanceEntries.find(
        (candidate) => candidate.instanceId === instanceId,
      );
      if (entry?.driverKind !== ProviderDriverKind.make("codex")) {
        return;
      }

      try {
        // Returned only so the picker can show a delayed progress line.
        return (
          requireEnvironmentConnection(environmentId)
            .client.server.refreshProviders({ instanceId, scope: "models" })
            // The picker intentionally keeps its stale catalogue on failure.
            // The server records a redacted phase marker; avoid surfacing raw
            // provider causes in the renderer console or a disruptive toast.
            .catch(() => undefined)
        );
      } catch {
        // A connection can disappear between the pointer event and this
        // lookup. The next picker open will retry after reconnect.
        return;
      }
    },
    [environmentId, providerInstanceEntries],
  );
  const selectedProviderModels = useMemo<ReadonlyArray<ServerProvider["models"][number]>>(
    () => selectedProviderEntry?.models ?? [],
    [selectedProviderEntry],
  );
  // Open state is bound to the exact pane/account identity. A route or picker
  // change closes the editor in the same render, before any user event can
  // reach a different target; an effect would leave one transient open frame.
  // Imported opaque ids may contain delimiters. A tuple must remain injective
  // so a different chat/account cannot inherit another editor's unsaved input.
  const concurrencyEditorKey = buildSubagentConcurrencyEditorKey({
    environmentId,
    threadId: activeThreadId,
    instanceId: selectedInstanceId,
    draftId,
    isServerThread,
  });
  const [concurrencyEditorState, setConcurrencyEditorState] = useState({
    key: concurrencyEditorKey,
    open: false,
  });
  if (concurrencyEditorState.key !== concurrencyEditorKey) {
    setConcurrencyEditorState({ key: concurrencyEditorKey, open: false });
  }
  const concurrencyEditorOpen =
    concurrencyEditorState.key === concurrencyEditorKey && concurrencyEditorState.open;
  const setConcurrencyEditorOpen = (open: boolean) =>
    setConcurrencyEditorState({ key: concurrencyEditorKey, open });
  const desiredSubagentLimits = composerDraft.subagentLimits ?? activeThread?.subagentLimits;
  const concurrencyKey = subagentLimitKey(selectedProvider);
  const concurrencySupported =
    selectedProviderStatus?.runtimeCapabilities?.subagentConcurrency === true;
  const configuredLimit =
    activeThread?.session?.providerInstanceId === selectedInstanceId
      ? activeThread.session.maxConcurrentSubagents
      : undefined;
  const concurrencyPresentation = deriveSubagentConcurrencyPresentation({
    provider: selectedProvider,
    limits: desiredSubagentLimits,
    inheritedLimit: configuredInstanceSubagentLimit(settings, selectedInstanceId),
    configuredLimit,
  });
  const concurrencySaveScope = useRef<{
    active: boolean;
    dispose: (() => void) | null;
  } | null>(null);
  useLayoutEffect(() => {
    if (isServerThread && activeThreadId) {
      // A reload need not run cleanup. Persisted server-thread overlays have
      // no surviving ACK owner, so canonical metadata must win on fresh mount.
      // Local drafts are deliberately excluded: their unsent defaults/reset
      // are still the authoritative source for first-send bootstrap.
      useComposerDraftStore
        .getState()
        .setSubagentLimits({ environmentId, threadId: activeThreadId }, undefined);
    }
    const scope = { active: true, dispose: null as (() => void) | null };
    concurrencySaveScope.current = scope;
    return () => {
      // The preference is already durable after ACK. This pane's overlay is
      // only a projection-lag bridge, not a second source of saved metadata.
      // Releasing it also prevents a late ACK from writing after a target or
      // account switch, or retaining a subscription after pane disposal.
      scope.active = false;
      scope.dispose?.();
      if (concurrencySaveScope.current === scope) concurrencySaveScope.current = null;
    };
  }, [concurrencyEditorKey, environmentId, activeThreadId, isServerThread]);
  useEffect(() => {
    // Restored/promoted draft metadata can already match the durable read
    // model without an in-flight save in this component. Retire that redundant
    // overlay as well; an explicit empty reset remains distinct from absence.
    if (
      isServerThread &&
      composerDraft.subagentLimits !== undefined &&
      subagentLimitsEqual(composerDraft.subagentLimits, activeThread?.subagentLimits)
    ) {
      useComposerDraftStore.getState().setSubagentLimits(composerDraftTarget, undefined);
    }
  }, [
    activeThread?.subagentLimits,
    composerDraft.subagentLimits,
    composerDraftTarget,
    isServerThread,
  ]);
  const saveSubagentLimit = async (value: number | undefined) => {
    if (!concurrencyKey || (value !== undefined && !concurrencySupported))
      throw new Error("Unsupported runtime");
    const store = useComposerDraftStore.getState();
    if (isServerThread && activeThreadId) {
      const scope = concurrencySaveScope.current;
      if (!scope?.active) throw new Error("Chat no longer active");
      const readCanonical = () =>
        useStore.getState().environmentStateById[environmentId]?.threadShellById[activeThreadId]
          ?.subagentLimits;
      const readCanonicalSequence = () =>
        useStore.getState().environmentStateById[environmentId]?.subagentPolicySequenceByThreadId?.[
          activeThreadId
        ];
      const current =
        store.getComposerDraft(composerDraftTarget)?.subagentLimits ?? readCanonical();
      const next = withSubagentLimit(current, selectedProvider, value);
      scope.dispose?.();
      let acknowledgedSequence: number | null = null;
      let installedOverlay = false;
      const dispose = () => {
        unsubscribe();
        if (
          installedOverlay &&
          subagentLimitsEqual(store.getComposerDraft(composerDraftTarget)?.subagentLimits, next)
        ) {
          store.setSubagentLimits(composerDraftTarget, undefined);
        }
        installedOverlay = false;
        if (scope.dispose === dispose) scope.dispose = null;
      };
      const unsubscribe = useStore.subscribe(() => {
        const sequence = readCanonicalSequence();
        // Earlier-arriving projections may precede our durable save. Only an
        // exact-thread policy witness at/after its ACK proves canonical policy
        // has caught up. Equal-policy snapshots also retire the lag bridge.
        if (
          acknowledgedSequence !== null &&
          sequence !== undefined &&
          sequence >= acknowledgedSequence
        )
          dispose();
      });
      scope.dispose = dispose;
      // Bind this write to the exact owner environment/thread before awaiting;
      // switching panes cannot redirect a late save into another conversation.
      try {
        const acknowledgement = await requireEnvironmentConnection(
          environmentId,
        ).client.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          subagentLimits: next,
        });
        acknowledgedSequence = acknowledgement.sequence;
        const canonicalSequence = readCanonicalSequence();
        if (
          scope.active &&
          concurrencySaveScope.current === scope &&
          scope.dispose === dispose &&
          (canonicalSequence === undefined || canonicalSequence < acknowledgedSequence) &&
          !subagentLimitsEqual(readCanonical(), next)
        ) {
          // Preserve an acknowledged choice until exact-thread canonical
          // authority catches up to that save. Earlier scalar changes are not
          // newer policy authority. Queued sends independently omit this optional
          // replacement and consume the server's current durable preference.
          installedOverlay = true;
          store.setSubagentLimits(composerDraftTarget, next);
        }
      } finally {
        if (!installedOverlay) dispose();
      }
      return;
    }
    const current =
      store.getComposerDraft(composerDraftTarget)?.subagentLimits ?? activeThread?.subagentLimits;
    const next = withSubagentLimit(current, selectedProvider, value);
    store.setSubagentLimits(composerDraftTarget, next);
  };
  const concurrencyMenuItem = concurrencyKey ? (
    <MenuItem
      inset
      disabled={!concurrencySupported && desiredSubagentLimits?.[concurrencyKey] === undefined}
      title={
        !concurrencySupported
          ? "This provider runtime cannot apply a numeric subagent limit. An existing chat override can still be reset."
          : undefined
      }
      onClick={() => setConcurrencyEditorOpen(true)}
    >
      Subagent limit…{concurrencyPresentation?.pending ? " (pending)" : ""}
    </MenuItem>
  ) : null;

  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        prompt,
        modelOptions: selectedComposerModelOptions,
      }),
    [prompt, selectedComposerModelOptions, selectedModel, selectedProvider, selectedProviderModels],
  );

  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const selectedProviderUsesNativePermissionModes =
    selectedProvider === "claudeAgent" || selectedProvider === "grok";
  // Ambiance composer surface: tint the frame ring with the current weather
  // state color (via CSS variables owned by AmbianceLayer). Ultrathink's
  // rainbow frame intentionally wins when both want the frame.
  const ambianceComposerRing = useSettings(
    (appSettings) => appSettings.ambianceEnabled && appSettings.ambianceSurfaceComposer,
  );
  const composerProviderControls = useMemo(
    () => ({
      showInteractionModeToggle: getProviderInteractionModeToggle(
        providerStatuses,
        selectedProvider,
      ),
    }),
    [providerStatuses, selectedProvider],
  );
  const handleClaudePermissionModeChange = useCallback(
    (mode: ClaudePermissionMode) => {
      const mapped = applyClaudePermissionMode({ interactionMode, runtimeMode }, mode);
      const next =
        selectedProvider === "grok" && mode === "auto"
          ? { ...mapped, runtimeMode: "auto-accept-edits" as const }
          : mapped;
      // Both draft-store updates are synchronous. Calling only the fields that
      // changed also avoids an unnecessary Claude session
      // restart when switching between Plan/Auto and the underlying access
      // policy can safely remain in place for a live SDK mode transition.
      if (next.runtimeMode !== runtimeMode) {
        handleRuntimeModeChange(next.runtimeMode);
      }
      if (next.interactionMode !== interactionMode) {
        handleInteractionModeChange(next.interactionMode);
      }
    },
    [
      handleInteractionModeChange,
      handleRuntimeModeChange,
      interactionMode,
      runtimeMode,
      selectedProvider,
    ],
  );
  const cycleComposerInteractionMode = useCallback(() => {
    if (selectedProvider === "claudeAgent" || selectedProvider === "grok") {
      const currentMode = deriveClaudePermissionMode({ interactionMode, runtimeMode });
      handleClaudePermissionModeChange(getNextClaudePermissionMode(currentMode));
      return;
    }
    toggleInteractionMode();
  }, [
    handleClaudePermissionModeChange,
    interactionMode,
    runtimeMode,
    selectedProvider,
    toggleInteractionMode,
  ]);
  const selectedModelSelection = useMemo<ModelSelection>(
    () => createModelSelection(selectedInstanceId, selectedModel, selectedModelOptionsForDispatch),
    [selectedInstanceId, selectedModel, selectedModelOptionsForDispatch],
  );
  const selectedModelForPicker = selectedModel;
  // Instance-keyed option list so the picker can show each configured
  // instance (built-in + custom) as a first-class sidebar entry. The
  // options are server-reported models plus that exact instance's
  // configured custom models; selected slugs are not injected into lists.
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of providerInstanceEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return out;
  }, [providerInstanceEntries, settings]);
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByInstance.get(selectedInstanceId) ?? [];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByInstance, selectedInstanceId, selectedModelForPicker, selectedProvider]);

  // ------------------------------------------------------------------
  // Context window
  // ------------------------------------------------------------------
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(activeThreadActivities ?? []),
    [activeThreadActivities],
  );

  // ------------------------------------------------------------------
  // Composer-local state
  // ------------------------------------------------------------------
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [composerHighlightedSearchKey, setComposerHighlightedSearchKey] = useState<string | null>(
    null,
  );
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [composerFocusRequestRevision, setComposerFocusRequestRevision] = useState(0);
  const [postSubmitInterruptGuardActive, setPostSubmitInterruptGuardActive] = useState(false);
  // Touch capability, not viewport width: foldables and tablets can be wider
  // than any phone breakpoint while still typing through an on-screen keyboard.
  const isOnScreenKeyboardDevice = useHasOnScreenKeyboard();
  const isComposerCollapsedMobile = isOnScreenKeyboardDevice && !isComposerFocused;
  const [dictationBrowserCapability] = useState(readDictationBrowserCapability);
  const dictationStatusQuery = useQuery({
    ...dictationStatusQueryOptions(environmentId),
    enabled: dictationBrowserCapability.supported && environmentUnavailable === null,
  });

  // TEMPORARY: mobile DOM debugging — remove with lib/mobileDebugLog.ts.
  useEffect(() => {
    mobileDebugLog("composer-state", {
      isOnScreenKeyboardDevice,
      isComposerFocused,
      isComposerCollapsedMobile,
      ...domSnapshot(),
    });
  }, [isComposerCollapsedMobile, isComposerFocused, isOnScreenKeyboardDevice]);

  // ------------------------------------------------------------------
  // Refs
  // ------------------------------------------------------------------
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const composerFormHeightRef = useRef(0);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const composerBlurFrameRef = useRef<number | null>(null);
  const mobileComposerExpandFrameRef = useRef<number | null>(null);
  const mobileComposerExpandReleaseFrameRef = useRef<number | null>(null);
  const mobileComposerExpandInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const composerFileInputRef = useRef<HTMLInputElement>(null);
  const [composerFilesListRef] = useAutoAnimate<HTMLDivElement>(COMPOSER_LIST_ANIMATION);
  const [composerImagesListRef] = useAutoAnimate<HTMLDivElement>(COMPOSER_LIST_ANIMATION);
  // A Send/queue action issued while dictation is active must cross exactly
  // one finalization boundary. Keeping the single-flight here prevents a
  // double click from dispatching the same final transcript twice while the
  // microphone session is still committing its last audio buffer.
  const pendingDictationComposerActionRef = useRef<Promise<void> | null>(null);
  const postSubmitInterruptGuardArmedRef = useRef(false);
  const postSubmitInterruptGuardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ------------------------------------------------------------------
  // Derived: composer send state
  // ------------------------------------------------------------------
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        fileCount: composerFiles.length,
      }),
    [composerImages.length, composerFiles.length, prompt],
  );
  const postSubmitInterruptGuardTarget =
    routeKind === "draft"
      ? `draft:${draftId ?? "none"}`
      : `thread:${routeThreadRef.environmentId}:${routeThreadRef.threadId}`;
  const armPostSubmitInterruptGuard = useCallback(() => {
    if (phase !== "running" || !composerSendState.hasSendableContent) return;
    if (postSubmitInterruptGuardTimerRef.current !== null) {
      clearTimeout(postSubmitInterruptGuardTimerRef.current);
      postSubmitInterruptGuardTimerRef.current = null;
    }
    postSubmitInterruptGuardArmedRef.current = true;
    setPostSubmitInterruptGuardActive(true);
  }, [composerSendState.hasSendableContent, phase]);
  const settlePostSubmitInterruptGuard = useCallback(() => {
    if (!postSubmitInterruptGuardArmedRef.current) return;
    if (postSubmitInterruptGuardTimerRef.current !== null) {
      clearTimeout(postSubmitInterruptGuardTimerRef.current);
    }
    // Start the click-safety window after the asynchronous submit settles.
    // Mobile keeps its keyboard overlay mounted until then, so starting this
    // timer from the original click could expire before the footer replaces it.
    setPostSubmitInterruptGuardActive(true);
    postSubmitInterruptGuardTimerRef.current = setTimeout(() => {
      postSubmitInterruptGuardTimerRef.current = null;
      postSubmitInterruptGuardArmedRef.current = false;
      setPostSubmitInterruptGuardActive(false);
    }, POST_SUBMIT_INTERRUPT_GUARD_MS);
  }, []);

  useEffect(() => {
    // A guard belongs only to the stable route target that armed it. Clear it
    // when navigation selects another target (not when provider lifecycle
    // reconciliation transiently changes activeThreadId or phase),
    // and clear the timer on unmount so it cannot update a retired composer.
    if (postSubmitInterruptGuardTimerRef.current !== null) {
      clearTimeout(postSubmitInterruptGuardTimerRef.current);
      postSubmitInterruptGuardTimerRef.current = null;
    }
    postSubmitInterruptGuardArmedRef.current = false;
    setPostSubmitInterruptGuardActive(false);
    return () => {
      if (postSubmitInterruptGuardTimerRef.current !== null) {
        clearTimeout(postSubmitInterruptGuardTimerRef.current);
        postSubmitInterruptGuardTimerRef.current = null;
      }
      postSubmitInterruptGuardArmedRef.current = false;
    };
  }, [postSubmitInterruptGuardTarget]);
  const selectedProviderDisplayName =
    selectedProviderEntry?.displayName ||
    selectedProviderStatus?.displayName?.trim() ||
    String(selectedProviderStatus?.instanceId ?? selectedProvider);
  const composerPendingStatusLabel = isPreparingWorktree
    ? "Preparing worktree..."
    : isSendBusy
      ? "Submitting prompt..."
      : isConnecting
        ? `Starting ${selectedProviderDisplayName}...`
        : null;

  // ------------------------------------------------------------------
  // Derived: composer trigger / menu
  // ------------------------------------------------------------------
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const skillsInput = useMemo<ProviderSkillsInput | null>(
    () =>
      selectedProvider !== "codex"
        ? null
        : isServerThread && activeThreadId
          ? {
              instanceId: selectedInstanceId,
              context: { kind: "thread", threadId: activeThreadId },
            }
          : !isPreparingWorktree && skillsProjectId
            ? {
                instanceId: selectedInstanceId,
                context: { kind: "project", projectId: skillsProjectId },
              }
            : null,
    [
      selectedProvider,
      selectedInstanceId,
      isServerThread,
      activeThreadId,
      skillsProjectId,
      isPreparingWorktree,
    ],
  );
  const skillsScopeRevision =
    selectedProvider === "codex"
      ? providerSkillsScopeRevision({
          cwd: gitCwd,
          instanceId: selectedInstanceId,
          settings,
          snapshot: selectedProviderStatus,
        })
      : "";
  const discoveredSkills = useProviderSkills(
    environmentId,
    skillsInput,
    composerTriggerKind === "skill" && selectedProvider === "codex",
    skillsScopeRevision,
  );
  const selectedProviderSkills =
    selectedProvider === "codex" ? discoveredSkills.skills : (selectedProviderStatus?.skills ?? []);
  // The placeholder advertises `$` only where skills can actually be inserted.
  const composerSkillsSupported =
    selectedProvider === "codex" || (selectedProviderStatus?.skills?.length ?? 0) > 0;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectionStatus = useWsConnectionStatus();
  const savedConnectionState = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[environmentId]?.connectionState,
  );
  const commandsConnected =
    environmentId === primaryEnvironmentId
      ? connectionStatus.phase === "connected"
      : savedConnectionState === "connected";
  const commandsRuntimeId = activeThread?.session?.subagentRuntimeId;
  const commandsInput = useMemo<ProviderCommandsInput | null>(
    () =>
      selectedProvider === "claudeAgent" &&
      isServerThread &&
      activeThreadId &&
      commandsRuntimeId &&
      activeThread?.session?.providerInstanceId === selectedInstanceId
        ? { threadId: activeThreadId, instanceId: selectedInstanceId, runtimeId: commandsRuntimeId }
        : null,
    [
      selectedProvider,
      isServerThread,
      activeThreadId,
      commandsRuntimeId,
      activeThread?.session?.providerInstanceId,
      selectedInstanceId,
    ],
  );
  const commandsScopeRevision =
    selectedProvider === "claudeAgent"
      ? providerSkillsScopeRevision({
          cwd: gitCwd,
          instanceId: selectedInstanceId,
          settings,
          snapshot: selectedProviderStatus,
        })
      : "";
  const discoveredCommands = useProviderCommands(
    environmentId,
    commandsInput,
    composerTriggerKind === "slash-command" && selectedProvider === "claudeAgent",
    commandsScopeRevision,
    commandsConnected,
  );
  const selectedProviderCommands =
    selectedProvider === "claudeAgent"
      ? discoveredCommands.commands
      : (selectedProviderStatus?.slashCommands ?? []);
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    pathTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      environmentId,
      cwd: gitCwd,
      query: effectivePathQuery,
      enabled: isPathTrigger,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;

  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch the model for this chat",
        },
        {
          id: "slash:plan",
          type: "slash-command",
          command: "plan",
          label: "/plan",
          description: "Switch to Plan",
        },
        {
          id: "slash:default",
          type: "slash-command",
          command: "default",
          label: "/default",
          description: "Switch back to Build",
        },
        ...(selectedProvider === "codex" || selectedProvider === "opencode"
          ? [
              {
                id: "slash:compact",
                type: "slash-command" as const,
                command: "compact" as const,
                label: "/compact",
                description: "Compact conversation context (between turns)",
              },
            ]
          : []),
        ...(goalControlsSupported
          ? [
              {
                id: "slash:goal",
                type: "slash-command" as const,
                command: "goal" as const,
                label: "/goal",
                description: "View or update the Codex goal",
              },
            ]
          : []),
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const providerSlashCommandItems = selectedProviderCommands
        .filter(
          (command) =>
            !(
              (selectedProvider === "codex" || selectedProvider === "opencode") &&
              command.name.toLowerCase() === "compact"
            ),
        )
        .map((command) => ({
          id: `provider-slash-command:${selectedProvider}:${command.name}`,
          type: "provider-slash-command" as const,
          provider: selectedProvider,
          command,
          label: `/${command.name}`,
          description: command.description ?? command.input?.hint ?? "Run provider command",
        }));
      const query = composerTrigger.query.trim().toLowerCase();
      const slashCommandItems = [...builtInSlashCommandItems, ...providerSlashCommandItems];
      if (!query) {
        return slashCommandItems;
      }
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderSkills, composerTrigger.query).map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: formatProviderSkillDisplayName(skill),
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
      }));
    }
    return [];
  }, [
    composerTrigger,
    goalControlsSupported,
    selectedProvider,
    selectedProviderStatus,
    selectedProviderCommands,
    selectedProviderSkills,
    workspaceEntries,
  ]);

  const composerMenuOpen = Boolean(composerTrigger);
  const composerMenuSearchKey = composerTrigger
    ? `${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
    : null;
  const activeComposerMenuItem = useMemo(() => {
    const activeItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    return composerMenuItems.find((item) => item.id === activeItemId) ?? null;
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuSearchKey,
  ]);

  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;

  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );

  const isComposerApprovalState = activePendingApproval !== null;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const showComposerDictation =
    dictationBrowserCapability.supported &&
    dictationStatusQuery.data?.configured === true &&
    !isComposerApprovalState &&
    pendingUserInputs.length === 0;
  const isComposerDictationUnavailable =
    isSendBusy || isConnecting || environmentUnavailable !== null;
  const isComposerDictationEnabled = showComposerDictation && !isComposerDictationUnavailable;
  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const showCollapsedMobilePromptRow =
    isComposerCollapsedMobile && !isComposerApprovalState && pendingUserInputs.length === 0;

  const composerFooterHasWideActions =
    showPlanFollowUpPrompt ||
    activePendingProgress !== null ||
    activePlan !== null ||
    activeSubagents.length > 0;
  // Runtime checklists now live in the compact composer progress popover.
  // The retained side-panel control is intentionally limited to authored plan
  // documents so a task update can never reopen the old Tasks panel.
  const showPlanSidebarToggle = sidebarProposedPlan !== null;
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}:dictation:${showComposerDictation}`;
    }
    if (phase === "running") {
      return `running:${composerSendState.hasSendableContent}:${postSubmitInterruptGuardActive}:dictation:${showComposerDictation}`;
    }
    if (showPlanFollowUpPrompt) {
      return `${prompt.trim().length > 0 ? "plan:refine" : "plan:implement"}:dictation:${showComposerDictation}`;
    }
    return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}:dictation:${showComposerDictation}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerSendState.hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    phase,
    postSubmitInterruptGuardActive,
    prompt,
    showComposerDictation,
    showPlanFollowUpPrompt,
  ]);

  const isComposerMenuLoading =
    (composerTriggerKind === "skill" && discoveredSkills.loading) ||
    (composerTriggerKind === "path" &&
      ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching));
  const composerMenuEmptyState = useMemo(() => {
    if (composerTriggerKind === "skill") {
      if (selectedProvider === "codex" && skillsInput === null)
        return "Skills are available once this chat's workspace has been created.";
      if (selectedProvider === "codex" && discoveredSkills.status === "unavailable")
        return "Skills unavailable. Close and reopen the picker to retry.";
      if (selectedProvider === "codex" && discoveredSkills.status === "disabled")
        return "Enable and sign in to this Codex account to discover skills.";
      return "No skills found. Try / to browse provider commands.";
    }
    return composerTriggerKind === "path"
      ? "No matching files or folders."
      : "No matching command.";
  }, [composerTriggerKind, selectedProvider, discoveredSkills.status, skillsInput]);

  // ------------------------------------------------------------------
  // Provider traits UI
  // ------------------------------------------------------------------
  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      if (nextPrompt === promptRef.current) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [composerDraftTarget, promptRef, scheduleComposerFocus, setComposerDraftPrompt],
  );

  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    providerInstanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: selectedComposerModelOptions,
    prompt,
    onPromptChange: setPromptFromTraits,
  });
  const pendingPrimaryAction = useMemo(
    () =>
      activePendingProgress
        ? {
            questionIndex: activePendingProgress.questionIndex,
            isLastQuestion: activePendingProgress.isLastQuestion,
            canAdvance: activePendingProgress.canAdvance,
            isResponding: activePendingIsResponding,
            isComplete: Boolean(activePendingResolvedAnswers),
          }
        : null,
    [activePendingIsResponding, activePendingProgress, activePendingResolvedAnswers],
  );
  // While the composer is expanded on mobile (on-screen keyboard likely open),
  // the footer toolbar is hidden to free vertical space and the primary action
  // is overlaid on the editor instead. Approval state keeps its own footer.
  const showMobileComposerActionsOverlay =
    isOnScreenKeyboardDevice && !isComposerCollapsedMobile && !isComposerApprovalState;
  // ------------------------------------------------------------------
  // Prompt helpers
  // ------------------------------------------------------------------
  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    },
    [composerDraftTarget, setComposerDraftPrompt],
  );

  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(composerDraftTarget, image);
    },
    [composerDraftTarget, addComposerDraftImage],
  );

  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(composerDraftTarget, images);
    },
    [composerDraftTarget, addComposerDraftImages],
  );

  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(composerDraftTarget, imageId);
    },
    [composerDraftTarget, removeComposerDraftImage],
  );

  // ------------------------------------------------------------------
  // Sync refs back to parent
  // ------------------------------------------------------------------
  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt, promptRef]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages, composerImagesRef]);

  // ------------------------------------------------------------------
  // Composer menu highlight sync
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      setComposerHighlightedSearchKey(null);
      return;
    }
    const nextActiveItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    setComposerHighlightedItemId((existing) =>
      existing === nextActiveItemId ? existing : nextActiveItemId,
    );
    setComposerHighlightedSearchKey((existing) =>
      existing === composerMenuSearchKey ? existing : composerMenuSearchKey,
    );
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
  ]);

  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }

    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingProgress?.activeQuestion?.id,
    activePendingUserInput?.requestId,
    promptRef,
  ]);

  // ------------------------------------------------------------------
  // Reset compositor state on thread/draft change
  // ------------------------------------------------------------------
  useEffect(() => {
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
  }, [draftId, activeThreadId, promptRef]);

  // ------------------------------------------------------------------
  // Footer compact layout observation
  // ------------------------------------------------------------------
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const measureFooterCompactness = () => {
      const composerFormWidth = measureComposerFormWidth();
      const footerCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const primaryActionsCompact =
        footerCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });
      return {
        primaryActionsCompact,
        footerCompact,
      };
    };

    composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
    const initialCompactness = measureFooterCompactness();
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
    setIsComposerFooterCompact(initialCompactness.footerCompact);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;
      const nextCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      );
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      );
      const nextHeight = entry.contentRect.height;
      const previousHeight = composerFormHeightRef.current;
      composerFormHeightRef.current = nextHeight;
      if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
      if (!shouldAutoScrollRef.current) return;
      scheduleStickToBottom();
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [
    activeThreadId,
    composerFooterActionLayoutKey,
    composerFooterHasWideActions,
    scheduleStickToBottom,
    shouldAutoScrollRef,
  ]);

  // ------------------------------------------------------------------
  // Image persist effect
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(composerDraftTarget);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        getComposerDraft(composerDraftTarget)?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds = fallbackPersistedAttachments
          .map((attachment) => attachment.id)
          .filter((id) => currentImageIds.has(id));
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    composerDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerImages,
    getComposerDraft,
    syncComposerDraftPersistedAttachments,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: prompt change
  // ------------------------------------------------------------------
  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
        setComposerCursor(nextCursor);
        setComposerTrigger(
          cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
        );
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      pendingUserInputs.length,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
    ],
  );

  // ------------------------------------------------------------------
  // Callbacks: prompt replacement / menu
  // ------------------------------------------------------------------
  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; focusEditorAfterReplace?: boolean },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      const nextExpandedCursor = expandCollapsedComposerCursor(next.text, nextCursor);
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingQuestion.id,
          next.text,
          nextCursor,
          nextExpandedCursor,
          false,
        );
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(next.text, nextExpandedCursor));
      if (options?.focusEditorAfterReplace !== false) {
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCursor);
        });
      }
      return true;
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
    ],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
    };
  }, [composerCursor, promptRef]);

  const composerDictationSessionKey = JSON.stringify([
    environmentId,
    routeKind,
    draftId ?? routeThreadRef.threadId,
  ]);
  const createComposerDictationClientSecret = useCallback(
    (model: DictationTranscriptionModel) =>
      requireEnvironmentConnection(environmentId).client.dictation.createClientSecret({ model }),
    [environmentId],
  );
  const replaceComposerDictationRange = useCallback(
    (replacement: {
      readonly start: number;
      readonly end: number;
      readonly replacement: string;
      readonly expectedText: string;
    }) =>
      applyPromptReplacement(replacement.start, replacement.end, replacement.replacement, {
        expectedText: replacement.expectedText,
        focusEditorAfterReplace: false,
      }),
    [applyPromptReplacement],
  );
  const reportComposerDictationError = useCallback((message: string) => {
    toastManager.add({ type: "error", title: message });
  }, []);
  const composerDictation = useComposerDictation({
    enabled: isComposerDictationEnabled,
    sessionKey: composerDictationSessionKey,
    createClientSecret: createComposerDictationClientSecret,
    readComposerSnapshot,
    replaceComposerRange: replaceComposerDictationRange,
    onError: reportComposerDictationError,
  });
  const finishComposerDictation = composerDictation.finish;
  const composerEditorDisabled =
    isSendBusy ||
    isConnecting ||
    composerDictation.isEditingLocked ||
    isComposerApprovalState ||
    (environmentUnavailable !== null && activePendingProgress === null);
  // Dictation owns its own connecting/recording/finalizing state. Reusing its
  // transcript edit lock as the send button's busy state incorrectly rendered
  // a "Sending" spinner before Cafe had dispatched any message.
  const isComposerPrimaryActionBusy = isSendBusy || blockedComposerFiles;
  const previousComposerEditorDisabledRef = useRef(composerEditorDisabled);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        const replacement = `@${item.path} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          });
          if (applied) {
            setComposerHighlightedItemId(null);
            setIsComposerModelPickerOpen(true);
          }
          return;
        }
        if (item.command === "compact") {
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            trigger.rangeEnd,
            "/compact ",
            {
              expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            },
          );
          if (applied) setComposerHighlightedItemId(null);
          return;
        }
        if (item.command === "goal") {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          });
          if (applied) {
            setComposerHighlightedItemId(null);
            onOpenGoalDialog();
          }
          return;
        }
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "provider-slash-command") {
        const replacement = `/${item.command.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "skill") {
        const replacement = `$${item.skill.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
    },
    [
      applyPromptReplacement,
      handleInteractionModeChange,
      onOpenGoalDialog,
      resolveActiveComposerTrigger,
    ],
  );

  const onComposerMenuItemHighlighted = useCallback(
    (itemId: string | null) => {
      setComposerHighlightedItemId(itemId);
      setComposerHighlightedSearchKey(composerMenuSearchKey);
    },
    [composerMenuSearchKey],
  );

  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) return;
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );

  const requestComposerEditorFocus = useCallback(() => {
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    setIsComposerFocused(true);
    setComposerFocusRequestRevision((revision) => revision + 1);
  }, []);

  // On mobile, sending dismisses the on-screen keyboard; refocusing the editor
  // afterwards would pop it right back open while the prompt is processed.
  // Blur and collapse instead so the keyboard stays closed until the user taps
  // the composer again.
  const dismissMobileComposerKeyboard = useCallback(() => {
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      composerSurfaceRef.current?.contains(activeElement)
    ) {
      activeElement.blur();
    }
    // Commit the collapsed state before any deferred focus work can run. This
    // mirrors the synchronous expansion path and prevents a cleared mobile
    // draft from repainting the keyboard overlay after its submit settles.
    flushSync(() => {
      setIsComposerFocused(false);
    });
    mobileDebugLog("dismiss-keyboard", domSnapshot());
  }, []);

  // Detect the on-screen keyboard being dismissed without a blur (e.g. the
  // Android back button): the visual viewport grows back to its full height
  // while the editor still has focus. Collapse the composer when that happens
  // so the header/footer come back without requiring a tap outside the box.
  useEffect(() => {
    if (!isOnScreenKeyboardDevice || !isComposerFocused) return;
    const visualViewport = window.visualViewport;
    if (!visualViewport) return;
    // Baseline is captured on focus, before the keyboard animates in. Track
    // the max seen so fold/rotation changes mid-session update it.
    let baselineHeight = Math.max(visualViewport.height, window.innerHeight);
    let sawKeyboardOpen = false;
    const handleViewportResize = () => {
      baselineHeight = Math.max(baselineHeight, visualViewport.height, window.innerHeight);
      const keyboardInset = baselineHeight - visualViewport.height;
      if (keyboardInset > 120) {
        if (!sawKeyboardOpen) {
          sawKeyboardOpen = true;
          mobileDebugLog("keyboard-open-detected", { keyboardInset, ...domSnapshot() });
        }
        return;
      }
      if (sawKeyboardOpen && keyboardInset < 60) {
        mobileDebugLog("keyboard-close-detected", { keyboardInset, ...domSnapshot() });
        dismissMobileComposerKeyboard();
      }
    };
    visualViewport.addEventListener("resize", handleViewportResize);
    return () => {
      visualViewport.removeEventListener("resize", handleViewportResize);
    };
  }, [dismissMobileComposerKeyboard, isComposerFocused, isOnScreenKeyboardDevice]);

  const runComposerActionAfterDictation = useCallback(
    (action: () => void | Promise<void>) => {
      if (pendingDictationComposerActionRef.current) return;

      const operation = (async () => {
        let actionStarted = false;
        try {
          // `finish` resolves only after OpenAI's authoritative final transcript
          // has been applied through replaceComposerRange. Deferring `action`
          // until then means onSend/onSteer re-read the final prompt rather than
          // racing the interim text currently painted in the editor.
          if (!(await finishComposerDictation())) return;
          actionStarted = true;
          await action();
        } finally {
          // A failed/cancelled finalization never reaches runSubmitComposer's
          // own finally block. Settle any click guard here so a failed
          // microphone handoff cannot hide Stop behind Queue indefinitely.
          if (!actionStarted) {
            settlePostSubmitInterruptGuard();
          }
        }
      })();
      pendingDictationComposerActionRef.current = operation;
      const clearOperation = () => {
        if (pendingDictationComposerActionRef.current === operation) {
          pendingDictationComposerActionRef.current = null;
        }
      };
      void operation.then(clearOperation, clearOperation);
    },
    [finishComposerDictation, settlePostSubmitInterruptGuard],
  );

  const runSubmitComposer = useCallback(
    async (event?: { preventDefault: () => void }) => {
      if (blockedComposerFiles || props.queueEditing) {
        event?.preventDefault();
        return;
      }
      const keepKeyboardClosed = isOnScreenKeyboardDevice;
      mobileDebugLog("submit-start", { keepKeyboardClosed, ...domSnapshot() });
      try {
        await onSend(event);
      } finally {
        mobileDebugLog("submit-settled", { keepKeyboardClosed, ...domSnapshot() });
        settlePostSubmitInterruptGuard();
        if (keepKeyboardClosed) {
          dismissMobileComposerKeyboard();
        } else {
          requestComposerEditorFocus();
        }
      }
    },
    [
      dismissMobileComposerKeyboard,
      isOnScreenKeyboardDevice,
      onSend,
      requestComposerEditorFocus,
      settlePostSubmitInterruptGuard,
      blockedComposerFiles,
      props.queueEditing,
    ],
  );

  const submitComposer = useCallback(
    (event?: { preventDefault: () => void }) => {
      if (pendingDictationComposerActionRef.current) {
        event?.preventDefault();
        return;
      }
      if (composerDictation.isEditingLocked) {
        // Prevent the browser's native form submission immediately. The real
        // send is intentionally issued without this short-lived event only
        // after dictation finalization has committed the last transcript.
        event?.preventDefault();
        runComposerActionAfterDictation(() => runSubmitComposer());
        return;
      }
      void runSubmitComposer(event);
    },
    [composerDictation.isEditingLocked, runComposerActionAfterDictation, runSubmitComposer],
  );

  const runSteerComposer = useCallback(
    async (event?: { preventDefault: () => void }) => {
      if (blockedComposerFiles || props.queueEditing) {
        event?.preventDefault();
        return;
      }
      const keepKeyboardClosed = isOnScreenKeyboardDevice;
      try {
        await onSteer(event);
      } finally {
        if (keepKeyboardClosed) {
          dismissMobileComposerKeyboard();
        } else {
          requestComposerEditorFocus();
        }
      }
    },
    [
      dismissMobileComposerKeyboard,
      isOnScreenKeyboardDevice,
      onSteer,
      requestComposerEditorFocus,
      blockedComposerFiles,
      props.queueEditing,
    ],
  );

  const steerComposer = useCallback(
    (event?: { preventDefault: () => void }) => {
      if (pendingDictationComposerActionRef.current) {
        event?.preventDefault();
        return;
      }
      if (composerDictation.isEditingLocked) {
        event?.preventDefault();
        runComposerActionAfterDictation(() => runSteerComposer());
        return;
      }
      void runSteerComposer(event);
    },
    [composerDictation.isEditingLocked, runComposerActionAfterDictation, runSteerComposer],
  );

  useEffect(() => {
    const wasDisabled = previousComposerEditorDisabledRef.current;
    previousComposerEditorDisabledRef.current = composerEditorDisabled;
    if (!wasDisabled || composerEditorDisabled || activeThreadId === null) {
      return;
    }
    // Re-enabling after a send (busy -> idle) must not reopen the on-screen
    // keyboard on mobile.
    if (isOnScreenKeyboardDevice) {
      mobileDebugLog("editor-reenabled-skip-refocus", domSnapshot());
      return;
    }
    requestComposerEditorFocus();
  }, [
    activeThreadId,
    composerEditorDisabled,
    isOnScreenKeyboardDevice,
    requestComposerEditorFocus,
  ]);
  const expandMobileComposer = useCallback(() => {
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
    }
    mobileComposerExpandInFlightRef.current = true;
    // Commit the expanded state synchronously and focus within the same tap
    // gesture. Deferring the focus to an animation frame raced the React
    // commit (the editor could still be display:hidden, so focus silently
    // failed) and mobile browsers only open the on-screen keyboard for focus
    // calls made during a user gesture.
    flushSync(() => {
      setIsComposerFocused(true);
    });
    composerEditorRef.current?.focusAtEnd();
    mobileDebugLog("expand-mobile-composer", domSnapshot());
    mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
      mobileComposerExpandReleaseFrameRef.current = null;
      mobileComposerExpandInFlightRef.current = false;
    });
  }, []);

  // ------------------------------------------------------------------
  // Callbacks: command key
  // ------------------------------------------------------------------
  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => {
    if (key === "Tab" && event.shiftKey) {
      cycleComposerInteractionMode();
      return true;
    }
    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;
    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if ((key === "Enter" || key === "Tab") && selectedItem) {
        onSelectComposerItem(selectedItem);
        return true;
      }
    }
    if (key === "Enter" && !event.shiftKey) {
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          composerFocused: true,
          modelPickerOpen: isComposerModelPickerOpen,
        },
      });
      if (command === "composer.steer") {
        steerComposer();
        return true;
      }
      // On touch devices a bare Enter from the on-screen keyboard inserts a
      // newline; sending is done with the send button. Modifier shortcuts
      // (e.g. Ctrl+Enter from a paired hardware keyboard) still submit.
      if (isOnScreenKeyboardDevice && !event.metaKey && !event.ctrlKey && !event.altKey) {
        return false;
      }
      if (command === "composer.submit" || (!event.metaKey && !event.ctrlKey && !event.altKey)) {
        submitComposer();
        return true;
      }
      return false;
    }
    return false;
  };

  // ------------------------------------------------------------------
  // Callbacks: images
  // ------------------------------------------------------------------
  const uploadTailRef = useRef<Promise<void>>(Promise.resolve());
  const queueFileUpload = (file: ComposerFileAttachment) => {
    const target = composerDraftTarget;
    const update = (patch: Partial<ComposerFileAttachment>) => {
      const store = useComposerDraftStore.getState();
      // Removed uploads may finish, but must never reappear in a newer draft.
      store.updateFile(target, file.id, patch);
    };
    update({ status: "uploading", error: undefined });
    uploadTailRef.current = uploadTailRef.current.then(async () => {
      if (!file.file) return;
      try {
        const attachment = await uploadFileAttachment({
          environmentId: file.environmentId,
          targetThreadId: file.targetThreadId,
          file: file.file,
          // A draft can move behind a queue-edit backup while its upload is in
          // flight. Check exact file/env/thread identity across durable drafts,
          // including that backup, without letting a removed file reappear.
          shouldRetain: () =>
            Object.values(useComposerDraftStore.getState().draftsByThreadKey).some((draft) =>
              draft.files.some(
                (entry) =>
                  entry.id === file.id &&
                  entry.environmentId === file.environmentId &&
                  entry.targetThreadId === file.targetThreadId,
              ),
            ),
        });
        update({ status: "ready", attachment, file: undefined, error: undefined });
      } catch {
        update({
          status: "failed",
          error: "Upload failed. Retry, or remove this file before sending.",
        });
      }
    });
  };

  const addComposerImages = (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;
    if (isSendBusy) {
      toastManager.add({
        type: "error",
        title: "Wait for the current submission before adding more files.",
      });
      return;
    }
    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach files after answering plan questions.",
      });
      return;
    }
    const nextImages: ComposerImageAttachment[] = [];
    const currentDraft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
    const nextFiles: ComposerFileAttachment[] = [];
    let nextImageCount = (currentDraft?.images.length ?? 0) + (currentDraft?.files.length ?? 0);
    let totalBytes = [...(currentDraft?.images ?? []), ...(currentDraft?.files ?? [])].reduce(
      (sum, file) => sum + file.sizeBytes,
      0,
    );
    let error: string | null = null;
    for (const file of files) {
      const isImage = isComposerImageFile(file);
      const limit = isImage
        ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
      if (file.size > limit) {
        error = `'${file.name}' exceeds the ${isImage ? IMAGE_SIZE_LIMIT_LABEL : "25MB"} attachment limit.`;
        continue;
      }
      if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files or images per message.`;
        break;
      }
      if (totalBytes + file.size > PROVIDER_SEND_TURN_MAX_TOTAL_ATTACHMENT_BYTES) {
        error = "Combined attachments exceed the 80MB limit.";
        continue;
      }
      totalBytes += file.size;
      nextImageCount += 1;
      if (!isImage) {
        nextFiles.push({
          id: randomUUID(),
          environmentId,
          targetThreadId: activeThreadId,
          name: file.name || "file",
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          status: "uploading",
          file,
        });
        continue;
      }
      const previewUrl = URL.createObjectURL(file);
      nextImages.push({
        type: "image",
        id: randomUUID(),
        name: file.name || "image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
    }
    if (nextImages.length === 1 && nextImages[0]) {
      addComposerImage(nextImages[0]);
    } else if (nextImages.length > 1) {
      addComposerImagesToDraft(nextImages);
    }
    if (nextFiles.length > 0) {
      const store = useComposerDraftStore.getState();
      store.setFiles(composerDraftTarget, [
        ...(store.getComposerDraft(composerDraftTarget)?.files ?? []),
        ...nextFiles,
      ]);
      for (const file of nextFiles) queueFileUpload(file);
    }
    setThreadError(activeThreadId, error);
  };

  const removeComposerImage = (imageId: string) => {
    if (isSendBusy) return;
    removeComposerImageFromDraft(imageId);
  };
  const removeComposerFile = (fileId: string) => {
    if (isSendBusy) return;
    const store = useComposerDraftStore.getState();
    store.setFiles(
      composerDraftTarget,
      (store.getComposerDraft(composerDraftTarget)?.files ?? []).filter(
        (entry) => entry.id !== fileId,
      ),
    );
  };

  // ------------------------------------------------------------------
  // Callbacks: paste / drag
  // ------------------------------------------------------------------
  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    addComposerImages(files);
  };

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    addComposerImages(files);
    focusComposer();
  };

  // Touch devices can't paste or drag-drop images, so a file picker is the
  // only practical way to attach on mobile; desktop gets the affordance too.
  const openComposerImagePicker = () => {
    composerFileInputRef.current?.click();
  };

  const onComposerFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Reset so picking the same file again after removal still fires change.
    event.target.value = "";
    if (files.length === 0) return;
    addComposerImages(files);
    focusComposer();
  };
  const handleInterruptPrimaryAction = useCallback(() => {
    void onInterrupt();
  }, [onInterrupt]);
  const handleImplementPlanInNewThreadPrimaryAction = useCallback(() => {
    void onImplementPlanInNewThread();
  }, [onImplementPlanInNewThread]);
  const scheduleComposerCollapseCheck = useCallback(() => {
    if (!isOnScreenKeyboardDevice) {
      return;
    }
    if (mobileComposerExpandInFlightRef.current) {
      return;
    }
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
    }
    composerBlurFrameRef.current = window.requestAnimationFrame(() => {
      composerBlurFrameRef.current = null;
      if (mobileComposerExpandInFlightRef.current) {
        return;
      }
      const composerSurface = composerSurfaceRef.current;
      const activeElement = document.activeElement;
      if (activeElement instanceof Element && isInsideComposerFloatingLayer(activeElement)) {
        return;
      }
      if (
        composerSurface &&
        activeElement instanceof Node &&
        composerSurface.contains(activeElement)
      ) {
        return;
      }
      setIsComposerFocused(false);
    });
  }, [isOnScreenKeyboardDevice]);

  useEffect(() => {
    const composerBlurFrameRefForCleanup = composerBlurFrameRef;
    const mobileComposerExpandFrameRefForCleanup = mobileComposerExpandFrameRef;
    const mobileComposerExpandReleaseFrameRefForCleanup = mobileComposerExpandReleaseFrameRef;
    return () => {
      if (composerBlurFrameRefForCleanup.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRefForCleanup.current);
      }
      if (mobileComposerExpandFrameRefForCleanup.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandFrameRefForCleanup.current);
      }
      if (mobileComposerExpandReleaseFrameRefForCleanup.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRefForCleanup.current);
      }
    };
  }, []);

  // ------------------------------------------------------------------
  // Imperative handle
  // ------------------------------------------------------------------
  useImperativeHandle(
    composerRef,
    () => ({
      focusAtEnd: () => {
        composerEditorRef.current?.focusAtEnd();
      },
      focusAt: (cursor: number) => {
        composerEditorRef.current?.focusAt(cursor);
      },
      openModelPicker: () => {
        setIsComposerModelPickerOpen(true);
      },
      toggleModelPicker: () => {
        setIsComposerModelPickerOpen((open) => !open);
      },
      isModelPickerOpen: () => isComposerModelPickerOpen,
      readDebugState: () => ({
        activeThreadId,
        phase,
        selectedProvider,
        selectedInstanceId,
        selectedModelSelection,
        composerEditorDisabled,
        composerFocusRequestRevision,
        isComposerFocused,
        isOnScreenKeyboardDevice,
        isComposerCollapsedMobile,
        isSendBusy,
        isConnecting,
        editor: composerEditorRef.current?.readDebugState() ?? null,
      }),
      readSnapshot: () => {
        return readComposerSnapshot();
      },
      resetCursorState: (options?: {
        cursor?: number;
        prompt?: string;
        detectTrigger?: boolean;
      }) => {
        const promptForState = options?.prompt ?? promptRef.current;
        const cursor = clampCollapsedComposerCursor(promptForState, options?.cursor ?? 0);
        setComposerHighlightedItemId(null);
        setComposerCursor(cursor);
        setComposerTrigger(
          options?.detectTrigger
            ? detectComposerTrigger(
                promptForState,
                expandCollapsedComposerCursor(promptForState, cursor),
              )
            : null,
        );
      },
      getSendContext: () => ({
        prompt: promptRef.current,
        images: composerImagesRef.current,
        files: useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.files ?? [],
        selectedPromptEffort,
        selectedModelOptionsForDispatch,
        selectedModelSelection,
        selectedProvider,
        selectedModel,
        selectedProviderModels,
        ...(desiredSubagentLimits !== undefined ? { subagentLimits: desiredSubagentLimits } : {}),
        ...(deliveryPriority !== undefined ? { deliveryPriority } : {}),
      }),
    }),
    [
      promptRef,
      composerImagesRef,
      composerDraftTarget,
      activeThreadId,
      composerEditorDisabled,
      composerFocusRequestRevision,
      isComposerModelPickerOpen,
      isComposerCollapsedMobile,
      isComposerFocused,
      isConnecting,
      isOnScreenKeyboardDevice,
      isSendBusy,
      phase,
      readComposerSnapshot,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedModelSelection,
      selectedInstanceId,
      selectedPromptEffort,
      selectedProvider,
      selectedProviderModels,
      desiredSubagentLimits,
      deliveryPriority,
    ],
  );

  const renderComposerDictationButton = (className?: string): ReactNode =>
    showComposerDictation ? (
      <ComposerDictationButton
        phase={composerDictation.phase}
        statusMessage={composerDictation.statusMessage}
        disabled={isComposerDictationUnavailable}
        preserveComposerFocusOnPointerDown
        {...(className ? { className } : {})}
        onToggle={composerDictation.toggle}
      />
    ) : null;

  // Render
  // ------------------------------------------------------------------
  const hasFollowUpQueue = followUpQueueItems.length > 0 || steeringFollowUpItems.length > 0;
  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposer}
      className="@container/composer mx-auto flow-root w-full min-w-0 max-w-208"
      data-chat-composer-form="true"
    >
      <input
        ref={composerFileInputRef}
        type="file"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onComposerFileInputChange}
      />
      <div
        className={cn(
          "group relative isolate rounded-2xl p-px transition-[color,background-color,border-color] duration-(--duration-slow) motion-reduce:transition-none",
          hasComposerTab && "mt-9 pointer-coarse:mt-12",
          composerProviderState.composerFrameClassName ??
            (ambianceComposerRing ? "cafe-ambiance-composer-frame" : undefined),
        )}
        onDragEnter={onComposerDragEnter}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
      >
        {hasComposerTab ? (
          <div
            data-chat-composer-tab="true"
            className="absolute inset-x-6 bottom-full -z-10 -mb-1 flex justify-end"
          >
            <ComposerTab
              label="Composer tools"
              collapsed={composerTabCollapsed}
              active={nativeReviewOpen}
              onCollapsedChange={useUiStateStore.getState().setComposerTabCollapsed}
            >
              {showNativeReviewControl ? (
                <Tooltip>
                  <TooltipTrigger
                    delay={250}
                    render={
                      <button
                        type="button"
                        className="cafe-composer-tab-action"
                        aria-haspopup="dialog"
                        aria-expanded={nativeReviewOpen}
                        aria-disabled={nativeReviewControlDisabled}
                        onClick={() => {
                          if (nativeReviewControlDisabled) return;
                          setNativeReviewState({ key: nativeReviewKey, open: true });
                        }}
                      />
                    }
                  >
                    <FileSearchIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="truncate">Code review</span>
                  </TooltipTrigger>
                  <TooltipPopup
                    role="tooltip"
                    side="top"
                    className="no-drag pointer-events-none max-w-64 leading-relaxed"
                  >
                    Review code with Codex
                    {nativeReviewControlDisabled && nativeReviewDisabledReason ? (
                      <span className="block text-muted-foreground">
                        {nativeReviewDisabledReason}
                      </span>
                    ) : null}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              {showDeliveryPriorityControl ? (
                <ClaudeDeliveryPriorityControl
                  key={deliveryChoiceKey}
                  value={deliveryPriority}
                  onChange={(priority) => setDeliveryChoice({ key: deliveryChoiceKey, priority })}
                  disabled={deliveryPriorityDisabled}
                  disabledReason={deliveryPriorityDisabledReason}
                  collapsed={composerTabCollapsed}
                />
              ) : null}
            </ComposerTab>
          </div>
        ) : null}
        <FollowUpQueueShelf
          attached
          items={followUpQueueItems}
          steeringItems={steeringFollowUpItems}
          actionLabel={followUpQueueActionLabel}
          actionTitle={followUpQueueActionTitle}
          onToggleExpanded={onToggleFollowUpQueueItem}
          onAction={onActivateFollowUpQueueItem}
          onRemove={onRemoveFollowUpQueueItem}
          onEdit={props.onEditFollowUpQueueItem}
          onClear={onClearFollowUpQueue}
          onExpandImage={onExpandImage}
        />
        <div
          ref={composerSurfaceRef}
          data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
          data-chat-composer-keyboard-open={
            isOnScreenKeyboardDevice && isComposerFocused ? "true" : "false"
          }
          className={cn(
            "rounded-[calc(var(--radius-2xl)-1px)] border bg-card transition-colors duration-(--duration-slow) has-focus-visible:border-ring/45",
            hasFollowUpQueue && "rounded-t-none",
            isDragOverComposer ? "border-primary bg-accent/30" : "border-border",
            environmentUnavailable ? "opacity-75" : null,
            composerProviderState.composerSurfaceClassName,
          )}
          onClick={(event) => {
            // Taps on the collapsed surface's padding/edges should expand the
            // composer just like tapping the prompt preview; without this a tap
            // that misses the preview button does nothing (or worse, leaves a
            // half-expanded state with no keyboard).
            if (!isComposerCollapsedMobile) return;
            if (
              event.target instanceof Element &&
              event.target.closest(
                '[data-chat-composer-collapsed-controls="true"], button, [role="button"], a, input, textarea, [contenteditable="true"]',
              )
            ) {
              return;
            }
            mobileDebugLog("surface-edge-tap-expand", domSnapshot());
            expandMobileComposer();
          }}
          onFocusCapture={(event) => {
            const activeElement = event.target;
            // While collapsed, only focus landing on the editor itself may
            // expand the composer. Buttons (preview row, toolbar controls) can
            // receive raw focus from a tap before their click fires; expanding
            // on that focus re-renders the surface mid-gesture, swallows the
            // click, and leaves an expanded composer with no keyboard. Those
            // controls expand via their own click handlers instead.
            if (
              isComposerCollapsedMobile &&
              !(
                activeElement instanceof HTMLElement &&
                activeElement.closest('[data-testid="composer-editor"]')
              )
            ) {
              mobileDebugLog("collapsed-focus-ignored", {
                target:
                  activeElement instanceof HTMLElement
                    ? (activeElement.getAttribute("aria-label") ?? activeElement.tagName)
                    : "<unknown>",
              });
              return;
            }
            if (composerBlurFrameRef.current !== null) {
              window.cancelAnimationFrame(composerBlurFrameRef.current);
              composerBlurFrameRef.current = null;
            }
            setIsComposerFocused(true);
          }}
          onBlurCapture={() => {
            scheduleComposerCollapseCheck();
          }}
        >
          {!isComposerCollapsedMobile &&
            (activePendingApproval ? (
              <div
                key={`approval:${activePendingApproval.requestId}`}
                className={COMPOSER_PANEL_CLASS_NAME}
              >
                <ComposerPendingApprovalPanel
                  approval={activePendingApproval}
                  pendingCount={pendingApprovals.length}
                />
              </div>
            ) : pendingUserInputs.length > 0 ? (
              <div
                key={`user-input:${pendingUserInputs[0]?.requestId ?? ""}`}
                className={COMPOSER_PANEL_CLASS_NAME}
              >
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
                  respondingRequestIds={respondingRequestIds}
                  answers={activePendingDraftAnswers}
                  questionIndex={activePendingQuestionIndex}
                  onToggleOption={onSelectActivePendingUserInputOption}
                  onAdvance={onAdvanceActivePendingUserInput}
                  autoResolutionSnoozed={activePendingAutoResolutionSnoozed}
                  onSnoozeAutoResolution={onSnoozeActivePendingUserInput}
                  {...(onRespondToInteraction ? { onRespondToInteraction } : {})}
                  {...(onResolveInteractionUrl ? { onResolveInteractionUrl } : {})}
                />
              </div>
            ) : showPlanFollowUpPrompt && activeProposedPlan ? (
              <div key={`plan:${activeProposedPlan.id}`} className={COMPOSER_PANEL_CLASS_NAME}>
                <ComposerPlanFollowUpBanner
                  key={activeProposedPlan.id}
                  planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                />
              </div>
            ) : null)}

          {isComposerCollapsedMobile && activePendingApproval ? (
            <div
              key={`approval:${activePendingApproval.requestId}`}
              className={COMPOSER_PANEL_CLASS_NAME}
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingApprovalPanel
                approval={activePendingApproval}
                pendingCount={pendingApprovals.length}
              />
              <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-3 sm:px-4">
                <ComposerPendingApprovalActions
                  requestId={activePendingApproval.requestId}
                  defaultToNo={activePendingApproval.defaultToNo === true}
                  suppressAlwaysAllowRule={activePendingApproval.suppressAlwaysAllowRule === true}
                  networkApproval={activePendingApproval.networkApproval !== undefined}
                  isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                  onRespondToApproval={onRespondToApproval}
                />
              </div>
            </div>
          ) : isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
            <div
              key={`user-input:${pendingUserInputs[0]?.requestId ?? ""}`}
              className={COMPOSER_PANEL_CLASS_NAME}
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingUserInputPanel
                pendingUserInputs={pendingUserInputs}
                respondingRequestIds={respondingRequestIds}
                answers={activePendingDraftAnswers}
                questionIndex={activePendingQuestionIndex}
                onToggleOption={onSelectActivePendingUserInputOption}
                onAdvance={onAdvanceActivePendingUserInput}
                autoResolutionSnoozed={activePendingAutoResolutionSnoozed}
                onSnoozeAutoResolution={onSnoozeActivePendingUserInput}
                {...(onRespondToInteraction ? { onRespondToInteraction } : {})}
                {...(onResolveInteractionUrl ? { onResolveInteractionUrl } : {})}
              />
              <div
                className="px-3 pb-3 sm:px-4"
                hidden={Boolean(activePendingUserInput?.interaction)}
              >
                <div
                  data-chat-composer-mobile-pending-compact="true"
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background/60 p-1.5 pl-3 transition-colors duration-(--duration-fast) hover:bg-background",
                    !activePendingProgress?.activeQuestion?.multiSelect && "p-0",
                  )}
                >
                  <button
                    type="button"
                    className={cn(
                      "min-w-0 flex-1 truncate bg-transparent py-1.5 text-left text-sm",
                      activePendingProgress?.customAnswer
                        ? "text-foreground"
                        : "text-subtle-foreground",
                      !activePendingProgress?.activeQuestion?.multiSelect && "px-3 py-2",
                    )}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={expandMobileComposer}
                    aria-label="Write custom answer"
                  >
                    {activePendingProgress?.customAnswer || "Write custom answer"}
                  </button>
                  {activePendingProgress?.activeQuestion?.multiSelect ? (
                    <ComposerPrimaryActions
                      compact
                      pendingAction={pendingPrimaryAction}
                      isRunning={false}
                      showPlanFollowUpPrompt={false}
                      promptHasText={false}
                      isSendBusy={isComposerPrimaryActionBusy}
                      isConnecting={isConnecting}
                      isEnvironmentUnavailable={environmentUnavailable !== null}
                      isPreparingWorktree={false}
                      hasSendableContent={false}
                      postSubmitInterruptGuardActive={postSubmitInterruptGuardActive}
                      preserveComposerFocusOnPointerDown
                      onArmPostSubmitInterruptGuard={armPostSubmitInterruptGuard}
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={handleInterruptPrimaryAction}
                      onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {showCollapsedMobilePromptRow ? (
            // Collapsed (keyboard down) the composer shows a one-line prompt
            // preview; the full bottom toolbar below keeps every control (model,
            // modes, traits, send) available, matching the desktop layout.
            // Horizontal padding mirrors the bottom toolbar (px-2.5 sm:px-3) plus
            // the model picker trigger's internal px-2, so the preview text lines
            // up with the picker's icon below it.
            <div className="flex items-center gap-2 px-2.5 pb-1 pt-3 sm:px-3">
              <button
                type="button"
                className={cn(
                  "min-w-0 flex-1 truncate bg-transparent py-0 pl-2 pr-0 text-left text-[16px] leading-relaxed focus:outline-none",
                  (activePendingProgress ? activePendingProgress.customAnswer : prompt.trim())
                    ? "text-foreground"
                    : "text-subtle-foreground",
                )}
                onPointerDown={(event) => event.preventDefault()}
                onClick={expandMobileComposer}
                aria-label="Expand composer"
              >
                {activePendingProgress
                  ? activePendingProgress.customAnswer || PENDING_ANSWER_PLACEHOLDER
                  : prompt.trim() || "Ask anything…"}
              </button>
              {composerImages.length + composerFiles.length > 0 ? (
                // The image preview strip is hidden while collapsed, so surface
                // a compact count pill to reassure the user their attachments
                // are still there. Tapping it expands the composer to manage them.
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground focus:outline-none"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={expandMobileComposer}
                  aria-label={`${composerImages.length + composerFiles.length} ${
                    composerImages.length + composerFiles.length === 1
                      ? "attachment"
                      : "attachments"
                  } attached — expand composer`}
                >
                  <ImageIcon aria-hidden="true" className="size-3" />
                  {composerImages.length + composerFiles.length}{" "}
                  {composerImages.length + composerFiles.length === 1
                    ? "attachment"
                    : "attachments"}
                </button>
              ) : null}
            </div>
          ) : null}

          <div
            className={cn(
              "relative px-3 pb-2 sm:px-4",
              hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
              (isComposerCollapsedMobile || activePendingUserInput?.interaction) && "hidden",
            )}
          >
            {composerMenuOpen && !isComposerApprovalState && (
              <div className="absolute inset-x-0 bottom-full z-20 mb-2 origin-bottom animate-enter-rise px-1">
                <ComposerCommandMenu
                  items={composerMenuItems}
                  resolvedTheme={resolvedTheme}
                  isLoading={isComposerMenuLoading}
                  triggerKind={composerTriggerKind}
                  groupSlashCommandSections={
                    composerTrigger?.kind === "slash-command" &&
                    composerTrigger.query.trim().length === 0
                  }
                  emptyStateText={composerMenuEmptyState}
                  statusText={
                    composerTriggerKind === "slash-command" && selectedProvider === "claudeAgent"
                      ? commandsInput === null
                        ? "Claude commands load once this chat connects."
                        : discoveredCommands.status === "loading"
                          ? "Refreshing Claude commands…"
                          : discoveredCommands.status === "unavailable"
                            ? "Claude commands unavailable. Reopen to retry, or type one."
                            : undefined
                      : undefined
                  }
                  activeItemId={activeComposerMenuItem?.id ?? null}
                  onHighlightedItemChange={onComposerMenuItemHighlighted}
                  onSelect={onSelectComposerItem}
                />
              </div>
            )}

            {props.queueEditing ? (
              <div className="mb-2 flex animate-enter-rise flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-xs">
                <span className="grow">Editing queued message. Your draft is saved.</span>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    isSendBusy || blockedComposerFiles || !composerSendState.hasSendableContent
                  }
                  onClick={props.onSaveQueueEdit}
                >
                  Save to queue
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isSendBusy}
                  onClick={props.onCancelQueueEdit}
                >
                  Cancel editing
                </Button>
              </div>
            ) : null}
            {composerFiles.length > 0 && !isComposerCollapsedMobile ? (
              <div
                ref={composerFilesListRef}
                className="mb-3 flex flex-wrap gap-2"
                aria-label="Uploaded file copies"
              >
                {composerFiles.map((file) => {
                  const sameDestination =
                    file.environmentId === environmentId && file.targetThreadId === activeThreadId;
                  return file.status === "ready" && file.attachment && sameDestination ? (
                    <FileAttachmentPill
                      key={file.id}
                      attachment={file.attachment}
                      environmentId={file.environmentId}
                      onRemove={() => removeComposerFile(file.id)}
                    />
                  ) : (
                    <FileAttachmentPendingPill
                      key={file.id}
                      name={file.name}
                      sizeBytes={file.sizeBytes}
                      status={!sameDestination ? "failed" : file.status}
                      error={
                        !sameDestination
                          ? "Uploaded to another destination. Remove and select again."
                          : file.error
                      }
                      onRetry={
                        file.status === "failed" && file.file && sameDestination
                          ? () => queueFileUpload(file)
                          : undefined
                      }
                      onRemove={() => removeComposerFile(file.id)}
                    />
                  );
                })}
                {fileDraftPersistenceFailed ? (
                  <span role="alert" className="basis-full text-xs text-destructive-foreground">
                    These file handles could not be saved in browser storage. Keep this page open
                    and free storage before reloading.
                  </span>
                ) : null}
              </div>
            ) : null}
            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerImages.length > 0 && (
                <div ref={composerImagesListRef} className="mb-3 flex flex-wrap gap-2">
                  {composerImages.map((image) => (
                    <div
                      key={image.id}
                      className="relative h-16 w-16 overflow-hidden rounded-lg border border-border bg-background"
                    >
                      {image.previewUrl ? (
                        <button
                          type="button"
                          className="h-full w-full cursor-zoom-in"
                          aria-label={`Preview ${image.name}`}
                          onClick={() => {
                            const preview = buildExpandedImagePreview(composerImages, image.id);
                            if (!preview) return;
                            onExpandImage(preview);
                          }}
                        >
                          <img
                            src={image.previewUrl}
                            alt={image.name}
                            className="h-full w-full object-cover"
                          />
                        </button>
                      ) : (
                        <div className="flex h-full w-full items-center justify-center px-1 text-center text-2xs text-muted-foreground">
                          {image.name}
                        </div>
                      )}
                      {nonPersistedComposerImageIdSet.has(image.id) && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span
                                role="img"
                                aria-label="Draft attachment may not persist"
                                className="absolute left-1 top-1 inline-flex items-center justify-center rounded-sm bg-background/85 p-0.5 text-warning-foreground"
                              >
                                <CircleAlertIcon className="size-3" />
                              </span>
                            }
                          />
                          <TooltipPopup
                            side="top"
                            className="max-w-64 whitespace-normal leading-tight"
                          >
                            Draft attachment could not be saved locally and may be lost on
                            navigation.
                          </TooltipPopup>
                        </Tooltip>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                        onClick={() => removeComposerImage(image.id)}
                        aria-label={`Remove ${image.name}`}
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

            <div className="relative">
              <ComposerPromptEditor
                editorRef={composerEditorRef}
                value={
                  isComposerApprovalState
                    ? ""
                    : activePendingProgress
                      ? activePendingProgress.customAnswer
                      : prompt
                }
                cursor={composerCursor}
                skills={selectedProviderSkills}
                focusRequestRevision={composerFocusRequestRevision}
                {...(showMobileComposerActionsOverlay ? { className: "max-h-40 pb-11" } : {})}
                onChange={onPromptChange}
                onCommandKeyDown={onComposerCommandKey}
                onPaste={onComposerPaste}
                placeholder={
                  isComposerApprovalState
                    ? "Approve or decline to continue"
                    : activePendingProgress
                      ? PENDING_ANSWER_PLACEHOLDER
                      : showPlanFollowUpPrompt && activeProposedPlan
                        ? "Add feedback, or leave blank to implement"
                        : environmentUnavailable
                          ? `${environmentUnavailable.label} is ${
                              environmentUnavailable.connectionState === "connecting"
                                ? "connecting"
                                : "disconnected"
                            }`
                          : phase === "disconnected" && (activeThread?.messages.length ?? 0) > 0
                            ? "Ask for follow-up changes…"
                            : composerSkillsSupported
                              ? "Ask anything · @ files · $ skills · / commands"
                              : "Ask anything · @ files · / commands"
                }
                disabled={composerEditorDisabled}
              />
              {showMobileComposerActionsOverlay ? (
                <div
                  data-chat-composer-mobile-pending-actions="true"
                  className="absolute bottom-0 right-0 flex items-center justify-end gap-1.5"
                >
                  <ComposerTaskProgress
                    providerTasks={providerTasks}
                    scheduledFollowups={scheduledFollowups}
                    plan={activePlan}
                    subagents={activeSubagents}
                    onOpenSubagentDetail={onOpenSubagentDetail}
                    sessionRailVisible={sessionRailVisible}
                    {...(onShowSessionRail ? { onShowOnSide: onShowSessionRail } : {})}
                  />
                  {pendingUserInputs.length === 0 ? (
                    <ComposerAttachImageButton
                      preserveComposerFocusOnPointerDown
                      disabled={activeThreadId === null}
                      className="bg-background/80 hover:bg-background/90"
                      onClick={openComposerImagePicker}
                    />
                  ) : null}
                  {renderComposerDictationButton("bg-background/80 hover:bg-background/90")}
                  <ComposerPrimaryActions
                    compact
                    pendingAction={pendingPrimaryAction}
                    isRunning={phase === "running"}
                    showPlanFollowUpPrompt={
                      pendingUserInputs.length === 0 && showPlanFollowUpPrompt
                    }
                    promptHasText={prompt.trim().length > 0}
                    isSendBusy={isComposerPrimaryActionBusy}
                    isQueueEditing={props.queueEditing ?? false}
                    isConnecting={isConnecting}
                    isEnvironmentUnavailable={environmentUnavailable !== null}
                    isPreparingWorktree={isPreparingWorktree}
                    hasSendableContent={composerSendState.hasSendableContent}
                    postSubmitInterruptGuardActive={postSubmitInterruptGuardActive}
                    preserveComposerFocusOnPointerDown
                    onArmPostSubmitInterruptGuard={armPostSubmitInterruptGuard}
                    onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                    onInterrupt={handleInterruptPrimaryAction}
                    onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                  />
                </div>
              ) : null}
            </div>
          </div>

          {/* Bottom toolbar. On touch devices the full toolbar stays available
              while the composer is collapsed (keyboard down) for parity with
              desktop; it is hidden only while the on-screen keyboard is open
              (the editor overlay provides the primary action then). */}
          {activePendingUserInput?.interaction ||
          showMobileComposerActionsOverlay ||
          (isComposerCollapsedMobile &&
            !showCollapsedMobilePromptRow) ? null : activePendingApproval ? (
            <div className="flex min-w-0 items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
              <ComposerTaskProgress
                providerTasks={providerTasks}
                scheduledFollowups={scheduledFollowups}
                plan={activePlan}
                subagents={activeSubagents}
                onOpenSubagentDetail={onOpenSubagentDetail}
                sessionRailVisible={sessionRailVisible}
                {...(onShowSessionRail ? { onShowOnSide: onShowSessionRail } : {})}
              />
              <ComposerPendingApprovalActions
                requestId={activePendingApproval.requestId}
                defaultToNo={activePendingApproval.defaultToNo === true}
                suppressAlwaysAllowRule={activePendingApproval.suppressAlwaysAllowRule === true}
                networkApproval={activePendingApproval.networkApproval !== undefined}
                isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                onRespondToApproval={onRespondToApproval}
              />
            </div>
          ) : (
            <div
              data-chat-composer-footer="true"
              data-chat-composer-footer-compact={isComposerFooterCompact ? "true" : "false"}
              data-chat-composer-collapsed-controls="true"
              className={cn(
                // A tiny pane beside an open sidebar can be narrower than
                // Tasks plus the primary actions. Let those actions use a
                // second row instead of overflowing the usable chat width.
                "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2.5 sm:px-3 sm:pb-3 @max-[20rem]/composer:flex-wrap",
                isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
              )}
            >
              <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <ComposerAttachImageButton
                  disabled={pendingUserInputs.length > 0 || activeThreadId === null}
                  onClick={openComposerImagePicker}
                />
                <ProviderModelPicker
                  compact={isComposerFooterCompact}
                  activeInstanceId={selectedInstanceId}
                  model={selectedModelForPickerWithCustomFallback}
                  lockedProvider={lockedProvider}
                  lockedContinuationGroupKey={lockedContinuationGroupKey}
                  instanceEntries={providerInstanceEntries}
                  keybindings={keybindings}
                  modelOptionsByInstance={modelOptionsByInstance}
                  open={isComposerModelPickerOpen}
                  {...(composerProviderState.modelPickerIconClassName
                    ? {
                        activeProviderIconClassName: composerProviderState.modelPickerIconClassName,
                      }
                    : {})}
                  onOpenChange={(open) => {
                    setIsComposerModelPickerOpen(open);
                  }}
                  onRequestModelsRefresh={requestProviderModelsRefresh}
                  onInstanceModelChange={onProviderModelSelect}
                />

                <ComputerUseButton
                  threadId={activeThreadId}
                  provider={selectedProvider}
                  local={environmentId === primaryEnvironmentId}
                  compact={isComposerFooterCompact}
                />
                <CompactComposerControlsMenu
                  showPlanSidebar={showPlanSidebarToggle}
                  provider={selectedProvider}
                  interactionMode={interactionMode}
                  planSidebarLabel={planSidebarLabel}
                  planSidebarOpen={planSidebarOpen}
                  runtimeMode={runtimeMode}
                  showInteractionModeToggle={
                    composerProviderControls.showInteractionModeToggle ||
                    selectedProviderUsesNativePermissionModes
                  }
                  showGoalControl={goalControlsSupported}
                  goalStatus={activeThread?.goal?.status ?? null}
                  traitsMenuContent={providerTraitsMenuContent}
                  subagentConcurrencyControl={concurrencyMenuItem}
                  providerActions={providerActions}
                  traitsTriggerLabel={
                    providerTraitsMenuContent ? composerProviderState.traitsTriggerLabel : null
                  }
                  onToggleInteractionMode={cycleComposerInteractionMode}
                  onNativePermissionModeChange={handleClaudePermissionModeChange}
                  onTogglePlanSidebar={togglePlanSidebar}
                  onRuntimeModeChange={handleRuntimeModeChange}
                  onOpenGoal={onOpenGoalDialog}
                />
              </div>

              {/* Keep task progress outside the horizontally scrolling provider
                  controls so the status remains legible on narrow screens. The
                  popover itself is portaled and cannot be clipped by the footer. */}
              <ComposerTaskProgress
                providerTasks={providerTasks}
                scheduledFollowups={scheduledFollowups}
                plan={activePlan}
                subagents={activeSubagents}
                onOpenSubagentDetail={onOpenSubagentDetail}
                sessionRailVisible={sessionRailVisible}
                {...(onShowSessionRail ? { onShowOnSide: onShowSessionRail } : {})}
              />

              {/* Right side: dictation plus send / stop button */}
              <div
                data-chat-composer-actions="right"
                data-chat-composer-primary-actions-compact={
                  isComposerPrimaryActionsCompact ? "true" : "false"
                }
                className="ml-2 flex shrink-0 flex-nowrap items-center justify-end gap-2 @max-[20rem]/composer:ml-auto"
              >
                <ComposerFooterPrimaryActions
                  compact={isComposerPrimaryActionsCompact}
                  activeContextWindow={activeContextWindow}
                  codexRateLimits={selectedCodexRateLimits}
                  usageResetAction={
                    <ProviderUsageResetButton
                      key={`${environmentId}:${selectedProviderStatus?.instanceId ?? ""}`}
                      provider={selectedProviderStatus}
                      request={(input) =>
                        requireEnvironmentConnection(environmentId).client.server.usageReset(input)
                      }
                    />
                  }
                  subagentConcurrency={concurrencyPresentation}
                  sessionRailVisible={sessionRailVisible}
                  {...(onShowSessionRail ? { onShowSessionRail } : {})}
                  pendingAction={pendingPrimaryAction}
                  isRunning={phase === "running"}
                  showPlanFollowUpPrompt={pendingUserInputs.length === 0 && showPlanFollowUpPrompt}
                  promptHasText={prompt.trim().length > 0}
                  isSendBusy={isComposerPrimaryActionBusy}
                  isQueueEditing={props.queueEditing ?? false}
                  isConnecting={isConnecting}
                  isEnvironmentUnavailable={environmentUnavailable !== null}
                  isPreparingWorktree={isPreparingWorktree}
                  hasSendableContent={composerSendState.hasSendableContent}
                  postSubmitInterruptGuardActive={postSubmitInterruptGuardActive}
                  pendingStatusLabel={composerPendingStatusLabel}
                  dictationAction={renderComposerDictationButton()}
                  preserveComposerFocusOnPointerDown
                  onArmPostSubmitInterruptGuard={armPostSubmitInterruptGuard}
                  onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                  onInterrupt={handleInterruptPrimaryAction}
                  onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                />
              </div>
            </div>
          )}
        </div>
      </div>
      {nativeReviewAvailable && onStartCodeReview ? (
        <NativeCodexReview
          key={nativeReviewKey}
          open={nativeReviewOpen}
          onOpenChange={(open) =>
            setNativeReviewState((current) =>
              current.key === nativeReviewKey ? { key: nativeReviewKey, open } : current,
            )
          }
          accountLabel={selectedProviderStatus?.displayName ?? "this Codex account"}
          runtimeMode={activeThread.runtimeMode}
          disabled={nativeReviewDisabled}
          onStart={onStartCodeReview}
        />
      ) : null}
      {concurrencyKey ? (
        <SubagentConcurrencyControl
          key={concurrencyEditorKey}
          open={concurrencyEditorOpen}
          onOpenChange={setConcurrencyEditorOpen}
          provider={selectedProvider}
          supported={concurrencySupported}
          override={desiredSubagentLimits?.[concurrencyKey]}
          presentation={concurrencyPresentation}
          isRunning={phase === "running"}
          onChange={saveSubagentLimit}
        />
      ) : null}
    </form>
  );
});
