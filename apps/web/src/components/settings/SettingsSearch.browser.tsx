import "../../index.css";

import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => ({
  pathname: "/settings/general",
  /** False simulates a narrow window's sidebar sheet unmounting on close. */
  showNav: true,
  listeners: new Set<() => void>(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
  useCanGoBack: () => true,
}));

import { SidebarProvider } from "../ui/sidebar";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE } from "./settingsSearchLanding";
import { useSettingsSearchFocusStore } from "./settingsSearchStore";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

function useFixture<T>(read: () => T): T {
  return useSyncExternalStore((listener) => {
    fixture.listeners.add(listener);
    return () => fixture.listeners.delete(listener);
  }, read);
}

function notify() {
  for (const listener of fixture.listeners) listener();
}

/** Synthetic pages: only the anchors and controls matter to the search. */
function Page({ pathname }: { pathname: string }) {
  if (pathname !== "/settings/appearance") {
    return (
      <SettingsPageContainer title="General">
        <SettingsSection title="Language & time">
          <SettingsRow searchId="general.timeFormat" title="Time format" />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer title="Appearance">
      <SettingsSection title="Interface">
        <SettingsRow
          searchId="appearance.accentColor"
          title="Accent color"
          control={<button type="button">Accent picker</button>}
        />
      </SettingsSection>
      {/* Pushes the next row below the fold so opening it must scroll. */}
      <div style={{ height: 1600 }} />
      <SettingsSection title="Sidebar">
        <SettingsRow
          searchId="appearance.sidebarEffectsColor"
          title="Sidebar effects color"
          control={<button type="button">Effects picker</button>}
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function Harness() {
  const pathname = useFixture(() => fixture.pathname);
  const showNav = useFixture(() => fixture.showNav);
  return (
    <SidebarProvider defaultOpen>
      <div style={{ display: "flex", width: "100vw", height: "100vh" }}>
        <nav style={{ width: 256, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {showNav ? <SettingsSidebarNav pathname={pathname} /> : null}
        </nav>
        <main style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <Page pathname={pathname} />
        </main>
      </div>
    </SidebarProvider>
  );
}

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(<Harness />, { container: host });
  return {
    async cleanup() {
      await screen.unmount();
      host.remove();
    },
  };
}

const searchInput = () => page.getByRole("combobox", { name: "Search settings" });
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const effectsRow = () =>
  document.querySelector<HTMLElement>('[data-settings-search-id="appearance.sidebarEffectsColor"]');
const optionTitles = () =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) =>
    option.querySelector("span > span")?.textContent?.trim(),
  );

beforeEach(async () => {
  await page.viewport(1280, 800);
  fixture.pathname = "/settings/general";
  fixture.showNav = true;
  fixture.navigate.mockReset();
  fixture.navigate.mockImplementation(async ({ to }: { to: string }) => {
    fixture.pathname = to;
    notify();
  });
  useSettingsSearchFocusStore.setState({ request: 0, pending: false });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Settings search", () => {
  it("filters as you type, moves with the arrow keys and opens the chosen setting", async () => {
    const app = await mount();
    try {
      expect(page.getByRole("button", { name: "Keybindings" }).element()).toBeTruthy();
      await searchInput().fill("color");

      await vi.waitFor(() => {
        expect(optionTitles().slice(0, 2)).toEqual(["Accent color", "Sidebar effects color"]);
      });
      // Results replace the menu while a query is present.
      expect(
        document.querySelector('[data-slot="sidebar-content"] [data-sidebar="menu-button"]'),
      ).toBeNull();
      expect(options()[0]?.getAttribute("aria-selected")).toBe("true");

      await userEvent.keyboard("{ArrowDown}");
      const input = searchInput().element() as HTMLInputElement;
      await vi.waitFor(() => {
        expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
        expect(input.getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
      });

      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => {
        expect(fixture.navigate).toHaveBeenCalledWith({
          to: "/settings/appearance",
          replace: true,
        });
      });
      await vi.waitFor(() => {
        expect(effectsRow()?.hasAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE)).toBe(true);
        expect(document.activeElement?.textContent).toBe("Effects picker");
      });
      // The row was scrolled into the visible part of the page.
      await vi.waitFor(() => {
        const rect = effectsRow()!.getBoundingClientRect();
        expect(rect.top).toBeGreaterThanOrEqual(0);
        expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
      });
      // The search stays open with the opened result marked.
      expect(input.value).toBe("color");
      expect(options()[1]?.getAttribute("aria-current")).toBe("page");

      // Interacting with the page ends the highlight early.
      await page.getByRole("button", { name: "Accent picker" }).click();
      await vi.waitFor(() => {
        expect(effectsRow()?.hasAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE)).toBe(false);
      });
    } finally {
      await app.cleanup();
    }
  });

  it("still reveals the setting when the sidebar unmounts as the result opens", async () => {
    const app = await mount();
    try {
      await searchInput().fill("sidebar effects");
      fixture.navigate.mockImplementation(async ({ to }: { to: string }) => {
        fixture.pathname = to;
        fixture.showNav = false;
        notify();
      });
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => {
        expect(document.querySelector("[data-settings-search-input]")).toBeNull();
        expect(effectsRow()?.hasAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE)).toBe(true);
        expect(document.activeElement?.textContent).toBe("Effects picker");
      });
    } finally {
      await app.cleanup();
    }
  });

  it("opens a result with the pointer", async () => {
    const app = await mount();
    try {
      await searchInput().fill("accent");
      await page.getByRole("option", { name: /Accent color/ }).click();
      await vi.waitFor(() => {
        expect(fixture.navigate).toHaveBeenCalledWith({
          to: "/settings/appearance",
          replace: true,
        });
        expect(
          document
            .querySelector('[data-settings-search-id="appearance.accentColor"]')
            ?.hasAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE),
        ).toBe(true);
      });
    } finally {
      await app.cleanup();
    }
  });

  it("shows the synonym that matched and an empty state", async () => {
    const app = await mount();
    try {
      await searchInput().fill("zoom");
      await vi.waitFor(() => {
        const option = document.querySelector<HTMLElement>('[role="option"]');
        expect(option?.textContent).toContain("Interface size");
        expect(option?.textContent).toContain("zoom");
      });
      await searchInput().fill("qqqq");
      await vi.waitFor(() => {
        expect(document.querySelector('[role="status"]')?.textContent).toBe(
          "No settings match “qqqq”",
        );
      });
      expect(document.querySelector('[role="option"]')).toBeNull();
    } finally {
      await app.cleanup();
    }
  });

  it("clears with Escape, then releases the field without leaving Settings", async () => {
    const app = await mount();
    const escapes: boolean[] = [];
    const recordEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") escapes.push(event.defaultPrevented);
    };
    window.addEventListener("keydown", recordEscape);
    try {
      await searchInput().fill("theme");
      const input = searchInput().element() as HTMLInputElement;
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(input.value).toBe("");
        expect(page.getByRole("button", { name: "Keybindings" }).element()).toBeTruthy();
      });
      expect(document.activeElement).toBe(input);

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(document.activeElement).not.toBe(input));
      // Both presses were consumed, so the layout's Escape (leave Settings) did not run.
      expect(escapes).toEqual([true, true]);
    } finally {
      window.removeEventListener("keydown", recordEscape);
      await app.cleanup();
    }
  });

  it("focuses and selects the field for a focus request, including one made before mount", async () => {
    useSettingsSearchFocusStore.getState().requestFocus();
    const app = await mount();
    try {
      const input = searchInput().element() as HTMLInputElement;
      await vi.waitFor(() => expect(document.activeElement).toBe(input));

      await searchInput().fill("tabs");
      input.blur();
      useSettingsSearchFocusStore.getState().requestFocus();
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(4);
      });
    } finally {
      await app.cleanup();
    }
  });
});
