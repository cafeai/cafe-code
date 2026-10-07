import type { EnvironmentId, ScopedThreadRef } from "@cafecode/contracts";

import type { DraftId } from "./composerDraftStore";
import type { ThreadRouteTarget } from "./threadRoutes";

/** Desk state contains view identities only. Chat content, provider work, drafts,
 * attachments, and delivery queues remain owned by their existing stores. */
export interface DeskGroup {
  readonly id: string;
  readonly name: string;
  readonly tabs: readonly string[];
  readonly activeTabKey: string | null;
  /** One temporary chat per pane. Excluded from saved navigation and history. */
  readonly previewTabKey?: string;
  /** Null inherits the pre-Desk global preference until this group is pinned
   * or unpinned explicitly. Never copy one pane's new preference to a sibling. */
  readonly sessionRailDocked: boolean | null;
}

export type DeskLayout =
  | { readonly kind: "leaf"; readonly groupId: string }
  | {
      readonly kind: "split";
      readonly id: string;
      readonly axis: "x" | "y";
      readonly ratio: number;
      readonly children: readonly [DeskLayout, DeskLayout];
    };

export interface ClosedDeskTab {
  readonly tabKey: string;
  readonly groupId: string;
  readonly index: number;
}

export interface DeskState {
  readonly environmentId: EnvironmentId | null;
  readonly groups: Readonly<Record<string, DeskGroup>>;
  readonly targets: Readonly<Record<string, ThreadRouteTarget>>;
  readonly layout: DeskLayout;
  readonly activeGroupId: string;
  readonly focusedGroupId: string | null;
  readonly sidebarMode: "desk" | "projects";
  readonly closed: readonly ClosedDeskTab[];
  readonly nextId: number;
}

export type DeskEdge = "left" | "right" | "top" | "bottom";
export type DeskAction =
  | {
      readonly type: "open";
      readonly target: ThreadRouteTarget;
      readonly groupId?: string;
      /** Background first-send promotion must not select another editor. */
      readonly activate?: boolean;
      readonly preview?: boolean;
    }
  | { readonly type: "keepOpen"; readonly tabKey: string }
  | { readonly type: "dismissPreview"; readonly groupId: string }
  | { readonly type: "select"; readonly tabKey: string }
  | { readonly type: "activateGroup"; readonly groupId: string }
  | { readonly type: "close"; readonly tabKey: string }
  | { readonly type: "closeOthers"; readonly tabKey: string }
  | { readonly type: "closeRight"; readonly tabKey: string }
  | { readonly type: "closeGroup"; readonly groupId: string }
  | { readonly type: "closeAll" }
  | { readonly type: "reopen" }
  | {
      readonly type: "move";
      readonly tabKey: string;
      readonly groupId: string;
      readonly index: number;
    }
  | {
      readonly type: "split";
      readonly tabKey: string;
      readonly targetGroupId: string;
      readonly edge: DeskEdge;
    }
  | { readonly type: "swapGroups"; readonly firstGroupId: string; readonly secondGroupId: string }
  | { readonly type: "merge"; readonly sourceGroupId: string; readonly targetGroupId: string }
  | { readonly type: "renameGroup"; readonly groupId: string; readonly name: string }
  | { readonly type: "resize"; readonly splitId: string; readonly ratio: number }
  | { readonly type: "focus"; readonly groupId: string | null }
  | { readonly type: "sidebarMode"; readonly mode: "desk" | "projects" }
  | { readonly type: "sessionRail"; readonly groupId: string; readonly docked: boolean }
  | {
      readonly type: "promoteDraft";
      readonly draftId: DraftId;
      readonly threadRef: ScopedThreadRef;
    }
  /** Before the first turn starts, the server shell is only an alias of the
   * still-owned draft. The caller must verify its exact promotedTo binding. */
  | {
      readonly type: "retainDraft";
      readonly draftId: DraftId;
      readonly threadRef: ScopedThreadRef;
    }
  /** Call only after a complete authoritative shell/draft inventory is ready.
   * A failed connection or an unhydrated shell is NOT an empty inventory. */
  | { readonly type: "reconcile"; readonly targets: readonly ThreadRouteTarget[] };

