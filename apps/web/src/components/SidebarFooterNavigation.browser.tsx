import "../index.css";

import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarFooterNavigation } from "./SidebarFooterNavigation";
import { SidebarProvider } from "./ui/sidebar";

async function renderFooter(input?: { readonly atriumEnabled?: boolean }) {
  const host = document.createElement("div");
  document.body.append(host);
  const onOpenAtrium = vi.fn();
  const onOpenSettings = vi.fn();
  const screen = await render(
    <SidebarProvider defaultOpen>
      <SidebarFooterNavigation
        atriumEnabled={input?.atriumEnabled ?? true}
        atriumOpen={false}
        settingsActive={false}
        onOpenAtrium={onOpenAtrium}
        onOpenSettings={onOpenSettings}
      />
    </SidebarProvider>,
    { container: host },
  );
  return { host, onOpenAtrium, onOpenSettings, screen };
}

describe("SidebarFooterNavigation", () => {
  it("places the unicorn Atrium action immediately above Settings", async () => {
    const { host, onOpenAtrium, onOpenSettings, screen } = await renderFooter();
    try {
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-sidebar="menu-button"]')];
      expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Atrium", "Settings"]);
      expect(buttons[0]?.getAttribute("aria-haspopup")).toBe("dialog");
      expect(buttons[0]?.getAttribute("aria-expanded")).toBe("false");
      expect(
        buttons[0]?.querySelector('[data-cafe-task-atrium-unicorn-icon="true"]'),
      ).not.toBeNull();
      const unicorn = buttons[0]?.querySelector<HTMLImageElement>(
        '[data-cafe-task-atrium-unicorn-icon="true"]',
      );
      expect(unicorn?.getAttribute("data-cafe-task-atrium-unicode-codepoint")).toBe("U+1F984");
      expect(unicorn?.getBoundingClientRect().width).toBeGreaterThanOrEqual(20);
      expect(unicorn?.getBoundingClientRect().height).toBeGreaterThanOrEqual(20);
      expect(unicorn?.complete).toBe(true);
      expect(unicorn?.naturalWidth).toBeGreaterThan(0);
      expect(unicorn?.naturalHeight).toBeGreaterThan(0);

      buttons[0]?.click();
      buttons[1]?.click();
      await vi.waitFor(() => {
        expect(onOpenAtrium).toHaveBeenCalledOnce();
        expect(onOpenSettings).toHaveBeenCalledOnce();
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps only Settings when the Atrium feature is disabled", async () => {
    const { host, screen } = await renderFooter({ atriumEnabled: false });
    try {
      expect(host.querySelector('[data-cafe-task-atrium-sidebar-button="true"]')).toBeNull();
      expect(
        [...host.querySelectorAll<HTMLButtonElement>('[data-sidebar="menu-button"]')].map(
          (button) => button.textContent?.trim(),
        ),
      ).toEqual(["Settings"]);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
