import { uiText } from "@cafecode/shared/i18n";
import { ChevronRightIcon, Clock3Icon } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { useUiLocale, useUiPresentation } from "~/i18n";
import { formatTokensPerSecond, type GenerationRate } from "~/lib/generationRate";
import { cn } from "~/lib/utils";
import { formatDuration } from "~/session-logic";
import { Spinner } from "../ui/spinner";
import type { ChatActivityPresentation } from "./chatActivity";
import { startElapsedTimeTicker } from "./elapsedTimeTicker";

export function ComposerActivityStatus({
  activity,
  turnStartedAt,
  generationRate,
  onOpenTasks,
}: {
  activity: ChatActivityPresentation;
  turnStartedAt?: string | null | undefined;
  /**
   * Measured output speed for this turn, shown beside the elapsed time. It
   * changes only when a response reports usage, so it is plain React state
   * rather than part of the per-second text-node ticker below.
   */
  generationRate?: GenerationRate | null | undefined;
  onOpenTasks: () => void;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const elapsedId = useId();
  const rateId = useId();
  // Observe the committed text node itself: inspectability can replace the
  // surrounding DOM without changing the start or retained pointer hover.
  // Node replacement renders once; ticking never publishes React state.
  const [elapsedElement, setElapsedElement] = useState<HTMLSpanElement | null>(null);
  // Task inspectability can replace a focused button with a plain status. DOM
  // removal does not promise blur, so reconcile focus on the committed
  // replacement. Hover belongs to a stable outer surface, not that node: a
  // newly attached element has not yet received browser :hover hit testing.
  const observeStatus = useCallback((element: HTMLElement | null) => {
    setFocused(element !== null && element === document.activeElement);
  }, []);
  const startedMs = turnStartedAt ? Date.parse(turnStartedAt) : Number.NaN;
  const hasTiming = Number.isFinite(startedMs);
  const revealed = hasTiming && (hovered || focused);
  const rate = generationRate ? formatTokensPerSecond(generationRate) : null;
  // Timing is display-only and already scoped by the caller to an active root
  // or local dispatch. Never turn a timestamp into evidence of running work.
  // Clamp host-clock skew without creating negative durations or using the
  // latest command's timestamp as a replacement for the whole-turn interval.
  useEffect(() => {
    if (!revealed || !elapsedElement) return;
    return startElapsedTimeTicker({
      startedMs,
      publish: (elapsedMs) => {
        elapsedElement.textContent = uiPresentation.formatDuration(elapsedMs);
      },
      visibility: document,
    });
  }, [revealed, startedMs, elapsedElement]);
  const content = (
    <>
      {activity.attention ? (
        <Clock3Icon className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Spinner
          className="size-3.5 shrink-0 motion-reduce:animate-none"
          strokeWidth={2.5}
          aria-hidden="true"
        />
      )}
      <span className="flex min-w-0 items-center">
        <span role="status" aria-live="polite" aria-atomic="true" className="min-w-0 truncate">
          {activity.label}
        </span>
        {hasTiming ? (
          <span
            className={cn(
              "grid shrink-0 transition-[grid-template-columns,opacity] duration-(--duration-base) ease-out motion-reduce:transition-none",
              revealed ? "grid-cols-[1fr] opacity-100" : "grid-cols-[0fr] opacity-0",
            )}
            aria-hidden={!revealed}
            data-activity-elapsed-revealed={revealed}
          >
            <span className="flex min-w-0 overflow-hidden">
              <span
                role="timer"
                aria-label={uiText("Elapsed turn time", undefined, undefined, uiLocale)}
                aria-live="off"
                className="block whitespace-nowrap pl-2 text-subtle-foreground tabular-nums"
              >
                <span aria-hidden="true">· </span>
                <span id={elapsedId}>
                  <span className="sr-only">
                    {uiText("Elapsed turn time: ", undefined, undefined, uiLocale)}
                  </span>
                  {/* The hidden initial node is deterministic; the reveal
                      effect publishes the current elapsed value immediately. */}
                  <span ref={setElapsedElement}>{uiPresentation.formatDuration(0)}</span>
                </span>
              </span>
              {rate !== null ? (
                <span
                  className="block whitespace-nowrap pl-2 text-subtle-foreground tabular-nums"
                  data-activity-generation-rate="true"
                >
                  <span aria-hidden="true">· </span>
                  <span aria-hidden="true">
                    {uiText("{rate} tok/s", { rate }, undefined, uiLocale)}
                  </span>
                  <span id={rateId} className="sr-only">
                    {uiText(
                      "Generation speed: {rate} tokens per second",
                      { rate },
                      undefined,
                      uiLocale,
                    )}
                  </span>
                </span>
              ) : null}
            </span>
          </span>
        ) : null}
      </span>
      {activity.canInspect ? (
        <ChevronRightIcon className="size-3 shrink-0" aria-hidden="true" />
      ) : null}
    </>
  );
  const className = cn(
    "flex min-w-0 max-w-full items-center gap-2 px-1 py-1 text-xs focus-ring rounded-sm",
    activity.attention ? "text-status-attention-foreground" : "text-muted-foreground",
  );
  const revealProps = {
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    "aria-describedby": revealed
      ? rate !== null
        ? `${elapsedId} ${rateId}`
        : elapsedId
      : undefined,
  };
  return (
    <div
      className="flex w-fit min-w-0 max-w-full"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {activity.canInspect ? (
        <button
          ref={observeStatus}
          {...revealProps}
          data-composer-activity-status="true"
          type="button"
          onClick={onOpenTasks}
          className={cn(className, "hover:text-foreground")}
          aria-label={uiText(
            "{value0}. Show tasks",
            { value0: activity.label },
            undefined,
            uiLocale,
          )}
        >
          {content}
        </button>
      ) : (
        // A non-actionable status can still reveal its timing to keyboard users;
        // do not invent a button/action when no exact task controls are available.
        <div
          ref={observeStatus}
          {...revealProps}
          data-composer-activity-status="true"
          tabIndex={hasTiming ? 0 : undefined}
          className={className}
        >
          {content}
        </div>
      )}
    </div>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { formatDuration };
