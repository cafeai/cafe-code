import { expect } from "vitest";
import { createMermaidPng } from "../lib/imageExport";
import type { MermaidResult } from "../lib/mermaid/renderService";

export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export function parsedSvg(svg: string): Document {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  expect(parsed.querySelector("parsererror")).toBeNull();
  expect(parsed.querySelector("foreignObject, script, image, a, use, animate, set")).toBeNull();
  for (const element of parsed.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      expect(attribute.name).not.toMatch(/^(?:on|href$|xlink:|xml:base$)/i);
      expect(attribute.value).not.toMatch(/(?:NaN|Infinity)/);
    }
  }
  return parsed;
}

export function textLabels(parsed: Document): string {
  const copy = parsed.cloneNode(true) as Document;
  for (const style of copy.querySelectorAll("style")) style.remove();
  // Native wrapping can place consecutive words in separate tspans. Joining
  // actual text nodes preserves those word boundaries instead of inventing a
  // missing-label failure from textContent's separator-free concatenation.
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  const labels: string[] = [];
  while (walker.nextNode()) labels.push(walker.currentNode.textContent ?? "");
  return labels.join(" ").replace(/\s+/g, " ");
}

export function expectAuthoredChartValues(family: string, parsed: Document): void {
  if (family === "quadrantChart") {
    const regions = Array.from(parsed.querySelectorAll(".quadrants rect"));
    expect(regions).toHaveLength(4);
    const left = Math.min(...regions.map((region) => Number(region.getAttribute("x"))));
    const top = Math.min(...regions.map((region) => Number(region.getAttribute("y"))));
    const right = Math.max(
      ...regions.map(
        (region) => Number(region.getAttribute("x")) + Number(region.getAttribute("width")),
      ),
    );
    const bottom = Math.max(
      ...regions.map(
        (region) => Number(region.getAttribute("y")) + Number(region.getAttribute("height")),
      ),
    );
    expect(right).toBeGreaterThan(left);
    expect(bottom).toBeGreaterThan(top);
    const points = Array.from(parsed.querySelectorAll(".data-points .data-point"));
    expect(points).toHaveLength(4);
    const expected = [
      ["Better labels", 0.2, 0.75],
      ["New layout engine", 0.8, 0.9],
      ["Spacing adjustment", 0.15, 0.2],
      ["Decorative animation", 0.75, 0.25],
    ] as const;
    // Native addPoints prepends each declaration. Bind the retained original
    // coordinate to its exact rendered label, not an invented source-order
    // invariant; duplicate/missing identities still fail before geometry.
    for (const [label, expectedX, expectedY] of expected) {
      const matching = points.filter((point) => point.querySelector("text")?.textContent === label);
      expect(matching).toHaveLength(1);
      const point = matching[0]!;
      const circle = point.querySelector("circle")!;
      expect(circle).not.toBeNull();
      expect((Number(circle.getAttribute("cx")) - left) / (right - left)).toBeCloseTo(expectedX, 5);
      expect((bottom - Number(circle.getAttribute("cy"))) / (bottom - top)).toBeCloseTo(
        expectedY,
        5,
      );
    }
  }
  if (family.startsWith("packet")) {
    const fields = Array.from(parsed.querySelectorAll("rect.packetBlock"));
    expect(fields).toHaveLength(5);
    const x = fields.map((field) => Number(field.getAttribute("x")));
    const y = fields.map((field) => Number(field.getAttribute("y")));
    const width = fields.map((field) => Number(field.getAttribute("width")));
    // Derive the native bit unit and inter-field padding from two authored
    // 8-bit fields. Different display defaults cannot conceal changed bit
    // lengths or row assignment for the following 16/32/32-bit fields.
    const unit = (x[1]! - x[0]!) / 8;
    const padding = x[1]! - x[0]! - width[0]!;
    expect(unit).toBeGreaterThan(0);
    expect(padding).toBeGreaterThanOrEqual(0);
    for (const [index, bits] of [8, 8, 16, 32, 32].entries())
      expect(width[index]).toBeCloseTo(bits * unit - padding, 5);
    expect(x[2]).toBeCloseTo(x[0]! + 16 * unit, 5);
    expect(x[3]).toBe(x[0]);
    expect(x[4]).toBe(x[0]);
    expect(y[0]).toBe(y[1]);
    expect(y[0]).toBe(y[2]);
    expect(y[3]).toBeGreaterThan(y[2]!);
    expect(y[4]).toBeGreaterThan(y[3]!);
    expect(
      Array.from(parsed.querySelectorAll(".packetByte.start"), (value) =>
        Number(value.textContent),
      ),
    ).toEqual([0, 8, 16, 32, 64]);
    expect(
      Array.from(parsed.querySelectorAll(".packetByte.end"), (value) => Number(value.textContent)),
    ).toEqual([7, 15, 31, 63, 95]);
  }
  if (family === "radar-beta") {
    expect(parsed.querySelectorAll(".radarAxisLine")).toHaveLength(4);
    const curves = Array.from(parsed.querySelectorAll("polygon[class^='radarCurve-']"));
    expect(curves).toHaveLength(2);
    const magnitudes = curves.map((curve) => {
      const points = (curve.getAttribute("points") ?? "")
        .trim()
        .split(/\s+/)
        .map((point) => point.split(",").map(Number));
      expect(points).toHaveLength(4);
      for (const point of points) {
        expect(point).toHaveLength(2);
        expect(point.every(Number.isFinite)).toBe(true);
      }
      return points.map((point) => Math.hypot(point[0]!, point[1]!));
    });
    // The authored domain starts at zero. Each matching axis radius must
    // therefore retain the exact source ratio across the two curves, regardless
    // of native chart dimensions or the radial grid's drawing style.
    for (const [index, ratio] of [8 / 7, 9 / 8, 9 / 5, 7 / 8].entries())
      expect(magnitudes[1]![index]! / magnitudes[0]![index]!).toBeCloseTo(ratio, 5);
  }
  if (family === "sankey-beta") {
    const flows = Array.from(parsed.querySelectorAll(".links .link path"));
    expect(flows).toHaveLength(5);
    const widths = flows.map((flow) => Number(flow.getAttribute("stroke-width")));
    for (const width of widths) expect(width).toBeGreaterThan(1);
    for (const [index, value] of [80, 20, 50, 30, 20].entries())
      expect(widths[index]! / widths[0]!).toBeCloseTo(value / 80, 5);
    expect(parsed.querySelectorAll(".nodes .node rect")).toHaveLength(5);
  }
  if (family === "treemap-beta") {
    const leaves = Array.from(parsed.querySelectorAll(".treemapLeafGroup"));
    expect(leaves).toHaveLength(6);
    for (const [label, value] of [
      ["Flowcharts", 40],
      ["Sequences", 25],
      ["Classes", 15],
      ["Entities", 10],
      ["Pie", 6],
      ["Radar", 4],
    ] as const) {
      const matching = leaves.filter(
        (leaf) => leaf.querySelector(".treemapLabel")?.textContent === label,
      );
      expect(matching).toHaveLength(1);
      expect(Number(matching[0]!.querySelector(".treemapValue")?.textContent)).toBe(value);
      const rectangle = matching[0]!.querySelector("rect.treemapLeaf")!;
      expect(Number(rectangle.getAttribute("width"))).toBeGreaterThan(0);
      expect(Number(rectangle.getAttribute("height"))).toBeGreaterThan(0);
    }
  }
  if (family === "eventmodeling") {
    expect(parsed.querySelectorAll("g.em-box")).toHaveLength(4);
    expect(parsed.querySelectorAll("g.em-box > text")).toHaveLength(4);
    const dataLines = Array.from(parsed.querySelectorAll("g.em-box tspan"))
      .map((span) => (span.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((line) => line === "title: string");
    expect(dataLines).toHaveLength(2);
  }
}

export async function decodeSvg(svg: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    expect(image.naturalWidth).toBeGreaterThan(0);
    expect(image.naturalHeight).toBeGreaterThan(0);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function pngPixels(blob: Blob): Promise<Pixels> {
  expect(blob.type).toBe("image/png");
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
      data: context.getImageData(0, 0, canvas.width, canvas.height).data,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function expectDrawingSurvivesPng(result: MermaidResult, theme: "light" | "dark") {
  const original = await pngPixels(
    await createMermaidPng(result, theme, new AbortController().signal),
  );
  expect(original.width).toBe(Math.ceil(result.width));
  expect(original.height).toBe(Math.ceil(result.height));
  const parsed = parsedSvg(result.svg);
  for (const shape of parsed.querySelectorAll(
    "path, rect, circle, ellipse, line, polygon, polyline",
  ))
    shape.remove();
  // This negative control retains the exact title, labels, original viewBox,
  // styles and image background. Text alone must not qualify an absent diagram
  // drawing, and a corner/background comparison cannot mistake a section tint
  // for the semantic geometry checked separately by each family fixture.
  const withoutDrawing = await pngPixels(
    await createMermaidPng(
      { ...result, svg: new XMLSerializer().serializeToString(parsed.documentElement) },
      theme,
      new AbortController().signal,
    ),
  );
  expect(withoutDrawing.width).toBe(original.width);
  expect(withoutDrawing.height).toBe(original.height);
  expect(original.data[3]).toBe(255);
  expect(original.data.at(-1)).toBe(255);
  let changed = 0;
  for (let offset = 0; offset < original.data.length; offset += 4) {
    if (
      Math.max(
        Math.abs(original.data[offset]! - withoutDrawing.data[offset]!),
        Math.abs(original.data[offset + 1]! - withoutDrawing.data[offset + 1]!),
        Math.abs(original.data[offset + 2]! - withoutDrawing.data[offset + 2]!),
      ) > 16
    )
      changed++;
  }
  expect(changed, "PNG omitted retained native diagram drawing").toBeGreaterThan(100);
}
