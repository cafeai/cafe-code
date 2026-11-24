import { scopedThreadKey } from "@cafecode/client-runtime";
import type { EnvironmentId } from "@cafecode/contracts";

import type { DraftSessionState } from "../../composerDraftStore";
import type { DeskGroup, DeskState } from "../../deskModel";
import { hasActiveThreadWork } from "../../lib/threadWork";
import { selectSidebarThreadSummaryByRef, type AppState } from "../../store";
import type { ThreadRouteTarget } from "../../threadRoutes";
import type {
  SidebarThreadGroupIndex,
  SidebarThreadGroupNode,
} from "../sidebar/threadGroups.logic";

type DraftSessions = Readonly<Record<string, DraftSessionState>>;

export function hasDeskTargetWork(
  state: AppState,
  drafts: DraftSessions,
  target: ThreadRouteTarget | undefined,
  sendInFlight?: (environmentId: string, threadId: string) => boolean,
): boolean {
  const draft = target?.kind === "draft" ? drafts[target.draftId] : undefined;
  const ref = target?.kind === "server" ? target.threadRef : draft?.promotedTo;
  if (hasActiveThreadWork(selectSidebarThreadSummaryByRef(state, ref))) return true;
  if (!sendInFlight) return false;
  if (ref) return sendInFlight(ref.environmentId, ref.threadId);
  return draft !== undefined && sendInFlight(draft.environmentId, draft.threadId);
}

type DeskSidebarTab = {
  readonly kind: "tab";
  readonly tabKey: string;
  readonly groups: DeskSidebarThreadGroup[];
};

type DeskSidebarThreadGroup = {
  readonly kind: "group";
  readonly node: SidebarThreadGroupNode;
  readonly entries: DeskSidebarEntry[];
  readonly tabKeys: string[];
};

export type DeskSidebarEntry = DeskSidebarTab | DeskSidebarThreadGroup;

/** Project one pane's open tabs onto the catalog's validated group tree. A
 * group with open descendants survives even when its owner has no tab here. */
export function buildDeskSidebarEntries(
  pane: DeskGroup,
  targets: DeskState["targets"],
  drafts: DraftSessions,
  index: SidebarThreadGroupIndex,
): DeskSidebarEntry[] {
  const roots: DeskSidebarEntry[] = [];
  const tabsByThreadKey = new Map<string, DeskSidebarTab>();
  const tabs = pane.tabs.flatMap((tabKey) => {
    const target = targets[tabKey];
    if (!target) return [];
    const ref = target.kind === "server" ? target.threadRef : drafts[target.draftId]?.promotedTo;
    const threadKey = ref ? scopedThreadKey(ref) : undefined;
    const tab: DeskSidebarTab = { kind: "tab", tabKey, groups: [] };
    if (threadKey) tabsByThreadKey.set(threadKey, tab);
    return [{ tab, threadKey, environmentId: ref?.environmentId }];
  });
  const groupsByKey = new Map<string, DeskSidebarThreadGroup>();
  const parentGroup = (
    threadKey: string,
    environmentId: EnvironmentId,
  ): DeskSidebarThreadGroup | undefined => {
    const node = index.parentGroupByMemberKey.get(threadKey);
    if (!node || node.environmentId !== environmentId) return undefined;
    const existing = groupsByKey.get(node.key);
    if (existing) return existing;
    const group: DeskSidebarThreadGroup = { kind: "group", node, entries: [], tabKeys: [] };
    groupsByKey.set(node.key, group);
    const owner = tabsByThreadKey.get(node.ownerKey);
    if (owner) owner.groups.push(group);
    else (parentGroup(node.ownerKey, environmentId)?.entries ?? roots).push(group);
    return group;
  };

  for (const { tab, threadKey, environmentId } of tabs) {
    let group = threadKey && environmentId ? parentGroup(threadKey, environmentId) : undefined;
    (group?.entries ?? roots).push(tab);
    while (group) {
      group.tabKeys.push(tab.tabKey);
      group = parentGroup(group.node.ownerKey, group.node.environmentId);
    }
  }
  return roots;
}
