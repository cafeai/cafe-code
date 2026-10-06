import type { EnvironmentId, OrchestrationShellSnapshot } from "@cafecode/contracts";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";
import type { SidebarThreadSortOrder } from "@cafecode/contracts/settings";
import { getThreadSortTimestamp } from "../../lib/threadSort";
import type { SidebarThreadSummary } from "../../types";

export interface StandaloneCatalogEntry {
  readonly key: string;
  readonly thread: SidebarThreadSummary;
}

/**
 * Match the project catalog: only canonical server shells are saved chats.
 * Local unsent drafts remain in their composer/Desk views until first send;
 * opening a new editor never adds a conversation to this catalog.
 * Duplicate imported ids remain distinct across environments.
 */
export function buildStandaloneCatalog(input: {
  readonly threads: readonly SidebarThreadSummary[];
  readonly sortOrder: SidebarThreadSortOrder;
}): StandaloneCatalogEntry[] {
  return input.threads
    .filter((thread) => thread.projectId === null && thread.archivedAt === null)
    .map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    }))
    .toSorted((left, right) => {
      const leftTimestamp = getThreadSortTimestamp(left.thread, input.sortOrder);
      const rightTimestamp = getThreadSortTimestamp(right.thread, input.sortOrder);
      return (
        (leftTimestamp === rightTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1) ||
        left.key.localeCompare(right.key)
      );
    });
}

type HistoryThread = OrchestrationShellSnapshot["threads"][number] & {
  environmentId: EnvironmentId;
};
type HistoryProject = {
  id: OrchestrationShellSnapshot["projects"][number]["id"];
  environmentId: EnvironmentId;
  name: string;
  cwd: string;
};
export interface ThreadHistoryGroup {
  readonly groupKey: string;
  readonly environmentId: EnvironmentId;
  /** Null is a presentation-only Chats group, never a project identifier. */
  readonly project: HistoryProject | null;
  readonly threads: HistoryThread[];
}

/** Archive/recycle-bin grouping stays environment-bound and shell-only. */
export function groupThreadHistory(
  snapshots: readonly { environmentId: EnvironmentId; snapshot: OrchestrationShellSnapshot }[],
  mode: "archived" | "deleted",
): ThreadHistoryGroup[] {
  const groups: ThreadHistoryGroup[] = [];
  for (const { environmentId, snapshot } of snapshots) {
    const byProject = new Map<string | null, HistoryThread[]>();
    for (const thread of snapshot.threads) {
      const rows = byProject.get(thread.projectId) ?? [];
      rows.push({ ...thread, environmentId });
      byProject.set(thread.projectId, rows);
    }
    const projectById = new Map<string, OrchestrationShellSnapshot["projects"][number]>(
      snapshot.projects.map((project) => [project.id, project]),
    );
    for (const [projectId, threads] of byProject) {
      const project = projectId === null ? null : projectById.get(projectId);
      // Missing real project metadata must not be silently relabeled Chats.
      if (projectId !== null && !project) continue;
      groups.push({
        groupKey: JSON.stringify([environmentId, projectId]),
        environmentId,
        project: project
          ? { id: project.id, environmentId, name: project.title, cwd: project.workspaceRoot }
          : null,
        threads: threads.toSorted((left, right) => {
          const leftKey =
            mode === "archived"
              ? (left.archivedAt ?? left.createdAt)
              : (left.deletedAt ?? left.updatedAt);
          const rightKey =
            mode === "archived"
              ? (right.archivedAt ?? right.createdAt)
              : (right.deletedAt ?? right.updatedAt);
          return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
        }),
      });
    }
  }
  return groups;
}
