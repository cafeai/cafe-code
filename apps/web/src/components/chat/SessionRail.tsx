import type { ServerProviderAccountRateLimits } from "@cafecode/contracts";
import { PanelBottomIcon, PanelRightIcon } from "lucide-react";
import { forwardRef, memo, type ReactNode } from "react";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import type { WorkLogEntry } from "../../session-logic";
import { isLiveSubagentStatus, type SubagentRosterEntry } from "../subagents/SubagentRosterRow";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { ContextWindowDetails } from "./ContextWindowDetails";
import type { SubagentConcurrencyPresentation } from "../../subagentConcurrency";
import { TaskProgressDetails } from "./TaskProgressDetails";
import { ScheduledFollowups, type ScheduledFollowupsContext } from "./ScheduledFollowups";
import {
  ProviderTasks,
  deriveActiveProviderTasks,
  type ProviderTasksContext,
} from "./ProviderTasks";
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
      className="text-subtle-foreground hover:text-foreground"
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
  readonly usageResetAction?: ReactNode;
  readonly subagentConcurrency?: SubagentConcurrencyPresentation | null;
  readonly onShowInComposer: () => void;
  readonly scheduledFollowups?: ScheduledFollowupsContext | undefined;
  readonly providerTasks?: ProviderTasksContext | undefined;
  readonly className?: string;
}

export const SessionRail = memo(
  forwardRef<HTMLDivElement, SessionRailProps>(function SessionRail(props, ref) {
    const plan = props.plan;
    const hasPlan = Boolean(plan && plan.steps.length > 0);
    const subagents = (props.subagents ?? []).filter(
      (entry): entry is SubagentRosterEntry =>
        entry.subagent !== undefined && isLiveSubagentStatus(entry.subagent.status),
    );
    const hasSubagents = subagents.length > 0;
    const hasProviderTasks =
      props.providerTasks && deriveActiveProviderTasks(props.providerTasks).length > 0;
    const { completedCount } = plan ? deriveTaskProgressPresentation(plan) : { completedCount: 0 };
    const total = plan?.steps.length ?? 0;

    return (
      <div
        ref={ref}
        tabIndex={-1}
        data-session-rail="true"
        className={cn(
          // Docking slides the rail in from its edge (docs/style-guide.md §8).
          "flex min-h-0 w-full flex-1 animate-enter-from-end flex-col outline-none",
          props.className,
        )}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle px-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="text-sm font-medium leading-5">Tasks</h2>
            {hasPlan || hasSubagents ? (
              <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
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
            {props.providerTasks ? <ProviderTasks context={props.providerTasks} /> : null}
            {hasPlan || hasSubagents ? (
              <TaskProgressDetails
                plan={plan}
                subagents={subagents}
                onOpenSubagentDetail={props.onOpenSubagentDetail}
              />
            ) : !hasProviderTasks ? (
              <p className="text-ui text-subtle-foreground">No tasks yet.</p>
            ) : null}
            {props.scheduledFollowups ? (
              <ScheduledFollowups
                key={`${props.scheduledFollowups.environmentId}:${props.scheduledFollowups.threadId}:${props.scheduledFollowups.modelSelection.instanceId}`}
                context={props.scheduledFollowups}
              />
            ) : null}
          </div>
        </ScrollArea>

        {/* Reserve part of this rail's actual allocation for its header/tasks,
            even when a plan shares the side column. The min-height flex chain
            shrinks only the quota list; reset availability stays below it. */}
        <div
          className="flex max-h-[70%] min-h-0 shrink-0 flex-col border-t border-border-subtle px-3 py-3"
          data-session-rail-usage="true"
        >
          <ContextWindowDetails
            usage={props.usage}
            rateLimits={props.rateLimits}
            usageResetAction={props.usageResetAction}
            layout="panel"
            subagentConcurrency={props.subagentConcurrency}
          />
        </div>
      </div>
    );
  }),
);
