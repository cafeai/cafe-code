import "../index.css";

import type { CSSProperties } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { APP_STAGE_LABEL } from "../branding";
import { SidebarChromeHeader } from "./Sidebar";
import { Sidebar, SidebarProvider } from "./ui/sidebar";

beforeEach(async () => {
  await page.viewport(1100, 800);
});
afterEach(() => vi.restoreAllMocks());

function headerFixture(width: number) {
  return (
    <SidebarProvider defaultOpen style={{ "--sidebar-width": `${width}px` } as CSSProperties}>
      <Sidebar collapsible="offcanvas">
        <SidebarChromeHeader isElectron />
      </Sidebar>
    </SidebarProvider>
  );
}

describe("desktop sidebar header", () => {
  it("anchors the Mac toggle to the trailing edge during resizing without overlapping the wordmark", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
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
          expect(Math.round(sidebarBounds.width)).toBe(width);
          expect(Math.round(headerBounds.right - toggleBounds.right)).toBe(16);
          expect(brandBounds.left).toBeGreaterThanOrEqual(headerBounds.left + 90);
          expect(brandBounds.right).toBeLessThanOrEqual(toggleBounds.left - 8);
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
  });

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
