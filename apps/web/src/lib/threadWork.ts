import { isLiveWorkRuntimeCurrent } from "@cafecode/shared/liveWork";

import type { SidebarThreadSummary } from "../types";

/** Live shell evidence, including work that outlasts the root turn. */
export function hasActiveThreadWork(thread: SidebarThreadSummary | undefined): boolean {
  if (!thread) return false;
  const { session, latestTurn, liveWork } = thread;
  return (
    session?.status === "running" ||
    session?.status === "connecting" ||
    session?.orchestrationStatus === "starting" ||
    session?.orchestrationStatus === "running" ||
    session?.activeTurnId != null ||
    latestTurn?.state === "running" ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    (liveWork !== undefined &&
      isLiveWorkRuntimeCurrent(liveWork.runtimeId, session) &&
      liveWork.taskCount + liveWork.agentCount > 0)
  );
}
