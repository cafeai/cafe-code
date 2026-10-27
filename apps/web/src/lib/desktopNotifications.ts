import type {
  DesktopNotificationInput,
  DesktopNotificationResult,
  ScopedThreadRef,
} from "@cafecode/contracts";
import { useSyncExternalStore } from "react";

let latestResult: DesktopNotificationResult | null = null;
let latestRequest = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function desktopThreadNotificationTag(ref: ScopedThreadRef): string {
  // Length-prefix the environment so delimiter-bearing IDs from independent
  // saved servers cannot collide and route a click to another chat.
  return `cafe-code-thread:${ref.environmentId.length}:${ref.environmentId}:${ref.threadId}`;
}

/** Finite feedback only: native/IPC errors and notification text stay opaque. */
export async function sendDesktopNotification(
  input: DesktopNotificationInput,
): Promise<DesktopNotificationResult> {
  const request = ++latestRequest;
  let result: DesktopNotificationResult;
  try {
    const show = window.desktopBridge?.showNotification;
    const response = show ? await show(input) : "unsupported";
    result =
      response === "sent" || response === "unsupported" || response === "cancelled"
        ? response
        : "failed";
  } catch {
    result = "failed";
  }
  if (request === latestRequest) {
    latestResult = result;
    for (const listener of listeners) listener();
  }
  return result;
}

export function useDesktopNotificationResult() {
  return useSyncExternalStore(subscribe, () => latestResult);
}
