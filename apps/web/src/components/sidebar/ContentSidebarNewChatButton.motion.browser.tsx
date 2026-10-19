import "../../index.css";

import { EnvironmentId } from "@cafecode/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  resetWorkspaceEnvironmentForTests,
  selectWorkspaceEnvironment,
} from "../../environments/workspace";
import { selectEnvironmentState, useStore } from "../../store";
import { SidebarProvider } from "../ui/sidebar";
import { ContentSidebarTriggerWithUnreadDot } from "./unseenCompletions";

const fixture = vi.hoisted(() => ({
  createChat: vi.fn<() => Promise<void>>(),
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => ({ handleNewStandaloneChat: fixture.createChat }),
}));

let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  useStore.setState({ environmentStateById: {} });
  resetWorkspaceEnvironmentForTests();
});

// The existing browser project owns this native preference. Never mutate media
// on an ordinary desktop page or sample transient animation frames/positions.
it("retains keyboard creation and hidden-state safety under native reduced motion", async () => {
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  await page.viewport(1100, 800);
  fixture.createChat.mockReset().mockResolvedValue(undefined);
  const environmentId = EnvironmentId.make("collapsed-controls-reduced-motion");
  const empty = selectEnvironmentState(useStore.getState(), null);
  useStore.setState({
    environmentStateById: { [environmentId]: { ...empty, bootstrapComplete: true } },
  });
  selectWorkspaceEnvironment(environmentId);
  mounted = await render(
    <SidebarProvider defaultOpen={false}>
      <div className="flex items-center gap-2">
        <button type="button">Before reduced-motion controls</button>
        <ContentSidebarTriggerWithUnreadDot />
        <button type="button">After reduced-motion controls</button>
      </div>
    </SidebarProvider>,
  );
  const action = page.getByRole("button", { name: "New chat", exact: true });
  await expect.element(action).toBeVisible();
  await page.getByRole("button", { name: "Before reduced-motion controls", exact: true }).click();
  await userEvent.tab();
  const toggle = page.getByRole("button", { name: "Toggle Sidebar", exact: true });
  await expect.element(toggle).toHaveFocus();
  await userEvent.tab();
  await expect.element(action).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(fixture.createChat).toHaveBeenCalledOnce();

  await toggle.click();
  const controls = document.querySelector<HTMLElement>('[data-sidebar="content-controls"]')!;
  await vi.waitFor(() => {
    expect(controls.hidden).toBe(true);
    expect(controls.inert).toBe(true);
  });
  await page.getByRole("button", { name: "Before reduced-motion controls", exact: true }).click();
  await userEvent.tab();
  await expect
    .element(page.getByRole("button", { name: "After reduced-motion controls", exact: true }))
    .toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(fixture.createChat).toHaveBeenCalledOnce();
});
