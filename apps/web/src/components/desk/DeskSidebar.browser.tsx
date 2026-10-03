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

const mocks = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock("../../threadRename", () => ({ renameThread: mocks.rename }));
// Canonical summary rendering is independent of the layout. The row must pass
// its full route target to navigation and its scoped identity to metadata
// actions; it must never infer either identity from its display title.
vi.mock("./useDeskTabMetadata", () => ({
  useDeskTabMetadata: (target: ThreadRouteTarget) => ({
    title: target.kind === "draft" ? "New chat" : `Chat ${target.threadRef.environmentId}`,
    projectName: "Fixture project",
    activityAt: new Date(Date.now() - (2 * 24 * 60 + 5) * 60_000).toISOString(),
    threadRef: target.kind === "server" ? target.threadRef : null,
    exists: true,
    working: false,
    attention: false,
    status: null,
  }),
}));

const environmentId = EnvironmentId.make("fixture");
const chat: ThreadRouteTarget = {
  kind: "server",
  threadRef: { environmentId, threadId: ThreadId.make("chat-1") },
};
const draft: ThreadRouteTarget = { kind: "draft", draftId: "draft-1" as DraftId };

beforeEach(async () => {
  await page.viewport(1100, 800);
  useDeskStore.setState({ desk: createDeskState(environmentId) });
  mocks.rename.mockReset();
  mocks.rename.mockResolvedValue(undefined);
});
afterEach(() => {
  useDeskStore.setState({ desk: createDeskState() });
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

describe("Desk sidebar", () => {
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
