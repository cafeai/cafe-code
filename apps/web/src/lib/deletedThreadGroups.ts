import {
  MAX_THREAD_GROUP_DEPTH,
  type EnvironmentId,
  type OrchestrationDeletedThreadGroup,
  type OrchestrationShellSnapshot,
  type ThreadId,
} from "@cafecode/contracts";

/**
 * One Recycle Bin entry per deleted agent-created group. Members and nested
 * groups are matched by the same deletion time, which every row of one delete
 * batch shares, so a chat deleted again separately is not counted here.
 * Display/cleanup preview only; the server decides the exact restore set.
 */
export interface DeletedThreadGroupEntry {
  readonly environmentId: EnvironmentId;
  readonly group: OrchestrationDeletedThreadGroup;
  /** Every chat in the group's deleted subtree, for permanent cleanup. */
  readonly threadIds: readonly ThreadId[];
  readonly nestedGroupCount: number;
}

export function collectDeletedThreadGroupEntries(
  snapshots: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly snapshot: OrchestrationShellSnapshot;
  }>,
): DeletedThreadGroupEntry[] {
  const entries: DeletedThreadGroupEntry[] = [];
  for (const { environmentId, snapshot } of snapshots) {
    const groups = snapshot.deletedThreadGroups ?? [];
    if (groups.length === 0) continue;
    const ownerOf = new Set(groups.map((group) => group.ownerThreadId));
    for (const root of groups) {
      // A group nested beneath another deleted group of the same batch is
      // reachable from that entry instead of being listed separately.
      const parentInBatch = snapshot.threads.some(
        (thread) =>
          thread.id === root.ownerThreadId &&
          thread.deletedAt === root.deletedAt &&
          groups.some((group) => group.id === thread.groupId && group.deletedAt === root.deletedAt),
      );
      if (parentInBatch) continue;
      const groupIds = new Set([root.id]);
      const threadIds: ThreadId[] = [];
      const seen = new Set<string>();
      let nestedGroupCount = 0;
      let frontier = [root.id] as string[];
      for (let depth = 0; depth <= MAX_THREAD_GROUP_DEPTH && frontier.length > 0; depth += 1) {
        const next: string[] = [];
        for (const thread of snapshot.threads) {
          if (
            !thread.groupId ||
            !frontier.includes(thread.groupId) ||
            thread.deletedAt !== root.deletedAt ||
            seen.has(thread.id)
          )
            continue;
          seen.add(thread.id);
          threadIds.push(thread.id);
          if (!ownerOf.has(thread.id)) continue;
          for (const group of groups) {
            if (
              group.ownerThreadId === thread.id &&
              group.deletedAt === root.deletedAt &&
              !groupIds.has(group.id)
            ) {
              groupIds.add(group.id);
              nestedGroupCount += 1;
              next.push(group.id);
            }
          }
        }
        frontier = next;
      }
      if (threadIds.length > 0)
        entries.push({ environmentId, group: root, threadIds, nestedGroupCount });
    }
  }
  return entries;
}
