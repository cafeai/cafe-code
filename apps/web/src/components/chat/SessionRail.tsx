import type { ServerProviderAccountRateLimits } from "@cafecode/contracts";
import { PanelBottomIcon, PanelRightIcon } from "lucide-react";
import { forwardRef, memo } from "react";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import type { WorkLogEntry } from "../../session-logic";
import { type SubagentRosterEntry } from "../subagents/SubagentRosterRow";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { ContextWindowDetails } from "./ContextWindowDetails";
import { TaskProgressDetails } from "./TaskProgressDetails";
import {
  deriveTaskProgressPresentation,
  type ComposerTaskProgressPlan,
} from "./taskProgressPresentation";

export function SessionPlacementButton(props: {
  readonly placement: "side" | "composer";
  readonly onClick: () => void;
}) {
  const label = props.placement === "side" ? "Show on the side" : "Show in composer";
  const Icon = props.placement === "side" ? PanelRightIcon : PanelBottomIcon;

  return (
    <Button
      size="icon-xs"
      variant="ghost"
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onClick();
      }}
      aria-label={label}
      title={label}
      data-session-rail-dock={props.placement === "side" ? "true" : undefined}
      data-session-rail-undock={props.placement === "composer" ? "true" : undefined}
      className="text-muted-foreground/50 hover:text-foreground/70"
    >
      <Icon className="size-3.5" />
    </Button>
  );
}

interface SessionRailProps {
  readonly plan: ComposerTaskProgressPlan | null | undefined;
  readonly subagents?: ReadonlyArray<WorkLogEntry>;
  readonly onOpenSubagentDetail?:
    | ((workEntry: WorkLogEntry, trigger: HTMLButtonElement) => void)
    | undefined;
  readonly usage: ContextWindowSnapshot | null;
  readonly rateLimits?: ServerProviderAccountRateLimits | null | undefined;
  readonly onShowInComposer: () => void;
  readonly className?: string;
}

export const SessionRail = memo(
  forwardRef<HTMLDivElement, SessionRailProps>(function SessionRail(props, ref) {
    const plan = props.plan;
    const hasPlan = Boolean(plan && plan.steps.length > 0);
    const subagents = (props.subagents ?? []).filter(
      (entry): entry is SubagentRosterEntry => entry.subagent !== undefined,
    );
    const hasSubagents = subagents.length > 0;
    const { completedCount } = plan ? deriveTaskProgressPresentation(plan) : { completedCount: 0 };
    const total = plan?.steps.length ?? 0;

    return (
      <div
        ref={ref}
        tabIndex={-1}
        data-session-rail="true"
        className={cn("flex min-h-0 w-full flex-1 flex-col outline-none", props.className)}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="text-sm font-medium leading-5">Tasks</h2>
            {hasPlan || hasSubagents ? (
              <span className="shrink-0 text-muted-foreground text-xs">
                {hasPlan ? `${completedCount} of ${total} completed` : null}
                {hasPlan && hasSubagents ? " · " : null}
                {hasSubagents ? `${subagents.length} active` : null}
              </span>
            ) : null}
          </div>
          <SessionPlacementButton placement="composer" onClick={props.onShowInComposer} />
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div
            aria-label="Task details"
            className="p-3"
            data-session-rail-tasks="true"
            data-task-list-scroll="true"
          >
            {hasPlan || hasSubagents ? (
              <TaskProgressDetails
                plan={plan}
                subagents={subagents}
                onOpenSubagentDetail={props.onOpenSubagentDetail}
              />
            ) : (
              <p className="text-[13px] text-muted-foreground/40">No tasks yet.</p>
            )}
          </div>
        </ScrollArea>

        <div
          className="shrink-0 border-t border-border/60 px-3 py-3"
          data-session-rail-usage="true"
        >
          <ContextWindowDetails usage={props.usage} rateLimits={props.rateLimits} layout="panel" />
        </div>
      </div>
    );
  }),
);