export const DESK_LIMITS = {
  panes: 4,
  tabs: 256,
  closed: 20,
  idLength: 256,
  nameLength: 80,
  minRatio: 0.2,
  maxRatio: 0.8,
  persistedBytes: 256 * 1024,
} as const;

export function createDeskState(environmentId: EnvironmentId | null = null): DeskState {
  return {
    environmentId,
    groups: {
      g1: { id: "g1", name: "Main", tabs: [], activeTabKey: null, sessionRailDocked: null },
    },
    targets: {},
    layout: { kind: "leaf", groupId: "g1" },
    activeGroupId: "g1",
    focusedGroupId: null,
    // Upgrading does not replace the familiar project catalog before the user
    // has chosen Desk. Both modes share the same tab layout after that choice.
    sidebarMode: "projects",
    closed: [],
    nextId: 2,
  };
}

/** JSON tuples are collision-free even when an opaque id contains a colon.
 * These are local identity keys, never paths, provider ids, or authorization. */
export function deskTabKey(target: ThreadRouteTarget): string {
  return target.kind === "draft"
    ? `draft:${JSON.stringify(target.draftId)}`
    : `server:${JSON.stringify([target.threadRef.environmentId, target.threadRef.threadId])}`;
}

export function deskGroupIds(layout: DeskLayout): string[] {
  return layout.kind === "leaf" ? [layout.groupId] : layout.children.flatMap(deskGroupIds);
}

export function deskGroupForTab(state: DeskState, tabKey: string): DeskGroup | undefined {
  return Object.values(state.groups).find((group) => group.tabs.includes(tabKey));
}

function ownGroup(state: DeskState, id: string): DeskGroup | undefined {
  return Object.hasOwn(state.groups, id) ? state.groups[id] : undefined;
}

function ownTarget(state: DeskState, key: string): ThreadRouteTarget | undefined {
  return Object.hasOwn(state.targets, key) ? state.targets[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsControl(value: string, allowWhitespace: boolean): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 127 || (code < 32 && !(allowWhitespace && [9, 10, 13].includes(code))))
      return true;
  }
  return false;
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= DESK_LIMITS.idLength &&
    !containsControl(value, false)
  );
}

function cleanName(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > DESK_LIMITS.nameLength * 2 ||
    containsControl(value, true)
  )
    return null;
  const name = value.replace(/\s+/gu, " ").trim();
  return name.length > 0 && name.length <= DESK_LIMITS.nameLength ? name : null;
}

/** Rebuild targets from known fields. localStorage is untrusted and must not
 * smuggle credentials, arbitrary properties, or another environment's ids. */
function decodeTarget(
  value: unknown,
  environmentId: EnvironmentId | null,
): ThreadRouteTarget | null {
  if (!isRecord(value) || environmentId === null) return null;
  if (value.kind === "draft" && validId(value.draftId)) {
    return { kind: "draft", draftId: value.draftId as DraftId };
  }
  if (
    value.kind !== "server" ||
    !isRecord(value.threadRef) ||
    value.threadRef.environmentId !== environmentId ||
    !validId(value.threadRef.threadId)
  )
    return null;
  return {
    kind: "server",
    threadRef: { environmentId, threadId: value.threadRef.threadId as ScopedThreadRef["threadId"] },
  };
}

function mapLayout(layout: DeskLayout, visit: (node: DeskLayout) => DeskLayout): DeskLayout {
  if (layout.kind === "leaf") return visit(layout);
  const first = mapLayout(layout.children[0], visit);
  const second = mapLayout(layout.children[1], visit);
  return visit(
    first === layout.children[0] && second === layout.children[1]
      ? layout
      : { ...layout, children: [first, second] },
  );
}

function withoutTab(group: DeskGroup, tabKey: string): DeskGroup {
  const index = group.tabs.indexOf(tabKey);
  const tabs = group.tabs.filter((key) => key !== tabKey);
  return {
    ...(group.previewTabKey === tabKey ? withoutPreviewMarker(group) : group),
    tabs,
    activeTabKey:
      group.activeTabKey === tabKey
        ? (tabs[Math.min(index, tabs.length - 1)] ?? null)
        : group.activeTabKey,
  };
}

