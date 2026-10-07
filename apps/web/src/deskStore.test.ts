import { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeskState, deskTabKey, serializeDesk } from "./deskModel";
import { createDeskStore, DESK_RESIZE_PERSIST_INTERVAL_MS, deskStorageKey } from "./deskStore";
import { createMemoryStorage, type StateStorage } from "./lib/storage";
import type { ThreadRouteTarget } from "./threadRoutes";
import { DraftId } from "./composerDraftStore";

const environmentId = EnvironmentId.make("desk-test");
const otherEnvironment = EnvironmentId.make("desk-other");
const denied = () => {
  throw new Error("denied");
};
const target = (environment = environmentId): ThreadRouteTarget => ({
  kind: "server",
  threadRef: { environmentId: environment, threadId: ThreadId.make("same-id") },
});

function resizableStore() {
  const storage = createMemoryStorage();
  const writes = vi.spyOn(storage, "setItem");
  const store = createDeskStore(() => storage);
  store.getState().bindEnvironment(environmentId);
  store.getState().dispatch({ type: "open", target: target() });
  const second: ThreadRouteTarget = {
    kind: "server",
    threadRef: { environmentId, threadId: ThreadId.make("second") },
  };
  store.getState().dispatch({ type: "open", target: second });
  store
    .getState()
    .dispatch({ type: "split", tabKey: deskTabKey(second), targetGroupId: "g1", edge: "right" });
  const layout = store.getState().desk.layout;
  if (layout.kind !== "split") throw new Error("Expected split layout");
  writes.mockClear();
  return { storage, writes, store, splitId: layout.id };
}

