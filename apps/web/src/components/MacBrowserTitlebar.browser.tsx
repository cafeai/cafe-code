import "../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

// Electron identity is sampled when its module loads. Keep this browser-only
// fixture separate from the desktop fixture rather than mutating an export
// after the hook has already imported the preload-host decision.
vi.mock("../env", () => ({ isElectron: false }));
vi.mock("../environments/workspaceData", () => ({ useWorkspaceSidebarThreads: () => [] }));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (
    select: (state: { threadLastVisitedAtById: Record<string, string> }) => unknown,
  ) => select({ threadLastVisitedAtById: {} }),
}));

import { useMacDesktopTitlebar } from "../hooks/useMacDesktopTitlebar";
import { applyInterfaceScalePercent } from "../interfaceScale";
import { ContentSidebarTriggerWithUnreadDot } from "./sidebar/unseenCompletions";
import { SidebarProvider } from "./ui/sidebar";

function OrdinaryBrowserHeader() {
  return (
    <header
      className="flex h-[52px] items-center border-b border-border px-5"
      data-mac-titlebar={useMacDesktopTitlebar()}
    >
      <ContentSidebarTriggerWithUnreadDot />
    </header>
  );
}

beforeEach(async () => {
  applyInterfaceScalePercent(100);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  await page.viewport(1100, 800);
});
afterEach(() => {
  applyInterfaceScalePercent(100);
  vi.restoreAllMocks();
});

describe("ordinary macOS browser titlebar gate", () => {
  it.each([80, 100, 130])(
    "preserves parent padding at %s%% without native clearance",
    async (scale) => {
      applyInterfaceScalePercent(scale);
      const host = document.createElement("div");
      document.body.append(host);
      const screen = await render(
        <SidebarProvider defaultOpen={false}>
          <div className="w-full">
            <OrdinaryBrowserHeader />
          </div>
        </SidebarProvider>,
        { container: host },
      );
      try {
        const header = host.querySelector<HTMLElement>("header")!;
        const trigger = header.querySelector('[data-sidebar="trigger"]')!;
        expect(header.dataset.macTitlebar).toBe("false");
        expect(header.getBoundingClientRect().height).toBe(52);
        expect(
          trigger.getBoundingClientRect().left - header.getBoundingClientRect().left,
        ).toBeCloseTo((20 * scale) / 100, 1);
        await expect
          .element(screen.getByRole("button", { name: "Toggle Sidebar", exact: true }))
          .toBeVisible();
      } finally {
        await screen.unmount();
        host.remove();
      }
    },
  );
});
