import type { ProviderThreadGoal, ProviderThreadGoalStatus } from "@cafecode/contracts";
import {
  CheckIcon,
  CirclePauseIcon,
  CirclePlayIcon,
  PencilIcon,
  TargetIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const MAX_GOAL_OBJECTIVE_CODE_POINTS = 4_000;
const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export type ThreadGoalDialogMode = "summary" | "edit" | "replace";

export interface ThreadGoalSetPatch {
  readonly objective?: string;
  readonly status?: ProviderThreadGoalStatus;
  readonly tokenBudget?: number | null;
  readonly replaceExisting?: boolean;
}

export function threadGoalStatusLabel(status: ProviderThreadGoalStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "blocked":
      return "Blocked";
    case "usageLimited":
      return "Usage limited";
    case "budgetLimited":
      return "Budget reached";
    case "complete":
      return "Complete";
  }
}

function goalStatusVariant(
  status: ProviderThreadGoalStatus,
): "success" | "warning" | "error" | "secondary" {
  switch (status) {
    case "active":
      return "success";
    case "paused":
    case "blocked":
    case "usageLimited":
      return "warning";
    case "budgetLimited":
      return "error";
    case "complete":
      return "secondary";
  }
}

function formatDuration(totalSeconds: number, compact: boolean): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  if (compact) {
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return "<1m";
  }
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0 || (days === 0 && hours === 0)) {
    parts.push(`${remainingSeconds}s`);
  }
  return parts.join(" ");
}

function effectiveGoalTimeSeconds(input: {
  readonly goal: ProviderThreadGoal;
  readonly activeTurnStartedAt: string | null;
  readonly isTurnRunning: boolean;
  readonly nowMs: number;
}): number {
  if (
    input.goal.status !== "active" ||
    !input.isTurnRunning ||
    input.activeTurnStartedAt === null
  ) {
    return input.goal.timeUsedSeconds;
  }
  const goalUpdatedAtMs = Date.parse(input.goal.updatedAt);
  const turnStartedAtMs = Date.parse(input.activeTurnStartedAt);
  const accountingBaselineMs = Math.max(
    Number.isFinite(goalUpdatedAtMs) ? goalUpdatedAtMs : 0,
    Number.isFinite(turnStartedAtMs) ? turnStartedAtMs : 0,
  );
  return (
    input.goal.timeUsedSeconds +
    Math.max(0, Math.floor((input.nowMs - accountingBaselineMs) / 1_000))
  );
}

function useGoalClock(running: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!running) {
      setNowMs(Date.now());
      return;
    }
    // Goal time is informational and minute-granular in the compact footer.
    // A 30-second clock avoids a permanent one-second renderer wakeup during
    // the multi-hour and multi-day workloads Cafe is designed to sustain.
    const interval = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [running]);
  return nowMs;
}

export const ThreadGoalFooterButton = memo(function ThreadGoalFooterButton(props: {
  readonly goal: ProviderThreadGoal | null;
  readonly activeTurnStartedAt: string | null;
  readonly isTurnRunning: boolean;
  readonly className?: string;
  readonly onClick: () => void;
}) {
  const nowMs = useGoalClock(props.goal?.status === "active" && props.isTurnRunning);
  const label = useMemo(() => {
    const goal = props.goal;
    if (goal === null) return "Goal";
    if (goal.status === "active" && goal.tokenBudget !== null) {
      return `${compactNumberFormatter.format(goal.tokensUsed)} / ${compactNumberFormatter.format(
        goal.tokenBudget,
      )}`;
    }
    if (goal.status === "active") {
      return formatDuration(
        effectiveGoalTimeSeconds({
          goal,
          activeTurnStartedAt: props.activeTurnStartedAt,
          isTurnRunning: props.isTurnRunning,
          nowMs,
        }),
        true,
      );
    }
    return threadGoalStatusLabel(goal.status);
  }, [nowMs, props.activeTurnStartedAt, props.goal, props.isTurnRunning]);

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(
        "shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3",
        props.className,
      )}
      aria-label={props.goal === null ? "Create goal" : "Open goal"}
      title={props.goal?.objective ?? "Goal"}
      onClick={props.onClick}
    >
      <TargetIcon />
      <span>{label}</span>
    </Button>
  );
});

