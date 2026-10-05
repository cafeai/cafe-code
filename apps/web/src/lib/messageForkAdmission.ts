import type { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { create } from "zustand";

// Renderer-local in-flight admission, not durable provider authority. A Desk
// pane may close/remount while its request is still awaiting acknowledgement.
// Retain the pending claim until that exact request settles, never until unmount.
export const useMessageForkAdmission = create<ReadonlyMap<string, symbol>>(() => new Map());

export function messageForkAdmissionKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return JSON.stringify([environmentId, threadId]);
}

export function claimMessageFork(key: string): (() => void) | null {
  const current = useMessageForkAdmission.getState();
  if (current.has(key)) return null;
  const token = Symbol();
  useMessageForkAdmission.setState(new Map(current).set(key, token), true);
  return () => {
    const latest = useMessageForkAdmission.getState();
    if (latest.get(key) !== token) return;
    const next = new Map(latest);
    next.delete(key);
    useMessageForkAdmission.setState(next, true);
  };
}
