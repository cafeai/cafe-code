import { create } from "zustand";

/**
 * Focus handoff for the Settings search field. The ⌘F/Ctrl+F handler lives
 * in the Settings layout, but on narrow windows the field is inside a sidebar
 * sheet that is not mounted until the sheet opens, so the request stays
 * pending until a mounted field consumes it.
 */
interface SettingsSearchFocusStore {
  readonly request: number;
  readonly pending: boolean;
  requestFocus: () => void;
  /** Returns true once for each pending request. */
  consume: () => boolean;
}

export const useSettingsSearchFocusStore = create<SettingsSearchFocusStore>((set, get) => ({
  request: 0,
  pending: false,
  requestFocus: () => set((state) => ({ request: state.request + 1, pending: true })),
  consume: () => {
    if (!get().pending) return false;
    set({ pending: false });
    return true;
  },
}));
