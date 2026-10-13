import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { applyInterfaceScalePercent } from "../../interfaceScale";

// Keep Electron detection in its own module graph; ordinary browser fixtures
// must retain real browser admission rather than inheriting this native flag.
vi.mock("../../env", () => ({ isElectron: true }));

import { ExpandedImageDialog } from "./ExpandedImageDialog";

afterEach(() => {
  applyInterfaceScalePercent(100);
  vi.restoreAllMocks();
});

describe("expanded image native titlebar", () => {
  it.each([
    { platform: "Win32", scale: 80, wco: true, inset: 40 },
    { platform: "Win32", scale: 130, wco: true, inset: 40 },
    { platform: "Win32", scale: 130, wco: false, inset: 0 },
    { platform: "MacIntel", scale: 130, wco: true, inset: 0 },
    { platform: "Linux x86_64", scale: 130, wco: true, inset: 0 },
  ])(
    "keeps controls usable on $platform at $scale% (overlay: $wco)",
    async ({ platform, scale, wco, inset }) => {
      await page.viewport(390, 320);
      applyInterfaceScalePercent(scale);
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const root = document.documentElement;
      const previousWco = root.classList.contains("wco");
      root.classList.toggle("wco", wco);
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="100%" height="100%" fill="#888"/></svg>';
      const view = await render(
        <ExpandedImageDialog
          preview={{
            images: [
              { src: `data:image/svg+xml,${encodeURIComponent(svg)}`, name: "portrait.png" },
            ],
            index: 0,
          }}
          onClose={vi.fn()}
        />,
      );
      try {
        await expect
          .element(page.getByRole("button", { name: "Original size", exact: true }))
          .toBeEnabled();
        const dialog = page
          .getByRole("dialog", { name: "Expanded image preview", exact: true })
          .element();
        const toolbar = page
          .getByRole("group", { name: "Image zoom controls", exact: true })
          .element();
        const img = page.getByRole("img", { name: "portrait.png", exact: true }).element();
        await vi.waitFor(() => {
          expect(parseFloat(getComputedStyle(dialog).paddingTop)).toBeCloseTo(
            inset + (16 * scale) / 100,
            1,
          );
          expect(toolbar.getBoundingClientRect().top).toBeGreaterThan(inset);
          expect(img.getBoundingClientRect().top).toBeGreaterThan(inset);
          expect(img.getBoundingClientRect().bottom).toBeLessThan(window.innerHeight);
          for (const button of toolbar.querySelectorAll("button")) {
            const bounds = button.getBoundingClientRect();
            expect(bounds.left).toBeGreaterThan(0);
            expect(bounds.right).toBeLessThan(window.innerWidth);
            expect(bounds.top).toBeGreaterThan(inset);
            expect(bounds.bottom).toBeLessThan(window.innerHeight);
          }
        });
        expect(getComputedStyle(dialog).getPropertyValue("-webkit-app-region")).toBe("no-drag");
      } finally {
        await view.unmount();
        root.classList.toggle("wco", previousWco);
      }
    },
  );
});
