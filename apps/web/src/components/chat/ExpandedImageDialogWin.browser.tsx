import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { applyInterfaceScalePercent } from "../../interfaceScale";
import { MAC_TRAFFIC_LIGHTS_CLASS_NAME } from "../../lib/macTrafficLights";

// Keep Electron detection in its own module graph; ordinary browser fixtures
// must retain real browser admission rather than inheriting this native flag.
vi.mock("../../env", () => ({ isElectron: true }));

import { ExpandedImageDialog } from "./ExpandedImageDialog";

afterEach(() => {
  applyInterfaceScalePercent(100);
  vi.restoreAllMocks();
});

describe("expanded image native titlebar", () => {
  // `inset` is the native band controls must clear: Windows' 40px caption
  // fallback (added to the 1rem padding) or macOS' fixed 50px traffic-light
  // band (which replaces the top padding).
  it.each([
    { platform: "Win32", scale: 80, wco: true, inset: 40, paddingTop: 40 + 12.8 },
    { platform: "Win32", scale: 130, wco: true, inset: 40, paddingTop: 40 + 20.8 },
    { platform: "Win32", scale: 130, wco: false, inset: 0, paddingTop: 20.8 },
    { platform: "MacIntel", scale: 80, wco: false, inset: 50, paddingTop: 50 },
    { platform: "MacIntel", scale: 130, wco: false, inset: 50, paddingTop: 50 },
    { platform: "Linux x86_64", scale: 130, wco: true, inset: 0, paddingTop: 20.8 },
  ])(
    "keeps controls usable on $platform at $scale% (overlay: $wco)",
    async ({ platform, scale, wco, inset, paddingTop }) => {
      await page.viewport(390, 320);
      applyInterfaceScalePercent(scale);
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const root = document.documentElement;
      const previousWco = root.classList.contains("wco");
      const previousMacTrafficLights = root.classList.contains(MAC_TRAFFIC_LIGHTS_CLASS_NAME);
      root.classList.toggle("wco", wco);
      // main.tsx sets this root class for ordinary macOS Electron windows.
      root.classList.toggle(MAC_TRAFFIC_LIGHTS_CLASS_NAME, platform === "MacIntel");
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
          expect(parseFloat(getComputedStyle(dialog).paddingTop)).toBeCloseTo(paddingTop, 1);
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
        root.classList.toggle(MAC_TRAFFIC_LIGHTS_CLASS_NAME, previousMacTrafficLights);
      }
    },
  );
});
