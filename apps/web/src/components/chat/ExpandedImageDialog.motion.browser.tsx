import "../../index.css";

import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { ExpandedImageDialog } from "./ExpandedImageDialog";

describe("expanded image reduced motion", () => {
  it("keeps fit and zoom immediate in the native reduced-motion context", async () => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    await page.viewport(900, 600);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="100%" height="100%" fill="#888"/></svg>';
    const onClose = vi.fn();
    const view = await render(
      <ExpandedImageDialog
        preview={{
          images: [
            { src: `data:image/svg+xml,${encodeURIComponent(svg)}`, name: "inspection.png" },
          ],
          index: 0,
        }}
        onClose={onClose}
      />,
    );
    try {
      const originalSize = page.getByRole("button", { name: "Original size", exact: true });
      await expect.element(originalSize).toBeEnabled();
      const dialog = page
        .getByRole("dialog", { name: "Expanded image preview", exact: true })
        .element();
      for (const element of [dialog, ...dialog.querySelectorAll(".animate-enter-scale")]) {
      }
      await originalSize.click();
      const img = page.getByRole("img", { name: "inspection.png", exact: true }).element();
      expect(img.getBoundingClientRect().width).toBe(1600);
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      expect(img.getBoundingClientRect().width).toBe(2000);
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      expect(img.getBoundingClientRect().width).toBeLessThan(900);
      await page.getByRole("button", { name: "Close image preview", exact: true }).last().click();
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await view.unmount();
    }
  });
});
