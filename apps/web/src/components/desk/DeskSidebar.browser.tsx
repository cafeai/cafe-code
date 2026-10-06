import "../../index.css";

import { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

import type { DraftId } from "../../composerDraftStore";
import { createDeskState, deskTabKey } from "../../deskModel";
import { useDeskStore } from "../../deskStore";
import type { ThreadRouteTarget } from "../../threadRoutes";
import { DeskSidebar } from "./DeskSidebar";

const mocks = vi.hoisted(() => ({
  rename: vi.fn(),
  archive: vi.fn(),
  recycle: vi.fn(),
  delete: vi.fn(),
  hardDelete: vi.fn(),
  showMenu: vi.fn(),
  confirm: vi.fn(),
  working: false,
}));
vi.mock("../../threadRename", () => ({ renameThread: mocks.rename }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    archiveThread: mocks.archive,
    confirmAndDeleteThread: mocks.recycle,
    deleteThread: mocks.delete,
    hardDeleteThread: mocks.hardDelete,
  }),
}));
vi.mock("../../hooks/useSettings", async () => {
  const { DEFAULT_UNIFIED_SETTINGS } = await import("@cafecode/contracts/settings");
  const settings = { ...DEFAULT_UNIFIED_SETTINGS, confirmThreadArchive: true };
  return {
    getClientSettings: () => settings,
    useSettings: (select: (value: typeof settings) => unknown) => select(settings),
  };
});
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: mocks.showMenu },
    dialogs: { confirm: mocks.confirm },
  }),
  ensureLocalApi: () => ({
    contextMenu: { show: mocks.showMenu },
    dialogs: { confirm: mocks.confirm },
  }),
}));
// Canonical summary rendering is independent of the layout. The row must pass
// its full route target to navigation and its scoped identity to metadata
// actions; it must never infer either identity from its display title.
vi.mock("./useDeskTabMetadata", () => {
  const metadata = (target: ThreadRouteTarget) => ({
    title: target.kind === "draft" ? "New chat" : `Chat ${target.threadRef.environmentId}`,
    projectName: "Fixture project",
    activityAt: new Date(Date.now() - (2 * 24 * 60 + 5) * 60_000).toISOString(),
    threadRef: target.kind === "server" ? target.threadRef : null,
    exists: true,
    working: mocks.working,
    attention: false,
    status: null,
  });
  return { useDeskTabMetadata: metadata, readDeskTabMetadata: metadata };
});

const environmentId = EnvironmentId.make("fixture");
const chat: ThreadRouteTarget = {
  kind: "server",
  threadRef: { environmentId, threadId: ThreadId.make("chat-1") },
};
const draft: ThreadRouteTarget = { kind: "draft", draftId: "draft-1" as DraftId };

beforeEach(async () => {
  await page.viewport(1100, 800);
  useDeskStore.setState({
    desk: createDeskState(environmentId),
    draftEditors: {},
    activeDraftId: null,
  });
  mocks.rename.mockReset();
  mocks.rename.mockResolvedValue(undefined);
  for (const action of [mocks.archive, mocks.recycle, mocks.delete, mocks.hardDelete])
    action.mockReset().mockResolvedValue(undefined);
  mocks.showMenu.mockReset().mockResolvedValue(null);
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.working = false;
});
afterEach(() => {
  useDeskStore.setState({ desk: createDeskState(), draftEditors: {}, activeDraftId: null });
  localStorage.removeItem(`cafe-code:desk:v1:${environmentId}`);
});

async function setup() {
  useDeskStore.getState().dispatch({ type: "open", target: chat });
  useDeskStore.getState().dispatch({ type: "open", target: draft });
  const onNavigate = vi.fn();
  const onNewChat = vi.fn();
  const screen = await render(<DeskSidebar onNavigate={onNavigate} onNewChat={onNewChat} />);
  return { screen, onNavigate, onNewChat };
}

