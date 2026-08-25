import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useEffect } from "react";

import { useSettings } from "../../hooks/useSettings";
import { TaskAtriumBoard } from "./TaskAtrium";
import { useTaskAtriumStore } from "./taskAtriumStore";

/**
 * The Task Atrium panel.
 *
 * It only ever opens because someone pressed the Atrium action in the sidebar —
 * there is no idle takeover and it never claims a pane on its own. The modal
 * dialog primitive moves focus into the full-screen surface, contains keyboard
 * focus while it is open, and restores focus for keyboard dismissals when its
 * opener still exists. Pointer dismissals intentionally do not restore focus:
 * doing so makes the sidebar action look selected after the overlay is gone.
 * This matters on mobile because opening Atrium also dismisses the sidebar
 * sheet that owned the trigger. Escape, the close button, and opening a thread
 * from a card all close it.
 *
 * It sits at z-30: above the app shell, below dialogs and popovers (z-50), and
 * below the ambiance canvas (z-40) so the weather keeps falling in front of the
 * cards exactly as it does over the rest of the app.
 */
export function TaskAtriumOverlay() {
  const enabled = useSettings((settings) => settings.ambianceAtriumEnabled);
  const open = useTaskAtriumStore((state) => state.open);
  const setOpen = useTaskAtriumStore((state) => state.setOpen);

  // Close if the feature is switched off while the panel happens to be open.
  useEffect(() => {
    if (!enabled && open) setOpen(false);
  }, [enabled, open, setOpen]);

  if (!enabled) return null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          className="fixed inset-0 z-30 flex flex-col bg-background outline-none [-webkit-app-region:no-drag]"
          aria-label="Task Atrium"
          aria-modal="true"
          data-cafe-task-atrium-overlay="true"
          // The dialog overlaps Cafe's frameless draggable titlebar. Electron
          // otherwise treats the visible filter and close controls as window
          // chrome instead of sending their pointer events to the renderer.
          data-cafe-window-no-drag="true"
          // Mouse/touch users already moved focus by clicking the dismissal
          // target, so returning it to Atrium produces a stale selected ring.
          // Keyboard users still need a predictable return destination.
          finalFocus={(closeType) => closeType === "keyboard"}
        >
          <DialogPrimitive.Close
            aria-label="Close Task Atrium"
            className="absolute right-4 top-4 z-30 flex size-8 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white/80 backdrop-blur-md transition-colors hover:bg-black/50 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60 dark:border-white/15"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
          <TaskAtriumBoard />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
