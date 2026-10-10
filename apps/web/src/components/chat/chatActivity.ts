import type {
  OrchestrationLiveWork,
  OrchestrationThreadActivity,
  TurnId,
} from "@cafecode/contracts";
import { deriveLiveWorkObservations, isLiveWorkRuntimeCurrent } from "@cafecode/shared/liveWork";
import type { SubagentRuntimeContext } from "../../subagent-activity";
import { readComputerUsePresentation } from "./computerUsePresentation";

export interface ChatActivityPresentation {
  label: string;
  attention: boolean;
  taskCount: number;
  agentCount: number;
  canInspect: boolean;
}

export function deriveForegroundTools(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null,
  running: boolean,
) {
  if (!running || !turnId) return [];
  const heads = new Map<string, OrchestrationThreadActivity>();
  for (const activity of activities
    .filter((entry) => entry.turnId === turnId)
    .toSorted((a, b) =>
      a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence
        ? a.sequence - b.sequence
        : a.createdAt.localeCompare(b.createdAt) || String(a.id).localeCompare(String(b.id)),
    )) {
    if (!activity.kind.startsWith("tool.")) continue;
    const payload = activity.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.itemId !== "string") continue;
    heads.delete(payload.itemId);
    if (
      activity.kind.endsWith(".completed") ||
      ["completed", "failed", "error", "cancelled"].includes(String(payload.status))
    )
      continue;
    if (payload.detail === "Continuing in the background") continue;
    heads.set(payload.itemId, activity);
  }
  return [...heads.values()];
}

export function deriveChatActivityPresentation(input: {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  runtimeSession: SubagentRuntimeContext | null;
  liveWork?: OrchestrationLiveWork | undefined;
  turnId: TurnId | null;
  running: boolean;
  preparing: boolean;
  connecting: boolean;
  streaming: boolean;
  approvalCount: number;
  questionCount: number;
}): ChatActivityPresentation | null {
  const live = deriveLiveWorkObservations(input.activities, input.runtimeSession);
  const foreground = deriveForegroundTools(input.activities, input.turnId, input.running);
  const summary = isLiveWorkRuntimeCurrent(input.liveWork?.runtimeId, input.runtimeSession)
    ? input.liveWork
    : undefined;
  const agentCount =
    summary?.agentCount ?? live.filter(({ observation }) => observation.agent).length;
  const taskCount =
    summary?.taskCount ?? live.filter(({ observation }) => !observation.agent).length;
  const canInspect = taskCount + agentCount + foreground.length > 0;
  const base = { attention: false, taskCount, agentCount, canInspect };
  if (input.approvalCount)
    return { ...base, label: "Waiting for approval", attention: true, canInspect: false };
  if (input.questionCount)
    return { ...base, label: "Waiting for your answer", attention: true, canInspect: false };
  if (input.connecting) return { ...base, label: "Connecting…", canInspect: false };
  if (input.preparing) return { ...base, label: "Preparing workspace…", canInspect: false };
  if (input.running && input.streaming) return { ...base, label: "Working…" };
  if (input.running && foreground.length) {
    const latest = foreground.at(-1)!;
    const computer = readComputerUsePresentation(latest);
    const itemType = (latest.payload as Record<string, unknown> | null)?.itemType;
    return {
      ...base,
      label:
        computer?.active ??
        (itemType === "command_execution"
          ? "Running command…"
          : itemType === "context_compaction"
            ? "Compacting context…"
            : "Waiting for a tool…"),
    };
  }
  if (input.running && agentCount)
    return {
      ...base,
      label: `Waiting for ${agentCount} ${agentCount === 1 ? "agent" : "agents"}…`,
    };
  if (input.running && taskCount)
    return {
      ...base,
      label: `Waiting for ${taskCount} background ${taskCount === 1 ? "task" : "tasks"}…`,
    };
  if (input.running) return { ...base, label: "Working…" };
  if (agentCount || taskCount) {
    const parts = [
      taskCount ? `${taskCount} ${taskCount === 1 ? "task" : "tasks"}` : null,
      agentCount ? `${agentCount} ${agentCount === 1 ? "agent" : "agents"}` : null,
    ].filter(Boolean);
    return { ...base, label: `Background work running · ${parts.join(" · ")}` };
  }
  return null;
}
