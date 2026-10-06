import "../../index.css";
import "../desk/desk.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ChatPaneContext } from "../../chatPaneContext";
import { applyInterfaceScalePercent } from "../../interfaceScale";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

function image(width: number, height: number, name: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#3c79b8"/></svg>`;
  return { src: `data:image/svg+xml,${encodeURIComponent(svg)}`, name };
}

const landscape = image(6000, 1800, "wide screenshot.png");
const portrait = image(1800, 6000, `${"Long image name ".repeat(20)}.png`);
const preview = { images: [landscape, portrait], index: 0 };

function PreviewInPane({
  current = preview,
  active = true,
  visible = true,
  onClose,
}: {
  current?: ExpandedImagePreview;
  active?: boolean;
  visible?: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className="desk-workspace"
      style={{
        position: "fixed",
        left: "35%",
        top: "20%",
        width: "60%",
        height: "60%",
        transform: "translateZ(0)",
      }}
    >
      <div className="desk-pane">
        <div className="group/chat-view flex flex-1 flex-col overflow-x-hidden" hidden={!visible}>
          <ChatPaneContext value={{ active, visible }}>
            <ExpandedImageDialog preview={current} onClose={onClose} />
          </ChatPaneContext>
        </div>
      </div>
    </div>
  );
}

function expectInsideWindow(element: Element) {
  const bounds = element.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
}

async function expectImageFits(name: string) {
  const dialog = page.getByRole("dialog", { name: "Expanded image preview" }).element();
  const img = page.getByRole("img", { name, exact: true }).element() as HTMLImageElement;
  await vi.waitFor(() => {
    expect(img.complete && img.naturalWidth > 0).toBe(true);
    expectInsideWindow(img);
    expectInsideWindow(dialog.querySelector("p")!);
    const bounds = img.getBoundingClientRect();
    // Geometry alone misses a correctly sized image clipped by its chat pane.
    for (const [x, y] of [
      [bounds.left + 2, bounds.top + bounds.height / 2],
      [bounds.right - 2, bounds.top + bounds.height / 2],
      [bounds.left + bounds.width / 2, bounds.top + 2],
      [bounds.left + bounds.width / 2, bounds.bottom - 2],
    ]) {
      const hit = document.elementFromPoint(x!, y!);
      const control = hit?.closest("button[data-slot=button]");
      // Gallery controls intentionally sit above the image at its edges.
      expect(
        hit === img || (control !== null && control !== undefined && dialog.contains(control)),
      ).toBe(true);
    }
    for (const button of dialog.querySelectorAll("button")) expectInsideWindow(button);
  });
}

afterEach(() => {
  applyInterfaceScalePercent(100);
});

describe("expanded chat images", () => {
  it.each([
    { width: 1440, height: 900, scale: 80 },
    { width: 1440, height: 900, scale: 130 },
    { width: 900, height: 320, scale: 80 },
    { width: 900, height: 320, scale: 130 },
    { width: 390, height: 700, scale: 80 },
    { width: 390, height: 700, scale: 130 },
  ])(
    "fits both image orientations at $width × $height and $scale% scale",
    async ({ width, height, scale }) => {
      await page.viewport(width, height);
      applyInterfaceScalePercent(scale);
      const onClose = vi.fn();
      const view = await render(<PreviewInPane onClose={onClose} />);
      try {
        await expectImageFits(landscape.name);
        await page.getByRole("button", { name: "Next image", exact: true }).click();
        await expectImageFits(portrait.name);
        await expect
          .element(page.getByText(`${portrait.name} (2/2)`, { exact: true }))
          .toBeVisible();
        await page.getByRole("button", { name: "Previous image", exact: true }).click();
        await expectImageFits(landscape.name);
        await page.getByRole("button", { name: "Close image preview", exact: true }).last().click();
        expect(onClose).toHaveBeenCalledOnce();
      } finally {
        await view.unmount();
      }
    },
  );

  it("refits an open image when the window shrinks and supports gallery keys and Escape", async () => {
    await page.viewport(1440, 900);
    const onClose = vi.fn();
    const view = await render(
      <PreviewInPane current={{ ...preview, index: 1 }} onClose={onClose} />,
    );
    try {
      await expectImageFits(portrait.name);
      await page.viewport(390, 320);
      applyInterfaceScalePercent(130);
      await expectImageFits(portrait.name);
      await userEvent.keyboard("{ArrowRight}");
      await expectImageFits(landscape.name);
      await userEvent.keyboard("{ArrowLeft}");
      await expectImageFits(portrait.name);
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await view.unmount();
    }
  });

  it("does not display a hidden pane's preview or handle its keys", async () => {
    await page.viewport(1000, 700);
    const onClose = vi.fn();
    const view = await render(<PreviewInPane onClose={onClose} />);
    try {
      await expectImageFits(landscape.name);
      await view.rerender(<PreviewInPane active={false} visible={false} onClose={onClose} />);
      await expect
        .element(page.getByRole("dialog", { name: "Expanded image preview" }))
        .not.toBeInTheDocument();
      await userEvent.keyboard("{ArrowRight}{Escape}");
      expect(onClose).not.toHaveBeenCalled();
      await view.rerender(<PreviewInPane onClose={onClose} />);
      await expectImageFits(landscape.name);
    } finally {
      await view.unmount();
    }
  });
});
