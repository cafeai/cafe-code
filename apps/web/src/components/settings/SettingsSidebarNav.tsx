import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { useCallback, useId, useMemo, type ComponentType } from "react";
import {
  ActivityIcon,
  ArchiveIcon,
  ArrowLeftIcon,
  BarChart3Icon,
  BellIcon,
  BotIcon,
  GitBranchIcon,
  KeyboardIcon,
  MessageSquareIcon,
  MicIcon,
  MonitorSmartphoneIcon,
  PaletteIcon,
  PlugIcon,
  Settings2Icon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "../../lib/utils";
import { useSettingsBackNavigation } from "../../hooks/useSettingsBackNavigation";
import {
  SettingsSearchField,
  SettingsSearchResults,
  useSettingsSearchController,
} from "./SettingsSearch";

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
  | "/settings/ambiance"
  | "/settings/chat-threads"
  | "/settings/files"
  | "/settings/general"
  | "/settings/keybindings"
  | "/settings/notifications"
  | "/settings/providers"
  | "/settings/mcp"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/dictation"
  | "/settings/stats"
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
    get label() {
      return uiText("Preferences");
    },
    items: [
      {
        get label() {
          return uiText("General");
        },
        to: "/settings/general",
        icon: Settings2Icon,
        activePaths: ["/settings/files", "/settings/system"],
      },
      {
        get label() {
          return uiText("Appearance");
        },
        to: "/settings/appearance",
        icon: PaletteIcon,
        activePaths: ["/settings/ambiance"],
      },
      {
        get label() {
          return uiText("Chats");
        },
        to: "/settings/chat-threads",
        icon: MessageSquareIcon,
      },
      {
        get label() {
          return uiText("Notifications");
        },
        to: "/settings/notifications",
        icon: BellIcon,
      },
      {
        get label() {
          return uiText("Keybindings");
        },
        to: "/settings/keybindings",
        icon: KeyboardIcon,
      },
    ],
  },
  {
    get label() {
      return uiText("AI & Integrations");
    },
    items: [
      {
        get label() {
          return uiText("Providers");
        },
        to: "/settings/providers",
        icon: BotIcon,
      },
      {
        get label() {
          return uiText("Cafe tools");
        },
        to: "/settings/mcp",
        icon: PlugIcon,
      },
      {
        get label() {
          return uiText("Dictation");
        },
        to: "/settings/dictation",
        icon: MicIcon,
      },
      {
        get label() {
          return uiText("Source control");
        },
        to: "/settings/source-control",
        icon: GitBranchIcon,
      },
      {
        get label() {
          return uiText("Connections & remote access");
        },
        to: "/settings/connections",
        icon: MonitorSmartphoneIcon,
      },
    ],
  },
  {
    get label() {
      return uiText("Data");
    },
    items: [
      {
        get label() {
          return uiText("Usage");
        },
        to: "/settings/stats",
        icon: BarChart3Icon,
      },
      {
        get label() {
          return uiText("History");
        },
        to: "/settings/archived",
        icon: ArchiveIcon,
        activePaths: ["/settings/recently-deleted"],
      },
    ],
  },
  {
    get label() {
      return uiText("Advanced");
    },
    items: [
      {
        get label() {
          return uiText("Diagnostics");
        },
        to: "/settings/diagnostics",
        icon: ActivityIcon,
      },
    ],
  },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const navigate = useNavigate();
  const navigateBackWithinApp = useSettingsBackNavigation();
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
    navigateBackWithinApp();
  }, [isMobile, navigateBackWithinApp, setOpenMobile]);
  const navItems = useMemo(
    () => uiPresentation.SETTINGS_NAV_GROUPS.flatMap((group) => group.items),
    [uiPresentation],
  );
  const search = useSettingsSearchController({ navItems });
  const listboxId = useId();

  return (
    <>
      <SettingsSearchField search={search} listboxId={listboxId} />
      <SidebarContent className="overflow-x-hidden">
        {search.active ? (
          <SettingsSearchResults search={search} listboxId={listboxId} navItems={navItems} />
        ) : (
          <SettingsNavGroups
            pathname={pathname}
            groups={uiPresentation.SETTINGS_NAV_GROUPS}
            // Returning from results fades the menu back in; the first render does not animate.
            className={search.hasSearched ? "animate-enter-fade" : undefined}
            onSectionClick={handleSectionClick}
          />
        )}
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-2 text-(length:--text-ui) text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleBackClick}
            >
              <ArrowLeftIcon className="size-4" />
              <span>{uiText("Back", undefined, undefined, uiLocale)}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

function SettingsNavGroups({
  pathname,
  groups,
  className,
  onSectionClick,
}: {
  readonly pathname: string;
  readonly groups: ReadonlyArray<SettingsNavGroup>;
  readonly className: string | undefined;
  readonly onSectionClick: (to: SettingsSectionPath) => void;
}) {
  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-2", className)}>
      {groups.map((group) => (
        <SidebarGroup key={group.label} className="px-2 py-2 first:pt-3">
          {/* Same section-label treatment as the sidebar's Chats/Projects
                headings; size and colour are explicit so they win over the
                primitive's text-xs/text-sidebar-foreground. */}
          <SidebarGroupLabel className="label-overline h-6 px-2 text-2xs text-subtle-foreground">
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
                    // text-(length:--text-ui): `cn` would treat a bare
                    // `text-ui` as a colour and drop it beside the colour.
                    className={
                      isActive
                        ? "gap-2.5 px-2.5 py-2 text-left text-(length:--text-ui) font-medium text-foreground"
                        : "gap-2.5 px-2.5 py-2 text-left text-(length:--text-ui) text-muted-foreground hover:text-foreground"
                    }
                    onClick={() => onSectionClick(item.to)}
                  >
                    <Icon
                      className={
                        isActive
                          ? "size-4 shrink-0 text-foreground"
                          : "size-4 shrink-0 text-subtle-foreground"
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
    </div>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { SETTINGS_NAV_GROUPS };