describe("Desk store", () => {
  it("persists kept tabs but drops temporary previews across restart and environment changes", () => {
    const storage = createMemoryStorage();
    const store = createDeskStore(() => storage);
    store.getState().bindEnvironment(environmentId);
    store.getState().dispatch({ type: "open", target: target(), preview: true });
    const reopened = createDeskStore(() => storage);
    reopened.getState().bindEnvironment(environmentId);
    expect(reopened.getState().desk.groups.g1?.tabs).toEqual([]);
    store.getState().dispatch({ type: "keepOpen", tabKey: deskTabKey(target()) });
    reopened.getState().bindEnvironment(null);
    reopened.getState().bindEnvironment(environmentId);
    expect(reopened.getState().desk.groups.g1?.tabs).toEqual([deskTabKey(target())]);
    store.getState().bindEnvironment(otherEnvironment);
    expect(store.getState().desk.groups.g1?.tabs).toEqual([]);
    store.getState().bindEnvironment(environmentId);
    expect(store.getState().desk.groups.g1?.previewTabKey).toBeUndefined();
    expect(store.getState().desk.groups.g1?.tabs).toEqual([deskTabKey(target())]);
  });

  it("dismisses a preview for a pending editor without consuming editor ownership", () => {
    const { store, storage } = resizableStore();
    const groupId = store.getState().desk.activeGroupId;
    const preview: ThreadRouteTarget = {
      kind: "server",
      threadRef: { environmentId, threadId: ThreadId.make("preview") },
    };
    store.getState().dispatch({ type: "open", target: preview, preview: true });
    const previous = store
      .getState()
      .desk.groups[groupId]!.tabs.find((key) => key !== deskTabKey(preview))!;
    store.getState().dispatch({ type: "close", tabKey: previous });
    const draftId = DraftId.make("pending-preview-editor");
    store.getState().showDraftEditor(draftId, groupId);
    expect(store.getState().desk.groups[groupId]?.tabs).toEqual([]);
    expect(store.getState().activeDraftId).toBe(draftId);
    expect(store.getState().draftEditors[draftId]?.groupId).toBe(groupId);
    const restored = createDeskStore(() => storage);
    restored.getState().bindEnvironment(environmentId);
    expect(Object.keys(restored.getState().desk.groups)).toEqual(["g1"]);
    expect(
      store.getState().promoteDraftEditor(draftId, {
        environmentId,
        threadId: ThreadId.make("sent-preview-editor"),
      }),
    ).toBe(true);
    expect(store.getState().desk.groups[groupId]?.previewTabKey).toBeUndefined();
    expect(store.getState().activeDraftId).toBeNull();
  });

  it("opens a pending editor without changing the sidebar, saved tabs or persisted layout", () => {
    const storage = createMemoryStorage();
    const writes = vi.spyOn(storage, "setItem");
    const store = createDeskStore(() => storage);
    store.getState().bindEnvironment(environmentId);
    store.getState().dispatch({ type: "open", target: target() });
    const saved = store.getState().desk;
    const draftId = DraftId.make("pending-editor");
    writes.mockClear();
    store.getState().showDraftEditor(draftId);
    expect(store.getState().desk).toBe(saved);
    expect(store.getState().desk.sidebarMode).toBe("projects");
    expect(store.getState().activeDraftId).toBe(draftId);
    expect(store.getState().draftEditors[draftId]).toEqual({ draftId, groupId: "g1" });
    expect(writes).not.toHaveBeenCalled();
    store.getState().dispatch({ type: "activateGroup", groupId: "g1" });
    expect(store.getState().activeDraftId).toBe(draftId);
    // The saved tab is still selected underneath the editor. Selecting it
    // explicitly dismisses the editor even when the tab reducer is a no-op.
    store.getState().dispatch({ type: "select", tabKey: deskTabKey(target()) });
    expect(store.getState().activeDraftId).toBeNull();
    expect(store.getState().draftEditors[draftId]).toBeDefined();
  });

  it("creates one saved tab only at promotion and retains the selected sidebar mode", () => {
    const storage = createMemoryStorage();
    const store = createDeskStore(() => storage);
    store.getState().bindEnvironment(environmentId);
    const draftId = DraftId.make("pending-first-send");
    const threadRef = { environmentId, threadId: ThreadId.make("sent-chat") };
    store.getState().showDraftEditor(draftId);
    expect(store.getState().desk.groups.g1?.tabs).toEqual([]);
    expect(store.getState().promoteDraftEditor(draftId, threadRef)).toBe(true);
    const key = deskTabKey({ kind: "server", threadRef });
    expect(store.getState().desk.groups.g1?.tabs).toEqual([key]);
    expect(store.getState().desk.groups.g1?.activeTabKey).toBe(key);
    expect(store.getState().desk.sidebarMode).toBe("projects");
    expect(store.getState().draftEditors).toEqual({});
    expect(store.getState().activeDraftId).toBeNull();
    expect(store.getState().promoteDraftEditor(draftId, threadRef)).toBe(false);
    expect(store.getState().desk.groups.g1?.tabs).toEqual([key]);
    const restored = createDeskStore(() => storage);
    restored.getState().bindEnvironment(environmentId);
    expect(restored.getState().desk).toEqual(store.getState().desk);
    expect(restored.getState().draftEditors).toEqual({});
  });

  it("promotes a background editor into its captured group without stealing newer input", () => {
    const { store } = resizableStore();
    const firstGroup = store.getState().desk.activeGroupId;
    const before = store.getState().desk.groups[firstGroup]?.activeTabKey;
    const firstId = DraftId.make("sending-editor");
    const newerId = DraftId.make("newer-editor");
    store.getState().showDraftEditor(firstId, firstGroup);
    store.getState().dispatch({ type: "activateGroup", groupId: "g1" });
    store.getState().showDraftEditor(newerId, "g1");
    const threadRef = { environmentId, threadId: ThreadId.make("background-sent-chat") };
    expect(store.getState().promoteDraftEditor(firstId, threadRef)).toBe(true);
    expect(store.getState().desk.groups[firstGroup]?.tabs).toContain(
      deskTabKey({ kind: "server", threadRef }),
    );
    expect(store.getState().desk.groups[firstGroup]?.activeTabKey).toBe(before);
    expect(store.getState().desk.activeGroupId).toBe("g1");
    expect(store.getState().activeDraftId).toBe(newerId);
    expect(store.getState().draftEditors[newerId]).toBeDefined();
    store.getState().bindEnvironment(otherEnvironment);
    expect(store.getState().draftEditors).toEqual({});
    expect(store.getState().activeDraftId).toBeNull();
    expect(store.getState().promoteDraftEditor(newerId, threadRef)).toBe(false);
  });

  it("keeps the newly focused saved chat selected when another group's first send completes", () => {
    const { store, storage } = resizableStore();
    const editorGroup = store.getState().desk.activeGroupId;
    const draftId = DraftId.make("sending-editor");
    store.getState().showDraftEditor(draftId, editorGroup);
    const editor = store.getState().draftEditors[draftId];
    const editorSelectedTab = store.getState().desk.groups[editorGroup]?.activeTabKey;
    const savedSelectedTab = store.getState().desk.groups.g1?.activeTabKey;
    store.getState().dispatch({ type: "focus", groupId: "g1" });
    expect(store.getState().activeDraftId).toBeNull();
    expect(store.getState().draftEditors[draftId]).toBe(editor);
    const threadRef = { environmentId, threadId: ThreadId.make("background-sent-chat") };
    expect(store.getState().promoteDraftEditor(draftId, threadRef)).toBe(true);
    expect(store.getState().desk.groups[editorGroup]?.tabs).toContain(
      deskTabKey({ kind: "server", threadRef }),
    );
    expect(store.getState().desk.groups[editorGroup]?.activeTabKey).toBe(editorSelectedTab);
    expect(store.getState().desk.groups.g1?.activeTabKey).toBe(savedSelectedTab);
    expect(store.getState().desk.activeGroupId).toBe("g1");
    expect(store.getState().desk.focusedGroupId).toBe("g1");
    expect(store.getState().activeDraftId).toBeNull();
    expect(store.getState().draftEditors[draftId]).toBeUndefined();
    const restored = createDeskStore(() => storage);
    restored.getState().bindEnvironment(environmentId);
    expect(restored.getState().desk).toEqual(store.getState().desk);
  });

  it("retains the active editor when focusing its own group, restoring groups or rejecting an unknown group", () => {
    const { store } = resizableStore();
    const editorGroup = store.getState().desk.activeGroupId;
    const draftId = DraftId.make("sending-editor");
    store.getState().showDraftEditor(draftId, editorGroup);
    for (const groupId of [editorGroup, editorGroup, null, "missing-group"]) {
      store.getState().dispatch({ type: "focus", groupId });
      expect(store.getState().activeDraftId).toBe(draftId);
      expect(store.getState().draftEditors[draftId]?.groupId).toBe(editorGroup);
    }
    const threadRef = { environmentId, threadId: ThreadId.make("active-sent-chat") };
    expect(store.getState().promoteDraftEditor(draftId, threadRef)).toBe(true);
    expect(store.getState().desk.groups[editorGroup]?.activeTabKey).toBe(
      deskTabKey({ kind: "server", threadRef }),
    );
    expect(store.getState().desk.activeGroupId).toBe(editorGroup);
  });

  it("binds only after authenticated environment selection and persists layout independently", () => {
    const storage = createMemoryStorage();
    const store = createDeskStore(() => storage);
    store.getState().dispatch({ type: "open", target: target() });
    expect(store.getState().desk.targets).toEqual({});
    store.getState().bindEnvironment(environmentId);
    store.getState().dispatch({ type: "open", target: target() });
    store.getState().dispatch({ type: "sidebarMode", mode: "desk" });
    const second = createDeskStore(() => storage);
    second.getState().bindEnvironment(environmentId);
    expect(second.getState().desk).toEqual(store.getState().desk);
    expect(second.getState().desk.groups.g1!.tabs).toEqual([deskTabKey(target())]);
  });

  it("does not leak same-id threads across environment bindings", () => {
    const storage = createMemoryStorage();
    const store = createDeskStore(() => storage);
    store.getState().bindEnvironment(environmentId);
    store.getState().dispatch({ type: "open", target: target() });
    store.getState().bindEnvironment(otherEnvironment);
    expect(store.getState().desk.targets).toEqual({});
    store.getState().dispatch({ type: "open", target: target(otherEnvironment) });
    expect(store.getState().desk.groups.g1!.tabs).toEqual([deskTabKey(target(otherEnvironment))]);
    store.getState().bindEnvironment(environmentId);
    expect(store.getState().desk.groups.g1!.tabs).toEqual([deskTabKey(target())]);
    store.getState().bindEnvironment(null);
    expect(store.getState().desk).toEqual(createDeskState());
  });

  it("storage denial and quota errors never stop in-memory tab operations", () => {
    const storage: StateStorage = { getItem: denied, setItem: denied, removeItem: denied };
    const store = createDeskStore(() => storage);
    expect(() => store.getState().bindEnvironment(environmentId)).not.toThrow();
    expect(() => store.getState().dispatch({ type: "open", target: target() })).not.toThrow();
    expect(store.getState().desk.groups.g1!.tabs).toEqual([deskTabKey(target())]);
  });

  it("does not rewrite storage for no-op actions or repeat bindings", () => {
    const storage = { ...createMemoryStorage(), setItem: vi.fn() };
    const store = createDeskStore(() => storage);
    store.getState().bindEnvironment(environmentId);
    store.getState().dispatch({ type: "close", tabKey: "missing" });
    const before = store.getState().desk;
    store.getState().bindEnvironment(environmentId);
    expect(store.getState().desk).toBe(before);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("leaves invalid persisted data untouched until a real navigation change", () => {
    const storage = createMemoryStorage();
    storage.setItem(deskStorageKey(environmentId), "invalid");
    const store = createDeskStore(() => storage);
    store.getState().bindEnvironment(environmentId);
    expect(store.getState().desk).toEqual(createDeskState(environmentId));
    expect(storage.getItem(deskStorageKey(environmentId))).toBe("invalid");
    store.getState().dispatch({ type: "sidebarMode", mode: "desk" });
    expect(storage.getItem(deskStorageKey(environmentId))).toBe(
      serializeDesk(store.getState().desk),
    );
  });
});

describe("Desk resize persistence coalescing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("updates layout immediately but bounds storage writes while continuously dragging", () => {
    const { store, writes, splitId } = resizableStore();
    store.getState().dispatch({ type: "resize", splitId, ratio: 0.3 });
    expect(store.getState().desk.layout).toMatchObject({ ratio: 0.3 });
    vi.advanceTimersByTime(DESK_RESIZE_PERSIST_INTERVAL_MS / 2);
    store.getState().dispatch({ type: "resize", splitId, ratio: 0.6 });
    expect(writes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DESK_RESIZE_PERSIST_INTERVAL_MS / 2);
    expect(writes).toHaveBeenCalledExactlyOnceWith(
      deskStorageKey(environmentId),
      serializeDesk(store.getState().desk),
    );
    store.getState().dispatch({ type: "resize", splitId, ratio: 0.7 });
    vi.advanceTimersByTime(DESK_RESIZE_PERSIST_INTERVAL_MS);
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it("the next tab action writes the latest layout once and cancels the older snapshot", () => {
    const { store, writes, splitId } = resizableStore();
    store.getState().dispatch({ type: "resize", splitId, ratio: 0.65 });
    store.getState().dispatch({ type: "sidebarMode", mode: "desk" });
    expect(writes).toHaveBeenCalledExactlyOnceWith(
      deskStorageKey(environmentId),
      serializeDesk(store.getState().desk),
    );
    vi.advanceTimersByTime(DESK_RESIZE_PERSIST_INTERVAL_MS);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("a no-op tab action flushes pending resize without waiting for another render", () => {
    const { store, writes, splitId } = resizableStore();
    store.getState().dispatch({ type: "resize", splitId, ratio: 0.65 });
    store.getState().dispatch({ type: "close", tabKey: "missing" });
    expect(writes).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DESK_RESIZE_PERSIST_INTERVAL_MS);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("flushes the old authenticated namespace before rebinding or clearing it", () => {
    const { store, writes, splitId } = resizableStore();
    store.getState().dispatch({ type: "resize", splitId, ratio: 0.65 });
    const saved = serializeDesk(store.getState().desk);
    store.getState().bindEnvironment(otherEnvironment);
    expect(writes).toHaveBeenCalledExactlyOnceWith(deskStorageKey(environmentId), saved);
    vi.advanceTimersByTime(DESK_RESIZE_PERSIST_INTERVAL_MS);
    expect(writes).toHaveBeenCalledTimes(1);
    store.getState().bindEnvironment(environmentId);
    expect(serializeDesk(store.getState().desk)).toBe(saved);
    store.getState().dispatch({ type: "resize", splitId, ratio: 0.4 });
    store.getState().bindEnvironment(null);
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it("flushes once on pagehide and removes its temporary listener", () => {
    const fakeWindow = new EventTarget();
    const remove = vi.spyOn(fakeWindow, "removeEventListener");
    vi.stubGlobal("window", fakeWindow);
    const { store, writes, splitId } = resizableStore();
    store.getState().dispatch({ type: "resize", splitId, ratio: 0.65 });
    fakeWindow.dispatchEvent(new Event("pagehide"));
    expect(writes).toHaveBeenCalledExactlyOnceWith(
      deskStorageKey(environmentId),
      serializeDesk(store.getState().desk),
    );
    expect(remove).toHaveBeenCalledWith("pagehide", expect.any(Function));
    fakeWindow.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(DESK_RESIZE_PERSIST_INTERVAL_MS);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("supports explicit release flush without changing state or writing twice", () => {
    const { store, writes, splitId } = resizableStore();
    store.getState().dispatch({ type: "resize", splitId, ratio: 0.65 });
    const before = store.getState().desk;
    store.getState().flushPersistence();
    store.getState().flushPersistence();
    expect(store.getState().desk).toBe(before);
    expect(writes).toHaveBeenCalledTimes(1);
  });
});
