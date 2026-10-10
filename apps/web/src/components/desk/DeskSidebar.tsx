import type { EnvironmentId, ScopedThreadRef } from "@cafecode/contracts";
import { autoAnimate } from "@formkit/auto-animate";
import { PencilIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { DESK_LIMITS, deskGroupIds, type DeskGroup, type DeskState } from "../../deskModel";
import { useDeskStore } from "../../deskStore";
import { renameThread } from "../../threadRename";
import { readLocalApi } from "../../localApi";
import type { ThreadRouteTarget } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { resolveThreadRowClassName } from "../Sidebar.logic";
import { SidebarNewChatButton } from "../sidebar/SidebarNewChatButton";
import { ThreadStatusLabel } from "../ThreadStatusLabel";
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useDeskTabMetadata } from "./useDeskTabMetadata";
import { useDeskChatActions } from "./useDeskChatActions";

/** Matches the Projects lists so open, close and reorder move the same way. */
const DESK_LIST_ANIMATION_OPTIONS = { duration: 180, easing: "ease-out" } as const;

type SidebarMenuOwnership = {
  readonly claim: () => symbol;
  readonly owns: (owner: symbol | null) => boolean;
  readonly revoke: (owner: symbol | null) => void;
};

const DESK_ROW_ACTION_CLASS_NAME =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-subtle-foreground transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring max-md:size-8";

