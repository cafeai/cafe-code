import { useEffect } from "react";
import { X } from "lucide-react";

import { useSettings } from "../../hooks/useSettings";
import { TaskAtriumBoard } from "./TaskAtrium";
import { useTaskAtriumStore } from "./taskAtriumStore";

/**
 * The Task Atrium panel.
 *
 * It only ever opens because someone pressed the button in the chat header —
 * there is no idle takeover and it never claims a pane on its own. Escape
 * closes it, as does the close button and opening any thread from a card.
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

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

  if (!enabled || !open) return null;

  return (
    <div
      className="fixed inset-0 z-30 flex flex-col bg-background"
      role="region"
      aria-label="Task Atrium"
      data-cafe-task-atrium-overlay="true"
    >
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Close Task Atrium"
        className="absolute right-4 top-4 z-30 flex size-8 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white/80 backdrop-blur-md transition-colors hover:bg-black/50 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60 dark:border-white/15"
      >
        <X className="size-4" />
      </button>
      <TaskAtriumBoard />
    </div>
  );
}
