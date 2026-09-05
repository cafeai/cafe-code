import { BotIcon } from "lucide-react";
import { memo, useRef, useState } from "react";

import type { WorkLogEntry } from "../../session-logic";
import { type SubagentRosterEntry } from "../subagents/SubagentRosterRow";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SessionPlacementButton } from "./SessionRail";
import { TaskProgressDetails } from "./TaskProgressDetails";
import {
  deriveTaskProgressPresentation,
  type ComposerTaskProgressPlan,
} from "./taskProgressPresentation";

export type {
  ComposerTaskProgressPlan,
  ComposerTaskProgressStepStatus,
} from "./taskProgressPresentation";

/**
 * Compact task progress for the composer footer. The trigger intentionally uses
 * Base UI's unified hover/press interaction model: mouse users can inspect the
 * list without clicking, while touch users press and keyboard users focus the
 * native button before activating it with Enter or Space.
 *
 * When the optional session rail is docked, this control is hidden so the
 * checklist is not shown twice.
 */
export const ComposerTaskProgress = memo(function ComposerTaskProgress(props: {
  readonly plan: ComposerTaskProgressPlan | null | undefined;
  readonly subagents?: ReadonlyArray<WorkLogEntry>;
  readonly onOpenSubagentDetail?:
    | ((workEntry: WorkLogEntry, trigger: HTMLButtonElement) => void)
    | undefined;
  readonly sessionRailVisible?: boolean;
  readonly onShowOnSide?: () => void;
}) {
  const { plan } = props;
  const [open, setOpen] = useState(false);
  const openModeRef = useRef<"hover" | "press" | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const subagents = (props.subagents ?? []).filter(
    (entry): entry is SubagentRosterEntry => entry.subagent !== undefined,
  );
  const hasPlan = Boolean(plan && plan.steps.length > 0);
  const hasSubagents = subagents.length > 0;
  if (props.sessionRailVisible || (!hasPlan && !hasSubagents)) return null;

  const handleOpenChange = (nextOpen: boolean, details: { readonly reason: string }) => {
    if (details.reason === "trigger-press") {
      // Pointer entry/focus can open the preview immediately before the same
      // user's click/Enter is delivered. Treat that first press as pinning the
      // preview instead of toggling it closed; a later press still toggles it.
      if (!nextOpen && openModeRef.current === "hover") {
        openModeRef.current = "press";
        setOpen(true);
        return;
      }
      openModeRef.current = nextOpen ? "press" : null;
      setOpen(nextOpen);
      return;
    }
    if (details.reason === "trigger-hover" || details.reason === "trigger-focus") {
      // Once pinned by click/tap/keyboard, leaving the hover corridor or moving
      // focus into the scroll region must not close the popover.
      if (!nextOpen && openModeRef.current === "press") return;
      openModeRef.current = nextOpen ? "hover" : null;
      setOpen(nextOpen);
      return;
    }
    if (!nextOpen) openModeRef.current = null;
    setOpen(nextOpen);
  };

  const total = plan?.steps.length ?? 0;
  const { completedCount, currentIndex } = plan
    ? deriveTaskProgressPresentation(plan)
    : { completedCount: 0, currentIndex: 0 };
  const completionPercentage = total > 0 ? (completedCount / total) * 100 : 0;
  const liveLabel = hasPlan
    ? `Task progress: step ${currentIndex} of ${total}${hasSubagents ? `, ${subagents.length} active ${subagents.length === 1 ? "subagent" : "subagents"}` : ""}`
    : `${subagents.length} active ${subagents.length === 1 ? "subagent" : "subagents"}`;

  const triggerContent = (
    <>
      {hasPlan ? (
        <span className="relative size-3 shrink-0" aria-hidden="true">
          <svg className="-rotate-90 size-full" viewBox="0 0 12 12">
            <circle
              cx="6"
              cy="6"
              r="4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="opacity-20"
            />
            <circle
              cx="6"
              cy="6"
              r="4.5"
              fill="none"
              pathLength="100"
              stroke="currentColor"
              strokeDasharray="100"
              strokeDashoffset={100 - completionPercentage}
              strokeLinecap="round"
              strokeWidth="2"
              className="transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none"
              data-completed={completedCount}
              data-task-progress-ring="true"
              data-total={total}
            />
          </svg>
        </span>
      ) : (
        <BotIcon className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span aria-live="polite">
        {hasPlan ? `Step ${currentIndex} / ${total}` : null}
        {hasPlan && hasSubagents ? " · " : null}
        {hasSubagents ? `${subagents.length} ${subagents.length === 1 ? "agent" : "agents"}` : null}
      </span>
    </>
  );

  const triggerClassName =
    "h-6 shrink-0 gap-1.5 rounded-full border-border/60 bg-muted/35 px-2 text-muted-foreground text-xs before:rounded-full hover:bg-muted/60 hover:text-foreground";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        openOnHover
        delay={0}
        closeDelay={100}
        render={
          <Button
            ref={triggerRef}
            type="button"
            size="xs"
            variant="ghost"
            className={triggerClassName}
            aria-label={`${liveLabel}. Show task list`}
            data-composer-task-progress="true"
            data-composer-task-progress-trigger="true"
          />
        }
      >
        {triggerContent}
      </PopoverTrigger>

      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        collisionAvoidance={{ fallbackAxisSide: "none" }}
        initialFocus={false}
        className="w-[min(22rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] p-0"
        viewportClassName="overflow-y-hidden p-0 [--viewport-inline-padding:0] not-data-transitioning:overflow-y-hidden"
        data-composer-task-progress-popup="true"
      >
        {/* Base UI temporarily assigns `--available-height: max-content` while
            measuring animated popovers. Combining that intrinsic keyword with
            CSS `min()` invalidates max-height and makes a long task history
            measure at its full natural height. Floating UI then abandons the
            requested top/bottom axis and can strand the popup at the viewport
            edge. Keep measurement bounded by the dynamic viewport. The extra
            rem below the usual page gutter reserves the trigger gap and
            collision clearance that Base UI removes from the final viewport;
            without it, Linux Chromium can leave the last task row clipped by
            the outer popover even though the inner list itself scrolls. */}
        <div className="flex max-h-[min(28rem,calc(100dvh-3rem))] min-h-0 w-full flex-col">
          <div className="shrink-0 border-border/70 border-b px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <PopoverTitle className="text-sm leading-5">Tasks</PopoverTitle>
              <div className="flex shrink-0 items-center gap-1">
                <span className="text-muted-foreground text-xs">
                  {hasPlan ? `${completedCount} of ${total} completed` : null}
                  {hasPlan && hasSubagents ? " · " : null}
                  {hasSubagents ? `${subagents.length} active` : null}
                </span>
                {props.onShowOnSide ? (
                  <SessionPlacementButton placement="side" onClick={props.onShowOnSide} />
                ) : null}
              </div>
            </div>
          </div>

          <div
            aria-label="Task details"
            className="min-h-0 overflow-y-auto overscroll-contain px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            data-task-list-scroll="true"
            role="region"
            tabIndex={0}
          >
            <TaskProgressDetails
              plan={plan}
              subagents={subagents}
              onOpenSubagentDetail={(selectedEntry, rowTrigger) => {
                openModeRef.current = null;
                setOpen(false);
                props.onOpenSubagentDetail?.(selectedEntry, triggerRef.current ?? rowTrigger);
              }}
            />
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
