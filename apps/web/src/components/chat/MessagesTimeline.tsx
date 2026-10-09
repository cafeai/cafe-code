import { FileAttachmentPill } from "./FileAttachmentPill";
import { TurnConfigurationWorkEntry } from "./TurnConfigurationWorkEntry";
import { ClaudeCommandWorkEntry, ClaudeSummaryWorkEntry } from "./ProviderOperationWorkEntry";
import {
  type EnvironmentId,
  type EditorId,
  type MessageId,
  type OrchestrationThreadActivity,
  type ProviderDriverKind,
  type ServerProviderSkill,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  deriveTimelineEntries,
  deriveSubagentWorkEntries,
  deriveWorkLogEntries,
  reconcileSubagentWorkEntryRuntime,
  formatElapsed,
  type WorkLogEntry,
} from "../../session-logic";
import type { SubagentRuntimeContext } from "../../subagent-activity";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  EyeIcon,
  GitForkIcon,
  GlobeIcon,
  HammerIcon,
  ChevronRightIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { MessageCopyButton } from "./MessageCopyButton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import {
  computeStableMessagesTimelineRows,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveHistoricalWorkLogDisplayState,
  deriveMessagesTimelineRows,
  mergeHistoricalSubagentEntries,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  type ChatCopyFormat,
  type DefaultEditorSelection,
  type TimestampFormat,
} from "@cafecode/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";
import { hasOnScreenKeyboard } from "../../hooks/useMediaQuery";
import {
  isWholeMessageSelection,
  prepareChatMessageMarkdownCopyText,
  shouldUseMarkdownSelectionCopy,
} from "../../lib/chatClipboard";

import { SkillInlineText } from "./SkillInlineText";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { readLocalApi } from "../../localApi";
import { getLocalShellCapabilities } from "../../localCapabilities";
import { readEnvironmentApi } from "../../environmentApi";
import { useSettings } from "../../hooks/useSettings";
import { useServerAvailableEditors } from "../../rpc/serverState";
import {
  extractOpenablePathTokens,
  isTimelineScrolledToEnd,
  resolveFileOpenEditor,
  resolveWorkspaceFilePath,
} from "./MessagesTimeline.helpers";
import {
  rememberTimelineView,
  resolveInitialTimelinePosition,
  type TimelineViewPosition,
} from "./timelineViewState";
import {
  summarizeTimelineScrollMetrics,
  type TimelineScrollDebugEventInput,
  type TimelineScrollDebugListState,
} from "./timelineScrollDebug";
import { useHistoricalWorkLogPresence } from "./useHistoricalWorkLogPresence";
import { DesktopObservation } from "../virtualDesktop/DesktopObservation";
import { SubagentRosterRow, type SubagentRosterEntry } from "../subagents/SubagentRosterRow";
import { SubagentDetailView, type SubagentDetailSelection } from "./SubagentDetailView";
import { ScheduledFollowupConversation } from "./ScheduledFollowupConversation";
import type { ScheduledFollowupsContext } from "./ScheduledFollowups";

export {
  extractOpenablePathTokens,
  isTimelineScrolledToEnd,
  resolveFileOpenEditor,
  resolveWorkspaceFilePath,
} from "./MessagesTimeline.helpers";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  subagentRuntimeSession: SubagentRuntimeContext | null;
  timestampFormat: TimestampFormat;
  activeProvider: ProviderDriverKind | null;
  markdownCwd: string | undefined;
  additionalWorkspaceRoots: ReadonlyArray<string>;
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  activeThreadId: ThreadId | null;
  activeThreadEnvironmentId: EnvironmentId;
  onHistoricalWorkLogPresenceResolved: (turnId: TurnId, hasWorkLog: boolean) => void;
  onRevertUserMessage: (messageId: MessageId) => void;
  onForkMessage?: ((messageId: MessageId) => void) | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenSubagentDetail: (workEntry: WorkLogEntry, trigger: HTMLButtonElement) => void;
  /** Stable, mutable tracker of rows appended live after first ready. */
  rowEntrances: TimelineRowEntranceTracker;
}

/**
 * Only rows appended live after the timeline's first ready render get an
 * entrance animation (docs/style-guide.md §8). LegendList keys row content by
 * item id and re-mounts rows as they scroll back into view; those re-mounts,
 * the initial history, bulk hydration and streaming updates never animate.
 */
interface TimelineRowEntranceTracker {
  /** Row ids seen since first ready; null until the timeline is ready. */
  knownIds: Set<string> | null;
  /** Live-appended ids awaiting their first mount, with append time. */
  readonly pendingSince: Map<string, number>;
}

// A live append only animates if its row mounts promptly; one scrolled into
// view much later is just content, not a new message.
const ROW_ENTRANCE_WINDOW_MS = 1_000;
// A single update that introduces more rows than this is a history/backfill
// load, not something the user just watched arrive.
const ROW_ENTRANCE_MAX_BATCH = 4;

function trackTimelineRowEntrances(
  tracker: TimelineRowEntranceTracker,
  rows: ReadonlyArray<MessagesTimelineRow>,
  ready: boolean,
): void {
  if (!ready) {
    // Hydration can deliver history in several commits. Everything present
    // before the conversation is ready is the baseline, never "new".
    tracker.knownIds = null;
    tracker.pendingSince.clear();
    return;
  }
  if (tracker.knownIds === null) {
    tracker.knownIds = new Set(rows.map((row) => row.id));
    return;
  }
  const known = tracker.knownIds;
  const appended = rows.filter((row) => !known.has(row.id));
  if (appended.length === 0) return;
  const now = Date.now();
  for (const row of appended) {
    known.add(row.id);
    if (appended.length <= ROW_ENTRANCE_MAX_BATCH) tracker.pendingSince.set(row.id, now);
  }
  for (const [id, since] of tracker.pendingSince) {
    if (now - since > ROW_ENTRANCE_WINDOW_MS) tracker.pendingSince.delete(id);
  }
  // Rows leave the bounded projection window over multi-hour sessions; keep
  // this set proportional to the current rows rather than all history.
  if (known.size > rows.length * 2 + 256) {
    tracker.knownIds = new Set(rows.map((row) => row.id));
  }
}

/** Decided once per row mount, then consumed so a later re-mount stays still. */
function useTimelineRowEntrance(rowId: string): boolean {
  const { rowEntrances } = use(TimelineRowCtx);
  const [animate] = useState(() => {
    const since = rowEntrances.pendingSince.get(rowId);
    return since !== undefined && Date.now() - since <= ROW_ENTRANCE_WINDOW_MS;
  });
  useEffect(() => {
    rowEntrances.pendingSince.delete(rowId);
  }, [rowEntrances, rowId]);
  return animate;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  messageForkDisabled: boolean;
  isRevertingCheckpoint: boolean;
  subagentDetailOpen: boolean;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);
