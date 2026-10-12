import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { ChevronRightIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { formatDuration, formatElapsed, type WorkLogEntry } from "../../session-logic";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
      return uiText("Waiting");
    case "active":
      return uiText("Working");
    case "failed":
      return uiText("Failed");
    case "stopped":
      return uiText("Stopped");
    case "unknown":
      return uiText("Status unavailable");
    default:
      return uiText("Done");
  }
}

/**
 * Canonical English caveat for callers comparing raw evidence. Keep ordinary
 * apostrophes here: ICU source escaping belongs only to the display formatter.
 */
export const SUBAGENT_STATUS_UNAVAILABLE_DETAIL =
  "Cafe can't confirm whether this subagent is still running. Its saved summary is shown as last reported.";
export function getSUBAGENT_STATUS_UNAVAILABLE_DETAIL() {
  return uiText(
    "Cafe can''t confirm whether this subagent is still running. Its saved summary is shown as last reported.",
  );
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
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => (props.paused ? undefined : subscribeLiveSubagentClock(setNow)), [props.paused]);
  const timestamp = Date.parse(props.startedAt);
  const elapsed = Number.isNaN(timestamp)
    ? ""
    : uiPresentation.formatDuration(Math.max(0, now - timestamp));
  return elapsed ? (
    <p
      className="mt-0.5 font-mono text-2xs text-subtle-foreground"
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const { subagent } = props.entry;
  const status = uiPresentation.subagentStatusLabel(subagent.status);
  const live = isLiveSubagentStatus(subagent.status);
  const terminalElapsed =
    subagent.status !== "unknown" && subagent.completedAt
      ? uiPresentation.formatElapsed(subagent.startedAt, subagent.completedAt)
      : null;
  const primaryDescription =
    subagent.description ??
    subagent.objective ??
    uiPresentation.subagentStatusLabel(subagent.status);
  const objectiveDescription =
    subagent.objective &&
    subagent.description &&
    subagent.objective.toLocaleLowerCase() !== subagent.description.toLocaleLowerCase() &&
    !/^working(?:\.{3})?$/iu.test(subagent.objective)
      ? subagent.objective
      : null;

  const unknownStatus = subagent.status === "unknown";
  const tooltip =
    objectiveDescription || unknownStatus ? (
      <>
        {objectiveDescription ? <p className="break-words">{objectiveDescription}</p> : null}
        {unknownStatus ? (
          <p className={cn(objectiveDescription && "mt-1 text-muted-foreground")}>
            {uiPresentation.getSUBAGENT_STATUS_UNAVAILABLE_DETAIL()}
          </p>
        ) : null}
      </>
    ) : null;

  // One line of description/progress stays visible without hover; the
  // original objective (when it differs) moves to the row tooltip, which also
  // opens on keyboard focus, and remains in full on the detail screen.
  const row = (
    <button
      type="button"
      className={cn(
        "grid min-h-11 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg text-left transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        props.compact ? "px-1.5 py-1.5" : "px-1 py-2",
      )}
      data-subagent-roster-row="true"
      data-subagent-work-row="true"
      aria-label={uiText(
        "{value0}, {value1}. {value2}. Open details",
        {
          value0: subagent.label,
          value1: status,
          value2: primaryDescription,
        },
        undefined,
        uiLocale,
      )}
      onClick={(event) => props.onOpen(props.entry, event.currentTarget)}
    >
      <SubagentAvatar
        seed={subagent.id}
        className={props.compact ? "size-7" : "size-7 sm:size-8"}
      />
      <div className="min-w-0 pt-0.5">
        <p className="truncate text-xs leading-4 font-medium text-foreground">{subagent.label}</p>
        <p
          className="mt-0.5 truncate text-2xs text-muted-foreground"
          data-subagent-description="true"
        >
          {primaryDescription}
        </p>
      </div>
      <div className="flex shrink-0 items-start gap-1 pt-0.5">
        <div className="min-w-14 text-right tabular-nums">
          <p className="text-2xs text-muted-foreground" data-subagent-status="true">
            {status}
          </p>
          {live ? (
            <LiveSubagentElapsed startedAt={subagent.startedAt} paused={props.paused ?? false} />
          ) : terminalElapsed ? (
            <p
              className="mt-0.5 font-mono text-2xs text-subtle-foreground"
              data-subagent-terminal-elapsed="true"
            >
              {terminalElapsed}
            </p>
          ) : null}
        </div>
        <ChevronRightIcon className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground" />
      </div>
    </button>
  );

  if (!tooltip) return row;
  return (
    <Tooltip>
      <TooltipTrigger delay={300} render={row} />
      <TooltipPopup side="top" align="start" className="max-w-80 text-pretty">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
});

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  formatDuration,
  formatElapsed,
  getSUBAGENT_STATUS_UNAVAILABLE_DETAIL,
  subagentStatusLabel,
};
