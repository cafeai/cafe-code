import { create } from "zustand";

/**
 * Open/closed state for the Task Atrium overlay.
 *
 * Deliberately ephemeral and not persisted: the Atrium only ever appears
 * because someone asked for it, so it should never be open on launch.
 */
interface TaskAtriumStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useTaskAtriumStore = create<TaskAtriumStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
}));
