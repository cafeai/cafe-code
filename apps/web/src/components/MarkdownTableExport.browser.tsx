import "../index.css";

import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { buildTableExportSvg, createTablePng } from "../lib/tableImageExport";
import { MarkdownTable } from "./MarkdownTableViewer";
import { toastManager } from "./ui/toast";

const transports = vi.hoisted(() => ({
  copy: vi.fn(async (png: Promise<Blob>, signal: AbortSignal) => {
    const result = await png;
    signal.throwIfAborted();
    return result;
  }),
  save: vi.fn(async (png: Promise<Blob>, _name: string, signal: AbortSignal) => {
    await png;
    signal.throwIfAborted();
    return "saved" as const;
  }),
}));

// Keep real DOM capture, font embedding, SVG admission and PNG rasterization.
// Only the external clipboard/download transports are replaced in this suite.
vi.mock("../lib/imageExport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/imageExport")>()),
  copyPngToClipboard: transports.copy,
  savePngToDisk: transports.save,
}));

const MARKDOWN = [
  "| Name | Code | Formula | Final column |",
  "| --- | --- | --- | --- |",
  ...Array.from(
    { length: 40 },
    (_, index) =>
      `| **Row ${index + 1}** | \`${"unbroken-code-".repeat(12)}\` | $\\frac{a_1+b^2}{\\sqrt{x}}$ | *Final value ${index + 1}* |`,
  ),
].join("\n");

