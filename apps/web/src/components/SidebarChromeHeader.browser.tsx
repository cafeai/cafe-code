import "../index.css";

import type { CSSProperties } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

vi.mock("../env", () => ({ isElectron: true }));
const actions = vi.hoisted(() => ({ newChat: vi.fn(async () => {}) }));
vi.mock("./sidebar/ContentSidebarNewChatButton", async () => {
  const { SidebarNewChatButton } = await import("./sidebar/SidebarNewChatButton");
  return {
    // Keep native button and sidebar behavior without borrowing router,
    // bootstrap or draft ownership for this isolated chrome fixture.
    ContentSidebarNewChatButton: () => <SidebarNewChatButton onClick={actions.newChat} />,
  };
});

import { APP_STAGE_LABEL } from "../branding";
import { useMacDesktopTitlebar } from "../hooks/useMacDesktopTitlebar";
import { applyInterfaceScalePercent } from "../interfaceScale";
import { SidebarChromeHeader } from "./Sidebar";
import { ContentSidebarTriggerWithUnreadDot } from "./sidebar/unseenCompletions";
import { Sidebar, SidebarProvider } from "./ui/sidebar";

beforeEach(async () => {
  actions.newChat.mockClear();
  applyInterfaceScalePercent(100);
  await page.viewport(1100, 800);
});
afterEach(() => {
  applyInterfaceScalePercent(100);
  vi.restoreAllMocks();
});

function headerFixture(width: number) {
  return (
    <SidebarProvider defaultOpen style={{ "--sidebar-width": `${width}px` } as CSSProperties}>
      <Sidebar collapsible="offcanvas">
        <SidebarChromeHeader isElectron />
      </Sidebar>
    </SidebarProvider>
  );
}

function TransitionContentHeader() {
  return (
    <header
      className="drag-region flex h-[52px] items-center border-b border-border px-5"
      data-mac-titlebar={useMacDesktopTitlebar()}
      data-testid="transition-content-header"
    >
      <ContentSidebarTriggerWithUnreadDot />
    </header>
  );
}

