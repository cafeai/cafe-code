import "../index.css";

import type { CDPSession } from "@vitest/browser-playwright";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  createMermaidRenderService,
  renderInMermaidSandbox,
  type MermaidResult,
} from "../lib/mermaid/renderService";
import { applyInterfaceScalePercent } from "../interfaceScale";
import { MermaidBlock } from "./MermaidBlock";

const mocks = vi.hoisted(() => ({
  render: vi.fn<(source: string, theme: "dark" | "light") => Promise<MermaidResult>>(),
  copy: vi.fn<(source: string) => Promise<void>>(),
}));

vi.mock("../lib/mermaid/renderService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mermaid/renderService")>()),
  renderMermaid: mocks.render,
}));
vi.mock("../lib/copyToClipboard", () => ({ copyTextToClipboard: mocks.copy }));

const REAL_CHARTS = [
  {
    name: "XY bars",
    label: "Baseline A",
    source: `xychart-beta
    title "Measured totals and forecast"
    x-axis ["Baseline A", "Baseline B", "Forecast", "Target"]
    y-axis "Decimal units" 0 --> 2400
    bar [2262.804, 2174.792, 360, 400]\n`,
  },
  {
    name: "pie showData",
    label: "Header bytes [150]",
    source: `pie showData
    title Resource allocation: exact unit composition
    "Primary pool" : 610698
    "Secondary pool" : 1563944
    "Header bytes" : 150\n`,
  },
] as const;