function withoutPreviewMarker(group: DeskGroup): DeskGroup {
  const { previewTabKey: _preview, ...kept } = group;
  return kept;
}

function keepTab(state: DeskState, tabKey: string): DeskState {
  const group = deskGroupForTab(state, tabKey);
  return group?.previewTabKey === tabKey
    ? { ...state, groups: { ...state.groups, [group.id]: withoutPreviewMarker(group) } }
    : state;
}

/** Replacement keeps the destination pane, even when its only tab was a preview. */
function dismissPreview(state: DeskState, groupId: string): DeskState {
  const group = ownGroup(state, groupId);
  return group?.previewTabKey
    ? pruneTargets({
        ...state,
        groups: { ...state.groups, [group.id]: withoutTab(group, group.previewTabKey) },
      })
    : state;
}

function withTab(group: DeskGroup, tabKey: string, index: number): DeskGroup {
  return {
    ...group,
    tabs: [...group.tabs.slice(0, index), tabKey, ...group.tabs.slice(index)],
    activeTabKey: tabKey,
  };
}

/** Empty groups collapse; the final empty Main-like group remains an opening
 * surface. Focus follows the actual surviving group, never a detached leaf. */
function collapseEmpty(state: DeskState, groupId: string): DeskState {
  const group = ownGroup(state, groupId);
  if (!group || group.tabs.length > 0 || Object.keys(state.groups).length === 1) return state;
  let replacement: string | null = null;
  const layout = mapLayout(state.layout, (node) => {
    if (node.kind !== "split") return node;
    const [first, second] = node.children;
    if (first.kind === "leaf" && first.groupId === groupId) {
      replacement = deskGroupIds(second)[0] ?? null;
      return second;
    }
    if (second.kind === "leaf" && second.groupId === groupId) {
      replacement = deskGroupIds(first)[0] ?? null;
      return first;
    }
    return node;
  });
  const groups = { ...state.groups };
  delete groups[groupId];
  const fallback = replacement ?? deskGroupIds(layout)[0]!;
  return {
    ...state,
    groups,
    layout,
    activeGroupId: state.activeGroupId === groupId ? fallback : state.activeGroupId,
    focusedGroupId: state.focusedGroupId === groupId ? fallback : state.focusedGroupId,
  };
}

/** Keep target metadata only while open or in the bounded reopen history. */
function pruneTargets(state: DeskState): DeskState {
  const retained = new Set([
    ...Object.values(state.groups).flatMap((group) => group.tabs),
    ...state.closed.map((entry) => entry.tabKey),
  ]);
  const entries = Object.entries(state.targets).filter(([key]) => retained.has(key));
  return entries.length === Object.keys(state.targets).length
    ? state
    : { ...state, targets: Object.fromEntries(entries) };
}

function selectTab(state: DeskState, tabKey: string): DeskState {
  let group = deskGroupForTab(state, tabKey);
  if (!group) return state;
  if (group.previewTabKey && group.previewTabKey !== tabKey) {
    state = dismissPreview(state, group.id);
    group = ownGroup(state, group.id)!;
  }
  const focusedGroupId = state.focusedGroupId === null ? null : group.id;
  if (
    group.activeTabKey === tabKey &&
    state.activeGroupId === group.id &&
    state.focusedGroupId === focusedGroupId
  )
    return state;
  return {
    ...state,
    activeGroupId: group.id,
    focusedGroupId,
    groups:
      group.activeTabKey === tabKey
        ? state.groups
        : { ...state.groups, [group.id]: { ...group, activeTabKey: tabKey } },
  };
}

function closeTabs(state: DeskState, keys: readonly string[], remember = true): DeskState {
  let next = state;
  for (const tabKey of keys) {
    const group = deskGroupForTab(next, tabKey);
    if (!group) continue;
    const closed = next.closed.filter((entry) => entry.tabKey !== tabKey);
    if (remember && group.previewTabKey !== tabKey)
      closed.push({ tabKey, groupId: group.id, index: group.tabs.indexOf(tabKey) });
    next = collapseEmpty(
      {
        ...next,
        groups: { ...next.groups, [group.id]: withoutTab(group, tabKey) },
        closed: closed.slice(-DESK_LIMITS.closed),
      },
      group.id,
    );
  }
  return pruneTargets(next);
}

