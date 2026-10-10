/** Routine Codex lifecycle observations belong in the steering shelf or diagnostics. */
export const CODEX_STEER_PROGRESS_TASK_PREFIXES = [
  "codex-turn-steer:",
  "codex-turn-steer-processing:",
] as const;

export const CODEX_STEER_PROGRESS_MESSAGES = [
  "Codex app-server accepted turn/steer.",
  "Codex app-server began processing turn/steer.",
  "Codex app-server observed the correlated user message after recovery.",
] as const;

export const CODEX_STEER_WAIT_MESSAGE =
  "Codex app-server accepted turn/steer but has not emitted the steer user message yet.";
export const CODEX_TURN_RUNNING_MESSAGE =
  "Codex still reports the active turn as in progress after delayed snapshot polling.";

// Persisted warnings predate structured presentation codes. Keep these exact
// Cafe-owned formats shared with the indexed historical count/page/presence
// queries. Other warnings and every runtime error remain visible.
export const CODEX_ROUTINE_WARNING_FORMATS = [
  {
    prefix:
      "Codex accepted turn/steer; it is queued until the active turn finishes current child-process work (",
    suffix: " live descendant process).",
    status: "steer-wait",
  },
  {
    prefix:
      "Codex accepted turn/steer; it is queued until the active turn finishes current child-process work (",
    suffix: " live descendant processes).",
    status: "steer-wait",
  },
  {
    prefix: "Codex still reports the active turn as in progress; app-server has ",
    suffix: " live descendant process still running.",
    status: "turn-running",
  },
  {
    prefix: "Codex still reports the active turn as in progress; app-server has ",
    suffix: " live descendant processes still running.",
    status: "turn-running",
  },
] as const;

export function readCodexRoutineWarningStatus(
  message: unknown,
): "steer-wait" | "turn-running" | null {
  if (message === CODEX_STEER_WAIT_MESSAGE) return "steer-wait";
  if (message === CODEX_TURN_RUNNING_MESSAGE) return "turn-running";
  if (typeof message !== "string") return null;
  return (
    CODEX_ROUTINE_WARNING_FORMATS.find(
      (format) => message.startsWith(format.prefix) && message.endsWith(format.suffix),
    )?.status ?? null
  );
}

export function isRoutineProviderWorkLogActivity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): boolean {
  if (activity.kind === "provider.turn.steer.accepted") return true;
  const payload =
    activity.payload !== null &&
    typeof activity.payload === "object" &&
    !Array.isArray(activity.payload)
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (activity.kind === "runtime.warning") {
    return readCodexRoutineWarningStatus(payload?.message) !== null;
  }
  if (activity.kind !== "task.progress") return false;
  const taskId = payload?.taskId;
  return (
    (typeof taskId === "string" &&
      CODEX_STEER_PROGRESS_TASK_PREFIXES.some((prefix) => taskId.startsWith(prefix))) ||
    CODEX_STEER_PROGRESS_MESSAGES.some(
      (message) => payload?.detail === message || payload?.description === message,
    )
  );
}
