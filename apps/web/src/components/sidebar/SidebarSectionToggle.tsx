import { ChevronRightIcon } from "lucide-react";

import type { HiddenThreadStatusSummary } from "../Sidebar.logic";
import { ThreadStatusDot } from "../ThreadStatusIndicators";

/**
 * Collapse toggle for a sidebar section heading (Chats, Projects).
 *
 * The chevron trails the label so every section label starts at the same left
 * edge whether or not the section can collapse. -mx-1/px-1 widens the hit
 * area without moving the label. While collapsed, `summary` names the most
 * urgent state among the chats the section is not showing.
 *
 * Presentation only: collapsing never changes, stops or deletes anything.
 */
export function SidebarSectionToggle({
  label,
  expanded,
  onExpandedChange,
  summary,
  testId,
  statusTestId,
}: {
  label: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  summary: HiddenThreadStatusSummary | null;
  testId: string;
  statusTestId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-expanded={expanded}
      className="-mx-1 inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1 text-subtle-foreground transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      onClick={() => onExpandedChange(!expanded)}
    >
      <span className="label-overline">{label}</span>
      <ChevronRightIcon
        aria-hidden="true"
        className={`size-3 shrink-0 transition-transform duration-(--duration-fast) motion-reduce:transition-none ${
          expanded ? "rotate-90" : ""
        }`}
      />
      {!expanded && summary ? (
        <span
          data-testid={statusTestId}
          data-status={summary.status.label}
          title={summary.text}
          className={`inline-flex shrink-0 items-center ${summary.status.colorClass}`}
        >
          <ThreadStatusDot status={summary.status} />
          <span className="sr-only">{summary.text}</span>
        </span>
      ) : null}
    </button>
  );
}
