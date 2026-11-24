import type { Project, SidebarThreadSummary } from "../types";
import { hasActiveThreadWork } from "./threadWork";

/** Shell-only UI admission. The owning backend still checks idleness and the
 * destination before changing the durable association or workspace fence. */
export function canMoveThread(thread: SidebarThreadSummary | null | undefined): boolean {
  return thread?.archivedAt === null && !hasActiveThreadWork(thread);
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
