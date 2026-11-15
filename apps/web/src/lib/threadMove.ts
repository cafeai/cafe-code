import { isLiveWorkRuntimeCurrent } from "@cafecode/shared/liveWork";

import type { Project, SidebarThreadSummary } from "../types";

/** Shell-only UI admission. The owning backend still checks idleness and the
 * destination before changing the durable association or workspace fence. */
export function canMoveThread(thread: SidebarThreadSummary | null | undefined): boolean {
  if (!thread || thread.archivedAt !== null) return false;
  const session = thread.session;
  if (
    session?.status === "running" ||
    session?.status === "connecting" ||
    session?.orchestrationStatus === "starting" ||
    session?.orchestrationStatus === "running" ||
    session?.activeTurnId != null ||
    thread.latestTurn?.state === "running" ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput
  )
    return false;
  return !(
    thread.liveWork &&
    isLiveWorkRuntimeCurrent(thread.liveWork.runtimeId, session) &&
    thread.liveWork.taskCount + thread.liveWork.agentCount > 0
  );
}

export function threadMoveCandidates(
  projects: readonly Project[],
  thread: SidebarThreadSummary,
): Project[] {
  return projects
    .filter(
      (project) =>
        project.environmentId === thread.environmentId && project.id !== thread.projectId,
    )
    .toSorted(
      (left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
        left.cwd.localeCompare(right.cwd, undefined, { sensitivity: "base" }) ||
        left.id.localeCompare(right.id),
    );
}