function tableFixture(markdown = MARKDOWN) {
  return (
    <div
      className="chat-markdown font-sans text-sm leading-relaxed text-chat-foreground"
      style={{ width: 320 }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false, trust: false }]]}
        components={{ table: MarkdownTable }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

async function pngCanvas(png: Blob): Promise<HTMLCanvasElement> {
  expect(png.type).toBe("image/png");
  const bitmap = await createImageBitmap(png);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  expect(context).not.toBeNull();
  context!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

function pixel(canvas: HTMLCanvasElement, x: number, y: number): number[] {
  return Array.from(canvas.getContext("2d")!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data);
}

afterEach(() => {
  vi.restoreAllMocks();
  transports.copy.mockClear();
  transports.save.mockClear();
});

describe("Markdown table image export", () => {
  it("offers both export actions inline and expanded, confirms copy and keeps saves quiet", async () => {
    const toast = vi.spyOn(toastManager, "add").mockReturnValue("table-export-fixture");
    const screen = await render(tableFixture("| Value |\n| --- |\n| Final row |"));
    try {
      await page.getByRole("button", { name: "Table image actions", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Save as PNG", exact: true }))
        .toBeVisible();
      await page.getByRole("menuitem", { name: "Copy image", exact: true }).click();
      expect(transports.copy).toHaveBeenCalledTimes(1);
      // Actual font readiness and rasterization belong to preparation, not the
      // short publication poll. Await this action's exact PNG before feedback.
      const inlinePng = await transports.copy.mock.calls[0]![0];
      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({ type: "success", title: "Table image copied" }),
        ),
      );
      const inlineCanvas = await pngCanvas(inlinePng);
      toast.mockClear();

      await page.getByRole("button", { name: "Expand table", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Expanded table" });
      await expect.element(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
      await dialog.getByRole("button", { name: "Table image actions", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Copy image", exact: true }))
        .toBeVisible();
      await page.getByRole("menuitem", { name: "Save as PNG", exact: true }).click();
      await vi.waitFor(() => expect(transports.save).toHaveBeenCalledTimes(1));
      const expandedPng = await transports.save.mock.calls[0]![0];
      // Check silence after the mocked sink fulfills, not while PNG preparation
      // is still pending and its eventual publication result is unknown.
      await transports.save.mock.results[0]!.value;
      const expandedCanvas = await pngCanvas(expandedPng);
      expect(transports.save.mock.calls[0]![1]).toBe("table.png");
      expect(expandedCanvas.width).toBe(inlineCanvas.width);
      expect(expandedCanvas.height).toBe(inlineCanvas.height);
      expect(toast).not.toHaveBeenCalled();
      inlineCanvas.width = expandedCanvas.width = 0;
      inlineCanvas.height = expandedCanvas.height = 0;
    } finally {
      await screen.unmount();
    }
  });

  it("retires preparation when the theme changes with the same children", async () => {
    const root = document.documentElement;
    const originalDark = root.classList.contains("dark");
    const originalTheme = localStorage.getItem("cafe-code:theme");
    localStorage.setItem("cafe-code:theme", "dark");
    const toast = vi.spyOn(toastManager, "add").mockReturnValue("table-export-fixture");
    const stableChildren = (
      <tbody>
        <tr>
          <td>Stable table</td>
        </tr>
      </tbody>
    );
    const screen = await render(
      <div className="chat-markdown">
        <MarkdownTable>{stableChildren}</MarkdownTable>
      </div>,
    );
    try {
      vi.spyOn(document.fonts, "ready", "get").mockReturnValue(new Promise<FontFaceSet>(() => {}));
      await page.getByRole("button", { name: "Table image actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Copy image", exact: true }).click();
      expect(transports.copy).toHaveBeenCalledTimes(1);
      const signal = transports.copy.mock.calls[0]![1];
      expect(signal.aborted).toBe(false);
      localStorage.setItem("cafe-code:theme", "light");
      window.dispatchEvent(
        new StorageEvent("storage", { key: "cafe-code:theme", newValue: "light" }),
      );
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      expect(toast).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      root.classList.toggle("dark", originalDark);
      if (originalTheme === null) localStorage.removeItem("cafe-code:theme");
      else localStorage.setItem("cafe-code:theme", originalTheme);
    }
  });

  it.each([
    { theme: "light", scale: 80 },
    { theme: "light", scale: 130 },
    { theme: "dark", scale: 80 },
    { theme: "dark", scale: 130 },
  ])(
    "exports every row and column with the $theme theme at $scale% after zoom and scroll",
    async ({ theme, scale }) => {
      const root = document.documentElement;
      const originalDark = root.classList.contains("dark");
      const originalFontSize = root.style.fontSize;
      const originalTheme = localStorage.getItem("cafe-code:theme");
      localStorage.setItem("cafe-code:theme", theme);
      root.classList.toggle("dark", theme === "dark");
      root.style.fontSize = `${scale}%`;
      const screen = await render(tableFixture());
      try {
        await document.fonts.ready;
        const scroller = document.querySelector<HTMLElement>(".chat-markdown-table-scroll")!;
        const table = scroller.querySelector<HTMLTableElement>("table")!;
        const last = table.querySelector<HTMLTableCellElement>(
          "tbody tr:last-child td:last-child",
        )!;
        const first = table.querySelector<HTMLTableCellElement>(
          "tbody tr:first-child td:first-child",
        )!;
        // Distinct synthetic colors establish actual end-to-end raster pixels,
        // not merely a source string containing the last row's label.
        last.style.backgroundColor = "rgb(29, 139, 84)";
        first.style.backgroundColor = "rgb(151, 64, 112)";
        await vi.waitFor(() => {
          expect(getComputedStyle(first).backgroundColor).toBe("rgb(151, 64, 112)");
          expect(getComputedStyle(last).backgroundColor).toBe("rgb(29, 139, 84)");
        });
        expect(table.querySelectorAll("tbody tr")).toHaveLength(40);
        expect(table.querySelectorAll(".katex")).toHaveLength(40);
        expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
        scroller.scrollLeft = 150;
        const scrollBefore = scroller.scrollLeft;
        const before = buildTableExportSvg(table);

        await page.getByRole("button", { name: "Expand table", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Expanded table" });
        await expect.element(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Reset", exact: true }).click();
        await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
        const expandedScroller = dialog
          .getByRole("region", { name: "Expanded table; scroll to inspect" })
          .element();
        expandedScroller.scrollLeft = 180;
        expandedScroller.scrollTop = 90;
        const compared = buildTableExportSvg(table);
        // Compare without dumping the embedded fonts if this ever regresses.
        expect(compared.svg === before.svg).toBe(true);
        expect(compared.width).toBe(before.width);
        expect(compared.height).toBe(before.height);

        const after = buildTableExportSvg(table);
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const canvas = await pngCanvas(await createTablePng(table, new AbortController().signal));
        expect(fetchSpy).not.toHaveBeenCalled();
        const ratio = canvas.width / after.width;
        expect(canvas.height).toBeCloseTo(after.height * ratio, 0);
        const tableBounds = table.getBoundingClientRect();
        const lastBounds = last.getBoundingClientRect();
        const firstBounds = first.getBoundingClientRect();
        expect(
          pixel(
            canvas,
            (8 + lastBounds.right - tableBounds.left - 4) * ratio,
            (8 + lastBounds.bottom - tableBounds.top - 4) * ratio,
          ),
        ).toEqual([29, 139, 84, 255]);
        expect(
          pixel(
            canvas,
            (8 + firstBounds.right - tableBounds.left - 4) * ratio,
            (8 + firstBounds.bottom - tableBounds.top - 4) * ratio,
          ),
        ).toEqual([151, 64, 112, 255]);
        expect(scroller.scrollLeft).toBe(scrollBefore);
        expect(after.svg).toContain("Final value 40");
        expect(after.svg).toContain("font-weight: 700");
        expect(after.svg).toContain("font-style: italic");
        expect(after.svg).toContain('font-family:"DM Sans Variable"');
        expect(after.svg).toContain('font-family:"KaTeX_Math"');
        expect(after.svg).toContain(getComputedStyle(table.querySelector("th")!).borderTopColor);
        const backgroundProbe = document.createElement("canvas").getContext("2d")!;
        backgroundProbe.fillStyle = after.background;
        backgroundProbe.fillRect(0, 0, 1, 1);
        expect(pixel(canvas, 0, 0)).toEqual(
          Array.from(backgroundProbe.getImageData(0, 0, 1, 1).data),
        );
        canvas.width = 0;
        canvas.height = 0;
      } finally {
        await screen.unmount();
        root.classList.toggle("dark", originalDark);
        root.style.fontSize = originalFontSize;
        if (originalTheme === null) localStorage.removeItem("cafe-code:theme");
        else localStorage.setItem("cafe-code:theme", originalTheme);
      }
    },
  );

  it("retains inert link labels and formatting while removing action and resource attributes", async () => {
    const screen = await render(
      <div className="chat-markdown font-sans text-chat-foreground">
        <MarkdownTable>
          <tbody>
            <tr>
              <td>
                <a href="https://example.invalid/private" data-open-policy="confirm">
                  <strong>Visible link</strong>
                </a>
              </td>
            </tr>
          </tbody>
        </MarkdownTable>
      </div>,
    );
    try {
      const table = document.querySelector<HTMLTableElement>(".chat-markdown-table-scroll table")!;
      table.querySelector("a")!.setAttribute("onclick", "window.__tableExportExecuted = true");
      const snapshot = buildTableExportSvg(table);
      const parsed = new DOMParser().parseFromString(snapshot.svg, "image/svg+xml");
      expect(parsed.querySelector("parsererror")).toBeNull();
      expect(parsed.querySelector("a")!.textContent).toBe("Visible link");
      expect(parsed.querySelector("strong")).not.toBeNull();
      expect(
        parsed.querySelector("[href],[onclick],[data-open-policy],script,iframe,image,use"),
      ).toBeNull();
      expect(snapshot.svg).not.toContain("example.invalid");
      expect(snapshot.svg).not.toContain("__tableExportExecuted");
      await createTablePng(table, new AbortController().signal);
    } finally {
      await screen.unmount();
    }
  });

  it("reuses complete origin-clean image pixels without retaining their original source", async () => {
    const screen = await render(
      tableFixture("| Icon | Value |\n| --- | --- |\n| label | intact |"),
    );
    try {
      const table = document.querySelector<HTMLTableElement>(".chat-markdown-table-scroll table")!;
      const iconCanvas = document.createElement("canvas");
      iconCanvas.width = 12;
      iconCanvas.height = 12;
      iconCanvas.getContext("2d")!.fillRect(0, 0, 12, 12);
      const image = document.createElement("img");
      image.src = iconCanvas.toDataURL("image/png");
      await image.decode();
      image.setAttribute("onclick", "window.__tableExportExecuted = true");
      table.querySelector("td")!.prepend(image);
      const snapshot = buildTableExportSvg(table);
      expect(snapshot.svg).toContain("data:image/png;base64,");
      expect(snapshot.svg).not.toContain("onclick");
      await createTablePng(table, new AbortController().signal);
    } finally {
      await screen.unmount();
    }
  });

  it("uses only the explicit app-owned decorative file icon fallback and keeps the link label", async () => {
    const screen = await render(
      <div className="chat-markdown font-sans text-chat-foreground">
        <MarkdownTable>
          <tbody>
            <tr>
              <td>
                <a className="chat-markdown-file-link" href="/synthetic/example.ts">
                  <img
                    className="chat-markdown-file-link-icon"
                    alt=""
                    aria-hidden="true"
                    data-cafe-image-export-fallback="file"
                    style={{ width: 14, height: 14 }}
                  />
                  <span>example.ts</span>
                </a>
              </td>
            </tr>
          </tbody>
        </MarkdownTable>
      </div>,
    );
    try {
      const table = document.querySelector<HTMLTableElement>(".chat-markdown-table-scroll table")!;
      const image = table.querySelector("img")!;
      const snapshot = buildTableExportSvg(table);
      const parsed = new DOMParser().parseFromString(snapshot.svg, "image/svg+xml");
      expect(parsed.querySelector("img,[href],[data-cafe-image-export-fallback]")).toBeNull();
      expect(parsed.querySelectorAll("svg path")).toHaveLength(2);
      expect(parsed.querySelector("a")!.textContent).toBe("example.ts");
      await createTablePng(table, new AbortController().signal);
      image.removeAttribute("data-cafe-image-export-fallback");
      expect(() => buildTableExportSvg(table)).toThrow(
        "This table could not be exported as an image.",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("bounds the aggregate decoded image pixels before processing another image", async () => {
    const screen = await render(tableFixture("| Value |\n| --- |\n| preserved |"));
    try {
      const table = document.querySelector<HTMLTableElement>(".chat-markdown-table-scroll table")!;
      const cell = table.querySelector("td")!;
      const pixels = document.createElement("canvas");
      pixels.width = 1024;
      pixels.height = 1024;
      const source = pixels.toDataURL("image/png");
      for (let index = 0; index < 5; index++) {
        const image = document.createElement("img");
        image.src = source;
        image.style.width = "12px";
        image.style.height = "12px";
        await image.decode();
        cell.append(image);
      }
      expect(() => buildTableExportSvg(table)).toThrow(
        "This table could not be exported as an image.",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("fails explicitly on unready images, active elements, resource-bearing SVG and oversized sources", async () => {
    const screen = await render(tableFixture("| Value |\n| --- |\n| preserved |"));
    try {
      const table = document.querySelector<HTMLTableElement>(".chat-markdown-table-scroll table")!;
      const cell = table.querySelector("td")!;
      const image = document.createElement("img");
      cell.append(image);
      expect(() => buildTableExportSvg(table)).toThrow(
        "This table could not be exported as an image.",
      );
      image.remove();
      const script = document.createElement("script");
      // Empty active elements are enough to prove admission rejection without
      // running synthetic attacker code in the actual fixture document.
      cell.append(script);
      expect(() => buildTableExportSvg(table)).toThrow(
        "This table could not be exported as an image.",
      );
      script.remove();
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.style.fill = "url(https://example.invalid/export-only)";
      svg.append(path);
      cell.append(svg);
      expect(() => buildTableExportSvg(table)).toThrow(
        "This table could not be exported as an image.",
      );
      svg.remove();
      table.style.width = "100001px";
      expect(() => buildTableExportSvg(table)).toThrow(
        "This table could not be exported as an image.",
      );
      table.style.width = "";
      cell.textContent = "x".repeat(1_000_001);
      expect(() => buildTableExportSvg(table)).toThrow(
        "This table could not be exported as an image.",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("rejects removed tables and cancelled actions before rasterization", async () => {
    const screen = await render(tableFixture("| Value |\n| --- |\n| preserved |"));
    const table = document.querySelector<HTMLTableElement>(".chat-markdown-table-scroll table")!;
    const controller = new AbortController();
    controller.abort();
    await expect(createTablePng(table, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await screen.unmount();
    expect(() => buildTableExportSvg(table)).toThrow(
      "This table could not be exported as an image.",
    );
  });

  it("cancels while initial font readiness is still pending", async () => {
    const screen = await render(tableFixture("| Value |\n| --- |\n| preserved |"));
    try {
      const table = document.querySelector<HTMLTableElement>(".chat-markdown-table-scroll table")!;
      vi.spyOn(document.fonts, "ready", "get").mockReturnValue(new Promise<FontFaceSet>(() => {}));
      const controller = new AbortController();
      const pending = createTablePng(table, controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await screen.unmount();
    }
  });
});
