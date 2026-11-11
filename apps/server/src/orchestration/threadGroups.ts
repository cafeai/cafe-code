/**
 * Pure group/containment traversal for the orchestration decider.
 *
 * Hierarchy: thread → owned group → member thread → owned group → …
 * Traversal is bounded by MAX_THREAD_GROUP_DEPTH and a visited set, so a
 * corrupted cycle can never loop. These helpers decide organisation only;
 * they never grant permission, native ownership or retry authority.
 */
import {
  MAX_THREAD_GROUP_DEPTH,
  type CommandId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadGroup,
  type ThreadGroupId,
  type ThreadId,
} from "@cafecode/contracts";

export function threadGroups(readModel: OrchestrationReadModel) {
  return readModel.threadGroups ?? [];
}

export function findThreadGroup(
  readModel: OrchestrationReadModel,
  groupId: ThreadGroupId,
): OrchestrationThreadGroup | undefined {
  return threadGroups(readModel).find((group) => group.id === groupId);
}

export function liveGroupsOwnedBy(readModel: OrchestrationReadModel, ownerThreadId: ThreadId) {
  return threadGroups(readModel).filter(
    (group) => group.ownerThreadId === ownerThreadId && group.deletedAt === null,
  );
}

/**
 * Depth of a group: 1 when its owner is top level, otherwise one more than
 * the owner's own group. Returns Infinity for a malformed chain so callers
 * refuse rather than loop.
 */
export function threadGroupDepth(
  readModel: OrchestrationReadModel,
  group: OrchestrationThreadGroup,
): number {
  const visited = new Set<string>();
  let depth = 1;
  let current: OrchestrationThreadGroup | undefined = group;
  while (current) {
    if (visited.has(current.id) || depth > MAX_THREAD_GROUP_DEPTH + 1) return Infinity;
    visited.add(current.id);
    const ownerId: ThreadId = current.ownerThreadId;
    const owner = readModel.threads.find((thread) => thread.id === ownerId);
    const parentGroupId = owner?.groupId ?? null;
    if (parentGroupId === null) return depth;
    current = findThreadGroup(readModel, parentGroupId);
    if (!current) return depth;
    depth += 1;
  }
  return depth;
}

export interface ContainmentClosure {
  readonly groups: ReadonlyArray<OrchestrationThreadGroup>;
  readonly threads: ReadonlyArray<OrchestrationThread>;
}

/**
 * Every live group reachable downward from the roots, and every member of
 * those groups selected by `includeThread`. Members' own live groups join the
 * closure, so nested delegation is covered. Roots themselves are included.
 */
function collectDownward(
  readModel: OrchestrationReadModel,
  rootGroups: ReadonlyArray<OrchestrationThreadGroup>,
  includeGroup: (group: OrchestrationThreadGroup) => boolean,
  includeThread: (thread: OrchestrationThread) => boolean,
): ContainmentClosure {
  const groups: OrchestrationThreadGroup[] = [];
  const threads: OrchestrationThread[] = [];
  const seenGroups = new Set<string>();
  const seenThreads = new Set<string>();
  let frontier = rootGroups.filter(includeGroup);
  for (let level = 0; level < MAX_THREAD_GROUP_DEPTH + 1 && frontier.length > 0; level += 1) {
    const next: OrchestrationThreadGroup[] = [];
    for (const group of frontier) {
      if (seenGroups.has(group.id)) continue;
      seenGroups.add(group.id);
      groups.push(group);
      for (const thread of readModel.threads) {
        if (thread.groupId !== group.id || seenThreads.has(thread.id)) continue;
        if (!includeThread(thread)) continue;
        seenThreads.add(thread.id);
        threads.push(thread);
        for (const owned of threadGroups(readModel)) {
          if (owned.ownerThreadId === thread.id && includeGroup(owned)) next.push(owned);
        }
      }
    }
    frontier = next;
  }
  return { groups, threads };
}

/** Live groups and non-deleted members beneath the given live roots. */
export function collectDeletionClosure(
  readModel: OrchestrationReadModel,
  rootGroups: ReadonlyArray<OrchestrationThreadGroup>,
): ContainmentClosure {
  return collectDownward(
    readModel,
    rootGroups,
    (group) => group.deletedAt === null,
    (thread) => thread.deletedAt === null,
  );
}

/**
 * Restore is bounded twice: only rows reachable downward from the chosen
 * roots, and only rows still carrying the exact deletion incarnation. A
 * sibling group deleted by the same parent cascade is not reachable from a
 * different root; a member restored and then deleted again later carries a
 * newer deletion ID.
 */
export function collectRestoreClosure(
  readModel: OrchestrationReadModel,
  rootGroups: ReadonlyArray<OrchestrationThreadGroup>,
  deletionId: CommandId,
): ContainmentClosure {
  return collectDownward(
    readModel,
    rootGroups,
    (group) => group.deletedAt !== null && group.deletionId === deletionId,
    (thread) => thread.deletedAt !== null && thread.deletionId === deletionId,
  );
}

/** Non-archived members beneath an owner's live groups (archive cascade). */
export function collectArchiveClosure(
  readModel: OrchestrationReadModel,
  ownerThreadId: ThreadId,
): ContainmentClosure {
  return collectDownward(
    readModel,
    liveGroupsOwnedBy(readModel, ownerThreadId),
    (group) => group.deletedAt === null,
    (thread) => thread.deletedAt === null,
  );
}

export function normalizedGroupTitle(title: string) {
  return title.trim().toLocaleLowerCase("en-US");
}
