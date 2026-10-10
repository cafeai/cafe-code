import { isElectron } from "../env";
import { shouldInsetContentSidebarTrigger } from "../components/Sidebar.logic";
import { useIsMobile } from "./useMediaQuery";

/**
 * Native traffic-light geometry is independent of Cafe's rem-based interface
 * scaling. Ordinary content headers use the desktop-sized macOS layout;
 * native Desk titlebars also keep that geometry when the window becomes narrow,
 * because the traffic lights do not shrink with the viewport. Browser clients
 * and mobile sheets keep their own spacing. Use sidebar navigation's predicate.
 */
export function useMacDesktopTitlebar({
  includeNarrowDesktop = false,
}: { includeNarrowDesktop?: boolean } = {}): boolean {
  const isMobile = useIsMobile();
  return shouldInsetContentSidebarTrigger({
    isElectronHost: isElectron,
    isMobile: isMobile && !includeNarrowDesktop,
    platform: typeof navigator === "undefined" ? "" : navigator.platform,
  });
}