const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FOOTER = <div className="h-3 sm:h-4" />;
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
// LegendList expresses this as a fraction of the viewport height. A value near
// one treats almost a full screen of review scrolling as still being at the
// tail, so the next streaming layout update can pull the user back down. Keep
// only a small sub-line allowance for measurement jitter.
const TIMELINE_MAINTAIN_SCROLL_AT_END_THRESHOLD = 0.01;
const TIMELINE_SUBMIT_STICK_TO_END_WINDOW_MS = 1_500;
const TIMELINE_SUBMIT_STICK_TO_END_FRAME_ATTEMPTS = 8;
const TIMELINE_SUBMIT_STICK_TO_END_SETTLE_TIMEOUTS_MS = [80, 180, 360, 720] as const;
const HISTORICAL_WORK_LOG_PREVIEW_LIMIT = 6;
const HISTORICAL_WORK_LOG_PAGE_SIZE = 24;
const HISTORICAL_WORK_LOG_SHOW_ALL_LIMIT = 1_000;
// Data-change anchoring can fight explicit tail following because a submitted
// message and its working row are data changes. Enable it only after the user
// has detached from the tail. Size anchoring remains active in both modes so
// rows above the viewport can settle without moving the visible conversation.
const TIMELINE_FOLLOW_VISIBLE_CONTENT_POSITION = {
  data: false,
  size: true,
} as const;
const TIMELINE_REVIEW_VISIBLE_CONTENT_POSITION = {
  data: true,
  size: true,
} as const;

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  /** Explicit selected-message native fork. Omitted for unsupported providers. */
  onForkMessage?: ((messageId: MessageId) => void) | undefined;
  messageForkDisabled?: boolean;
  /** Live saved follow-ups are visible without opening the separate Tasks rail. */
  scheduledFollowups?: ScheduledFollowupsContext;
  /** Missing session evidence is explicitly unknown, never implicitly live. */
  subagentRuntimeSession?: SubagentRuntimeContext | null;
  /** True until the detail stream has delivered its first complete snapshot. */
  isThreadHistoryHydrating?: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  historicalWorkLogSummariesByTurnId?: Parameters<
    typeof deriveMessagesTimelineRows
  >[0]["historicalWorkLogSummariesByTurnId"];
  completionDividerAfterEntryId: string | null;
  completionSummary: string | null;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  activeProvider: ProviderDriverKind | null;
  markdownCwd: string | undefined;
  additionalWorkspaceRoots?: ReadonlyArray<string>;
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  activeThreadId?: ThreadId;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  stickToEndRevision: number;
  autoFollowTail: boolean;
  initialViewPosition?: TimelineViewPosition | null;
  viewPositionCache?: Map<string, TimelineViewPosition>;
  viewPositionKey?: string;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onUserScrollIntent: () => void;
  onDebugScrollEvent?: (event: TimelineScrollDebugEventInput) => void;
  selectedSubagent?: SubagentDetailSelection | null;
  onOpenSubagentDetail?: (workEntry: WorkLogEntry, trigger: HTMLButtonElement) => void;
  onCloseSubagentDetail?: () => void;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  onForkMessage,
  messageForkDisabled = false,
  scheduledFollowups,
  isThreadHistoryHydrating = false,
  isWorking,
  activeTurnInProgress,
  activeTurnId,
  activeTurnStartedAt,
  listRef,
  timelineEntries,
  historicalWorkLogSummariesByTurnId,
  completionDividerAfterEntryId,
  completionSummary,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  activeProvider,
  subagentRuntimeSession = null,
  markdownCwd,
  additionalWorkspaceRoots = [],
  timestampFormat,
  workspaceRoot,
  activeThreadId: activeThreadIdProp,
  skills = EMPTY_TIMELINE_SKILLS,
  stickToEndRevision,
  autoFollowTail,
  initialViewPosition = null,
  viewPositionCache,
  viewPositionKey,
  onIsAtEndChange,
  onUserScrollIntent,
  onDebugScrollEvent,
  selectedSubagent: controlledSelectedSubagent,
  onOpenSubagentDetail: controlledOpenSubagentDetail,
  onCloseSubagentDetail: controlledCloseSubagentDetail,
}: MessagesTimelineProps) {
  const timelineElementRef = useRef<HTMLDivElement | null>(null);
  const activeThreadId = activeThreadIdProp ?? null;
  const chatCopyFormat = useSettings((settings) => settings.chatCopyFormat);
  const {
    summaries: visibleHistoricalWorkLogSummariesByTurnId,
    recordPresence: recordHistoricalWorkLogPresence,
  } = useHistoricalWorkLogPresence({
    environmentId: activeThreadEnvironmentId,
    threadId: activeThreadId,
    summaries: historicalWorkLogSummariesByTurnId,
  });
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerAfterEntryId,
        completionSummary,
        isWorking,
        activeTurnInProgress,
        activeTurnId: activeTurnId ?? null,
        activeTurnStartedAt,
        revertTurnCountByUserMessageId,
        ...(visibleHistoricalWorkLogSummariesByTurnId !== undefined
          ? { historicalWorkLogSummariesByTurnId: visibleHistoricalWorkLogSummariesByTurnId }
          : {}),
      }),
    [
      timelineEntries,
      completionDividerAfterEntryId,
      completionSummary,
      isWorking,
      activeTurnInProgress,
      activeTurnId,
      activeTurnStartedAt,
      revertTurnCountByUserMessageId,
      visibleHistoricalWorkLogSummariesByTurnId,
    ],
  );
  const rows = useStableRows(rawRows);
  // One stable, deliberately mutable tracker per mounted timeline (the
  // timeline remounts per chat). Tracking runs during render so a
  // live-appended row knows it is new on its first mount; it is idempotent for
  // the same rows, so repeated or concurrent renders agree.
  const [rowEntranceTracker] = useState<TimelineRowEntranceTracker>(() => ({
    knownIds: null,
    pendingSince: new Map(),
  }));
  const rowEntrances = useMemo(() => {
    trackTimelineRowEntrances(rowEntranceTracker, rows, !isThreadHistoryHydrating);
    return rowEntranceTracker;
  }, [isThreadHistoryHydrating, rowEntranceTracker, rows]);
  const [internalSelectedSubagent, setInternalSelectedSubagent] =
    useState<SubagentDetailSelection | null>(null);
  const selectedSubagent =
    controlledSelectedSubagent === undefined
      ? internalSelectedSubagent
      : controlledSelectedSubagent;
  const selectedSubagentTriggerRef = useRef<HTMLButtonElement | null>(null);
  const subagentDetailBackButtonRef = useRef<HTMLButtonElement | null>(null);
  const openSubagentDetail = useCallback(
    (workEntry: WorkLogEntry, trigger: HTMLButtonElement) => {
      if (!workEntry.subagent) return;
      if (controlledOpenSubagentDetail) {
        controlledOpenSubagentDetail(workEntry, trigger);
        return;
      }
      selectedSubagentTriggerRef.current = trigger;
      setInternalSelectedSubagent({
        environmentId: activeThreadEnvironmentId,
        threadId: activeThreadId,
        rowId: workEntry.id,
        turnId: workEntry.turnId ?? null,
        workEntry: { ...workEntry, subagent: workEntry.subagent },
      });
    },
    [activeThreadEnvironmentId, activeThreadId, controlledOpenSubagentDetail],
  );
  const closeSubagentDetail = useCallback(() => {
    if (controlledCloseSubagentDetail) {
      controlledCloseSubagentDetail();
      return;
    }
    const trigger = selectedSubagentTriggerRef.current;
    setInternalSelectedSubagent(null);
    selectedSubagentTriggerRef.current = null;
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }, [controlledCloseSubagentDetail]);
  useEffect(() => {
    // A timeline instance can survive navigation while its thread/environment
    // props change. Never carry a child selection into a different Cafe scope:
    // besides showing stale detail, that would issue a guaranteed-denied RPC
    // using the new thread id and the prior turn/child identity.
    setInternalSelectedSubagent(null);
    selectedSubagentTriggerRef.current = null;
  }, [activeThreadEnvironmentId, activeThreadId]);
  const resolvedSelectedSubagent = useMemo(() => {
    if (!selectedSubagent) return null;
    if (
      selectedSubagent.environmentId !== activeThreadEnvironmentId ||
      selectedSubagent.threadId !== activeThreadId
    ) {
      return null;
    }
    // Live child progress continues to update the selected screen. Historical
    // rows own their paged activity locally, so their immutable terminal
    // snapshot remains the fallback when it is not present in the root rows.
    for (const row of rows) {
      const candidates =
        row.kind === "work"
          ? row.groupedEntries
          : row.kind === "historical-work"
            ? (row.summary.subagentEntries ?? [])
            : [];
      const current = candidates.find(
        (entry) =>
          entry.subagent?.id === selectedSubagent.workEntry.subagent.id &&
          (entry.turnId ?? null) === selectedSubagent.turnId,
      );
      if (current?.subagent) {
        const [reconciled] = mergeHistoricalSubagentEntries(
          [selectedSubagent.workEntry],
          [current],
          subagentRuntimeSession,
        );
        return {
          ...selectedSubagent,
          rowId: reconciled?.id ?? current.id,
          workEntry: reconcileSubagentWorkEntryRuntime(
            reconciled ?? { ...current, subagent: current.subagent },
            subagentRuntimeSession,
          ),
        };
      }
    }
    return {
      ...selectedSubagent,
      workEntry: reconcileSubagentWorkEntryRuntime(
        selectedSubagent.workEntry,
        subagentRuntimeSession,
      ),
    };
  }, [activeThreadEnvironmentId, activeThreadId, rows, selectedSubagent, subagentRuntimeSession]);
  const isSubagentDetailOpen = resolvedSelectedSubagent !== null;
  // Returning from a subagent detail slides the (still mounted) timeline back
  // in from the start edge. Adjusting state during render restarts the CSS
  // animation exactly once per open→closed transition.
  const [subagentDetailWasOpen, setSubagentDetailWasOpen] = useState(isSubagentDetailOpen);
  const [returnedFromSubagentDetail, setReturnedFromSubagentDetail] = useState(false);
  if (subagentDetailWasOpen !== isSubagentDetailOpen) {
    setSubagentDetailWasOpen(isSubagentDetailOpen);
    setReturnedFromSubagentDetail(!isSubagentDetailOpen);
  }
  const stickToEndDeadlineMsRef = useRef(0);
  const submitStickScrollEventRepinFrameRef = useRef<number | null>(null);
  const tailFollowItemLayoutRepinFrameRef = useRef<number | null>(null);
  const autoFollowTailRef = useRef(autoFollowTail);
  autoFollowTailRef.current = autoFollowTail;
  const forcedScrollGenerationRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  const touchReviewIntentReportedRef = useRef(false);
  const scrollbarPointerActiveRef = useRef(false);
  const scrollbarReviewIntentReportedRef = useRef(false);
  const scrollbarPointerReleaseFrameRef = useRef<number | null>(null);
  const assistantMarkdownCopyTextByMessageId = useMemo(() => {
    const values = new Map<string, string>();
    for (const row of rows) {
      if (row.kind !== "message" || row.message.role !== "assistant") {
        continue;
      }
      values.set(
        row.message.id,
        prepareChatMessageMarkdownCopyText(row.message.text ?? "", {
          provider: activeProvider,
        }),
      );
    }
    return values;
  }, [activeProvider, rows]);
  const markdownSelectionCopyStateRef = useRef<{
    format: ChatCopyFormat;
    assistantMarkdownCopyTextByMessageId: Map<string, string>;
  }>({
    format: chatCopyFormat,
    assistantMarkdownCopyTextByMessageId,
  });
  useEffect(() => {
    markdownSelectionCopyStateRef.current = {
      format: chatCopyFormat,
      assistantMarkdownCopyTextByMessageId,
    };
  }, [assistantMarkdownCopyTextByMessageId, chatCopyFormat]);
  const emitScrollDebugEvent = useCallback(
    (
      reason: string,
      input: {
        readonly state?: TimelineScrollDebugListState | null;
        readonly details?: Record<string, unknown>;
      } = {},
    ) => {
      if (!onDebugScrollEvent) {
        return;
      }
      const nowMs = Date.now();
      onDebugScrollEvent({
        source: "MessagesTimeline",
        reason,
        activeThreadId,
        activeTurnId: activeTurnId ?? null,
        metrics: summarizeTimelineScrollMetrics({
          state: input.state ?? null,
          rowCount: rows.length,
          autoFollowTail,
          stickToEndRevision,
          submitStickDeadlineMs: stickToEndDeadlineMsRef.current,
          nowMs,
        }),
        ...(input.details ? { details: input.details } : {}),
      });
    },
    [
      activeThreadId,
      activeTurnId,
      autoFollowTail,
      onDebugScrollEvent,
      rows.length,
      stickToEndRevision,
    ],
  );
  useEffect(() => {
    const handleDocumentCopy = (event: ClipboardEvent) => {
      const { format, assistantMarkdownCopyTextByMessageId: copyTextByMessageId } =
        markdownSelectionCopyStateRef.current;
      if (!shouldUseMarkdownSelectionCopy(format) || event.defaultPrevented) {
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        return;
      }

      const range = selection.getRangeAt(0);
      const copyRegion = findAssistantMarkdownCopyRegion(range);
      if (!copyRegion || !timelineElementRef.current?.contains(copyRegion)) {
        return;
      }

      const visibleText = copyRegion.innerText || copyRegion.textContent || "";
      if (!isWholeMessageSelection({ selectedText: selection.toString(), visibleText })) {
        return;
      }

      const messageId = copyRegion.dataset.chatCopyMessageId;
      const markdownText = messageId ? copyTextByMessageId.get(messageId) : null;
      if (!markdownText) {
        return;
      }

      event.preventDefault();
      event.clipboardData?.setData("text/plain", markdownText);
      event.clipboardData?.setData("text/markdown", markdownText);
    };

    document.addEventListener("copy", handleDocumentCopy);
    return () => {
      document.removeEventListener("copy", handleDocumentCopy);
    };
  }, []);
  const forceScrollToEnd = useCallback(
    (rowCount = rows.length, reason = "force-scroll-to-end") => {
      if (rowCount <= 0) {
        emitScrollDebugEvent(reason, {
          details: {
            result: "skipped-empty-rows",
            requestedRowCount: rowCount,
          },
        });
        return;
      }
      const list = listRef.current;
      if (!list) {
        emitScrollDebugEvent(reason, {
          details: {
            result: "skipped-missing-list",
            requestedRowCount: rowCount,
          },
        });
        return;
      }
      const state = onDebugScrollEvent ? list.getState?.() : null;
      void list.scrollToEnd?.({ animated: false });
      // The last-row fallback predates the live follow-up footer. Aligning the
      // last message after scrollToEnd would hide that entire footer below the
      // viewport. Only the footer-aware end position is valid for these views.
      if (!scheduledFollowups) {
        void list.scrollToIndex?.({
          index: rowCount - 1,
          animated: false,
          viewPosition: 1,
        });
      }
      emitScrollDebugEvent(reason, {
        state: state ?? null,
        details: {
          result: "requested",
          requestedRowCount: rowCount,
          targetIndex: rowCount - 1,
        },
      });
    },
    [emitScrollDebugEvent, listRef, onDebugScrollEvent, rows.length, scheduledFollowups],
  );
  const cancelTailFollowItemLayoutRepin = useCallback(() => {
    if (tailFollowItemLayoutRepinFrameRef.current === null) {
      return;
    }
    window.cancelAnimationFrame(tailFollowItemLayoutRepinFrameRef.current);
    tailFollowItemLayoutRepinFrameRef.current = null;
  }, []);
  const scheduleTailFollowItemLayoutRepin = useCallback(() => {
    if (!autoFollowTailRef.current || rows.length === 0) {
      return;
    }
    if (tailFollowItemLayoutRepinFrameRef.current !== null) {
      return;
    }

    // LegendList checks its internal `isAtEnd` after recalculating item
    // positions. A live tool/work-log row can grow enough during that same
    // measurement to flip the flag before LegendList's own item-layout follow
    // step runs. Reassert Cafe's explicit follow-mode decision after the
    // measurement frame. Coalescing keeps this O(1) per paint even when many
    // rows settle together after a large provider update.
    tailFollowItemLayoutRepinFrameRef.current = window.requestAnimationFrame(() => {
      tailFollowItemLayoutRepinFrameRef.current = null;
      if (!autoFollowTailRef.current) {
        return;
      }
      forceScrollToEnd(rows.length, "tail-follow-item-layout-repin");
    });
  }, [forceScrollToEnd, rows.length]);
  const handleItemSizeChanged = useCallback(() => {
    // Footer metrics use this same follow-only path: delayed proposals can
    // grow after the initial scroll settles, but must never move a reader who
    // deliberately scrolled away. Coalescing covers item and footer changes.
    scheduleTailFollowItemLayoutRepin();
  }, [scheduleTailFollowItemLayoutRepin]);
  const cancelSubmitStickToEnd = useCallback(() => {
    // Invalidate every already-scheduled initial/submit hard-scroll callback.
    // Clearing only the deadline is insufficient because the animation-frame
    // loop historically did not consult it before issuing scrollToEnd.
    autoFollowTailRef.current = false;
    cancelTailFollowItemLayoutRepin();
    forcedScrollGenerationRef.current += 1;
    stickToEndDeadlineMsRef.current = 0;
    if (submitStickScrollEventRepinFrameRef.current !== null) {
      window.cancelAnimationFrame(submitStickScrollEventRepinFrameRef.current);
      submitStickScrollEventRepinFrameRef.current = null;
    }
  }, [cancelTailFollowItemLayoutRepin]);
  const scheduleSubmitStickScrollEventRepin = useCallback(() => {
    if (submitStickScrollEventRepinFrameRef.current !== null) {
      return;
    }
    submitStickScrollEventRepinFrameRef.current = window.requestAnimationFrame(() => {
      submitStickScrollEventRepinFrameRef.current = null;
      if (Date.now() <= stickToEndDeadlineMsRef.current) {
        forceScrollToEnd(rows.length, "submit-stick-scroll-event-repin");
      }
    });
  }, [forceScrollToEnd, rows.length]);
  useEffect(
    () => () => {
      if (submitStickScrollEventRepinFrameRef.current !== null) {
        window.cancelAnimationFrame(submitStickScrollEventRepinFrameRef.current);
        submitStickScrollEventRepinFrameRef.current = null;
      }
      if (scrollbarPointerReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollbarPointerReleaseFrameRef.current);
        scrollbarPointerReleaseFrameRef.current = null;
      }
      if (tailFollowItemLayoutRepinFrameRef.current !== null) {
        window.cancelAnimationFrame(tailFollowItemLayoutRepinFrameRef.current);
        tailFollowItemLayoutRepinFrameRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    autoFollowTailRef.current = autoFollowTail;
    // A user gesture changes follow mode after its scroll callback. Update the
    // cached flag as well, otherwise a single scroll-away could be remembered
    // as tail-following and jump to the bottom when the tab is reopened.
    if (viewPositionCache && viewPositionKey) {
      const previous = viewPositionCache.get(viewPositionKey);
      if (previous && previous.following !== autoFollowTail) {
        viewPositionCache.set(viewPositionKey, { ...previous, following: autoFollowTail });
      }
    }
    if (!autoFollowTail) {
      cancelTailFollowItemLayoutRepin();
    }
  }, [autoFollowTail, cancelTailFollowItemLayoutRepin, viewPositionCache, viewPositionKey]);

  const handleUserScrollIntent = useCallback(
    (event?: { readonly type?: string }) => {
      emitScrollDebugEvent("user-scroll-intent", {
        state: onDebugScrollEvent ? (listRef.current?.getState?.() ?? null) : null,
        details: {
          eventType: event?.type ?? "unknown",
        },
      });
      cancelSubmitStickToEnd();
      onUserScrollIntent();
    },
    [cancelSubmitStickToEnd, emitScrollDebugEvent, listRef, onDebugScrollEvent, onUserScrollIntent],
  );

  const handleScroll = useCallback(() => {
    if (Date.now() <= stickToEndDeadlineMsRef.current) {
      const state = listRef.current?.getState?.() ?? null;
      const shouldRepin = state === null || !isTimelineScrolledToEnd(state);
      emitScrollDebugEvent("scroll-event-ignored-during-submit-stick", {
        state: state ?? null,
        details: {
          resolvedIsAtEnd: true,
          repinScheduled: shouldRepin,
        },
      });
      if (shouldRepin) {
        scheduleSubmitStickScrollEventRepin();
      }
      onIsAtEndChange(true);
      return;
    }

    const state = listRef.current?.getState?.();
    if (state) {
      if (viewPositionCache && viewPositionKey) {
        rememberTimelineView(viewPositionCache, viewPositionKey, state, autoFollowTailRef.current);
      }
      const resolvedIsAtEnd = isTimelineScrolledToEnd(state);
      if (
        !resolvedIsAtEnd &&
        scrollbarPointerActiveRef.current &&
        !scrollbarReviewIntentReportedRef.current
      ) {
        scrollbarReviewIntentReportedRef.current = true;
        handleUserScrollIntent({ type: "scrollbar" });
      }
      emitScrollDebugEvent("scroll-event", {
        state,
        details: {
          resolvedIsAtEnd,
        },
      });
      onIsAtEndChange(resolvedIsAtEnd);
    } else {
      emitScrollDebugEvent("scroll-event", {
        details: {
          result: "missing-list-state",
        },
      });
    }
  }, [
    emitScrollDebugEvent,
    handleUserScrollIntent,
    listRef,
    onIsAtEndChange,
    scheduleSubmitStickScrollEventRepin,
    viewPositionCache,
    viewPositionKey,
  ]);
  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLElement>) => {
      if (event.deltaY < 0) {
        handleUserScrollIntent(event);
      }
    },
    [handleUserScrollIntent],
  );
  const handleTouchStart = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    touchStartYRef.current = event.touches.item(0)?.clientY ?? null;
    touchReviewIntentReportedRef.current = false;
  }, []);
  const handleTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLElement>) => {
      const startY = touchStartYRef.current;
      const currentY = event.touches.item(0)?.clientY;
      if (
        startY !== null &&
        currentY !== undefined &&
        currentY - startY > 4 &&
        !touchReviewIntentReportedRef.current
      ) {
        touchReviewIntentReportedRef.current = true;
        handleUserScrollIntent(event);
      }
    },
    [handleUserScrollIntent],
  );
  const handleTouchEnd = useCallback(() => {
    touchStartYRef.current = null;
    touchReviewIntentReportedRef.current = false;
  }, []);
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const scrollbarIntentPx = 24;
      if (scrollbarPointerReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollbarPointerReleaseFrameRef.current);
        scrollbarPointerReleaseFrameRef.current = null;
      }
      const scrollbarPointerActive = event.clientX >= bounds.right - scrollbarIntentPx;
      scrollbarPointerActiveRef.current = scrollbarPointerActive;
      scrollbarReviewIntentReportedRef.current = scrollbarPointerActive;
      if (scrollbarPointerActive) {
        handleUserScrollIntent({ type: "scrollbar-pointerdown" });
      }
    },
    [handleUserScrollIntent],
  );
  const handlePointerEnd = useCallback(() => {
    if (scrollbarPointerReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollbarPointerReleaseFrameRef.current);
    }
    // Native scrollbar track clicks can dispatch their scroll event after the
    // pointer event. Keep the attribution alive for one frame, then clear it.
    scrollbarPointerReleaseFrameRef.current = window.requestAnimationFrame(() => {
      scrollbarPointerReleaseFrameRef.current = null;
      scrollbarPointerActiveRef.current = false;
      scrollbarReviewIntentReportedRef.current = false;
    });
  }, []);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        (event.key === " " && event.shiftKey)
      ) {
        emitScrollDebugEvent("user-scroll-intent", {
          state: onDebugScrollEvent ? (listRef.current?.getState?.() ?? null) : null,
          details: {
            eventType: "keydown",
            key: event.key,
          },
        });
        cancelSubmitStickToEnd();
        onUserScrollIntent();
      }
    },
    [cancelSubmitStickToEnd, emitScrollDebugEvent, listRef, onDebugScrollEvent, onUserScrollIntent],
  );

  const previousRowCountRef = useRef(0);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;

    if (previousRowCount > 0 || rows.length === 0 || initialViewPosition?.following === false) {
      return;
    }

    onIsAtEndChange(true);
    let cancelled = false;
    let attempts = 0;
    const frameIds: number[] = [];
    const forcedScrollGeneration = forcedScrollGenerationRef.current;
    const scheduleScroll = () => {
      const frameId = window.requestAnimationFrame(() => {
        if (cancelled || forcedScrollGeneration !== forcedScrollGenerationRef.current) return;
        attempts += 1;
        forceScrollToEnd(rows.length, "initial-rows-scroll-to-end");
        if (attempts < 3) {
          scheduleScroll();
        }
      });
      frameIds.push(frameId);
    };
    scheduleScroll();
    return () => {
      cancelled = true;
      for (const frameId of frameIds) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [forceScrollToEnd, onIsAtEndChange, rows.length, initialViewPosition]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const state = listRef.current?.getState?.();
      if (state && isTimelineScrolledToEnd(state)) {
        onIsAtEndChange(true);
      }
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [listRef, onIsAtEndChange, rows]);

  const handledStickToEndRevisionRef = useRef(stickToEndRevision);
  useEffect(() => {
    if (stickToEndRevision === handledStickToEndRevisionRef.current || rows.length === 0) {
      return;
    }

    handledStickToEndRevisionRef.current = stickToEndRevision;
    stickToEndDeadlineMsRef.current = Date.now() + TIMELINE_SUBMIT_STICK_TO_END_WINDOW_MS;
    onIsAtEndChange(true);

    let cancelled = false;
    let attempts = 0;
    const frameIds: number[] = [];
    const timeoutIds: number[] = [];
    const forcedScrollGeneration = forcedScrollGenerationRef.current;
    const scheduleScroll = () => {
      const frameId = window.requestAnimationFrame(() => {
        if (
          cancelled ||
          forcedScrollGeneration !== forcedScrollGenerationRef.current ||
          Date.now() > stickToEndDeadlineMsRef.current
        ) {
          return;
        }
        attempts += 1;
        forceScrollToEnd(rows.length, "submit-stick-animation-frame");
        if (attempts < TIMELINE_SUBMIT_STICK_TO_END_FRAME_ATTEMPTS) {
          scheduleScroll();
        }
      });
      frameIds.push(frameId);
    };
    const scheduleSettleScroll = (delayMs: number) => {
      const timeoutId = window.setTimeout(() => {
        if (cancelled || Date.now() > stickToEndDeadlineMsRef.current) {
          return;
        }
        forceScrollToEnd(rows.length, `submit-stick-settle-timeout-${delayMs}ms`);
      }, delayMs);
      timeoutIds.push(timeoutId);
    };

    // LegendList can briefly preserve the previous visible row while React is
    // committing a locally submitted message and the working indicator. The
    // submit path already decided that the user was at the bottom, so replay
    // that decision after the new rows exist instead of letting the virtualizer
    // settle at the top of the conversation.
    forceScrollToEnd(rows.length, "submit-stick-immediate");
    scheduleScroll();
    for (const delayMs of TIMELINE_SUBMIT_STICK_TO_END_SETTLE_TIMEOUTS_MS) {
      scheduleSettleScroll(delayMs);
    }

    return () => {
      cancelled = true;
      for (const frameId of frameIds) {
        window.cancelAnimationFrame(frameId);
      }
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [forceScrollToEnd, onIsAtEndChange, rows.length, stickToEndRevision]);

  useEffect(() => {
    if (rows.length === 0 || Date.now() > stickToEndDeadlineMsRef.current) {
      return;
    }

    let cancelled = false;
    const frameId = window.requestAnimationFrame(() => {
      if (!cancelled && Date.now() <= stickToEndDeadlineMsRef.current) {
        forceScrollToEnd(rows.length, "submit-stick-row-update");
      }
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [forceScrollToEnd, rows, rows.length]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      timestampFormat,
      markdownCwd,
      additionalWorkspaceRoots,
      workspaceRoot,
      skills,
      activeThreadId,
      activeThreadEnvironmentId,
      onHistoricalWorkLogPresenceResolved: recordHistoricalWorkLogPresence,
      activeProvider,
      subagentRuntimeSession,
      onRevertUserMessage,
      onForkMessage,
      onImageExpand,
      onOpenSubagentDetail: openSubagentDetail,
      rowEntrances,
    }),
    [
      timestampFormat,
      markdownCwd,
      additionalWorkspaceRoots,
      workspaceRoot,
      skills,
      activeThreadId,
      activeThreadEnvironmentId,
      recordHistoricalWorkLogPresence,
      activeProvider,
      subagentRuntimeSession,
      onRevertUserMessage,
      onForkMessage,
      onImageExpand,
      openSubagentDetail,
      // Same tracker object on every render; listed for completeness only.
      rowEntrances,
    ],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      messageForkDisabled: messageForkDisabled || activeTurnInProgress,
      isRevertingCheckpoint,
      subagentDetailOpen: isSubagentDetailOpen,
    }),
    [
      activeTurnInProgress,
      isRevertingCheckpoint,
      isSubagentDetailOpen,
      isWorking,
      messageForkDisabled,
    ],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  // Schedule reads are independent of streaming tokens. Keep the footer
  // element stable so a token update does not churn the virtualizer's footer
  // or recreate the shared scheduler subscription. Subagent detail has its own
  // transcript and must not present the parent's schedule as the child's.
  const timelineFooter = useMemo(
    () =>
      scheduledFollowups && !isSubagentDetailOpen ? (
        <div className="mx-auto w-full min-w-0 max-w-3xl" data-timeline-scheduled-followups="true">
          <ScheduledFollowupConversation context={scheduledFollowups} />
          {TIMELINE_LIST_FOOTER}
        </div>
      ) : (
        TIMELINE_LIST_FOOTER
      ),
    [isSubagentDetailOpen, scheduledFollowups],
  );

  if (
    rows.length === 0 &&
    !isWorking &&
    resolvedSelectedSubagent === null &&
    isThreadHistoryHydrating
  ) {
    return <ThreadHistoryLoadingState />;
  }

  if (rows.length === 0 && !isWorking && resolvedSelectedSubagent === null) {
    return (
      <div className="flex h-full min-w-0 flex-col overflow-y-auto px-3 sm:px-5 animate-enter-fade">
        <div className="flex min-h-40 flex-1 shrink-0 items-center justify-center">
          <p className="text-sm text-subtle-foreground">
            Send a message to start the conversation.
          </p>
        </div>
        {timelineFooter}
      </div>
    );
  }

  return (
    // The timeline remounts per chat (keyed by ChatView), so this fade plays
    // once when a chat's content first becomes ready — never on row updates.
    // Opacity only: it cannot disturb LegendList's measurement or anchoring.
    <div
      ref={timelineElementRef}
      className="relative h-full min-h-0 min-w-0 overflow-hidden animate-enter-fade"
    >
      <TimelineRowCtx value={sharedState}>
        <TimelineRowActivityCtx value={activityState}>
          <div
            className={cn(
              "h-full min-h-0",
              isSubagentDetailOpen && "pointer-events-none invisible",
              !isSubagentDetailOpen && returnedFromSubagentDetail && "animate-enter-from-start",
            )}
            aria-hidden={isSubagentDetailOpen ? true : undefined}
            inert={isSubagentDetailOpen ? true : undefined}
          >
            <LegendList<MessagesTimelineRow>
              ref={listRef}
              data={rows}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              estimatedItemSize={90}
              {...resolveInitialTimelinePosition(initialViewPosition, rows)}
              maintainScrollAtEnd={autoFollowTail}
              maintainScrollAtEndThreshold={TIMELINE_MAINTAIN_SCROLL_AT_END_THRESHOLD}
              maintainVisibleContentPosition={
                autoFollowTail
                  ? TIMELINE_FOLLOW_VISIBLE_CONTENT_POSITION
                  : TIMELINE_REVIEW_VISIBLE_CONTENT_POSITION
              }
              onItemSizeChanged={handleItemSizeChanged}
              {...(scheduledFollowups ? { onMetricsChange: handleItemSizeChanged } : {})}
              onScroll={handleScroll}
              onWheel={handleWheel}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchEnd}
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
              onKeyDown={handleKeyDown}
              className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
              ListHeaderComponent={TIMELINE_LIST_HEADER}
              ListFooterComponent={timelineFooter}
            />
          </div>
        </TimelineRowActivityCtx>
      </TimelineRowCtx>
      {resolvedSelectedSubagent ? (
        <SubagentDetailView
          key={JSON.stringify([
            activeThreadEnvironmentId,
            activeThreadId,
            activeProvider,
            resolvedSelectedSubagent.turnId,
            resolvedSelectedSubagent.workEntry.subagent.id,
            resolvedSelectedSubagent.workEntry.subagent.historyId ?? null,
          ])}
          selection={resolvedSelectedSubagent}
          environmentId={activeThreadEnvironmentId}
          threadId={activeThreadId}
          provider={activeProvider}
          markdownCwd={markdownCwd}
          additionalWorkspaceRoots={additionalWorkspaceRoots}
          skills={skills}
          backButtonRef={subagentDetailBackButtonRef}
          onBack={closeSubagentDetail}
        />
      ) : null}
    </div>
  );
});

