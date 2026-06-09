import { useCallback, type ComponentType } from "react";
import {
  ActivityIcon,
  ArchiveIcon,
  ArrowLeftIcon,
  BotIcon,
  FileTextIcon,
  GitBranchIcon,
  KeyboardIcon,
  Link2Icon,
  MessageSquareIcon,
  PaletteIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";

export type SettingsSectionPath =
  | "/settings/appearance"
  | "/settings/chat-threads"
  | "/settings/files-diffs"
  | "/settings/general"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/archived"
  | "/settings/recently-deleted"
  | "/settings/system"
  | "/settings/diagnostics";

type SettingsNavItem = {
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
  activePaths?: ReadonlyArray<string>;
};

type SettingsNavGroup = {
  label: string;
  items: ReadonlyArray<SettingsNavItem>;
};

export const SETTINGS_NAV_GROUPS: ReadonlyArray<SettingsNavGroup> = [
  {
    label: "Preferences",
    items: [
      {
        label: "Appearance",
        to: "/settings/appearance",
        icon: PaletteIcon,
        activePaths: ["/settings/general"],
      },
      { label: "Chat & Threads", to: "/settings/chat-threads", icon: MessageSquareIcon },
      { label: "Files & Diffs", to: "/settings/files-diffs", icon: FileTextIcon },
      { label: "Keybindings", to: "/settings/keybindings", icon: KeyboardIcon },
    ],
  },
  {
    label: "AI & Integrations",
    items: [
      { label: "Providers", to: "/settings/providers", icon: BotIcon },
      { label: "Source Control", to: "/settings/source-control", icon: GitBranchIcon },
      { label: "WebUI", to: "/settings/connections", icon: Link2Icon },
    ],
  },
  {
    label: "Data",
    items: [
      { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
      { label: "Recently Deleted", to: "/settings/recently-deleted", icon: Trash2Icon },
    ],
  },
  {
    label: "Advanced",
    items: [
      { label: "System", to: "/settings/system", icon: Settings2Icon },
      { label: "Diagnostics", to: "/settings/diagnostics", icon: ActivityIcon },
    ],
  },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSectionClick = useCallback(
    (to: SettingsSectionPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        {SETTINGS_NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="px-2 py-2 first:pt-3">
            <SidebarGroupLabel className="h-6 px-2 text-[11px] uppercase tracking-wide text-muted-foreground/60">
              {group.label}
            </SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive =
                  pathname === item.to || (item.activePaths?.includes(pathname) ?? false);
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      size="sm"
                      isActive={isActive}
                      className={
                        isActive
                          ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
                          : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
                      }
                      onClick={() => handleSectionClick(item.to)}
                    >
                      <Icon
                        className={
                          isActive
                            ? "size-4 shrink-0 text-foreground"
                            : "size-4 shrink-0 text-muted-foreground/60"
                        }
                      />
                      <span className="truncate">{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleBackClick}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
