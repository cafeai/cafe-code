import { uiText, type UiLocale } from "@cafecode/shared/i18n";
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
export function computerActivityText(activity: NativeControlActivity, locale?: UiLocale): string {
  if (activity.phase === "controlling" && activity.usingSystemPointer)
    return uiText("Using the real mouse", undefined, undefined, locale);
  return {
    inactive: uiText("Computer use", undefined, undefined, locale),
    idle: uiText("Computer use active", undefined, undefined, locale),
    "reading-controls": uiText("Reading controls", undefined, undefined, locale),
    capturing: uiText("Taking a screenshot", undefined, undefined, locale),
    controlling: uiText("Controlling", undefined, undefined, locale),
    stopping: uiText("Stopping…", undefined, undefined, locale),
  }[activity.phase];
}
