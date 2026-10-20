import "../index.css";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createMermaidPng } from "../lib/imageExport";
import { renderMermaid } from "../lib/mermaid/renderService";
import { applyInterfaceScalePercent } from "../interfaceScale";
import { MermaidBlock } from "./MermaidBlock";
import { MERMAID_FAMILY_FIXTURES } from "./mermaidFamilies.test.fixture";
import {
  decodeSvg,
  expectAuthoredChartValues,
  expectDrawingSurvivesPng,
  parsedSvg,
  pngPixels,
  textLabels,
} from "./mermaidFamilyRendering.test.fixture";
import { installMermaidFamilyCleanup } from "./mermaidFamilyCleanup.test.fixture";

const mocks = vi.hoisted(() => ({ copy: vi.fn<(source: string) => Promise<void>>() }));
vi.mock("../lib/copyToClipboard", () => ({ copyTextToClipboard: mocks.copy }));
installMermaidFamilyCleanup(() => mocks.copy.mockReset());

describe("complete newly admitted Mermaid families", () => {
  it.each(
    (["packet", "packet-beta"] as const).flatMap((header) =>
      (["relative", "absolute"] as const).flatMap((syntax) =>
        (["light", "dark"] as const).map((theme) => ({ header, syntax, theme })),
      ),
    ),
  )(
    "renders an exact $header $syntax header-line field in $theme",
    async ({ header, syntax, theme }) => {
      const fields =
        syntax === "relative"
          ? '+8: "Version"\n+8: "Flags"\n+16: "Length"\n+32: "Request ID"\n+32: "Payload"'
          : '0-7: "Version"\n8-15: "Flags"\n16-31: "Length"\n32-63: "Request ID"\n64-95: "Payload"';
      const result = await renderMermaid(`${header} ${fields}`, theme);
      const parsed = parsedSvg(result.svg);
      for (const label of ["Version", "Flags", "Length", "Request ID", "Payload"])
        expect(textLabels(parsed)).toContain(label);
      expectAuthoredChartValues("packet", parsed);
      await decodeSvg(result.svg);
      await expectDrawingSurvivesPng(result, theme);
    },
  );

  it.each(
    MERMAID_FAMILY_FIXTURES.flatMap((fixture) =>
      (["light", "dark"] as const).map((theme) => ({ ...fixture, theme })),
    ),
  )(
    "renders and exports complete $family in $theme",
    async ({ family, source, labels, geometry, theme }) => {
      const result = await renderMermaid(source, theme);
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      const parsed = parsedSvg(result.svg);
      const visibleLabels = textLabels(parsed);
      for (const label of labels) expect(visibleLabels).toContain(label);
      expectAuthoredChartValues(family, parsed);
      for (const shape of geometry) {
        const retained = parsed.querySelectorAll(shape.selector);
        expect(
          retained.length,
          `Missing semantic native ${shape.selector} geometry`,
        ).toBeGreaterThanOrEqual(shape.minimum);
        for (const element of retained) {
          for (const dimension of ["width", "height", "r", "rx", "ry"]) {
            if (!element.hasAttribute(dimension)) continue;
            const value = Number(element.getAttribute(dimension));
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
          }
          if (element.localName === "path") expect(element.getAttribute("d")).toMatch(/^\s*[Mm]/);
        }
      }
      await decodeSvg(result.svg);
      await expectDrawingSurvivesPng(result, theme);
      expect(document.querySelector('iframe[title="Isolated diagram renderer"]')).toBeNull();
    },
  );

  it.each(["mindmap", "kanban", "architecture-beta", "packet relative lengths"])(
    "retains exact source and minimal expanded controls for %s",
    async (family) => {
      const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === family)!;
      expect(fixture).toBeDefined();
      mocks.copy.mockResolvedValue(undefined);
      await page.viewport(390, 700);
      applyInterfaceScalePercent(130);
      const host = document.createElement("div");
      host.className = "chat-markdown";
      host.style.width = "min(100%, 19rem)";
      document.body.append(host);
      const screen = await render(<MermaidBlock code={fixture.source} complete theme="light" />, {
        container: host,
      });
      try {
        await vi.waitFor(() => expect(host.querySelector(".mermaid-preview img")).not.toBeNull(), {
          timeout: 20_000,
        });
        const image = host.querySelector<HTMLImageElement>(".mermaid-preview img")!;
        await image.decode();
        expect(image.naturalWidth).toBeGreaterThan(0);
        expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
        await page.getByRole("button", { name: "Source", exact: true }).click();
        expect(host.querySelector(".mermaid-source code")?.textContent).toBe(fixture.source);
        await page.getByRole("button", { name: "Copy Mermaid source" }).click();
        expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(fixture.source);
        await page.getByRole("button", { name: "Diagram", exact: true }).click();
        await page.getByRole("button", { name: "Expand diagram" }).click();
        await expect
          .element(page.getByRole("dialog", { name: "Expanded Mermaid diagram" }))
          .toBeVisible();
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        expect(host.ownerDocument.querySelector(".mermaid-zoom-value")?.textContent).toBe("100%");
        await page.getByRole("button", { name: "Zoom in", exact: true }).click();
        expect(host.ownerDocument.querySelector(".mermaid-zoom-value")?.textContent).toBe("125%");
        await page.getByRole("button", { name: "Fit", exact: true }).click();
        await userEvent.keyboard("{Escape}");
        await expect.element(page.getByRole("button", { name: "Expand diagram" })).toHaveFocus();
      } finally {
        await screen.unmount();
        host.remove();
      }
    },
  );

  it.each(["light", "dark"] as const)(
    "renders the pinned info version as inert text and a real PNG in %s",
    async (theme) => {
      // The native info engine intentionally has no graph drawing. Qualify its
      // exact pinned version label and readable rasterized text independently,
      // without pretending that it has node/edge geometry like other families.
      const result = await renderMermaid("info", theme);
      expect(result.width).toBe(400);
      expect(result.height).toBe(100);
      const parsed = parsedSvg(result.svg);
      expect(textLabels(parsed)).toContain("12.0.0");
      expect(parsed.querySelectorAll("text").length).toBeGreaterThan(0);
      await decodeSvg(result.svg);
      const png = await pngPixels(
        await createMermaidPng(result, theme, new AbortController().signal),
      );
      expect(png.width).toBe(Math.ceil(result.width));
      expect(png.height).toBe(Math.ceil(result.height));
      const corner = png.data.slice(0, 3);
      let ink = 0;
      for (let offset = 0; offset < png.data.length; offset += 4) {
        if (
          Math.max(
            Math.abs(png.data[offset]! - corner[0]!),
            Math.abs(png.data[offset + 1]! - corner[1]!),
            Math.abs(png.data[offset + 2]! - corner[2]!),
          ) > 16
        )
          ink++;
      }
      expect(ink).toBeGreaterThan(100);
    },
  );

  it.each(["packet relative lengths", "sankey-beta"])(
    "does not mistake retained %s labels for a complete painted diagram",
    async (family) => {
      const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === family)!;
      const result = await renderMermaid(fixture.source, "light");
      const parsed = parsedSvg(result.svg);
      for (const shape of parsed.querySelectorAll(
        "path, rect, circle, ellipse, line, polygon, polyline",
      ))
        shape.remove();
      const noDrawing = {
        ...result,
        svg: new XMLSerializer().serializeToString(parsed.documentElement),
      };
      for (const label of fixture.labels) expect(textLabels(parsed)).toContain(label);
      const png = await pngPixels(
        await createMermaidPng(noDrawing, "light", new AbortController().signal),
      );
      const corner = png.data.slice(0, 3);
      let textInk = 0;
      for (let offset = 0; offset < png.data.length; offset += 4) {
        if (
          Math.max(
            Math.abs(png.data[offset]! - corner[0]!),
            Math.abs(png.data[offset + 1]! - corner[1]!),
            Math.abs(png.data[offset + 2]! - corner[2]!),
          ) > 16
        )
          textInk++;
      }
      // The negative is a real nonblank decoded PNG, not an export failure.
      // The same positive drawing oracle must reject its retained text alone.
      expect(textInk).toBeGreaterThan(100);
      await expect(expectDrawingSurvivesPng(noDrawing, "light")).rejects.toThrow(
        "PNG omitted retained native diagram drawing",
      );
    },
  );
});
