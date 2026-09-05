import { CircleCheckIcon, CircleIcon, LoaderCircleIcon } from "lucide-react";
import { memo } from "react";

import type { WorkLogEntry } from "../../session-logic";
import { cn } from "~/lib/utils";
import { SubagentRosterRow, type SubagentRosterEntry } from "../subagents/SubagentRosterRow";
import {
  displayTaskProgressSteps,
  sanitizePlanText,
  TASK_PROGRESS_STATUS_LABELS,
  type ComposerTaskProgressPlan,
} from "./taskProgressPresentation";

export const TaskProgressDetails = memo(function TaskProgressDetails(props: {
  readonly plan: ComposerTaskProgressPlan | null | undefined;
  readonly subagents?: ReadonlyArray<WorkLogEntry>;
  readonly onOpenSubagentDetail?:
    | ((workEntry: WorkLogEntry, trigger: HTMLButtonElement) => void)
    | undefined;
}) {
  const plan = props.plan;
  const hasPlan = Boolean(plan && plan.steps.length > 0);
  const subagents = (props.subagents ?? []).filter(
    (entry): entry is SubagentRosterEntry => entry.subagent !== undefined,
  );
  const displaySteps = plan ? displayTaskProgressSteps(plan) : [];

  return (
    <>
      {subagents.length > 0 ? (
        <section
          aria-label="Active subagents"
          className={cn(hasPlan && "mb-3 border-border/55 border-b pb-3")}
          data-composer-subagent-list="true"
        >
          <p className="mb-1 text-[9px] font-medium uppercase tracking-[0.16em] text-muted-foreground/55">
            Active subagents
          </p>
          <div className="space-y-0.5">
            {subagents.map((entry) => (
              <SubagentRosterRow
                key={`task-progress-subagent:${entry.id}`}
                entry={entry}
                compact
                onOpen={(selectedEntry, rowTrigger) => {
                  props.onOpenSubagentDetail?.(selectedEntry, rowTrigger);
                }}
              />
            ))}
          </div>
        </section>
      ) : null}

      {plan?.explanation ? (
        <p className="mb-3 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
          {sanitizePlanText(plan.explanation)}
        </p>
      ) : null}

      {hasPlan ? (
        <ol aria-label="Task list" className="space-y-3" data-composer-task-progress-list="true">
          {displaySteps.map((step) => {
            const { status } = step;
            const label = TASK_PROGRESS_STATUS_LABELS[status];

            return (
              <li
                // Provider plans do not currently carry durable step ids. The
                // printable description plus its duplicate occurrence stays
                // stable across status updates and remains unique when a plan
                // intentionally repeats the same task.
                key={step.key}
                aria-current={status === "current" ? "step" : undefined}
                className="flex min-w-0 items-start gap-2.5"
                data-composer-task-progress-step="true"
                data-task-status={status}
              >
                <span
                  className={cn(
                    "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center",
                    status === "completed" && "text-emerald-600 dark:text-emerald-400",
                    status === "current" && "text-primary",
                    status === "pending" && "text-muted-foreground/65",
                  )}
                  aria-hidden="true"
                >
                  {status === "completed" ? (
                    <CircleCheckIcon className="size-4" strokeWidth={2} />
                  ) : status === "current" ? (
                    <LoaderCircleIcon
                      className="size-4 animate-spin motion-reduce:animate-none"
                      strokeWidth={2}
                    />
                  ) : (
                    <CircleIcon className="size-4" strokeWidth={1.75} />
                  )}
                </span>

                <div
                  className={cn(
                    "min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-5 [overflow-wrap:anywhere]",
                    status === "current" && "font-medium text-foreground",
                    status !== "current" && "text-muted-foreground",
                  )}
                >
                  <span className="sr-only">{label}: </span>
                  {step.text}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </>
  );
});
