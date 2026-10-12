import "../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { createMermaidPng } from "../lib/imageExport";
import { admitMermaidSource } from "../lib/mermaid/policy";
import { renderMermaid, type MermaidResult } from "../lib/mermaid/renderService";
import { createMermaidSandboxDocument } from "../lib/mermaid/sandboxDocument";
import { applyInterfaceScalePercent } from "../interfaceScale";
import { MermaidBlock } from "./MermaidBlock";
import { MERMAID_FAMILY_FIXTURES } from "./mermaidFamilies.test.fixture";

const mocks = vi.hoisted(() => ({ copy: vi.fn<(source: string) => Promise<void>>() }));
vi.mock("../lib/copyToClipboard", () => ({ copyTextToClipboard: mocks.copy }));

interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

function parsedSvg(svg: string): Document {
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

function textLabels(parsed: Document): string {
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

function expectAuthoredChartValues(family: string, parsed: Document): void {
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

async function decodeSvg(svg: string): Promise<void> {
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

async function pngPixels(blob: Blob): Promise<Pixels> {
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

async function expectDrawingSurvivesPng(result: MermaidResult, theme: "light" | "dark") {
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

/** Run the real pinned parser and production pre-layout admission in its
 * ordinary opaque document. Only the final renderer is replaced by a constant
 * sentinel, so large/cyclic boundary fixtures cannot enter expensive layout. */
async function admitsParsedFamily(
  source: string,
  parsedMutation = "",
  parserFixtureSource?: string,
  expectedNativeStateCalls?: number,
  expectedNativeParserCalls?: number,
): Promise<boolean> {
  const nonce = crypto.randomUUID();
  const id = crypto.randomUUID();
  const frame = document.createElement("iframe");
  const channel = new MessageChannel();
  frame.dataset.mermaidFamilySecurityFixture = "";
  frame.setAttribute("sandbox", "allow-scripts");
  const admittedSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" />';
  const override =
    parsedMutation || parserFixtureSource !== undefined
      ? `const nativeGetDiagram = mermaid.mermaidAPI.getDiagramFromText.bind(mermaid.mermaidAPI);
       const probeNativeGetDiagram = async (source) => {
         probeNativeParserCalls++;
         const diagram = await nativeGetDiagram(${parserFixtureSource === undefined ? "source" : JSON.stringify(parserFixtureSource)});
         const originalDb = diagram.db;
         const methodNames = new Set([...Object.getOwnPropertyNames(originalDb), ...Object.getOwnPropertyNames(Object.getPrototypeOf(originalDb))]);
         const methods = [...methodNames].filter(name => typeof originalDb[name] === 'function').map(name => [name, originalDb[name]]);
         ${parsedMutation}
         probeMutationApplied = diagram.db !== originalDb || methods.some(([name, method]) => diagram.db[name] !== method);
         return diagram;
       };
       mermaid.mermaidAPI = { ...mermaid.mermaidAPI, getDiagramFromText: probeNativeGetDiagram };
       probeParserReplacementInstalled = mermaid.mermaidAPI.getDiagramFromText === probeNativeGetDiagram;`
      : "";
  const documentSource = createMermaidSandboxDocument(nonce).replace(
    "</script></body>",
    `</script><script nonce="${nonce}">let probeMutationApplied = false; let probeNativeStateCalls = 0;
     let probeNativeParserCalls = 0; let probeParserReplacementInstalled = false;
     const nativePostMessage = MessagePort.prototype.postMessage;
     MessagePort.prototype.postMessage = function(value, ...transfer) {
       return nativePostMessage.call(this, { ...value, probeMutationApplied, probeNativeStateCalls, probeNativeParserCalls, probeParserReplacementInstalled }, ...transfer);
     };
     // The pre-layout probe deliberately replaces only final-image work. Its
     // empty sentinel is not a native event diagram and must not be passed to
     // the strict output adapter. Real SVG/PNG and adversarial output probes
     // below retain that adapter unchanged and qualify it independently.
     const nativeEventLabels = globalThis.cafeMermaidEventModelingSvgLabels;
     const nativeInfoViewport = globalThis.cafeMermaidInfoSvgViewport;
     if (typeof nativeEventLabels !== 'function' || typeof nativeInfoViewport !== 'function') throw new Error();
     globalThis.cafeMermaidEventModelingSvgLabels = svg => svg;
     globalThis.cafeMermaidInfoSvgViewport = svg => svg;
     mermaid.render = async () => ({ svg: ${JSON.stringify(admittedSvg)} });${override}</script></body>`,
  );
  return new Promise((resolve, reject) => {
    const finish = (admitted: boolean | undefined) => {
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      frame.remove();
      if (admitted === undefined) reject(new Error("Family admission probe did not reply"));
      else resolve(admitted);
    };
    const timeout = setTimeout(() => finish(undefined), 10_000);
    channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (!data || typeof data !== "object" || !("id" in data) || data.id !== id) return;
      if (
        parsedMutation &&
        !("probeMutationApplied" in data && data.probeMutationApplied === true)
      ) {
        clearTimeout(timeout);
        channel.port1.close();
        channel.port2.close();
        frame.remove();
        reject(new Error("The test-authored parsed database mutation was not applied"));
        return;
      }
      if (
        expectedNativeStateCalls !== undefined &&
        !(
          "probeNativeStateCalls" in data && data.probeNativeStateCalls === expectedNativeStateCalls
        )
      ) {
        clearTimeout(timeout);
        channel.port1.close();
        channel.port2.close();
        frame.remove();
        reject(
          new Error("The allocating native event-state resolver crossed its pre-layout fence"),
        );
        return;
      }
      if (
        expectedNativeParserCalls !== undefined &&
        !(
          "probeParserReplacementInstalled" in data &&
          data.probeParserReplacementInstalled === true &&
          "probeNativeParserCalls" in data &&
          data.probeNativeParserCalls === expectedNativeParserCalls
        )
      ) {
        clearTimeout(timeout);
        channel.port1.close();
        channel.port2.close();
        frame.remove();
        reject(new Error("The native parser crossed its pre-parse allocation fence"));
        return;
      }
      finish("svg" in data && data.svg === admittedSvg);
    };
    frame.onload = () => {
      frame.onload = null;
      frame.contentWindow?.postMessage("cafe-mermaid-render", "*", [channel.port2]);
      channel.port1.postMessage({ id, source, theme: "dark" });
    };
    frame.srcdoc = documentSource;
    document.body.append(frame);
  });
}

/** Observe the production output adapters after real native parsing and
 * rendering. Mutations below are static synthetic test code, never received
 * diagram source. The ordinary opaque document, CSP and one-use port remain
 * intact; no HTML/SVG is attached to the application document. */
async function renderNativeFamilyOutput(
  family: "eventmodeling" | "info",
  outputMutation = "",
): Promise<string | null> {
  const source =
    family === "info"
      ? "info"
      : MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === "eventmodeling")!.source;
  const nonce = crypto.randomUUID();
  const id = crypto.randomUUID();
  const frame = document.createElement("iframe");
  const channel = new MessageChannel();
  frame.dataset.mermaidFamilySecurityFixture = "";
  frame.setAttribute("sandbox", "allow-scripts");
  const documentSource = createMermaidSandboxDocument(nonce).replace(
    "</script></body>",
    `</script><script nonce="${nonce}">
       let probeOutputMutationApplied = false;
       const nativePostMessage = MessagePort.prototype.postMessage;
       MessagePort.prototype.postMessage = function(value, ...transfer) {
         return nativePostMessage.call(this, { ...value, probeOutputMutationApplied }, ...transfer);
       };
       const nativeRender = mermaid.render.bind(mermaid);
       mermaid.render = async (...args) => {
         const native = await nativeRender(...args);
         if (!${JSON.stringify(outputMutation)}) return native;
         const template = document.createElement('template');
         template.innerHTML = native.svg;
         const svg = template.content.querySelector('svg');
         const foreignObject = svg.querySelector('foreignObject');
         const bold = foreignObject?.querySelector('b');
         const code = svg.querySelector('foreignObject code');
         ${outputMutation}
         probeOutputMutationApplied = true;
         return { ...native, svg: template.innerHTML };
       };
     </script></body>`,
  );
  return new Promise((resolve, reject) => {
    const finish = (svg: string | null | undefined, error?: Error) => {
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      frame.remove();
      if (error) reject(error);
      else if (svg === undefined) reject(new Error("Native diagram-output probe did not reply"));
      else resolve(svg);
    };
    const timeout = setTimeout(() => finish(undefined), 10_000);
    channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (!data || typeof data !== "object" || !("id" in data) || data.id !== id) return;
      if (
        outputMutation &&
        !("probeOutputMutationApplied" in data && data.probeOutputMutationApplied === true)
      ) {
        finish(
          undefined,
          new Error("The test-authored native diagram-output mutation was not applied"),
        );
        return;
      }
      if ("svg" in data && typeof data.svg === "string") finish(data.svg);
      else if ("failed" in data && data.failed === true) {
        // A refusal must not disclose the synthetic label, parser error or any
        // other received content across the renderer's narrow result boundary.
        const fields = Object.keys(data)
          .filter((name) => name !== "probeOutputMutationApplied")
          .sort();
        if (fields.join(",") !== "failed,id") {
          finish(
            undefined,
            new Error("Native diagram-output refusal disclosed unqualified response fields"),
          );
          return;
        }
        finish(null);
      } else finish(undefined);
    };
    frame.onload = () => {
      frame.onload = null;
      frame.contentWindow?.postMessage("cafe-mermaid-render", "*", [channel.port2]);
      channel.port1.postMessage({ id, source, theme: "light" });
    };
    frame.srcdoc = documentSource;
    document.body.append(frame);
  });
}

afterEach(() => {
  mocks.copy.mockReset();
  vi.restoreAllMocks();
  applyInterfaceScalePercent(100);
  document.documentElement.classList.remove("dark");
  for (const frame of document.querySelectorAll("iframe[data-mermaid-family-security-fixture]"))
    frame.remove();
});

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

describe("new family pre-layout security admission", () => {
  it("does not accept an unfamiliar info version database", async () => {
    expect(await admitsParsedFamily("info")).toBe(true);
    expect(
      await admitsParsedFamily(
        "info",
        "diagram.db = { ...diagram.db, getVersion: () => '13.0.0' }; ",
      ),
    ).toBe(false);
  });

  it("preserves all native event labels and inline data as inert SVG text", async () => {
    const svg = await renderNativeFamilyOutput("eventmodeling");
    expect(svg).not.toBeNull();
    const parsed = parsedSvg(svg!);
    expect(parsed.querySelectorAll("g.em-box")).toHaveLength(4);
    expect(parsed.querySelectorAll("g.em-box > text")).toHaveLength(4);
    for (const label of ["TaskForm", "CreateTask", "TaskCreated", "TaskList"])
      expect(textLabels(parsed)).toContain(label);
    const dataLines = Array.from(parsed.querySelectorAll("g.em-box tspan"))
      .map((span) => (span.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((line) => line === "title: string");
    expect(dataLines).toHaveLength(2);
    await decodeSvg(svg!);
  });

  it.each([
    ["resource-bearing HTML", "bold.append(document.createElement('img'));"],
    ["interactive HTML", "bold.append(document.createElement('a'));"],
    ["script HTML", "bold.append(document.createElement('script'));"],
    ["nested arbitrary formatting", "bold.append(document.createElement('i'));"],
    ["HTML comments", "bold.append(document.createComment('private-synthetic-label'));"],
    ["HTML event handlers", "bold.setAttribute('onclick', 'private-synthetic-label');"],
    ["HTML links", "bold.setAttribute('href', 'https://example.invalid/synthetic');"],
    [
      "unqualified native wrapper style",
      "foreignObject.querySelector('span').style.color = 'red';",
    ],
    ["unqualified inline data style", "code.style.maxWidth = '100000px';"],
    ["unknown foreign-object attributes", "foreignObject.setAttribute('class', 'unexpected');"],
    ["non-finite box geometry", "foreignObject.setAttribute('width', 'Infinity');"],
    ["non-finite native viewport", "svg.setAttribute('viewBox', '0 0 Infinity 100');"],
    ["non-decimal native viewport", "svg.setAttribute('viewBox', '0 0 0x100 100');"],
    [
      "non-finite native relation geometry",
      "svg.querySelector('path.em-relation').setAttribute('d', 'M0 0 LNaN 100');",
    ],
    [
      "overflowing native rectangle coordinates",
      "foreignObject.parentNode.querySelector('rect').setAttribute('x', '1e308');",
    ],
    ["zero box geometry", "foreignObject.setAttribute('height', '0');"],
    [
      "mismatched native box coordinates",
      "foreignObject.setAttribute('x', String(Number(foreignObject.getAttribute('x')) + 1));",
    ],
    [
      "mismatched native rectangle geometry",
      "foreignObject.parentNode.querySelector('rect').setAttribute('width', '99999');",
    ],
    [
      "unknown native rounding",
      "foreignObject.parentNode.querySelector('rect').setAttribute('rx', '4');",
    ],
    [
      "unqualified foreign-object parent",
      "foreignObject.parentNode.setAttribute('class', 'ordinary-html-box');",
    ],
    [
      "unexpected native box siblings",
      "foreignObject.parentNode.append(document.createElementNS('http://www.w3.org/2000/svg', 'text'));",
    ],
    ["HTML outside native foreign objects", "svg.append(document.createElement('div'));"],
    [
      "unqualified label line count",
      "bold.replaceChildren(...Array.from({ length: 251 }, () => document.createElement('br')));",
    ],
    ["unreadably overwide labels", "bold.textContent = 'W'.repeat(1000);"],
  ])("refuses %s without widening event HTML or SVG admission", async (_name, mutation) => {
    expect(await renderNativeFamilyOutput("eventmodeling", mutation)).toBeNull();
  });

  it("binds only the exact pinned native info label to its fixed viewport", async () => {
    const svg = await renderNativeFamilyOutput("info");
    expect(svg).not.toBeNull();
    const parsed = parsedSvg(svg!);
    expect(parsed.documentElement.getAttribute("viewBox")).toBe("0 0 400 100");
    expect(parsed.querySelectorAll("text")).toHaveLength(1);
    expect(parsed.querySelector("text")?.textContent).toBe("v12.0.0");
    await decodeSvg(svg!);
  });

  it.each([
    ["a source-shaped viewport", "svg.setAttribute('viewBox', '0 0 99999 99999');"],
    ["a future version label", "svg.querySelector('text').textContent = 'v13.0.0';"],
    ["a foreign fixed width", "svg.style.maxWidth = '500px';"],
    ["a foreign namespace", "svg.setAttribute('xmlns', 'urn:unqualified');"],
    ["extra HTML", "svg.append(document.createElement('div'));"],
    [
      "extra SVG drawings",
      "svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'circle'));",
    ],
    [
      "nested version markup",
      "svg.querySelector('text').append(document.createElementNS('http://www.w3.org/2000/svg', 'tspan'));",
    ],
    [
      "version event handlers",
      "svg.querySelector('text').setAttribute('onclick', 'private-synthetic-label');",
    ],
    ["a changed native label origin", "svg.querySelector('text').setAttribute('x', '101');"],
    [
      "non-finite version font geometry",
      "svg.querySelector('text').setAttribute('font-size', 'NaN');",
    ],
    [
      "extra native container text",
      "svg.querySelector('g').append(document.createTextNode('private-synthetic-label'));",
    ],
    [
      "unqualified version links",
      "svg.querySelector('text').setAttribute('href', 'https://example.invalid/synthetic');",
    ],
  ])("refuses %s instead of inventing a generic info viewport", async (_name, mutation) => {
    expect(await renderNativeFamilyOutput("info", mutation)).toBeNull();
  });

  it.each(MERMAID_FAMILY_FIXTURES)(
    "refuses source configuration and callbacks for $family at both boundaries",
    async ({ source }) => {
      for (const hostile of [
        `%%{init: {"securityLevel":"loose"}}%%\n${source}`,
        `${source}\nclick target "https://example.invalid/diagram"`,
        `---\nconfig:\n  securityLevel: loose\n---\n${source}`,
      ]) {
        expect(() => admitMermaidSource(hostile)).toThrow();
        expect(await admitsParsedFamily(hostile)).toBe(false);
      }
    },
  );

  it.each([
    {
      family: "journey",
      mutation: "diagram.db.getTasks = () => null;",
    },
    {
      family: "quadrantChart",
      mutation:
        "const native = diagram.db.getQuadrantData.bind(diagram.db); diagram.db.getQuadrantData = () => { const value = native(); value.points[0].x = Infinity; return value; };",
    },
    {
      family: "requirementDiagram",
      mutation: "diagram.db.getRequirements = () => [];",
    },
    {
      family: "gitGraph horizontal merge",
      mutation:
        "const native = diagram.db.getCommits.bind(diagram.db); diagram.db.getCommits = () => { const value = native(); value.values().next().value.seq = NaN; return value; };",
    },
    {
      family: "timeline",
      mutation: "diagram.db = { ...diagram.db, getTasks: () => [undefined] };",
    },
    {
      family: "sankey-beta",
      mutation:
        "const native = diagram.db.getLinks.bind(diagram.db); diagram.db.getLinks = () => { const value = native(); value[0].value = Infinity; return value; };",
    },
    {
      family: "block-beta",
      mutation:
        "const native = diagram.db.getBlocksFlat.bind(diagram.db); diagram.db.getBlocksFlat = () => { const value = native(); value[0].widthInColumns = 1000000000; return value; };",
    },
    {
      family: "packet relative lengths",
      mutation:
        "const native = diagram.db.getPacket.bind(diagram.db); diagram.db.getPacket = () => { const value = native(); value[0][0].bits = NaN; return value; };",
    },
    {
      family: "kanban",
      mutation:
        "const native = diagram.db.getData.bind(diagram.db); diagram.db.getData = () => { const value = native(); value.nodes[0].label = {}; return value; };",
    },
    {
      family: "radar-beta",
      mutation:
        "const native = diagram.db.getCurves.bind(diagram.db); diagram.db.getCurves = () => { const value = native(); value[0].entries[0] = Infinity; return value; };",
    },
    {
      family: "treemap-beta",
      mutation:
        "const native = diagram.db.getRoot.bind(diagram.db); diagram.db.getRoot = () => { const value = native(); value.children = [value]; return value; };",
    },
    {
      family: "mindmap",
      mutation:
        "const native = diagram.db.getMindmap.bind(diagram.db); diagram.db.getMindmap = () => { const value = native(); value.children = [value]; return value; };",
    },
    {
      family: "architecture-beta",
      mutation:
        "const native = diagram.db.getNodes.bind(diagram.db); diagram.db.getNodes = () => { const value = native(); value[0].icon = 'external:unqualified'; return value; };",
    },
    {
      family: "C4Context",
      mutation:
        "const native = diagram.db.getC4ShapeArray.bind(diagram.db); diagram.db.getC4ShapeArray = () => { const value = native(); value[0].label = { text: {} }; return value; };",
    },
    {
      family: "swimlane-beta",
      mutation:
        "const native = diagram.db.getData.bind(diagram.db); diagram.db.getData = () => { const value = native(); value.nodes[0].parentId = value.nodes[0].id; return value; };",
    },
    {
      family: "agentflow-beta",
      mutation:
        "const native = diagram.db.getVertices.bind(diagram.db); diagram.db.getVertices = () => { const value = native(); value.values().next().value.img = 'https://example.invalid/hidden'; return value; };",
    },
    {
      family: "usecase-beta",
      mutation: "diagram.db.getJsonNodes = () => new Map([['hidden', {}]]);",
    },
    {
      family: "eventmodeling",
      mutation:
        "const native = diagram.db.getState.bind(diagram.db); diagram.db.getState = () => { const value = native(); value.boxes[0].x = Infinity; return value; };",
    },
    {
      family: "venn-beta",
      mutation:
        "const native = diagram.db.getSubsetData.bind(diagram.db); diagram.db.getSubsetData = () => { const value = native(); value[0].size = Infinity; return value; };",
    },
    {
      family: "ishikawa-beta",
      mutation:
        "const native = diagram.db.getRoot.bind(diagram.db); diagram.db.getRoot = () => { const value = native(); value.children = [value]; return value; };",
    },
    {
      family: "wardley-beta",
      mutation:
        "const native = diagram.db.getWardleyData.bind(diagram.db); diagram.db.getWardleyData = () => { const value = native(); value.nodes[0].x = Infinity; return value; };",
    },
    {
      family: "cynefin-beta",
      mutation: "diagram.db.getDomains = () => ({});",
    },
    {
      family: "treeView-beta",
      mutation: "diagram.db.getCount = () => NaN;",
    },
    ...["railroad-beta", "railroad-ebnf-beta", "railroad-abnf-beta", "railroad-peg-beta"].map(
      (family) => ({
        family,
        mutation:
          "const native = diagram.db.getRules.bind(diagram.db); diagram.db.getRules = () => { const value = native(); value[0].definition = { type: 'sequence', elements: [] }; value[0].definition.elements = [value[0].definition]; return value; };",
      }),
    ),
  ])("fails closed before layout for changed $family parsed data", async ({ family, mutation }) => {
    const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === family)!;
    expect(await admitsParsedFamily(fixture.source)).toBe(true);
    expect(await admitsParsedFamily(fixture.source, mutation)).toBe(false);
  });

  it.each(["swimlane-beta", "agentflow-beta", "usecase-beta"])(
    "refuses aggregate rank amplification in the real %s parsed contract",
    async (family) => {
      const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === family)!;
      const getter = family === "usecase-beta" ? "getRelationships" : "getData";
      const edges = family === "usecase-beta" ? "value" : "value.edges";
      // Each rank is individually below the 250 limit. Their combined native
      // dummy-rank work is not, so an element-only bound cannot pass this case.
      const mutation = `const native = diagram.db.${getter}.bind(diagram.db);
        diagram.db.${getter} = () => { const value = native(); const edges = ${edges};
        edges[0].minlen = 125; edges[1].minlen = 126; return value; };`;
      expect(await admitsParsedFamily(fixture.source)).toBe(true);
      expect(await admitsParsedFamily(fixture.source, mutation)).toBe(false);
    },
  );

  it.each([
    {
      name: "same-line reset-frame declarations",
      source: `eventmodeling ${Array.from({ length: 251 }, (_, index) => `rf ${index} ui Task`).join(" ")}`,
    },
    {
      name: "same-line repeated dependencies",
      source: `eventmodeling tf 01 ui Task${" ->> 01".repeat(251)}`,
    },
    {
      name: "unresolved native dependency identities",
      source: "eventmodeling tf 01 ui Task ->> 99",
    },
    {
      name: "forward native dependencies omitted by one-pass resolution",
      source: "eventmodeling tf 01 ui Task ->> 02 tf 02 cmd Done",
    },
  ])("refuses $name before the allocating native event-state resolver", async ({ source }) => {
    const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === "eventmodeling")!;
    const mutation = `const native = diagram.db.getState.bind(diagram.db);
      diagram.db.getState = () => { probeNativeStateCalls++; return native(); };`;
    // The real parser receives a known-safe same-family fixture so allocation
    // cannot hide a missing raw token fence. Production still receives the
    // exact hostile source as its admission input; no source is rewritten by
    // the application. The method-replacement proof must be active and the
    // resolver count must remain exactly zero when the guard refuses.
    expect(await admitsParsedFamily(fixture.source, mutation, fixture.source)).toBe(true);
    expect(await admitsParsedFamily(source, mutation, fixture.source, 0)).toBe(false);
  });

  it("admits an exact native event inline payload with retained trailing whitespace", async () => {
    expect(await admitsParsedFamily("eventmodeling\ntf 01 ui Task { title: string }")).toBe(true);
  });

  it.each([
    ["an inline brace payload whose final character would be lost", "{title:string}"],
    ["double-quoted data the native renderer treats as braces", '"quoted data"'],
    ["single-quoted data the native renderer treats as braces", "'quoted data'"],
    ["unqualified inline markup", "{ <b>html</b> }"],
  ])("refuses %s before native event-state allocation", async (_name, payload) => {
    const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === "eventmodeling")!;
    const mutation = `const native = diagram.db.getState.bind(diagram.db);
      diagram.db.getState = () => { probeNativeStateCalls++; return native(); };`;
    expect(await admitsParsedFamily(fixture.source, mutation, fixture.source)).toBe(true);
    expect(
      await admitsParsedFamily(
        `eventmodeling\ntf 01 ui Task ${payload}`,
        mutation,
        fixture.source,
        0,
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "journey task, section and distinct actors",
      source: (count: number) =>
        `journey\nsection Build\nCompile: 5: ${Array.from({ length: count }, (_, index) => `Actor${index}`).join(", ")}`,
      accepted: 248,
      rejected: 249,
    },
    {
      name: "timeline task and every event",
      source: (count: number) =>
        `timeline\n2026 : ${Array.from({ length: count }, (_, index) => `Event${index}`).join(" : ")}`,
      accepted: 249,
      rejected: 250,
    },
    {
      name: "gitGraph commits and native main branch",
      source: (count: number) =>
        `gitGraph\n${Array.from({ length: count }, (_, index) => `commit id: "Commit${index}"`).join("\n")}`,
      accepted: 249,
      rejected: 250,
    },
    {
      name: "requirement declarations",
      source: (count: number) =>
        `requirementDiagram\n${Array.from({ length: count }, (_, index) => `requirement R${index} {\nid: R${index}\ntext: Item\nrisk: low\nverifymethod: test\n}`).join("\n")}`,
      accepted: 250,
      rejected: 251,
    },
    {
      name: "sankey actual nodes along a directed path",
      source: (count: number) =>
        `sankey-beta\n\n${Array.from({ length: count - 1 }, (_, index) => `Node${index},Node${index + 1},1`).join("\n")}`,
      accepted: 250,
      rejected: 251,
    },
    {
      name: "mindmap native recursive depth independently of node count",
      source: (depth: number) =>
        `mindmap\nRoot\n${Array.from({ length: depth }, (_, index) => `${"  ".repeat(index + 1)}Depth${index}`).join("\n")}`,
      accepted: 64,
      rejected: 65,
    },
    {
      name: "Venn numerical solver circles independently of subset budget",
      source: (count: number) =>
        `venn-beta\n${Array.from({ length: count }, (_, index) => `set Circle${index}`).join("\n")}`,
      accepted: 8,
      rejected: 9,
    },
  ])("counts $name before layout", async ({ source, accepted, rejected }) => {
    expect(await admitsParsedFamily(source(accepted))).toBe(true);
    expect(await admitsParsedFamily(source(rejected))).toBe(false);
  });

  it.each([
    ["journey outside native score rail", "journey\nCompile: 6: User"],
    ["journey prototype actor", "journey\nCompile: 5: __proto__"],
    ["sankey directed cycle", "sankey-beta\n\nA,B,1\nB,A,1"],
    ["sankey self loop", "sankey-beta\n\nA,A,1"],
    ["sankey zero flow", "sankey-beta\n\nA,B,0"],
    ["sankey negative flow", "sankey-beta\n\nA,B,-1"],
    ["sankey overflowed flow", "sankey-beta\n\nA,B,1e309"],
    ["block allocating unbounded spacer", "block-beta\nspace:1000000000"],
    ["block unbounded columns", "block-beta\ncolumns 1000000000\nA[Item]"],
    ["block unbounded span", "block-beta\nA[Item]:1000000000"],
    [
      "block external style resource",
      'block-beta\nA[Item]\nstyle A fill:url("https://example.invalid/paint")',
    ],
    ["packet allocating unbounded bit rows", 'packet\n+1000000000: "Huge field"'],
    ["packet noncontiguous fields", 'packet\n0-7: "First"\n16-31: "Skipped"'],
    ["packet zero length", 'packet\n+0: "Empty"'],
    ["packet reversed field", 'packet\n0-7: "First"\n8-3: "Reversed"'],
    [
      "radar singular scale",
      'radar-beta\naxis a["A"], b["B"], c["C"]\ncurve one["One"]{1,1,1}\nmin 1\nmax 1',
    ],
    [
      "radar mismatched entries",
      'radar-beta\naxis a["A"], b["B"], c["C"]\ncurve one["One"]{1,2}\nmax 3',
    ],
    ["treemap zero-valued leaf", 'treemap-beta\n"Root"\n "Empty": 0'],
    ["treemap subnormal layout scale", 'treemap-beta\n"Root"\n "Tiny": 1e-320'],
    ["treemap overflowed total", 'treemap-beta\n"Root"\n "First": 1e308\n "Second": 1e308'],
    [
      "radar overflowing domain",
      'radar-beta\naxis a["A"], b["B"], c["C"]\ncurve one["One"]{1,2,3}\nmin -1e308\nmax 1e308',
    ],
    [
      "architecture custom icon acquisition",
      "architecture-beta\nservice app(external:server)[Application]",
    ],
    ["eventmodeling prototype identity", "eventmodeling\ntf 01 ui __proto__"],
    ["Wardley out-of-domain coordinate", "wardley-beta\ncomponent Node [101, 50]"],
    [
      "Wardley extreme native drawing size",
      "wardley-beta\ncomponent Node [0.5, 0.5]\nsize [1000000000,1000000000]",
    ],
    ["railroad semantically lost finite repetition", 'railroad-abnf-beta\nrule = 3"alpha" ;'],
  ])("refuses unsafe %s before final layout", async (_name, source) => {
    expect(await admitsParsedFamily(source)).toBe(false);
  });

  it.each([
    ["packet relative lengths", 'packet\n+1000000000: "Huge field"'],
    ["packet-beta absolute offsets", 'packet-beta\n0-1000000000: "Huge field"'],
    ["block-beta", "block-beta\nspace:1000000000"],
    ["block-beta", "block-beta\ncolumns 1000000000\nA[Item]"],
    ["block-beta", "block-beta\nA[Item]:1000000000"],
    ["block-beta", "block-beta\nspace:250\nspace:250"],
  ])(
    "refuses allocating %s syntax before entering even a safe parser substitute",
    async (family, source) => {
      const fixture = MERMAID_FAMILY_FIXTURES.find((entry) => entry.family === family)!;
      // The fixed test-only parser substitute returns the real, known valid
      // database for this SAME family. Its final layout is still a sentinel. If
      // unsafe source were only rejected by post-parse graph counts, substituting
      // this bounded graph would admit it. Refusal proves raw preflight ran before
      // the parser's spacer/bit-row allocation. Production never substitutes DSL.
      expect(await admitsParsedFamily(fixture.source, "", fixture.source)).toBe(true);
      expect(await admitsParsedFamily(source, "", fixture.source)).toBe(false);
    },
  );

  it.each(
    (["packet", "packet-beta"] as const).flatMap((header) =>
      (["relative", "absolute"] as const).flatMap((syntax) =>
        (["first-header-line", "later-line"] as const).map((position) => ({
          header,
          syntax,
          position,
        })),
      ),
    ),
  )(
    "refuses huge $header $syntax $position fields before native parser entry",
    async ({ header, syntax, position }) => {
      const fixture = MERMAID_FAMILY_FIXTURES.find(
        (entry) => entry.family === "packet relative lengths",
      )!;
      const prefix =
        position === "later-line"
          ? syntax === "relative"
            ? '+8: "First"\n'
            : '0-7: "First"\n'
          : "";
      const huge =
        syntax === "relative"
          ? '+1000000000: "Huge field"'
          : `${position === "later-line" ? 8 : 0}-1000000000: "Huge field"`;
      // Only the tiny known-safe packet fixture could reach the real parser.
      // The substitute identity is independently proven installed, its safe
      // control must enter exactly once, and each hostile header/later-line source
      // must be refused with exactly zero native parser calls. Never pass the
      // enormous field to Mermaid to discover the parser's allocation bound.
      expect(await admitsParsedFamily(fixture.source, "", fixture.source, undefined, 1)).toBe(true);
      expect(
        await admitsParsedFamily(`${header} ${prefix}${huge}`, "", fixture.source, undefined, 0),
      ).toBe(false);
    },
  );
});
