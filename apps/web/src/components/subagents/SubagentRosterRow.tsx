import { ChevronRightIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { formatDuration, formatElapsed, type WorkLogEntry } from "../../session-logic";
import { cn } from "~/lib/utils";
import { SubagentAvatar } from "./SubagentAvatar";

export type SubagentRosterEntry = WorkLogEntry & {
  readonly subagent: NonNullable<WorkLogEntry["subagent"]>;
};

export function isLiveSubagentStatus(status: SubagentRosterEntry["subagent"]["status"]): boolean {
  return status === "active" || status === "waiting";
}

export function subagentStatusLabel(status: SubagentRosterEntry["subagent"]["status"]): string {
  switch (status) {
    case "waiting":
      return "Waiting";
    case "active":
      return "Working";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    default:
      return "Done";
  }
}

const LIVE_SUBAGENT_CLOCK_INTERVAL_MS = 1_000;
type LiveSubagentClockListener = (now: number) => void;
const liveSubagentClockListeners = new Set<LiveSubagentClockListener>();
let liveSubagentClockInterval: number | null = null;

function stopLiveSubagentClock(): void {
  if (liveSubagentClockInterval === null) return;
  window.clearInterval(liveSubagentClockInterval);
  liveSubagentClockInterval = null;
}

function emitLiveSubagentClockTick(): void {
  const now = Date.now();
  for (const listener of liveSubagentClockListeners) listener(now);
}

/**
 * Every visible roster shares one document-aware timer. A long conversation
 * can retain hundreds of completed workers, so completed rows never subscribe,
 * and a background tab owns no interval at all.
 */
function reconcileLiveSubagentClock(): void {
  if (liveSubagentClockListeners.size === 0 || document.visibilityState !== "visible") {
    stopLiveSubagentClock();
    return;
  }
  if (liveSubagentClockInterval !== null) return;
  emitLiveSubagentClockTick();
  liveSubagentClockInterval = window.setInterval(
    emitLiveSubagentClockTick,
    LIVE_SUBAGENT_CLOCK_INTERVAL_MS,
  );
}

function subscribeLiveSubagentClock(listener: LiveSubagentClockListener): () => void {
  liveSubagentClockListeners.add(listener);
  if (liveSubagentClockListeners.size === 1) {
    document.addEventListener("visibilitychange", reconcileLiveSubagentClock);
  }
  reconcileLiveSubagentClock();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    liveSubagentClockListeners.delete(listener);
    if (liveSubagentClockListeners.size === 0) {
      document.removeEventListener("visibilitychange", reconcileLiveSubagentClock);
      stopLiveSubagentClock();
    }
  };
}

const LiveSubagentElapsed = memo(function LiveSubagentElapsed(props: {
  readonly startedAt: string;
  readonly paused: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => (props.paused ? undefined : subscribeLiveSubagentClock(setNow)), [props.paused]);
  const timestamp = Date.parse(props.startedAt);
  const elapsed = Number.isNaN(timestamp) ? "" : formatDuration(Math.max(0, now - timestamp));
  return elapsed ? (
    <p
      className="mt-0.5 font-mono text-[10px] text-muted-foreground/65"
      data-subagent-live-elapsed="true"
    >
      {elapsed}
    </p>
  ) : null;
});

/**
 * Shared semantic worker row used by the conversation roster and the
 * composer Tasks popover. Provider-native ids remain opaque and are used only
 * as avatar/detail-routing seeds; all visible copy is the bounded presentation
 * text produced by the session projection.
 */
export const SubagentRosterRow = memo(function SubagentRosterRow(props: {
  readonly entry: SubagentRosterEntry;
  readonly paused?: boolean;
  readonly compact?: boolean;
  readonly onOpen: (entry: SubagentRosterEntry, trigger: HTMLButtonElement) => void;
}) {
  const { subagent } = props.entry;
  const status = subagentStatusLabel(subagent.status);
  const live = isLiveSubagentStatus(subagent.status);
  const terminalElapsed = subagent.completedAt
    ? formatElapsed(subagent.startedAt, subagent.completedAt)
    : null;
  const primaryDescription =
    subagent.description ??
    subagent.objective ??
    (subagent.status === "waiting" ? "Waiting" : "Working");
  const objectiveDescription =
    subagent.objective &&
    subagent.description &&
    subagent.objective.toLocaleLowerCase() !== subagent.description.toLocaleLowerCase() &&
    !/^working(?:\.{3})?$/iu.test(subagent.objective)
      ? subagent.objective
      : null;

  return (
    <button
      type="button"
      className={cn(
        "grid min-h-11 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg text-left transition-colors hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        props.compact ? "px-1.5 py-1.5" : "px-1 py-2",
      )}
      data-subagent-roster-row="true"
      data-subagent-work-row="true"
      aria-label={`${subagent.label}, ${status}. ${primaryDescription}. Open details`}
      onClick={(event) => props.onOpen(props.entry, event.currentTarget)}
    >
      <SubagentAvatar
        seed={subagent.id}
        className={props.compact ? "size-7" : "size-7 sm:size-8"}
      />
      <div className="min-w-0 pt-0.5">
        <p className="truncate text-xs leading-4 font-medium text-foreground/90">
          {subagent.label}
        </p>
        <p
          className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground/70 break-words"
          data-subagent-description="true"
        >
          {primaryDescription}
        </p>
        {objectiveDescription ? (
          <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground/50 break-words">
            {objectiveDescription}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-start gap-1 pt-0.5">
        <div className="min-w-14 text-right tabular-nums">
          <p className="text-[9px] uppercase tracking-[0.08em] text-muted-foreground/55">
            {status}
          </p>
          {live ? (
            <LiveSubagentElapsed startedAt={subagent.startedAt} paused={props.paused ?? false} />
          ) : terminalElapsed ? (
            <p
              className="mt-0.5 font-mono text-[10px] text-muted-foreground/55"
              data-subagent-terminal-elapsed="true"
            >
              {terminalElapsed}
            </p>
          ) : null}
        </div>
        <ChevronRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/35" />
      </div>
    </button>
  );
});
