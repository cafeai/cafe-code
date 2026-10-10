import "../index.css";

import type { SavePngInput } from "@cafecode/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  copyPngToClipboard,
  createMermaidPng,
  rasterizeSvgToPng,
  savePngToDisk,
} from "../lib/imageExport";
import { renderMermaid, type MermaidResult } from "../lib/mermaid/renderService";
import { MermaidBlock } from "./MermaidBlock";
import { anchoredToastManager, toastManager } from "./ui/toast";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// Exercise every admitted engine through the actual opaque-origin renderer.
// A mocked rectangle cannot qualify labels, markers, chart geometry, or the
// SVG-to-image-to-canvas boundary used by the exported PNG.
const DIAGRAMS = [
  {
    family: "flowchart",
    source: 'flowchart LR\nA["First endpoint<br/>Multiline label"] --> B["Last endpoint 界"]',
  },
  { family: "sequence", source: "sequenceDiagram\nAlice->>Bob: Exported message" },
  { family: "class", source: "classDiagram\nAnimal <|-- Duck\nAnimal : +int age" },
  { family: "state", source: "stateDiagram-v2\n[*] --> Ready\nReady --> Done" },
  { family: "ER", source: "erDiagram\nCUSTOMER ||--o{ ORDER : places" },
  {
    family: "XY",
    source:
      'xychart-beta\n title "Visible series"\n x-axis ["First", "Middle", "Last"]\n y-axis "Units" 0 --> 100\n bar [20, 50, 80]\n line [30, 60, 90]',
  },
  {
    family: "pie",
    source: 'pie showData\n title Complete legend\n "First slice" : 25\n "Last slice" : 75',
  },
] as const;