/**
 * First-load placeholder for a chat whose history is still arriving. Fast
 * loads show nothing; after ~300ms a bottom-anchored skeleton matching the
 * message layout appears, and a short label only for waits over ~1.5s
 * (docs/style-guide.md §9). The status text is always available to assistive
 * technology.
 */
function ThreadHistoryLoadingState() {
  const showSkeleton = useDelayedFlag(true, { delayMs: 300, minVisibleMs: 0 });
  const showLabel = useDelayedFlag(true, { delayMs: 1_500, minVisibleMs: 0 });
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-thread-history-loading="true"
      className="flex h-full min-h-0 flex-col justify-end overflow-hidden px-3 pb-4 sm:px-5"
    >
      {showSkeleton ? (
        <div
          aria-hidden="true"
          className="mx-auto w-full min-w-0 max-w-3xl space-y-4 animate-enter-fade"
          data-thread-history-skeleton="true"
        >
          <div className="flex justify-end">
            <Skeleton className="h-11 w-2/5 rounded-2xl rounded-br-sm" />
          </div>
          <div className="space-y-2 px-1">
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <div className="flex justify-end">
            <Skeleton className="h-9 w-1/3 rounded-2xl rounded-br-sm" />
          </div>
        </div>
      ) : null}
      <p
        className={
          showLabel
            ? "mx-auto mt-3 w-full max-w-3xl text-center text-2xs text-subtle-foreground animate-enter-fade"
            : "sr-only"
        }
      >
        Loading conversation…
      </p>
    </div>
  );
}

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function isNodeInsideElement(node: Node, element: HTMLElement): boolean {
  if (node === element) {
    return true;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    return element.contains(node);
  }
  return node.parentElement != null && element.contains(node.parentElement);
}

