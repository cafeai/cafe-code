import { create } from "zustand";

/**
 * Volatile sidebar presentation: the scoped key of the hovered chat row that
 * owns agent-created groups, so its group rows (which are sibling list items,
 * not DOM descendants) highlight together with it. Never persisted; grants
 * nothing and never changes a chat or group.
 */
export const useThreadGroupOwnerHoverStore = create<{ ownerKey: string | null }>(() => ({
  ownerKey: null,
}));

export function setHoveredThreadGroupOwner(ownerKey: string): void {
  if (useThreadGroupOwnerHoverStore.getState().ownerKey !== ownerKey) {
    useThreadGroupOwnerHoverStore.setState({ ownerKey });
  }
}

/** Clears only this owner's hover, so a late leave cannot clear a newer row. */
export function clearHoveredThreadGroupOwner(ownerKey: string): void {
  if (useThreadGroupOwnerHoverStore.getState().ownerKey === ownerKey) {
    useThreadGroupOwnerHoverStore.setState({ ownerKey: null });
  }
}
