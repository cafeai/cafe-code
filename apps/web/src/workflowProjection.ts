import type {
  OrchestrationThreadActivity,
  OrchestrationThreadActivityTone,
} from "@cafecode/contracts";

import {
  deriveSubagentActivities,
  type DeriveSubagentActivityOptions,
  type DerivedSubagentActivity,
  type SubagentRunStatus,
} from "./subagent-activity";

/**
 * Read-only workflow projection for one selected thread.
 *
 * The projection adds no new provider traffic. It reads the persisted
 * orchestration activities that the chat timeline already renders, and it
 * reuses `deriveSubagentActivities` so the observatory, the composer task pill,
 * and the Atrium always agree about one child lifecycle.
 *
 * Every field is source-reported or explicitly absent. Cafe does not infer a
 * worker count, a parent relationship, or a running state from age, file
 * paths, or event order.
 */

/** Maximum node count, including the thread node, kept in one snapshot. */
export const WORKFLOW_MAX_NODES = 64;
/** Maximum recent-activity rows kept in one snapshot. */
export const WORKFLOW_MAX_RECENT_ACTIVITIES = 100;
/** Maximum characters kept for one display string. */
export const WORKFLOW_MAX_TEXT_CHARS = 512;

/** Activity kinds that carry a workflow lifecycle edge in current Cafe. */
const WORKFLOW_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "task.started",
  "task.progress",
  "task.completed",
  "turn.plan.updated",
]);

export type WorkflowNodeStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";

export type WorkflowNodeKind = "thread" | "agent";

/**
 * How much lifecycle detail the source reported for this thread.
 *
 * `live` means the provider sent at least one progress edge. `lifecycle-only`
 * means only start and terminal edges arrived. `not-reported` means the
 * provider reported no task lifecycle at all.
 */
export type WorkflowFidelity = "live" | "lifecycle-only" | "not-reported";

export interface WorkflowNode {
  readonly id: string;
  /**
   * Containment edge only. Cafe providers report which thread recorded a child
   * agent; they do not report agent-to-agent parentage. An agent node is
   * therefore never shown as the parent of another agent node.
   */
  readonly parentId: string | null;
  readonly kind: WorkflowNodeKind;
  readonly title: string;
  readonly objective: string | null;
  readonly detail: string | null;
  readonly status: WorkflowNodeStatus;
  readonly startedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly completedAt: string | null;
  /**
   * Seconds between the first and the last recorded activity for this node.
   * This is an observed span from recorded timestamps. Current Cafe provider
   * adapters report no task duration, so the value is never shown as one.
   */
  readonly observedSpanSeconds: number | null;
}

export interface WorkflowActivityEntry {
  readonly id: string;
  readonly nodeId: string | null;
  readonly kind: string;
  readonly summary: string;
  readonly tone: OrchestrationThreadActivityTone;
  readonly createdAt: string;
}

export interface WorkflowProjectionSnapshot {
  readonly threadId: string | null;
  readonly environmentId: string | null;
  readonly turnId: string | null;
  readonly fidelity: WorkflowFidelity;
  readonly nodes: readonly WorkflowNode[];
  readonly recentActivities: readonly WorkflowActivityEntry[];
  readonly providerLabel: string | null;
  readonly modelLabel: string | null;
  /** Agent nodes the source reported. The thread node is not counted. */
  readonly agentCount: number;
  readonly sourceActivityCount: number;
  readonly omittedNodeCount: number;
  readonly omittedActivityCount: number;
  /** Source rows dropped because another row already used the same node id. */
  readonly duplicateNodeIdCount: number;
}

export interface WorkflowLatestTurn {
  readonly turnId: string;
  readonly state: "running" | "interrupted" | "completed" | "error";
  readonly requestedAt?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

export interface WorkflowProjectionInput {
  readonly threadId: string | null;
  readonly environmentId: string | null;
  readonly threadTitle?: string | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly latestTurn?: WorkflowLatestTurn | null;
  readonly providerLabel?: string | null;
  readonly modelLabel?: string | null;
  readonly subagentOptions?: DeriveSubagentActivityOptions;
}

export const EMPTY_WORKFLOW_SNAPSHOT: WorkflowProjectionSnapshot = {
  threadId: null,
  environmentId: null,
  turnId: null,
  fidelity: "not-reported",
  nodes: [],
  recentActivities: [],
  providerLabel: null,
  modelLabel: null,
  agentCount: 0,
  sourceActivityCount: 0,
  omittedNodeCount: 0,
  omittedActivityCount: 0,
  duplicateNodeIdCount: 0,
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\p{Cc}\p{Bidi_Control}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return normalized.length > WORKFLOW_MAX_TEXT_CHARS
    ? `${normalized.slice(0, WORKFLOW_MAX_TEXT_CHARS - 3)}...`
    : normalized;
}

function spanSeconds(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1_000));
}

function agentStatus(status: SubagentRunStatus): WorkflowNodeStatus {
  switch (status) {
    case "waiting":
      return "waiting";
    case "active":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "interrupted";
  }
}

function threadStatus(latestTurn: WorkflowLatestTurn | null): WorkflowNodeStatus {
  switch (latestTurn?.state) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "error":
      return "failed";
    default:
      // No turn is recorded for this thread, so no lifecycle is known.
      return "unknown";
  }
}