function diagram(title = "Fixture diagram", width = 1200, height = 600): MermaidResult {
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#888"/></svg>`,
    width,
    height,
    title,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// CDP addresses the runner's top-level viewport. Translate the test frame's
// CSS geometry, including Vitest's display scale, before sending real input.
function browserPoint(point: { x: number; y: number }) {
  let { x, y } = point;
  let frame = window.frameElement;
  while (frame) {
    const element = frame as HTMLElement;
    const rect = element.getBoundingClientRect();
    x = rect.left + (x + element.clientLeft) * (rect.width / element.offsetWidth);
    y = rect.top + (y + element.clientTop) * (rect.height / element.offsetHeight);
    frame = frame.ownerDocument.defaultView?.frameElement ?? null;
  }
  return { x, y };
}

beforeEach(async () => {
  await page.viewport(1100, 800);
  mocks.render.mockReset().mockResolvedValue(diagram());
  mocks.copy.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  applyInterfaceScalePercent(100);
  document.documentElement.classList.remove("dark");
});

describe("Mermaid block", () => {
  it("keeps incomplete source exact and copyable without requesting a render", async () => {
    const source = "flowchart LR\n  A[Unfinished  \n";
    const screen = await render(<MermaidBlock code={source} complete={false} theme="dark" />);
    try {
      expect(document.querySelector(".mermaid-source code")?.textContent).toBe(source);
      expect(mocks.render).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("button", { name: "Diagram", exact: true }))
        .toBeDisabled();
      await page.getByRole("button", { name: "Copy Mermaid source" }).click();
      expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(source);
      await expect.element(page.getByText("Copied", { exact: true })).toBeVisible();
      await screen.rerender(<MermaidBlock code={source + "]"} complete theme="dark" />);
      await expect.element(page.getByRole("img", { name: "Fixture diagram" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("shows a fixed failure notice and retains unsupported or invalid source", async () => {
    const source = "unsupported-secret-diagram\nprivate-source";
    mocks.render.mockRejectedValue(new Error("private-exception /secret/path"));
    const screen = await render(<MermaidBlock code={source} complete theme="light" />);
    try {
      await expect
        .element(page.getByText("Couldn't render this diagram. Showing its source."))
        .toBeVisible();
      expect(document.querySelector(".mermaid-source code")?.textContent).toBe(source);
      expect(document.body.textContent).not.toContain("private-exception");
      expect(document.body.textContent).not.toContain("/secret/path");
      await expect.element(page.getByRole("button", { name: "Expand diagram" })).toBeDisabled();
      await page.getByRole("button", { name: "Copy Mermaid source" }).click();
      expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(source);
    } finally {
      await screen.unmount();
    }
  });

  it("ignores stale source and theme responses and revokes each owned image URL", async () => {
    const first = deferred<MermaidResult>();
    const second = deferred<MermaidResult>();
    const createUrl = vi.spyOn(URL, "createObjectURL");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL");
    mocks.render.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const screen = await render(<MermaidBlock code="first" complete theme="dark" />);
    try {
      await screen.rerender(<MermaidBlock code="second" complete theme="light" />);
      second.resolve(diagram("Current diagram"));
      await expect.element(page.getByRole("img", { name: "Current diagram" })).toBeVisible();
      const currentUrl = document.querySelector<HTMLImageElement>(".mermaid-preview img")!.src;
      first.resolve(diagram("Stale diagram"));
      await Promise.resolve();
      await Promise.resolve();
      expect(createUrl).toHaveBeenCalledTimes(1);
      expect(document.querySelector<HTMLImageElement>(".mermaid-preview img")!.alt).toBe(
        "Current diagram",
      );
      expect(mocks.render).toHaveBeenNthCalledWith(1, "first", "dark");
      expect(mocks.render).toHaveBeenNthCalledWith(2, "second", "light");
      await screen.rerender(<MermaidBlock code="second" complete theme="dark" />);
      await expect.element(page.getByRole("img", { name: "Fixture diagram" })).toBeVisible();
      expect(revokeUrl).toHaveBeenCalledWith(currentUrl);
    } finally {
      await screen.unmount();
    }
    expect(revokeUrl).toHaveBeenCalledTimes(2);
  });

  it("does not allocate an image or clipboard feedback after unmount", async () => {
    const pending = deferred<MermaidResult>();
    const copied = deferred<void>();
    const createUrl = vi.spyOn(URL, "createObjectURL");
    mocks.render.mockReturnValue(pending.promise);
    mocks.copy.mockReturnValue(copied.promise);
    const screen = await render(<MermaidBlock code="flowchart LR\nA-->B" complete theme="dark" />);
    await page.getByRole("button", { name: "Copy Mermaid source" }).click();
    await screen.unmount();
    pending.resolve(diagram());
    copied.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(createUrl).not.toHaveBeenCalled();
    expect(document.querySelector(".mermaid-block")).toBeNull();
  });

  it("exposes selectable source after a clipboard failure without losing the diagram toggle", async () => {
    mocks.copy.mockRejectedValue(new Error("private clipboard detail"));
    const source = "flowchart LR\nA-->B";
    const screen = await render(<MermaidBlock code={source} complete theme="light" />);
    try {
      await expect.element(page.getByRole("img", { name: "Fixture diagram" })).toBeVisible();
      await page.getByRole("button", { name: "Copy Mermaid source" }).click();
      await expect
        .element(page.getByRole("button", { name: "Source", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
      expect(document.querySelector(".mermaid-source code")?.textContent).toBe(source);
      expect(document.body.textContent).not.toContain("private clipboard detail");
      await page.getByRole("button", { name: "Diagram", exact: true }).click();
      await expect.element(page.getByRole("img", { name: "Fixture diagram" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("does not reuse a revoked image when a pending replacement changes back to its prior source", async () => {
    const replacement = deferred<MermaidResult>();
    const repeated = deferred<MermaidResult>();
    mocks.render
      .mockResolvedValueOnce(diagram("Original diagram"))
      .mockReturnValueOnce(replacement.promise)
      .mockReturnValueOnce(repeated.promise);
    const screen = await render(<MermaidBlock code="original" complete theme="dark" />);
    try {
      await expect.element(page.getByRole("img", { name: "Original diagram" })).toBeVisible();
      await screen.rerender(<MermaidBlock code="replacement" complete theme="dark" />);
      await screen.rerender(<MermaidBlock code="original" complete theme="dark" />);
      expect(document.querySelector(".mermaid-preview img")).toBeNull();
      repeated.resolve(diagram("Restored diagram"));
      await expect.element(page.getByRole("img", { name: "Restored diagram" })).toBeVisible();
      replacement.reject(new Error("obsolete failure"));
      await Promise.resolve();
      await Promise.resolve();
      await expect.element(page.getByRole("img", { name: "Restored diagram" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    { theme: "light" as const, scale: 80 },
    { theme: "light" as const, scale: 130 },
    { theme: "dark" as const, scale: 80 },
    { theme: "dark" as const, scale: 130 },
  ])("contains diagram and source overflow at $theme/$scale%", async ({ theme, scale }) => {
    await page.viewport(390, 700);
    applyInterfaceScalePercent(scale);
    document.documentElement.classList.toggle("dark", theme === "dark");
    const host = document.createElement("div");
    host.className = "chat-markdown";
    host.style.width = "min(100%, 19rem)";
    document.body.append(host);
    const source = `flowchart LR\nA[${"wide".repeat(300)}]-->B`;
    mocks.render.mockResolvedValue(diagram("Wide diagram", 12000, 6000));
    const screen = await render(<MermaidBlock code={source} complete theme={theme} />, {
      container: host,
    });
    try {
      await expect.element(page.getByRole("img", { name: "Wide diagram" })).toBeVisible();
      const block = host.querySelector<HTMLElement>(".mermaid-block")!;
      expect(block.getBoundingClientRect().width).toBeLessThanOrEqual(
        host.getBoundingClientRect().width + 1,
      );
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      const image = host.querySelector<HTMLImageElement>("img")!;
      const preview = host.querySelector<HTMLElement>(".mermaid-preview")!;
      expect(image.getBoundingClientRect().width).toBe(image.naturalWidth);
      expect(preview.scrollWidth).toBeGreaterThan(preview.clientWidth);
      expect(preview.scrollHeight).toBeGreaterThan(preview.clientHeight);
      expect(preview.getBoundingClientRect().right).toBeLessThanOrEqual(
        block.getBoundingClientRect().right,
      );
      await page.getByRole("button", { name: "Source", exact: true }).click();
      const sourceBlock = host.querySelector<HTMLElement>(".mermaid-source")!;
      expect(sourceBlock.scrollWidth).toBeGreaterThan(sourceBlock.clientWidth);
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      expect(sourceBlock.textContent).toBe(source);
      await page.getByRole("button", { name: "Diagram", exact: true }).click();
      await page.getByRole("button", { name: "Expand diagram" }).click();
      await expect
        .element(page.getByRole("dialog", { name: "Expanded Mermaid diagram" }))
        .toBeVisible();
      const popup = document.querySelector<HTMLElement>(".mermaid-expanded-dialog")!;
      expect(popup.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(popup.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("button", { name: "Expand diagram" })).toHaveFocus();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("expands with fit, zoom, native scroll and pointer pan, then restores trigger focus", async () => {
    mocks.render.mockResolvedValue(diagram("Large diagram", 3000, 1600));
    const screen = await render(<MermaidBlock code="flowchart LR\nA-->B" complete theme="dark" />);
    try {
      await expect.element(page.getByRole("img", { name: "Large diagram" })).toBeVisible();
      await page.getByRole("button", { name: "Expand diagram" }).click();
      await expect
        .element(page.getByRole("dialog", { name: "Expanded Mermaid diagram" }))
        .toBeVisible();
      const viewport = document.querySelector<HTMLElement>(".mermaid-expanded-viewport")!;
      await vi.waitFor(() => {
        expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
        expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight + 1);
      });
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("100%");
      expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("125%");
      await page.getByRole("button", { name: "Zoom out", exact: true }).click();
      viewport.focus();
      await userEvent.keyboard("{ArrowRight}");
      await vi.waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));
      viewport.scrollTo(100, 100);
      const rect = viewport.getBoundingClientRect();
      const start = browserPoint({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      const end = browserPoint({
        x: rect.left + rect.width / 2 - 70,
        y: rect.top + rect.height / 2 - 50,
      });
      const input: CDPSession = cdp();
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
          expect(viewport.scrollLeft).toBeGreaterThan(150);
          expect(viewport.scrollTop).toBeGreaterThan(130);
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
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await vi.waitFor(() =>
        expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1),
      );
      expect(viewport.scrollLeft).toBe(0);
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("button", { name: "Expand diagram" })).toHaveFocus();
    } finally {
      await screen.unmount();
    }
  });

  it.each(
    REAL_CHARTS.flatMap((chart) =>
      (["light", "dark"] as const).flatMap((theme) =>
        [80, 130].map((scale) => ({ ...chart, theme, scale })),
      ),
    ),
  )(
    "retains real $name source, copy and expanded controls at $theme/$scale%",
    async ({ source, label, theme, scale }) => {
      await page.viewport(390, 700);
      applyInterfaceScalePercent(scale);
      document.documentElement.classList.toggle("dark", theme === "dark");
      const host = document.createElement("div");
      host.className = "chat-markdown";
      host.style.width = "min(100%, 19rem)";
      document.body.append(host);
      // Retain the existing lifecycle test double, but give chart cases a
      // fresh real service and its ordinary opaque-origin sandbox. This also
      // exercises parent admission and sanitized image publication; Mermaid
      // itself is never evaluated in this test document's application realm.
      mocks.render.mockImplementation(createMermaidRenderService(renderInMermaidSandbox));
      const screen = await render(<MermaidBlock code={source} complete theme={theme} />, {
        container: host,
      });
      try {
        // Keep the established 30-second browser test deadline. As in the real
        // preview harness, bound cold bundle/sandbox readiness separately from
        // the remaining source, geometry and native-input checks.
        await vi.waitFor(() => expect(host.querySelector(".mermaid-preview img")).not.toBeNull(), {
          timeout: 20_000,
        });
        const image = host.querySelector<HTMLImageElement>(".mermaid-preview img")!;
        await image.decode();
        expect(image.naturalWidth).toBeGreaterThan(0);
        expect(image.naturalHeight).toBeGreaterThan(0);
        const imageUrl = image.src;
        const svg = await (await fetch(imageUrl)).text();
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        expect(parsed.querySelector("foreignObject,script,image,a,use")).toBeNull();
        for (const style of parsed.querySelectorAll("style")) style.remove();
        expect(parsed.documentElement.textContent).toContain(label);
        expect(mocks.render).toHaveBeenCalledExactlyOnceWith(source, theme);
        expect(document.querySelector('iframe[title="Isolated diagram renderer"]')).toBeNull();

        const block = host.querySelector<HTMLElement>(".mermaid-block")!;
        const preview = host.querySelector<HTMLElement>(".mermaid-preview")!;
        expect(block.getBoundingClientRect().width).toBeLessThanOrEqual(
          host.getBoundingClientRect().width + 1,
        );
        expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
        expect(image.getBoundingClientRect().width).toBeCloseTo(image.naturalWidth, 0);
        expect(preview.scrollWidth).toBeGreaterThan(preview.clientWidth);
        await expect
          .element(page.getByRole("button", { name: "Diagram", exact: true }))
          .toHaveAttribute("aria-pressed", "true");
        await page.getByRole("button", { name: "Source", exact: true }).click();
        expect(host.querySelector(".mermaid-source code")?.textContent).toBe(source);
        expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
        await page.getByRole("button", { name: "Copy Mermaid source" }).click();
        expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(source);
        await expect.element(page.getByText("Copied", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Diagram", exact: true }).click();
        expect(host.querySelector<HTMLImageElement>(".mermaid-preview img")!.src).toBe(imageUrl);

        await page.getByRole("button", { name: "Expand diagram" }).click();
        await expect
          .element(page.getByRole("dialog", { name: "Expanded Mermaid diagram" }))
          .toBeVisible();
        const popup = document.querySelector<HTMLElement>(".mermaid-expanded-dialog")!;
        const viewport = document.querySelector<HTMLElement>(".mermaid-expanded-viewport")!;
        await vi.waitFor(() => {
          expect(Number(getComputedStyle(popup).opacity)).toBe(1);
          expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
          expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight + 1);
        });
        expect(popup.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
        expect(popup.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight + 1);
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("100%");
        expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
        await page.getByRole("button", { name: "Zoom in", exact: true }).click();
        expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("125%");
        await page.getByRole("button", { name: "Zoom out", exact: true }).click();
        expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("100%");
        // Both real chart families are smaller than the large rectangle used
        // by the existing control fixture. Two zoom steps ensure scroll room
        // on both axes before exercising keyboard input and pointer capture.
        await page.getByRole("button", { name: "Zoom in", exact: true }).click();
        await page.getByRole("button", { name: "Zoom in", exact: true }).click();
        viewport.focus();
        await userEvent.keyboard("{ArrowRight}");
        await vi.waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));
        viewport.scrollTo(50, 50);
        const rect = viewport.getBoundingClientRect();
        const start = browserPoint({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
        const end = browserPoint({
          x: rect.left + rect.width / 2 - 50,
          y: rect.top + rect.height / 2 - 30,
        });
        const input: CDPSession = cdp();
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
            expect(viewport.scrollLeft).toBeGreaterThan(80);
            expect(viewport.scrollTop).toBeGreaterThan(65);
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
        await page.getByRole("button", { name: "Fit", exact: true }).click();
        await vi.waitFor(() => {
          expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
          expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight + 1);
        });
        expect(viewport.scrollLeft).toBe(0);
        expect(viewport.scrollTop).toBe(0);
        await userEvent.keyboard("{Escape}");
        await expect.element(page.getByRole("button", { name: "Expand diagram" })).toHaveFocus();
      } finally {
        await screen.unmount();
        host.remove();
      }
    },
  );
});
