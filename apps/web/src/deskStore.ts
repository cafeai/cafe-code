import type { EnvironmentId, ScopedThreadRef } from "@cafecode/contracts";
import { create } from "zustand";
import type { DraftId } from "./composerDraftStore";

import {
  createDeskState,
  deskGroupForTab,
  deskTabKey,
  DESK_LIMITS,
  hydrateDesk,
  reduceDesk,
  serializeDesk,
  type DeskAction,
  type DeskState,
} from "./deskModel";
import type { StateStorage } from "./lib/storage";

export const DESK_STORAGE_PREFIX = "cafe-code:desk:v1:";
export const DESK_RESIZE_PERSIST_INTERVAL_MS = 200;

export interface DeskStoreState {
  readonly desk: DeskState;
  /** Pending editors are view ownership, never persisted open-chat entries. */
  readonly draftEditors: Readonly<Record<string, { draftId: DraftId; groupId: string }>>;
  readonly activeDraftId: DraftId | null;
  readonly showDraftEditor: (draftId: DraftId, groupId?: string, activate?: boolean) => void;
  readonly promoteDraftEditor: (draftId: DraftId, threadRef: ScopedThreadRef) => boolean;
  readonly reconcileDraftEditors: (draftIds: readonly DraftId[]) => void;
  readonly bindEnvironment: (environmentId: EnvironmentId | null) => void;
  readonly dispatch: (action: DeskAction) => void;
  readonly flushPersistence: () => void;
}

export function deskStorageKey(environmentId: EnvironmentId): string {
  return `${DESK_STORAGE_PREFIX}${encodeURIComponent(environmentId)}`;
}

function browserStorage(): StateStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** A separate factory makes storage denial and environment switching testable
 * without providers, authenticated APIs, or the singleton application store. */
