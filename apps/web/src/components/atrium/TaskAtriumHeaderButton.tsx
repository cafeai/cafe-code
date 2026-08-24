import { Sparkles } from "lucide-react";

import { useSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { useTaskAtriumStore } from "./taskAtriumStore";

/**
 * Opens the Task Atrium.
 *
 * Lives in the chat header because that is where you are when the question
 * "what is everything else doing?" comes up — you are inside one thread and
 * several others are running. Hidden entirely unless the feature is on, so it
 * costs nothing in the default header.
 */
export function TaskAtriumHeaderButton() {
  const enabled = useSettings((settings) => settings.ambianceAtriumEnabled);
  const toggle = useTaskAtriumStore((state) => state.toggle);
  const open = useTaskAtriumStore((state) => state.open);

  if (!enabled) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Open Task Atrium"
      aria-pressed={open}
      title="Task Atrium"
      onClick={toggle}
      className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
    >
      <Sparkles className="size-4" />
    </Button>
  );
}
