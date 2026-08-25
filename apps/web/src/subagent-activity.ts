import type { OrchestrationThreadActivity, TurnId } from "@cafecode/contracts";

export type SubagentRunStatus = "waiting" | "active" | "completed" | "failed" | "stopped";

export interface DerivedSubagentActivity {
  /** Provider child-thread/task identity; also the deterministic avatar seed. */
  id: string;
  /** Stable renderer row identity from the first durable lifecycle activity. */
  rowId: string;
  turnId: TurnId | null;
  label: string;
  objective?: string;
  description?: string;
  status: SubagentRunStatus;
  startedAt: string;
  updatedAt: string;
  /**
   * Durable provider-neutral invalidation token for the latest lifecycle edge.
   * Timestamps are display metadata and can collide; the activity sequence/id
   * pair is the authoritative revision used by an open detail view.
   */
  lifecycleRevision: string;
  completedAt?: string;
  /**
   * Opaque provider history binding used only when requesting this child's
   * transcript. It is deliberately never presented as text or used as a DOM
   * identity: Claude task ids and transcript ids are separate namespaces.
   */
  historyId?: string;
}

const DISPLAY_TEXT_LIMIT = 240;
const ID_TEXT_LIMIT = 512;

export interface DeriveSubagentActivityOptions {
  /** Legacy prose-only rows on these known-terminal turns cannot receive a new structured edge. */
  readonly terminalTurnIds?: ReadonlySet<TurnId> | undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeLine(value: unknown, limit = DISPLAY_TEXT_LIMIT): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\p{Cc}\p{Bidi_Control}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function exactOpaqueIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Provider identities are authorization material, not display text. Never
  // normalize an accepted identity: even collapsing two spaces would turn the
  // persisted exact binding into a different provider key. Control characters
  // fail closed, but ordinary leading/trailing whitespace remains byte-exact:
  // this value is never rendered, used as a DOM id, or written to a log.
  return value.length > 0 &&
    value.length <= ID_TEXT_LIMIT &&
    !/[\p{Cc}\p{Bidi_Control}]/u.test(value)
    ? value
    : undefined;
}

function lifecycleRevision(activity: OrchestrationThreadActivity): string {
  // A length prefix keeps the fallback unambiguous even when an imported
  // activity id contains punctuation. Sequence is preferred because it is the
  // durable provider/orchestration order; id disambiguates defensive fixtures
  // that reuse a sequence.
  const id = String(activity.id);
  return activity.sequence === undefined
    ? `id:${id.length}:${id}`
    : `sequence:${activity.sequence}:${id.length}:${id}`;
}

function pathLabel(path: string | undefined): string | undefined {
  const leaf = path
    ?.split("/")
    .map((part) => part.trim())
    .findLast((part) => part.length > 0 && part !== "root");
  const normalized = safeLine(
    leaf?.replace(/^@+/u, "").replace(/[_-]+/gu, " "),
  )?.toLocaleLowerCase();
  return normalized
    ? `${normalized.charAt(0).toLocaleUpperCase()}${normalized.slice(1)}`
    : undefined;
}

function compareActivityOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (
    left.sequence !== undefined &&
    right.sequence !== undefined &&
    left.sequence !== right.sequence
  ) {
    return left.sequence - right.sequence;
  }
  const byTime = left.createdAt.localeCompare(right.createdAt);
  return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
}

function structuredStatus(
  value: unknown,
  activityKind: OrchestrationThreadActivity["kind"],
): SubagentRunStatus {
  // The canonical activity edge is authoritative. Presentation metadata is
  // repeated from provider state and can lag by one notification; allowing a
  // stale `active` descriptor to override task.completed would leave a worker
  // spinning forever even though payload.status is terminal.
  if (activityKind === "task.completed") return "completed";
  if (
    value === "waiting" ||
    value === "active" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped"
  ) {
    return value;
  }
  if (activityKind === "task.started" || activityKind === "task.progress") return "active";
  return "active";
}

function terminalStatusFromPayload(
  payload: Record<string, unknown>,
  fallback: SubagentRunStatus,
): SubagentRunStatus {
  return payload.status === "failed"
    ? "failed"
    : payload.status === "stopped"
      ? "stopped"
      : fallback;
}

function subagentMapKey(activity: OrchestrationThreadActivity, id: string): string {
  return JSON.stringify([activity.turnId ?? null, id]);
}

