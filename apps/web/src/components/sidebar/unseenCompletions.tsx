import { useMemo, useState } from "react";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";

import { useWorkspaceSidebarThreads } from "../../environments/workspaceData";
import { useUiStateStore } from "../../uiStateStore";
import { hasUnseenCompletion } from "../Sidebar.logic";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { cn } from "~/lib/utils";
import { ContentSidebarNewChatButton } from "./ContentSidebarNewChatButton";

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
  const { isMobile, open, openMobile } = useSidebar();
  const sidebarOpen = isMobile ? openMobile : open;
  // Arm motion only after a real toggle. Switching chats with navigation
  // already closed must not replay an entrance on every header mount.
  const [previousOpen, setPreviousOpen] = useState(sidebarOpen);
  const [animate, setAnimate] = useState(false);
  if (previousOpen !== sidebarOpen) {
    setPreviousOpen(sidebarOpen);
    setAnimate(true);
  }
  const hidden = !isMobile && sidebarOpen;
  return (
    <span
      data-sidebar="content-controls"
      data-animate={!isMobile && animate}
      className={cn("content-sidebar-controls", className)}
      hidden={hidden}
      aria-hidden={hidden || undefined}
      inert={hidden}
    >
      {/* Native CSS retains the exit paint while hidden/inert revoke focus and
          activation immediately. No timer or late completion can resurrect it.
          The parent header, not these shared controls, owns native clearance. */}
      <SidebarTriggerWithUnreadDot />
      <span
        hidden={isMobile && sidebarOpen}
        aria-hidden={sidebarOpen || undefined}
        inert={sidebarOpen}
      >
        <ContentSidebarNewChatButton />
      </span>
    </span>
  );
}
