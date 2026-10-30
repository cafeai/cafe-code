import {
  WORK_LOG_OPERATION_ID_MAX_LENGTH,
  type WorkLogOperationIdentity,
} from "@cafecode/contracts";

/** Match the finite wire identity without admitting accessors or inherited data. */
function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

export function readWorkLogOperationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id.length > 0 &&
    id.length <= WORK_LOG_OPERATION_ID_MAX_LENGTH &&
    !/[\p{Cc}\p{Bidi_Control}]/u.test(id)
    ? id
    : undefined;
}

/**
 * All current adapters preserve a native item id; ACP additionally carries a
 * toolCallId. Prefer that explicit tool identity, then the native item id.
 * Keep public summaries separate even when a provider reuses the same id.
 * SQL history filtering follows this exact precedence and String.trim policy.
 */
export function readWorkLogOperationIdentity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): WorkLogOperationIdentity | undefined {
  const itemId = ownValue(activity.payload, "itemId");
  if (activity.kind === "reasoning.summary") {
    const id = readWorkLogOperationId(itemId);
    return id ? { kind: "summary", id } : undefined;
  }
  if (
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.completed"
  ) {
    // Explicit native task/tool correlation from trusted ingestion, never a
    // task id, description or control target guessed to be a tool identity.
    const id = readWorkLogOperationId(ownValue(activity.payload, "workLogToolCallId"));
    return id ? { kind: "tool", id } : undefined;
  }
  if (
    activity.kind !== "tool.started" &&
    activity.kind !== "tool.updated" &&
    activity.kind !== "tool.completed"
  )
    return undefined;
  const toolCallId = ownValue(ownValue(activity.payload, "data"), "toolCallId");
  const candidate =
    typeof toolCallId === "string" && toolCallId.trim().length > 0 ? toolCallId : itemId;
  const id = readWorkLogOperationId(candidate);
  return id ? { kind: "tool", id } : undefined;
}

export function isExcludedWorkLogOperation(
  activity: { readonly kind: string; readonly payload: unknown },
  operations: ReadonlyArray<WorkLogOperationIdentity> | undefined,
): boolean {
  if (!operations?.length) return false;
  const operation = readWorkLogOperationIdentity(activity);
  return (
    operation !== undefined &&
    operations.some((excluded) => excluded.kind === operation.kind && excluded.id === operation.id)
  );
}

/**
 * Providers whose adapters emit the version-1 public reasoning summary contract
 * from their own primary conversation (Claude public summaries and OpenCode
 * reasoning parts). Server ingestion, the historical work-log SQL predicate and
 * the renderer admit exactly this list; any other provider's reasoning item is
 * never promoted to a visible row by shape alone.
 */
export const PUBLIC_REASONING_SUMMARY_PROVIDERS = ["claudeAgent", "opencode"] as const;
export type PublicReasoningSummaryProvider = (typeof PUBLIC_REASONING_SUMMARY_PROVIDERS)[number];

export function isPublicReasoningSummaryProvider(
  value: unknown,
): value is PublicReasoningSummaryProvider {
  return (
    typeof value === "string" &&
    (PUBLIC_REASONING_SUMMARY_PROVIDERS as ReadonlyArray<string>).includes(value)
  );
}

/** Duplicate/polling observations stay in diagnostics; canonical receipts stay visible. */
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

/**
 * Exact Cafe-authored warnings that stay in durable diagnostics but no longer
 * get their own Work Log row: the failure they describe now appears once as a
 * categorized provider error ("Sign-in required"), or the warning reported a
 * provider message Cafe now consumes quietly. Older persisted rows match the
 * same exact text, so historical presence/count/page queries agree.
 */
export const HIDDEN_PROVIDER_WARNING_MESSAGES = [
  "Claude authentication failed; suppressing Claude Code's synthetic assistant error and retiring this stale session.",
  "Claude authentication failed; retiring this stale Claude session so the next turn starts with current login material.",
  "Claude authentication retry failed with 401; Cafe will retire this session if Claude reports the turn as failed.",
  "Unhandled Claude system message subtype 'dev_intent'.",
  "Unhandled Claude system message subtype 'session_title_changed'.",
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
  const payload =
    activity.payload !== null &&
    typeof activity.payload === "object" &&
    !Array.isArray(activity.payload)
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (activity.kind === "runtime.warning") {
    return (
      readCodexRoutineWarningStatus(payload?.message) !== null ||
      (HIDDEN_PROVIDER_WARNING_MESSAGES as ReadonlyArray<unknown>).includes(payload?.message)
    );
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
