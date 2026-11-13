import { MAX_THREAD_GROUP_DEPTH } from "@cafecode/contracts";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";
import { uiText } from "@cafecode/shared/i18n";
import { BotIcon, ChevronRightIcon } from "lucide-react";
import { createContext, Fragment, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { useUiLocale } from "~/i18n";
import { useThreadActions } from "../../hooks/useThreadActions";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import { readLocalApi } from "../../localApi";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SidebarMenuSubItem } from "../ui/sidebar";
import {
  clearHoveredThreadGroupOwner,
  setHoveredThreadGroupOwner,
  useThreadGroupOwnerHoverStore,
} from "./threadGroupOwnerHover";
import {
  collectSidebarGroupDescendants,
  EMPTY_SIDEBAR_THREAD_GROUP_INDEX,
  layoutSidebarThreadGroupRows,
  type SidebarThreadGroupIndex,
  type SidebarThreadGroupRowLayout,
} from "./threadGroups.logic";

/**
 * Agent-created thread groups, rendered as indented agent rows directly
 * beneath their parent chat. People browse, expand/collapse and delete whole
 * groups here; there is deliberately no "New group" or "Add to group" action
 * (groups are created through Cafe's management tool). Presentation and
 * explicit delete only: browsing never changes a chat or group.
 */
export interface SidebarThreadGroupContextValue {
  readonly index: SidebarThreadGroupIndex;
  readonly activeThreadKey: string | null;
}

export const SidebarThreadGroupContext = createContext<SidebarThreadGroupContextValue>({
  index: EMPTY_SIDEBAR_THREAD_GROUP_INDEX,
  activeThreadKey: null,
});

/** Visual indentation stops growing after four levels; order is preserved. */
export function sidebarNestingIndentStyle(depth: number) {
  return depth > 0 ? { paddingInlineStart: `${Math.min(depth, 4) * 0.75}rem` } : undefined;
}

export type SidebarThreadGroupRowRenderer = (
  thread: SidebarThreadSummary,
  nestingDepth: number,
) => ReactNode;

export function SidebarThreadGroups({
  ownerThread,
  depth,
  renderRow,
}: {
  ownerThread: SidebarThreadSummary;
  /** Nesting depth of the owner row (0 for top-level rows). */
  depth: number;
  renderRow: SidebarThreadGroupRowRenderer;
}) {
  const { index, activeThreadKey } = useContext(SidebarThreadGroupContext);
  const nodes =
    depth >= MAX_THREAD_GROUP_DEPTH * 2
      ? undefined
      : index.groupsByOwnerKey.get(
          scopedThreadKey(scopeThreadRef(ownerThread.environmentId, ownerThread.id)),
        );
  // Shallow-compared per-owner flags: only this parent's groups re-render when
  // one of them is expanded or collapsed.
  const expanded = useUiStateStore(
    useShallow((state) =>
      nodes ? nodes.map((node) => state.expandedThreadGroupKeys.includes(node.key)) : NO_FLAGS,
    ),
  );
  // Collapsing always works, even from inside a group. Like a collapsed
  // project, a collapsed group keeps only the routed chat (or the path to it
  // through nested groups) visible, so the open chat is never hidden.
  const rows = useMemo(
    () => (nodes ? layoutSidebarThreadGroupRows(index, nodes, expanded, activeThreadKey) : []),
    [activeThreadKey, expanded, index, nodes],
  );
  return rows.map((row) => (
    <SidebarThreadGroupRow key={row.node.key} row={row} depth={depth + 1} renderRow={renderRow} />
  ));
}

const NO_FLAGS: readonly boolean[] = [];

