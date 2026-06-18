import type { ThreadId, TurnId } from "@cafecode/contracts";

export interface TimelineScrollDebugListState {
  readonly isAtEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

export interface TimelineScrollDebugMetrics {
  readonly isAtEnd: boolean | null;
  readonly contentLength: number | null;
  readonly scroll: number | null;
  readonly scrollLength: number | null;
  readonly remainingScrollDistance: number | null;
  readonly rowCount: number;
  readonly autoFollowTail: boolean;
  readonly stickToEndRevision: number;
  readonly submitStickDeadlineRemainingMs: number | null;
}

export interface TimelineScrollDebugEventInput {
  readonly source: "ChatView" | "MessagesTimeline";
  readonly reason: string;
  readonly activeThreadId: ThreadId | string | null;
  readonly activeTurnId: TurnId | string | null;
  readonly metrics?: TimelineScrollDebugMetrics | null;
  readonly details?: Record<string, unknown>;
}

export interface TimelineScrollDebugEvent extends TimelineScrollDebugEventInput {
  readonly sequence: number;
  readonly capturedAt: string;
}

export interface TimelineScrollDebugSnapshot {
  readonly state: {
    readonly isAtEnd: boolean;
    readonly userScrollIntentSinceReset: boolean;
    readonly autoFollowTail: boolean;
    readonly showScrollToBottom: boolean;
    readonly stickToEndRevision: number;
  };
  readonly currentListMetrics: TimelineScrollDebugMetrics | null;
  readonly latest: TimelineScrollDebugEvent | null;
  readonly recent: ReadonlyArray<TimelineScrollDebugEvent>;
}

export function summarizeTimelineScrollMetrics(input: {
  readonly state: TimelineScrollDebugListState | null | undefined;
  readonly rowCount: number;
  readonly autoFollowTail: boolean;
  readonly stickToEndRevision: number;
  readonly submitStickDeadlineMs?: number;
  readonly nowMs?: number;
}): TimelineScrollDebugMetrics {
  const state = input.state;
  const contentLength = readFiniteNumber(state?.contentLength);
  const scroll = readFiniteNumber(state?.scroll);
  const scrollLength = readFiniteNumber(state?.scrollLength);
  const remainingScrollDistance =
    contentLength === null || scroll === null || scrollLength === null
      ? null
      : Math.max(0, contentLength - scroll - scrollLength);
  const submitStickDeadlineMs = input.submitStickDeadlineMs ?? 0;
  const nowMs = input.nowMs ?? Date.now();

  return {
    isAtEnd: typeof state?.isAtEnd === "boolean" ? state.isAtEnd : null,
    contentLength,
    scroll,
    scrollLength,
    remainingScrollDistance,
    rowCount: input.rowCount,
    autoFollowTail: input.autoFollowTail,
    stickToEndRevision: input.stickToEndRevision,
    submitStickDeadlineRemainingMs:
      submitStickDeadlineMs > nowMs ? Math.round(submitStickDeadlineMs - nowMs) : null,
  };
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
