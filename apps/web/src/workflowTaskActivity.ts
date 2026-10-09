import {
  ProviderIndividualTaskControl,
  RuntimeWorkflowPresentation,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
  type TurnId,
} from "@cafecode/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isSubagentRuntimeCurrent, type SubagentRuntimeContext } from "./subagent-activity";

const decodeWorkflow = Schema.decodeUnknownOption(RuntimeWorkflowPresentation);
const isControl = Schema.is(ProviderIndividualTaskControl);
const decodedByActivity = new WeakMap<
  OrchestrationThreadActivity,
  RuntimeWorkflowPresentation | null
>();

export type WorkflowTaskStatus = "running" | "completed" | "failed" | "stopped" | "unknown";

/**
 * A received workflow snapshot is presentation, not a collection of authorized
 * provider children. Its numeric indices have meaning only within this exact
 * root task; they never become transcript ids or individual control targets.
 */
export interface DerivedWorkflowTask {
  readonly key: string;
  readonly taskId: string;
  readonly turnId: TurnId;
  readonly title: string;
  readonly description?: string;
  readonly summary?: string;
  readonly status: WorkflowTaskStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly workflow: RuntimeWorkflowPresentation;
  readonly totalTokens?: number;
  readonly durationMs?: number;
  readonly reference?: ProviderIndividualTaskControl;
}

export interface WorkflowTaskContext {
  readonly providerInstanceId: ProviderInstanceId;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly runtimeSession: SubagentRuntimeContext | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function displayLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Old activity payloads remain untyped JSON. Keep their inert display copy
  // bounded and remove invisible controls without parsing Markdown or paths.
  const line = value
    .replace(/[\p{Cc}\p{Bidi_Control}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return line.length > 0 ? line.slice(0, 300) : undefined;
}

function exactIdentity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\p{Cc}\p{Bidi_Control}]/u.test(value)
    ? value
    : undefined;
}

function reportedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function readWorkflowTaskPresentation(
  activity: OrchestrationThreadActivity,
): RuntimeWorkflowPresentation | undefined {
  let decoded = decodedByActivity.get(activity);
  if (decoded === undefined) {
    const result = decodeWorkflow(record(activity.payload)?.workflow);
    decoded = Option.isSome(result) ? result.value : null;
    decodedByActivity.set(activity, decoded);
  }
  return decoded ?? undefined;
}

