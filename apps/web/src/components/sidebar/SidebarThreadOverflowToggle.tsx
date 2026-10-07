import { ChevronDownIcon } from "lucide-react";
import { useMemo } from "react";
import type { HiddenThreadStatusSummary } from "../Sidebar.logic";
import { ThreadStatusDot } from "../ThreadStatusLabel";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";

/**
 * Expand/collapse control at the end of a sidebar chat list, shared by project
 * lists and the standalone Chats catalog.
 *
 * It deliberately reuses thread-row geometry (row height, horizontal padding,
 * inner flex gap and a trailing metadata column) so its label starts on the
 * same column as chat titles in both states and does not shift when toggled.
 * The single element also stays mounted across toggles, so list animation
 * moves it rather than swapping two different buttons.
 *
 * While collapsed it names the most urgent status among the hidden chats,
 * since sorting by latest user message can push a long-running or waiting
 * chat below the preview.
 */
export function SidebarThreadOverflowToggle({
  expanded,
  hiddenCount,
  hiddenSummary,
  onToggle,
}: {
  expanded: boolean;
  /** Chats beyond the preview count. Counted while expanded too. */
  hiddenCount: number;
  /** Ignored while expanded, when every chat is already visible. */
  hiddenSummary: HiddenThreadStatusSummary | null;
  onToggle: () => void;
}) {
  const buttonRender = useMemo(() => <button type="button" />, []);
  const summary = expanded ? null : hiddenSummary;
  const label = expanded ? "Show fewer" : `${hiddenCount} more`;
  const accessibleLabel = expanded
    ? "Show fewer chats"
    : `Show ${hiddenCount} more ${hiddenCount === 1 ? "chat" : "chats"}${
        summary ? `, ${summary.text}` : ""
      }`;

  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={buttonRender}
        size="sm"
        data-thread-selection-safe
        data-testid="sidebar-thread-overflow-toggle"
        aria-expanded={expanded}
        aria-label={accessibleLabel}
        className="group/overflow h-7 w-full translate-x-0 cursor-pointer justify-start px-2 text-left text-subtle-foreground select-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onToggle}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {/* Zero-width counterpart of a row's collapsed status-dot slot. With
              the shared gap it places the label exactly on the title column. */}
          <span aria-hidden="true" className="w-0 shrink-0" />
          <span className="shrink-0 text-xs" data-testid="sidebar-thread-overflow-label">
            {label}
          </span>
          {summary ? (
            <span
              data-testid="sidebar-thread-overflow-summary"
              data-status={summary.status.label}
              className={`ml-0.5 inline-flex min-w-0 items-center gap-1.5 text-2xs ${summary.status.colorClass}`}
            >
              {/* The same dot as chat rows, so a hidden chat reads identically. */}
              <ThreadStatusDot status={summary.status} />
              <span className="truncate">{summary.text}</span>
            </span>
          ) : null}
        </span>
        {/* The chevron sits in the timestamp column so flipping it never
            moves the label. */}
        <span aria-hidden="true" className="ml-auto flex shrink-0 justify-end">
          <ChevronDownIcon
            className={`size-3.5 text-disabled-foreground transition-transform duration-(--duration-base) ease-out motion-reduce:transition-none group-hover/overflow:text-muted-foreground ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