export function createDeskStore(resolveStorage: () => StateStorage | null = browserStorage) {
  let pendingResize: DeskState | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let listeningWindow: Window | null = null;

  const persist = (desk: DeskState) => {
    if (desk.environmentId === null) return;
    try {
      const raw = serializeDesk(desk);
      if (
        raw.length <= DESK_LIMITS.persistedBytes &&
        new TextEncoder().encode(raw).byteLength <= DESK_LIMITS.persistedBytes
      )
        resolveStorage()?.setItem(deskStorageKey(desk.environmentId), raw);
    } catch {
      // Full/disabled storage cannot roll back an already-visible tab action.
      // The existing chats, drafts and queued input are stored independently.
    }
  };

  const discardPendingResize = () => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = null;
    pendingResize = null;
    listeningWindow?.removeEventListener("pagehide", flushPersistence);
    listeningWindow = null;
  };
  const flushPersistence = () => {
    const latest = pendingResize;
    discardPendingResize();
    if (latest !== null) persist(latest);
  };
  const scheduleResizePersistence = (desk: DeskState) => {
    pendingResize = desk;
    if (resizeTimer !== null) return;
    // Pointer movement may update the layout at display refresh frequency.
    // Coalesce only those metadata writes, with a fixed maximum delay rather
    // than postponing forever while the user continues dragging the divider.
    resizeTimer = setTimeout(flushPersistence, DESK_RESIZE_PERSIST_INTERVAL_MS);
    if (typeof window !== "undefined") {
      listeningWindow = window;
      listeningWindow.addEventListener("pagehide", flushPersistence);
    }
  };

  return create<DeskStoreState>((set, get) => ({
    desk: createDeskState(),
    draftEditors: {},
    activeDraftId: null,
    flushPersistence,
    showDraftEditor: (draftId, groupId, activate = true) => {
      const current = get();
      if (current.desk.environmentId === null) return;
      const previous = current.draftEditors[draftId];
      const destination = groupId ?? previous?.groupId ?? current.desk.activeGroupId;
      const admittedGroup = current.desk.groups[destination]
        ? destination
        : current.desk.activeGroupId;
      const next = activate
        ? reduceDesk(current.desk, { type: "activateGroup", groupId: admittedGroup })
        : current.desk;
      if (
        previous?.groupId === admittedGroup &&
        (!activate || current.activeDraftId === draftId) &&
        next === current.desk
      )
        return;
      set({
        ...(next !== current.desk ? { desk: next } : {}),
        draftEditors: {
          ...current.draftEditors,
          [draftId]: { draftId, groupId: admittedGroup },
        },
        ...(activate ? { activeDraftId: draftId } : {}),
      });
      if (next !== current.desk) {
        discardPendingResize();
        persist(next);
      }
    },
    promoteDraftEditor: (draftId, threadRef) => {
      const current = get();
      const editor = current.draftEditors[draftId];
      if (!editor || threadRef.environmentId !== current.desk.environmentId) return false;
      const active = current.activeDraftId === draftId;
      const next = reduceDesk(current.desk, {
        type: "open",
        target: { kind: "server", threadRef },
        groupId: current.desk.groups[editor.groupId] ? editor.groupId : current.desk.activeGroupId,
        activate: active,
      });
      // Respect the existing open-tab limit without retiring a still-owned
      // editor. Reconciliation can promote it when a tab slot becomes free.
      if (!deskGroupForTab(next, deskTabKey({ kind: "server", threadRef }))) return false;
      const { [draftId]: _retired, ...draftEditors } = current.draftEditors;
      set({
        desk: next,
        draftEditors,
        activeDraftId: active ? null : current.activeDraftId,
      });
      discardPendingResize();
      persist(next);
      return true;
    },
    reconcileDraftEditors: (draftIds) => {
      const current = get();
      const available = new Set(draftIds);
      const retained = Object.entries(current.draftEditors).filter(([id]) =>
        available.has(id as DraftId),
      );
      if (retained.length === Object.keys(current.draftEditors).length) return;
      set({
        draftEditors: Object.fromEntries(retained),
        activeDraftId:
          current.activeDraftId && available.has(current.activeDraftId)
            ? current.activeDraftId
            : null,
      });
    },
    bindEnvironment: (environmentId) => {
      if (get().desk.environmentId === environmentId) return;
      // Flush the exact old namespace before selecting another authenticated
      // environment, so a delayed callback cannot publish into its successor.
      flushPersistence();
      if (environmentId === null) {
        set({ desk: createDeskState(), draftEditors: {}, activeDraftId: null });
        return;
      }
      let raw: string | null = null;
      try {
        const saved = resolveStorage()?.getItem(deskStorageKey(environmentId));
        // Browser navigation preferences use synchronous local storage only.
        // A custom async adapter is not allowed to hydrate an old environment
        // after a newer authenticated binding has already been selected.
        if (typeof saved === "string") raw = saved;
      } catch {
        // Storage denial affects persistence, never whether chats can open.
      }
      set({ desk: hydrateDesk(raw, environmentId), draftEditors: {}, activeDraftId: null });
    },
    dispatch: (action) => {
      const { desk: current, activeDraftId, draftEditors } = get();
      const next = reduceDesk(current, action);
      // Pane focus on the editor's own group and sidebar-mode changes do not
      // dismiss it. Explicit chat selection must work even if its saved tab was
      // already selected underneath the pending editor (a reducer no-op).
      const capturedGroup = activeDraftId ? draftEditors[activeDraftId]?.groupId : null;
      const editorGroup =
        capturedGroup && current.groups[capturedGroup] ? capturedGroup : current.activeGroupId;
      const leavesEditor =
        action.type === "open" ||
        action.type === "select" ||
        action.type === "reopen" ||
        action.type === "closeAll" ||
        action.type === "split" ||
        action.type === "move" ||
        (action.type === "activateGroup" && action.groupId !== editorGroup) ||
        (action.type === "focus" &&
          action.groupId !== null &&
          action.groupId !== editorGroup &&
          next.activeGroupId === action.groupId) ||
        (action.type === "closeGroup" && action.groupId === editorGroup);
      if (next === current) {
        if (activeDraftId && leavesEditor) set({ activeDraftId: null });
        if (action.type !== "resize") flushPersistence();
        return;
      }
      set({ desk: next, ...(activeDraftId && leavesEditor ? { activeDraftId: null } : {}) });
      if (action.type === "resize") scheduleResizePersistence(next);
      else {
        // A tab operation includes the latest resize and must be immediately
        // durable. Cancel the stale pending snapshot instead of writing both.
        discardPendingResize();
        persist(next);
      }
    },
  }));
}

export const useDeskStore = createDeskStore();
