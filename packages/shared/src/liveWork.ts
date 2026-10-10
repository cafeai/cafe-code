import type { OrchestrationThreadActivity, OrchestrationSessionStatus } from "@cafecode/contracts";
import {
  ProviderIndividualTaskControl,
  RuntimeSubagentPresentation,
  SubagentRuntimeId,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { isRoutineProviderWorkLogActivity } from "./providerWorkLog.ts";

const isControl = Schema.is(ProviderIndividualTaskControl);
const isSubagent = Schema.is(RuntimeSubagentPresentation);
const isRuntime = Schema.is(SubagentRuntimeId);

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const identity = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;

export interface LiveWorkObservation {
  runtimeId: string;
  lane: "task" | "tool";
  workId: string;
  agent: boolean;
  active: boolean;
}

/** Presentation evidence only. Never grants a task mutation or changes a turn's state.
 * Generic reasoning/heartbeat task rows have no native binding and stay absent. */
export function readLiveWorkObservation(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): LiveWorkObservation | null {
  const payload = record(activity.payload);
  if (!payload) return null;
  if (
    isRoutineProviderWorkLogActivity(activity) ||
    (typeof payload.taskId === "string" && payload.taskId.startsWith("codex-turn-start:"))
  )
    return null;
  const task = activity.kind.startsWith("task.");
  const tool = activity.kind.startsWith("tool.");
  if (!task && !tool) return null;
  const control = record(payload.individualTaskControl);
  const subagent = record(payload.subagent);
  const runtimeId =
    identity(payload.nativeWorkRuntimeId) ??
    identity(control?.runtimeId) ??
    identity(subagent?.runtimeId);
  const workId = identity(task ? payload.taskId : payload.itemId);
  if (!runtimeId || !isRuntime(runtimeId) || !workId) return null;
  const terminal =
    activity.kind.endsWith(".completed") ||
    ["completed", "failed", "stopped", "error", "cancelled"].includes(
      String(payload.status ?? subagent?.status),
    );
  const visible = payload.visibility !== "ambient";
  // A tool update without its former control retracts that foreground entry
  // when the provider binds it to an independent native background task.
  const nativeBound = subagent
    ? isSubagent(payload.subagent) && subagent.runtimeId === runtimeId
    : isControl(payload.individualTaskControl) && control?.runtimeId === runtimeId;
  return {
    runtimeId,
    lane: task ? "task" : "tool",
    workId,
    agent: task && subagent !== null,
    active:
      visible &&
      nativeBound &&
      !terminal &&
      (!subagent ||
        subagent.status === undefined ||
        ["active", "waiting"].includes(String(subagent.status))),
  };
}

export function isLiveWorkRuntimeCurrent(
  runtimeId: string | undefined,
  session: {
    subagentRuntimeId?: string | null | undefined;
    orchestrationStatus: OrchestrationSessionStatus;
  } | null,
): boolean {
  return Boolean(
    runtimeId &&
    session &&
    session.orchestrationStatus !== "stopped" &&
    session.orchestrationStatus !== "error" &&
    session.subagentRuntimeId === runtimeId,
  );
}

/** Shared with the small server projection. A quiet transcript is never liveness evidence. */
export function deriveLiveWorkObservations(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  session: Parameters<typeof isLiveWorkRuntimeCurrent>[1],
) {
  const heads = new Map<
    string,
    { activity: OrchestrationThreadActivity; observation: LiveWorkObservation }
  >();
  for (const activity of activities.toSorted((a, b) =>
    a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence
      ? a.sequence - b.sequence
      : a.createdAt.localeCompare(b.createdAt) || String(a.id).localeCompare(String(b.id)),
  )) {
    const observation = readLiveWorkObservation(activity);
    if (!observation) {
      const payload = record(activity.payload);
      const lane = activity.kind.startsWith("task.")
        ? "task"
        : activity.kind.startsWith("tool.")
          ? "tool"
          : null;
      const workId = identity(lane === "task" ? payload?.taskId : payload?.itemId);
      if (lane && workId)
        for (const [key, head] of heads) {
          if (
            head.activity.turnId === activity.turnId &&
            head.observation.lane === lane &&
            head.observation.workId === workId
          )
            heads.delete(key);
        }
      continue;
    }
    const key = JSON.stringify([
      observation.runtimeId,
      activity.turnId,
      observation.lane,
      observation.workId,
    ]);
    heads.set(key, { activity, observation });
  }
  return [...heads.values()].filter(
    ({ observation }) =>
      observation.active && isLiveWorkRuntimeCurrent(observation.runtimeId, session),
  );
}
