import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { ChevronRightIcon, Clock3Icon } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import type { ChatActivityPresentation } from "./chatActivity";
import { Spinner } from "../ui/spinner";
import { cn } from "~/lib/utils";
import { formatDuration } from "~/session-logic";

export function ComposerActivityStatus({
  activity,
  turnStartedAt,
  onOpenTasks,
}: {
  activity: ChatActivityPresentation;
  turnStartedAt?: string | null | undefined;
  onOpenTasks: () => void;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const elapsedId = useId();
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
  // Timing is display-only and already scoped by the caller to an active root
  // or local dispatch. Never turn a timestamp into evidence of running work.
  // Clamp host-clock skew without creating negative durations or using the
  // latest command's timestamp as a replacement for the whole-turn interval.
  useEffect(() => {
    if (!revealed || !elapsedElement) return;
    const update = () => {
      elapsedElement.textContent = uiPresentation.formatDuration(
        Math.max(0, Date.now() - startedMs),
      );
    };
    // Update only this text node, not the streaming composer React subtree.
    // Hover/focus exit, hidden documents, a new turn and unmount all retire the
    // sole interval. Restoring visibility catches up from the same start edge.
    let interval: ReturnType<typeof setInterval> | undefined;
    const synchronizeVisibility = () => {
      clearInterval(interval);
      interval = undefined;
      if (document.visibilityState === "hidden") return;
      update();
      interval = setInterval(update, 1_000);
    };
    synchronizeVisibility();
    document.addEventListener("visibilitychange", synchronizeVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", synchronizeVisibility);
    };
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
            <span className="min-w-0 overflow-hidden">
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
    "aria-describedby": revealed ? elapsedId : undefined,
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
