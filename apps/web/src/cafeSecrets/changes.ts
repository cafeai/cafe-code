import type { ScopedThreadRef } from "@cafecode/contracts";

// Content-free invalidations only. Values belong to the mounted private reader.
const listeners = new Set<(thread: ScopedThreadRef) => void>();

export function notifyCafeSecretsChanged(thread: ScopedThreadRef) {
  for (const listener of listeners) listener(thread);
}

export function subscribeCafeSecretsChanges(listener: (thread: ScopedThreadRef) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
