import { isElectron } from "../env";
import { shouldInsetContentSidebarTrigger } from "../components/Sidebar.logic";
import { useIsMobile } from "./useMediaQuery";

/**
 * Native traffic-light geometry is independent of Cafe's rem-based interface
 * scaling. Admit the matching fixed titlebar layout only on a desktop-sized
 * macOS Electron window; ordinary browsers and mobile sheets keep their own
 * spacing. Use the same platform predicate as sidebar navigation.
 */
export function useMacDesktopTitlebar(): boolean {
  const isMobile = useIsMobile();
  return shouldInsetContentSidebarTrigger({
    isElectronHost: isElectron,
    isMobile,
    platform: typeof navigator === "undefined" ? "" : navigator.platform,
  });
}
