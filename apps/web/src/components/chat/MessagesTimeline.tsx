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
import { deriveTimelineEntries, deriveWorkLogEntries, formatElapsed } from "../../session-logic";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { MessageCopyButton } from "./MessageCopyButton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  computeStableMessagesTimelineRows,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveHistoricalWorkLogDisplayState,
  deriveMessagesTimelineRows,
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
  summarizeTimelineScrollMetrics,
  type TimelineScrollDebugEventInput,
  type TimelineScrollDebugListState,
} from "./timelineScrollDebug";
import { useHistoricalWorkLogPresence } from "./useHistoricalWorkLogPresence";

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
  onImageExpand: (preview: ExpandedImagePreview) => void;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
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
const TIMELINE_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  data: false,
  size: true,
} as const;

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
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
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onUserScrollIntent: () => void;
  onDebugScrollEvent?: (event: TimelineScrollDebugEventInput) => void;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
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
  markdownCwd,
  additionalWorkspaceRoots = [],
  timestampFormat,
  workspaceRoot,
  activeThreadId: activeThreadIdProp,
  skills = EMPTY_TIMELINE_SKILLS,
  stickToEndRevision,
  autoFollowTail,
  onIsAtEndChange,
  onUserScrollIntent,
  onDebugScrollEvent,
}: MessagesTimelineProps) {
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
  const stickToEndDeadlineMsRef = useRef(0);
  const submitStickScrollEventRepinFrameRef = useRef<number | null>(null);
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
      if (!copyRegion) {
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
      void list.scrollToIndex?.({
        index: rowCount - 1,
        animated: false,
        viewPosition: 1,
      });
      emitScrollDebugEvent(reason, {
        state: state ?? null,
        details: {
          result: "requested",
          requestedRowCount: rowCount,
          targetIndex: rowCount - 1,
        },
      });
    },
    [emitScrollDebugEvent, listRef, onDebugScrollEvent, rows.length],
  );
  const cancelSubmitStickToEnd = useCallback(() => {
    // Invalidate every already-scheduled initial/submit hard-scroll callback.
    // Clearing only the deadline is insufficient because the animation-frame
    // loop historically did not consult it before issuing scrollToEnd.
    forcedScrollGenerationRef.current += 1;
    stickToEndDeadlineMsRef.current = 0;
    if (submitStickScrollEventRepinFrameRef.current !== null) {
      window.cancelAnimationFrame(submitStickScrollEventRepinFrameRef.current);
      submitStickScrollEventRepinFrameRef.current = null;
    }
  }, []);
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
    },
    [],
  );

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

    if (previousRowCount > 0 || rows.length === 0) {
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
  }, [forceScrollToEnd, onIsAtEndChange, rows.length]);

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
      onRevertUserMessage,
      onImageExpand,
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
      onRevertUserMessage,
      onImageExpand,
    ],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isRevertingCheckpoint,
    }),
    [isRevertingCheckpoint, isWorking],
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

  if (rows.length === 0 && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
        <LegendList<MessagesTimelineRow>
          ref={listRef}
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          estimatedItemSize={90}
          initialScrollAtEnd
          maintainScrollAtEnd={autoFollowTail}
          maintainScrollAtEndThreshold={TIMELINE_MAINTAIN_SCROLL_AT_END_THRESHOLD}
          maintainVisibleContentPosition={TIMELINE_MAINTAIN_VISIBLE_CONTENT_POSITION}
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
          ListFooterComponent={TIMELINE_LIST_FOOTER}
        />
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
});

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

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
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
  return (
    <div
      className={cn(
        "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
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
  const userImages = row.message.attachments ?? [];
  const copyText = row.message.text.trim().length > 0 ? row.message.text : null;
  const canRevertAgentWork = typeof row.revertTurnCount === "number";

  return (
    <div className="flex justify-end">
      <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
        {userImages.length > 0 && (
          <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
            {userImages.map((image: NonNullable<TimelineMessage["attachments"]>[number]) => (
              <div
                key={image.id}
                className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
              >
                {image.previewUrl ? (
                  <button
                    type="button"
                    className="h-full w-full cursor-zoom-in"
                    aria-label={`Preview ${image.name}`}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(userImages, image.id);
                      if (!preview) return;
                      ctx.onImageExpand(preview);
                    }}
                  >
                    <img
                      src={image.previewUrl}
                      alt={image.name}
                      className="block h-auto max-h-[220px] w-full object-cover"
                    />
                  </button>
                ) : (
                  <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                    {image.name}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <CollapsibleUserMessageBody
          text={row.message.text}
          skills={ctx.skills}
          footer={
            <>
              <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                {copyText && <MessageCopyButton text={copyText} />}
                {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
              </div>
              <p className="text-right text-xs text-muted-foreground/50">
                {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
              </p>
            </>
          }
        />
      </div>
    </div>
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
          if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
            throw new Error("Clipboard is unavailable.");
          }
          await navigator.clipboard.writeText(copyText);
          toastManager.add(stackedThreadToast({ type: "success", title: "Copied message" }));
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
        <p className="text-[10px] text-muted-foreground/30">
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
      </div>
    </div>
  );
}

function AssistantCompletionDivider({ completionSummary }: { completionSummary: string | null }) {
  return (
    <div className="my-3 flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
        {completionSummary ? `Response • ${completionSummary}` : "Response"}
      </span>
      <span className="h-px flex-1 bg-border" />
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
    <div className="flex items-center opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/assistant:opacity-100">
      <MessageCopyButton
        text={prepareChatMessageMarkdownCopyText(assistantCopyState.text ?? "", {
          provider: ctx.activeProvider,
        })}
        size="icon-xs"
        variant="outline"
        className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
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
      <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70">
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
            "Working..."
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
      setLoadError("Work log is unavailable while this environment is disconnected.");
      return;
    }

    let cancelled = false;
    const loadInitialPage = async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const knownTotal =
          totalCount ??
          (
            await api.orchestration.getThreadTurnActivityPage({
              threadId: activeThreadId,
              turnId: row.turnId,
              offset: 0,
              limit: 1,
            })
          ).totalCount;
        if (cancelled) return;
        setTotalCount(knownTotal);
        onHistoricalWorkLogPresenceResolved(row.turnId, knownTotal > 0);
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
          setLoadError("Unable to load this work log page.");
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
    totalCount,
  ]);

  const visibleEntries = useMemo(() => {
    if (activityRows.length > 0) {
      return deriveWorkLogEntries(activityRows, row.turnId);
    }
    return row.summary.previewEntries.slice(-HISTORICAL_WORK_LOG_PREVIEW_LIMIT);
  }, [activityRows, row.summary.previewEntries, row.turnId]);
  const historicalWorkLogDisplayState = deriveHistoricalWorkLogDisplayState({
    snapshotEntryCount: row.summary.snapshotEntryCount,
    previewEntryCount: row.summary.previewEntries.length,
    visibleEntryCount: visibleEntries.length,
    loadedRawActivityCount: activityRows.length,
    rawTotalCount: totalCount,
    loadedOffset,
  });
  const displayCount = historicalWorkLogDisplayState.displayCount;
  const countLabel = historicalWorkLogDisplayState.countLabel;
  const compactSummary =
    row.summary.previewEntries.at(-1)?.label ??
    (displayCount > 0 ? "Saved activity" : "Fetch on demand");
  const hasOlder =
    loadedOffset !== null
      ? loadedOffset > 0
      : totalCount !== null
        ? totalCount > Math.max(activityRows.length, row.summary.previewEntries.length)
        : false;
  const canShowAll =
    hasOlder && totalCount !== null && totalCount <= HISTORICAL_WORK_LOG_SHOW_ALL_LIMIT;

  const loadOlderPage = useCallback(async () => {
    if (loadedOffset === null || loadedOffset <= 0 || isLoadingOlder) {
      return;
    }
    const api = readEnvironmentApi(ctx.activeThreadEnvironmentId);
    const activeThreadId = ctx.activeThreadId;
    if (!api || activeThreadId === null) {
      setLoadError("Work log is unavailable while this environment is disconnected.");
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
      setLoadError("Unable to load older work log entries.");
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
      setLoadError("Work log is unavailable while this environment is disconnected.");
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
      setLoadError("Unable to load the full work log.");
    } finally {
      setIsLoadingOlder(false);
    }
  }, [ctx.activeThreadEnvironmentId, ctx.activeThreadId, row.turnId, totalCount]);

  const knownEmpty =
    totalCount === 0 &&
    row.summary.snapshotEntryCount === 0 &&
    row.summary.previewEntries.length === 0;

  if (knownEmpty) {
    return null;
  }

  if (!isExpanded) {
    return (
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/35 bg-card/15 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground/70 transition-colors hover:border-border/60 hover:bg-card/25 hover:text-foreground/80"
        data-historical-work-log-row="collapsed"
        onClick={() => setIsExpanded(true)}
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/45" />
          <span className="shrink-0 font-medium text-muted-foreground/75">
            Work log{countLabel}
          </span>
          <span className="truncate text-muted-foreground/45">{compactSummary}</span>
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/45">
          Expand
        </span>
      </button>
    );
  }

  return (
    <div
      className="rounded-xl border border-border/45 bg-card/20 px-2 py-1.5"
      data-historical-work-log-row="expanded"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
        <button
          type="button"
          className="inline-flex min-w-0 items-center gap-1.5 text-[9px] uppercase tracking-[0.16em] text-muted-foreground/60 transition-colors hover:text-foreground/75"
          onClick={() => setIsExpanded(false)}
        >
          <ChevronDownIcon className="size-3 shrink-0" />
          <span>Work log{countLabel}</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {canShowAll ? (
            <button
              type="button"
              className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75 disabled:opacity-45"
              disabled={isLoadingOlder}
              onClick={loadAllPages}
            >
              Show all
            </button>
          ) : null}
          {hasOlder ? (
            <button
              type="button"
              className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75 disabled:opacity-45"
              disabled={isLoadingOlder}
              onClick={loadOlderPage}
            >
              {isLoadingOlder ? "Loading..." : "Show older"}
            </button>
          ) : null}
        </div>
      </div>
      {isLoading && visibleEntries.length === 0 ? (
        <p className="px-0.5 py-1 text-[11px] text-muted-foreground/50">Loading work log...</p>
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
        <p className="mt-1 px-0.5 text-[10px] text-destructive/75">{loadError}</p>
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
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  const showHeader = hasOverflow || !onlyToolEntries;
  const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";

  return (
    <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      {showHeader && (
        <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
            {groupLabel} ({groupedEntries.length})
          </p>
          {hasOverflow && (
            <button
              type="button"
              className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
              onClick={() => setIsExpanded((v) => !v)}
            >
              {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
            </button>
          )}
        </div>
      )}
      <div className="space-y-0.5">
        {visibleEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={`work-row:${workEntry.id}`}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
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
              className="-ml-1 h-6 rounded-md px-1.5 text-xs text-muted-foreground/72 hover:bg-muted/55 hover:text-foreground/85"
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
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
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
  if (!getLocalShellCapabilities().canOpenLocalEditor) {
    void navigator.clipboard?.writeText(absolutePath).catch((error: unknown) => {
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
  const { workEntry, workspaceRoot } = props;
  const defaultEditor = useSettings((settings) => settings.defaultEditor);
  const availableEditors = useServerAvailableEditors();
  const canOpenLocalEditor = getLocalShellCapabilities().canOpenLocalEditor;
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
        filePath,
        workspaceRoot,
        defaultEditor,
        availableEditors,
      }),
    [availableEditors, defaultEditor, workspaceRoot],
  );
  const commandPathTokens = useMemo(
    () =>
      extractOpenablePathTokens(
        [workEntry.command, rawCommand, workEntry.detail].filter(Boolean).join(" "),
        workspaceRoot,
      ),
    [rawCommand, workEntry.command, workEntry.detail, workspaceRoot],
  );
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
              <p
                className={cn(
                  "truncate text-xs leading-5",
                  workToneClass(workEntry.tone),
                  preview ? "text-muted-foreground/70" : "",
                )}
              >
                <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                  {heading}
                </span>
                {preview && (
                  <Tooltip>
                    <TooltipTrigger
                      closeDelay={0}
                      delay={75}
                      render={
                        <span className="max-w-full cursor-default text-muted-foreground/55 transition-colors hover:text-muted-foreground/75 hover:underline focus-visible:text-muted-foreground/75 focus-visible:underline group-hover/file-open:underline group-focus-visible/file-open:underline underline-offset-2">
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
                      <div className="max-w-[min(56rem,calc(100vw-2rem))] overflow-x-auto px-1.5 py-1 font-mono text-[11px] leading-4 whitespace-nowrap">
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
                <p
                  className={cn(
                    "truncate text-[11px] leading-5",
                    workToneClass(workEntry.tone),
                    preview ? "text-muted-foreground/70" : "",
                  )}
                >
                  <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                    {heading}
                  </span>
                  {preview && (
                    <span className="text-muted-foreground/55 group-hover/file-open:underline group-focus-visible/file-open:underline underline-offset-2">
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
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            const canOpenFile = resolveWorkspaceFilePath(filePath, workspaceRoot) !== null;
            return (
              <button
                key={`${workEntry.id}:${filePath}`}
                data-work-log-path-pill="changed-file"
                className={cn(
                  "max-w-full rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 text-left font-mono text-[10px] text-muted-foreground/75 break-words",
                  canOpenFile
                    ? "cursor-pointer transition-colors hover:border-primary/45 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/45 focus-visible:underline underline-offset-2"
                    : "cursor-default",
                )}
                disabled={!canOpenFile}
                onClick={(event) => {
                  event.stopPropagation();
                  openResolvedFile(filePath);
                }}
                title={
                  canOpenFile
                    ? `${canOpenLocalEditor ? "Open" : "Copy"} ${displayPath}`
                    : displayPath
                }
                type="button"
              >
                {displayPath}
              </button>
            );
          })}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
      {commandPathTokens.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {commandPathTokens.map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            return (
              <button
                key={`${workEntry.id}:command-path:${filePath}`}
                data-work-log-path-pill="command-token"
                className="max-w-full rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 text-left font-mono text-[10px] text-muted-foreground/75 break-words cursor-pointer transition-colors hover:border-primary/45 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/45 focus-visible:underline underline-offset-2"
                onClick={(event) => {
                  event.stopPropagation();
                  openResolvedFile(filePath);
                }}
                title={`${canOpenLocalEditor ? "Open" : "Copy"} ${displayPath}`}
                type="button"
              >
                {displayPath}
              </button>
            );
          })}
        </div>
      )}
    </>
  );

  if (canOpenPrimaryChangedFile && previewIsChangedFiles) {
    return (
      <button
        className="group/file-open block w-full rounded-lg px-1 py-1 text-left transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/35"
        onClick={() => openResolvedFile(primaryChangedFile)}
        title={`${canOpenLocalEditor ? "Open" : "Copy"} ${formatWorkspaceRelativePath(primaryChangedFile, workspaceRoot)}`}
        type="button"
      >
        {rowContent}
      </button>
    );
  }

  return <div className="rounded-lg px-1 py-1">{rowContent}</div>;
});
