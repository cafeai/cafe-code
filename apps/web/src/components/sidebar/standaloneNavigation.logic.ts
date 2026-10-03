import type { EnvironmentId, OrchestrationShellSnapshot } from "@cafecode/contracts";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";
import type { SidebarThreadSortOrder } from "@cafecode/contracts/settings";
import type { DraftId, DraftSessionState } from "../../composerDraftStore";
import { getThreadSortTimestamp, toSortableTimestamp } from "../../lib/threadSort";
import type { SidebarThreadSummary } from "../../types";

export type StandaloneCatalogEntry =
  | { readonly kind: "server"; readonly key: string; readonly thread: SidebarThreadSummary }
  | {
      readonly kind: "draft";
      readonly key: string;
      readonly draft: DraftSessionState & { draftId: DraftId };
    };

/** Local-only preview; never copy composer text into Desk preferences or RPC. */
export function standaloneDraftTitle(prompt: string): string {
  return (
    prompt
      .slice(0, 512)
      .split(/[\r\n]/, 1)[0]
      ?.trim()
      .slice(0, 100) || "New chat"
  );
}

/**
 * The standalone catalog consumes only shell summaries and local draft metadata.
 * A chat is not represented by a fake project, and duplicate imported ids remain
 * distinct across environments. Promoted drafts are omitted before the catalog
 * sees them, so the server's canonical row owns its title and mutations.
 */
export function buildStandaloneCatalog(input: {
  readonly threads: readonly SidebarThreadSummary[];
  readonly drafts: readonly (DraftSessionState & { draftId: DraftId })[];
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly sortOrder: SidebarThreadSortOrder;
}): StandaloneCatalogEntry[] {
  const threads = input.threads.filter(
    (thread) => thread.projectId === null && thread.archivedAt === null,
  );
  const entries: StandaloneCatalogEntry[] = threads.map((thread) => ({
    kind: "server",
    key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    thread,
  }));
  for (const draft of input.drafts) {
    // Standalone creation is local-only. Never reopen an imported remote draft
    // through the current local Desk merely because its opaque id matches.
    if (
      input.primaryEnvironmentId !== null &&
      draft.environmentId === input.primaryEnvironmentId &&
      draft.projectId === null &&
      draft.promotedTo == null
    ) {
      entries.push({ kind: "draft", key: JSON.stringify(["draft", draft.draftId]), draft });
    }
  }
  return entries.toSorted((left, right) => {
    const timestamp = (entry: StandaloneCatalogEntry): number =>
      entry.kind === "draft"
        ? (toSortableTimestamp(entry.draft.createdAt) ?? Number.NEGATIVE_INFINITY)
        : getThreadSortTimestamp(entry.thread, input.sortOrder);
    const leftTimestamp = timestamp(left);
    const rightTimestamp = timestamp(right);
    return (
      (leftTimestamp === rightTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1) ||
      left.key.localeCompare(right.key)
    );
  });
}

/** The primary environment must remain queryable even without any projects. */
export function historyEnvironmentIds(
  primaryEnvironmentId: EnvironmentId | null,
  projects: readonly { environmentId: EnvironmentId }[],
): EnvironmentId[] {
  return [
    ...new Set([
      ...(primaryEnvironmentId === null ? [] : [primaryEnvironmentId]),
      ...projects.map((project) => project.environmentId),
    ]),
  ];
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
