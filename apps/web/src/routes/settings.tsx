import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { RotateCcwIcon } from "lucide-react";
import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useSettingsBackNavigation } from "../hooks/useSettingsBackNavigation";

import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { Button } from "../components/ui/button";
import { SidebarInset, useSidebar } from "../components/ui/sidebar";
import {
  isSettingsSearchShortcut,
  SETTINGS_SEARCH_INPUT_ATTRIBUTE,
} from "../components/settings/SettingsSearch";
import { useSettingsSearchFocusStore } from "../components/settings/settingsSearchStore";
import { ContentSidebarTriggerWithUnreadDot } from "../components/sidebar/unseenCompletions";
import { isElectron } from "../env";
import { useMacDesktopTitlebar } from "../hooks/useMacDesktopTitlebar";
import { useWorkspaceEnvironmentId } from "../environments/workspace";

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const uiLocale = useUiLocale();

  const pathname = useLocation({ select: (location) => location.pathname });
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored, pathname);

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="size-3.5" />
      {uiText("Reset this page", undefined, undefined, uiLocale)}
    </Button>
  );
}

function SettingsContentLayout() {
  const uiLocale = useUiLocale();

  const isMacDesktopTitlebar = useMacDesktopTitlebar();
  const environmentId = useWorkspaceEnvironmentId();
  const location = useLocation();
  const navigateBackWithinApp = useSettingsBackNavigation();
  const { isMobile, open: sidebarOpen, setOpen: setSidebarOpen, setOpenMobile } = useSidebar();
  const [restoreSignal, setRestoreSignal] = useState(0);
  const showRestoreDefaults = SETTINGS_RESTORE_DEFAULTS_PATHS.has(location.pathname);
  const handleRestored = () => setRestoreSignal((value) => value + 1);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // The Keybindings page keeps ⌘F for its own filter (its handler owns it).
      if (isSettingsSearchShortcut(event) && location.pathname !== "/settings/keybindings") {
        // A second press while the search field is focused falls through to
        // the browser's own find, so page find stays reachable on the web.
        // Inside a dialog it must not move focus behind the modal either.
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.hasAttribute(SETTINGS_SEARCH_INPUT_ATTRIBUTE) ||
            target.closest('[role="dialog"], [role="alertdialog"]'))
        ) {
          return;
        }
        event.preventDefault();
        if (isMobile) setOpenMobile(true);
        else if (!sidebarOpen) setSidebarOpen(true);
        useSettingsSearchFocusStore.getState().requestFocus();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        navigateBackWithinApp();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    isMobile,
    location.pathname,
    navigateBackWithinApp,
    setOpenMobile,
    setSidebarOpen,
    sidebarOpen,
  ]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 sm:px-5">
            <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
              <ContentSidebarTriggerWithUnreadDot />
              <span className="text-sm font-medium text-foreground">
                {uiText("Settings", undefined, undefined, uiLocale)}
              </span>
              {showRestoreDefaults ? (
                <div className="ms-auto flex items-center gap-2">
                  <RestoreDefaultsButton onRestored={handleRestored} />
                </div>
              ) : null}
            </div>
          </header>
        )}

        {isElectron && (
          <div
            data-mac-titlebar={isMacDesktopTitlebar}
            className="drag-region flex h-(--app-titlebar-height) shrink-0 items-center border-b border-border px-5 wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
          >
            <ContentSidebarTriggerWithUnreadDot className="mr-2" />
            <span className="text-xs font-medium tracking-wide text-subtle-foreground">
              {uiText("Settings", undefined, undefined, uiLocale)}
            </span>
            {showRestoreDefaults ? (
              <div className="ms-auto flex items-center gap-2">
                <RestoreDefaultsButton onRestored={handleRestored} />
              </div>
            ) : null}
          </div>
        )}

        <div key={`${environmentId}:${restoreSignal}`} className="min-h-0 flex flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  return <SettingsContentLayout />;
}

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context, location }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }

    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/appearance", replace: true });
    }
  },
  component: SettingsRouteLayout,
});

const SETTINGS_RESTORE_DEFAULTS_PATHS = new Set([
  "/settings/appearance",
  "/settings/chat-threads",
  "/settings/source-control",
  "/settings/general",
  "/settings/providers",
]);
