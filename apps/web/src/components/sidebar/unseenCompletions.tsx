import { useMemo, useState } from "react";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";

import { useWorkspaceSidebarThreads } from "../../environments/workspaceData";
import { useUiStateStore } from "../../uiStateStore";
import { hasUnseenCompletion } from "../Sidebar.logic";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { cn } from "~/lib/utils";

/** True when any thread has a completed turn the user hasn't viewed yet. */
export function useHasUnseenThreadCompletions(): boolean {
  const threads = useWorkspaceSidebarThreads();
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

/** Uses the "Completed" status colour shared by every chat-state surface. */
export function UnseenCompletionsDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="unseen-completions-dot"
      className={cn(
        "pointer-events-none absolute size-2 rounded-full bg-status-done ring-2 ring-background",
        className,
      )}
    />
  );
}

/**
 * SidebarTrigger with an unread dot when a chat finished running and hasn't
 * been viewed. This is how users with a hidden sidebar (mobile, or settings
 * pages) learn that work in another chat completed.
 */
export function SidebarTriggerWithUnreadDot({ className }: { className?: string }) {
  const hasUnseenCompletions = useHasUnseenThreadCompletions();
  const { isMobile, open, openMobile } = useSidebar();
  const sidebarOpen = isMobile ? openMobile : open;
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <SidebarTrigger className="size-7" />
      {/* Kept inside the trigger bounds: header rows use overflow-hidden, so a
          dot overlapping the button edge gets clipped. */}
      {hasUnseenCompletions && !sidebarOpen ? (
        <UnseenCompletionsDot className="right-0 top-0" />
      ) : null}
    </span>
  );
}

/**
 * Content-header counterpart to the toggle housed beside the Cafe wordmark.
 * Desktop only needs this copy while the off-canvas navigation is hidden;
 * mobile always needs it because the sidebar lives in a modal sheet.
 */
export function ContentSidebarTriggerWithUnreadDot({ className }: { className?: string }) {
  const { isMobile, open } = useSidebar();
  // Only a real close animates the trigger in. A chat view that mounts while
  // the sidebar is already hidden (switching tabs) shows it immediately.
  const [previousOpen, setPreviousOpen] = useState(open);
  const [animateEntrance, setAnimateEntrance] = useState(false);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    setAnimateEntrance(!open);
  }
  if (!isMobile && open) {
    return null;
  }
  return (
    <SidebarTriggerWithUnreadDot
      className={cn(
        // The actual titlebar owns native clearance. This control is shared
        // by flush Desk bars and padded chat/settings headers, so a child
        // margin cannot safely assume any particular parent padding.
        // Desktop: the trigger appears as soon as the sidebar starts its 200ms
        // slide out, so fade it in as the slide finishes instead of popping it
        // into the header mid-slide. Mobile (a modal sheet) keeps it static.
        !isMobile && animateEntrance && "animate-enter-fade [animation-delay:150ms]",
        className,
      )}
    />
  );
}
