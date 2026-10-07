import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useEffect } from "react";

import { isElectron } from "../../env";
import { useSettings } from "../../hooks/useSettings";
import { cn, isWindowsPlatform } from "../../lib/utils";
import { TaskAtriumBoard } from "./TaskAtrium";
import { useTaskAtriumStore } from "./taskAtriumStore";
import { useWorkspaceEnvironmentId } from "../../environments/workspace";

/**
 * The Task Atrium panel.
 *
 * It only ever opens because someone pressed the Atrium action in the sidebar —
 * there is no idle takeover and it never claims a pane on its own. The modal
 * dialog primitive moves focus into the full-screen surface, contains keyboard
 * focus while it is open, but deliberately never restores focus to its opener.
 * The Atrium action is a transient launcher rather than a selected destination,
 * so returning focus there makes it look selected after the overlay is gone.
 * This matters on mobile because opening Atrium also dismisses the sidebar
 * sheet that owned the trigger. Escape, the close button, and opening a thread
 * from a card all close it.
 *
 * It sits above every thread-local surface, including the absolute subagent
 * detail view and any composer popover left in its close transition. Atrium
 * owns its own scene canvas, so it does not depend on the global ambiance layer
 * being stacked above this modal.
 */
export function TaskAtriumOverlay() {
  const environmentId = useWorkspaceEnvironmentId();
  const enabled = useSettings((settings) => settings.ambianceAtriumEnabled);
  const open = useTaskAtriumStore((state) => state.open);
  const setOpen = useTaskAtriumStore((state) => state.setOpen);
  const reserveNativeTitlebar = isElectron && isWindowsPlatform(navigator.platform);

  // Close if the feature is switched off while the panel happens to be open.
  useEffect(() => {
    if (!enabled && open) setOpen(false);
  }, [enabled, open, setOpen]);

  if (!enabled) return null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          // Native caption buttons sit above renderer content, regardless of
          // z-index. Reserve the same band for the close button and board so
          // provider filters cannot collide with either close control. `wco`
          // tracks native visibility, including entering/leaving fullscreen;
          // the fallback matches DesktopWindow's 40px caption configuration.
          className={cn(
            "fixed inset-0 z-[60] flex flex-col bg-background outline-none [-webkit-app-region:no-drag]",
            // Fade + slight scale in, a faster fade out (docs/style-guide.md
            // §8). Reduced motion drops the scale globally and keeps the fade.
            // The popup stays full-window and modal throughout.
            "transition-[opacity,scale] duration-[180ms] ease-out data-ending-style:scale-[0.99] data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-in data-starting-style:scale-[0.985] data-starting-style:opacity-0",
            reserveNativeTitlebar &&
              "wco:[--cafe-atrium-titlebar-inset:calc(env(titlebar-area-y,0px)+env(titlebar-area-height,40px))] pt-[var(--cafe-atrium-titlebar-inset,0px)]",
          )}
          aria-label="Task Atrium"
          aria-modal="true"
          data-cafe-task-atrium-overlay="true"
          // The dialog overlaps Cafe's frameless draggable titlebar. Electron
          // otherwise treats the visible filter and close controls as window
          // chrome instead of sending their pointer events to the renderer.
          data-cafe-window-no-drag="true"
          // Escape remains a supported dismissal, but no close path returns
          // focus to the transient Atrium launcher and leaves a stale ring.
          finalFocus={false}
        >
          <DialogPrimitive.Close
            aria-label="Close Task Atrium"
            className="focus-ring absolute right-4 top-[calc(var(--cafe-atrium-titlebar-inset,0px)+1rem)] z-30 flex size-8 items-center justify-center rounded-full border border-border bg-card/60 text-muted-foreground backdrop-blur-md transition-colors duration-(--duration-fast) hover:bg-card hover:text-foreground"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
          <TaskAtriumBoard key={environmentId} />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
