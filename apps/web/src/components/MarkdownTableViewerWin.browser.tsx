import "../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

// Electron detection is intentionally module-load based. Isolate this fixture
// from ordinary browser coverage so the real viewer's native titlebar policy
// can be qualified without changing the rest of ChatMarkdown's tests.
vi.mock("../env", () => ({ isElectron: true }));

import { MarkdownTable } from "./MarkdownTableViewer";

describe("Expanded Markdown table native titlebar", () => {
  it.each([
    { platform: "Win32", scale: 80, captionInset: 40 },
    { platform: "Win32", scale: 130, captionInset: 40 },
    { platform: "MacIntel", scale: 100, captionInset: 0 },
    { platform: "Linux x86_64", scale: 100, captionInset: 0 },
  ])(
    "keeps popup, heading and close within the usable window on $platform at $scale%",
    async ({ platform, scale, captionInset }) => {
      const root = document.documentElement;
      const originalWco = root.classList.contains("wco");
      const originalFontSize = root.style.fontSize;
      const originalViewport = { width: window.innerWidth, height: window.innerHeight };
      const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const safeInsets = [
        ["--markdown-table-safe-top", "28px"],
        ["--markdown-table-safe-right", "22px"],
        ["--markdown-table-safe-bottom", "20px"],
        ["--markdown-table-safe-left", "24px"],
      ] as const;
      const originalInsets = safeInsets.map(([property]) => root.style.getPropertyValue(property));
      for (const [property, value] of safeInsets) root.style.setProperty(property, value);
      root.classList.add("wco");
      root.style.fontSize = `${scale}%`;
      await page.viewport(640, 320);
      const screen = await render(
        <div className="chat-markdown" style={{ width: 320 }}>
          <MarkdownTable>
            <thead>
              <tr>
                <th>App</th>
                <th>Tradeoff</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Jamie</td>
                <td>{"Long table detail ".repeat(40)}</td>
              </tr>
            </tbody>
          </MarkdownTable>
        </div>,
      );
      try {
        await page.getByRole("button", { name: "Expand table" }).click();
        const dialog = page.getByRole("dialog", { name: "Expanded table" });
        await expect.element(dialog).toBeVisible();
        const popup = dialog.element();
        const heading = popup.querySelector<HTMLElement>(".markdown-table-expanded-heading");
        const close = popup.querySelector<HTMLElement>('[aria-label="Close"]');
        const viewport = popup.querySelector<HTMLElement>(".markdown-table-expanded-viewport");
        expect(heading).not.toBeNull();
        expect(close).not.toBeNull();
        expect(viewport).not.toBeNull();
        expect(popup.classList.contains("markdown-table-native-titlebar")).toBe(captionInset > 0);
        await vi.waitFor(() => {
          const bounds = popup.getBoundingClientRect();
          const usableTop = 28 + captionInset;
          expect(bounds.left).toBeGreaterThanOrEqual(24);
          expect(bounds.right).toBeLessThanOrEqual(window.innerWidth - 22 + 1);
          expect(bounds.top).toBeGreaterThanOrEqual(usableTop);
          expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 20 + 1);
          expect(heading!.getBoundingClientRect().top).toBeGreaterThanOrEqual(usableTop);
          expect(close!.getBoundingClientRect().top).toBeGreaterThanOrEqual(usableTop);
          expect(close!.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom);
          expect(viewport!.clientHeight).toBeGreaterThan(0);
        });
        expect(getComputedStyle(popup).getPropertyValue("-webkit-app-region")).toBe("no-drag");
      } finally {
        await screen.unmount();
        root.classList.toggle("wco", originalWco);
        root.style.fontSize = originalFontSize;
        safeInsets.forEach(([property], index) => {
          const original = originalInsets[index];
          if (original) root.style.setProperty(property, original);
          else root.style.removeProperty(property);
        });
        platformSpy.mockRestore();
        await page.viewport(originalViewport.width, originalViewport.height);
      }
    },
  );
});
