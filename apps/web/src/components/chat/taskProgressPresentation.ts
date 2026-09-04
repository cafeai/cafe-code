export type ComposerTaskProgressStepStatus = "pending" | "inProgress" | "completed";

/**
 * The plan subset needed by the composer control and the docked session rail.
 * ActivePlanState is structurally compatible with this type.
 */
export interface ComposerTaskProgressPlan {
  readonly explanation?: string | null;
  readonly steps: ReadonlyArray<{
    readonly step: string;
    readonly status: ComposerTaskProgressStepStatus;
  }>;
}

export interface TaskProgressPresentation {
  readonly currentIndex: number;
  readonly completedCount: number;
  readonly currentStepIndex: number | null;
}

export type TaskProgressDisplayStatus = "completed" | "current" | "pending";

export interface TaskProgressDisplayStep {
  readonly key: string;
  readonly status: TaskProgressDisplayStatus;
  readonly text: string;
}

export const TASK_PROGRESS_STATUS_LABELS: Record<TaskProgressDisplayStatus, string> = {
  completed: "Completed",
  current: "Current",
  pending: "Pending",
};

// Provider-authored plan text is rendered as ordinary React text, so markup is
// already escaped. Remove only non-printing controls that can obscure or reorder
// what the user sees (notably Unicode bidi overrides); preserve tabs, newlines,
// the ZWNJ/ZWJ code points used by natural-language scripts and emoji, and every
// printable code point.
const UNSAFE_INVISIBLE_CONTROL_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- these are the exact non-printing code points this boundary removes
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu;

export function sanitizePlanText(value: string): string {
  return value.replace(UNSAFE_INVISIBLE_CONTROL_CHARACTERS, "");
}

function statusForStep(
  step: ComposerTaskProgressPlan["steps"][number],
  index: number,
  currentStepIndex: number | null,
): TaskProgressDisplayStatus {
  if (step.status === "completed") return "completed";
  if (index === currentStepIndex) return "current";
  return "pending";
}

export function deriveTaskProgressPresentation(
  plan: ComposerTaskProgressPlan,
): TaskProgressPresentation {
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

export function displayTaskProgressSteps(
  plan: ComposerTaskProgressPlan,
): ReadonlyArray<TaskProgressDisplayStep> {
  const { currentStepIndex } = deriveTaskProgressPresentation(plan);
  const keyOccurrences = new Map<string, number>();
  return plan.steps.map((step, index) => {
    const text = sanitizePlanText(step.step);
    const occurrence = (keyOccurrences.get(text) ?? 0) + 1;
    keyOccurrences.set(text, occurrence);
    return {
      key: `${text}\u001F${occurrence}`,
      status: statusForStep(step, index, currentStepIndex),
      text,
    };
  });
}
