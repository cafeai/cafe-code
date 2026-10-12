import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
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
      return uiText("Active");
    case "paused":
      return uiText("Paused");
    case "blocked":
      return uiText("Blocked");
    case "usageLimited":
      return uiText("Usage limited");
    case "budgetLimited":
      return uiText("Budget reached");
    case "complete":
      return uiText("Complete");
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
    if (days > 0) return uiText("{days}d {hours}h", { days, hours });
    if (hours > 0) return uiText("{hours}h {minutes}m", { hours, minutes });
    if (minutes > 0) return uiText("{minutes}m", { minutes });
    return uiText("'<1m'");
  }
  const parts: string[] = [];
  if (days > 0) parts.push(uiText("{days}d", { days }));
  if (hours > 0) parts.push(uiText("{hours}h", { hours }));
  if (minutes > 0) parts.push(uiText("{minutes}m", { minutes }));
  if (parts.length === 0 || (days === 0 && hours === 0)) {
    parts.push(uiText("{seconds}s", { seconds: remainingSeconds }));
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const nowMs = useGoalClock(props.goal?.status === "active" && props.isTurnRunning);
  const label = useMemo(() => {
    const goal = props.goal;
    if (goal === null) return uiText("Goal", undefined, undefined, uiLocale);
    if (goal.status === "active" && goal.tokenBudget !== null) {
      return `${compactNumberFormatter.format(goal.tokensUsed)} / ${compactNumberFormatter.format(
        goal.tokenBudget,
      )}`;
    }
    if (goal.status === "active") {
      return uiPresentation.formatDuration(
        effectiveGoalTimeSeconds({
          goal,
          activeTurnStartedAt: props.activeTurnStartedAt,
          isTurnRunning: props.isTurnRunning,
          nowMs,
        }),
        true,
      );
    }
    return uiPresentation.threadGoalStatusLabel(goal.status);
  }, [nowMs, props.activeTurnStartedAt, props.goal, props.isTurnRunning, uiLocale, uiPresentation]);

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(
        "shrink-0 px-2 text-muted-foreground hover:text-foreground sm:px-3",
        props.className,
      )}
      aria-label={
        props.goal === null
          ? uiText("Create goal", undefined, undefined, uiLocale)
          : uiText("Open goal", undefined, undefined, uiLocale)
      }
      title={props.goal?.objective ?? uiText("Goal", undefined, undefined, uiLocale)}
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

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
          cause instanceof Error
            ? cause.message
            : uiText("The goal operation could not be queued.", undefined, undefined, uiLocale),
        );
      } finally {
        setPending(false);
      }
    },
    [props, uiLocale],
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
                ? uiText("Create goal", undefined, undefined, uiLocale)
                : mode === "replace"
                  ? uiText("Replace goal", undefined, undefined, uiLocale)
                  : mode === "edit"
                    ? uiText("Edit goal", undefined, undefined, uiLocale)
                    : uiText("Goal", undefined, undefined, uiLocale)}
            </DialogTitle>
            {props.goal !== null && !isEditor ? (
              <DialogDescription className="flex items-center gap-2">
                <Badge variant={goalStatusVariant(props.goal.status)}>
                  {uiPresentation.threadGoalStatusLabel(props.goal.status)}
                </Badge>
              </DialogDescription>
            ) : null}
          </DialogHeader>

          <DialogPanel className="grid gap-5">
            {isEditor ? (
              <>
                <label className="grid gap-1.5">
                  <span className="font-medium text-sm">
                    {uiText("Objective", undefined, undefined, uiLocale)}
                  </span>
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
                  <span className="font-medium text-sm">
                    {uiText("Token budget", undefined, undefined, uiLocale)}
                  </span>
                  <Input
                    nativeInput
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    placeholder={uiText("No limit", undefined, undefined, uiLocale)}
                    value={tokenBudgetText}
                    aria-invalid={!budgetIsValid ? "true" : undefined}
                    onChange={(event) => setTokenBudgetText(event.currentTarget.value)}
                  />
                </label>
              </>
            ) : props.goal !== null ? (
              <>
                <p className="whitespace-pre-wrap text-sm leading-6">{props.goal.objective}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 border-t border-border-subtle pt-4 text-sm">
                  <dt className="text-muted-foreground">
                    {uiText("Time", undefined, undefined, uiLocale)}
                  </dt>
                  <dd>{uiPresentation.formatDuration(effectiveTime, false)}</dd>
                  <dt className="text-muted-foreground">
                    {uiText("Tokens", undefined, undefined, uiLocale)}
                  </dt>
                  <dd>{numberFormatter.format(props.goal.tokensUsed)}</dd>
                  <dt className="text-muted-foreground">
                    {uiText("Budget", undefined, undefined, uiLocale)}
                  </dt>
                  <dd>
                    {props.goal.tokenBudget === null
                      ? uiText("No limit", undefined, undefined, uiLocale)
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
                    {uiText("Cancel", undefined, undefined, uiLocale)}
                  </Button>
                ) : null}
                <Button
                  disabled={pending || !objectiveIsValid || !budgetIsValid}
                  onClick={requestObjectiveCommit}
                >
                  <CheckIcon />
                  {pending
                    ? uiText("Saving", undefined, undefined, uiLocale)
                    : uiText("Save", undefined, undefined, uiLocale)}
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
                  {uiText("Clear", undefined, undefined, uiLocale)}
                </Button>
                <Button variant="outline" disabled={pending} onClick={() => setMode("edit")}>
                  <PencilIcon />
                  {uiText("Edit", undefined, undefined, uiLocale)}
                </Button>
                {props.goal.status === "active" ? (
                  <Button
                    disabled={pending}
                    onClick={() => void runOperation(() => props.onSetGoal({ status: "paused" }))}
                  >
                    <CirclePauseIcon />
                    {uiText("Pause", undefined, undefined, uiLocale)}
                  </Button>
                ) : props.goal.status === "paused" ||
                  props.goal.status === "blocked" ||
                  props.goal.status === "usageLimited" ? (
                  <Button
                    disabled={pending}
                    onClick={() => void runOperation(() => props.onSetGoal({ status: "active" }))}
                  >
                    <CirclePlayIcon />
                    {uiText("Resume", undefined, undefined, uiLocale)}
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
            <AlertDialogTitle>
              {uiText("Replace the active goal?", undefined, undefined, uiLocale)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {uiText(
                "The existing unfinished goal will be replaced.",
                undefined,
                undefined,
                uiLocale,
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </AlertDialogClose>
            <Button
              disabled={pending}
              onClick={() => {
                setReplaceConfirmOpen(false);
                commitObjective();
              }}
            >
              {uiText("Replace", undefined, undefined, uiLocale)}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
});

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { formatDuration, threadGoalStatusLabel };