function allocateAllowed(state: DeskState): boolean {
  return (
    Number.isSafeInteger(state.nextId) &&
    state.nextId > 0 &&
    state.nextId < 1_000_000_000 &&
    !Object.hasOwn(state.groups, `g${state.nextId}`)
  );
}

function replaceTargetIdentity(
  state: DeskState,
  source: ThreadRouteTarget,
  destination: ThreadRouteTarget,
): DeskState {
  const previousTarget = decodeTarget(source, state.environmentId);
  const target = decodeTarget(destination, state.environmentId);
  if (!previousTarget || !target) return state;
  const oldKey = deskTabKey(previousTarget);
  if (!ownTarget(state, oldKey)) return state;
  const newKey = deskTabKey(target);
  const existing = deskGroupForTab(state, newKey);
  const oldGroup = deskGroupForTab(state, oldKey);
  let next = state;
  if (existing && oldGroup) {
    // A deep link or restored layout can expose both names of a draft/server
    // transition. Keep the destination's existing location, whether the draft
    // still owns initialization or the server has accepted its first turn.
    // Rewriting both open tabs and reopen history prevents a second owner.
    next = closeTabs(keepTab(state, newKey), [oldKey], false);
    if (oldGroup.activeTabKey === oldKey && state.activeGroupId === oldGroup.id)
      next = selectTab(next, newKey);
  } else if (oldGroup) {
    next = {
      ...state,
      groups: {
        ...state.groups,
        [oldGroup.id]: {
          ...withoutPreviewMarker(oldGroup),
          tabs: oldGroup.tabs.map((key) => (key === oldKey ? newKey : key)),
          activeTabKey: oldGroup.activeTabKey === oldKey ? newKey : oldGroup.activeTabKey,
        },
      },
    };
  }
  const open = new Set(Object.values(next.groups).flatMap((group) => group.tabs));
  const closed: ClosedDeskTab[] = [];
  for (const entry of next.closed) {
    const tabKey = entry.tabKey === oldKey ? newKey : entry.tabKey;
    if (open.has(tabKey)) continue;
    const previous = closed.findIndex((item) => item.tabKey === tabKey);
    if (previous >= 0) closed.splice(previous, 1);
    closed.push({ ...entry, tabKey });
  }
  return pruneTargets({ ...next, targets: { ...next.targets, [newKey]: target }, closed });
}

/** Pure transitions never stop/archive/delete a thread, submit input, or clear
 * its composer. Opening an already-open identity selects its existing pane. */
