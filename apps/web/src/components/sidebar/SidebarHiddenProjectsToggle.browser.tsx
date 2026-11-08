import "../../index.css";

import { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { SidebarThreadSummary } from "../../types";
import { SidebarMenu, SidebarProvider } from "../ui/sidebar";
import { SidebarHiddenProjectsToggle } from "./SidebarHiddenProjectsToggle";

const environmentId = EnvironmentId.make("hidden-projects-fixture");
const idle: SidebarThreadSummary = {
  environmentId,
  id: ThreadId.make("idle-chat"),
  projectId: null,
  title: "Idle chat",
  interactionMode: "default",
  session: null,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
  archivedAt: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
const waiting: SidebarThreadSummary = {
  ...idle,
  id: ThreadId.make("waiting-chat"),
  title: "Waiting chat",
  hasPendingApprovals: true,
};

async function renderToggle(open: boolean, threads: readonly SidebarThreadSummary[]) {
  const onToggle = vi.fn();
  const screen = await render(
    <SidebarProvider>
      <div className="w-72">
        <SidebarMenu>
          <SidebarHiddenProjectsToggle
            hiddenCount={2}
            open={open}
            threads={threads}
            onToggle={onToggle}
          />
        </SidebarMenu>
      </div>
    </SidebarProvider>,
  );
  return { screen, onToggle };
}

describe("Hidden projects group header", () => {
  it("surfaces a hidden project's waiting chat while collapsed and toggles on click", async () => {
    const { screen, onToggle } = await renderToggle(false, [idle, waiting]);
    try {
      const toggle = screen.getByTestId("sidebar-hidden-projects-toggle");
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
      const summary = screen.getByTestId("sidebar-hidden-projects-summary");
      await expect.element(summary).toHaveAttribute("data-status", "Pending Approval");
      await expect.element(summary).toHaveTextContent("1 needs approval");
      // Label, then the hidden-project count, then the summary.
      expect(toggle.element().textContent).toBe("Hidden21 needs approval");
      await toggle.click();
      expect(onToggle).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("drops the summary once open, where each project shows its own state", async () => {
    const { screen } = await renderToggle(true, [waiting]);
    try {
      await expect
        .element(screen.getByTestId("sidebar-hidden-projects-toggle"))
        .toHaveAttribute("aria-expanded", "true");
      await expect
        .element(screen.getByTestId("sidebar-hidden-projects-summary"))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