describe("desktop sidebar header", () => {
  it.each([100])(
    "retains mounted chrome and the accessible hide/reopen escape hatch at %s%%",
    async (scale) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      applyInterfaceScalePercent(scale);
      const host = document.createElement("div");
      document.body.append(host);
      const screen = await render(
        <SidebarProvider defaultOpen style={{ "--sidebar-width": "320px" } as CSSProperties}>
          <Sidebar collapsible="offcanvas">
            <SidebarChromeHeader isElectron />
          </Sidebar>
          <main className="min-w-0 flex-1">
            <TransitionContentHeader />
            <button type="button">After content controls</button>
          </main>
        </SidebarProvider>,
        { container: host },
      );
      try {
        const sidebar = host.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
        const container = host.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
        const gap = host.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!;
        const wordmark = container.querySelector('[aria-label="Cafe Code"]')!;
        const contentHeader = host.querySelector<HTMLElement>(
          '[data-testid="transition-content-header"]',
        )!;
        const controls = contentHeader.querySelector<HTMLElement>(
          '[data-sidebar="content-controls"]',
        )!;
        expect(controls.hidden).toBe(true);
        expect(controls.inert).toBe(true);
        expect(controls.getAttribute("aria-hidden")).toBe("true");

        await screen.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
        await vi.waitFor(() => {
          expect(sidebar.dataset.state).toBe("collapsed");
          expect(controls.hidden).toBe(false);
          expect(controls.inert).toBe(false);
        });
        // Navigation chrome survives closing, while its content counterpart
        // becomes an immediately usable native control group.
        expect(container.isConnected).toBe(true);
        expect(container.querySelector('[aria-label="Cafe Code"]')).toBe(wordmark);
        const reopen = contentHeader.querySelector<HTMLButtonElement>('[data-sidebar="trigger"]')!;
        const newChat = screen
          .getByTestId("transition-content-header")
          .getByRole("button", { name: "New chat", exact: true });
        await expect.element(newChat).toBeVisible();
        await vi.waitFor(() => {
          // Observe the existing transition's settled geometry; do not add a
          // separate sleep, deadline, or wider retry budget to qualify it.
          expect(gap.getBoundingClientRect().width).toBe(0);
          expect(container.getBoundingClientRect().right).toBe(0);
          expect(contentHeader.getBoundingClientRect().left).toBe(0);
          const newChatBounds = newChat.element().getBoundingClientRect();
          expect(newChatBounds.left).toBeGreaterThanOrEqual(reopen.getBoundingClientRect().right);
          expect(newChatBounds.right).toBeLessThanOrEqual(
            contentHeader.getBoundingClientRect().right,
          );
        });
        expect(getComputedStyle(reopen).getPropertyValue("-webkit-app-region")).toBe("no-drag");
        expect(getComputedStyle(newChat.element()).getPropertyValue("-webkit-app-region")).toBe(
          "no-drag",
        );
        await newChat.click();
        expect(actions.newChat).toHaveBeenCalledOnce();
        // Shift-Tab from the following native sentinel reaches the final
        // content action without assigning focus or replaying input.
        await screen.getByRole("button", { name: "After content controls", exact: true }).click();
        await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
        await expect.element(newChat).toHaveFocus();
        await userEvent.keyboard("{Enter}");
        expect(actions.newChat).toHaveBeenCalledTimes(2);
        await screen
          .getByTestId("transition-content-header")
          .getByRole("button", { name: "Toggle Sidebar", exact: true })
          .click();
        await vi.waitFor(() => {
          expect(sidebar.dataset.state).toBe("expanded");
          expect(controls.hidden).toBe(true);
          expect(controls.inert).toBe(true);
          expect(controls.getAttribute("aria-hidden")).toBe("true");
          expect(container.getBoundingClientRect().left).toBe(0);
          expect(gap.getBoundingClientRect().width).toBe(320);
        });
        await screen.getByRole("button", { name: "After content controls", exact: true }).click();
        await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
        await vi.waitFor(() => {
          expect(document.activeElement).toBe(container.querySelector('[data-sidebar="trigger"]'));
          expect(controls.contains(document.activeElement)).toBe(false);
        });
        expect(actions.newChat).toHaveBeenCalledTimes(2);
        expect(container.querySelector('[aria-label="Cafe Code"]')).toBe(wordmark);
      } finally {
        await screen.unmount();
        host.remove();
      }
    },
  );

  it.each([100])(
    "anchors the Mac toggle during resizing at %s%% without overlapping the wordmark",
    async (scale) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      applyInterfaceScalePercent(scale);
      const host = document.createElement("div");
      document.body.append(host);
      const screen = await render(headerFixture(320), { container: host });
      try {
        const positions: number[] = [];
        for (const width of [320, 440, 208]) {
          await screen.rerender(headerFixture(width));
          await vi.waitFor(() => {
            const header = host.querySelector<HTMLElement>('[data-slot="sidebar-header"]')!;
            const toggle = header.querySelector<HTMLButtonElement>('[data-sidebar="trigger"]')!;
            const wordmark = header.querySelector<HTMLElement>('[aria-label="Cafe Code"]')!;
            const headerBounds = header.getBoundingClientRect();
            const toggleBounds = toggle.getBoundingClientRect();
            const brandBounds = wordmark.getBoundingClientRect();
            const sidebarBounds = host
              .querySelector('[data-slot="sidebar-container"]')!
              .getBoundingClientRect();
            // Width transitions can enter the target's rounding bucket before
            // finishing. Wait for the exact requested width before recording an
            // exact toggle position; rounding here races the assertion below.
            expect(sidebarBounds.width).toBe(width);
            // Native traffic-light geometry stays in CSS pixels, while the
            // right-side spacing and controls retain the user's rem scale.
            expect(header.getAttribute("data-mac-titlebar")).toBe("true");
            expect(headerBounds.height).toBe(50);
            expect(brandBounds.left).toBeGreaterThanOrEqual(headerBounds.left + 90);
            expect(brandBounds.right).toBeLessThanOrEqual(
              toggleBounds.left - (8 * scale) / 100 + 0.1,
            );
            expect(toggleBounds.top).toBeGreaterThan(headerBounds.top + 3);
            expect(toggleBounds.bottom).toBeLessThan(headerBounds.bottom - 3);
            expect(getComputedStyle(toggle).getPropertyValue("-webkit-app-region")).toBe("no-drag");
          });
          positions.push(
            host.querySelector('[data-sidebar="trigger"]')!.getBoundingClientRect().right,
          );
        }
        expect(positions[1]! - positions[0]!).toBe(120);
        const badge = [...host.querySelectorAll<HTMLElement>("span")].find(
          (element) => element.textContent?.trim() === APP_STAGE_LABEL,
        )!;
        expect(getComputedStyle(badge).display).toBe("none");
        await screen.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
        expect(host.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe(
          "collapsed",
        );
      } finally {
        await screen.unmount();
        host.remove();
      }
    },
  );

  it.each(["Win32", "Linux x86_64"])(
    "keeps the existing leading toggle on %s",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const host = document.createElement("div");
      document.body.append(host);
      const screen = await render(headerFixture(320), { container: host });
      try {
        const toggle = host.querySelector('[data-sidebar="trigger"]')!;
        const wordmark = host.querySelector('[aria-label="Cafe Code"]')!;
        expect(
          host.querySelector('[data-slot="sidebar-header"]')?.getAttribute("data-mac-titlebar"),
        ).not.toBe("true");
        expect(toggle.getBoundingClientRect().right).toBeLessThan(
          wordmark.getBoundingClientRect().left,
        );
      } finally {
        await screen.unmount();
        host.remove();
      }
    },
  );
});
