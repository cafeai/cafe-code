import {
  MAX_THREAD_GROUP_DEPTH,
  type EnvironmentId,
  type ThreadGroupId,
  type ThreadId,
} from "@cafecode/contracts";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";

import type { SidebarThreadSummary } from "../../types";

/**
 * Sidebar containment for agent-created groups: thread → group → member →
 * group …. Pure presentation derived from shell summaries; it never changes a
 * chat, a group or any provider state.
 */
export interface SidebarThreadGroupNode {
  /** Stable key for expansion state and React lists. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly groupId: ThreadGroupId;
  readonly title: string;
  readonly ownerKey: string;
  readonly ownerThreadId: ThreadId;
  /** Direct members, in creation order. */
  readonly members: readonly SidebarThreadSummary[];
}

export interface SidebarThreadGroupIndex {
  readonly groupsByOwnerKey: ReadonlyMap<string, readonly SidebarThreadGroupNode[]>;
  /**
   * Chats shown beneath a group and therefore omitted from top-level lists.
   * Only members reachable from a visible top-level parent are listed, so a
   * malformed cycle or an absent parent falls back to showing the chat at top
   * level instead of hiding it.
   */
  readonly nestedThreadKeys: ReadonlySet<string>;
}

export const EMPTY_SIDEBAR_THREAD_GROUP_INDEX: SidebarThreadGroupIndex = {
  groupsByOwnerKey: new Map(),
  nestedThreadKeys: new Set(),
};

export function sidebarThreadGroupKey(environmentId: EnvironmentId, groupId: ThreadGroupId) {
  return JSON.stringify([environmentId, groupId]);
}

