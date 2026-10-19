import "../../index.css";
import "../desk/desk.css";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
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

function inspectionBoard() {
  const swatches = [
    "#bec1bd",
    "#9ea4a3",
    "#667978",
    "#8ca55c",
    "#c9c8b2",
    "#a05945",
    "#e4c796",
    "#775238",
    "#58736f",
    "#8b283b",
  ];
  const tiles = swatches
    .map((color, index) => {
      const x = 50 + (index % 5) * 300;
      const y = 150 + Math.floor(index / 5) * 400;
      return `<g transform="translate(${x} ${y})"><text y="0" font-family="sans-serif" font-size="22" fill="#e4e6eb">${String(index + 1).padStart(2, "0")}  Material study</text><rect y="25" width="265" height="300" fill="${color}"/><rect y="25" width="265" height="300" fill="url(#grid)"/><text y="355" font-family="sans-serif" font-size="18" fill="#a9b2bc">Original / replacement</text></g>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#ffffff" stroke-opacity=".18" stroke-width="1"/></pattern></defs><rect width="1600" height="1000" fill="#141b23"/><text x="50" y="65" font-family="sans-serif" font-size="34" font-weight="bold" fill="#e4e6eb">MATERIAL COMPARISON</text><text x="50" y="105" font-family="sans-serif" font-size="20" fill="#a9b2bc">Synthetic image for viewer inspection</text>${tiles}</svg>`;
  return { src: `data:image/svg+xml,${encodeURIComponent(svg)}`, name: "material-comparison.png" };
}

// Real pointer/wheel input uses the top-level browser's coordinates; Vitest's
// tester iframe may be scaled and offset within that native page.
function browserPoint(point: { x: number; y: number }) {
  let { x, y } = point;
  let frame = window.frameElement;
  while (frame) {
    const element = frame as HTMLElement;
    const bounds = element.getBoundingClientRect();
    x = bounds.left + (x + element.clientLeft) * (bounds.width / element.offsetWidth);
    y = bounds.top + (y + element.clientTop) * (bounds.height / element.offsetHeight);
    frame = frame.ownerDocument.defaultView?.frameElement ?? null;
  }
  return { x, y };
}

function imageViewport() {
  return page
    .getByRole("region", { name: "Expanded image; scroll to zoom or drag to pan", exact: true })
    .element() as HTMLElement;
}

async function expectFitted(name: string) {
  await expectImageFits(name);
  const viewport = imageViewport();
  await vi.waitFor(() => {
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
    expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight + 1);
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
  });
}

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
      [bounds.left + Math.min(2, bounds.width / 2), bounds.top + bounds.height / 2],
      [bounds.right - Math.min(2, bounds.width / 2), bounds.top + bounds.height / 2],
      [bounds.left + bounds.width / 2, bounds.top + Math.min(2, bounds.height / 2)],
      [bounds.left + bounds.width / 2, bounds.bottom - Math.min(2, bounds.height / 2)],
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
  document.documentElement.classList.remove("dark");
});