/**
 * Identity key shared with `deriveSubagentActivities`.
 *
 * A provider child identity is unique only inside its turn, so the turn is part
 * of the key. A recent-activity row attaches to a node through this key instead
 * of through prose, order, or timing.
 */
function sourceKey(turnId: string | null, id: string): string {
  return JSON.stringify([turnId, id]);
}

function activitySourceKey(activity: OrchestrationThreadActivity): string | null {
  const payload = record(activity.payload);
  if (!payload) return null;
  const presentation = record(payload.subagent);
  const id =
    typeof presentation?.threadId === "string" && presentation.threadId.length > 0
      ? presentation.threadId
      : typeof payload.taskId === "string" && payload.taskId.length > 0
        ? payload.taskId
        : null;
  return id === null ? null : sourceKey(activity.turnId ?? null, id);
}

function agentNode(row: DerivedSubagentActivity, parentId: string): WorkflowNode {
  const lastActivityAt = row.completedAt ?? row.updatedAt;
  return {
    // `rowId` is the activity id of the first durable lifecycle edge for this
    // child. It stays stable across reconnect replay, and two turns that reuse
    // one provider identity keep separate node ids.
    id: `agent:${row.rowId}`,
    parentId,
    kind: "agent",
    title: boundedLine(row.label) ?? "Subagent",
    objective: boundedLine(row.objective),
    detail: boundedLine(row.description),
    status: agentStatus(row.status),
    startedAt: row.startedAt,
    lastActivityAt,
    completedAt: row.completedAt ?? null,
    observedSpanSeconds: spanSeconds(row.startedAt, lastActivityAt),
  };
}

/**
 * Builds one bounded workflow snapshot from the authoritative thread state.
 *
 * The caller owns selection. If no thread is selected, the result is the empty
 * snapshot, so a thread or environment switch cannot leave stale nodes on
 * screen.
 */
export function deriveWorkflowProjection(
  input: WorkflowProjectionInput,
): WorkflowProjectionSnapshot {
  if (!input.threadId) {
    return EMPTY_WORKFLOW_SNAPSHOT;
  }
  const latestTurn = input.latestTurn ?? null;
  const threadNodeId = `thread:${input.threadId}`;
  const workflowActivities = input.activities.filter((activity) =>
    WORKFLOW_ACTIVITY_KINDS.has(activity.kind),
  );
  const derivedRows = deriveSubagentActivities(input.activities, input.subagentOptions ?? {});

  const nodeIdBySourceKey = new Map<string, string>();
  const agentNodes: WorkflowNode[] = [];
  const seenNodeIds = new Set<string>([threadNodeId]);
  let duplicateNodeIdCount = 0;
  let omittedNodeCount = 0;
  for (const row of derivedRows) {
    const node = agentNode(row, threadNodeId);
    if (seenNodeIds.has(node.id)) {
      duplicateNodeIdCount += 1;
      continue;
    }
    if (agentNodes.length + 1 >= WORKFLOW_MAX_NODES) {
      omittedNodeCount += 1;
      continue;
    }
    seenNodeIds.add(node.id);
    nodeIdBySourceKey.set(sourceKey(row.turnId ?? null, row.id), node.id);
    agentNodes.push(node);
  }

  const lastWorkflowActivityAt = workflowActivities.at(-1)?.createdAt ?? null;
  const threadStartedAt = latestTurn?.startedAt ?? latestTurn?.requestedAt ?? null;
  const threadLastActivityAt = latestTurn?.completedAt ?? lastWorkflowActivityAt;
  const threadNode: WorkflowNode = {
    id: threadNodeId,
    parentId: null,
    kind: "thread",
    title: boundedLine(input.threadTitle) ?? "Selected thread",
    objective: null,
    detail: null,
    status: threadStatus(latestTurn),
    startedAt: threadStartedAt,
    lastActivityAt: threadLastActivityAt,
    completedAt: latestTurn?.completedAt ?? null,
    observedSpanSeconds: spanSeconds(threadStartedAt, threadLastActivityAt),
  };

  const recognizedActivities = workflowActivities.map<WorkflowActivityEntry>((activity) => {
    const key = activitySourceKey(activity);
    return {
      id: activity.id,
      nodeId: (key === null ? undefined : nodeIdBySourceKey.get(key)) ?? null,
      kind: activity.kind,
      summary: boundedLine(activity.summary) ?? activity.kind,
      tone: activity.tone,
      createdAt: activity.createdAt,
    };
  });
  const recentActivities = recognizedActivities.slice(-WORKFLOW_MAX_RECENT_ACTIVITIES).toReversed();

  const hasLifecycleEdge = workflowActivities.some((activity) => activity.kind.startsWith("task."));
  const hasProgressEdge = workflowActivities.some((activity) => activity.kind === "task.progress");

  return {
    threadId: input.threadId,
    environmentId: input.environmentId,
    turnId: latestTurn?.turnId ?? null,
    fidelity: hasProgressEdge ? "live" : hasLifecycleEdge ? "lifecycle-only" : "not-reported",
    nodes: [threadNode, ...agentNodes],
    recentActivities,
    providerLabel: boundedLine(input.providerLabel),
    modelLabel: boundedLine(input.modelLabel),
    agentCount: agentNodes.length,
    sourceActivityCount: workflowActivities.length,
    omittedNodeCount,
    omittedActivityCount: Math.max(0, recognizedActivities.length - WORKFLOW_MAX_RECENT_ACTIVITIES),
    duplicateNodeIdCount,
  };
}