function threadKeyOf(thread: SidebarThreadSummary) {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function compareMembers(left: SidebarThreadSummary, right: SidebarThreadSummary) {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function buildSidebarThreadGroupIndex(
  threads: readonly SidebarThreadSummary[],
): SidebarThreadGroupIndex {
  const ownerKeyByGroupKey = new Map<string, string>();
  const ownerIdByGroupKey = new Map<string, ThreadId>();
  const titleByGroupKey = new Map<string, string>();
  for (const thread of threads) {
    for (const group of thread.ownedGroups ?? []) {
      const key = sidebarThreadGroupKey(thread.environmentId, group.id);
      ownerKeyByGroupKey.set(key, threadKeyOf(thread));
      ownerIdByGroupKey.set(key, thread.id);
      titleByGroupKey.set(key, group.title);
    }
  }
  if (ownerKeyByGroupKey.size === 0) return EMPTY_SIDEBAR_THREAD_GROUP_INDEX;

  const membersByGroupKey = new Map<string, SidebarThreadSummary[]>();
  const candidateKeys = new Set<string>();
  for (const thread of threads) {
    if (!thread.groupId) continue;
    const groupKey = sidebarThreadGroupKey(thread.environmentId, thread.groupId);
    const ownerKey = ownerKeyByGroupKey.get(groupKey);
    if (ownerKey === undefined || ownerKey === threadKeyOf(thread)) continue;
    const members = membersByGroupKey.get(groupKey) ?? [];
    members.push(thread);
    membersByGroupKey.set(groupKey, members);
    candidateKeys.add(threadKeyOf(thread));
  }

  const nodesByOwnerKey = new Map<string, SidebarThreadGroupNode[]>();
  for (const [groupKey, members] of membersByGroupKey) {
    const ownerKey = ownerKeyByGroupKey.get(groupKey)!;
    const [environmentId, groupId] = JSON.parse(groupKey) as [EnvironmentId, ThreadGroupId];
    const nodes = nodesByOwnerKey.get(ownerKey) ?? [];
    nodes.push({
      key: groupKey,
      environmentId,
      groupId,
      title: titleByGroupKey.get(groupKey) ?? "",
      ownerKey,
      ownerThreadId: ownerIdByGroupKey.get(groupKey)!,
      members: members.toSorted(compareMembers),
    });
    nodesByOwnerKey.set(ownerKey, nodes);
  }

  // Walk downward from top-level parents (chats that are not candidates).
  const nestedThreadKeys = new Set<string>();
  let frontier = threads.map(threadKeyOf).filter((key) => !candidateKeys.has(key));
  for (let depth = 0; depth < MAX_THREAD_GROUP_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const ownerKey of frontier) {
      for (const node of nodesByOwnerKey.get(ownerKey) ?? []) {
        for (const member of node.members) {
          const memberKey = threadKeyOf(member);
          if (nestedThreadKeys.has(memberKey)) continue;
          nestedThreadKeys.add(memberKey);
          next.push(memberKey);
        }
      }
    }
    frontier = next;
  }

  // Render only groups whose members were actually reached, keeping the
  // owner's creation order of its groups.
  const groupsByOwnerKey = new Map<string, readonly SidebarThreadGroupNode[]>();
  for (const [ownerKey, nodes] of nodesByOwnerKey) {
    const visible: SidebarThreadGroupNode[] = [];
    for (const node of nodes) {
      const members = node.members.filter((member) => nestedThreadKeys.has(threadKeyOf(member)));
      if (members.length > 0) visible.push(Object.assign({}, node, { members }));
    }
    if (visible.length > 0) groupsByOwnerKey.set(ownerKey, visible);
  }
  return { groupsByOwnerKey, nestedThreadKeys };
}

/** Every chat beneath a group, including nested groups (for status summaries). */
export function collectSidebarGroupDescendants(
  index: SidebarThreadGroupIndex,
  node: SidebarThreadGroupNode,
): SidebarThreadSummary[] {
  const result: SidebarThreadSummary[] = [];
  const seen = new Set<string>();
  const visit = (current: SidebarThreadGroupNode, depth: number) => {
    if (depth > MAX_THREAD_GROUP_DEPTH) return;
    for (const member of current.members) {
      const key = threadKeyOf(member);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(member);
      for (const child of index.groupsByOwnerKey.get(key) ?? []) visit(child, depth + 1);
    }
  };
  visit(node, 1);
  return result;
}

/** Group keys on the path to the routed chat, so it is never hidden. */
export function sidebarGroupKeysContaining(
  index: SidebarThreadGroupIndex,
  threadKey: string | null,
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!threadKey || !index.nestedThreadKeys.has(threadKey)) return keys;
  const parentByThreadKey = new Map<string, SidebarThreadGroupNode>();
  for (const nodes of index.groupsByOwnerKey.values()) {
    for (const node of nodes) {
      for (const member of node.members) parentByThreadKey.set(threadKeyOf(member), node);
    }
  }
  let current: string | undefined = threadKey;
  for (let depth = 0; current && depth < MAX_THREAD_GROUP_DEPTH; depth += 1) {
    const node = parentByThreadKey.get(current);
    if (!node || keys.has(node.key)) break;
    keys.add(node.key);
    current = node.ownerKey;
  }
  return keys;
}

/** Top-level chat whose group tree contains `threadKey` (itself when top level). */
export function sidebarRootThreadKey(
  index: SidebarThreadGroupIndex,
  threadKey: string | null,
): string | null {
  if (!threadKey || !index.nestedThreadKeys.has(threadKey)) return threadKey;
  const ownerByMemberKey = new Map<string, string>();
  for (const nodes of index.groupsByOwnerKey.values()) {
    for (const node of nodes) {
      for (const member of node.members) ownerByMemberKey.set(threadKeyOf(member), node.ownerKey);
    }
  }
  let current = threadKey;
  for (let depth = 0; depth < MAX_THREAD_GROUP_DEPTH; depth += 1) {
    const owner = ownerByMemberKey.get(current);
    if (!owner) return current;
    current = owner;
  }
  return current;
}
