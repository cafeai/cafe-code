import type { ScopedThreadRef } from "@cafecode/contracts";
import { create } from "zustand";

/**
 * Which chat's Secrets dialog is open. Holds only the exact environment/thread
 * identity and a generation; never secret metadata or values.
 */
interface ThreadSecretsDialogState {
  readonly target:
    | (ScopedThreadRef & { readonly title: string; readonly generation: number })
    | null;
  open: (threadRef: ScopedThreadRef, title: string) => void;
  close: () => void;
}

let generation = 0;

export const useThreadSecretsDialogStore = create<ThreadSecretsDialogState>((set) => ({
  target: null,
  open: (threadRef, title) =>
    set({
      target: {
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
        title,
        generation: ++generation,
      },
    }),
  close: () => set({ target: null }),
}));

export function openThreadSecretsDialog(threadRef: ScopedThreadRef, title: string) {
  useThreadSecretsDialogStore.getState().open(threadRef, title);
}