/** Shared durable ordering; a timestamp collision must not reorder lifecycle edges. */
function compareActivity(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (
    left.sequence !== undefined &&
    right.sequence !== undefined &&
    left.sequence !== right.sequence
  )
    return left.sequence - right.sequence;
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function isTerminal(status: WorkflowTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

/**
 * Reconstruct exact workflow roots from authenticated lifecycle activity. A
 * missing snapshot arrays in a stamped workflow envelope retain the last
 * received arrays because Claude deliberately omits them on throttled progress
 * frames. A supplied snapshot
 * replaces both arrays; it is never appended as another set of agents/phases.
 * Current query/account evidence controls live presentation independently of
 * whether the root currently offers a mutation receipt.
 */
export function deriveWorkflowTasks(context: WorkflowTaskContext): DerivedWorkflowTask[] {
  const tasks = new Map<string, DerivedWorkflowTask>();
  for (const activity of context.activities.toSorted(compareActivity)) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    )
      continue;
    const payload = record(activity.payload);
    const taskId = exactIdentity(payload?.taskId);
    if (!payload || !taskId || activity.turnId === null) continue;
    const key = JSON.stringify([activity.turnId, taskId]);
    const previous = tasks.get(key);
    const observedWorkflow = readWorkflowTaskPresentation(activity);
    if (!observedWorkflow) {
      // A malformed/unstamped lifecycle edge cannot borrow the previous
      // account/query stamp. Preserve only inert historical copy and retire
      // live controls; absence is never evidence of completion.
      if (previous && !isTerminal(previous.status)) {
        const { reference: _reference, ...inert } = previous;
        tasks.set(key, { ...inert, status: "unknown" });
      }
      continue;
    }
    const workflow = observedWorkflow;

    // A current account cannot inherit another account's display or controls.
    // Foreign delayed observations cannot erase an admitted current card.
    if (workflow.providerInstanceId !== context.providerInstanceId) continue;
    const currentRuntimeId = context.runtimeSession?.subagentRuntimeId;
    if (
      typeof currentRuntimeId === "string" &&
      previous?.workflow.runtimeId === currentRuntimeId &&
      observedWorkflow.runtimeId !== currentRuntimeId
    )
      continue;

    if (payload.visibility === "ambient") {
      // Visibility retraction is not completion. Do not reveal a prior phase
      // snapshot or retain controls after the native root becomes hidden.
      tasks.delete(key);
      continue;
    }

    const replacement =
      previous !== undefined && observedWorkflow.runtimeId !== previous.workflow.runtimeId;
    const restart =
      activity.kind === "task.started" && previous !== undefined && isTerminal(previous.status);
    if (previous && isTerminal(previous.status) && !restart && !replacement) continue;

    const current = isSubagentRuntimeCurrent(workflow.runtimeId, context.runtimeSession);
    const terminal = activity.kind === "task.completed";
    const status: WorkflowTaskStatus = terminal
      ? payload.status === "failed"
        ? "failed"
        : payload.status === "stopped"
          ? "stopped"
          : payload.status === "completed"
            ? "completed"
            : "unknown"
      : current
        ? "running"
        : "unknown";
    const replacingSnapshot =
      observedWorkflow?.phases !== undefined && observedWorkflow.agents !== undefined;
    const retainedWorkflow: RuntimeWorkflowPresentation = {
      ...workflow,
      ...(!restart && !replacement && workflow.name === undefined && previous?.workflow.name
        ? { name: previous.workflow.name }
        : {}),
      ...(!replacingSnapshot && !restart && !replacement && previous
        ? {
            ...(previous.workflow.phases !== undefined ? { phases: previous.workflow.phases } : {}),
            ...(previous.workflow.agents !== undefined ? { agents: previous.workflow.agents } : {}),
            ...(previous.workflow.truncated !== undefined
              ? { truncated: previous.workflow.truncated }
              : {}),
          }
        : {}),
    };
    const usage = record(payload.usage);
    const fresh = restart || replacement;
    const description =
      !previous || fresh || previous.description === undefined
        ? displayLine(payload.detail)
        : previous.description;
    const summary = activity.kind !== "task.started" ? displayLine(payload.detail) : undefined;
    const totalTokens =
      reportedNumber(usage?.total_tokens) ?? (!fresh ? previous?.totalTokens : undefined);
    const durationMs =
      reportedNumber(usage?.duration_ms) ?? (!fresh ? previous?.durationMs : undefined);
    const control = isControl(payload.individualTaskControl)
      ? payload.individualTaskControl
      : undefined;
    const reference =
      !terminal &&
      current &&
      control &&
      control.taskId === taskId &&
      control.runtimeId === workflow.runtimeId &&
      control.capability.providerInstanceId === context.providerInstanceId
        ? control
        : undefined;
    tasks.set(key, {
      key,
      taskId,
      turnId: activity.turnId,
      title: retainedWorkflow.name ?? "Claude workflow",
      ...(description ? { description } : {}),
      ...(summary ? { summary } : !fresh && previous?.summary ? { summary: previous.summary } : {}),
      status,
      startedAt: fresh ? activity.createdAt : (previous?.startedAt ?? activity.createdAt),
      ...(terminal ? { completedAt: activity.createdAt } : {}),
      workflow: retainedWorkflow,
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(reference ? { reference } : {}),
    });
  }
  // A stopped/replaced session invalidates retained live status immediately,
  // even when no new native lifecycle event is available after a reconnect.
  const result: DerivedWorkflowTask[] = [];
  for (const task of [...tasks.values()].toReversed()) {
    if (
      isTerminal(task.status) ||
      isSubagentRuntimeCurrent(task.workflow.runtimeId, context.runtimeSession)
    ) {
      result.push(task);
    } else {
      const { reference: _reference, ...inert } = task;
      result.push({ ...inert, status: "unknown" });
    }
  }
  return result;
}
