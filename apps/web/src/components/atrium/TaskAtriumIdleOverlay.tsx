import { useEffect, useRef, useState } from "react";

import { useSettings } from "../../hooks/useSettings";
import { selectAnyThreadRunning, useStore } from "../../store";
import { TaskAtriumBoard } from "./TaskAtrium";

/**
 * Idle takeover for the Task Atrium.
 *
 * When work is in flight and the window has gone untouched for the configured
 * delay, the Atrium fades up over the whole window like a Now Playing screen —
 * the "walk away while the agents work" mode. Any key, pointer or scroll
 * dismisses it immediately.
 *
 * Deliberately conservative about when it may engage:
 * - only while `ambianceAtrium` is "empty-state-and-idle",
 * - only while something is actually running (an idle app just stays as it is),
 * - never under `prefers-reduced-motion`,
 * - never while the document is hidden, so a background window never animates,
 * - never while a dialog is open or the composer has focus, so it cannot cover
 *   something the user is part-way through.
 */

/** Bounded poll; nothing here needs to react faster than this. */
const IDLE_CHECK_INTERVAL_MS = 5_000;

function isBlockedByFocus(): boolean {
  if (typeof document === "undefined") return true;
  // An open dialog or popover owns the screen; never cover it.
  if (document.querySelector("[role='dialog'],[data-state='open'][role='alertdialog']")) {
    return true;
  }
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  const tag = active.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") return true;
  return active.getAttribute("contenteditable") === "true";
}

export function TaskAtriumIdleOverlay() {
  const atriumMode = useSettings((settings) => settings.ambianceAtrium);
  const idleMinutes = useSettings((settings) => settings.ambianceAtriumIdleMinutes);
  const [visible, setVisible] = useState(false);
  const lastActivityRef = useRef(Date.now());

  const enabled = atriumMode === "empty-state-and-idle";

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(false);
      return;
    }

    const markActive = () => {
      lastActivityRef.current = Date.now();
      setVisible((wasVisible) => (wasVisible ? false : wasVisible));
    };

    const events: Array<keyof WindowEventMap> = [
      "pointerdown",
      "pointermove",
      "keydown",
      "wheel",
      "focus",
    ];
    for (const event of events) {
      window.addEventListener(event, markActive, { passive: true });
    }

    const check = () => {
      if (document.visibilityState !== "visible") {
        setVisible(false);
        return;
      }
      if (isBlockedByFocus()) {
        lastActivityRef.current = Date.now();
        setVisible(false);
        return;
      }
      const idleFor = Date.now() - lastActivityRef.current;
      const running = selectAnyThreadRunning(useStore.getState());
      setVisible(running && idleFor >= idleMinutes * 60_000);
    };

    const interval = window.setInterval(check, IDLE_CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      for (const event of events) window.removeEventListener(event, markActive);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", check);
      setVisible(false);
    };
  }, [enabled, idleMinutes]);

  if (!enabled || !visible) return null;

  return (
    <div
      // Below dialogs/popovers (z-50) and below the ambiance canvas (z-40) so
      // the weather still falls in front of the cards, exactly as it does on
      // the empty state.
      className="fixed inset-0 z-30 flex flex-col bg-background/92 backdrop-blur-sm"
      role="presentation"
      aria-hidden="true"
    >
      <TaskAtriumBoard />
    </div>
  );
}
