import { useSyncExternalStore } from "react";
import type { NativeControlActivity } from "@cafecode/contracts";

let current: NativeControlActivity | null = null;
const listeners = new Set<() => void>();
let disconnect: (() => void) | undefined;
let retiredGenerations = new Set<string>();
export function newerComputerActivity(
  previous: NativeControlActivity | null,
  next: NativeControlActivity,
): boolean {
  return !previous || previous.generation !== next.generation || next.sequence > previous.sequence;
}
function receive(next: NativeControlActivity) {
  if (retiredGenerations.has(next.generation) || !newerComputerActivity(current, next)) return;
  if (current && current.generation !== next.generation) {
    retiredGenerations.add(current.generation);
    // Main-process generations cannot legitimately change more than once
    // without reloading this renderer. Keep the cache bounded nevertheless.
    if (retiredGenerations.size > 8)
      retiredGenerations = new Set([...retiredGenerations].slice(-8));
  }
  current = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const bridge = window.desktopBridge;
    disconnect = bridge?.onNativeControlActivity?.(receive);
    // Subscribe before hydration: an older query cannot overwrite a transition.
    void bridge
      ?.getNativeControlActivity?.()
      .then(receive)
      .catch(() => {});
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      disconnect?.();
      disconnect = undefined;
    }
  };
}
export function useNativeControlActivity() {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
export function computerActivityText(activity: NativeControlActivity): string {
  if (activity.phase === "controlling" && activity.usingSystemPointer)
    return "Using the real mouse";
  return {
    inactive: "Computer use",
    idle: "Computer use active",
    "reading-controls": "Reading controls",
    capturing: "Taking a screenshot",
    controlling: "Controlling",
    stopping: "Stopping…",
  }[activity.phase];
}
