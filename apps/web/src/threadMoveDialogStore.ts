import type { ScopedThreadRef } from "@cafecode/contracts";
import { create } from "zustand";

export interface ThreadMoveDialogTarget {
  readonly id: string;
  readonly threadRef: ScopedThreadRef;
}

/** One view shared by Chats, Projects and Desk. Exact object identity prevents
 * a late acknowledgement from closing a subsequently opened chooser. */
export const useThreadMoveDialogStore = create<{
  readonly target: ThreadMoveDialogTarget | null;
  readonly open: (threadRef: ScopedThreadRef) => void;
  readonly close: (target: ThreadMoveDialogTarget) => void;
}>((set) => ({
  target: null,
  open: (threadRef) => set({ target: { id: crypto.randomUUID(), threadRef } }),
  close: (target) => set((state) => (state.target === target ? { target: null } : state)),
}));

export function openThreadMoveDialog(threadRef: ScopedThreadRef) {
  useThreadMoveDialogStore.getState().open(threadRef);
}
