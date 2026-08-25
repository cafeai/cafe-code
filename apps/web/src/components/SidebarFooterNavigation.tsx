import { SettingsIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../lib/utils";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

interface SidebarFooterNavigationProps {
  readonly atriumEnabled: boolean;
  readonly atriumOpen: boolean;
  readonly settingsActive: boolean;
  readonly onOpenAtrium: () => void;
  readonly onOpenSettings: () => void;
}

/**
 * Keeps the two app-level destinations together at the bottom of the sidebar.
 * Atrium deliberately precedes Settings so the work overview is available
 * without consuming the already crowded per-thread header.
 */
export const SidebarFooterNavigation = memo(function SidebarFooterNavigation({
  atriumEnabled,
  atriumOpen,
  settingsActive,
  onOpenAtrium,
  onOpenSettings,
}: SidebarFooterNavigationProps) {
  const menuButtonClassName =
    "min-w-0 flex-1 gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground";

  return (
    <SidebarMenu>
      {atriumEnabled && (
        <SidebarMenuItem className="flex w-full items-center gap-1">
          <SidebarMenuButton
            size="sm"
            className={cn(menuButtonClassName, atriumOpen && "bg-accent text-foreground")}
            aria-expanded={atriumOpen}
            aria-haspopup="dialog"
            data-cafe-task-atrium-sidebar-button="true"
            onClick={onOpenAtrium}
          >
            <span
              aria-hidden="true"
              className="grid size-3.5 shrink-0 place-items-center text-[13px] leading-none"
              data-cafe-task-atrium-unicorn-icon="true"
            >
              🦄
            </span>
            <span className="text-xs">Atrium</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}

      <SidebarMenuItem className="flex w-full items-center gap-1">
        <SidebarMenuButton
          size="sm"
          className={cn(menuButtonClassName, settingsActive && "bg-accent text-foreground")}
          onClick={onOpenSettings}
        >
          <SettingsIcon className="size-3.5" />
          <span className="text-xs">Settings</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
});
