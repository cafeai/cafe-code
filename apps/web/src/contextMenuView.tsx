import type { ContextMenuItem } from "@cafecode/contracts";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Copy,
  FolderInput,
  GitFork,
  LayoutPanelLeft,
  Maximize2,
  PanelLeftClose,
  Pencil,
  Pin,
  RotateCcw,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useRef } from "react";
import { createRoot } from "react-dom/client";
import { randomUUID } from "./lib/utils";

import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./components/ui/menu";

// These are presentation hints for existing, server-independent action ids.
// Labels remain inert React text and no id acquires dispatch authority here.
function decoration(id: string): { icon: LucideIcon; group: string } {
  if (id.startsWith("rename")) return { icon: Pencil, group: "edit" };
  if (id === "fork") return { icon: GitFork, group: "edit" };
  if (id.startsWith("copy")) return { icon: Copy, group: "copy" };
  if (id === "archive") return { icon: Archive, group: "history" };
  if (id === "unarchive" || id === "restore") return { icon: ArchiveRestore, group: "history" };
  if (id.startsWith("delete")) return { icon: Trash2, group: "history" };
  if (id === "reopen") return { icon: RotateCcw, group: "tabs" };
  if (id.startsWith("close") || id === "others" || id === "right")
    return { icon: X, group: "tabs" };
  if (id === "split-right") return { icon: SquareSplitHorizontal, group: "layout" };
  if (id === "split-bottom") return { icon: SquareSplitVertical, group: "layout" };
  if (id.startsWith("move")) return { icon: FolderInput, group: "layout" };
  if (id === "focus") return { icon: Maximize2, group: "layout" };
  if (id === "session-rail") return { icon: Pin, group: "layout" };
  if (id.startsWith("merge")) return { icon: PanelLeftClose, group: "layout" };
  if (id.startsWith("swap")) return { icon: LayoutPanelLeft, group: "layout" };
  if (id === "repair-thread") return { icon: Wrench, group: "maintenance" };
  return { icon: ArrowRight, group: "other" };
}

const panelClass =
  "z-[10000] w-72 max-w-[calc(100vw-1rem)] rounded-xl border-border/80 bg-popover/95 text-popover-foreground shadow-[0_12px_36px_-8px_rgb(0_0_0/35%)] backdrop-blur-xl [&>div]:p-1.5";
const rowClass =
  "min-h-9 gap-3 rounded-lg px-2.5 py-2 text-sm sm:min-h-9 sm:text-sm [&>svg]:size-4 [&>svg]:opacity-75";

function MenuEntries<T extends string>({
  items,
  select,
}: {
  readonly items: readonly ContextMenuItem<T>[];
  readonly select: (id: T) => void;
}) {
  const pressed = useRef(new Set<T>());
  return items.map((item, index) => {
    const { icon: Icon, group } = decoration(item.id);
    const children = item.children?.length ? item.children : undefined;
    return (
      <Fragment key={item.id}>
        {index > 0 && group !== decoration(items[index - 1]!.id).group ? (
          <MenuSeparator className="mx-2 my-1.5 bg-border/60" />
        ) : null}
        {children ? (
          <MenuSub>
            <MenuSubTrigger className={rowClass} disabled={item.disabled}>
              <Icon aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </MenuSubTrigger>
            <MenuSubPopup className={panelClass} positionerClassName="z-[10000]">
              <MenuEntries items={children} select={select} />
            </MenuSubPopup>
          </MenuSub>
        ) : (
          <MenuItem
            className={`${rowClass} ${item.destructive ? "text-destructive data-highlighted:text-destructive" : ""}`}
            disabled={item.disabled}
            closeOnClick={false}
            onPointerDown={(event) => {
              if (event.button === 0) pressed.current.add(item.id);
            }}
            onClick={(event) => {
              if (event.detail > 0 && !pressed.current.delete(item.id)) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              select(item.id);
            }}
          >
            <Icon aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </MenuItem>
        )}
      </Fragment>
    );
  });
}

let dismissCurrent: (() => void) | undefined;

/** The shell owns only one menu at a time. Base UI supplies keyboard traversal,
 * submenus, focus management and viewport collision handling. A resolved item
 * is still merely a user choice; callers retain exact chat/action admission. */
export function showContextMenu<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  dismissCurrent?.();
  if (items.length === 0) return Promise.resolve(null);
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = document.createElement("div");
  host.dataset.contextMenuHost = "true";
  document.body.appendChild(host);
  const root = createRoot(host);
  const triggerId = `context-menu-${randomUUID()}`;
  const focusedRect = previousFocus?.getBoundingClientRect();
  // Keep the opening pointer clear of the first action: a platform-synthesized
  // release must never select a destructive item without a fresh gesture.
  const x = Math.min(
    Math.max(4, (position?.x ?? focusedRect?.left ?? 0) + 12),
    window.innerWidth - 4,
  );
  const y = Math.min(
    Math.max(4, (position?.y ?? focusedRect?.bottom ?? 0) + 6),
    window.innerHeight - 4,
  );
  const anchor = { getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) };
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (id: T | null) => {
      if (resolved) return;
      resolved = true;
      if (dismissCurrent === dismiss) dismissCurrent = undefined;
      // Defer unmount until the library has finished its current event/update.
      queueMicrotask(() => {
        root.unmount();
        host.remove();
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        resolve(id);
      });
    };
    const dismiss = () => finish(null);
    dismissCurrent = dismiss;
    root.render(
      <Menu
        defaultOpen
        defaultTriggerId={triggerId}
        modal={false}
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
      >
        {/* The registered trigger supplies Base UI's floating-tree identity even
          though this imperative menu is anchored to the original gesture. */}
        <MenuTrigger id={triggerId} hidden tabIndex={-1} aria-hidden="true" />
        <MenuPopup
          aria-label="Actions"
          className={panelClass}
          positionerClassName="z-[10000]"
          anchor={anchor}
          align="start"
          side="bottom"
          sideOffset={0}
          finalFocus={false}
        >
          <MenuEntries items={items} select={finish} />
        </MenuPopup>
      </Menu>,
    );
  });
}
