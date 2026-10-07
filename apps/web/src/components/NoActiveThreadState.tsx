import { SquarePenIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { ContentSidebarTriggerWithUnreadDot } from "./sidebar/unseenCompletions";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";

/**
 * Shown when no chat is open. One title and one obvious next step: the same
 * New chat action as the sidebar and shortcut. Callers (the Desk) may add
 * secondary actions such as reopening a closed tab.
 */
export function NoActiveThreadState({
  secondaryActions,
}: {
  readonly secondaryActions?: ReactNode;
} = {}) {
  const { handleNewStandaloneChat } = useNewThreadHandler();
  const startNewChat = () => {
    void handleNewStandaloneChat().catch((error: unknown) => {
      console.warn("Failed to start a new chat from the empty state", { error });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create chat",
          description: "Reconnect to Cafe Code and try again.",
        }),
      );
    });
  };
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The header only carries the sidebar trigger and window chrome; the
            empty state below names the view once. */}
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-(--app-titlebar-height) items-center wco:h-[env(titlebar-area-height)]"
              : "flex items-center py-2 sm:py-3",
          )}
        >
          <div className="flex min-w-0 items-center gap-2 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
            <ContentSidebarTriggerWithUnreadDot />
          </div>
        </header>

        <Empty className="flex-1 animate-enter-fade">
          <EmptyHeader>
            <EmptyTitle className="text-lg text-foreground">No chat selected</EmptyTitle>
          </EmptyHeader>
          <EmptyContent className="flex-row flex-wrap justify-center gap-2">
            <Button onClick={startNewChat}>
              <SquarePenIcon />
              New chat
            </Button>
            {secondaryActions}
          </EmptyContent>
        </Empty>
      </div>
    </SidebarInset>
  );
}