describe("expanded chat images", () => {
  it.each([
    { width: 1100, height: 800, scale: 80, dark: false },
    { width: 1100, height: 800, scale: 130, dark: true },
    { width: 390, height: 700, scale: 80, dark: true },
    { width: 390, height: 700, scale: 130, dark: false },
  ])(
    "keeps inspection controls visible while zoomed at $width and $scale% (dark: $dark)",
    async ({ width, height, scale, dark }) => {
      await page.viewport(width, height);
      applyInterfaceScalePercent(scale);
      document.documentElement.classList.toggle("dark", dark);
      const item = inspectionBoard();
      const view = await render(
        <PreviewInPane current={{ images: [item], index: 0 }} onClose={vi.fn()} />,
      );
      try {
        await expectFitted(item.name);
        const capture = async (state: string) => {
          if (import.meta.env.VITE_IMAGE_VIEWER_SCREENSHOTS !== "1") return;
          const dialog = page.getByRole("dialog", { name: "Expanded image preview" }).element();
          await Promise.all(
            dialog.getAnimations({ subtree: true }).map((animation) => animation.finished),
          );
          await page.screenshot({
            path: `../../../../../.explorations/image-viewer/${width}-${scale}-${dark ? "dark" : "light"}-${state}.png`,
          });
        };
        await capture("fit");
        await page.getByRole("button", { name: "Original size", exact: true }).click();
        await page.getByRole("button", { name: "Zoom in", exact: true }).click();
        const toolbar = page
          .getByRole("group", { name: "Image zoom controls", exact: true })
          .element();
        for (const button of toolbar.querySelectorAll("button")) expectInsideWindow(button);
        expect(imageViewport().scrollWidth).toBeGreaterThan(imageViewport().clientWidth);
        await capture("zoom");
        await page.getByRole("button", { name: "Fit", exact: true }).click();
        await expectFitted(item.name);
      } finally {
        await view.unmount();
      }
    },
  );
  it.each([
    { width: 1440, height: 900, scale: 80, dark: false },
    { width: 1440, height: 900, scale: 130, dark: true },
    { width: 900, height: 320, scale: 80, dark: true },
    { width: 900, height: 320, scale: 130, dark: false },
    { width: 390, height: 700, scale: 80, dark: false },
    { width: 390, height: 700, scale: 130, dark: true },
  ])(
    "fits both image orientations at $width × $height and $scale% scale (dark: $dark)",
    async ({ width, height, scale, dark }) => {
      await page.viewport(width, height);
      applyInterfaceScalePercent(scale);
      document.documentElement.classList.toggle("dark", dark);
      const onClose = vi.fn();
      const view = await render(<PreviewInPane onClose={onClose} />);
      try {
        await expectFitted(landscape.name);
        await page.getByRole("button", { name: "Next image", exact: true }).click();
        await expectFitted(portrait.name);
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

  it("zooms to original pixels, pans with captured pointer input and keyboard, then fits again", async () => {
    await page.viewport(1100, 800);
    const onClose = vi.fn();
    let observedViewport: HTMLElement | null = null;
    let retired = false;
    let sequence = 0;
    const observations: Record<string, string | number | boolean | null>[] = [];
    const observe = (phase: string, event?: Event) => {
      if (retired) return;
      const viewport = observedViewport;
      const key = event instanceof KeyboardEvent ? event : null;
      observations.push({
        sequence: ++sequence,
        phase,
        at: performance.now(),
        focused: document.hasFocus(),
        visible: document.visibilityState === "visible",
        exactActiveElement: document.activeElement === viewport,
        exactTarget: event ? event.target === viewport : null,
        trusted: event?.isTrusted ?? null,
        prevented: event?.defaultPrevented ?? null,
        ctrl: key?.ctrlKey ?? null,
        alt: key?.altKey ?? null,
        meta: key?.metaKey ?? null,
        shift: key?.shiftKey ?? null,
        left: viewport?.scrollLeft ?? null,
        top: viewport?.scrollTop ?? null,
        maxLeft: viewport ? viewport.scrollWidth - viewport.clientWidth : null,
        maxTop: viewport ? viewport.scrollHeight - viewport.clientHeight : null,
        dragging: viewport ? getComputedStyle(viewport).cursor === "grabbing" : null,
      });
      if (observations.length > 16) observations.shift();
    };
    const observeKeyState = (event: KeyboardEvent) => {
      if (event.key !== "ArrowRight") return;
      // Read final dispatch state without consuming native scrolling. Retired
      // continuations cannot append after the one-shot completion receipt.
      queueMicrotask(() => observe(event.type, event));
    };
    const observeFocus = (event: FocusEvent) => {
      if (event.target === window || event.target === observedViewport) observe(event.type, event);
    };
    const observeScroll = (event: Event) => {
      if (event.target === observedViewport) observe("scroll", event);
    };
    const retireObservations = () => {
      if (retired) return;
      observe("final");
      retired = true;
      window.removeEventListener("keydown", observeKeyState, true);
      window.removeEventListener("keyup", observeKeyState, true);
      window.removeEventListener("focus", observeFocus, true);
      window.removeEventListener("blur", observeFocus, true);
      observedViewport?.removeEventListener("scroll", observeScroll);
      console.info("image-viewer-native-key-diagnostic", JSON.stringify({ observations }));
    };
    // Own observations before render/input awaits. They are bounded scalar
    // diagnostics only: no focus, scroll, key, timer or readiness is added.
    onTestFinished(retireObservations);
    const view = await render(<PreviewInPane onClose={onClose} />);
    try {
      await expectFitted(landscape.name);
      await page.getByRole("button", { name: "Original size", exact: true }).click();
      const img = page.getByRole("img", { name: landscape.name, exact: true }).element();
      const viewport = imageViewport();
      await vi.waitFor(() => {
        expect(img.getBoundingClientRect().width).toBe(6000);
        expect(img.getBoundingClientRect().height).toBe(1800);
        expect(viewport.scrollLeft).toBeGreaterThan(0);
        expect(viewport.scrollTop).toBeGreaterThan(0);
      });
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      expect(
        page.getByRole("status", { name: "Zoom level", exact: true }).element().textContent,
      ).toBe("125%");
      expect(img.getBoundingClientRect().width).toBe(7500);
      await page.getByRole("button", { name: "Zoom out", exact: true }).click();
      expect(img.getBoundingClientRect().width).toBe(6000);
      // Activate the native page through the owning region's real pointer/focus
      // path, then observe its released, zoomed keyboard-scroll preconditions.
      await page
        .getByRole("region", { name: "Expanded image; scroll to zoom or drag to pan", exact: true })
        .click();
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(viewport);
        expect(img.getBoundingClientRect().width).toBe(6000);
        expect(
          page.getByRole("status", { name: "Zoom level", exact: true }).element().textContent,
        ).toBe("100%");
        expect(viewport.scrollLeft).toBeGreaterThan(0);
        expect(viewport.scrollLeft).toBeLessThan(viewport.scrollWidth - viewport.clientWidth);
      });
      const beforeKey = viewport.scrollLeft;
      // Hard-timeout completion can retire this observer during an earlier
      // native await. Never attach listeners after its one-shot cleanup ran.
      if (retired) return;
      observedViewport = viewport;
      window.addEventListener("keydown", observeKeyState, true);
      window.addEventListener("keyup", observeKeyState, true);
      window.addEventListener("focus", observeFocus, true);
      window.addEventListener("blur", observeFocus, true);
      viewport.addEventListener("scroll", observeScroll);
      observe("before-key");
      let keyReceipt: { trusted: boolean; exactTarget: boolean; defaultPrevented: boolean } | null =
        null;
      const observeKey = (event: KeyboardEvent) => {
        if (event.key !== "ArrowRight") return;
        retireKeyReceipt();
        // Observe final dispatch state without consuming or preventing native
        // scrolling, which remains the behavior under test.
        queueMicrotask(() => {
          keyReceipt = {
            trusted: event.isTrusted,
            exactTarget: event.target === viewport,
            defaultPrevented: event.defaultPrevented,
          };
        });
      };
      const retireKeyReceipt = () => window.removeEventListener("keydown", observeKey, true);
      onTestFinished(retireKeyReceipt);
      window.addEventListener("keydown", observeKey, true);
      try {
        await userEvent.keyboard("{ArrowRight}");
        observe("after-key");
        await vi.waitFor(() =>
          expect(keyReceipt).toEqual({ trusted: true, exactTarget: true, defaultPrevented: false }),
        );
        await vi.waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(beforeKey));
      } finally {
        retireKeyReceipt();
        retireObservations();
      }
      await expect
        .element(page.getByRole("img", { name: landscape.name, exact: true }))
        .toBeInTheDocument();
      viewport.scrollTo(200, 200);
      const bounds = viewport.getBoundingClientRect();
      const start = browserPoint({
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      });
      // Pointer capture must retain the drag even over the dismissing backdrop.
      const end = browserPoint({ x: bounds.left - 20, y: bounds.top - 20 });
      const input = cdp();
      await input.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
      await input.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...start,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      try {
        await input.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...end,
          button: "left",
          buttons: 1,
        });
        await vi.waitFor(() => {
          expect(viewport.scrollLeft).toBeGreaterThan(250);
          expect(viewport.scrollTop).toBeGreaterThan(240);
          expect(getComputedStyle(viewport).cursor).toBe("grabbing");
        });
      } finally {
        await input.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...end,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
      }
      expect(getComputedStyle(viewport).cursor).toBe("grab");
      expect(onClose).not.toHaveBeenCalled();
      await userEvent.keyboard("-1");
      expect(img.getBoundingClientRect().width).toBe(6000);
      await userEvent.keyboard("0");
      await expectFitted(landscape.name);
      await page.getByRole("button", { name: "Original size", exact: true }).click();
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await expectFitted(landscape.name);
    } finally {
      await view.unmount();
    }
  });

  it("anchors real wheel and trackpad pinch zoom at the cursor without zooming the app", async () => {
    await page.viewport(1100, 800);
    const view = await render(<PreviewInPane onClose={vi.fn()} />);
    try {
      await expectFitted(landscape.name);
      await page.getByRole("button", { name: "Original size", exact: true }).click();
      const viewport = imageViewport();
      const img = page
        .getByRole("img", { name: landscape.name, exact: true })
        .element() as HTMLImageElement;
      // Record an image-space anchor only after the native image reaches its
      // requested original size and the layout effect applies its initial pan.
      // A completed click alone does not establish that geometry.
      await vi.waitFor(() => {
        const original = img.getBoundingClientRect();
        expect(original.width).toBe(img.naturalWidth);
        expect(original.height).toBe(img.naturalHeight);
        expect(viewport.scrollLeft).toBeGreaterThan(0);
        expect(viewport.scrollTop).toBeGreaterThan(0);
      });
      const bounds = viewport.getBoundingClientRect();
      const point = { x: bounds.left + bounds.width * 0.65, y: bounds.top + bounds.height * 0.6 };
      const original = img.getBoundingClientRect();
      const imagePoint = { x: point.x - original.left, y: point.y - original.top };
      const input = cdp();
      const nativePoint = browserPoint(point);
      const appScale = window.visualViewport?.scale;
      await input.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...nativePoint });
      for (const modifiers of [0, 2]) {
        const previousWidth = img.getBoundingClientRect().width;
        await input.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...nativePoint,
          deltaX: 0,
          deltaY: -40,
          modifiers,
        });
        await vi.waitFor(() => {
          const current = img.getBoundingClientRect();
          expect(current.width).toBeGreaterThan(previousWidth);
          const scale = current.width / img.naturalWidth;
          expect(Math.abs(current.left + imagePoint.x * scale - point.x)).toBeLessThan(2);
          expect(Math.abs(current.top + imagePoint.y * scale - point.y)).toBeLessThan(2);
          expect(window.visualViewport?.scale).toBe(appScale);
        });
      }
      await input.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...nativePoint,
        deltaX: 0,
        deltaY: 1000,
      });
      await vi.waitFor(() => expect(img.getBoundingClientRect().width).toBeLessThan(6000));
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await expectFitted(landscape.name);
    } finally {
      await view.unmount();
    }
  });

  it("toggles fit and original size on double click and resets when selecting or replacing an image", async () => {
    await page.viewport(1100, 800);
    const onClose = vi.fn();
    const view = await render(<PreviewInPane onClose={onClose} />);
    try {
      await expectFitted(landscape.name);
      await page.getByRole("img", { name: landscape.name, exact: true }).dblClick();
      expect(
        page.getByRole("status", { name: "Zoom level", exact: true }).element().textContent,
      ).toBe("100%");
      // The image is larger than its viewport; double-click a visible region.
      await page
        .getByRole("region", { name: "Expanded image; scroll to zoom or drag to pan", exact: true })
        .dblClick();
      await expectFitted(landscape.name);
      await page.getByRole("button", { name: "Original size", exact: true }).click();
      await page.getByRole("button", { name: "Next image", exact: true }).click();
      await expectFitted(portrait.name);
      await page.getByRole("button", { name: "Original size", exact: true }).click();
      await view.rerender(
        <PreviewInPane
          current={{ images: [image(80, 40, "small.png")], index: 0 }}
          onClose={onClose}
        />,
      );
      await expectFitted("small.png");
      const small = page.getByRole("img", { name: "small.png", exact: true }).element();
      expect(small.getBoundingClientRect().width).toBe(80);
      expect(small.getBoundingClientRect().height).toBe(40);
    } finally {
      await view.unmount();
    }
  });

  it("bounds repeated zooming and keeps Fit reachable on extreme image dimensions", async () => {
    await page.viewport(390, 320);
    applyInterfaceScalePercent(130);
    const item = image(100, 16384, "tall.png");
    const view = await render(
      <PreviewInPane current={{ images: [item], index: 0 }} onClose={vi.fn()} />,
    );
    try {
      await expectFitted(item.name);
      await expect
        .element(page.getByRole("button", { name: "Zoom out", exact: true }))
        .toBeDisabled();
      await page.getByRole("button", { name: "Original size", exact: true }).click();
      for (let step = 0; step < 10; step++) {
        const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
        if (!(zoomIn.element() as HTMLButtonElement).disabled) await zoomIn.click();
      }
      await expect
        .element(page.getByRole("button", { name: "Zoom in", exact: true }))
        .toBeDisabled();
      expect(
        page.getByRole("status", { name: "Zoom level", exact: true }).element().textContent,
      ).toBe("800%");
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await expectFitted(item.name);
    } finally {
      await view.unmount();
    }
  });

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