export const ThreadGoalDialog = memo(function ThreadGoalDialog(props: {
  readonly open: boolean;
  readonly requestRevision: number;
  readonly mode: ThreadGoalDialogMode;
  readonly seedObjective: string | null;
  readonly confirmReplacement: boolean;
  readonly goal: ProviderThreadGoal | null;
  readonly activeTurnStartedAt: string | null;
  readonly isTurnRunning: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSetGoal: (patch: ThreadGoalSetPatch) => Promise<void>;
  readonly onClearGoal: () => Promise<void>;
}) {
  const [mode, setMode] = useState<ThreadGoalDialogMode>(props.mode);
  const [objective, setObjective] = useState(props.seedObjective ?? props.goal?.objective ?? "");
  const [tokenBudgetText, setTokenBudgetText] = useState(
    props.goal?.tokenBudget === null || props.goal?.tokenBudget === undefined
      ? ""
      : String(props.goal.tokenBudget),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);
  const nowMs = useGoalClock(props.open && props.goal?.status === "active" && props.isTurnRunning);

  useEffect(() => {
    if (!props.open) return;
    setMode(props.mode);
    setObjective(props.seedObjective ?? props.goal?.objective ?? "");
    setTokenBudgetText(
      props.mode === "replace" ||
        props.goal?.tokenBudget === null ||
        props.goal?.tokenBudget === undefined
        ? ""
        : String(props.goal.tokenBudget),
    );
    setPending(false);
    setError(null);
    setReplaceConfirmOpen(false);
  }, [props.goal, props.mode, props.open, props.requestRevision, props.seedObjective]);

  const objectiveCodePoints = Array.from(objective.trim()).length;
  const parsedTokenBudget =
    tokenBudgetText.trim().length === 0 ? null : Number(tokenBudgetText.trim());
  const budgetIsValid =
    parsedTokenBudget === null ||
    (Number.isSafeInteger(parsedTokenBudget) && parsedTokenBudget > 0);
  const objectiveIsValid =
    objectiveCodePoints > 0 && objectiveCodePoints <= MAX_GOAL_OBJECTIVE_CODE_POINTS;

  const runOperation = useCallback(
    async (operation: () => Promise<void>) => {
      setPending(true);
      setError(null);
      try {
        await operation();
        props.onOpenChange(false);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "The goal operation could not be queued.",
        );
      } finally {
        setPending(false);
      }
    },
    [props],
  );

  const commitObjective = useCallback(() => {
    if (!objectiveIsValid || !budgetIsValid) return;
    void runOperation(() =>
      props.onSetGoal(
        mode === "replace"
          ? {
              objective: objective.trim(),
              replaceExisting: true,
            }
          : {
              objective: objective.trim(),
              tokenBudget: parsedTokenBudget,
            },
      ),
    );
  }, [budgetIsValid, objective, objectiveIsValid, parsedTokenBudget, props, runOperation, mode]);

  const requestObjectiveCommit = useCallback(() => {
    if (mode === "replace" && props.goal !== null && props.confirmReplacement) {
      setReplaceConfirmOpen(true);
      return;
    }
    commitObjective();
  }, [commitObjective, mode, props.confirmReplacement, props.goal]);

  const isEditor = props.goal === null || mode === "edit" || mode === "replace";
  const effectiveTime =
    props.goal === null
      ? 0
      : effectiveGoalTimeSeconds({
          goal: props.goal,
          activeTurnStartedAt: props.activeTurnStartedAt,
          isTurnRunning: props.isTurnRunning,
          nowMs,
        });

  return (
    <>
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {props.goal === null
                ? "Create goal"
                : mode === "replace"
                  ? "Replace goal"
                  : mode === "edit"
                    ? "Edit goal"
                    : "Goal"}
            </DialogTitle>
            {props.goal !== null && !isEditor ? (
              <DialogDescription className="flex items-center gap-2">
                <Badge variant={goalStatusVariant(props.goal.status)}>
                  {threadGoalStatusLabel(props.goal.status)}
                </Badge>
              </DialogDescription>
            ) : null}
          </DialogHeader>

          <DialogPanel className="grid gap-5">
            {isEditor ? (
              <>
                <label className="grid gap-1.5">
                  <span className="font-medium text-sm">Objective</span>
                  <Textarea
                    autoFocus
                    value={objective}
                    aria-invalid={objective.length > 0 && !objectiveIsValid ? "true" : undefined}
                    rows={5}
                    onChange={(event) => setObjective(event.currentTarget.value)}
                  />
                  <span
                    className={cn(
                      "text-muted-foreground text-xs",
                      objectiveCodePoints > MAX_GOAL_OBJECTIVE_CODE_POINTS && "text-destructive",
                    )}
                  >
                    {numberFormatter.format(objectiveCodePoints)} /{" "}
                    {numberFormatter.format(MAX_GOAL_OBJECTIVE_CODE_POINTS)}
                  </span>
                </label>

                <label className="grid gap-1.5">
                  <span className="font-medium text-sm">Token budget</span>
                  <Input
                    nativeInput
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    placeholder="No limit"
                    value={tokenBudgetText}
                    aria-invalid={!budgetIsValid ? "true" : undefined}
                    onChange={(event) => setTokenBudgetText(event.currentTarget.value)}
                  />
                </label>
              </>
            ) : props.goal !== null ? (
              <>
                <p className="whitespace-pre-wrap text-sm leading-6">{props.goal.objective}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 border-t border-border/60 pt-4 text-sm">
                  <dt className="text-muted-foreground">Time</dt>
                  <dd>{formatDuration(effectiveTime, false)}</dd>
                  <dt className="text-muted-foreground">Tokens</dt>
                  <dd>{numberFormatter.format(props.goal.tokensUsed)}</dd>
                  <dt className="text-muted-foreground">Budget</dt>
                  <dd>
                    {props.goal.tokenBudget === null
                      ? "No limit"
                      : numberFormatter.format(props.goal.tokenBudget)}
                  </dd>
                </dl>
              </>
            ) : null}
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
          </DialogPanel>

          <DialogFooter className="flex-wrap">
            {isEditor ? (
              <>
                {props.goal !== null ? (
                  <Button variant="outline" disabled={pending} onClick={() => setMode("summary")}>
                    Cancel
                  </Button>
                ) : null}
                <Button
                  disabled={pending || !objectiveIsValid || !budgetIsValid}
                  onClick={requestObjectiveCommit}
                >
                  <CheckIcon />
                  {pending ? "Saving" : "Save"}
                </Button>
              </>
            ) : props.goal !== null ? (
              <>
                <Button
                  variant="destructive-outline"
                  disabled={pending}
                  onClick={() => void runOperation(props.onClearGoal)}
                >
                  <Trash2Icon />
                  Clear
                </Button>
                <Button variant="outline" disabled={pending} onClick={() => setMode("edit")}>
                  <PencilIcon />
                  Edit
                </Button>
                {props.goal.status === "active" ? (
                  <Button
                    disabled={pending}
                    onClick={() => void runOperation(() => props.onSetGoal({ status: "paused" }))}
                  >
                    <CirclePauseIcon />
                    Pause
                  </Button>
                ) : props.goal.status === "paused" ||
                  props.goal.status === "blocked" ||
                  props.goal.status === "usageLimited" ? (
                  <Button
                    disabled={pending}
                    onClick={() => void runOperation(() => props.onSetGoal({ status: "active" }))}
                  >
                    <CirclePlayIcon />
                    Resume
                  </Button>
                ) : null}
              </>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={replaceConfirmOpen} onOpenChange={setReplaceConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the active goal?</AlertDialogTitle>
            <AlertDialogDescription>
              The existing unfinished goal will be replaced.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              disabled={pending}
              onClick={() => {
                setReplaceConfirmOpen(false);
                commitObjective();
              }}
            >
              Replace
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
});
