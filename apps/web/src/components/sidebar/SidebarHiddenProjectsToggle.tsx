import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";
import { uiText } from "@cafecode/shared/i18n";
import { ChevronRightIcon, EyeOffIcon } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useUiLocale, useUiPresentation } from "~/i18n";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  readScheduledFollowUpAtFrom,
  useScheduledFollowupPresenceByEnvironment,
} from "../chat/scheduledFollowupPresence";
import { resolveThreadStatusPill, summarizeHiddenThreadStatuses } from "../Sidebar.logic";
import { ThreadStatusDot } from "../ThreadStatusIndicators";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

const PRESENTATION_SOURCES = { summarizeHiddenThreadStatuses };

/**
 * Header row of the sidebar's Hidden projects group.
 *
 * While collapsed it names the most urgent state among the hidden projects'
 * chats (the same summary as a chat list's "N more" row), so hiding a project
 * never hides a chat that is working or waiting for you.
 */
export function SidebarHiddenProjectsToggle({
  hiddenCount,
  open,
  threads,
  onToggle,
}: {
  hiddenCount: number;
  open: boolean;
  /** Unarchived chats of the hidden projects, used only for the summary. */
  threads: readonly SidebarThreadSummary[];
  onToggle: () => void;
}) {
  const uiLocale = useUiLocale();
  const presentation = useUiPresentation(PRESENTATION_SOURCES);
  const lastVisitedAts = useUiStateStore(
    useShallow((state) =>
      open
        ? []
        : threads.map(
            (thread) =>
              state.threadLastVisitedAtById[
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
              ] ?? null,
          ),
    ),
  );
  const environmentIds = useMemo(
    () => [...new Set(threads.map((thread) => thread.environmentId))],
    [threads],
  );
  const scheduledPresence = useScheduledFollowupPresenceByEnvironment(environmentIds);
  const summary = useMemo(
    () =>
      open
        ? null
        : presentation.summarizeHiddenThreadStatuses(
            threads.map((thread, index) => {
              const lastVisitedAt = lastVisitedAts[index];
              return resolveThreadStatusPill({
                thread: {
                  ...thread,
                  ...(lastVisitedAt !== null && lastVisitedAt !== undefined
                    ? { lastVisitedAt }
                    : {}),
                  scheduledFollowUpAt: readScheduledFollowUpAtFrom(
                    scheduledPresence,
                    thread.environmentId,
                    thread.id,
                  ),
                },
              });
            }),
          ),
    [lastVisitedAts, open, presentation, scheduledPresence, threads],
  );

  return (
    <SidebarMenuItem className="rounded-md">
      <SidebarMenuButton
        size="sm"
        data-testid="sidebar-hidden-projects-toggle"
        aria-expanded={open}
        aria-label={uiText(
          "{count, plural, one {# hidden project} other {# hidden projects}}{hasSummary, select, yes {, {summary}} other {}}",
          {
            count: hiddenCount,
            hasSummary: summary ? "yes" : "no",
            summary: summary?.text ?? "",
          },
          undefined,
          uiLocale,
        )}
        className="group/hidden-projects cursor-pointer gap-2 px-2 py-1.5 text-left text-subtle-foreground hover:bg-accent hover:text-foreground"
        onClick={onToggle}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={`-ml-0.5 size-3.5 shrink-0 transition-transform duration-(--duration-fast) motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
        />
        <EyeOffIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="shrink-0 text-ui">
          {uiText("Hidden", undefined, "sidebar group of hidden projects", uiLocale)}
        </span>
        <span className="shrink-0 text-2xs tabular-nums">{hiddenCount}</span>
        {summary ? (
          <span
            data-testid="sidebar-hidden-projects-summary"
            data-status={summary.status.label}
            className={`ml-auto inline-flex min-w-0 items-center gap-1.5 text-2xs ${summary.status.colorClass}`}
          >
            <ThreadStatusDot status={summary.status} />
            <span className="truncate">{summary.text}</span>
          </span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
