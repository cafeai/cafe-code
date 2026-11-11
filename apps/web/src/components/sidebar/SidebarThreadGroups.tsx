import { MAX_THREAD_GROUP_DEPTH } from "@cafecode/contracts";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";
import { uiText } from "@cafecode/shared/i18n";
import { ChevronRightIcon, FolderIcon } from "lucide-react";
import { createContext, Fragment, useCallback, useContext, useMemo, type ReactNode } from "react";

import { useUiLocale } from "~/i18n";
import { useThreadActions } from "../../hooks/useThreadActions";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import { readLocalApi } from "../../localApi";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { ThreadStatusDot } from "../ThreadStatusIndicators";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SidebarMenuSubItem } from "../ui/sidebar";
import {
  collectSidebarGroupDescendants,
  EMPTY_SIDEBAR_THREAD_GROUP_INDEX,
  sidebarGroupKeysContaining,
  type SidebarThreadGroupIndex,
  type SidebarThreadGroupNode,
} from "./threadGroups.logic";
import { useHiddenThreadStatusSummary } from "./useHiddenThreadStatusSummary";

/**
 * Agent-created thread groups, rendered as indented folder rows directly
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
  const { index } = useContext(SidebarThreadGroupContext);
  const nodes = index.groupsByOwnerKey.get(
    scopedThreadKey(scopeThreadRef(ownerThread.environmentId, ownerThread.id)),
  );
  if (!nodes || depth >= MAX_THREAD_GROUP_DEPTH * 2) return null;
  return nodes.map((node) => (
    <SidebarThreadGroupRow key={node.key} node={node} depth={depth + 1} renderRow={renderRow} />
  ));
}

function SidebarThreadGroupRow({
  node,
  depth,
  renderRow,
}: {
  node: SidebarThreadGroupNode;
  depth: number;
  renderRow: SidebarThreadGroupRowRenderer;
}) {
  const uiLocale = useUiLocale();
  const { index, activeThreadKey } = useContext(SidebarThreadGroupContext);
  const storedExpanded = useUiStateStore((state) =>
    state.expandedThreadGroupKeys.includes(node.key),
  );
  const setThreadGroupExpanded = useUiStateStore((state) => state.setThreadGroupExpanded);
  // The routed chat is never hidden inside a collapsed group.
  const containsActiveChat = useMemo(
    () => sidebarGroupKeysContaining(index, activeThreadKey).has(node.key),
    [activeThreadKey, index, node.key],
  );
  const expanded = storedExpanded || containsActiveChat;
  const descendants = useMemo(() => collectSidebarGroupDescendants(index, node), [index, node]);
  const summary = useHiddenThreadStatusSummary(descendants, !expanded);
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
      <SidebarMenuSubItem
        className="w-full"
        style={sidebarNestingIndentStyle(depth)}
        data-thread-selection-safe
        data-testid={`thread-group-row-${node.groupId}`}
      >
        <button
          type="button"
          aria-expanded={expanded}
          data-thread-selection-safe
          className="focus-ring flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground"
          onClick={toggle}
          onContextMenu={handleContextMenu}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={`size-3 shrink-0 transition-transform duration-(--duration-fast) motion-reduce:transition-none ${
              expanded ? "rotate-90" : ""
            }`}
          />
          <FolderIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{node.title}</span>
          {!expanded && summary ? (
            <span
              data-testid={`thread-group-status-${node.groupId}`}
              data-status={summary.status.label}
              title={summary.text}
              className={`inline-flex shrink-0 items-center ${summary.status.colorClass}`}
            >
              <ThreadStatusDot status={summary.status} />
              <span className="sr-only">{summary.text}</span>
            </span>
          ) : null}
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
      {expanded
        ? node.members.map((member) => (
            <Fragment key={scopedThreadKey(scopeThreadRef(member.environmentId, member.id))}>
              {renderRow(member, depth + 1)}
              <SidebarThreadGroups ownerThread={member} depth={depth + 1} renderRow={renderRow} />
            </Fragment>
          ))
        : null}
    </>
  );
}
