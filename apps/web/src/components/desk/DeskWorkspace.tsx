import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from "@dnd-kit/core";
import {
  GripVertical,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import type { ContextMenuItem } from "@cafecode/contracts";
import { useShallow } from "zustand/react/shallow";
import ChatView from "../ChatView";
import { NoActiveThreadState } from "../NoActiveThreadState";
import { ThreadStatusLabel } from "../ThreadStatusLabel";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ChatPaneContext, isChatSendInFlight } from "../../chatPaneContext";
import { useDeskStore } from "../../deskStore";
import {
  deskGroupIds,
  deskGroupForTab,
  deskTabKey,
  type DeskAction,
  type DeskGroup,
  type DeskLayout,
  type DeskState,
} from "../../deskModel";
import { useWorkspaceEnvironmentId } from "~/environments/workspace";
import { useSettings } from "../../hooks/useSettings";
import { useIsMobile } from "../../hooks/useMediaQuery";
import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { selectEnvironmentState, selectThreadByRef, useStore } from "../../store";
import { threadHasStarted } from "../ChatView.logic";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "../../threadRoutes";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useUiStateStore } from "../../uiStateStore";
import { readLocalApi } from "../../localApi";
import { useRenameChat } from "../../hooks/useRenameChat";
import { isMacPlatform } from "../../lib/utils";
import { isElectron } from "../../env";
import { useDeskTabMetadata, readDeskTabMetadata } from "./useDeskTabMetadata";
import { useDeskChatActions } from "./useDeskChatActions";
import { useDeskOpenActions } from "./useDeskOpenActions";
import {
  deskDropEdge,
  deskInsertionIndex,
  deskResizeBounds,
  fitDeskLayout,
  projectDeskLayout,
  type DeskRect,
  type DeskSize,
} from "./deskLayout";
import { deskCollisionDetection } from "./deskDrag";
import "./desk.css";

type DragData =
  | { kind: "tab"; tabKey: string; groupId: string; index: number }
  | { kind: "group" | "pane" | "strip"; groupId: string };
// A tab-strip insertion is not a pane-center drop. Keep its boundary index
// before removing the dragged tab so preview and commit share one intention,
// including when the pointer crosses a tab midpoint without changing target.
type DropHint =
  | { kind: "insert"; groupId: string; index: number }
  | { kind: "pane"; groupId: string; edge: ReturnType<typeof deskDropEdge> }
  | null;
