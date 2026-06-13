import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";

import { selectSidebarThreadsAcrossEnvironments, useStore } from "../../store";
import { useUiStateStore } from "../../uiStateStore";
import { hasUnseenCompletion } from "../Sidebar.logic";
import { SidebarTrigger } from "../ui/sidebar";
import { cn } from "~/lib/utils";

/** True when any thread has a completed turn the user hasn't viewed yet. */
export function useHasUnseenThreadCompletions(): boolean {
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const lastVisitedById = useUiStateStore((state) => state.threadLastVisitedAtById);
  return useMemo(
    () =>
      threads.some((thread) =>
        hasUnseenCompletion({
          ...thread,
          lastVisitedAt:
            lastVisitedById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
        }),
      ),
    [lastVisitedById, threads],
  );
}

/** Color matches the "Completed" thread status pill in the sidebar. */
export function UnseenCompletionsDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="unseen-completions-dot"
      className={cn(
        "pointer-events-none absolute size-2 rounded-full bg-cyan-500 ring-2 ring-background dark:bg-cyan-300/90",
        className,
      )}
    />
  );
}

/**
 * SidebarTrigger with an unread dot when a thread finished running and hasn't
 * been viewed. This is how users with a hidden sidebar (mobile, or settings
 * pages) learn that work in another thread completed.
 */
export function SidebarTriggerWithUnreadDot({ className }: { className?: string }) {
  const hasUnseenCompletions = useHasUnseenThreadCompletions();
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <SidebarTrigger className="size-7" />
      {/* Kept inside the trigger bounds: header rows use overflow-hidden, so a
          dot overlapping the button edge gets clipped. */}
      {hasUnseenCompletions ? <UnseenCompletionsDot className="right-0 top-0" /> : null}
    </span>
  );
}