function SidebarThreadGroupRow({
  row,
  depth,
  renderRow,
}: {
  row: SidebarThreadGroupRowLayout;
  depth: number;
  renderRow: SidebarThreadGroupRowRenderer;
}) {
  const { node, expanded, visibleMembers, attached } = row;
  const uiLocale = useUiLocale();
  const { index } = useContext(SidebarThreadGroupContext);
  // The parent chat and its group rows are sibling list items, so hovering
  // any of them marks the whole cluster (see threadGroupOwnerHover).
  const clusterHovered = useThreadGroupOwnerHoverStore((state) => state.ownerKey === node.ownerKey);
  const handleMouseEnter = useCallback(
    () => setHoveredThreadGroupOwner(node.ownerKey),
    [node.ownerKey],
  );
  const handleMouseLeave = useCallback(
    () => clearHoveredThreadGroupOwner(node.ownerKey),
    [node.ownerKey],
  );
  const setThreadGroupExpanded = useUiStateStore((state) => state.setThreadGroupExpanded);
  const descendants = useMemo(() => collectSidebarGroupDescendants(index, node), [index, node]);
  const { deleteThreadGroup } = useThreadActions();

  const toggle = useCallback(() => {
    setThreadGroupExpanded(node.key, !expanded);
  }, [expanded, node.key, setThreadGroupExpanded]);

  const handleContextMenu = useCallback(
    async (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "copy-group-id", label: uiText("Copy group ID", undefined, undefined, uiLocale) },
          {
            id: "delete-group",
            label: uiText("Delete group…", undefined, undefined, uiLocale),
            destructive: true,
          },
        ],
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "copy-group-id") {
        await copyTextToClipboard(node.groupId).catch(() => undefined);
        return;
      }
      if (clicked !== "delete-group") return;
      const running = descendants.filter(
        (thread) =>
          thread.session?.status === "running" ||
          thread.session?.orchestrationStatus === "starting",
      ).length;
      const nestedGroups = Math.max(
        0,
        descendants.reduce(
          (count, thread) =>
            count +
            (index.groupsByOwnerKey.get(
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
            )?.length ?? 0),
          0,
        ),
      );
      const lines = [
        uiText(
          'Move group "{title}" and its {count, plural, one {# chat} other {# chats}} to the Recycle Bin?',
          { title: node.title, count: descendants.length },
          undefined,
          uiLocale,
        ),
      ];
      if (nestedGroups > 0)
        lines.push(
          uiText(
            "This includes {count, plural, one {# nested group} other {# nested groups}}.",
            { count: nestedGroups },
            undefined,
            uiLocale,
          ),
        );
      if (running > 0)
        lines.push(
          uiText(
            "{count, plural, one {# is running and will be stopped.} other {# are running and will be stopped.}}",
            { count: running },
            undefined,
            uiLocale,
          ),
        );
      lines.push(
        uiText("The parent chat is kept. Worktrees are kept.", undefined, undefined, uiLocale),
      );
      if (!(await api.dialogs.confirm(lines.join("\n")))) return;
      try {
        await deleteThreadGroup({
          environmentId: node.environmentId,
          groupId: node.groupId,
          ownerThreadId: node.ownerThreadId,
          memberThreadKeys: new Set(
            descendants.map((thread) =>
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
            ),
          ),
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not delete group", undefined, undefined, uiLocale),
            description:
              error instanceof Error
                ? error.message
                : uiText("The group may already be deleted.", undefined, undefined, uiLocale),
          }),
        );
      }
    },
    [deleteThreadGroup, descendants, index, node, uiLocale],
  );

  return (
    <>
      {/* Group rows read as attached to their parent chat: the row is one
          step shorter (h-6) than a chat row and, when it directly follows the
          parent, -mt-0.5 cancels the sidebar list's gap-0.5 without
          overlapping either row's click area. Group rows show no status:
          their members report to the agent that started them. */}
      <SidebarMenuSubItem
        className={attached ? "-mt-0.5 w-full" : "w-full"}
        style={sidebarNestingIndentStyle(depth)}
        data-thread-selection-safe
        data-testid={`thread-group-row-${node.groupId}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <button
          type="button"
          aria-expanded={expanded}
          data-thread-selection-safe
          data-thread-group-button
          data-cluster-hover={clusterHovered ? "true" : undefined}
          className="focus-ring flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground"
          onClick={toggle}
          onContextMenu={handleContextMenu}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={`size-3 shrink-0 transition-transform duration-(--duration-fast) motion-reduce:transition-none ${
              expanded ? "rotate-90" : ""
            }`}
          />
          <BotIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{node.title}</span>
          <span className="shrink-0 text-subtle-foreground tabular-nums">
            {uiText(
              "{count, plural, one {# chat} other {# chats}}",
              { count: node.members.length },
              undefined,
              uiLocale,
            )}
          </span>
        </button>
      </SidebarMenuSubItem>
      {visibleMembers.map((member) => (
        <Fragment key={scopedThreadKey(scopeThreadRef(member.environmentId, member.id))}>
          {renderRow(member, depth + 1)}
          <SidebarThreadGroups ownerThread={member} depth={depth + 1} renderRow={renderRow} />
        </Fragment>
      ))}
    </>
  );
}
