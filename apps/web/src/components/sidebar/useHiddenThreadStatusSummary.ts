import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useUiPresentation } from "~/i18n";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  readScheduledFollowUpAtFrom,
  useScheduledFollowupPresenceByEnvironment,
} from "../chat/scheduledFollowupPresence";
import {
  type HiddenThreadStatusSummary,
  resolveThreadStatusPill,
  summarizeHiddenThreadStatuses,
} from "../Sidebar.logic";

const PRESENTATION_SOURCES = { summarizeHiddenThreadStatuses };
const NO_VISITS: readonly (string | null)[] = [];

/**
 * The most urgent status among chats a sidebar surface is not showing (a
 * collapsed section, the Hidden projects group, or a list's "N more" row), so
 * hiding chats never hides one that is working or waiting for you.
 *
 * Presentation only: it reads already-projected shell summaries and visit
 * cursors and never fetches thread detail. While `enabled` is false it
 * subscribes to no visit cursors and returns null; the scheduled-follow-up
 * presence of `threads` stays retained so reopening the summary is warm.
 */
export function useHiddenThreadStatusSummary(
  threads: readonly SidebarThreadSummary[],
  enabled: boolean,
): HiddenThreadStatusSummary | null {
  const presentation = useUiPresentation(PRESENTATION_SOURCES);
  const lastVisitedAts = useUiStateStore(
    useShallow((state) =>
      enabled
        ? threads.map(
            (thread) =>
              state.threadLastVisitedAtById[
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
              ] ?? null,
          )
        : NO_VISITS,
    ),
  );
  const environmentIds = useMemo(
    () => [...new Set(threads.map((thread) => thread.environmentId))],
    [threads],
  );
  const scheduledPresence = useScheduledFollowupPresenceByEnvironment(environmentIds);
  return useMemo(
    () =>
      !enabled || threads.length === 0
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
    [enabled, lastVisitedAts, presentation, scheduledPresence, threads],
  );
}