interface PngPixels {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

async function readPng(blob: Blob): Promise<PngPixels> {
  expect(blob.type).toBe("image/png");
  // PNG signature and actual decoding qualify the output format separately
  // from a caller merely assigning an image/png MIME type to arbitrary bytes.
  expect(Array.from(new Uint8Array(await blob.slice(0, 8).arrayBuffer()))).toEqual([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function pixelAt(png: PngPixels, x: number, y: number): number[] {
  const offset = (y * png.width + x) * 4;
  return Array.from(png.pixels.slice(offset, offset + 4));
}

function inkCount(png: PngPixels, top = 0, bottom = png.height): number {
  const background = pixelAt(png, 0, 0);
  let ink = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4;
      if (
        Math.abs(png.pixels[offset]! - background[0]!) > 16 ||
        Math.abs(png.pixels[offset + 1]! - background[1]!) > 16 ||
        Math.abs(png.pixels[offset + 2]! - background[2]!) > 16
      )
        ink++;
    }
  }
  return ink;
}

function fixtureResult(contents: string, width = 100, height = 60): MermaidResult {
  return {
    svg: `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 ${width} ${height}">${contents}</svg>`,
    width,
    height,
    title: "Synthetic export fixture",
  };
}

function installExportTransportFixture() {
  const previous = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  let copyHandedOff!: (png: Uint8Array) => void;
  let saveHandedOff!: (input: SavePngInput) => void;
  const copied = new Promise<Uint8Array>((resolve) => {
    copyHandedOff = resolve;
  });
  const saved = new Promise<SavePngInput>((resolve) => {
    saveHandedOff = resolve;
  });
  const copyPng = vi.fn<(png: Uint8Array) => Promise<void>>().mockImplementation(async (png) => {
    copyHandedOff(png);
  });
  const savePng = vi
    .fn<(input: SavePngInput) => Promise<"saved" | "cancelled" | "failed">>()
    .mockImplementation(async (input) => {
      saveHandedOff(input);
      return "saved";
    });
  const copyText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  // Only the explicit write-only methods exercised here are present. No native
  // clipboard is read/written, and no save dialog or filesystem action runs.
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { copyPng, savePng, copyText },
  });
  // A wrongly selected browser fallback must also remain inert. The assertions
  // still require the desktop transport, so this catches branch regressions
  // without granting the fixture access to a real clipboard or download.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      write: vi.fn().mockResolvedValue(undefined),
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return {
    copyPng,
    savePng,
    copyText,
    copied,
    saved,
    restore() {
      if (previous) Object.defineProperty(window, "desktopBridge", previous);
      else Reflect.deleteProperty(window, "desktopBridge");
      if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("real Mermaid PNG export", () => {
  it.each(
    DIAGRAMS.flatMap((diagram) =>
      (["light", "dark"] as const).map((theme) => ({
        family: diagram.family,
        source: diagram.source,
        theme,
      })),
    ),
  )("exports the complete $family image in $theme", async ({ source, theme }) => {
    const result = await renderMermaid(source, theme);
    const png = await readPng(await createMermaidPng(result, theme, new AbortController().signal));
    // These ordinary fixtures fit the image budget. Export must therefore
    // preserve intrinsic diagram dimensions, rather than capture a preview's
    // bounded scroll viewport or the expanded viewer's current zoom.
    expect(png.width).toBe(Math.ceil(result.width));
    expect(png.height).toBe(Math.ceil(result.height));
    expect(inkCount(png)).toBeGreaterThan(100);
    const corner = pixelAt(png, 0, 0);
    expect(corner[3]).toBe(255);
    if (theme === "dark") expect(Math.max(...corner.slice(0, 3))).toBeLessThan(100);
    else expect(Math.min(...corner.slice(0, 3))).toBeGreaterThan(200);
    expect(document.querySelector('iframe[title="Isolated diagram renderer"]')).toBeNull();
  });

  it("retains ink at both ends of a diagram longer than the inline preview", async () => {
    const source = `flowchart TD\n${Array.from(
      { length: 12 },
      (_, index) => `N${index}["Endpoint ${index}"]${index < 11 ? ` --> N${index + 1}` : ""}`,
    ).join("\n")}`;
    const result = await renderMermaid(source, "light");
    expect(result.height).toBeGreaterThan(600);
    const png = await readPng(
      await createMermaidPng(result, "light", new AbortController().signal),
    );
    expect(png.height).toBe(Math.ceil(result.height));
    expect(inkCount(png, 0, Math.ceil(png.height / 10))).toBeGreaterThan(100);
    expect(inkCount(png, Math.floor((png.height * 9) / 10))).toBeGreaterThan(100);
  });

  it.each([
    { theme: "light" as const, documentDark: true },
    { theme: "dark" as const, documentDark: false },
  ])(
    "binds an explicit $theme background independently of the document theme",
    async ({ theme, documentDark }) => {
      const root = document.documentElement;
      const previousDark = root.classList.contains("dark");
      root.classList.toggle("dark", documentDark);
      try {
        const png = await readPng(
          await createMermaidPng(fixtureResult(""), theme, new AbortController().signal),
        );
        const corner = pixelAt(png, 0, 0);
        expect(corner[3]).toBe(255);
        if (theme === "dark") expect(Math.max(...corner.slice(0, 3))).toBeLessThan(100);
        else expect(Math.min(...corner.slice(0, 3))).toBeGreaterThan(200);
      } finally {
        root.classList.toggle("dark", previousDark);
      }
    },
  );
});

describe("PNG resource and cancellation boundary", () => {
  it("re-admits SVG before decoding and removes active or externally addressed content", async () => {
    const result = fixtureResult(
      "<script>globalThis.__diagramExportExecuted = true</script>" +
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://example.invalid/export-tracker" /></div></foreignObject>' +
        '<image href="https://example.invalid/export-image" width="30" height="30" />' +
        '<a href="javascript:alert(1)"><text x="4" y="20">Safe label</text></a>' +
        '<rect width="25" height="20" fill="#e03030" onload="globalThis.__diagramExportExecuted = true" />',
    );
    const sources: string[] = [];
    const setter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!.set!;
    vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function (
      this: HTMLImageElement,
      value,
    ) {
      sources.push(value);
      setter.call(this, value);
    });
    const blob = await createMermaidPng(result, "light", new AbortController().signal);
    // Inspect the admitted image document before the PNG-decoding helper adds
    // its own harmless blob URL. This assertion does not depend on the browser
    // deciding whether to block a malicious external image after admission.
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatch(/^data:image\/svg\+xml/);
    const svg = decodeURIComponent(sources[0]!.slice(sources[0]!.indexOf(",") + 1));
    expect(svg).not.toMatch(/foreignObject|<script|<image|href=|onload=|example\.invalid/);
    expect(Reflect.get(globalThis, "__diagramExportExecuted")).toBeUndefined();
    expect(inkCount(await readPng(blob))).toBeGreaterThan(100);
  });

  it.each([
    '.node { fill: url("https://example.invalid/export-tracker"); }',
    '.node { fill: u\\72l("https://example.invalid/export-tracker"); }',
    '@import "https://example.invalid/export-style";',
  ])("rejects resource-bearing generated CSS before image decode: %s", async (css) => {
    const decode = vi.spyOn(HTMLImageElement.prototype, "decode");
    await expect(
      createMermaidPng(
        fixtureResult(`<style>${css}</style><rect width="10" height="10"/>`),
        "light",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects XML stylesheet instructions before creating an image", async () => {
    const decode = vi.spyOn(HTMLImageElement.prototype, "decode");
    await expect(
      rasterizeSvgToPng({
        svg: `<?xml-stylesheet href="https://example.invalid/export-style"?><svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 100 60"/>`,
        width: 100,
        height: 60,
        background: "#ffffff",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });

  it.each([
    { width: 100_000, height: 1_000 },
    { width: 10_000, height: 10_000 },
  ])("bounds a $width by $height image while keeping both endpoints", async ({ width, height }) => {
    const svg = `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 ${width} ${height}"><rect width="${width / 10}" height="${height}" fill="#00ff00"/><rect x="${(width * 9) / 10}" width="${width / 10}" height="${height}" fill="#0000ff"/></svg>`;
    const png = await readPng(
      await rasterizeSvgToPng({
        svg,
        width,
        height,
        background: "#ffffff",
        signal: new AbortController().signal,
      }),
    );
    expect(Math.max(png.width, png.height)).toBeLessThanOrEqual(8192);
    expect(png.width * png.height).toBeLessThanOrEqual(16 * 1024 * 1024);
    // A canvas has integral dimensions. Uniform scale followed by rounding
    // can differ from the exact aspect ratio by at most one output pixel.
    expect(Math.abs(png.height - (png.width * height) / width)).toBeLessThanOrEqual(1);
    expect(pixelAt(png, 2, Math.floor(png.height / 2))).toEqual([0, 255, 0, 255]);
    expect(pixelAt(png, png.width - 3, Math.floor(png.height / 2))).toEqual([0, 0, 255, 255]);
  });

  it("rejects a cancelled export before creating or decoding an image", async () => {
    const controller = new AbortController();
    controller.abort();
    const decode = vi.spyOn(HTMLImageElement.prototype, "decode");
    await expect(createMermaidPng(fixtureResult(""), "light", controller.signal)).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });

  it("settles cancellation while image decoding is pending", async () => {
    const controller = new AbortController();
    let finishDecode!: () => void;
    const decode = vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDecode = resolve;
        }),
    );
    const pending = createMermaidPng(fixtureResult(""), "dark", controller.signal);
    const failure = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(decode).toHaveBeenCalled());
    controller.abort();
    await failure;
    finishDecode();
  });

  it("reports an image decode failure without producing a PNG", async () => {
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob");
    vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValue(
      new Error("Synthetic decode failure"),
    );
    await expect(
      createMermaidPng(fixtureResult(""), "light", new AbortController().signal),
    ).rejects.toThrow();
    expect(encode).not.toHaveBeenCalled();
  });

  it.each(["copy", "save"] as const)(
    "rechecks cancellation after byte preparation before native %s publication",
    async (action) => {
      const transport = installExportTransportFixture();
      const controller = new AbortController();
      const blob = await createMermaidPng(fixtureResult(""), "light", controller.signal);
      const arrayBuffer = blob.arrayBuffer.bind(blob);
      vi.spyOn(blob, "arrayBuffer").mockImplementation(() => {
        const prepared = arrayBuffer();
        // Revoke in the microtask between the inner byte preparation's final
        // check and its caller's continuation. Native publication needs its
        // own check immediately before crossing the write capability boundary.
        void prepared.then(() => queueMicrotask(() => controller.abort()));
        return prepared;
      });
      try {
        await expect(
          action === "copy"
            ? copyPngToClipboard(Promise.resolve(blob), controller.signal)
            : savePngToDisk(Promise.resolve(blob), "diagram.png", controller.signal),
        ).rejects.toThrow();
        expect(transport.copyPng).not.toHaveBeenCalled();
        expect(transport.savePng).not.toHaveBeenCalled();
      } finally {
        transport.restore();
      }
    },
  );
});

describe("diagram image actions preserve the viewer", () => {
  it("copies an image from Source without changing its tab or the exact source", async () => {
    await page.viewport(900, 700);
    const transport = installExportTransportFixture();
    const toast = vi.spyOn(toastManager, "add");
    const anchoredToast = vi.spyOn(anchoredToastManager, "add");
    const source = 'flowchart LR\nA["First endpoint"] --> B["Last endpoint"]';
    const screen = await render(<MermaidBlock code={source} complete theme="light" />);
    try {
      await vi.waitFor(
        () => expect(document.querySelector(".mermaid-preview img")).not.toBeNull(),
        { timeout: 20_000 },
      );
      await page.getByRole("button", { name: "Source", exact: true }).click();
      expect(document.querySelector(".mermaid-source code")?.textContent).toBe(source);
      await page.getByRole("button", { name: /diagram.*(?:image|actions)/i }).click();
      await page.getByRole("menuitem", { name: "Copy image", exact: true }).click();
      // Wait for the actual byte-ready handoff, not a short preparation poll.
      // The test and production decode deadlines still bound failures/stalls.
      const bytes = await transport.copied;
      expect(transport.copyPng).toHaveBeenCalledTimes(1);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(
        inkCount(await readPng(new Blob([new Uint8Array(bytes).buffer], { type: "image/png" }))),
      ).toBeGreaterThan(100);
      await expect
        .element(page.getByRole("button", { name: "Source", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
      expect(document.querySelector(".mermaid-source code")?.textContent).toBe(source);
      expect(transport.copyText).not.toHaveBeenCalled();
      expect(transport.savePng).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(toast.mock.calls.length + anchoredToast.mock.calls.length).toBe(1),
      );
      const titles = [...toast.mock.calls, ...anchoredToast.mock.calls].map(([options]) =>
        String(options.title),
      );
      expect(titles[0]).toMatch(/copied/i);
    } finally {
      await screen.unmount();
      transport.restore();
    }
  });

  it("exports through the expanded menu without closing, zooming, panning or a save toast", async () => {
    await page.viewport(900, 700);
    const transport = installExportTransportFixture();
    const toast = vi.spyOn(toastManager, "add");
    const anchoredToast = vi.spyOn(anchoredToastManager, "add");
    const source = `flowchart TD\n${Array.from(
      { length: 12 },
      (_, index) => `N${index}["Endpoint ${index}"]${index < 11 ? ` --> N${index + 1}` : ""}`,
    ).join("\n")}`;
    const screen = await render(<MermaidBlock code={source} complete theme="dark" />);
    try {
      await vi.waitFor(
        () => expect(document.querySelector(".mermaid-preview img")).not.toBeNull(),
        { timeout: 20_000 },
      );
      const originalImage = document.querySelector<HTMLImageElement>(".mermaid-preview img")!;
      await originalImage.decode();
      await page.getByRole("button", { name: "Expand diagram", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Expanded Mermaid diagram", exact: true });
      await expect.element(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Reset", exact: true }).click();
      await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
      expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("125%");
      const viewport = document.querySelector<HTMLElement>(".mermaid-expanded-viewport")!;
      await vi.waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight));
      viewport.scrollTop = 180;
      const scrollTop = viewport.scrollTop;
      await dialog.getByRole("button", { name: /diagram.*(?:image|actions)/i }).click();
      await page.getByRole("menuitem", { name: /save.*PNG/i }).click();
      // Only actual native invocation settles this preparation checkpoint;
      // an error toast or viewer state cannot stand in for successful export.
      const { png: bytes, suggestedName } = await transport.saved;
      expect(transport.savePng).toHaveBeenCalledTimes(1);
      const png = await readPng(new Blob([new Uint8Array(bytes).buffer], { type: "image/png" }));
      expect(suggestedName).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*\.png$/);
      const result = await renderMermaid(source, "dark");
      expect(png.width).toBe(Math.ceil(result.width));
      expect(png.height).toBe(Math.ceil(result.height));
      expect(inkCount(png, Math.floor((png.height * 9) / 10))).toBeGreaterThan(100);
      await expect.element(dialog).toBeVisible();
      expect(document.querySelector(".mermaid-zoom-value")?.textContent).toBe("125%");
      expect(viewport.scrollTop).toBe(scrollTop);
      expect(transport.copyPng).not.toHaveBeenCalled();
      expect(toast).not.toHaveBeenCalled();
      expect(anchoredToast).not.toHaveBeenCalled();
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByRole("button", { name: "Expand diagram", exact: true }))
        .toHaveFocus();
    } finally {
      await screen.unmount();
      transport.restore();
    }
  });
});