const DeskSidebarRow = memo(function DeskSidebarRow({
  target,
  selected,
  preview,
  onActivate,
  onKeepOpen,
  onClose,
  chatActions,
  deskSnapshot,
  menuOwnership,
}: {
  target: ThreadRouteTarget;
  selected: boolean;
  preview: boolean;
  onActivate: () => void;
  onKeepOpen: () => void;
  onClose: () => void;
  chatActions: ReturnType<typeof useDeskChatActions>;
  deskSnapshot: DeskState;
  menuOwnership: SidebarMenuOwnership;
}) {
  const metadata = useDeskTabMetadata(target);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const renameRef = useRef<{
    ref: ScopedThreadRef;
    originalTitle: string;
    value: string;
  } | null>(null);
  const savingRef = useRef(false);
  const focusFrameRef = useRef<number | null>(null);
  const rowMenuOwner = useRef<symbol | null>(null);

  const revokeMenu = () => {
    // Another row can replace this menu before this row is removed. Its
    // cleanup must revoke only its own choice, never the successor's token.
    menuOwnership.revoke(rowMenuOwner.current);
    rowMenuOwner.current = null;
  };

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  useLayoutEffect(
    () => () => {
      // A late response belongs to this row's original edit, never a reopened
      // row or a chat selected after it was closed or moved to another group.
      renameRef.current = null;
      menuOwnership.revoke(rowMenuOwner.current);
      rowMenuOwner.current = null;
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    },
    [menuOwnership],
  );

  const restoreRowFocus = () => {
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      // Saving after blur must not take focus away from the control the user
      // just selected. Only restore focus lost when this input was removed.
      if (document.activeElement === document.body) buttonRef.current?.focus();
    });
  };
  const beginRename = () => {
    if (!metadata.threadRef || !metadata.exists || savingRef.current) return;
    revokeMenu();
    renameRef.current = {
      ref: metadata.threadRef,
      originalTitle: metadata.title,
      value: metadata.title,
    };
    setTitle(metadata.title);
    setError(null);
    setEditing(true);
  };
  const cancelRename = () => {
    if (savingRef.current) return;
    // Clear synchronously: removing the input can fire blur, which must not
    // save an edit cancelled with Escape.
    renameRef.current = null;
    setEditing(false);
    setError(null);
    restoreRowFocus();
  };
  const saveRename = async () => {
    const edit = renameRef.current;
    if (!edit || savingRef.current) return;
    if (!edit.value.trim() || edit.value.trim() === edit.originalTitle) {
      cancelRename();
      return;
    }
    // Enter followed by blur is one user action, not two rename commands.
    // Keep the identity and original title captured at the start of editing.
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await renameThread(edit.ref, edit.value, edit.originalTitle);
      if (renameRef.current !== edit) return;
      renameRef.current = null;
      setEditing(false);
      restoreRowFocus();
    } catch {
      if (renameRef.current === edit) {
        // Do not render raw transport errors; retain the draft for an explicit
        // retry without exposing backend diagnostic details in the sidebar.
        setError("Could not rename this chat. Check the connection and press Enter to retry.");
      }
    } finally {
      savingRef.current = false;
      if (renameRef.current === edit || renameRef.current === null) setSaving(false);
    }
  };
  const showMenu = async (position: { x: number; y: number }) => {
    if (editing || savingRef.current || useDeskStore.getState().desk !== deskSnapshot) return;
    const owner = menuOwnership.claim();
    rowMenuOwner.current = owner;
    const action = await readLocalApi()?.contextMenu.show(
      [
        ...(metadata.threadRef && metadata.exists ? [{ id: "rename", label: "Rename chat…" }] : []),
        ...chatActions.items(target),
        { id: "close", label: "Close tab" },
      ],
      position,
    );
    if (!menuOwnership.owns(owner) || rowMenuOwner.current !== owner) return;
    revokeMenu();
    if (action === "rename" || action === "close") {
      // Reopened tabs and restored layouts can reuse the same chat/group IDs.
      // Local intent belongs to this immutable snapshot, not its successor.
      if (useDeskStore.getState().desk !== deskSnapshot) return;
      if (action === "rename") beginRename();
      else onClose();
    } else if (action) {
      // Server actions retain the exact captured chat and the existing
      // confirmation/admission boundary, independent of current selection.
      await chatActions.run(action, target);
    }
  };
  return (
    <SidebarMenuSubItem
      className="group/desk-row w-full"
      data-desk-chat-row
      onContextMenu={(event) => {
        if (editing) return;
        event.preventDefault();
        event.stopPropagation();
        void showMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {/* Use Projects' row primitive and state classes, including its full-width
          selected background. Time and actions share one reserved trailing slot;
          hovering swaps them without shifting or retruncating the title. */}
      <SidebarMenuSubButton
        size="sm"
        isActive={selected}
        className={`${resolveThreadRowClassName({ isActive: selected, isSelected: false })} relative isolate group-hover/desk-row:bg-accent group-hover/desk-row:text-foreground ${selected ? "dark:group-hover/desk-row:bg-accent/70" : ""}`}
        render={
          editing ? (
            <div />
          ) : (
            <button
              ref={buttonRef}
              type="button"
              aria-label={metadata.title}
              aria-current={selected ? "page" : undefined}
              onClick={onActivate}
              onDoubleClick={onKeepOpen}
              onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  event.preventDefault();
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  void showMenu({ x: rect.left, y: rect.bottom });
                  return;
                }
                if (event.key === "F2" && metadata.threadRef && metadata.exists) {
                  event.preventDefault();
                  beginRename();
                }
              }}
            />
          )
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <ThreadStatusLabel status={metadata.status} />
          {editing ? (
            <input
              ref={inputRef}
              aria-label="Chat title"
              aria-invalid={error !== null}
              aria-busy={saving}
              className="min-w-0 flex-1 truncate rounded-sm border border-ring bg-transparent px-0.5 text-base outline-none sm:text-ui"
              value={title}
              readOnly={saving}
              onChange={(event) => {
                setTitle(event.target.value);
                if (renameRef.current) renameRef.current.value = event.target.value;
                setError(null);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
              onBlur={() => void saveRename()}
            />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    data-desk-row-title
                    className={`min-w-0 flex-1 truncate text-ui ${preview ? "italic" : ""}`}
                  >
                    {metadata.title}
                  </span>
                }
              />
              {/* The project is context, so it lives in the tooltip, not the row. */}
              <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
                {metadata.projectName
                  ? `${metadata.title} · ${metadata.projectName}`
                  : metadata.title}
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
        <div className="ml-auto flex min-w-12 shrink-0 justify-end max-md:min-w-20">
          <span
            data-desk-row-meta
            className={`pointer-events-none text-2xs tabular-nums transition-opacity duration-(--duration-fast) group-hover/desk-row:opacity-0 group-has-focus-visible/desk-row:opacity-0 [@media(hover:none)_and_(pointer:coarse)]:opacity-0 ${editing ? "opacity-0" : ""} ${selected ? "text-muted-foreground" : "text-subtle-foreground"}`}
          >
            {metadata.activityAt ? formatRelativeTimeLabel(metadata.activityAt) : null}
          </span>
        </div>
      </SidebarMenuSubButton>
      {!editing ? (
        <div
          data-desk-row-actions
          className="pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/desk-row:pointer-events-auto group-hover/desk-row:opacity-100 group-has-focus-visible/desk-row:pointer-events-auto group-has-focus-visible/desk-row:opacity-100 [@media(hover:none)_and_(pointer:coarse)]:pointer-events-auto [@media(hover:none)_and_(pointer:coarse)]:opacity-100"
        >
          {metadata.threadRef && metadata.exists ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Rename ${metadata.title}`}
                    className={DESK_ROW_ACTION_CLASS_NAME}
                    onClick={beginRename}
                  >
                    <PencilIcon className="size-3" />
                  </button>
                }
              />
              <TooltipPopup side="top">Rename (F2)</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Close tab ${metadata.title}`}
                  className={DESK_ROW_ACTION_CLASS_NAME}
                  onClick={onClose}
                >
                  <XIcon className="size-3" />
                </button>
              }
            />
            <TooltipPopup side="top">Close tab (chat keeps running)</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </SidebarMenuSubItem>
  );
});

/** Group names are local layout metadata. Keep editing separate from the
 * activation button so renaming an inactive group never switches its chat. */
const DeskSidebarGroupHeading = memo(function DeskSidebarGroupHeading({
  group,
  environmentId,
  count,
  selected,
  onActivate,
  onRename,
}: {
  group: DeskGroup;
  environmentId: EnvironmentId | null;
  count: number;
  selected: boolean;
  onActivate: () => void;
  onRename: (name: string) => void;
}) {
  const name = group.name;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const editRef = useRef<{
    originalName: string;
    value: string;
    group: DeskGroup;
    environmentId: EnvironmentId | null;
    onRename: (name: string) => void;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const focusFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  useLayoutEffect(
    () => () => {
      editRef.current = null;
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    },
    [],
  );

  const beginRename = () => {
    const current = useDeskStore.getState().desk;
    // Resolve at the gesture, including when a store update precedes React's
    // next render. A stale heading cannot start editing a replacement group.
    if (current.environmentId !== environmentId || current.groups[group.id] !== group) return;
    editRef.current = { originalName: name, value: name, group, environmentId, onRename };
    setValue(name);
    setEditing(true);
  };
  const finishRename = (commit: boolean) => {
    const edit = editRef.current;
    if (!edit) return;
    // Enter/Escape can remove the input and trigger blur. Retire this exact
    // edit first so blur neither repeats a commit nor saves a cancelled name.
    editRef.current = null;
    const nextName = edit.value.trim();
    const current = useDeskStore.getState().desk;
    const ownsGroup =
      current.environmentId === edit.environmentId && current.groups[edit.group.id] === edit.group;
    // Unrelated pane activation may change the Desk snapshot before blur.
    // Keep that ordinary save, but never cross a replaced group incarnation.
    if (commit && ownsGroup && nextName && nextName !== edit.originalName) edit.onRename(nextName);
    setEditing(false);
    if (!ownsGroup) return;
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      // A blur commit must leave focus on the control the user just selected.
      if (document.activeElement === document.body) buttonRef.current?.focus();
    });
  };

  return (
    <div data-desk-group-heading className="group/desk-group relative">
      {editing ? (
        <div className="flex h-7 w-full items-center px-2 pr-9">
          <input
            ref={inputRef}
            aria-label="Group name"
            className="min-w-0 flex-1 truncate rounded-sm border border-ring bg-transparent px-0.5 text-base outline-none sm:text-xs"
            maxLength={DESK_LIMITS.nameLength}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              if (editRef.current) editRef.current.value = event.target.value;
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault();
                finishRename(event.key === "Enter");
              }
            }}
            onBlur={() => finishRename(true)}
          />
        </div>
      ) : (
        <>
          <button
            ref={buttonRef}
            type="button"
            aria-label={`Activate group ${name}`}
            aria-pressed={selected}
            className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-xs font-medium text-muted-foreground transition-colors duration-(--duration-fast) group-hover/desk-group:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:text-foreground"
            onClick={onActivate}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                event.stopPropagation();
                beginRename();
              }
            }}
          >
            <span data-desk-group-name className="min-w-0 flex-1 truncate">
              {name}
            </span>
            <span
              data-desk-group-count
              className="pointer-events-none min-w-5 shrink-0 text-right text-2xs font-normal tabular-nums text-subtle-foreground transition-opacity duration-(--duration-fast) group-hover/desk-group:opacity-0 group-has-focus-visible/desk-group:opacity-0 [@media(hover:none)_and_(pointer:coarse)]:opacity-0"
            >
              {count}
            </span>
          </button>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Rename group ${name}`}
                  className="pointer-events-none absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-subtle-foreground opacity-0 transition-[opacity,color] duration-(--duration-fast) hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring max-md:size-8 group-hover/desk-group:pointer-events-auto group-hover/desk-group:opacity-100 group-has-focus-visible/desk-group:pointer-events-auto group-has-focus-visible/desk-group:opacity-100 [@media(hover:none)_and_(pointer:coarse)]:pointer-events-auto [@media(hover:none)_and_(pointer:coarse)]:opacity-100"
                  onClick={beginRename}
                >
                  <PencilIcon className="size-3" />
                </button>
              }
            />
            <TooltipPopup side="top">Rename group (F2)</TooltipPopup>
          </Tooltip>
        </>
      )}
    </div>
  );
});

/** The Desk lists open views, not a second chat catalog. All chat mutations
 * continue through existing APIs; closing a view only updates local layout.
 */
export function DeskSidebar({
  onNavigate,
  onNewChat,
  newChatDisabled = false,
}: {
  onNavigate: (target: ThreadRouteTarget) => void;
  onNewChat: () => void;
  newChatDisabled?: boolean;
}) {
  const desk = useDeskStore((state) => state.desk);
  const dispatch = useDeskStore((state) => state.dispatch);
  const chatActions = useDeskChatActions();
  const menuOwner = useRef<symbol | null>(null);
  // The sidebar owns the shared token. Rows receive stable operations rather
  // than a mutable ref prop, and retiring one row cannot revoke its successor.
  const menuOwnership = useMemo<SidebarMenuOwnership>(
    () => ({
      claim: () => {
        const owner = Symbol();
        menuOwner.current = owner;
        return owner;
      },
      owns: (owner) => owner !== null && menuOwner.current === owner,
      revoke: (owner) => {
        if (owner !== null && menuOwner.current === owner) menuOwner.current = null;
      },
    }),
    [],
  );
  useLayoutEffect(
    () => () => {
      menuOwner.current = null;
    },
    [],
  );
  // Rows animate in, out and between positions (docs/style-guide.md §8).
  const animatedListsRef = useRef(new WeakSet<HTMLElement>());
  const attachListAutoAnimate = useCallback((node: HTMLElement | null) => {
    if (!node || animatedListsRef.current.has(node)) return;
    autoAnimate(node, DESK_LIST_ANIMATION_OPTIONS);
    animatedListsRef.current.add(node);
  }, []);
  return (
    <section aria-label="Desk open chats" className="px-2 py-2">
      <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
        <span className="label-overline">Chats</span>
        <SidebarNewChatButton
          label="New chat in active tab group"
          disabled={newChatDisabled}
          onClick={onNewChat}
        />
      </div>
      {deskGroupIds(desk.layout).map((groupId) => {
        const group = desk.groups[groupId];
        if (!group) return null;
        return (
          <section
            // Group IDs repeat across local environment layouts. Remount the
            // editor on a namespace change instead of carrying its draft over.
            key={JSON.stringify([desk.environmentId, groupId])}
            aria-label={`${group.name} tab group`}
            className="mb-2"
          >
            <DeskSidebarGroupHeading
              group={group}
              environmentId={desk.environmentId}
              count={group.tabs.length}
              selected={desk.activeGroupId === groupId}
              onActivate={() => {
                dispatch({ type: "activateGroup", groupId });
                const active = group.activeTabKey ? desk.targets[group.activeTabKey] : null;
                if (active) onNavigate(active);
              }}
              onRename={(name) => {
                // A namespace switch may precede React's unmount/blur work.
                // The captured group can only mutate its original local Desk.
                if (useDeskStore.getState().desk.environmentId !== desk.environmentId) return;
                dispatch({ type: "renameGroup", groupId, name });
              }}
            />
            <SidebarMenuSub
              ref={attachListAutoAnimate}
              className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0"
            >
              {group.tabs.map((tabKey) => {
                const target = desk.targets[tabKey];
                if (!target) return null;
                return (
                  <DeskSidebarRow
                    key={tabKey}
                    target={target}
                    chatActions={chatActions}
                    deskSnapshot={desk}
                    menuOwnership={menuOwnership}
                    selected={desk.activeGroupId === groupId && group.activeTabKey === tabKey}
                    preview={group.previewTabKey === tabKey}
                    onActivate={() => {
                      dispatch({ type: "select", tabKey });
                      onNavigate(target);
                    }}
                    onClose={() => dispatch({ type: "close", tabKey })}
                    onKeepOpen={() => dispatch({ type: "keepOpen", tabKey })}
                  />
                );
              })}
            </SidebarMenuSub>
            {group.tabs.length === 0 ? (
              <p className="px-3 py-1 text-xs text-subtle-foreground">No open chats</p>
            ) : null}
          </section>
        );
      })}
    </section>
  );
}