function closestElementFromNode(node: Node): Element | null {
  if (node.nodeType === Node.ELEMENT_NODE) {
    return node as Element;
  }
  return node.parentElement;
}

function findAssistantMarkdownCopyRegion(range: Range): HTMLElement | null {
  const startRegion = closestElementFromNode(range.startContainer)?.closest<HTMLElement>(
    '[data-chat-copy-region="assistant"]',
  );
  const endRegion = closestElementFromNode(range.endContainer)?.closest<HTMLElement>(
    '[data-chat-copy-region="assistant"]',
  );

  if (!startRegion || startRegion !== endRegion) {
    return null;
  }

  if (
    !isNodeInsideElement(range.startContainer, startRegion) ||
    !isNodeInsideElement(range.endContainer, startRegion)
  ) {
    return null;
  }

  return startRegion;
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

const SYNTHETIC_ASSISTANT_STREAM_MIN_JUMP_CHARS = 80;
const SYNTHETIC_ASSISTANT_STREAM_FRAME_MS = 24;
const SYNTHETIC_ASSISTANT_STREAM_MAX_FRAMES = 36;
type AssistantMessageContextMenuAction = "copy-message";

function hasActiveTextSelection(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString().trim().length > 0;
}

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  const entering = useTimelineRowEntrance(row.id);
  return (
    <div
      className={cn(
        "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
        // Translate on the row's own content never changes the size LegendList
        // measures on its container.
        entering && "animate-enter-rise",
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" ? <WorkGroupSection groupedEntries={row.groupedEntries} /> : null}
      {row.kind === "historical-work" ? <HistoricalWorkLogSection row={row} /> : null}
      {row.kind === "completion-divider" ? (
        <AssistantCompletionDivider completionSummary={row.completionSummary} />
      ) : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
    </div>
  );
});

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const userImages =
    row.message.attachments?.filter((attachment) => attachment.type === "image") ?? [];
  const userFiles =
    row.message.attachments?.filter((attachment) => attachment.type === "file") ?? [];
  const copyText = row.message.text.trim().length > 0 ? row.message.text : null;
  const canRevertAgentWork = typeof row.revertTurnCount === "number";

  return (
    <div className="flex justify-end">
      <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
        {userImages.length > 0 && (
          <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
            {userImages.map((image) => (
              <div
                key={image.id}
                className="overflow-hidden rounded-lg border border-border-subtle bg-muted"
              >
                {image.previewUrl ? (
                  <button
                    type="button"
                    className="block w-full cursor-zoom-in"
                    aria-label={`Preview ${image.name}`}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(userImages, image.id);
                      if (!preview) return;
                      ctx.onImageExpand(preview);
                    }}
                  >
                    <TimelineUserImage src={image.previewUrl} alt={image.name} />
                  </button>
                ) : (
                  <div className="flex aspect-[4/3] items-center justify-center px-2 py-3 text-center text-2xs text-muted-foreground">
                    {image.name}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {userFiles.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {userFiles.map((attachment) => (
              <FileAttachmentPill
                key={attachment.id}
                attachment={attachment}
                environmentId={ctx.activeThreadEnvironmentId}
              />
            ))}
          </div>
        ) : null}
        <CollapsibleUserMessageBody
          text={row.message.text}
          skills={ctx.skills}
          footer={
            <>
              <div className={USER_MESSAGE_META_REVEAL_CLASS_NAME}>
                {copyText && <MessageCopyButton text={copyText} />}
                {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
                {!row.message.streaming && <ForkMessageButton messageId={row.message.id} />}
              </div>
              <p
                className={cn(
                  "text-right text-2xs text-subtle-foreground tabular-nums",
                  USER_MESSAGE_META_REVEAL_CLASS_NAME,
                )}
                data-message-meta="true"
              >
                {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
              </p>
            </>
          }
        />
      </div>
    </div>
  );
}

// Message metadata and actions appear on hover or keyboard focus within the
// message. Devices without hover (touch) keep them visible, matching the
// existing fork button.
const USER_MESSAGE_META_REVEAL_CLASS_NAME =
  "flex items-center gap-1.5 opacity-0 transition-opacity duration-(--duration-fast) focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100";
const ASSISTANT_MESSAGE_META_REVEAL_CLASS_NAME =
  "opacity-0 transition-opacity duration-(--duration-fast) focus-within:opacity-100 group-hover/assistant:opacity-100 group-focus-within/assistant:opacity-100 [@media(hover:none)]:opacity-100";
const MESSAGE_ACTION_BUTTON_CLASS_NAME =
  "border-border-subtle bg-transparent text-subtle-foreground shadow-none hover:border-border hover:bg-accent hover:text-foreground";

// Chat image previews are reserved at a fixed 4:3 box (attachments carry no
// pixel size), filled once loaded, and fade in only on their first load in
// this session so virtualized re-mounts of an already-seen image stay still.
const LOADED_TIMELINE_IMAGE_SRCS = new Set<string>();
const LOADED_TIMELINE_IMAGE_SRC_LIMIT = 256;

function rememberLoadedTimelineImage(src: string): void {
  LOADED_TIMELINE_IMAGE_SRCS.delete(src);
  LOADED_TIMELINE_IMAGE_SRCS.add(src);
  if (LOADED_TIMELINE_IMAGE_SRCS.size > LOADED_TIMELINE_IMAGE_SRC_LIMIT) {
    const oldest = LOADED_TIMELINE_IMAGE_SRCS.values().next().value;
    if (oldest !== undefined) LOADED_TIMELINE_IMAGE_SRCS.delete(oldest);
  }
}

function TimelineUserImage({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(() => LOADED_TIMELINE_IMAGE_SRCS.has(src));
  return (
    <img
      src={src}
      alt={alt}
      onLoad={() => {
        rememberLoadedTimelineImage(src);
        setLoaded(true);
      }}
      // Show the browser's broken-image/alt state rather than an empty box.
      onError={() => setLoaded(true)}
      className={cn(
        "block aspect-[4/3] w-full object-cover transition-opacity duration-(--duration-base) ease-out",
        loaded ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

function RevertUserMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={activity.isRevertingCheckpoint || activity.isWorking}
      onClick={() => ctx.onRevertUserMessage(messageId)}
      title="Revert to this message"
    >
      <Undo2Icon className="size-3" />
    </Button>
  );
}

function ForkMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);
  if (
    ctx.activeProvider !== "claudeAgent" ||
    !ctx.onForkMessage ||
    activity.messageForkDisabled ||
    activity.isWorking ||
    activity.isRevertingCheckpoint
  )
    return null;
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="outline"
      aria-label="Fork from this message"
      title="Fork from this message"
      className={cn(
        MESSAGE_ACTION_BUTTON_CLASS_NAME,
        "opacity-0 transition-[opacity,color,background-color,border-color] duration-(--duration-fast) focus-visible:opacity-100 group-hover:opacity-100 group-hover/assistant:opacity-100 [@media(hover:none)]:opacity-100",
      )}
      onClick={() => ctx.onForkMessage?.(messageId)}
    >
      <GitForkIcon className="size-3" />
    </Button>
  );
}

function useSmoothedAssistantText(messageId: MessageId, sourceText: string) {
  const [displayedText, setDisplayedText] = useState(sourceText);
  const [isAnimating, setIsAnimating] = useState(false);
  const displayedTextRef = useRef(sourceText);
  const targetTextRef = useRef(sourceText);
  const previousMessageIdRef = useRef<MessageId>(messageId);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopTimer();
  }, [stopTimer]);

  useEffect(() => {
    if (previousMessageIdRef.current !== messageId) {
      previousMessageIdRef.current = messageId;
      stopTimer();
      targetTextRef.current = sourceText;
      displayedTextRef.current = sourceText;
      setDisplayedText(sourceText);
      setIsAnimating(false);
      return;
    }

    if (sourceText === targetTextRef.current) {
      return;
    }

    targetTextRef.current = sourceText;
    const currentText = displayedTextRef.current;
    const appendedCharCount = sourceText.length - currentText.length;
    const canSmoothAppend =
      currentText.length > 0 &&
      appendedCharCount >= SYNTHETIC_ASSISTANT_STREAM_MIN_JUMP_CHARS &&
      sourceText.startsWith(currentText);

    if (!canSmoothAppend) {
      stopTimer();
      displayedTextRef.current = sourceText;
      setDisplayedText(sourceText);
      setIsAnimating(false);
      return;
    }

    setIsAnimating(true);
    if (timerRef.current !== null) {
      return;
    }

    timerRef.current = setInterval(() => {
      const target = targetTextRef.current;
      const current = displayedTextRef.current;
      if (!target.startsWith(current)) {
        displayedTextRef.current = target;
        setDisplayedText(target);
        setIsAnimating(false);
        stopTimer();
        return;
      }

      const remaining = target.length - current.length;
      if (remaining <= 0) {
        setIsAnimating(false);
        stopTimer();
        return;
      }

      const step = Math.max(1, Math.ceil(remaining / SYNTHETIC_ASSISTANT_STREAM_MAX_FRAMES));
      const nextText = target.slice(0, current.length + step);
      displayedTextRef.current = nextText;
      setDisplayedText(nextText);
    }, SYNTHETIC_ASSISTANT_STREAM_FRAME_MS);
  }, [messageId, sourceText, stopTimer]);

  return { displayedText, isAnimating };
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const sourceMessageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
  const normalizeCodexCitations = ctx.activeProvider === "codex";
  const { displayedText: messageText, isAnimating } = useSmoothedAssistantText(
    row.message.id,
    sourceMessageText,
  );
  // Native context-menu copies have no button to flip, so confirm inline in
  // the message's meta row instead of a toast.
  const [contextCopied, setContextCopied] = useState(false);
  useEffect(() => {
    if (!contextCopied) return;
    const timer = window.setTimeout(() => setContextCopied(false), 1_200);
    return () => window.clearTimeout(timer);
  }, [contextCopied]);
  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLDivElement>) => {
      // On touch devices the contextmenu event comes from a long-press, which
      // should start native text selection rather than open the custom copy
      // menu — otherwise text on the page can never be selected.
      if (hasOnScreenKeyboard()) {
        return;
      }
      if (hasActiveTextSelection()) {
        return;
      }

      const localApi = readLocalApi();
      if (!localApi) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const clicked = await localApi.contextMenu.show<AssistantMessageContextMenuAction>(
        [{ id: "copy-message", label: "Copy message" }],
        { x: event.clientX, y: event.clientY },
      );

      if (clicked === "copy-message") {
        const copyText = prepareChatMessageMarkdownCopyText(row.message.text ?? "", {
          provider: ctx.activeProvider,
        });
        try {
          await copyTextToClipboard(copyText);
          setContextCopied(true);
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to copy message",
              description: error instanceof Error ? error.message : "Clipboard write failed.",
            }),
          );
        }
        return;
      }
    },
    [ctx.activeProvider, row.message.text],
  );

  return (
    <div className="min-w-0 px-1 py-0.5" onContextMenu={handleContextMenu}>
      <div data-chat-copy-region="assistant" data-chat-copy-message-id={row.message.id}>
        <ChatMarkdown
          text={messageText}
          cwd={ctx.markdownCwd}
          additionalWorkspaceRoots={ctx.additionalWorkspaceRoots}
          isStreaming={Boolean(row.message.streaming || isAnimating)}
          normalizeCodexCitations={normalizeCodexCitations}
          skills={ctx.skills}
        />
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <p
          className={cn(
            "text-2xs text-subtle-foreground tabular-nums",
            ASSISTANT_MESSAGE_META_REVEAL_CLASS_NAME,
          )}
          data-message-meta="true"
        >
          {row.message.streaming ? (
            <LiveMessageMeta
              createdAt={row.message.createdAt}
              durationStart={row.durationStart}
              timestampFormat={ctx.timestampFormat}
            />
          ) : (
            formatMessageMeta(
              row.message.createdAt,
              formatElapsed(row.durationStart, row.message.completedAt),
              ctx.timestampFormat,
            )
          )}
        </p>
        <AssistantCopyButton row={row} />
        {!row.message.streaming && <ForkMessageButton messageId={row.message.id} />}
        {contextCopied ? (
          <span role="status" className="text-2xs text-subtle-foreground animate-enter-fade">
            Copied
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AssistantCompletionDivider({ completionSummary }: { completionSummary: string | null }) {
  return (
    <div className="my-3 flex items-center gap-3" data-completion-divider="true">
      <span className="h-px flex-1 bg-border-subtle" />
      {completionSummary ? (
        <>
          <span className="text-2xs text-subtle-foreground tabular-nums">{completionSummary}</span>
          <span className="h-px flex-1 bg-border-subtle" />
        </>
      ) : null}
    </div>
  );
}

function AssistantCopyButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return (
    <div className={cn("flex items-center", ASSISTANT_MESSAGE_META_REVEAL_CLASS_NAME)}>
      <MessageCopyButton
        text={prepareChatMessageMarkdownCopyText(assistantCopyState.text ?? "", {
          provider: ctx.activeProvider,
        })}
        size="icon-xs"
        variant="outline"
        className={MESSAGE_ACTION_BUTTON_CLASS_NAME}
      />
    </div>
  );
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
      />
    </div>
  );
}

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex items-center gap-2 pt-1 text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-[3px]">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
        </span>
        <span>
          {row.createdAt ? (
            <>
              Working for <WorkingTimer createdAt={row.createdAt} />
            </>
          ) : (
            "Working…"
          )}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels — update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return <span ref={textRef}>{initialText}</span>;
}

/** Live timestamp + elapsed duration for a streaming assistant message. */
function LiveMessageMeta({
  createdAt,
  durationStart,
  timestampFormat,
}: {
  createdAt: string;
  durationStart: string | null | undefined;
  timestampFormat: TimestampFormat;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatLiveMessageMetaNow(createdAt, durationStart, timestampFormat);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatLiveMessageMetaNow(
          createdAt,
          durationStart,
          timestampFormat,
        );
      }
    };
    updateText();
    if (!durationStart) {
      return;
    }
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt, durationStart, timestampFormat]);

  return <span ref={textRef}>{initialText}</span>;
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