// Width of the edge fade on an overflowing tab strip. It is passed to desk.css
// as --desk-strip-fade and also keeps a revealed tab clear of the fade.
const TAB_STRIP_FADE_REM = 1.5;
const tabStripStyle = { "--desk-strip-fade": `${TAB_STRIP_FADE_REM}rem` } as CSSProperties;
const rectStyle = (r: DeskRect): CSSProperties => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.width * 100}%`,
  height: `${r.height * 100}%`,
});

function isTabContextMenuGesture(event: { button: number; ctrlKey: boolean }): boolean {
  // macOS presents Control-primary-click as a secondary menu gesture while
  // retaining button=0. Other hosts keep their ordinary primary-click policy.
  return (
    event.button === 2 || (event.button === 0 && event.ctrlKey && isMacPlatform(navigator.platform))
  );
}

function focusTabAfterSelection(tabKey: string) {
  // Selected chats have stable identity keys, so changing tabs replaces their
  // strip along with the view. Restore keyboard focus after that React commit,
  // comparing opaque keys as data rather than interpolating them into selectors.
  requestAnimationFrame(() => {
    const current = useDeskStore.getState().desk;
    if (current.groups[current.activeGroupId]?.activeTabKey !== tabKey) return;
    for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-desk-tab-key]")) {
      if (tab.dataset.deskTabKey === tabKey) {
        tab.focus({ preventScroll: true });
        break;
      }
    }
  });
}

/** Route identity remains the source for external navigation/deep links. Desk
 * commands update that route only after applying a local layout transition.
 * A route echo must never reopen a tab the user has just closed. */
export function useDeskRouteSync() {
  const navigate = useNavigate();
  const chatClickBehavior = useSettings((settings) => settings.chatClickBehavior);
  const environmentId = useWorkspaceEnvironmentId();
  const target = useParams({ strict: false, select: resolveThreadRouteTarget });
  const routeKey = target ? deskTabKey(target) : "";
  const desk = useDeskStore((s) => s.desk);
  const activeDraftId = useDeskStore((s) => s.activeDraftId);
  const bindEnvironment = useDeskStore((s) => s.bindEnvironment);
  const dispatch = useDeskStore((s) => s.dispatch);
  const bootstrapped = useStore((s) => selectEnvironmentState(s, environmentId).bootstrapComplete);
  const shells = useStore((s) => selectEnvironmentState(s, environmentId).threadShellById);
  const drafts = useComposerDraftStore((s) => s.draftThreadsByThreadKey);
  const readyDrafts = useStore(
    useShallow((s) =>
      Object.entries(drafts)
        .filter(
          ([, draft]) =>
            draft.environmentId === environmentId &&
            draft.promotedTo &&
            threadHasStarted(selectThreadByRef(s, draft.promotedTo)),
        )
        .map(([id]) => id),
    ),
  );
  const openTabCount = Object.values(desk.groups).reduce(
    (count, group) => count + group.tabs.length,
    0,
  );
  const lastRoute = useRef<string | null>(null);
  const expectedRoute = useRef<string | null>(null);
  useEffect(() => {
    lastRoute.current = null;
    expectedRoute.current = null;
    bindEnvironment(environmentId);
  }, [environmentId, bindEnvironment]);

  useEffect(() => {
    const currentDesk = useDeskStore.getState().desk;
    if (!environmentId || !bootstrapped || currentDesk.environmentId !== environmentId) return;
    // Never prune against an empty reconnect snapshot: bootstrapComplete marks
    // an authoritative catalog, while disconnected cached catalogs stay valid.
    const available: ThreadRouteTarget[] = Object.values(shells)
      .filter((s) => s.archivedAt === null)
      .map((s) => ({ kind: "server", threadRef: { environmentId, threadId: s.id } }));
    for (const [id, draft] of Object.entries(drafts)) {
      if (draft.environmentId !== environmentId) continue;
      const promoted = draft.promotedTo;
      if (promoted && promoted.environmentId === environmentId && readyDrafts.includes(id)) {
        const view = useDeskStore.getState();
        if (view.draftEditors[id]) {
          if (!view.promoteDraftEditor(DraftId.make(id), promoted)) continue;
        } else dispatch({ type: "promoteDraft", draftId: DraftId.make(id), threadRef: promoted });
        // Transfer Desk ownership before removing the draft identity. This also
        // handles a send completing in a nonfocused group without duplicate tabs.
        finalizePromotedDraftThreadByRef(promoted);
      } else {
        if (draft.projectId === null) {
          // Older builds saved standalone draft tabs. Retire those view rows
          // without deleting their independently persisted input/attachments.
          const group = deskGroupForTab(
            currentDesk,
            deskTabKey({ kind: "draft", draftId: DraftId.make(id) }),
          );
          if (group) useDeskStore.getState().showDraftEditor(DraftId.make(id), group.id, false);
          if (promoted) {
            const alias = available.findIndex(
              (entry) => entry.kind === "server" && entry.threadRef.threadId === promoted.threadId,
            );
            if (alias >= 0) available.splice(alias, 1);
          }
          continue;
        }
        available.push({ kind: "draft", draftId: DraftId.make(id) });
        if (promoted?.environmentId === environmentId) {
          // The server shell can appear before the first accepted turn. Keep
          // one draft owner until initialization is ready, even if a deep link
          // or persisted Desk exposes the new server identity in another group.
          dispatch({ type: "retainDraft", draftId: DraftId.make(id), threadRef: promoted });
        }
      }
    }
    useDeskStore
      .getState()
      .reconcileDraftEditors(
        Object.entries(drafts).flatMap(([id, draft]) =>
          draft.environmentId === environmentId && draft.projectId === null
            ? [DraftId.make(id)]
            : [],
        ),
      );
    dispatch({ type: "reconcile", targets: available });
  }, [
    environmentId,
    bootstrapped,
    shells,
    drafts,
    readyDrafts,
    desk.environmentId,
    desk.targets,
    openTabCount,
    dispatch,
  ]);

  useEffect(() => {
    if (!environmentId || !bootstrapped || desk.environmentId !== environmentId) return;
    if (lastRoute.current !== routeKey) {
      lastRoute.current = routeKey;
      const isRouteEcho = expectedRoute.current === routeKey;
      expectedRoute.current = null;
      if (target && !isRouteEcho) {
        // Older navigation and draft bootstrap can still use /env/thread before
        // its server shell exists. Resolve that exact locally registered draft,
        // not an arbitrary orphan, and move navigation to its explicit draft URL.
        const pending =
          target.kind === "server"
            ? Object.entries(drafts).find(
                ([id, draft]) =>
                  !readyDrafts.includes(id) &&
                  draft.environmentId === target.threadRef.environmentId &&
                  (draft.promotedTo
                    ? draft.promotedTo.environmentId === target.threadRef.environmentId &&
                      draft.promotedTo.threadId === target.threadRef.threadId
                    : draft.threadId === target.threadRef.threadId),
              )
            : null;
        const admitted =
          target.kind === "server"
            ? target.threadRef.environmentId === environmentId &&
              (shells[target.threadRef.threadId]?.archivedAt === null || Boolean(pending))
            : drafts[target.draftId]?.environmentId === environmentId;
        if (admitted) {
          const draftId = pending
            ? DraftId.make(pending[0])
            : target.kind === "draft"
              ? target.draftId
              : null;
          if (draftId && drafts[draftId]?.projectId === null) {
            useDeskStore.getState().showDraftEditor(draftId);
            return;
          }
          dispatch({
            type: "open",
            target: pending ? { kind: "draft", draftId: DraftId.make(pending[0]) } : target,
            // A current URL can restore a preview, but must never pin it on reload.
            // Existing kept tabs retain their permanent state when selected here.
            preview: !pending && target.kind === "server" && chatClickBehavior === "preview",
          });
          return;
        }
      }
    }
    const latest = useDeskStore.getState().desk;
    const currentEditor = useDeskStore.getState().activeDraftId;
    const activeKey = currentEditor
      ? deskTabKey({ kind: "draft", draftId: currentEditor })
      : (latest.groups[latest.activeGroupId]?.activeTabKey ?? "");
    // Preserve the existing no-project empty route behavior. Its route guard,
    // not the layout, decides whether an unknown deep link should redirect.
    if (
      !activeKey &&
      target?.kind === "server" &&
      Object.keys(shells).length === 0 &&
      Object.keys(drafts).length === 0
    )
      return;
    // Serialize route writes. A rapid B→C selection must not treat the delayed
    // B route commit as external navigation and steal focus back from C.
    if (activeKey === routeKey || expectedRoute.current !== null) return;
    const next = currentEditor
      ? { kind: "draft" as const, draftId: currentEditor }
      : latest.targets[activeKey];
    expectedRoute.current = activeKey;
    const navigation =
      next?.kind === "server"
        ? navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(next.threadRef),
          })
        : next?.kind === "draft"
          ? navigate({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(next.draftId) })
          : navigate({ to: "/" });
    void navigation.catch(() => {
      expectedRoute.current = null;
    });
  }, [
    desk,
    activeDraftId,
    environmentId,
    bootstrapped,
    routeKey,
    target,
    shells,
    drafts,
    readyDrafts,
    chatClickBehavior,
    dispatch,
    navigate,
  ]);
}

function GroupGrip({ group }: { group: DeskGroup }) {
  const drag = useDraggable({
    id: `group:${group.id}`,
    data: { kind: "group", groupId: group.id } satisfies DragData,
  });
  return (
    <button
      className="desk-icon desk-group-grip"
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      aria-label={`Move ${group.name} group`}
      title={`Move ${group.name} group`}
    >
      <GripVertical size={12} />
    </button>
  );
}

function ChatTab({
  target,
  tabKey,
  group,
  index,
  onMenu,
  onRename,
}: {
  target: ThreadRouteTarget;
  tabKey: string;
  group: DeskGroup;
  index: number;
  onMenu: (key: string, position: { x: number; y: number }) => void;
  onRename: (target: ThreadRouteTarget) => void;
}) {
  const meta = useDeskTabMetadata(target);
  const dispatch = useDeskStore((s) => s.dispatch);
  const selected = group.activeTabKey === tabKey;
  const drag = useDraggable({
    id: `tab:${tabKey}`,
    data: { kind: "tab", tabKey, groupId: group.id, index } satisfies DragData,
  });
  const drop = useDroppable({
    id: `target:${tabKey}`,
    data: { kind: "tab", tabKey, groupId: group.id, index } satisfies DragData,
  });
  return (
    <div
      ref={drop.setNodeRef}
      className="desk-tab-cell"
      data-selected={selected}
      data-dragging={drag.isDragging}
      onPointerDownCapture={(event) => {
        // A native secondary click can focus its button before contextmenu.
        // Keep the existing composer/tab focus so Pane's ordinary keyboard
        // focus activation cannot select this menu's otherwise inactive group.
        // Cancelling pointerdown does not cancel the subsequent contextmenu.
        if (isTabContextMenuGesture(event)) event.preventDefault();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(tabKey, { x: event.clientX, y: event.clientY });
      }}
    >
      <button
        ref={drag.setNodeRef}
        {...drag.listeners}
        {...drag.attributes}
        className="desk-tab"
        role="tab"
        aria-selected={selected}
        tabIndex={selected || (group.activeTabKey === null && index === 0) ? 0 : -1}
        data-desk-tab-key={tabKey}
        data-preview={group.previewTabKey === tabKey}
        title={`${meta.title}${meta.projectName ? ` · ${meta.projectName}` : ""}`}
        onClick={() => {
          dispatch({ type: "select", tabKey });
          focusTabAfterSelection(tabKey);
        }}
        onDoubleClick={() => dispatch({ type: "keepOpen", tabKey })}
        onKeyDown={(event) => {
          // Once a keyboard drag is active, its sensor owns arrow/Space/Escape.
          if (drag.isDragging) return;
          if (event.key === "F2") {
            event.preventDefault();
            onRename(target);
            return;
          }
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const r = event.currentTarget.getBoundingClientRect();
            onMenu(tabKey, { x: r.left, y: r.bottom });
            return;
          }
          const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (direction || event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const nextIndex =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? group.tabs.length - 1
                  : (index + direction + group.tabs.length) % group.tabs.length;
            const key = group.tabs[nextIndex];
            if (key) {
              dispatch({ type: "select", tabKey: key });
              focusTabAfterSelection(key);
            }
          } else drag.listeners?.onKeyDown?.(event);
        }}
      >
        {/* Same status vocabulary as the sidebar rows and project rows. */}
        <ThreadStatusLabel status={meta.status} />
        <span className="desk-tab-title">{meta.title}</span>
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              className="desk-tab-action"
              aria-label={`Close tab ${meta.title}`}
              onClick={() => dispatch({ type: "close", tabKey })}
            >
              <X size={12} />
            </button>
          }
        />
        <TooltipPopup side="bottom">Close tab (chat keeps running)</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function GroupTabs({
  group,
  hint,
  restoreGroups,
  canRestoreGroups,
  onToggleFocus,
  onMenu,
  onRename,
  onRenameGroup,
  pendingEditor = false,
  controls,
  rect,
}: {
  group: DeskGroup;
  hint: DropHint;
  restoreGroups: boolean;
  canRestoreGroups: boolean;
  onToggleFocus: () => void;
  onMenu: (key: string | null, position: { x: number; y: number }) => void;
  onRename: (target: ThreadRouteTarget) => void;
  onRenameGroup: () => void;
  pendingEditor?: boolean;
  controls: ReactNode;
  rect: DeskRect;
}) {
  const desk = useDeskStore((s) => s.desk);
  const strip = useRef<HTMLDivElement>(null);
  const titlebar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = titlebar.current;
    if (!bar || !isElectron || rect.y !== 0) return;
    const measure = () => {
      const bounds = bar.getBoundingClientRect();
      bar.style.setProperty("--desk-window-left-gap", `${bounds.left}px`);
      bar.style.setProperty("--desk-window-right-gap", `${window.innerWidth - bounds.right}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [rect.x, rect.y, rect.width]);
  const insertionIndex = hint?.kind === "insert" && hint.groupId === group.id ? hint.index : null;
  const drop = useDroppable({
    id: `strip:${group.id}`,
    data: { kind: "strip", groupId: group.id } satisfies DragData,
  });
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    // Mark each edge that has tabs scrolled beyond it; desk.css fades only
    // those edges. Observing the cells as well as the strip catches title and
    // interface-size changes that alter scrollWidth without resizing the strip;
    // the mutation observer follows tabs as they open and close.
    const update = () => {
      const max = element.scrollWidth - element.clientWidth;
      // One pixel of slack absorbs fractional widths at non-100% scales.
      element.dataset.overflowStart = String(element.scrollLeft > 1);
      element.dataset.overflowEnd = String(element.scrollLeft < max - 1);
    };
    update();
    const sizes = new ResizeObserver(update);
    sizes.observe(element);
    for (const cell of element.children) sizes.observe(cell);
    const cells = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) if (node instanceof Element) sizes.unobserve(node);
        for (const node of record.addedNodes) if (node instanceof Element) sizes.observe(node);
      }
      update();
    });
    cells.observe(element, { childList: true });
    element.addEventListener("scroll", update, { passive: true });
    return () => {
      cells.disconnect();
      sizes.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, []);
  useEffect(() => {
    const bar = strip.current;
    const reveal = () => {
      // Reveal the whole selected cell, including its always-visible sibling
      // close button. Measuring only the title button can leave X clipped just
      // beyond the right edge of an overflowing tab strip.
      const tab = bar
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.closest<HTMLElement>(".desk-tab-cell");
      if (!bar || !tab) return;
      const a = tab.getBoundingClientRect(),
        b = bar.getBoundingClientRect();
      // Also keep the cell clear of an edge fade. At either scroll end there is
      // no fade there and scrollLeft clamps, so the margin costs nothing. When
      // the cell cannot fit between both fades, keep its title start visible.
      const fade =
        TAB_STRIP_FADE_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
      if (a.left < b.left + fade) bar.scrollLeft -= b.left + fade - a.left;
      else if (a.right > b.right - fade)
        bar.scrollLeft += Math.min(a.right - (b.right - fade), a.left - (b.left + fade));
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    if (bar) observer.observe(bar);
    return () => observer.disconnect();
  }, [group.activeTabKey, group.tabs]);
  return (
    <div
      ref={titlebar}
      className={`desk-group-bar${isElectron && rect.y === 0 ? " drag-region" : ""}`}
      data-desktop-titlebar={isElectron && rect.y === 0}
      data-window-left={rect.x === 0}
      data-window-top={rect.y === 0}
      data-window-right={rect.x + rect.width >= 0.999}
    >
      <div className="desk-header-controls">{controls}</div>
      <div className="desk-group-identity">
        <GroupGrip group={group} />
        <Tooltip>
          <TooltipTrigger
            render={
              <button className="desk-group-name" onClick={onRenameGroup}>
                {group.name}
              </button>
            }
          />
          <TooltipPopup side="bottom">Rename group</TooltipPopup>
        </Tooltip>
      </div>
      <div
        ref={(element) => {
          strip.current = element;
          drop.setNodeRef(element);
        }}
        className="desk-tab-strip"
        style={tabStripStyle}
        role="tablist"
        aria-label={`${group.name} tabs`}
      >
        {group.tabs.map((key, index) => {
          const target = desk.targets[key];
          return target ? (
            <Fragment key={key}>
              {insertionIndex === index && (
                <span
                  className="desk-tab-insertion"
                  data-desk-insertion-index={index}
                  aria-hidden
                />
              )}
              <ChatTab
                target={target}
                tabKey={key}
                group={pendingEditor ? { ...group, activeTabKey: null } : group}
                index={index}
                onMenu={onMenu}
                onRename={onRename}
              />
            </Fragment>
          ) : null;
        })}
        {insertionIndex === group.tabs.length && (
          <span
            className="desk-tab-insertion"
            data-desk-insertion-index={group.tabs.length}
            aria-hidden
          />
        )}
      </div>
      <button
        className="desk-icon"
        aria-label={restoreGroups ? "Restore all groups" : `Focus ${group.name}`}
        title={
          restoreGroups
            ? canRestoreGroups
              ? "Restore all groups"
              : "Enlarge the window to restore all groups"
            : "Focus group"
        }
        disabled={restoreGroups && !canRestoreGroups}
        onClick={onToggleFocus}
      >
        {restoreGroups ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              className="desk-icon"
              aria-label={`${group.name} tab actions`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onMenu(null, { x: r.left, y: r.bottom });
              }}
            >
              <MoreHorizontal size={15} />
            </button>
          }
        />
        <TooltipPopup side="bottom">Tab actions</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function Pane({
  group,
  rect,
  active,
  children,
  hint,
}: {
  group: DeskGroup;
  rect: DeskRect;
  active: boolean;
  children: ReactNode;
  hint: DropHint;
}) {
  const dispatch = useDeskStore((s) => s.dispatch);
  const drop = useDroppable({
    id: `pane:${group.id}`,
    data: { kind: "pane", groupId: group.id } satisfies DragData,
  });
  return (
    <section
      ref={drop.setNodeRef}
      className="desk-pane"
      style={rectStyle(rect)}
      aria-label={`${group.name} chat group`}
      data-active={active}
      onPointerDownCapture={(event) => {
        // Only a primary gesture selects the pane. Opening a tab's secondary
        // menu must retain the active chat, route and composer ownership.
        if (event.button === 0 && !isTabContextMenuGesture(event))
          dispatch({ type: "activateGroup", groupId: group.id });
      }}
      onFocusCapture={() => dispatch({ type: "activateGroup", groupId: group.id })}
    >
      {children}
      {hint?.kind === "pane" && hint.groupId === group.id && (
        <div className="desk-drop-hint" data-edge={hint.edge ?? "center"} aria-hidden />
      )}
    </section>
  );
}

function ResizeDivider({
  node,
  rect,
  area,
}: {
  node: Extract<DeskLayout, { kind: "split" }>;
  rect: DeskRect;
  area: DeskSize;
}) {
  const dispatch = useDeskStore((s) => s.dispatch);
  const x = node.axis === "x";
  const limits = deskResizeBounds(node, {
    width: rect.width * area.width,
    height: rect.height * area.height,
  });
  const style: CSSProperties = x
    ? {
        left: `${(rect.x + rect.width * node.ratio) * 100}%`,
        top: `${rect.y * 100}%`,
        height: `${rect.height * 100}%`,
      }
    : {
        top: `${(rect.y + rect.height * node.ratio) * 100}%`,
        left: `${rect.x * 100}%`,
        width: `${rect.width * 100}%`,
      };
  return (
    <div
      role="separator"
      tabIndex={0}
      className="desk-divider"
      data-axis={node.axis}
      aria-label="Resize chat groups"
      aria-orientation={x ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(node.ratio * 100)}
      aria-valuemin={Math.round((limits?.min ?? node.ratio) * 100)}
      aria-valuemax={Math.round((limits?.max ?? node.ratio) * 100)}
      style={style}
      onPointerDown={(e) => {
        if (e.button !== 0 || !limits) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const bounds = e.currentTarget.parentElement?.getBoundingClientRect();
        if (!bounds) return;
        // Derive the bound from the current host, not a stale pointer-down
        // width. Descendant panes also need their minimum sizes: clamping only
        // this split's immediate percentage can strand a nested divider.
        const currentLimits = deskResizeBounds(node, {
          width: rect.width * bounds.width,
          height: rect.height * bounds.height,
        });
        if (!currentLimits) return;
        const ratio = x
          ? ((e.clientX - bounds.left) / bounds.width - rect.x) / rect.width
          : ((e.clientY - bounds.top) / bounds.height - rect.y) / rect.height;
        dispatch({
          type: "resize",
          splitId: node.id,
          ratio: Math.max(currentLimits.min, Math.min(currentLimits.max, ratio)),
        });
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        useDeskStore.getState().flushPersistence();
      }}
      onPointerCancel={() => useDeskStore.getState().flushPersistence()}
      onKeyDown={(e) => {
        const delta = x
          ? e.key === "ArrowLeft"
            ? -0.05
            : e.key === "ArrowRight"
              ? 0.05
              : 0
          : e.key === "ArrowUp"
            ? -0.05
            : e.key === "ArrowDown"
              ? 0.05
              : 0;
        if (delta && limits) {
          e.preventDefault();
          dispatch({
            type: "resize",
            splitId: node.id,
            ratio: Math.max(limits.min, Math.min(limits.max, node.ratio + delta)),
          });
        }
      }}
    />
  );
}

export default function DeskWorkspace() {
  useDeskRouteSync();
  const isMobile = useIsMobile();
  const compactNavigation = !isElectron && isMobile;
  const desk = useDeskStore((s) => s.desk);
  const draftEditors = useDeskStore((s) => s.draftEditors);
  const activeDraftId = useDeskStore((s) => s.activeDraftId);
  const dispatch = useDeskStore((s) => s.dispatch);
  const defaultDocked = useUiStateStore((s) => s.sessionRailDocked);
  const { openRenameChat, renameChatDialog } = useRenameChat();
  const [renameGroup, setRenameGroup] = useState<{
    groupId: string;
    desk: DeskState;
  } | null>(null);
  const menuOwner = useRef<symbol | null>(null);
  const [groupName, setGroupName] = useState("");
  const [overflow, setOverflow] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [hint, setHint] = useState<DropHint>(null);
  const dragPointer = useRef<{ x: number; y: number } | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const root = useRef<HTMLDivElement>(null);
  const lastTarget = useRef<ThreadRouteTarget | null>(null);
  const drafts = useComposerDraftStore((s) => s.draftThreadsByThreadKey);
  const primaryEnvironmentId = useWorkspaceEnvironmentId();
  const shells = useStore((s) => selectEnvironmentState(s, primaryEnvironmentId).threadShellById);
  const bootstrapped = useStore(
    (s) => selectEnvironmentState(s, primaryEnvironmentId).bootstrapComplete,
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  useLayoutEffect(
    () => () => {
      // A native menu may answer after its workspace has unmounted. Revoking
      // during the unmount commit prevents that answer from affecting a new
      // mount even before passive effects have been flushed.
      menuOwner.current = null;
    },
    [],
  );
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setArea((previous) =>
        previous.width === el.clientWidth && previous.height === el.clientHeight
          ? previous
          : { width: el.clientWidth, height: el.clientHeight },
      ),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Fit the saved preferences to the current viewport without rewriting them.
  // Old extreme ratios and temporarily smaller windows must not turn a usable
  // split into automatic focus mode and remove its only resize handle.
  const fittedLayout = useMemo(() => fitDeskLayout(desk.layout, area), [desk.layout, area]);
  const geometry = useMemo(
    () => projectDeskLayout(fittedLayout ?? desk.layout),
    [fittedLayout, desk.layout],
  );
  const groupIds = deskGroupIds(desk.layout);
  // Never squeeze unchanged composers into unusable quarter-width slivers.
  // Collapse only when the layout cannot fit at ANY admissible ratios, not
  // because one user-selected ratio made an otherwise viable pane too small.
  const narrow = area.width > 0 && (area.width < 760 || fittedLayout === null);
  const isolated = compactNavigation
    ? desk.activeGroupId
    : (desk.focusedGroupId ?? (narrow ? desk.activeGroupId : null));
  const restoreGroups = desk.focusedGroupId !== null || (narrow && groupIds.length > 1);
  const canRestoreGroups = groupIds.length < 2 || !narrow;
  const toggleGroupFocus = (groupId: string) => {
    if (restoreGroups && !canRestoreGroups) return;
    dispatch({ type: "focus", groupId: restoreGroups ? null : groupId });
  };
  const panes = isolated
    ? [{ groupId: isolated, rect: { x: 0, y: 0, width: 1, height: 1 } }]
    : geometry.panes;
  const activeEditor =
    activeDraftId && drafts[activeDraftId]?.environmentId === primaryEnvironmentId
      ? draftEditors[activeDraftId]
      : null;
  const editorGroupId =
    activeEditor && desk.groups[activeEditor.groupId] ? activeEditor.groupId : desk.activeGroupId;
  const editorTarget: ThreadRouteTarget | null = activeEditor
    ? { kind: "draft", draftId: activeEditor.draftId }
    : null;
  const activeKey = desk.groups[desk.activeGroupId]?.activeTabKey;
  const selectedTarget = editorTarget ?? (activeKey ? desk.targets[activeKey] : null);
  const hasTabs = Object.values(desk.groups).some((g) => g.tabs.length > 0);
  const hasVisibleChat = hasTabs || editorTarget !== null;
  const admitted = (target: ThreadRouteTarget) =>
    target.kind === "server"
      ? target.threadRef.environmentId === primaryEnvironmentId &&
        shells[target.threadRef.threadId]?.archivedAt === null
      : drafts[target.draftId]?.environmentId === primaryEnvironmentId;
  const queueHostTarget = (target: ThreadRouteTarget | null): ThreadRouteTarget | null => {
    if (!target || !admitted(target)) return null;
    if (target.kind === "draft") return target;
    // A newly created server shell is not necessarily a renderable chat yet:
    // renderChat deliberately suppresses it while its exact draft owner still
    // exists. Normalize hidden hosts through the same ownership boundary, so
    // an empty Desk never silently loses every queue dispatcher after reload.
    const draft = Object.entries(drafts).find(
      ([, value]) =>
        value.environmentId === primaryEnvironmentId &&
        value.promotedTo?.environmentId === target.threadRef.environmentId &&
        value.promotedTo.threadId === target.threadRef.threadId,
    );
    return draft ? { kind: "draft", draftId: DraftId.make(draft[0]) } : target;
  };
  // A hidden queue owner must never survive deletion or cross the primary
  // environment boundary. On reload an empty Desk still hosts existing queues.
  lastTarget.current = queueHostTarget(lastTarget.current);
  const selectedHost = queueHostTarget(selectedTarget ?? null);
  if (selectedHost) lastTarget.current = selectedHost;
  const fallbackShell = !hasTabs
    ? Object.values(shells).find((shell) => shell.archivedAt === null)
    : null;
  const emptyQueueHost = queueHostTarget(
    lastTarget.current ??
      (primaryEnvironmentId && fallbackShell
        ? {
            kind: "server" as const,
            threadRef: { environmentId: primaryEnvironmentId, threadId: fallbackShell.id },
          }
        : null),
  );
  const rename = (target: ThreadRouteTarget) => {
    const meta = readDeskTabMetadata(target);
    if (meta.threadRef) openRenameChat(meta.threadRef, meta.title);
  };
  const chatActions = useDeskChatActions();
  const getOpenActions = useDeskOpenActions();

  const showMenu = async (
    groupId: string,
    tabKey: string | null,
    position: { x: number; y: number },
  ) => {
    const current = useDeskStore.getState().desk;
    const group = current.groups[groupId];
    if (!group || current.environmentId !== primaryEnvironmentId) return;
    const editorMenu = tabKey === null && groupId === editorGroupId && editorTarget !== null;
    const key = editorMenu ? null : (tabKey ?? group.activeTabKey);
    if (key && !group.tabs.includes(key)) return;
    const target = editorMenu ? editorTarget : key ? current.targets[key] : null;
    const openActions = target ? getOpenActions(target) : null;
    const owner = Symbol();
    menuOwner.current = owner;
    const items: ContextMenuItem[] = [];
    items.push(...(openActions?.items ?? []));
    const actions = new Map<string, DeskAction>();
    const item = (id: string, label: string, action: DeskAction, disabled = false) => {
      items.push({ id, label, disabled });
      actions.set(id, action);
    };
    if (key && target) {
      if (group.previewTabKey === key)
        item("keep-open", "Keep open", { type: "keepOpen", tabKey: key });
      items.push({
        id: "rename-chat",
        label: "Rename chat…",
        disabled: !readDeskTabMetadata(target).threadRef,
      });
      items.push(...chatActions.items(target));
      item("close", "Close tab", { type: "close", tabKey: key });
      item(
        "others",
        "Close other tabs",
        { type: "closeOthers", tabKey: key },
        group.tabs.length < 2,
      );
      item(
        "right",
        "Close tabs to the right",
        { type: "closeRight", tabKey: key },
        group.tabs.at(-1) === key,
      );
      for (const edge of ["right", "bottom"] as const)
        item(
          `split-${edge}`,
          `Split ${edge === "right" ? "right" : "below"}`,
          { type: "split", tabKey: key, targetGroupId: groupId, edge },
          groupIds.length >= 4 || group.tabs.length < 2,
        );
      for (const otherId of groupIds)
        if (otherId !== groupId)
          item(`move-${otherId}`, `Move tab to ${current.groups[otherId]!.name}`, {
            type: "move",
            tabKey: key,
            groupId: otherId,
            index: current.groups[otherId]!.tabs.length,
          });
    }
    item(
      "close-group",
      "Close all tabs in group",
      { type: "closeGroup", groupId },
      !group.tabs.length,
    );
    item("close-all", "Close all tabs", { type: "closeAll" }, !hasTabs);
    item("reopen", "Reopen closed tab", { type: "reopen" }, !current.closed.length);
    items.push({ id: "all-tabs", label: "Search open tabs…" });
    items.push({ id: "rename-group", label: "Rename group…" });
    for (const otherId of groupIds)
      if (otherId !== groupId) {
        item(`merge-${otherId}`, `Merge into ${current.groups[otherId]!.name}`, {
          type: "merge",
          sourceGroupId: groupId,
          targetGroupId: otherId,
        });
        item(`swap-${otherId}`, `Swap with ${current.groups[otherId]!.name}`, {
          type: "swapGroups",
          firstGroupId: groupId,
          secondGroupId: otherId,
        });
      }
    item(
      "focus",
      restoreGroups ? "Restore all groups" : "Focus group",
      { type: "focus", groupId: restoreGroups ? null : groupId },
      restoreGroups && !canRestoreGroups,
    );
    const railDocked = group.sessionRailDocked ?? defaultDocked;
    item("session-rail", railDocked ? "Unpin session information" : "Pin session information", {
      type: "sessionRail",
      groupId,
      docked: !railDocked,
    });
    const clicked = await readLocalApi()?.contextMenu.show(items, position);
    if (!clicked || menuOwner.current !== owner) return;
    // Chat mutations retain their captured environment/chat authority and
    // perform their existing metadata/confirmation checks independently of
    // navigation. Never resolve them from whichever tab is now active.
    if (target && (await chatActions.run(clicked, target))) return;
    // Local actions contain reusable group IDs and relative tab/layout intent.
    // Bind that consent to the exact immutable Desk snapshot, not its IDs or
    // environment string: a reset/reload can replace both under the same names.
    // Recheck after the awaited chat-action discriminator as well as the menu.
    if (menuOwner.current !== owner || useDeskStore.getState().desk !== current) return;
    if (openActions?.run(clicked)) return;
    if (clicked === "all-tabs") {
      setFilter("");
      setOverflow(groupId);
    } else if (clicked === "rename-chat" && target) rename(target);
    else if (clicked === "rename-group") {
      setGroupName(group.name);
      setRenameGroup({ groupId, desk: current });
    } else if (clicked && actions.has(clicked)) dispatch(actions.get(clicked)!);
  };

  const getDragPoint = (event: DragMoveEvent) => {
    // dnd-kit PointerSensor reports viewport coordinates to collisionDetection.
    // Its move/end delta also includes scroll adjustment; adding that delta to
    // pointerdown drifts away from the cursor after the tab strip autoscrolls.
    // Use the exact collision point for pointer gestures and the translated
    // draggable center only for keyboard gestures, which have no pointer.
    if ("clientX" in event.activatorEvent) return dragPointer.current;
    const rect = event.active.rect.current.translated;
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  };
  const getHint = (event: DragMoveEvent): DropHint => {
    const data = event.over?.data.current as DragData | undefined;
    if (!data) return null;
    // Dnd-kit can emit movement before committing a new `over`. A containing
    // pane still contains the pointer when a tab has become the first hit, so
    // bounds alone cannot prevent a stale split preview above the tab strip.
    if (event.collisions?.[0]?.id !== event.over?.id) return null;
    const point = getDragPoint(event);
    const rect = event.over!.rect;
    // onDragMove can precede onDragOver when crossing target IDs. Do not flash
    // the old pane's center preview while the pointer is already outside it.
    if (
      "clientX" in event.activatorEvent &&
      (!point ||
        point.x < rect.left ||
        point.x > rect.left + rect.width ||
        point.y < rect.top ||
        point.y > rect.top + rect.height)
    )
      return null;
    const source = event.active.data.current as DragData | undefined;
    if (source?.kind !== "tab") return { kind: "pane", groupId: data.groupId, edge: null };
    const group = useDeskStore.getState().desk.groups[data.groupId];
    if (!group) return null;
    if (data.kind === "tab") {
      const index = group.tabs.indexOf(data.tabKey);
      if (index < 0) return null;
      return {
        kind: "insert",
        groupId: data.groupId,
        index: index + (point && point.x > rect.left + rect.width / 2 ? 1 : 0),
      };
    }
    if (data.kind === "strip") {
      return { kind: "insert", groupId: data.groupId, index: group.tabs.length };
    }
    return { kind: "pane", groupId: data.groupId, edge: point ? deskDropEdge(point, rect) : null };
  };
  const updateHint = (event: DragMoveEvent) => {
    const next = getHint(event);
    // onDragOver is target-ID based in dnd-kit, not position based. Also listen
    // to moves to update center/edge previews inside one pane, but avoid a Desk
    // rerender for every pixel when the visible destination hasn't changed.
    setHint((previous) => {
      if (!previous || !next || previous.groupId !== next.groupId) return next;
      if (previous.kind === "insert" && next.kind === "insert" && previous.index === next.index)
        return previous;
      if (previous.kind === "pane" && next.kind === "pane" && previous.edge === next.edge)
        return previous;
      return next;
    });
  };
  const endDrag = (event: DragEndEvent) => {
    const source = event.active.data.current as DragData | undefined;
    const over = event.over?.data.current as DragData | undefined;
    const destination = getHint(event);
    setHint(null);
    dragPointer.current = null;
    if (!source || !over || !destination) return;
    if (source.kind === "group") {
      dispatch({ type: "swapGroups", firstGroupId: source.groupId, secondGroupId: over.groupId });
      return;
    }
    if (source.kind !== "tab") return;
    if (destination.kind === "insert") {
      const current = useDeskStore.getState().desk;
      const old = current.groups[destination.groupId]?.tabs.indexOf(source.tabKey) ?? -1;
      const index = deskInsertionIndex(old, destination.index, false);
      dispatch({ type: "move", tabKey: source.tabKey, groupId: destination.groupId, index });
    } else if (destination.edge) {
      dispatch({
        type: "split",
        tabKey: source.tabKey,
        targetGroupId: over.groupId,
        edge: destination.edge,
      });
    } else {
      const tabs = useDeskStore.getState().desk.groups[over.groupId]?.tabs ?? [];
      dispatch({
        type: "move",
        tabKey: source.tabKey,
        groupId: over.groupId,
        index: tabs.length - (tabs.includes(source.tabKey) ? 1 : 0),
      });
    }
  };

  function renderChat(
    target: ThreadRouteTarget,
    navigationSlot?: (controls: ReactNode) => ReactNode,
  ) {
    if (!bootstrapped) return null;
    if (target.kind === "server") {
      // Promotion reconciliation runs after commit. Suppress the canonical
      // alias during that boundary so React never mounts two owners for one
      // provider thread while its draft is still completing initialization.
      const pending = Object.values(drafts).some(
        (draft) =>
          draft.promotedTo?.environmentId === target.threadRef.environmentId &&
          draft.promotedTo.threadId === target.threadRef.threadId,
      );
      if (pending) return null;
      return target.threadRef.environmentId === primaryEnvironmentId &&
        shells[target.threadRef.threadId]?.archivedAt === null ? (
        <ChatView
          environmentId={target.threadRef.environmentId}
          threadId={target.threadRef.threadId}
          routeKind="server"
          navigationSlot={navigationSlot}
        />
      ) : null;
    }
    const draft = drafts[target.draftId];
    if (!draft || draft.environmentId !== primaryEnvironmentId) return null;
    return (
      <ChatView
        environmentId={draft.environmentId}
        threadId={draft.threadId}
        draftId={target.draftId}
        routeKind="draft"
        navigationSlot={navigationSlot}
      />
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 min-w-0 overflow-hidden bg-background text-foreground">
      <DndContext
        sensors={sensors}
        collisionDetection={(args) => {
          dragPointer.current = args.pointerCoordinates;
          return deskCollisionDetection(args);
        }}
        onDragStart={() => {
          dragPointer.current = null;
          setHint(null);
        }}
        onDragMove={updateHint}
        onDragOver={updateHint}
        onDragEnd={endDrag}
        onDragCancel={() => {
          dragPointer.current = null;
          setHint(null);
        }}
      >
        <div className="desk-workspace" ref={root}>
          {!hasVisibleChat ? (
            <NoActiveThreadState
              secondaryActions={
                <>
                  <Button
                    variant="outline"
                    onClick={() => useCommandPaletteStore.getState().setOpen(true)}
                  >
                    <Search />
                    Open a chat
                  </Button>
                  {desk.closed.length > 0 ? (
                    <Button variant="ghost" onClick={() => dispatch({ type: "reopen" })}>
                      <RotateCcw />
                      Reopen closed tab
                    </Button>
                  ) : null}
                </>
              }
            />
          ) : (
            panes.map(({ groupId, rect }) => {
              const group = desk.groups[groupId];
              const key = group?.activeTabKey;
              const pendingEditor = editorTarget !== null && groupId === editorGroupId;
              const target = pendingEditor ? editorTarget : key ? desk.targets[key] : null;
              if (!group || !target || desk.environmentId !== primaryEnvironmentId) return null;
              const active = groupId === desk.activeGroupId;
              return (
                <Pane
                  key={deskTabKey(target)}
                  group={group}
                  rect={rect}
                  active={active}
                  hint={hint}
                >
                  <ChatPaneContext
                    value={{
                      active,
                      visible: true,
                      autoFocusComposer: target.kind === "draft",
                      sessionRailDocked: group.sessionRailDocked ?? defaultDocked,
                      onSessionRailDockedChange: (docked) =>
                        dispatch({ type: "sessionRail", groupId, docked }),
                    }}
                  >
                    {renderChat(
                      target,
                      compactNavigation
                        ? undefined
                        : (controls) => (
                            <>
                              <GroupTabs
                                controls={controls}
                                rect={rect}
                                group={group}
                                pendingEditor={pendingEditor}
                                hint={hint}
                                restoreGroups={restoreGroups}
                                canRestoreGroups={canRestoreGroups}
                                onToggleFocus={() => toggleGroupFocus(groupId)}
                                onMenu={(key, pos) => {
                                  void showMenu(groupId, key, pos);
                                }}
                                onRename={rename}
                                onRenameGroup={() => {
                                  setGroupName(group.name);
                                  setRenameGroup({ groupId, desk: useDeskStore.getState().desk });
                                }}
                              />
                              {isolated && groupIds.length > 1 && (
                                <div
                                  className="desk-group-switcher"
                                  role="group"
                                  aria-label="Chat groups"
                                >
                                  {groupIds.map((id) => (
                                    <button
                                      key={id}
                                      aria-pressed={id === isolated}
                                      onClick={() => {
                                        dispatch({ type: "activateGroup", groupId: id });
                                        if (desk.focusedGroupId)
                                          dispatch({ type: "focus", groupId: id });
                                      }}
                                    >
                                      {desk.groups[id]!.name}
                                    </button>
                                  ))}
                                  {desk.focusedGroupId && (
                                    <button
                                      disabled={!canRestoreGroups}
                                      title={
                                        canRestoreGroups
                                          ? undefined
                                          : "Enlarge the window to restore all groups"
                                      }
                                      onClick={() => toggleGroupFocus(groupId)}
                                    >
                                      Restore layout
                                    </button>
                                  )}
                                </div>
                              )}
                            </>
                          ),
                    )}
                  </ChatPaneContext>
                </Pane>
              );
            })
          )}
          {!isolated &&
            hasVisibleChat &&
            geometry.dividers.map(({ node, rect }) => (
              <ResizeDivider key={node.id} node={node} rect={rect} area={area} />
            ))}
          {Object.values(draftEditors).map((editor) => {
            const session = drafts[editor.draftId];
            // Keep pending sends mounted in the background without mounting
            // idle recovered drafts or introducing a second provider owner.
            return editor.draftId !== activeDraftId &&
              session?.environmentId === primaryEnvironmentId &&
              (session.promotedTo ||
                isChatSendInFlight(session.environmentId, session.threadId)) ? (
              <div key={editor.draftId} hidden aria-hidden inert>
                <ChatPaneContext value={{ active: false, visible: false }}>
                  {renderChat({ kind: "draft", draftId: editor.draftId })}
                </ChatPaneContext>
              </div>
            ) : null;
          })}
          {!hasVisibleChat &&
            emptyQueueHost &&
            !(emptyQueueHost.kind === "draft" && draftEditors[emptyQueueHost.draftId]) &&
            desk.environmentId === primaryEnvironmentId && (
              <div hidden aria-hidden inert>
                <ChatPaneContext value={{ active: false, visible: false }}>
                  {renderChat(emptyQueueHost)}
                </ChatPaneContext>
              </div>
            )}
        </div>
      </DndContext>
      {renameChatDialog}
      <Dialog
        open={renameGroup !== null}
        onOpenChange={(open) => {
          if (!open) setRenameGroup(null);
        }}
      >
        <DialogPopup>
          <div className="p-5 space-y-3">
            <DialogTitle>Rename tab group</DialogTitle>
            <DialogDescription>
              Groups organize open chats without moving their projects.
            </DialogDescription>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (renameGroup && groupName.trim()) {
                  // The dialog is another asynchronous consent boundary: a
                  // recycled group ID cannot inherit an earlier rename form.
                  if (useDeskStore.getState().desk === renameGroup.desk)
                    dispatch({
                      type: "renameGroup",
                      groupId: renameGroup.groupId,
                      name: groupName,
                    });
                  setRenameGroup(null);
                }
              }}
            >
              <Input
                aria-label="Group name"
                maxLength={80}
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
              />
              <Button type="submit" className="mt-3" disabled={!groupName.trim()}>
                Save
              </Button>
            </form>
          </div>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={overflow !== null}
        onOpenChange={(open) => {
          if (!open) setOverflow(null);
        }}
      >
        <DialogPopup>
          <div className="p-5 space-y-3">
            <DialogTitle>Open tabs</DialogTitle>
            <DialogDescription>Select a chat in this group.</DialogDescription>
            <Input
              type="search"
              aria-label="Search open tabs"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="max-h-80 overflow-y-auto">
              {(overflow ? desk.groups[overflow]?.tabs : [])?.map((key) => {
                const target = desk.targets[key];
                if (!target) return null;
                const meta = readDeskTabMetadata(target);
                if (
                  !`${meta.title} ${meta.projectName}`.toLowerCase().includes(filter.toLowerCase())
                )
                  return null;
                return (
                  <button
                    key={key}
                    className="desk-overflow-row"
                    onClick={() => {
                      dispatch({ type: "select", tabKey: key });
                      setOverflow(null);
                    }}
                  >
                    <span>{meta.title}</span>
                    <small>{meta.projectName}</small>
                  </button>
                );
              })}
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  );
}
