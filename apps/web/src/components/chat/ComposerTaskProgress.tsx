import { CircleCheckIcon, CircleIcon, LoaderCircleIcon } from "lucide-react";
import { memo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";

export type ComposerTaskProgressStepStatus = "pending" | "inProgress" | "completed";

/**
 * The plan subset needed by the composer control. ActivePlanState is structurally
 * compatible with this type, while keeping the reusable view independent from
 * the session projection that produces the plan.
 */
export interface ComposerTaskProgressPlan {
  readonly explanation?: string | null;
  readonly steps: ReadonlyArray<{
    readonly step: string;
    readonly status: ComposerTaskProgressStepStatus;
  }>;
}

interface StepPresentation {
  readonly currentIndex: number;
  readonly completedCount: number;
  readonly currentStepIndex: number | null;
}

function deriveStepPresentation(plan: ComposerTaskProgressPlan): StepPresentation {
  const inProgressIndex = plan.steps.findIndex((step) => step.status === "inProgress");
  const pendingIndex = plan.steps.findIndex((step) => step.status === "pending");
  const currentStepIndex =
    inProgressIndex >= 0 ? inProgressIndex : pendingIndex >= 0 ? pendingIndex : null;

  return {
    completedCount: plan.steps.filter((step) => step.status === "completed").length,
    currentIndex: currentStepIndex === null ? plan.steps.length : currentStepIndex + 1,
    currentStepIndex,
  };
}

function statusForStep(
  step: ComposerTaskProgressPlan["steps"][number],
  index: number,
  currentStepIndex: number | null,
): "completed" | "current" | "pending" {
  if (step.status === "completed") return "completed";
  if (index === currentStepIndex) return "current";
  return "pending";
}

const statusLabels = {
  completed: "Completed",
  current: "Current",
  pending: "Pending",
} as const;

// Provider-authored plan text is rendered as ordinary React text, so markup is
// already escaped. Remove only non-printing controls that can obscure or reorder
// what the user sees (notably Unicode bidi overrides); preserve tabs, newlines,
// the ZWNJ/ZWJ code points used by natural-language scripts and emoji, and every
// printable code point.
const UNSAFE_INVISIBLE_CONTROL_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- these are the exact non-printing code points this boundary removes
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu;

function sanitizePlanText(value: string): string {
  return value.replace(UNSAFE_INVISIBLE_CONTROL_CHARACTERS, "");
}

/**
 * Compact task progress for the composer footer. The trigger intentionally uses
 * Base UI's unified hover/press interaction model: mouse users can inspect the
 * list without clicking, while touch users press and keyboard users focus the
 * native button before activating it with Enter or Space.
 */
export const ComposerTaskProgress = memo(function ComposerTaskProgress(props: {
  readonly plan: ComposerTaskProgressPlan | null | undefined;
}) {
  const { plan } = props;
  const [open, setOpen] = useState(false);
  const openModeRef = useRef<"hover" | "press" | null>(null);
  if (!plan || plan.steps.length === 0) return null;

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

  const total = plan.steps.length;
  const { completedCount, currentIndex, currentStepIndex } = deriveStepPresentation(plan);
  const completionPercentage = (completedCount / total) * 100;
  const keyOccurrences = new Map<string, number>();
  const displaySteps = plan.steps.map((step, index) => {
    const text = sanitizePlanText(step.step);
    const occurrence = (keyOccurrences.get(text) ?? 0) + 1;
    keyOccurrences.set(text, occurrence);
    return {
      key: `${text}\u001F${occurrence}`,
      status: statusForStep(step, index, currentStepIndex),
      text,
    };
  });

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        openOnHover
        delay={0}
        closeDelay={100}
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-6 shrink-0 gap-1.5 rounded-full border-border/60 bg-muted/35 px-2 text-muted-foreground text-xs before:rounded-full hover:bg-muted/60 hover:text-foreground"
            aria-label={`Task progress: step ${currentIndex} of ${total}. Show task list`}
            data-composer-task-progress="true"
            data-composer-task-progress-trigger="true"
          />
        }
      >
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
        <span aria-live="polite">
          Step {currentIndex} / {total}
        </span>
      </PopoverTrigger>

      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        initialFocus={false}
        className="w-[min(22rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] p-0"
        data-composer-task-progress-popup="true"
      >
        <div className="flex max-h-[min(28rem,calc(100dvh-2rem))] min-h-0 w-full flex-col">
          <div className="shrink-0 border-border/70 border-b px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <PopoverTitle className="text-sm leading-5">Tasks</PopoverTitle>
              <span className="shrink-0 text-muted-foreground text-xs">
                {completedCount} of {total} completed
              </span>
            </div>
          </div>

          <div
            aria-label="Task details"
            className="min-h-0 overflow-y-auto overscroll-contain px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            data-task-list-scroll="true"
            role="region"
            tabIndex={0}
          >
            {plan.explanation ? (
              <PopoverDescription className="mb-3 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
                {sanitizePlanText(plan.explanation)}
              </PopoverDescription>
            ) : null}

            <ol
              aria-label="Task list"
              className="space-y-3"
              data-composer-task-progress-list="true"
            >
              {displaySteps.map((step) => {
                const { status } = step;
                const label = statusLabels[status];

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
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