function mergeHistoricalActivityRows(
  rows: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity[] {
  const byId = new Map<string, OrchestrationThreadActivity>();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  return [...byId.values()].toSorted(compareHistoricalActivityRows);
}

function compareHistoricalActivityRows(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }
  return left.id.localeCompare(right.id);
}

/** Owns its own expand/collapse state so toggling re-renders only this row.
 *  State resets on unmount which is fine — work groups start collapsed. */
const HistoricalWorkLogSection = memo(function HistoricalWorkLogSection({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "historical-work" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const { onHistoricalWorkLogPresenceResolved, workspaceRoot } = ctx;
  const [isExpanded, setIsExpanded] = useState(false);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [activityRows, setActivityRows] = useState<ReadonlyArray<OrchestrationThreadActivity>>([]);
  const [loadedOffset, setLoadedOffset] = useState<number | null>(null);
  const [initialPageLoaded, setInitialPageLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!isExpanded || initialPageLoaded) {
      return;
    }
    const api = readEnvironmentApi(ctx.activeThreadEnvironmentId);
    const activeThreadId = ctx.activeThreadId;
    if (!api || activeThreadId === null) {
      setInitialPageLoaded(true);
      setLoadError("Work log unavailable while disconnected.");
      return;
    }

    let cancelled = false;
    const loadInitialPage = async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const knownTotal = (
          await api.orchestration.getThreadTurnActivityPage({
            threadId: activeThreadId,
            turnId: row.turnId,
            offset: 0,
            limit: 1,
          })
        ).totalCount;
        if (cancelled) return;
        setTotalCount(knownTotal);
        if (knownTotal <= 0) {
          setActivityRows([]);
          setLoadedOffset(0);
          setInitialPageLoaded(true);
          return;
        }
        const limit = Math.min(HISTORICAL_WORK_LOG_PREVIEW_LIMIT, knownTotal);
        const offset = Math.max(0, knownTotal - limit);
        const page = await api.orchestration.getThreadTurnActivityPage({
          threadId: activeThreadId,
          turnId: row.turnId,
          offset,
          limit,
        });
        if (cancelled) return;
        setTotalCount(page.totalCount);
        setActivityRows(page.activities);
        setLoadedOffset(page.offset);
        setInitialPageLoaded(true);
      } catch {
        if (!cancelled) {
          setLoadError("Couldn’t load the work log.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadInitialPage();
    return () => {
      cancelled = true;
    };
  }, [
    ctx.activeThreadEnvironmentId,
    ctx.activeThreadId,
    initialPageLoaded,
    isExpanded,
    onHistoricalWorkLogPresenceResolved,
    row.turnId,
  ]);

  const visibleEntries = useMemo(() => {
    if (activityRows.length > 0) {
      return deriveWorkLogEntries(activityRows, row.turnId, {
        terminalTurnIds: new Set([row.turnId]),
      });
    }
    return row.summary.previewEntries.slice(-HISTORICAL_WORK_LOG_PREVIEW_LIMIT);
  }, [activityRows, row.summary.previewEntries, row.turnId]);
  const subagentEntries = useMemo(() => {
    const hydratedEntries = deriveSubagentWorkEntries(activityRows, row.turnId, {
      terminalTurnIds: new Set([row.turnId]),
      runtimeSession: ctx.subagentRuntimeSession,
    });
    return mergeHistoricalSubagentEntries(
      row.summary.subagentEntries ?? [],
      hydratedEntries,
      ctx.subagentRuntimeSession,
    ).map((entry) => reconcileSubagentWorkEntryRuntime(entry, ctx.subagentRuntimeSession));
  }, [activityRows, row.summary.subagentEntries, row.turnId, ctx.subagentRuntimeSession]);
  const historicalWorkLogDisplayState = deriveHistoricalWorkLogDisplayState({
    snapshotEntryCount: row.summary.snapshotEntryCount,
    previewEntryCount: row.summary.previewEntries.length,
    visibleEntryCount: visibleEntries.length,
    loadedRawActivityCount: activityRows.length,
    rawTotalCount: totalCount,
    loadedOffset,
  });
  const countLabel = historicalWorkLogDisplayState.countLabel;
  // The latest saved label previews a collapsed log; nothing else is shown
  // when no preview exists (no implementation placeholders).
  const compactSummary = row.summary.previewEntries.at(-1)?.label ?? null;
  const hasOlder =
    loadedOffset !== null
      ? loadedOffset > 0
      : totalCount !== null
        ? totalCount > Math.max(activityRows.length, row.summary.previewEntries.length)
        : false;
  const canShowAll =
    hasOlder && totalCount !== null && totalCount <= HISTORICAL_WORK_LOG_SHOW_ALL_LIMIT;

  useEffect(() => {
    if (!initialPageLoaded || loadedOffset !== 0) return;
    // The activity page also contains subagent lifecycle rows. Once every raw
    // row is present, publish presence from the derived command/tool list—not
    // from raw totalCount—so a child-only turn never masquerades as Work Log.
    onHistoricalWorkLogPresenceResolved(row.turnId, visibleEntries.length > 0);
  }, [
    initialPageLoaded,
    loadedOffset,
    onHistoricalWorkLogPresenceResolved,
    row.turnId,
    visibleEntries.length,
  ]);

  const loadOlderPage = useCallback(async () => {
    if (loadedOffset === null || loadedOffset <= 0 || isLoadingOlder) {
      return;
    }
    const api = readEnvironmentApi(ctx.activeThreadEnvironmentId);
    const activeThreadId = ctx.activeThreadId;
    if (!api || activeThreadId === null) {
      setLoadError("Work log unavailable while disconnected.");
      return;
    }
    const nextOffset = Math.max(0, loadedOffset - HISTORICAL_WORK_LOG_PAGE_SIZE);
    const limit = loadedOffset - nextOffset;
    setIsLoadingOlder(true);
    setLoadError(null);
    try {
      const page = await api.orchestration.getThreadTurnActivityPage({
        threadId: activeThreadId,
        turnId: row.turnId,
        offset: nextOffset,
        limit,
      });
      setTotalCount(page.totalCount);
      setActivityRows((current) => mergeHistoricalActivityRows([...page.activities, ...current]));
      setLoadedOffset(page.offset);
    } catch {
      setLoadError("Couldn’t load older entries.");
    } finally {
      setIsLoadingOlder(false);
    }
  }, [ctx.activeThreadEnvironmentId, ctx.activeThreadId, isLoadingOlder, loadedOffset, row.turnId]);

  const loadAllPages = useCallback(async () => {
    if (totalCount === null || totalCount <= 0 || totalCount > HISTORICAL_WORK_LOG_SHOW_ALL_LIMIT) {
      return;
    }
    const api = readEnvironmentApi(ctx.activeThreadEnvironmentId);
    const activeThreadId = ctx.activeThreadId;
    if (!api || activeThreadId === null) {
      setLoadError("Work log unavailable while disconnected.");
      return;
    }
    setIsLoadingOlder(true);
    setLoadError(null);
    try {
      const page = await api.orchestration.getThreadTurnActivityPage({
        threadId: activeThreadId,
        turnId: row.turnId,
        offset: 0,
        limit: totalCount,
      });
      setTotalCount(page.totalCount);
      setActivityRows(page.activities);
      setLoadedOffset(page.offset);
    } catch {
      setLoadError("Couldn’t load the full work log.");
    } finally {
      setIsLoadingOlder(false);
    }
  }, [ctx.activeThreadEnvironmentId, ctx.activeThreadId, row.turnId, totalCount]);

  // `totalCount` and `loadedOffset` describe raw activities, including the
  // independently rendered subagent lifecycle. Only a complete scan plus an
  // empty derived command/tool list proves that the Work Log itself is empty.
  const workKnownEmpty = initialPageLoaded && loadedOffset === 0 && visibleEntries.length === 0;

  const showLoading = useDelayedFlag(isLoading && visibleEntries.length === 0);

  if (workKnownEmpty) {
    return <SubagentGroupSection entries={subagentEntries} />;
  }

  // Collapsed and expanded share one surface and one header style; the
  // chevron rotates and the revealed rows rise in (docs/style-guide.md §8).
  return (
    <div className="space-y-2">
      <SubagentGroupSection entries={subagentEntries} />
      <div
        className="rounded-xl border border-border-subtle bg-card"
        data-historical-work-log-row={isExpanded ? "expanded" : "collapsed"}
      >
        <div className="flex min-w-0 items-center justify-between gap-2 pr-2">
          <button
            type="button"
            className="focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-2xs text-subtle-foreground transition-colors duration-(--duration-fast) hover:text-foreground"
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded((value) => !value)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3 shrink-0 transition-transform duration-(--duration-fast) ease-out",
                isExpanded && "rotate-90",
              )}
            />
            <span className="shrink-0 font-medium text-muted-foreground">Work log{countLabel}</span>
            {!isExpanded && compactSummary ? (
              <span className="truncate">{compactSummary}</span>
            ) : null}
          </button>
          {isExpanded ? (
            <div className="flex shrink-0 items-center gap-2">
              {canShowAll ? (
                <button
                  type="button"
                  className="focus-ring rounded-sm text-2xs text-subtle-foreground transition-colors duration-(--duration-fast) hover:text-foreground disabled:opacity-50"
                  disabled={isLoadingOlder}
                  onClick={loadAllPages}
                >
                  Show all
                </button>
              ) : null}
              {hasOlder ? (
                <button
                  type="button"
                  className="focus-ring rounded-sm text-2xs text-subtle-foreground transition-colors duration-(--duration-fast) hover:text-foreground disabled:opacity-50"
                  disabled={isLoadingOlder}
                  onClick={loadOlderPage}
                >
                  {isLoadingOlder ? "Loading…" : "Show older"}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {isExpanded ? (
          <div className="px-2 pb-1.5 animate-enter-rise">
            {isLoading && visibleEntries.length === 0 ? (
              showLoading ? (
                <div role="status" aria-label="Loading work log" className="space-y-1.5 px-1 py-1">
                  <Skeleton className="h-3 w-3/5" />
                  <Skeleton className="h-3 w-2/5" />
                </div>
              ) : null
            ) : visibleEntries.length === 0 ? (
              <p className="px-0.5 py-1 text-2xs text-subtle-foreground">No commands or tools.</p>
            ) : (
              <div className="space-y-0.5">
                {visibleEntries.map((workEntry) => (
                  <SimpleWorkEntryRow
                    key={`historical-work-row:${workEntry.id}`}
                    workEntry={workEntry}
                    workspaceRoot={workspaceRoot}
                  />
                ))}
              </div>
            )}
            {loadError ? (
              <p className="mt-1 px-0.5 text-2xs text-destructive-foreground">{loadError}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

const SubagentGroupSection = memo(function SubagentGroupSection(props: {
  readonly entries: ReadonlyArray<SubagentRosterEntry>;
}) {
  const { onOpenSubagentDetail } = use(TimelineRowCtx);
  const { subagentDetailOpen } = use(TimelineRowActivityCtx);
  if (props.entries.length === 0) return null;

  return (
    <section
      aria-label={`${props.entries.length} ${props.entries.length === 1 ? "subagent" : "subagents"}`}
      className="rounded-xl border border-border-subtle bg-card px-2 py-1.5"
      data-subagent-turn-group="true"
    >
      {/* Every row is shown, so the heading carries no count. */}
      <p className="mb-1 px-0.5 text-2xs font-medium text-subtle-foreground">Subagents</p>
      <div className="space-y-0.5">
        {props.entries.map((entry) => (
          <SubagentRosterRow
            key={`subagent-row:${entry.id}`}
            entry={entry}
            paused={subagentDetailOpen}
            onOpen={onOpenSubagentDetail}
          />
        ))}
      </div>
    </section>
  );
});

const WORK_LOG_FOLLOW_THRESHOLD_PX = 32;

/**
 * A long expanded Work Log is the only inner scroller in the turn row. It
 * follows its tail while the reader stays at the bottom, but never steals the
 * viewport after they scroll upward to inspect an older command.
 */
const IntentAwareWorkLogList = memo(function IntentAwareWorkLogList(props: {
  readonly entries: ReadonlyArray<WorkLogEntry>;
  readonly scrollable: boolean;
  readonly entering?: boolean;
  readonly workspaceRoot: string | undefined;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const [newEntries, setNewEntries] = useState(0);
  const priorLastIdRef = useRef<string | null>(null);
  const lastId = props.entries.at(-1)?.id ?? null;

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const changed = priorLastIdRef.current !== null && priorLastIdRef.current !== lastId;
    priorLastIdRef.current = lastId;
    if (!scroller || !props.scrollable) return;
    if (following) {
      scroller.scrollTop = scroller.scrollHeight;
      setNewEntries(0);
    } else if (changed) {
      setNewEntries((count) => count + 1);
    }
  }, [following, lastId, props.entries.length, props.scrollable]);

  const jumpToLatest = () => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    setFollowing(true);
    setNewEntries(0);
  };

  return (
    <div className={cn("relative min-h-0", props.entering && "animate-enter-rise")}>
      <div
        ref={scrollerRef}
        className={cn(
          "space-y-0.5",
          props.scrollable &&
            "max-h-[min(22rem,45vh)] overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]",
        )}
        data-work-log-scroll={props.scrollable ? "true" : undefined}
        onScroll={(event) => {
          if (!props.scrollable) return;
          const node = event.currentTarget;
          const atBottom =
            node.scrollHeight - node.scrollTop - node.clientHeight <= WORK_LOG_FOLLOW_THRESHOLD_PX;
          setFollowing(atBottom);
          if (atBottom) setNewEntries(0);
        }}
      >
        {props.entries.map((workEntry) => (
          <OrdinaryWorkEntryRow
            key={`work-row:${workEntry.id}`}
            workEntry={workEntry}
            workspaceRoot={props.workspaceRoot}
          />
        ))}
      </div>
      {newEntries > 0 ? (
        <button
          type="button"
          className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded-full border border-border bg-raised px-2.5 py-1 text-2xs text-foreground shadow-sm transition-colors duration-(--duration-fast) hover:bg-accent"
          data-work-log-jump-to-latest="true"
          onClick={jumpToLatest}
        >
          {newEntries} new · Jump to latest
        </button>
      ) : null}
    </div>
  );
});

const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
}) {
  const { workspaceRoot } = use(TimelineRowCtx);
  const [isExpanded, setIsExpanded] = useState(false);
  const ordinaryEntries = groupedEntries.filter((entry) => !entry.subagent);
  const subagentEntries = groupedEntries.filter(
    (entry): entry is SubagentRosterEntry => entry.subagent !== undefined,
  );
  const hasOverflow = ordinaryEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? ordinaryEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : ordinaryEntries;
  const hiddenCount = ordinaryEntries.length - visibleEntries.length;
  const onlyToolEntries = ordinaryEntries.every((entry) => entry.tone === "tool");
  const showHeader = hasOverflow || !onlyToolEntries;
  const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";

  return (
    <div className="space-y-2" data-turn-activity-groups="true">
      <SubagentGroupSection entries={subagentEntries} />
      {ordinaryEntries.length > 0 ? (
        <section
          className="rounded-xl border border-border-subtle bg-card px-2 py-1.5"
          data-work-log="true"
        >
          {showHeader ? (
            // The count is shown only where rows are hidden ("Show N more").
            <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
              <p className="text-2xs font-medium text-subtle-foreground">{groupLabel}</p>
              {hasOverflow ? (
                <button
                  type="button"
                  className="focus-ring inline-flex items-center gap-1 rounded-sm text-2xs text-subtle-foreground transition-colors duration-(--duration-fast) hover:text-foreground"
                  aria-expanded={isExpanded}
                  onClick={() => setIsExpanded((value) => !value)}
                >
                  {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                  <ChevronRightIcon
                    aria-hidden="true"
                    className={cn(
                      "size-3 transition-transform duration-(--duration-fast) ease-out",
                      isExpanded ? "-rotate-90" : "rotate-90",
                    )}
                  />
                </button>
              ) : null}
            </div>
          ) : null}
          <IntentAwareWorkLogList
            // Re-key on expand so the revealed history rises in once.
            key={isExpanded ? "expanded" : "collapsed"}
            entries={visibleEntries}
            scrollable={hasOverflow && isExpanded}
            entering={isExpanded}
            workspaceRoot={workspaceRoot}
          />
        </section>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }

  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody text={props.text} skills={props.skills} />
        </div>
      ) : null}
      {canCollapse || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            canCollapse && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {canCollapse ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1 h-6 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
}) {
  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      <SkillInlineText text={props.text} skills={props.skills} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function formatWorkingTimerNow(startIso: string): string {
  return formatElapsed(startIso, new Date().toISOString()) ?? "0s";
}

function formatLiveMessageMetaNow(
  createdAt: string,
  durationStart: string | null | undefined,
  timestampFormat: TimestampFormat,
): string {
  const elapsed = durationStart ? formatElapsed(durationStart, new Date().toISOString()) : null;
  return formatMessageMeta(createdAt, elapsed, timestampFormat);
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-destructive-foreground",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-muted-foreground",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-muted-foreground",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-muted-foreground",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-destructive-foreground";
  if (tone === "tool") return "text-muted-foreground";
  if (tone === "thinking") return "text-muted-foreground";
  return "text-subtle-foreground";
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "terminal-input") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function openFileWithPreferredEditor(input: {
  readonly environmentId: EnvironmentId;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly defaultEditor: DefaultEditorSelection;
  readonly availableEditors: ReadonlyArray<EditorId>;
}) {
  const absolutePath = resolveWorkspaceFilePath(input.filePath, input.workspaceRoot);
  if (!absolutePath) {
    return;
  }
  const api = readLocalApi();
  if (!api) {
    return;
  }
  if (!getLocalShellCapabilities(input.environmentId).canOpenLocalEditor) {
    void copyTextToClipboard(absolutePath).catch((error: unknown) => {
      console.warn("Failed to copy file path", error);
    });
    return;
  }
  const editor = resolveFileOpenEditor(input.defaultEditor, input.availableEditors);
  const opened = editor
    ? api.shell.openInEditor(absolutePath, editor)
    : api.shell.openPath(absolutePath);
  void opened.catch((error: unknown) => {
    console.warn("Failed to open file", error);
  });
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  return <OrdinaryWorkEntryRow {...props} />;
});

const OrdinaryWorkEntryRow = memo(function OrdinaryWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { activeThreadEnvironmentId, activeThreadId, timestampFormat } = use(TimelineRowCtx);
  if (props.workEntry.turnConfiguration)
    return <TurnConfigurationWorkEntry configuration={props.workEntry.turnConfiguration} />;
  if (props.workEntry.publicSummary)
    return <ClaudeSummaryWorkEntry summary={props.workEntry.publicSummary} />;
  if (props.workEntry.desktopObservation && activeThreadId)
    return (
      <DesktopObservation
        entry={props.workEntry}
        environmentId={activeThreadEnvironmentId}
        threadId={activeThreadId}
        timestampFormat={timestampFormat}
      />
    );
  return <OrdinaryWorkEntryContent {...props} />;
});

const OrdinaryWorkEntryContent = memo(function OrdinaryWorkEntryContent(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const { activeThreadEnvironmentId, timestampFormat } = use(TimelineRowCtx);
  const defaultEditor = useSettings((settings) => settings.defaultEditor);
  const availableEditors = useServerAvailableEditors();
  const canOpenLocalEditor =
    getLocalShellCapabilities(activeThreadEnvironmentId).canOpenLocalEditor;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const rawCommand = workEntryRawCommand(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;
  const primaryChangedFile = workEntry.changedFiles?.[0] ?? null;
  const canOpenPrimaryChangedFile =
    primaryChangedFile !== null &&
    resolveWorkspaceFilePath(primaryChangedFile, workspaceRoot) !== null;
  const openResolvedFile = useCallback(
    (filePath: string) =>
      openFileWithPreferredEditor({
        environmentId: activeThreadEnvironmentId,
        filePath,
        workspaceRoot,
        defaultEditor,
        availableEditors,
      }),
    [activeThreadEnvironmentId, availableEditors, defaultEditor, workspaceRoot],
  );
  // Paths named in the command/detail are already visible in its text, so
  // they no longer repeat as chips; the open/copy action stays available from
  // one revealed control. Changed files that are also listed below are skipped.
  const commandPathTokens = useMemo(() => {
    const changed = new Set(workEntry.changedFiles ?? []);
    return extractOpenablePathTokens(
      [workEntry.command, rawCommand, workEntry.detail].filter(Boolean).join(" "),
      workspaceRoot,
    ).filter((filePath) => !changed.has(filePath));
  }, [rawCommand, workEntry.changedFiles, workEntry.command, workEntry.detail, workspaceRoot]);
  const openVerb = canOpenLocalEditor ? "Open" : "Copy";
  const extraChangedFiles = workEntry.changedFiles?.slice(1) ?? [];
  if (workEntry.commandInspection) {
    return (
      <div className="group/work-row flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1">
          <ClaudeCommandWorkEntry
            inspection={workEntry.commandInspection}
            timestampFormat={timestampFormat}
          />
        </div>
        {commandPathTokens.length > 0 ? (
          <div className="pt-1">
            <WorkEntryOpenPaths
              paths={commandPathTokens}
              workspaceRoot={workspaceRoot}
              openVerb={openVerb}
              onOpen={openResolvedFile}
            />
          </div>
        ) : null}
      </div>
    );
  }
  const rowContent = (
    <>
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          {rawCommand ? (
            <div className="max-w-full">
              <p className={cn("truncate text-xs leading-5", workToneClass(workEntry.tone))}>
                <span className={cn("text-foreground", workToneClass(workEntry.tone))}>
                  {heading}
                </span>
                {preview && (
                  <Tooltip>
                    <TooltipTrigger
                      closeDelay={0}
                      delay={75}
                      render={
                        <span className="max-w-full cursor-default text-subtle-foreground transition-colors hover:text-muted-foreground hover:underline focus-visible:text-muted-foreground focus-visible:underline group-hover/file-open:underline group-focus-visible/file-open:underline underline-offset-2">
                          {" "}
                          - {preview}
                        </span>
                      }
                    />
                    <TooltipPopup
                      align="start"
                      className="max-w-[min(56rem,calc(100vw-2rem))] px-0 py-0"
                      side="top"
                    >
                      <div className="max-w-[min(56rem,calc(100vw-2rem))] overflow-x-auto px-1.5 py-1 font-mono text-2xs leading-4 whitespace-nowrap">
                        {rawCommand}
                      </div>
                    </TooltipPopup>
                  </Tooltip>
                )}
              </p>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger className="block min-w-0 w-full text-left" aria-label={displayText}>
                <p className={cn("truncate text-2xs leading-5", workToneClass(workEntry.tone))}>
                  <span className={cn("text-foreground", workToneClass(workEntry.tone))}>
                    {heading}
                  </span>
                  {preview && (
                    <span className="text-subtle-foreground group-hover/file-open:underline group-focus-visible/file-open:underline underline-offset-2">
                      {" "}
                      - {preview}
                    </span>
                  )}
                </p>
              </TooltipTrigger>
              <TooltipPopup className="max-w-[min(720px,calc(100vw-2rem))]">
                <p className="whitespace-pre-wrap wrap-break-word text-xs leading-5">
                  {displayText}
                </p>
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
        {commandPathTokens.length > 0 ? (
          <WorkEntryOpenPaths
            paths={commandPathTokens}
            workspaceRoot={workspaceRoot}
            openVerb={openVerb}
            onOpen={openResolvedFile}
          />
        ) : null}
      </div>
      {hasChangedFiles && !previewIsChangedFiles && primaryChangedFile !== null && (
        // The row already describes the change, so list one file and fold the
        // rest behind "+N more" (each still opens from that menu).
        <div className="mt-1 flex flex-wrap items-center gap-1 pl-6">
          <ChangedFileChip
            entryId={workEntry.id}
            filePath={primaryChangedFile}
            workspaceRoot={workspaceRoot}
            openVerb={openVerb}
            onOpen={openResolvedFile}
          />
          {extraChangedFiles.length > 0 ? (
            <Menu>
              <MenuTrigger
                className="focus-ring rounded-sm px-1 text-2xs text-subtle-foreground transition-colors duration-(--duration-fast) hover:text-foreground"
                data-work-log-more-files="true"
                aria-label={`${extraChangedFiles.length} more changed ${
                  extraChangedFiles.length === 1 ? "file" : "files"
                }`}
              >
                +{extraChangedFiles.length} more
              </MenuTrigger>
              <MenuPopup align="start" className="max-w-[min(32rem,calc(100vw-2rem))]">
                {extraChangedFiles.map((filePath) => {
                  const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
                  const canOpenFile = resolveWorkspaceFilePath(filePath, workspaceRoot) !== null;
                  return (
                    <MenuItem
                      key={`${workEntry.id}:more:${filePath}`}
                      disabled={!canOpenFile}
                      className="font-mono text-2xs"
                      onClick={() => openResolvedFile(filePath)}
                    >
                      <span className="truncate">{displayPath}</span>
                    </MenuItem>
                  );
                })}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      )}
    </>
  );

  if (canOpenPrimaryChangedFile && previewIsChangedFiles) {
    return (
      <button
        className="group/file-open block w-full rounded-lg px-1 py-1 text-left transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => openResolvedFile(primaryChangedFile)}
        title={`${openVerb} ${formatWorkspaceRelativePath(primaryChangedFile, workspaceRoot)}`}
        type="button"
      >
        {rowContent}
      </button>
    );
  }

  return <div className="group/work-row rounded-lg px-1 py-1">{rowContent}</div>;
});

const ChangedFileChip = memo(function ChangedFileChip(props: {
  readonly entryId: string;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly openVerb: "Open" | "Copy";
  readonly onOpen: (filePath: string) => void;
}) {
  const displayPath = formatWorkspaceRelativePath(props.filePath, props.workspaceRoot);
  const canOpenFile = resolveWorkspaceFilePath(props.filePath, props.workspaceRoot) !== null;
  return (
    <button
      key={`${props.entryId}:${props.filePath}`}
      data-work-log-path-pill="changed-file"
      className={cn(
        "max-w-full rounded-sm border border-border-subtle bg-background px-1.5 py-0.5 text-left font-mono text-2xs text-muted-foreground break-words",
        canOpenFile
          ? "cursor-pointer transition-colors duration-(--duration-fast) hover:border-primary/45 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:underline underline-offset-2"
          : "cursor-default",
      )}
      disabled={!canOpenFile}
      onClick={(event) => {
        event.stopPropagation();
        props.onOpen(props.filePath);
      }}
      title={canOpenFile ? `${props.openVerb} ${displayPath}` : displayPath}
      type="button"
    >
      {displayPath}
    </button>
  );
});

/**
 * Hover/focus-revealed open (or copy, without a local editor) action for the
 * workspace paths a command names. One path opens directly; several open
 * from a menu. Always visible on devices without hover.
 */
const WorkEntryOpenPaths = memo(function WorkEntryOpenPaths(props: {
  readonly paths: ReadonlyArray<string>;
  readonly workspaceRoot: string | undefined;
  readonly openVerb: "Open" | "Copy";
  readonly onOpen: (filePath: string) => void;
}) {
  const revealClassName =
    "focus-ring inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-subtle-foreground opacity-0 transition-[opacity,color] duration-(--duration-fast) hover:text-foreground focus-visible:opacity-100 group-hover/work-row:opacity-100 data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100";
  const [singlePath] = props.paths;
  if (props.paths.length === 1 && singlePath !== undefined) {
    const displayPath = formatWorkspaceRelativePath(singlePath, props.workspaceRoot);
    const label = `${props.openVerb} ${displayPath}`;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={revealClassName}
              aria-label={label}
              data-work-log-open-path="true"
              onClick={(event) => {
                event.stopPropagation();
                props.onOpen(singlePath);
              }}
            />
          }
        >
          <ExternalLinkIcon aria-hidden="true" className="size-3" />
        </TooltipTrigger>
        <TooltipPopup className="font-mono text-2xs">{label}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        className={revealClassName}
        aria-label={`${props.openVerb} a file from this command`}
        data-work-log-open-path="true"
      >
        <ExternalLinkIcon aria-hidden="true" className="size-3" />
      </MenuTrigger>
      <MenuPopup align="end" className="max-w-[min(32rem,calc(100vw-2rem))]">
        {props.paths.map((filePath) => (
          <MenuItem
            key={filePath}
            className="font-mono text-2xs"
            onClick={() => props.onOpen(filePath)}
          >
            <span className="truncate">
              {formatWorkspaceRelativePath(filePath, props.workspaceRoot)}
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
});