export function reduceDesk(state: DeskState, action: DeskAction): DeskState {
  switch (action.type) {
    case "open": {
      const target = decodeTarget(action.target, state.environmentId);
      let group = ownGroup(state, action.groupId ?? state.activeGroupId);
      if (!target || !group) return state;
      const tabKey = deskTabKey(target);
      const preview =
        action.preview === true && target.kind === "server" && action.activate !== false;
      if (deskGroupForTab(state, tabKey)) {
        const next = preview ? state : keepTab(state, tabKey);
        return action.activate === false ? next : selectTab(next, tabKey);
      }
      if (
        Object.values(state.groups).reduce((count, item) => count + item.tabs.length, 0) -
          (action.activate !== false && group.previewTabKey ? 1 : 0) >=
        DESK_LIMITS.tabs
      )
        return state;
      const index = group.previewTabKey
        ? group.tabs.indexOf(group.previewTabKey)
        : group.tabs.length;
      if (action.activate !== false) {
        state = dismissPreview(state, group.id);
        group = ownGroup(state, group.id)!;
      }
      return {
        ...state,
        groups: {
          ...state.groups,
          [group.id]: {
            ...withTab(group, tabKey, preview ? index : group.tabs.length),
            ...(preview ? { previewTabKey: tabKey } : {}),
            ...(action.activate === false ? { activeTabKey: group.activeTabKey ?? tabKey } : {}),
          },
        },
        targets: { ...state.targets, [tabKey]: target },
        activeGroupId: action.activate === false ? state.activeGroupId : group.id,
        focusedGroupId:
          action.activate === false || state.focusedGroupId === null
            ? state.focusedGroupId
            : group.id,
        closed: state.closed.filter((entry) => entry.tabKey !== tabKey),
      };
    }
    case "keepOpen":
      return keepTab(state, action.tabKey);
    case "dismissPreview":
      return dismissPreview(state, action.groupId);
    case "select":
      return selectTab(state, action.tabKey);
    case "activateGroup": {
      if (!ownGroup(state, action.groupId) || state.activeGroupId === action.groupId) return state;
      return {
        ...state,
        activeGroupId: action.groupId,
        focusedGroupId: state.focusedGroupId === null ? null : action.groupId,
      };
    }
    case "close":
      return closeTabs(state, [action.tabKey]);
    case "closeOthers":
    case "closeRight": {
      const group = deskGroupForTab(state, action.tabKey);
      if (!group) return state;
      const keys =
        action.type === "closeOthers"
          ? group.tabs.filter((key) => key !== action.tabKey)
          : group.tabs.slice(group.tabs.indexOf(action.tabKey) + 1);
      return closeTabs(state, keys);
    }
    case "closeGroup":
      return closeTabs(state, ownGroup(state, action.groupId)?.tabs ?? []);
    case "closeAll":
      return closeTabs(
        state,
        deskGroupIds(state.layout).flatMap((id) => ownGroup(state, id)?.tabs ?? []),
      );
    case "reopen": {
      const entry = state.closed.at(-1);
      const target = entry ? ownTarget(state, entry.tabKey) : undefined;
      if (!entry || !target) return state;
      const group = ownGroup(state, entry.groupId) ?? ownGroup(state, state.activeGroupId)!;
      const next = reduceDesk(state, { type: "open", target, groupId: group.id });
      return reduceDesk(next, {
        type: "move",
        tabKey: entry.tabKey,
        groupId: group.id,
        index: Math.min(entry.index, ownGroup(next, group.id)!.tabs.length - 1),
      });
    }
    case "move": {
      let source = deskGroupForTab(state, action.tabKey);
      let target = ownGroup(state, action.groupId);
      if (
        !source ||
        !target ||
        !Number.isInteger(action.index) ||
        action.index < 0 ||
        action.index > target.tabs.length - (source.id === target.id ? 1 : 0)
      )
        return state;
      if (source.id === target.id && source.tabs.indexOf(action.tabKey) === action.index)
        return selectTab(keepTab(state, action.tabKey), action.tabKey);
      let index = action.index;
      if (target.previewTabKey && target.previewTabKey !== action.tabKey) {
        // The dragged chat becomes selected. Dismiss the destination's old
        // preview and translate the insertion slot without reordering kept tabs.
        const previewIndex = target.tabs
          .filter((key) => key !== action.tabKey)
          .indexOf(target.previewTabKey);
        if (previewIndex < index) index -= 1;
        state = dismissPreview(state, target.id);
        source = deskGroupForTab(state, action.tabKey)!;
        target = ownGroup(state, target.id)!;
      }
      const remaining = withoutTab(source, action.tabKey);
      const next = collapseEmpty(
        {
          ...state,
          groups: {
            ...state.groups,
            [source.id]: remaining,
            [target.id]: withTab(
              source.id === target.id ? remaining : target,
              action.tabKey,
              index,
            ),
          },
          activeGroupId: target.id,
          focusedGroupId: state.focusedGroupId === null ? null : target.id,
        },
        source.id,
      );
      return next;
    }
    case "split": {
      const source = deskGroupForTab(state, action.tabKey);
      const target = ownGroup(state, action.targetGroupId);
      if (
        !source ||
        !target ||
        !["left", "right", "top", "bottom"].includes(action.edge) ||
        !allocateAllowed(state)
      )
        return state;
      if (source.id === target.id && source.tabs.length === 1) return state;
      if (Object.keys(state.groups).length + (source.tabs.length === 1 ? 0 : 1) > DESK_LIMITS.panes)
        return state;
      const id = `g${state.nextId}`;
      const usedNames = new Set(Object.values(state.groups).map((group) => group.name));
      let suffix = 2;
      while (usedNames.has(`Group ${suffix}`)) suffix += 1;
      const group: DeskGroup = {
        id,
        name: `Group ${suffix}`,
        tabs: [action.tabKey],
        activeTabKey: action.tabKey,
        sessionRailDocked: source.sessionRailDocked,
      };
      const layout = mapLayout(state.layout, (node) => {
        if (node.kind !== "leaf" || node.groupId !== target.id) return node;
        const newLeaf: DeskLayout = { kind: "leaf", groupId: id };
        return {
          kind: "split",
          id: `s${state.nextId}`,
          axis: action.edge === "left" || action.edge === "right" ? "x" : "y",
          ratio: 0.5,
          children:
            action.edge === "left" || action.edge === "top" ? [newLeaf, node] : [node, newLeaf],
        };
      });
      return collapseEmpty(
        {
          ...state,
          layout,
          groups: { ...state.groups, [source.id]: withoutTab(source, action.tabKey), [id]: group },
          activeGroupId: id,
          focusedGroupId: state.focusedGroupId === null ? null : id,
          nextId: state.nextId + 1,
        },
        source.id,
      );
    }
    case "swapGroups": {
      if (
        action.firstGroupId === action.secondGroupId ||
        !ownGroup(state, action.firstGroupId) ||
        !ownGroup(state, action.secondGroupId)
      )
        return state;
      return {
        ...state,
        layout: mapLayout(state.layout, (node) =>
          node.kind !== "leaf"
            ? node
            : node.groupId === action.firstGroupId
              ? { ...node, groupId: action.secondGroupId }
              : node.groupId === action.secondGroupId
                ? { ...node, groupId: action.firstGroupId }
                : node,
        ),
      };
    }
    case "merge": {
      const source = ownGroup(state, action.sourceGroupId);
      const target = ownGroup(state, action.targetGroupId);
      if (!source || !target || source.id === target.id) return state;
      return collapseEmpty(
        {
          ...state,
          groups: {
            ...state.groups,
            [source.id]: { ...source, tabs: [], activeTabKey: null },
            [target.id]: {
              ...withoutPreviewMarker(target),
              tabs: [...target.tabs, ...source.tabs],
              activeTabKey: target.activeTabKey ?? source.activeTabKey,
            },
          },
          activeGroupId: state.activeGroupId === source.id ? target.id : state.activeGroupId,
          focusedGroupId: state.focusedGroupId === source.id ? target.id : state.focusedGroupId,
        },
        source.id,
      );
    }
    case "renameGroup": {
      const group = ownGroup(state, action.groupId);
      const name = cleanName(action.name);
      return !group || name === null || name === group.name
        ? state
        : { ...state, groups: { ...state.groups, [group.id]: { ...group, name } } };
    }
    case "resize": {
      if (!Number.isFinite(action.ratio)) return state;
      const ratio = Math.max(DESK_LIMITS.minRatio, Math.min(DESK_LIMITS.maxRatio, action.ratio));
      const layout = mapLayout(state.layout, (node) =>
        node.kind === "split" && node.id === action.splitId && node.ratio !== ratio
          ? { ...node, ratio }
          : node,
      );
      return layout === state.layout ? state : { ...state, layout };
    }
    case "focus":
      return action.groupId === state.focusedGroupId ||
        (action.groupId !== null && !ownGroup(state, action.groupId))
        ? state
        : {
            ...state,
            focusedGroupId: action.groupId,
            activeGroupId: action.groupId ?? state.activeGroupId,
          };
    case "sidebarMode":
      return action.mode === state.sidebarMode || !["desk", "projects"].includes(action.mode)
        ? state
        : { ...state, sidebarMode: action.mode };
    case "sessionRail": {
      const group = ownGroup(state, action.groupId);
      return !group ||
        typeof action.docked !== "boolean" ||
        group.sessionRailDocked === action.docked
        ? state
        : {
            ...state,
            groups: { ...state.groups, [group.id]: { ...group, sessionRailDocked: action.docked } },
          };
    }
    case "promoteDraft":
      return replaceTargetIdentity(
        state,
        { kind: "draft", draftId: action.draftId },
        { kind: "server", threadRef: action.threadRef },
      );
    case "retainDraft":
      return replaceTargetIdentity(
        state,
        { kind: "server", threadRef: action.threadRef },
        { kind: "draft", draftId: action.draftId },
      );
    case "reconcile": {
      const known = new Set(
        action.targets.flatMap((value) => {
          const target = decodeTarget(value, state.environmentId);
          return target ? [deskTabKey(target)] : [];
        }),
      );
      const stale = Object.values(state.groups)
        .flatMap((group) => group.tabs)
        .filter((key) => !known.has(key));
      const next = closeTabs(state, stale, false);
      const closed = next.closed.filter((entry) => known.has(entry.tabKey));
      return closed.length === next.closed.length ? next : pruneTargets({ ...next, closed });
    }
    default:
      return state;
  }
}

