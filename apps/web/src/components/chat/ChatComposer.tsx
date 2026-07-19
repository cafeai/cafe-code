import type {
  ApprovalRequestId,
  EnvironmentId,
  ModelSelection,
  ProjectEntry,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ResolvedKeybindingsConfig,
  RuntimeMode,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
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
} from "react";
import { flushSync } from "react-dom";
import { useQuery } from "@tanstack/react-query";
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
import { ComposerAttachImageButton } from "./ComposerAttachImageButton";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import {
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { basenameOfPath } from "../../vscode-icons";
import { cn, randomUUID } from "~/lib/utils";
import { resolveShortcutCommand } from "../../keybindings";
import { Separator } from "../ui/separator";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ImageIcon,
  LoaderCircleIcon,
  ListTodoIcon,
  type LucideIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
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
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";
import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useHasOnScreenKeyboard } from "../../hooks/useMediaQuery";
import { domSnapshot, mobileDebugLog } from "../../lib/mobileDebugLog";

const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;

const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
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

const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showPlanToggle: boolean;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onTogglePlanSidebar: () => void;
}) {
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

      {props.showInteractionModeToggle ? (
        <>
          <Button
            variant="ghost"
            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
            size="sm"
            type="button"
            onClick={props.onToggleInteractionMode}
            title={
              props.interactionMode === "plan"
                ? "Plan mode — click to return to normal build mode"
                : "Default mode — click to enter plan mode"
            }
          >
            <BotIcon />
            <span className="sr-only sm:not-sr-only">
              {props.interactionMode === "plan" ? "Plan" : "Build"}
            </span>
          </Button>

          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
        </>
      ) : null}

      <Select
        value={props.runtimeMode}
        onValueChange={(value) => props.onRuntimeModeChange(value!)}
      >
        <SelectTrigger
          variant="ghost"
          size="sm"
          className="font-medium"
          aria-label="Runtime mode"
          title={runtimeModeOption.description}
        >
          <RuntimeModeIcon className="size-4" />
          <SelectValue>{runtimeModeOption.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {runtimeModeOptions.map((mode) => {
            const option = runtimeModeConfig[mode];
            const OptionIcon = option.icon;
            return (
              <SelectItem key={mode} value={mode} className="min-w-64 py-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    {option.label}
                  </span>
                  <span className="text-muted-foreground text-xs leading-4">
                    {option.description}
                  </span>
                </div>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>

      {props.showPlanToggle ? (
        <>
          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
          <Button
            variant="ghost"
            className={cn(
              "shrink-0 whitespace-nowrap px-2 sm:px-3",
              props.planSidebarOpen
                ? "text-blue-400 hover:text-blue-300"
                : "text-muted-foreground/70 hover:text-foreground/80",
            )}
            size="sm"
            type="button"
            onClick={props.onTogglePlanSidebar}
            title={
              props.planSidebarOpen
                ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`
            }
          >
            <ListTodoIcon />
            <span className="sr-only sm:not-sr-only">{props.planSidebarLabel}</span>
          </Button>
        </>
      ) : null}
    </>
  );
});

const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  activeContextWindow: ReturnType<typeof deriveLatestContextWindowSnapshot>;
  codexRateLimits: ServerProvider["accountRateLimits"] | null;
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
  pendingStatusLabel: string | null;
  preserveComposerFocusOnPointerDown?: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}) {
  return (
    <>
      {props.activeContextWindow ? (
        <ContextWindowMeter
          usage={props.activeContextWindow}
          codexRateLimits={props.codexRateLimits}
        />
      ) : null}
      {props.pendingStatusLabel ? (
        <span className="text-muted-foreground/70 text-xs">{props.pendingStatusLabel}</span>
      ) : null}
      <ComposerPrimaryActions
        compact={props.compact}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        isSendBusy={props.isSendBusy}
        isConnecting={props.isConnecting}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
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
    selectedPromptEffort: string | null;
    selectedModelOptionsForDispatch: unknown;
    selectedModelSelection: ModelSelection;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  };
}

export interface FollowUpQueueViewItem {
  id: string;
  preview: string;
  promptText: string;
  images: readonly ComposerImageAttachment[];
  queuedAt: string;
  expanded: boolean;
  canExpand: boolean;
  blockedReason: string | null;
  automaticSteerRetry?: {
    readonly nonSteerableTurnKind: "review" | "compact";
  } | null;
}

export interface SteeringFollowUpViewItem {
  id: string;
  preview: string;
  promptText: string;
  dispatchedAt: string;
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
    const kind = automaticSteerItems[0]?.automaticSteerRetry?.nonSteerableTurnKind;
    return kind === "compact" ? "1 steer waiting for compact" : "1 steer waiting for review";
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
  const kind = item.automaticSteerRetry?.nonSteerableTurnKind ?? null;
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
  items: readonly FollowUpQueueViewItem[];
  steeringItems?: readonly SteeringFollowUpViewItem[];
  actionLabel: string;
  actionTitle: string;
  onToggleExpanded: (itemId: string) => void;
  onAction: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  onClear: () => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
}) {
  const steeringItems = props.steeringItems ?? [];
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
      className="cafe-followup-queue relative mb-2 overflow-hidden rounded-2xl border border-border/70 bg-card/80 px-3 py-2 text-sm shadow-lg/5 backdrop-blur-sm"
      data-cafe-followup-queue="true"
    >
      <div className="relative z-10 flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0 text-muted-foreground text-xs font-medium">{shelfLabel}</div>
        {props.items.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-muted-foreground/80 hover:text-foreground"
            onClick={props.onClear}
          >
            Clear
          </Button>
        ) : null}
      </div>
      <div className="relative z-10 mt-1.5 grid gap-1">
        {steeringItems.map((item) => (
          <div
            key={item.id}
            className="rounded-xl border border-border/50 bg-muted/20 p-2"
            data-cafe-followup-steering="true"
          >
            <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
              <span
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/75"
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
                className="h-7 shrink-0 rounded-md border border-border/60 px-2 py-1 text-muted-foreground/85 text-xs"
                aria-label="Follow-up steering into active turn"
                title="Follow-up accepted for the active turn; waiting for the provider to act on it."
              >
                Steering
              </span>
            </div>
          </div>
        ))}
        {props.items.map((item) => {
          const retryStatus = automaticSteerRetryStatus(item);
          return (
            <div key={item.id} className="rounded-xl border border-border/45 bg-background/42 p-2">
              <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2">
                {item.canExpand ? (
                  <button
                    type="button"
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
                    aria-label={item.expanded ? "Collapse queued message" : "Expand queued message"}
                    onClick={() => props.onToggleExpanded(item.id)}
                  >
                    {item.expanded ? (
                      <ChevronDownIcon className="size-4" />
                    ) : (
                      <ChevronRightIcon className="size-4" />
                    )}
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
                {retryStatus ? (
                  <span
                    className="h-7 shrink-0 whitespace-nowrap rounded-md border border-border/60 px-2 py-1 text-muted-foreground/85 text-xs"
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
                    onClick={() => props.onAction(item.id)}
                  >
                    {props.actionLabel}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 shrink-0 text-muted-foreground/75 hover:text-destructive"
                  aria-label="Remove queued message"
                  onClick={() => props.onRemove(item.id)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
              {item.canExpand && item.expanded ? (
                <div className="mt-2 grid gap-2 rounded-lg border border-border/35 bg-background/55 p-2">
                  {item.images.length > 0 ? (
                    <div className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3">
                      {item.images.map((image) => (
                        <div
                          key={image.id}
                          className="overflow-hidden rounded-lg border border-border/70 bg-background/70"
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
                            <div className="flex min-h-20 items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
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
                    className="max-h-36 min-h-20 w-full resize-none overflow-y-auto rounded-md border border-border/30 bg-background/40 p-2 text-muted-foreground text-xs leading-5 outline-none [overflow-wrap:anywhere]"
                    onChange={() => undefined}
                  />
                </div>
              ) : null}
              {item.blockedReason ? (
                <div className="mt-2 text-[11px] text-destructive/85">{item.blockedReason}</div>
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

export interface ChatComposerProps {
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
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  respondingRequestIds: ApprovalRequestId[];

  // Plan
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: Thread["proposedPlans"][number] | null;
  activePlan: { turnId?: TurnId } | null;
  sidebarProposedPlan: { turnId?: TurnId } | null;
  planSidebarLabel: string;
  planSidebarOpen: boolean;

  // Mode
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;

  // Provider / model
  lockedProvider: ProviderDriverKind | null;
  providerStatuses: ServerProvider[];
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
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

  onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;
  toggleInteractionMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  togglePlanSidebar: () => void;

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
    composerDraftTarget,
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    activeThreadId,
    activeThreadEnvironmentId: _activeThreadEnvironmentId,
    activeThread,
    isServerThread: _isServerThread,
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
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    respondingRequestIds,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    activePlan,
    sidebarProposedPlan,
    planSidebarLabel,
    planSidebarOpen,
    runtimeMode,
    interactionMode,
    lockedProvider,
    providerStatuses,
    activeProjectDefaultModelSelection,
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
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect,
    toggleInteractionMode,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    togglePlanSidebar,
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
  const selectedCodexRateLimits =
    (selectedProviderStatus?.driver === "codex" ||
      selectedProviderStatus?.driver === "claudeAgent") &&
    selectedProviderStatus.auth.status === "authenticated"
      ? (selectedProviderStatus.accountRateLimits ?? null)
      : null;
  const selectedProviderModels = useMemo<ReadonlyArray<ServerProvider["models"][number]>>(
    () => selectedProviderEntry?.models ?? [],
    [selectedProviderEntry],
  );

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
  const composerProviderControls = useMemo(
    () => ({
      showInteractionModeToggle: getProviderInteractionModeToggle(
        providerStatuses,
        selectedProvider,
      ),
    }),
    [providerStatuses, selectedProvider],
  );
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
  // Touch capability, not viewport width: foldables and tablets can be wider
  // than any phone breakpoint while still typing through an on-screen keyboard.
  const isOnScreenKeyboardDevice = useHasOnScreenKeyboard();
  const isComposerCollapsedMobile = isOnScreenKeyboardDevice && !isComposerFocused;

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

  // ------------------------------------------------------------------
  // Derived: composer send state
  // ------------------------------------------------------------------
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
      }),
    [composerImages.length, prompt],
  );
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
          description: "Switch response model for this thread",
        },
        {
          id: "slash:plan",
          type: "slash-command",
          command: "plan",
          label: "/plan",
          description: "Switch this thread into plan mode",
        },
        {
          id: "slash:default",
          type: "slash-command",
          command: "default",
          label: "/default",
          description: "Switch this thread back to normal build mode",
        },
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const providerSlashCommandItems = (selectedProviderStatus?.slashCommands ?? []).map(
        (command) => ({
          id: `provider-slash-command:${selectedProvider}:${command.name}`,
          type: "provider-slash-command" as const,
          provider: selectedProvider,
          command,
          label: `/${command.name}`,
          description: command.description ?? command.input?.hint ?? "Run provider command",
        }),
      );
      const query = composerTrigger.query.trim().toLowerCase();
      const slashCommandItems = [...builtInSlashCommandItems, ...providerSlashCommandItems];
      if (!query) {
        return slashCommandItems;
      }
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderStatus?.skills ?? [], composerTrigger.query).map(
        (skill) => ({
          id: `skill:${selectedProvider}:${skill.name}`,
          type: "skill" as const,
          provider: selectedProvider,
          skill,
          label: formatProviderSkillDisplayName(skill),
          description:
            skill.shortDescription ??
            skill.description ??
            (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
        }),
      );
    }
    return [];
  }, [composerTrigger, selectedProvider, selectedProviderStatus, workspaceEntries]);

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
  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const showCollapsedMobilePromptRow =
    isComposerCollapsedMobile && !isComposerApprovalState && pendingUserInputs.length === 0;

  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const showPlanSidebarToggle = Boolean(activePlan || sidebarProposedPlan);
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (phase === "running") {
      return "running";
    }
    if (showPlanFollowUpPrompt) {
      return prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
    }
    return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerSendState.hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    phase,
    prompt,
    showPlanFollowUpPrompt,
  ]);

  const isComposerMenuLoading =
    composerTriggerKind === "path" &&
    ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
      workspaceEntriesQuery.isLoading ||
      workspaceEntriesQuery.isFetching);
  const composerMenuEmptyState = useMemo(() => {
    if (composerTriggerKind === "skill") {
      return "No skills found. Try / to browse provider commands.";
    }
    return composerTriggerKind === "path"
      ? "No matching files or folders."
      : "No matching command.";
  }, [composerTriggerKind]);

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
  const providerTraitsPicker = renderProviderTraitsPicker({
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
  const composerEditorDisabled =
    isSendBusy ||
    isConnecting ||
    isComposerApprovalState ||
    (environmentUnavailable !== null && activePendingProgress === null);
  const previousComposerEditorDisabledRef = useRef(composerEditorDisabled);

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
    [applyPromptReplacement, handleInteractionModeChange, resolveActiveComposerTrigger],
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
    setIsComposerFocused(false);
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

  const submitComposer = useCallback(
    (event?: { preventDefault: () => void }) => {
      const keepKeyboardClosed = isOnScreenKeyboardDevice;
      mobileDebugLog("submit-start", { keepKeyboardClosed, ...domSnapshot() });
      void Promise.resolve(onSend(event)).finally(() => {
        mobileDebugLog("submit-settled", { keepKeyboardClosed, ...domSnapshot() });
        if (keepKeyboardClosed) {
          dismissMobileComposerKeyboard();
          return;
        }
        requestComposerEditorFocus();
      });
    },
    [dismissMobileComposerKeyboard, isOnScreenKeyboardDevice, onSend, requestComposerEditorFocus],
  );
  const steerComposer = useCallback(
    (event?: { preventDefault: () => void }) => {
      const keepKeyboardClosed = isOnScreenKeyboardDevice;
      void Promise.resolve(onSteer(event)).finally(() => {
        if (keepKeyboardClosed) {
          dismissMobileComposerKeyboard();
          return;
        }
        requestComposerEditorFocus();
      });
    },
    [dismissMobileComposerKeyboard, isOnScreenKeyboardDevice, onSteer, requestComposerEditorFocus],
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
      toggleInteractionMode();
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
  const addComposerImages = (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;
    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach images after answering plan questions.",
      });
      return;
    }
    const nextImages: ComposerImageAttachment[] = [];
    let nextImageCount = composerImagesRef.current.length;
    let error: string | null = null;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
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
      nextImageCount += 1;
    }
    if (nextImages.length === 1 && nextImages[0]) {
      addComposerImage(nextImages[0]);
    } else if (nextImages.length > 1) {
      addComposerImagesToDraft(nextImages);
    }
    setThreadError(activeThreadId, error);
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  // ------------------------------------------------------------------
  // Callbacks: paste / drag
  // ------------------------------------------------------------------
  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    addComposerImages(imageFiles);
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
        selectedPromptEffort,
        selectedModelOptionsForDispatch,
        selectedModelSelection,
        selectedProvider,
        selectedModel,
        selectedProviderModels,
      }),
    }),
    [
      promptRef,
      composerImagesRef,
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
    ],
  );

  // Render
  // ------------------------------------------------------------------
  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposer}
      className="mx-auto w-full min-w-0 max-w-208"
      data-chat-composer-form="true"
    >
      <FollowUpQueueShelf
        items={followUpQueueItems}
        steeringItems={steeringFollowUpItems}
        actionLabel={followUpQueueActionLabel}
        actionTitle={followUpQueueActionTitle}
        onToggleExpanded={onToggleFollowUpQueueItem}
        onAction={onActivateFollowUpQueueItem}
        onRemove={onRemoveFollowUpQueueItem}
        onClear={onClearFollowUpQueue}
        onExpandImage={onExpandImage}
      />
      <input
        ref={composerFileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onComposerFileInputChange}
      />
      <div
        className={cn(
          "group rounded-[22px] p-px transition-colors duration-200",
          composerProviderState.composerFrameClassName,
        )}
        onDragEnter={onComposerDragEnter}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
      >
        <div
          ref={composerSurfaceRef}
          data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
          data-chat-composer-keyboard-open={
            isOnScreenKeyboardDevice && isComposerFocused ? "true" : "false"
          }
          className={cn(
            "rounded-[20px] border bg-card transition-colors duration-200 has-focus-visible:border-ring/45",
            isDragOverComposer ? "border-primary/70 bg-accent/30" : "border-border",
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
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingApprovalPanel
                  approval={activePendingApproval}
                  pendingCount={pendingApprovals.length}
                />
              </div>
            ) : pendingUserInputs.length > 0 ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
                  respondingRequestIds={respondingRequestIds}
                  answers={activePendingDraftAnswers}
                  questionIndex={activePendingQuestionIndex}
                  onToggleOption={onSelectActivePendingUserInputOption}
                  onAdvance={onAdvanceActivePendingUserInput}
                />
              </div>
            ) : showPlanFollowUpPrompt && activeProposedPlan ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPlanFollowUpBanner
                  key={activeProposedPlan.id}
                  planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                />
              </div>
            ) : null)}

          {isComposerCollapsedMobile && activePendingApproval ? (
            <div
              className="rounded-t-[19px] border-b border-border/65 bg-muted/20"
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingApprovalPanel
                approval={activePendingApproval}
                pendingCount={pendingApprovals.length}
              />
              <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-3 sm:px-4">
                <ComposerPendingApprovalActions
                  requestId={activePendingApproval.requestId}
                  isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                  onRespondToApproval={onRespondToApproval}
                />
              </div>
            </div>
          ) : isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
            <div
              className="rounded-t-[19px] border-b border-border/65 bg-muted/20"
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingUserInputPanel
                pendingUserInputs={pendingUserInputs}
                respondingRequestIds={respondingRequestIds}
                answers={activePendingDraftAnswers}
                questionIndex={activePendingQuestionIndex}
                onToggleOption={onSelectActivePendingUserInputOption}
                onAdvance={onAdvanceActivePendingUserInput}
              />
              <div className="px-3 pb-3 sm:px-4">
                <div
                  data-chat-composer-mobile-pending-compact="true"
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-lg border border-border/55 bg-background/55 p-1.5 pl-3 transition-colors hover:bg-background/80",
                    !activePendingProgress?.activeQuestion?.multiSelect && "p-0",
                  )}
                >
                  <button
                    type="button"
                    className={cn(
                      "min-w-0 flex-1 truncate bg-transparent py-1.5 text-left text-sm",
                      activePendingProgress?.customAnswer
                        ? "text-foreground"
                        : "text-muted-foreground/60",
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
                      isSendBusy={isSendBusy}
                      isConnecting={isConnecting}
                      isEnvironmentUnavailable={environmentUnavailable !== null}
                      isPreparingWorktree={false}
                      hasSendableContent={false}
                      preserveComposerFocusOnPointerDown
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
                    : "text-muted-foreground/35",
                )}
                onPointerDown={(event) => event.preventDefault()}
                onClick={expandMobileComposer}
                aria-label="Expand composer"
              >
                {activePendingProgress
                  ? activePendingProgress.customAnswer ||
                    "Type your own answer, or leave this blank to use the selected option"
                  : prompt.trim() || "Ask anything..."}
              </button>
              {composerImages.length > 0 ? (
                // The image preview strip is hidden while collapsed, so surface
                // a compact count pill to reassure the user their attachments
                // are still there. Tapping it expands the composer to manage them.
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground focus:outline-none"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={expandMobileComposer}
                  aria-label={`${composerImages.length} ${
                    composerImages.length === 1 ? "attachment" : "attachments"
                  } attached — expand composer`}
                >
                  <ImageIcon aria-hidden="true" className="size-3" />
                  {composerImages.length}{" "}
                  {composerImages.length === 1 ? "attachment" : "attachments"}
                </button>
              ) : null}
            </div>
          ) : null}

          <div
            className={cn(
              "relative px-3 pb-2 sm:px-4",
              hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
              isComposerCollapsedMobile && "hidden",
            )}
          >
            {composerMenuOpen && !isComposerApprovalState && (
              <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
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
                  activeItemId={activeComposerMenuItem?.id ?? null}
                  onHighlightedItemChange={onComposerMenuItemHighlighted}
                  onSelect={onSelectComposerItem}
                />
              </div>
            )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerImages.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {composerImages.map((image) => (
                    <div
                      key={image.id}
                      className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
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
                        <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
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
                                className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
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
                skills={selectedProviderStatus?.skills ?? []}
                focusRequestRevision={composerFocusRequestRevision}
                {...(showMobileComposerActionsOverlay ? { className: "max-h-40 pb-11" } : {})}
                onChange={onPromptChange}
                onCommandKeyDown={onComposerCommandKey}
                onPaste={onComposerPaste}
                placeholder={
                  isComposerApprovalState
                    ? (activePendingApproval?.detail ?? "Resolve this approval request to continue")
                    : activePendingProgress
                      ? "Type your own answer, or leave this blank to use the selected option"
                      : showPlanFollowUpPrompt && activeProposedPlan
                        ? "Add feedback to refine the plan, or leave this blank to implement it"
                        : environmentUnavailable
                          ? `${environmentUnavailable.label} is ${
                              environmentUnavailable.connectionState === "connecting"
                                ? "connecting"
                                : "disconnected"
                            }`
                          : phase === "disconnected"
                            ? "Ask for follow-up changes or attach images"
                            : "Ask anything, @tag files/folders, $use skills, or / for commands"
                }
                disabled={composerEditorDisabled}
              />
              {showMobileComposerActionsOverlay ? (
                <div
                  data-chat-composer-mobile-pending-actions="true"
                  className="absolute bottom-0 right-0 flex items-center justify-end gap-1.5"
                >
                  {pendingUserInputs.length === 0 ? (
                    <ComposerAttachImageButton
                      preserveComposerFocusOnPointerDown
                      disabled={activeThreadId === null}
                      className="bg-background/80 hover:bg-background/90"
                      onClick={openComposerImagePicker}
                    />
                  ) : null}
                  <ComposerPrimaryActions
                    compact
                    pendingAction={pendingPrimaryAction}
                    isRunning={phase === "running"}
                    showPlanFollowUpPrompt={
                      pendingUserInputs.length === 0 && showPlanFollowUpPrompt
                    }
                    promptHasText={prompt.trim().length > 0}
                    isSendBusy={isSendBusy}
                    isConnecting={isConnecting}
                    isEnvironmentUnavailable={environmentUnavailable !== null}
                    isPreparingWorktree={isPreparingWorktree}
                    hasSendableContent={composerSendState.hasSendableContent}
                    preserveComposerFocusOnPointerDown
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
          {showMobileComposerActionsOverlay ||
          (isComposerCollapsedMobile &&
            !showCollapsedMobilePromptRow) ? null : activePendingApproval ? (
            <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
              <ComposerPendingApprovalActions
                requestId={activePendingApproval.requestId}
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
                "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2.5 sm:px-3 sm:pb-3",
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
                  onInstanceModelChange={onProviderModelSelect}
                />

                {isComposerFooterCompact ? (
                  <CompactComposerControlsMenu
                    activePlan={showPlanSidebarToggle}
                    interactionMode={interactionMode}
                    planSidebarLabel={planSidebarLabel}
                    planSidebarOpen={planSidebarOpen}
                    runtimeMode={runtimeMode}
                    showInteractionModeToggle={composerProviderControls.showInteractionModeToggle}
                    traitsMenuContent={providerTraitsMenuContent}
                    onToggleInteractionMode={toggleInteractionMode}
                    onTogglePlanSidebar={togglePlanSidebar}
                    onRuntimeModeChange={handleRuntimeModeChange}
                  />
                ) : (
                  <>
                    {providerTraitsPicker ? (
                      <>
                        <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                        {providerTraitsPicker}
                      </>
                    ) : null}
                    <ComposerFooterModeControls
                      showInteractionModeToggle={composerProviderControls.showInteractionModeToggle}
                      interactionMode={interactionMode}
                      runtimeMode={runtimeMode}
                      showPlanToggle={showPlanSidebarToggle}
                      planSidebarLabel={planSidebarLabel}
                      planSidebarOpen={planSidebarOpen}
                      onToggleInteractionMode={toggleInteractionMode}
                      onRuntimeModeChange={handleRuntimeModeChange}
                      onTogglePlanSidebar={togglePlanSidebar}
                    />
                  </>
                )}
              </div>

              {/* Right side: send / stop button */}
              <div
                data-chat-composer-actions="right"
                data-chat-composer-primary-actions-compact={
                  isComposerPrimaryActionsCompact ? "true" : "false"
                }
                className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
              >
                <ComposerFooterPrimaryActions
                  compact={isComposerPrimaryActionsCompact}
                  activeContextWindow={activeContextWindow}
                  codexRateLimits={selectedCodexRateLimits}
                  pendingAction={pendingPrimaryAction}
                  isRunning={phase === "running"}
                  showPlanFollowUpPrompt={pendingUserInputs.length === 0 && showPlanFollowUpPrompt}
                  promptHasText={prompt.trim().length > 0}
                  isSendBusy={isSendBusy}
                  isConnecting={isConnecting}
                  isEnvironmentUnavailable={environmentUnavailable !== null}
                  isPreparingWorktree={isPreparingWorktree}
                  hasSendableContent={composerSendState.hasSendableContent}
                  pendingStatusLabel={composerPendingStatusLabel}
                  preserveComposerFocusOnPointerDown
                  onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                  onInterrupt={handleInterruptPrimaryAction}
                  onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </form>
  );
});