function deferredMenu() {
  let answer!: (action: string | null) => void;
  const promise = new Promise<string | null>((resolve) => {
    answer = resolve;
  });
  return { promise, answer };
}

function openRowMenu(element: Element) {
  element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

describe("Desk sidebar", () => {
  it("offers exact-chat actions on right-click without activating the row", async () => {
    const { screen, onNavigate } = await setup();
    const before = useDeskStore.getState().desk;
    const row = screen.getByRole("button", { name: "Chat fixture", exact: true });
    row.element().dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 60,
      }),
    );
    await expect.poll(() => mocks.showMenu.mock.calls.length).toBe(1);
    expect(mocks.showMenu.mock.calls[0]?.[0].map((item: { id: string }) => item.id)).toEqual([
      "rename",
      "archive",
      "delete",
      "delete-forever",
      "close",
    ]);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(useDeskStore.getState().desk).toBe(before);
  });

  it("opens with Shift+F10 and renames the requested row inline", async () => {
    const { screen, onNavigate } = await setup();
    mocks.showMenu.mockResolvedValueOnce("rename");
    screen.getByRole("button", { name: "Chat fixture", exact: true }).element().focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(screen.getByRole("textbox", { name: "Chat title" })).toBeVisible();
    expect(onNavigate).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
  });

  it.each(["close", "rename"])(
    "discards a delayed %s choice after the tab was closed and reopened",
    async (action) => {
      const { screen } = await setup();
      const reply = deferredMenu();
      mocks.showMenu.mockReturnValueOnce(reply.promise);
      openRowMenu(screen.getByRole("button", { name: "Chat fixture", exact: true }).element());
      await expect.poll(() => mocks.showMenu.mock.calls.length).toBe(1);
      // Use the real navigation reducer: the same ID is a new open-tab intent,
      // even if React has not yet committed the intermediate row removal.
      useDeskStore.getState().dispatch({ type: "close", tabKey: deskTabKey(chat) });
      useDeskStore.getState().dispatch({ type: "reopen" });
      const reopened = useDeskStore.getState().desk;
      reply.answer(action);
      await reply.promise;
      expect(useDeskStore.getState().desk).toBe(reopened);
      expect(reopened.groups.g1?.tabs).toContain(deskTabKey(chat));
      await expect
        .element(screen.getByRole("textbox", { name: "Chat title" }))
        .not.toBeInTheDocument();
      expect(mocks.rename).not.toHaveBeenCalled();
    },
  );

  it("discards a delayed close after the same environment's persisted layout is rebound", async () => {
    const { screen } = await setup();
    const reply = deferredMenu();
    mocks.showMenu.mockReturnValueOnce(reply.promise);
    openRowMenu(screen.getByRole("button", { name: "Chat fixture", exact: true }).element());
    useDeskStore.getState().bindEnvironment(null);
    useDeskStore.getState().bindEnvironment(environmentId);
    const restored = useDeskStore.getState().desk;
    reply.answer("close");
    await reply.promise;
    expect(useDeskStore.getState().desk).toBe(restored);
    expect(restored.groups.g1?.tabs).toContain(deskTabKey(chat));
  });

  it("accepts only the latest row's menu and preserves an unchanged close choice", async () => {
    const { screen, onNavigate } = await setup();
    const first = deferredMenu();
    const second = deferredMenu();
    mocks.showMenu.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    openRowMenu(screen.getByRole("button", { name: "Chat fixture", exact: true }).element());
    openRowMenu(screen.getByRole("button", { name: "New chat", exact: true }).element());
    const original = useDeskStore.getState().desk;
    first.answer("close");
    await first.promise;
    expect(useDeskStore.getState().desk).toBe(original);
    second.answer("close");
    await second.promise;
    expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([deskTabKey(chat)]);
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it.each(["row", "sidebar"])(
    "revokes an unanswered chat mutation when its %s unmounts",
    async (unmount) => {
      const { screen } = await setup();
      const reply = deferredMenu();
      mocks.showMenu.mockReturnValueOnce(reply.promise);
      openRowMenu(screen.getByRole("button", { name: "Chat fixture", exact: true }).element());
      if (unmount === "sidebar") await screen.unmount();
      else {
        useDeskStore.getState().dispatch({ type: "close", tabKey: deskTabKey(chat) });
        await expect
          .element(screen.getByRole("button", { name: "Chat fixture", exact: true }))
          .not.toBeInTheDocument();
      }
      reply.answer("delete-forever");
      await reply.promise;
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.delete).not.toHaveBeenCalled();
      expect(mocks.hardDelete).not.toHaveBeenCalled();
    },
  );

  it("keeps a directly started rename after an older menu answers", async () => {
    const { screen } = await setup();
    const reply = deferredMenu();
    mocks.showMenu.mockReturnValueOnce(reply.promise);
    const row = screen.getByRole("button", { name: "Chat fixture", exact: true });
    openRowMenu(row.element());
    row.element().focus();
    await userEvent.keyboard("{F2}");
    const original = useDeskStore.getState().desk;
    reply.answer("close");
    await reply.promise;
    expect(useDeskStore.getState().desk).toBe(original);
    await expect.element(screen.getByRole("textbox", { name: "Chat title" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
  });

  it("keeps server chat actions bound to the clicked chat after another tab is selected", async () => {
    const { screen } = await setup();
    await screen.getByRole("button", { name: "Chat fixture", exact: true }).click();
    const reply = deferredMenu();
    mocks.showMenu.mockReturnValueOnce(reply.promise);
    openRowMenu(screen.getByRole("button", { name: "Chat fixture", exact: true }).element());
    useDeskStore.getState().dispatch({ type: "select", tabKey: deskTabKey(draft) });
    reply.answer("delete-forever");
    await reply.promise;
    await expect.poll(() => mocks.hardDelete.mock.calls.length).toBe(1);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith(chat.threadRef);
    expect(mocks.hardDelete).toHaveBeenCalledExactlyOnceWith(chat.threadRef, { confirm: false });
  });

  it("requires permanent-delete consent before any existing lifecycle action and preserves exact scope", async () => {
    const { screen } = await setup();
    const row = screen.getByRole("button", { name: "Chat fixture", exact: true });
    const open = () =>
      row
        .element()
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    mocks.showMenu.mockResolvedValue("delete-forever");
    mocks.confirm.mockResolvedValueOnce(false);
    open();
    await expect.poll(() => mocks.confirm.mock.calls.length).toBe(1);
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.hardDelete).not.toHaveBeenCalled();
    expect(useDeskStore.getState().desk.targets[deskTabKey(chat)]).toEqual(chat);
    open();
    await expect.poll(() => mocks.hardDelete.mock.calls.length).toBe(1);
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith(
      chat.kind === "server" ? chat.threadRef : null,
    );
    expect(mocks.hardDelete).toHaveBeenCalledExactlyOnceWith(
      chat.kind === "server" ? chat.threadRef : null,
      { confirm: false },
    );
    expect(mocks.delete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.hardDelete.mock.invocationCallOrder[0]!,
    );
    await expect
      .poll(() => Object.values(useDeskStore.getState().desk.groups).flatMap((group) => group.tabs))
      .not.toContain(deskTabKey(chat));
  });

  it("keeps drafts view-only and refuses archive after the chat becomes busy", async () => {
    const { screen } = await setup();
    const draftRow = screen.getByRole("button", { name: "New chat", exact: true });
    draftRow
      .element()
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await expect.poll(() => mocks.showMenu.mock.calls.length).toBe(1);
    expect(mocks.showMenu.mock.calls[0]?.[0]).toEqual([{ id: "close", label: "Close tab" }]);
    mocks.working = true;
    mocks.showMenu.mockResolvedValueOnce("archive");
    screen
      .getByRole("button", { name: "Chat fixture", exact: true })
      .element()
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await expect.poll(() => mocks.showMenu.mock.calls.length).toBe(2);
    expect(mocks.showMenu.mock.calls[1]?.[0]).toContainEqual({
      id: "archive",
      label: "Archive chat",
      disabled: true,
    });
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("deduplicates permanent deletion while consent or the purge acknowledgement is pending", async () => {
    const { screen } = await setup();
    const row = screen.getByRole("button", { name: "Chat fixture", exact: true });
    const open = () =>
      row
        .element()
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    let consent!: (accepted: boolean) => void;
    mocks.confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          consent = resolve;
        }),
    );
    mocks.showMenu.mockResolvedValue("delete-forever");
    open();
    await expect.poll(() => mocks.confirm.mock.calls.length).toBe(1);
    open();
    await expect.poll(() => mocks.showMenu.mock.calls.length).toBe(2);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.delete).not.toHaveBeenCalled();
    consent(false);
    await vi.waitFor(() => expect(mocks.confirm.mock.results[0]?.value).resolves.toBe(false));
    let finishPurge!: () => void;
    mocks.hardDelete.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPurge = resolve;
        }),
    );
    open();
    await expect.poll(() => mocks.hardDelete.mock.calls.length).toBe(1);
    open();
    await expect.poll(() => mocks.showMenu.mock.calls.length).toBe(4);
    expect(mocks.delete).toHaveBeenCalledOnce();
    expect(mocks.hardDelete).toHaveBeenCalledOnce();
    finishPurge();
    await expect
      .poll(() => Object.values(useDeskStore.getState().desk.groups).flatMap((group) => group.tabs))
      .not.toContain(deskTabKey(chat));
  });

  it("reuses archive consent and recycle-bin actions for the exact unselected chat", async () => {
    const { screen, onNavigate } = await setup();
    const row = screen.getByRole("button", { name: "Chat fixture", exact: true });
    const open = () =>
      row
        .element()
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    mocks.showMenu.mockResolvedValueOnce("archive");
    mocks.confirm.mockResolvedValueOnce(false);
    open();
    await expect.poll(() => mocks.confirm.mock.calls.length).toBe(1);
    expect(mocks.archive).not.toHaveBeenCalled();
    mocks.showMenu.mockResolvedValueOnce("delete");
    open();
    await expect.poll(() => mocks.recycle.mock.calls.length).toBe(1);
    expect(mocks.recycle).toHaveBeenCalledExactlyOnceWith(
      chat.kind === "server" ? chat.threadRef : null,
    );
    expect(mocks.hardDelete).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("rechecks archive idleness after confirmation finishes", async () => {
    const { screen } = await setup();
    mocks.showMenu.mockResolvedValueOnce("archive");
    mocks.confirm.mockImplementationOnce(async () => {
      mocks.working = true;
      return true;
    });
    screen
      .getByRole("button", { name: "Chat fixture", exact: true })
      .element()
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await expect.poll(() => mocks.confirm.mock.calls.length).toBe(1);
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(
      Object.values(useDeskStore.getState().desk.groups).flatMap((group) => group.tabs),
    ).toContain(deskTabKey(chat));
  });
  it("swaps the group count for a pencil on hover or keyboard focus without shifting the name", async () => {
    const { screen } = await setup();
    try {
      const heading = screen.getByRole("button", { name: "Activate group Main" });
      const pencil = screen.getByRole("button", { name: "Rename group Main" });
      const outside = screen.getByRole("button", { name: "New chat in active tab group" });
      const count = heading.element().querySelector("[data-desk-group-count]")!;
      const name = heading.element().querySelector("[data-desk-group-name]")!;
      await outside.hover();
      await vi.waitFor(() => {
        expect(getComputedStyle(count).opacity).toBe("0.6");
        expect(getComputedStyle(pencil.element()).opacity).toBe("0");
      });
      expect(count.textContent).toBe("2");
      const idleNameWidth = name.getBoundingClientRect().width;
      await heading.hover();
      await vi.waitFor(() => {
        expect(getComputedStyle(count).opacity).toBe("0");
        expect(getComputedStyle(pencil.element()).opacity).toBe("1");
      });
      expect(name.getBoundingClientRect().width).toBe(idleNameWidth);
      await heading.click();
      await outside.hover();
      await vi.waitFor(() => {
        expect(getComputedStyle(count).opacity).toBe("0.6");
        expect(getComputedStyle(pencil.element()).opacity).toBe("0");
      });
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(pencil.element());
      await vi.waitFor(() => {
        expect(getComputedStyle(count).opacity).toBe("0");
        expect(getComputedStyle(pencil.element()).opacity).toBe("1");
      });
      expect(name.getBoundingClientRect().width).toBe(idleNameWidth);
    } finally {
      await screen.unmount();
    }
  });

  it("renames the chosen inactive group inline on Enter and preserves normal group activation", async () => {
    const { screen, onNavigate } = await setup();
    useDeskStore.getState().dispatch({
      type: "split",
      tabKey: deskTabKey(draft),
      targetGroupId: "g1",
      edge: "right",
    });
    const otherGroupId = useDeskStore.getState().desk.activeGroupId;
    useDeskStore
      .getState()
      .dispatch({ type: "renameGroup", groupId: otherGroupId, name: "PixelVM" });
    try {
      // These controls intentionally admit pointer events only while their
      // parent row is hovered. Exercise that real user path before clicking,
      // rather than relying on the runner to reveal a hidden action for us.
      await screen.getByRole("button", { name: "Activate group Main" }).hover();
      await screen.getByRole("button", { name: "Rename group Main" }).click();
      const input = screen.getByRole("textbox", { name: "Group name" });
      const element = input.element() as HTMLInputElement;
      expect(element.selectionStart).toBe(0);
      expect(element.selectionEnd).toBe("Main".length);
      await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
      await input.fill("  Platform  ");
      await userEvent.keyboard("{Enter}");
      await expect.element(input).not.toBeInTheDocument();
      expect(useDeskStore.getState().desk.groups.g1?.name).toBe("Platform");
      expect(useDeskStore.getState().desk.groups[otherGroupId]?.name).toBe("PixelVM");
      expect(useDeskStore.getState().desk.activeGroupId).toBe(otherGroupId);
      expect(onNavigate).not.toHaveBeenCalled();
      expect(mocks.rename).not.toHaveBeenCalled();
      const heading = screen.getByRole("button", { name: "Activate group Platform" });
      await vi.waitFor(() => expect(document.activeElement).toBe(heading.element()));
      await heading.click();
      expect(useDeskStore.getState().desk.activeGroupId).toBe("g1");
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith(chat);
    } finally {
      await screen.unmount();
    }
  });

  it("saves group names on blur and ignores IME Enter and Escape during composition", async () => {
    const { screen, onNavigate } = await setup();
    try {
      await screen.getByRole("button", { name: "Activate group Main" }).click();
      onNavigate.mockClear();
      await userEvent.keyboard("{F2}");
      const input = screen.getByRole("textbox", { name: "Group name" });
      await input.fill("開発");
      for (const key of ["Enter", "Escape"]) {
        input
          .element()
          .dispatchEvent(new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true }));
        await expect.element(input).toHaveValue("開発");
        expect(useDeskStore.getState().desk.groups.g1?.name).toBe("Main");
      }
      const outside = screen.getByRole("button", { name: "New chat in active tab group" });
      await outside.click();
      await expect.element(input).not.toBeInTheDocument();
      expect(useDeskStore.getState().desk.groups.g1?.name).toBe("開発");
      expect(document.activeElement).toBe(outside.element());
      expect(onNavigate).not.toHaveBeenCalled();
      expect(mocks.rename).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("cancels group edits on Escape or an empty name without a blur commit", async () => {
    const { screen, onNavigate } = await setup();
    try {
      await screen.getByRole("button", { name: "Activate group Main" }).hover();
      await screen.getByRole("button", { name: "Rename group Main" }).click();
      const input = screen.getByRole("textbox", { name: "Group name" });
      await input.fill("Discard this name");
      await userEvent.keyboard("{Escape}");
      await expect.element(input).not.toBeInTheDocument();
      await screen.getByRole("button", { name: "New chat in active tab group" }).click();
      expect(useDeskStore.getState().desk.groups.g1?.name).toBe("Main");
      await screen.getByRole("button", { name: "Activate group Main" }).hover();
      await screen.getByRole("button", { name: "Rename group Main" }).click();
      await input.fill("   ");
      await userEvent.keyboard("{Enter}");
      await expect.element(input).not.toBeInTheDocument();
      expect(useDeskStore.getState().desk.groups.g1?.name).toBe("Main");
      expect(onNavigate).not.toHaveBeenCalled();
      expect(mocks.rename).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("discards an unfinished group edit when the environment changes before blur", async () => {
    const { screen } = await setup();
    const otherEnvironmentId = EnvironmentId.make("other-group-fixture");
    try {
      await screen.getByRole("button", { name: "Activate group Main" }).hover();
      await screen.getByRole("button", { name: "Rename group Main" }).click();
      const input = screen.getByRole("textbox", { name: "Group name" });
      await input.fill("Old environment name");
      const element = input.element() as HTMLInputElement;
      // Exercise the narrow interval before React removes the old editor as
      // well as the remount: a blur must not target the new layout's reused g1.
      useDeskStore.getState().bindEnvironment(otherEnvironmentId);
      element.blur();
      await expect.element(input).not.toBeInTheDocument();
      expect(useDeskStore.getState().desk.environmentId).toBe(otherEnvironmentId);
      expect(useDeskStore.getState().desk.groups.g1?.name).toBe("Main");
      await expect
        .element(screen.getByRole("button", { name: "Activate group Main" }))
        .toBeVisible();
      expect(mocks.rename).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      localStorage.removeItem(`cafe-code:desk:v1:${otherEnvironmentId}`);
    }
  });

  it.each(["Enter", "blur"])(
    "discards a group edit on %s after rebinding the same persisted layout",
    async (finish) => {
      const { screen } = await setup();
      screen.getByRole("button", { name: "Activate group Main" }).element().focus();
      await userEvent.keyboard("{F2}");
      const input = screen.getByRole("textbox", { name: "Group name" });
      await input.fill("Old edit");
      useDeskStore.getState().bindEnvironment(null);
      useDeskStore.getState().bindEnvironment(environmentId);
      const restored = useDeskStore.getState().desk;
      if (finish === "Enter") await userEvent.keyboard("{Enter}");
      else (input.element() as HTMLInputElement).blur();
      await expect.element(input).not.toBeInTheDocument();
      expect(useDeskStore.getState().desk).toBe(restored);
      expect(restored.groups.g1?.name).toBe("Main");
    },
  );

  it("refuses to start an edit from a heading before its rebound incarnation renders", async () => {
    const { screen } = await setup();
    const heading = screen.getByRole("button", { name: "Activate group Main" }).element();
    useDeskStore.getState().bindEnvironment(null);
    useDeskStore.getState().bindEnvironment(environmentId);
    heading.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    await expect
      .element(screen.getByRole("textbox", { name: "Group name" }))
      .not.toBeInTheDocument();
    // Once the new heading renders, its own explicit edit still works.
    await screen.getByRole("button", { name: "Activate group Main" }).click();
    await userEvent.keyboard("{F2}");
    await expect.element(screen.getByRole("textbox", { name: "Group name" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
  });

  it("saves an unchanged group's edit on blur after unrelated pane activation", async () => {
    const { screen } = await setup();
    useDeskStore.getState().dispatch({
      type: "split",
      tabKey: deskTabKey(draft),
      targetGroupId: "g1",
      edge: "right",
    });
    useDeskStore.getState().dispatch({ type: "activateGroup", groupId: "g1" });
    screen.getByRole("button", { name: "Activate group Main" }).element().focus();
    await userEvent.keyboard("{F2}");
    const input = screen.getByRole("textbox", { name: "Group name" });
    await input.fill("Keep this edit");
    const group = useDeskStore.getState().desk.groups.g1;
    useDeskStore.getState().dispatch({ type: "activateGroup", groupId: "g2" });
    expect(useDeskStore.getState().desk.groups.g1).toBe(group);
    await screen.getByRole("button", { name: "New chat in active tab group" }).click();
    await expect.element(input).not.toBeInTheDocument();
    expect(useDeskStore.getState().desk.groups.g1?.name).toBe("Keep this edit");
    expect(useDeskStore.getState().desk.activeGroupId).toBe("g2");
  });

  it("opens existing server and draft views using their exact targets", async () => {
    const { screen, onNavigate, onNewChat } = await setup();
    try {
      await screen.getByRole("button", { name: "Chat fixture", exact: true }).click();
      expect(onNavigate).toHaveBeenLastCalledWith(chat);
      expect(useDeskStore.getState().desk.groups.g1?.activeTabKey).toBe(deskTabKey(chat));
      await screen.getByRole("button", { name: "New chat", exact: true }).click();
      expect(onNavigate).toHaveBeenLastCalledWith(draft);
      await screen.getByRole("button", { name: "New chat in active tab group" }).click();
      expect(onNewChat).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("closes only the layout entry without renaming, archiving or navigating", async () => {
    const { screen, onNavigate } = await setup();
    try {
      await screen.getByRole("button", { name: "Chat fixture", exact: true }).hover();
      await screen.getByRole("button", { name: "Close tab Chat fixture" }).click();
      expect(useDeskStore.getState().desk.groups.g1?.tabs).toEqual([deskTabKey(draft)]);
      expect(useDeskStore.getState().desk.closed[0]?.tabKey).toBe(deskTabKey(chat));
      expect(onNavigate).not.toHaveBeenCalled();
      expect(mocks.rename).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("offers direct rename and retains an editable title after failure", async () => {
    const { screen, onNavigate } = await setup();
    try {
      mocks.rename.mockRejectedValueOnce(new Error("Reconnect to this environment."));
      await screen.getByRole("button", { name: "Chat fixture", exact: true }).hover();
      await screen.getByRole("button", { name: "Rename Chat fixture" }).click();
      await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
      await screen.getByRole("textbox", { name: "Chat title" }).fill("A useful title");
      await userEvent.keyboard("{Enter}");
      await expect.element(screen.getByRole("alert")).toMatchTextContent("Could not rename");
      expect(screen.getByRole("alert").element().textContent).not.toContain(
        "Reconnect to this environment.",
      );
      await expect
        .element(screen.getByRole("textbox", { name: "Chat title" }))
        .toHaveValue("A useful title");
      expect(onNavigate).not.toHaveBeenCalled();
      await userEvent.keyboard("{Enter}");
      await expect
        .element(screen.getByRole("textbox", { name: "Chat title" }))
        .not.toBeInTheDocument();
      expect(mocks.rename).toHaveBeenLastCalledWith(
        chat.threadRef,
        "A useful title",
        "Chat fixture",
      );
      expect(mocks.rename).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps cancellation and local drafts free of metadata commands", async () => {
    const { screen } = await setup();
    try {
      await expect
        .element(screen.getByRole("button", { name: "Rename New chat" }))
        .not.toBeInTheDocument();
      await screen.getByRole("button", { name: "Chat fixture", exact: true }).click();
      await userEvent.keyboard("{F2}");
      await expect.element(screen.getByRole("textbox", { name: "Chat title" })).toBeVisible();
      await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
      await screen.getByRole("textbox", { name: "Chat title" }).fill("Unsaved");
      await userEvent.keyboard("{Escape}");
      await expect
        .element(screen.getByRole("textbox", { name: "Chat title" }))
        .not.toBeInTheDocument();
      expect(mocks.rename).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("reveals actions on hover or keyboard focus, not a lingering mouse selection", async () => {
    const { screen } = await setup();
    try {
      const title = screen.getByRole("button", { name: "Chat fixture", exact: true });
      const outside = screen.getByRole("button", { name: "New chat in active tab group" });
      const actions = title.element().closest("li")!.querySelector("[data-desk-row-actions]")!;
      const timestamp = title.element().querySelector("[data-desk-row-meta]")!;
      const titleText = title.element().querySelector("[data-desk-row-title]")!;
      await outside.hover();
      await vi.waitFor(() => {
        expect(getComputedStyle(actions).opacity).toBe("0");
        expect(getComputedStyle(timestamp).opacity).toBe("1");
      });
      expect(timestamp.textContent).toBe("2d ago");
      const idleTitleWidth = titleText.getBoundingClientRect().width;
      await title.click();
      await vi.waitFor(() => {
        expect(getComputedStyle(actions).opacity).toBe("1");
        expect(getComputedStyle(timestamp).opacity).toBe("0");
      });
      expect(titleText.getBoundingClientRect().width).toBe(idleTitleWidth);
      await outside.hover();
      await vi.waitFor(() => {
        expect(getComputedStyle(actions).opacity).toBe("0");
        expect(getComputedStyle(timestamp).opacity).toBe("1");
      });
      await userEvent.keyboard("{Tab}");
      await vi.waitFor(() => {
        expect(getComputedStyle(actions).opacity).toBe("1");
        expect(getComputedStyle(timestamp).opacity).toBe("0");
      });
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Rename Chat fixture");
    } finally {
      await screen.unmount();
    }
  });

  it("saves on blur and does not interpret IME confirmation as submission", async () => {
    const { screen, onNavigate } = await setup();
    try {
      await screen.getByRole("button", { name: "Chat fixture", exact: true }).hover();
      await screen.getByRole("button", { name: "Rename Chat fixture" }).click();
      const input = screen.getByRole("textbox", { name: "Chat title" });
      const element = input.element() as HTMLInputElement;
      expect(element.selectionStart).toBe(0);
      expect(element.selectionEnd).toBe("Chat fixture".length);
      await input.fill("A new title");
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
      );
      expect(mocks.rename).not.toHaveBeenCalled();
      await screen.getByRole("button", { name: "New chat in active tab group" }).click();
      await expect.element(input).not.toBeInTheDocument();
      expect(mocks.rename).toHaveBeenCalledExactlyOnceWith(
        chat.threadRef,
        "A new title",
        "Chat fixture",
      );
      expect(onNavigate).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("submits once when Enter is followed by blur before the response", async () => {
    const { screen } = await setup();
    let resolve!: () => void;
    mocks.rename.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    try {
      await screen.getByRole("button", { name: "Chat fixture", exact: true }).hover();
      await screen.getByRole("button", { name: "Rename Chat fixture" }).click();
      const input = screen.getByRole("textbox", { name: "Chat title" });
      await input.fill("Delayed rename");
      await userEvent.keyboard("{Enter}");
      expect(mocks.rename).toHaveBeenCalledOnce();
      await expect.element(input).toHaveAttribute("readonly");
      const outside = screen.getByRole("button", { name: "New chat in active tab group" });
      await outside.click();
      expect(mocks.rename).toHaveBeenCalledOnce();
      resolve();
      await expect.element(input).not.toBeInTheDocument();
      expect(document.activeElement).toBe(outside.element());
      expect(mocks.rename).toHaveBeenCalledOnce();
    } finally {
      resolve?.();
      await screen.unmount();
    }
  });
});
