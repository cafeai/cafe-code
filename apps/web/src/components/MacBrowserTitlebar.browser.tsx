import "../index.css";

import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@cafecode/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

// Electron identity is sampled when its module loads. Keep this browser-only
// fixture separate from the desktop fixture rather than mutating an export
// after the hook has already imported the preload-host decision.
vi.mock("../env", () => ({ isElectron: false }));
vi.mock("../rpc/serverState", () => ({ useServerConfig: () => null }));
vi.mock("../hooks/useSettings", () => ({
  useSettings: (select: (settings: UnifiedSettings) => unknown) => select(DEFAULT_UNIFIED_SETTINGS),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: "dark", setTheme: vi.fn() }) }));
vi.mock("../localApi", () => ({ ensureLocalApi: vi.fn() }));
vi.mock("../environments/workspaceData", () => ({ useWorkspaceSidebarThreads: () => [] }));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (
    select: (state: { threadLastVisitedAtById: Record<string, string> }) => unknown,
  ) => select({ threadLastVisitedAtById: {} }),
}));

import { useMacDesktopTitlebar } from "../hooks/useMacDesktopTitlebar";
import { applyInterfaceScalePercent } from "../interfaceScale";
import { OnboardingScreen } from "./OnboardingScreen";
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
  it.each([100])("keeps onboarding's ordinary browser header at %s%%", async (scale) => {
    applyInterfaceScalePercent(scale);
    const screen = await render(<OnboardingScreen />);
    try {
      const header = document.querySelector("[data-testid='onboarding-screen'] header")!;
      expect(header.getAttribute("data-mac-titlebar")).toBe("false");
      await expect.element(screen.getByRole("button", { name: "Skip", exact: true })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it.each([100])("preserves parent padding at %s%% without native clearance", async (scale) => {
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
      await expect
        .element(screen.getByRole("button", { name: "Toggle Sidebar", exact: true }))
        .toBeVisible();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