function upsertStructuredSubagent(
  byId: Map<string, DerivedSubagentActivity>,
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
): boolean {
  const presentation = record(payload.subagent);
  if (!presentation) return false;
  const id = exactOpaqueIdentity(presentation.threadId) ?? exactOpaqueIdentity(payload.taskId);
  if (!id) return true;

  const key = subagentMapKey(activity, id);
  const previous = byId.get(key);
  const explicitStartedAt = safeLine(presentation.startedAt, 80);
  const previousTerminal =
    previous?.status === "completed" ||
    previous?.status === "failed" ||
    previous?.status === "stopped";
  const isRestart = activity.kind === "task.started" && previousTerminal;
  // Durable provider order is authoritative. A delayed/replayed progress edge
  // after completion must not resurrect a child or restart its clock. Only an
  // explicit new task.started edge can reopen the same provider identity.
  if (previousTerminal && !isRestart) return true;
  const status = terminalStatusFromPayload(
    payload,
    structuredStatus(presentation.status, activity.kind),
  );
  const objective = safeLine(presentation.objective) ?? previous?.objective;
  const historyId = exactOpaqueIdentity(presentation.historyId) ?? previous?.historyId;
  const detail = safeLine(payload.detail);
  const meaningfulDetail = detail && !/^working(?:\.{3})?$/iu.test(detail) ? detail : undefined;
  const nextDescription = isRestart
    ? meaningfulDetail
    : activity.kind === "task.progress"
      ? (meaningfulDetail ?? previous?.description)
      : activity.kind === "task.completed" && (status === "failed" || status === "stopped")
        ? (meaningfulDetail ?? previous?.description)
        : (previous?.description ?? meaningfulDetail);
  const label =
    safeLine(presentation.label, 96) ??
    pathLabel(safeLine(presentation.path, 256)) ??
    previous?.label ??
    "Subagent";
  const startedAt =
    isRestart || !previous
      ? (explicitStartedAt ?? activity.createdAt)
      : activity.kind === "task.started" && explicitStartedAt
        ? explicitStartedAt
        : previous.startedAt;
  const terminal = status === "completed" || status === "failed" || status === "stopped";

  byId.set(key, {
    id,
    rowId: previous?.rowId ?? activity.id,
    turnId: activity.turnId,
    label,
    ...(objective ? { objective } : {}),
    ...(nextDescription ? { description: nextDescription } : {}),
    status,
    startedAt,
    updatedAt: activity.createdAt,
    lifecycleRevision: lifecycleRevision(activity),
    ...(historyId ? { historyId } : {}),
    ...(terminal
      ? { completedAt: activity.createdAt }
      : previous?.completedAt && !isRestart
        ? { completedAt: previous.completedAt }
        : {}),
  });
  return true;
}

function splitLegacyDetail(detail: string): { label: string; description: string } {
  const colon = detail.indexOf(":");
  if (colon > 0 && colon <= 40) {
    const label = safeLine(detail.slice(0, colon), 96);
    const description = safeLine(detail.slice(colon + 1));
    if (label && description) return { label, description };
  }
  const action = /^(?:Started|Interacted with|Interrupted)\s+(.+)$/iu.exec(detail);
  if (action?.[1]) {
    const path = safeLine(action[1], 256);
    return {
      label: pathLabel(path) ?? "Subagent",
      description: /^Interrupted\b/iu.test(detail) ? "Interrupted" : "Working",
    };
  }
  return { label: "Subagent", description: detail };
}

function legacySubagentStatus(
  activity: OrchestrationThreadActivity,
  detail: string,
  terminalTurnIds: ReadonlySet<TurnId> | undefined,
): SubagentRunStatus {
  if (/^Interrupted\b/iu.test(detail)) return "stopped";
  if (activity.turnId !== null && terminalTurnIds?.has(activity.turnId)) return "completed";
  // A Codex v2 `Started`/`Interacted` item completes immediately around the
  // control-plane interaction, not around the child task. Keep it active until
  // a structured child task terminal event arrives.
  if (/^(?:Started|Interacted with)\b/iu.test(detail)) return "active";
  return activity.kind === "tool.completed" ? "completed" : "active";
}

function upsertLegacySubagent(
  byId: Map<string, DerivedSubagentActivity>,
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
  options: DeriveSubagentActivityOptions,
): void {
  if (payload.itemType !== "collab_agent_tool_call") return;
  const detail = safeLine(payload.detail) ?? safeLine(activity.summary);
  if (!detail) return;
  const data = record(payload.data);
  const item = record(data?.item);
  const id =
    exactOpaqueIdentity(item?.agentThreadId) ??
    exactOpaqueIdentity(payload.itemId) ??
    exactOpaqueIdentity(activity.id);
  if (!id) return;
  const key = subagentMapKey(activity, id);
  const previous = byId.get(key);
  const split = splitLegacyDetail(detail);
  const status = legacySubagentStatus(activity, detail, options.terminalTurnIds);
  const terminal = status === "completed" || status === "failed" || status === "stopped";
  byId.set(key, {
    id,
    rowId: previous?.rowId ?? activity.id,
    turnId: activity.turnId,
    label: split.label || previous?.label || "Subagent",
    ...(previous?.objective ? { objective: previous.objective } : {}),
    description: split.description || previous?.description || "Working",
    status,
    startedAt: previous?.startedAt ?? activity.createdAt,
    updatedAt: activity.createdAt,
    lifecycleRevision: lifecycleRevision(activity),
    ...(terminal ? { completedAt: activity.createdAt } : {}),
  });
}

/**
 * Coalesces provider-neutral `task.*` subagent lifecycle into one row per child.
 *
 * The legacy item fallback keeps already-persisted Codex/Claude work visible
 * after upgrades. New events never depend on prose parsing: child identity,
 * status, objective, and timing are taken from the structured presentation
 * object emitted at the provider boundary.
 */
export function deriveSubagentActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options: DeriveSubagentActivityOptions = {},
): DerivedSubagentActivity[] {
  const byId = new Map<string, DerivedSubagentActivity>();
  // Detail snapshots and session derivation already provide monotonic activity
  // order. Avoid a second clone/sort on every Atrium clock tick; retain the
  // defensive sort only for imported or test data that is actually unordered.
  const ordered = activities.every(
    (activity, index) => index === 0 || compareActivityOrder(activities[index - 1]!, activity) <= 0,
  )
    ? activities
    : [...activities].toSorted(compareActivityOrder);
  for (const activity of ordered) {
    const payload = record(activity.payload);
    if (!payload) continue;
    if (upsertStructuredSubagent(byId, activity, payload)) continue;
    upsertLegacySubagent(byId, activity, payload, options);
  }
  return [...byId.values()].toSorted((left, right) => {
    const leftLive = left.status === "active" || left.status === "waiting";
    const rightLive = right.status === "active" || right.status === "waiting";
    if (leftLive !== rightLive) return Number(rightLive) - Number(leftLive);
    return left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id);
  });
}
