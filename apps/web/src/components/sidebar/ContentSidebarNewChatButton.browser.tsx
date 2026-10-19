import "../../index.css";

import { EnvironmentId } from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  resetWorkspaceEnvironmentForTests,
  selectWorkspaceEnvironment,
} from "../../environments/workspace";
import { selectEnvironmentState, useStore } from "../../store";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { SidebarProvider, SidebarTrigger } from "../ui/sidebar";
import { ContentSidebarNewChatButton } from "./ContentSidebarNewChatButton";
import { ContentSidebarTriggerWithUnreadDot } from "./unseenCompletions";

const fixture = vi.hoisted(() => ({
  createChat: vi.fn<() => Promise<void>>(),
}));
// Only the navigation/submission boundary is inert. The production control,
// selected-environment hook, bootstrap selector and native input stay real.
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => ({ handleNewStandaloneChat: fixture.createChat }),
}));

const selected = EnvironmentId.make("collapsed-controls-selected");
const other = EnvironmentId.make("collapsed-controls-other");
let mounted: Awaited<ReturnType<typeof render>> | undefined;

function seedBootstrap(selectedComplete: boolean, otherComplete = false) {
  const empty = selectEnvironmentState(useStore.getState(), null);
  useStore.setState({
    environmentStateById: {
      [selected]: { ...empty, bootstrapComplete: selectedComplete },
      [other]: { ...empty, bootstrapComplete: otherComplete },
    },
  });
  selectWorkspaceEnvironment(selected);
}

beforeEach(async () => {
  await page.viewport(1100, 800);
  fixture.createChat.mockReset().mockResolvedValue(undefined);
  useThreadSelectionStore.getState().clearSelection();
  seedBootstrap(true);
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  useThreadSelectionStore.getState().clearSelection();
  useStore.setState({ environmentStateById: {} });
  resetWorkspaceEnvironmentForTests();
});

function SurroundingButtons({ collapsedControls = false }: { collapsedControls?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <button type="button">Before content controls</button>
      {collapsedControls ? <ContentSidebarTriggerWithUnreadDot /> : <ContentSidebarNewChatButton />}
      <button type="button">After content controls</button>
      {collapsedControls ? <SidebarTrigger aria-label="Fixture sidebar navigation" /> : null}
    </div>
  );
}

describe("collapsed-sidebar New chat action", () => {
  it("does not borrow another environment's bootstrap or admit disabled keyboard activation", async () => {
    seedBootstrap(false, true);
    mounted = await render(<SurroundingButtons />);
    const action = page.getByRole("button", { name: "New chat", exact: true });
    await expect.element(action).toBeDisabled();
    await page.getByRole("button", { name: "Before content controls", exact: true }).click();
    await userEvent.tab();
    await expect
      .element(page.getByRole("button", { name: "After content controls", exact: true }))
      .toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(fixture.createChat).not.toHaveBeenCalled();

    // The same real hook must react to selecting the environment whose own
    // snapshot is ready; another server's readiness never enables this one.
    selectWorkspaceEnvironment(other);
    await expect.element(action).not.toBeDisabled();
    await action.click();
    expect(fixture.createChat).toHaveBeenCalledOnce();
    selectWorkspaceEnvironment(selected);
    await expect.element(action).toBeDisabled();
    expect(fixture.createChat).toHaveBeenCalledOnce();
  });

  it("delegates each native click and focused keyboard action once and clears selection on completion", async () => {
    useThreadSelectionStore.setState({
      selectedThreadKeys: new Set(["fixture-selected-chat"]),
      anchorThreadKey: "fixture-selected-chat",
    });
    mounted = await render(<SurroundingButtons />);
    const action = page.getByRole("button", { name: "New chat", exact: true });
    await expect.element(action).not.toBeDisabled();
    await action.click();
    expect(fixture.createChat).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
      expect(useThreadSelectionStore.getState().anchorThreadKey).toBeNull();
    });
    await expect.element(action).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(fixture.createChat).toHaveBeenCalledTimes(2);
  });

  it("keeps retained hidden controls inert and reveals New chat immediately after the native reopen toggle", async () => {
    mounted = await render(
      <SidebarProvider defaultOpen>
        <SurroundingButtons collapsedControls />
      </SidebarProvider>,
    );
    const controls = document.querySelector<HTMLElement>('[data-sidebar="content-controls"]')!;
    expect(controls.hidden).toBe(true);
    expect(controls.inert).toBe(true);
    expect(controls.getAttribute("aria-hidden")).toBe("true");
    await page.getByRole("button", { name: "Before content controls", exact: true }).click();
    await userEvent.tab();
    await expect
      .element(page.getByRole("button", { name: "After content controls", exact: true }))
      .toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(fixture.createChat).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Fixture sidebar navigation", exact: true }).click();
    const action = page.getByRole("button", { name: "New chat", exact: true });
    await expect.element(action).toBeVisible();
    expect(controls.hidden).toBe(false);
    expect(controls.inert).toBe(false);
    await page.getByRole("button", { name: "Before content controls", exact: true }).click();
    await userEvent.tab();
    await expect
      .element(page.getByRole("button", { name: "Toggle Sidebar", exact: true }))
      .toHaveFocus();
    await userEvent.tab();
    await expect.element(action).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(fixture.createChat).toHaveBeenCalledOnce();

    // Opening revokes focus/activation immediately even if CSS retains exit
    // paint. Native Tab must skip both controls without waiting for animation.
    await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
    await vi.waitFor(() => {
      expect(controls.hidden).toBe(true);
      expect(controls.inert).toBe(true);
    });
    await page.getByRole("button", { name: "Before content controls", exact: true }).click();
    await userEvent.tab();
    await expect
      .element(page.getByRole("button", { name: "After content controls", exact: true }))
      .toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(fixture.createChat).toHaveBeenCalledOnce();
  });

  it("uses the mobile sheet state rather than the desktop sidebar preference", async () => {
    await page.viewport(390, 800);
    mounted = await render(
      <SidebarProvider defaultOpen>
        <SurroundingButtons collapsedControls />
      </SidebarProvider>,
    );
    const action = page.getByRole("button", { name: "New chat", exact: true });
    await expect.element(action).toBeVisible();
    const button = action.element();
    const controls = document.querySelector<HTMLElement>('[data-sidebar="content-controls"]')!;
    const navigation = page.getByRole("button", {
      name: "Fixture sidebar navigation",
      exact: true,
    });
    await navigation.click();
    // The modal sheet owns mobile visibility independently of the saved
    // desktop preference. Its reopen toggle remains, but creation is hidden.
    expect(controls.hidden).toBe(false);
    await expect.element(button).not.toBeVisible();
    expect(button.parentElement?.inert).toBe(true);
    expect(fixture.createChat).not.toHaveBeenCalled();
    await navigation.click();
    await expect.element(action).toBeVisible();
    await action.click();
    expect(fixture.createChat).toHaveBeenCalledOnce();
  });
});
