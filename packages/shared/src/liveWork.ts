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

/** SQLite BINARY text order, including non-BMP ids, without viewer locale rules. */
function compareText(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== right.sequence) {
    if (left.sequence === undefined) return -1;
    if (right.sequence === undefined) return 1;
    return left.sequence - right.sequence;
  }
  return compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id);
}

function orderActivities(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  return activities.every(
    (activity, index) => index === 0 || compareActivities(activities[index - 1]!, activity) <= 0,
  )
    ? activities
    : activities.toSorted(compareActivities);
}

/**
 * Current explicit native-agent binding evidence, independently of whether its
 * latest lifecycle head is active. Shared active-only rosters and work counts
 * must not lose the owning start when completion or visibility retires a head.
 * This selects presentation evidence only; it never grants a control or history
 * route and preserves the source activity's exact turn/runtime/child identity.
 */
export function deriveCurrentNativeAgentStarts(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
) {
  const agentStarts = new Map<
    string,
    { activity: OrchestrationThreadActivity; observation: LiveWorkObservation }
  >();
  for (const activity of orderActivities(activities)) {
    if (activity.kind !== "task.started") continue;
    const observation = readLiveWorkObservation(activity);
    const subagent = record(activity.payload)?.subagent;
    // Claude and Codex use one stable native task/child identity inside the
    // exact query runtime. A generic task control or two different task/child
    // namespaces do not establish that contract. Only a fully bound explicit
    // start may replace its owning root turn; progress alone cannot do so.
    if (
      !observation ||
      !isSubagent(subagent) ||
      subagent.runtimeId !== observation.runtimeId ||
      subagent.threadId !== observation.workId
    )
      continue;
    agentStarts.set(JSON.stringify([observation.runtimeId, observation.workId]), {
      activity,
      observation,
    });
  }
  return [...agentStarts.values()];
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
  const ordered = orderActivities(activities);
  const agentStarts = new Map(
    deriveCurrentNativeAgentStarts(ordered).map(({ activity, observation }) => [
      JSON.stringify([observation.runtimeId, observation.workId]),
      activity,
    ]),
  );
  for (const activity of ordered) {
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
    const agentStart = observation.agent
      ? agentStarts.get(JSON.stringify([observation.runtimeId, observation.workId]))
      : undefined;
    // The explicit start owns this native task slot across root turns. Keep
    // historical activity and control identities untouched, but do not count
    // their obsolete per-turn heads as additional workers. A delayed terminal,
    // progress or visibility edge from an older owning turn cannot retire or
    // resurrect the replacement, even if it has a later canonical sequence.
    // Retaining start evidence separately also fences a late old-turn update
    // after an unstamped same-turn edge has invalidated the current live head.
    if (agentStart && activity.turnId !== agentStart.turnId) continue;
    //
    // Tasks without this exact child binding and all tools retain their
    // existing turn namespace. Item/control ids alone do not prove a runtime-
    // global child binding. Same-turn task reincarnation remains subject to
    // the producer's unchanged explicit run/tool/generation admission guards.
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
