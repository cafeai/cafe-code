import type { ServerProviderAccountRateLimits } from "@cafecode/contracts";
import { PanelBottomIcon, PanelRightIcon, SquareIcon } from "lucide-react";
import { forwardRef, memo, useEffect, useState, type ReactNode } from "react";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import type { WorkLogEntry } from "../../session-logic";
import { isLiveSubagentStatus, type SubagentRosterEntry } from "../subagents/SubagentRosterRow";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { ContextWindowDetails } from "./ContextWindowDetails";
import { useProviderQuota, type ProviderQuotaContext } from "./useProviderQuota";
import type { SubagentConcurrencyPresentation } from "../../subagentConcurrency";
import { codexRecoveryLabel, type CodexRecoveryPresentation } from "../../codexRecovery";
import { TaskProgressDetails } from "./TaskProgressDetails";
import { ScheduledFollowups, type ScheduledFollowupsContext } from "./ScheduledFollowups";
import { ProviderTasks, hasProviderTaskContent, type ProviderTasksContext } from "./ProviderTasks";
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

/**
 * The failed root and still-live children are deliberately separate facts. This
 * compact notice is shared by the Tasks rail and undocked composer. Its clock
 * renders only a received server deadline; reaching zero does not claim that a
 * retry started. Stop is a separate explicit action, so typing/sending a new
 * instruction remains available while the parent is terminal.
 */
export function CodexRecoveryNotice(props: {
  readonly presentation: CodexRecoveryPresentation;
  readonly onStop: () => void;
  readonly disabled?: boolean | undefined;
}) {
  const [nowMs, setNowMs] = useState(Date.now);
  const retryAtMs = props.presentation.retryAtMs;
  useEffect(() => {
    setNowMs(Date.now());
    if (retryAtMs === null || retryAtMs <= Date.now()) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (now >= retryAtMs) window.clearInterval(timer);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [retryAtMs]);
  const label = codexRecoveryLabel(props.presentation, nowMs);
  const count = props.presentation.activeAgentCount;

  return (
    <div
      data-codex-recovery-notice="true"
      className="flex min-w-0 items-center gap-2 rounded-lg border border-border-subtle bg-raised/60 px-3 py-2"
    >
      <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground" role="status">
        <span className="font-medium text-foreground">Root failed</span>
        {label ? <span> · {label}</span> : null}
        {count > 0 ? (
          <span>
            {" "}
            · {count} {count === 1 ? "agent active" : "agents active"}
          </span>
        ) : null}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
        disabled={props.disabled}
        onClick={props.onStop}
        aria-label="Stop recovery and running agents"
        title="Stop pending recovery and all running agents in this chat"
      >
        <SquareIcon aria-hidden="true" className="size-3" />
        Stop
      </Button>
    </div>
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
  readonly quotaContext?: ProviderQuotaContext | undefined;
  readonly usageResetAction?: ReactNode;
  readonly subagentConcurrency?: SubagentConcurrencyPresentation | null;
  readonly onShowInComposer: () => void;
  readonly scheduledFollowups?: ScheduledFollowupsContext | undefined;
  readonly providerTasks?: ProviderTasksContext | undefined;
  readonly codexRecovery?: CodexRecoveryPresentation | null | undefined;
  readonly onStopCodexRecovery?: (() => void) | undefined;
  readonly codexRecoveryStopDisabled?: boolean;
  readonly className?: string;
}

export const SessionRail = memo(
  forwardRef<HTMLDivElement, SessionRailProps>(function SessionRail(props, ref) {
    const sessionQuota = useProviderQuota(props.quotaContext, true);
    const plan = props.plan;
    const hasPlan = Boolean(plan && plan.steps.length > 0);
    const subagents = (props.subagents ?? []).filter(
      (entry): entry is SubagentRosterEntry =>
        entry.subagent !== undefined && isLiveSubagentStatus(entry.subagent.status),
    );
    const hasSubagents = subagents.length > 0;
    const hasProviderTasks = props.providerTasks && hasProviderTaskContent(props.providerTasks);
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
            {props.codexRecovery && props.onStopCodexRecovery ? (
              <div className="mb-3">
                <CodexRecoveryNotice
                  presentation={props.codexRecovery}
                  onStop={props.onStopCodexRecovery}
                  disabled={props.codexRecoveryStopDisabled}
                />
              </div>
            ) : null}
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
            sessionQuota={sessionQuota}
            usageResetAction={props.usageResetAction}
            layout="panel"
            subagentConcurrency={props.subagentConcurrency}
          />
        </div>
      </div>
    );
  }),
);
