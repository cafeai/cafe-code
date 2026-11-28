import { scopedThreadKey } from "@cafecode/client-runtime";
import { MAX_THREAD_GROUP_DEPTH } from "@cafecode/contracts";

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
  readonly target: ThreadRouteTarget;
  readonly threadKey: string | undefined;
};

type DeskSidebarThreadGroup = {
  readonly kind: "group";
  readonly node: SidebarThreadGroupNode;
};

export type DeskSidebarEntry = DeskSidebarTab | DeskSidebarThreadGroup;

/** Open tabs anchor the catalog tree in each pane. Only find the roots here;
 * the renderer can expand catalog members without creating tabs for them. */
export function buildDeskSidebarEntries(
  pane: DeskGroup,
  targets: DeskState["targets"],
  drafts: DraftSessions,
  index: SidebarThreadGroupIndex,
): {
  readonly roots: readonly DeskSidebarEntry[];
  readonly tabsByThreadKey: ReadonlyMap<string, DeskSidebarTab>;
  readonly activeThreadKey: string | null;
} {
  const tabsByThreadKey = new Map<string, DeskSidebarTab>();
  let activeThreadKey: string | null = null;
  const tabs = pane.tabs.flatMap((tabKey) => {
    const target = targets[tabKey];
    if (!target) return [];
    const ref = target.kind === "server" ? target.threadRef : drafts[target.draftId]?.promotedTo;
    const threadKey = ref ? scopedThreadKey(ref) : undefined;
    const tab: DeskSidebarTab = { kind: "tab", tabKey, target, threadKey };
    if (threadKey) tabsByThreadKey.set(threadKey, tab);
    if (pane.activeTabKey === tabKey) activeThreadKey = threadKey ?? null;
    return [tab];
  });

  const roots: DeskSidebarEntry[] = [];
  const detachedGroupKeys = new Set<string>();
  for (const tab of tabs) {
    let group = tab.threadKey ? index.parentGroupByMemberKey.get(tab.threadKey) : undefined;
    if (!group) {
      roots.push(tab);
      continue;
    }
    // An open ancestor exposes this group beneath its own row. Otherwise
    // retain one detached heading at the first open member's position.
    for (let depth = 0; group && depth < MAX_THREAD_GROUP_DEPTH; depth += 1) {
      if (tabsByThreadKey.has(group.ownerKey)) break;
      const parent = index.parentGroupByMemberKey.get(group.ownerKey);
      if (!parent) {
        if (!detachedGroupKeys.has(group.key)) {
          detachedGroupKeys.add(group.key);
          roots.push({ kind: "group", node: group });
        }
        break;
      }
      group = parent;
    }
  }
  return { roots, tabsByThreadKey, activeThreadKey };
}