/** Versioned, bounded parser. A malformed layout is rejected as a whole: partial
 * graph repair can move a chat into the wrong pane or accidentally duplicate its
 * mounted runtime. A cold/invalid profile safely starts with an empty Desk. */
export function hydrateDesk(raw: string | null, environmentId: EnvironmentId): DeskState {
  const fallback = createDeskState(environmentId);
  if (
    !raw ||
    raw.length > DESK_LIMITS.persistedBytes ||
    new TextEncoder().encode(raw).byteLength > DESK_LIMITS.persistedBytes
  )
    return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.desk)) return fallback;
    const value = parsed.desk;
    if (
      value.environmentId !== environmentId ||
      !isRecord(value.groups) ||
      !isRecord(value.targets) ||
      !Array.isArray(value.closed) ||
      value.closed.length > DESK_LIMITS.closed ||
      !Number.isSafeInteger(value.nextId) ||
      (value.nextId as number) < 2 ||
      (value.nextId as number) >= 1_000_000_000 ||
      !["desk", "projects"].includes(value.sidebarMode as string)
    )
      return fallback;
    const targetEntries = Object.entries(value.targets);
    if (targetEntries.length > DESK_LIMITS.tabs + DESK_LIMITS.closed) return fallback;
    const targets: Record<string, ThreadRouteTarget> = {};
    for (const [key, input] of targetEntries) {
      const target = decodeTarget(input, environmentId);
      if (!target || deskTabKey(target) !== key) return fallback;
      targets[key] = target;
    }
    const groupEntries = Object.entries(value.groups);
    if (groupEntries.length < 1 || groupEntries.length > DESK_LIMITS.panes) return fallback;
    const groups: Record<string, DeskGroup> = {};
    const open = new Set<string>();
    let greatestId = 1;
    for (const [id, input] of groupEntries) {
      if (
        !/^g[1-9]\d{0,8}$/u.test(id) ||
        !isRecord(input) ||
        input.id !== id ||
        !Array.isArray(input.tabs) ||
        input.tabs.length > DESK_LIMITS.tabs ||
        (input.tabs.length === 0 && groupEntries.length > 1)
      )
        return fallback;
      const name = cleanName(input.name);
      if (name === null) return fallback;
      const tabs: string[] = [];
      for (const key of input.tabs) {
        if (typeof key !== "string" || !Object.hasOwn(targets, key) || open.has(key))
          return fallback;
        open.add(key);
        tabs.push(key);
      }
      if (
        open.size > DESK_LIMITS.tabs ||
        (tabs.length === 0
          ? input.activeTabKey !== null
          : typeof input.activeTabKey !== "string" || !tabs.includes(input.activeTabKey))
      )
        return fallback;
      if (
        input.sessionRailDocked !== undefined &&
        input.sessionRailDocked !== null &&
        typeof input.sessionRailDocked !== "boolean"
      )
        return fallback;
      groups[id] = {
        id,
        name,
        tabs,
        activeTabKey: input.activeTabKey as string | null,
        sessionRailDocked:
          typeof input.sessionRailDocked === "boolean" ? input.sessionRailDocked : null,
      };
      greatestId = Math.max(greatestId, Number(id.slice(1)));
    }
    const leaves = new Set<string>();
    const splits = new Set<string>();
    let nodes = 0;
    const decodeLayout = (input: unknown, depth: number): DeskLayout | null => {
      nodes += 1;
      if (!isRecord(input) || nodes > DESK_LIMITS.panes * 2 - 1 || depth >= DESK_LIMITS.panes)
        return null;
      if (input.kind === "leaf") {
        if (
          typeof input.groupId !== "string" ||
          !Object.hasOwn(groups, input.groupId) ||
          leaves.has(input.groupId)
        )
          return null;
        leaves.add(input.groupId);
        return { kind: "leaf", groupId: input.groupId };
      }
      if (
        input.kind !== "split" ||
        typeof input.id !== "string" ||
        !/^s[1-9]\d{0,8}$/u.test(input.id) ||
        splits.has(input.id) ||
        (input.axis !== "x" && input.axis !== "y") ||
        typeof input.ratio !== "number" ||
        !Number.isFinite(input.ratio) ||
        input.ratio < DESK_LIMITS.minRatio ||
        input.ratio > DESK_LIMITS.maxRatio ||
        !Array.isArray(input.children) ||
        input.children.length !== 2
      )
        return null;
      splits.add(input.id);
      greatestId = Math.max(greatestId, Number(input.id.slice(1)));
      const first = decodeLayout(input.children[0], depth + 1);
      const second = decodeLayout(input.children[1], depth + 1);
      return first && second
        ? {
            kind: "split",
            id: input.id,
            axis: input.axis,
            ratio: input.ratio,
            children: [first, second],
          }
        : null;
    };
    const layout = decodeLayout(value.layout, 0);
    if (
      !layout ||
      leaves.size !== groupEntries.length ||
      (value.nextId as number) <= greatestId ||
      typeof value.activeGroupId !== "string" ||
      !Object.hasOwn(groups, value.activeGroupId) ||
      (value.focusedGroupId !== null &&
        (typeof value.focusedGroupId !== "string" || !Object.hasOwn(groups, value.focusedGroupId)))
    )
      return fallback;
    const closed: ClosedDeskTab[] = [];
    const closedKeys = new Set<string>();
    for (const entry of value.closed) {
      if (
        !isRecord(entry) ||
        typeof entry.tabKey !== "string" ||
        !Object.hasOwn(targets, entry.tabKey) ||
        open.has(entry.tabKey) ||
        closedKeys.has(entry.tabKey) ||
        typeof entry.groupId !== "string" ||
        !/^g[1-9]\d{0,8}$/u.test(entry.groupId) ||
        !Number.isInteger(entry.index) ||
        (entry.index as number) < 0 ||
        (entry.index as number) >= DESK_LIMITS.tabs
      )
        return fallback;
      closedKeys.add(entry.tabKey);
      closed.push({ tabKey: entry.tabKey, groupId: entry.groupId, index: entry.index as number });
    }
    return pruneTargets({
      environmentId,
      groups,
      targets,
      layout,
      activeGroupId: value.activeGroupId,
      focusedGroupId: value.focusedGroupId as string | null,
      sidebarMode: value.sidebarMode as DeskState["sidebarMode"],
      closed,
      nextId: value.nextId as number,
    });
  } catch {
    return fallback;
  }
}

export function serializeDesk(desk: DeskState): string {
  const previews = Object.values(desk.groups).flatMap((group) =>
    group.previewTabKey ? [group.previewTabKey] : [],
  );
  let saved = closeTabs(desk, previews, false);
  // An active pending editor can keep a pane whose preview was dismissed.
  // Only persisted navigation collapses that empty pane; editor ownership stays live.
  for (const groupId of deskGroupIds(saved.layout)) saved = collapseEmpty(saved, groupId);
  return JSON.stringify({ version: 1, desk: saved });
}
