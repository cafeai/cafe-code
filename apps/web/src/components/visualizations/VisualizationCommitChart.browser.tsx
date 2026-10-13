import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_MONO_FONT_FAMILY,
  CHAT_SANS_FONT_FAMILY,
  GENERATED_VISUALIZATION_FONT_FAMILY_STYLE,
} from "@cafecode/shared/chatTypography";
import { loadGeneratedVisualizationFontFaces } from "@cafecode/shared/visualizationFonts";
import chartSource from "./visualizationCommitChart.fixture.html?raw";

interface ChartClock {
  flush(time: number): void;
  pending(): number;
  maximum(): number;
}
interface ChartWindow extends Window {
  __chartClock: ChartClock;
  FontFace: typeof FontFace;
}
interface ChartFixture {
  frame: HTMLIFrameElement;
  window: ChartWindow;
  document: Document;
  chart: SVGSVGElement;
  fonts: readonly FontFace[];
}
const fixtures: ChartFixture[] = [];

// The deterministic clock belongs only to this synthetic chart document. It
// neither changes runner device/media policy nor pretends to qualify native
// fluid pixels, GPU use, host sizing, leases or provider execution.
const clockSource = `(() => {
  const pending = new Map();
  let next = 1, maximum = 0;
  window.requestAnimationFrame = callback => {
    const id = next++; pending.set(id, callback);
    maximum = Math.max(maximum, pending.size); return id;
  };
  window.cancelAnimationFrame = id => pending.delete(id);
  window.__chartClock = {
    flush(time) {
      const batch = Array.from(pending.values()); pending.clear();
      for (const callback of batch) callback(time);
    },
    pending: () => pending.size,
    maximum: () => maximum,
  };
})();`;

async function fixture(width = 780, theme: "light" | "dark" = "dark", visible = true) {
  const frame = document.createElement("iframe");
  frame.style.cssText = `width:${width}px;height:620px;border:0;max-width:none`;
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener("load", () => resolve(), { once: true }),
  );
  const colors =
    theme === "dark"
      ? "--foreground:#e8edf5;--background:#15171c;--muted-foreground:#bac6d9;--chart-1:#22d3ee;--chart-2:#619cff;--chart-3:#ae88ff"
      : "--foreground:#152238;--background:#fafbff;--muted-foreground:#46576f;--chart-1:#087e8b;--chart-2:#3458c7;--chart-3:#8344ba";
  // Start without chart source. Fixed binary FontFace loading occurs in this
  // exact child's realm under the existing no-font-fetch CSP. Native Electron
  // separately qualifies isolated-preload sharing and user-origin precedence;
  // this browser fixture must not pretend an author stylesheet proves either.
  const csp =
    "default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';font-src 'none';connect-src 'none'";
  frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body></body></html>`;
  document.body.append(frame);
  await loaded;
  const window = frame.contentWindow as ChartWindow;
  const chartDocument = frame.contentDocument!;
  try {
    expect(chartDocument.querySelector("#chart")).toBeNull();
    const fonts = await loadGeneratedVisualizationFontFaces("generated", window.FontFace);
    expect(fonts).toHaveLength(4);
    expect(fonts.every((font) => font.status === "loaded")).toBe(true);
    // document.open creates the replacement font set. Add these same already
    // loaded objects after replacement, before any authored HTML or script is
    // parsed, matching the production source-admission ordering.
    chartDocument.open();
    chartDocument.write(
      `<!doctype html><html data-cafe-visible="${visible}"><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>:root{${colors}}${GENERATED_VISUALIZATION_FONT_FAMILY_STYLE}</style><script>${clockSource}</script></head><body>`,
    );
    for (const font of fonts) chartDocument.fonts.add(font);
    expect([...chartDocument.fonts]).toEqual(fonts);
    expect(chartDocument.querySelector("#chart")).toBeNull();
    chartDocument.write(chartSource);
    chartDocument.write("</body></html>");
    chartDocument.close();
    const value: ChartFixture = {
      frame,
      window,
      document: chartDocument,
      chart: chartDocument.querySelector<SVGSVGElement>("#chart")!,
      fonts,
    };
    fixtures.push(value);
    await vi.waitFor(() => expect(value.chart.viewBox.baseVal.width).toBeGreaterThan(0));
    return value;
  } catch (error) {
    // Failed font/source admission must not leave a fixture document alive or
    // rely on successful setup to register its later pagehide cleanup.
    window.dispatchEvent(new Event("pagehide"));
    frame.remove();
    throw error;
  }
}

function settled(value: ChartFixture, start = 0) {
  value.window.__chartClock.flush(start);
  value.window.__chartClock.flush(start + 651);
  expect(value.chart.dataset.animation).toBe("settled");
  expect(value.window.__chartClock.pending()).toBe(0);
}
function text(value: ChartFixture, id: string) {
  return value.document.getElementById(id)!.textContent!;
}
function line(value: ChartFixture) {
  return value.chart.querySelector("[data-chart-line]")!.getAttribute("d");
}
function select(value: ChartFixture, days: number) {
  value.document.querySelector<HTMLButtonElement>(`[data-days="${days}"]`)!.click();
}
function expectSummary(value: ChartFixture, days: number) {
  const data = JSON.parse(text(value, "data")) as { daily: [string, number][] };
  const counts = data.daily.slice(-days).map((row) => row[1]);
  const total = counts.reduce((sum, count) => sum + count, 0);
  expect(text(value, "total")).toBe(String(total));
  expect(text(value, "average")).toBe((total / days).toFixed(1));
  expect(text(value, "active")).toBe(`${counts.filter((count) => count > 0).length}/${days}`);
  expect(text(value, "peak")).toBe(String(Math.max(...counts)));
  expect(value.chart.dataset.days).toBe(String(days));
}
function expectResponsive(value: ChartFixture) {
  const rectangle = value.chart.getBoundingClientRect();
  const box = value.chart.viewBox.baseVal;
  expect(box.width).toBeCloseTo(rectangle.width, 5);
  expect(box.height).toBeCloseTo(rectangle.height, 5);
  const transform = value.chart.getScreenCTM()!;
  expect(transform.a).toBeCloseTo(1, 5);
  expect(transform.d).toBeCloseTo(1, 5);
  expect(transform.b).toBe(0);
  expect(transform.c).toBe(0);
  expect(value.chart.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
  for (const label of value.chart.querySelectorAll<SVGTextElement>("text")) {
    const bounds = label.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(rectangle.left - 1);
    expect(bounds.right).toBeLessThanOrEqual(rectangle.right + 1);
    expect(value.window.getComputedStyle(label).fontSize).toBe("10px");
    // The loaded proportional chat face is measured in actual CSS units. The
    // existing identity CTM plus glyph-length equality rejects nonuniform SVG
    // stretching without substituting a guessed screenshot/font declaration.
    expect(label.getComputedTextLength()).toBeCloseTo(bounds.width, 3);
  }
  expect(value.document.documentElement.scrollWidth).toBe(value.frame.clientWidth);
  const unit = value.document.querySelector<HTMLElement>(".unit")!;
  expect(unit.scrollHeight).toBe(unit.clientHeight);
}

function normalizedFamily(value: string) {
  return value.replaceAll('"', "").replaceAll("'", "").replaceAll(/\s+/g, " ").trim();
}
function computedFamily(value: ChartFixture, canonicalFamily: string) {
  // Chromium canonicalizes its unquoted BlinkMacSystemFont alias to system-ui
  // in computed style. Resolve the exact canonical stack in this same child
  // instead of accepting arbitrary aliases, dropping fallback entries, or
  // weakening the strict computed-family equality below. The hidden probe's
  // inline author-important declaration also avoids inheriting the fixture's
  // ordinary author-origin family default when measuring the mono stack.
  const probe = value.document.createElement("span");
  probe.hidden = true;
  probe.style.setProperty("font-family", canonicalFamily, "important");
  value.document.body.append(probe);
  const result = value.window.getComputedStyle(probe).fontFamily;
  probe.remove();
  return result;
}
async function expectChatTypography(value: ChartFixture) {
  expect(value.fonts).toHaveLength(4);
  expect([...value.document.fonts]).toEqual(value.fonts);
  expect(value.fonts.map((font) => font.style).toSorted()).toEqual([
    "italic",
    "italic",
    "normal",
    "normal",
  ]);
  for (const font of value.fonts) {
    expect(font.status).toBe("loaded");
    expect(normalizedFamily(font.family)).toBe("DM Sans Variable");
    expect(font.weight).toBe("100 1000");
  }
  // FontFaceSet.check can return true for an absent face, so require the actual
  // normal/italic Latin AND extended-face objects for glyph-bearing requests.
  for (const style of ["normal", "italic"] as const) {
    const loaded = await value.document.fonts.load(
      `${style} 650 14px "DM Sans Variable"`,
      "Aa é ĀğŽ",
    );
    expect(loaded).toHaveLength(2);
    expect(new Set(loaded)).toEqual(new Set(value.fonts.filter((font) => font.style === style)));
  }
  const expectedFamily = computedFamily(value, CHAT_SANS_FONT_FAMILY);
  for (const node of value.document.querySelectorAll(
    "h2,button,.sub,.stat b,.stat span,.foot span,svg text",
  )) {
    expect(value.window.getComputedStyle(node).fontFamily).toBe(expectedFamily);
  }
  expect(value.window.getComputedStyle(value.document.querySelector("h2")!).fontSize).toBe("17px");
  expect(value.window.getComputedStyle(value.document.querySelector("h2")!).fontWeight).toBe("650");
  expect(value.window.getComputedStyle(value.document.querySelector("button")!).fontSize).toBe(
    "11px",
  );
}

describe("responsive exact-data chart replay", () => {
  afterEach(() => {
    for (const value of fixtures.splice(0)) {
      value.window.dispatchEvent(new Event("pagehide"));
      expect(value.window.__chartClock.pending()).toBe(0);
      value.frame.remove();
    }
  });

  it("preserves the complete supplied immutable daily JSON and one helper marker without a second engine", async () => {
    const value = await fixture();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text(value, "data")),
    );
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(hex).toBe("6bce2a6d2eb947a4680da26b1d8ae0507882cd23408324ad81b0d030e0ecf3dc");
    expect(value.document.querySelectorAll("canvas[data-cafe-fluid]")).toHaveLength(1);
    expect(chartSource).not.toContain("function boot()");
    expect(chartSource).not.toContain("compileShader");
    settled(value);
    expectSummary(value, 30);
    expect(value.window.__chartClock.maximum()).toBe(1);
  });

  it.each([240, 320, 780, 1600])(
    "keeps real-width SVG glyphs uniform without horizontal/root scrolling at %ipx",
    async (width) => {
      for (const theme of ["light", "dark"] as const) {
        const value = await fixture(width, theme);
        settled(value);
        expectResponsive(value);
        await expectChatTypography(value);
        const canvas = value.document.querySelector("canvas")!;
        const veil = value.document.querySelector(".veil")!;
        expect(value.window.getComputedStyle(canvas).opacity).toBe("0.8");
        expect(value.window.getComputedStyle(canvas).pointerEvents).toBe("none");
        expect(value.window.getComputedStyle(veil).backgroundColor).toContain("0.5");
        expect(value.window.getComputedStyle(value.document.querySelector("h2")!).color).toBe(
          theme === "dark" ? "rgb(232, 237, 245)" : "rgb(21, 34, 56)",
        );
      }
    },
  );

  it("preserves semantic code subtrees and states the browser author-origin priority boundary", async () => {
    const value = await fixture();
    settled(value);
    await expectChatTypography(value);
    const diagnostics = value.document.createElement("section");
    diagnostics.innerHTML =
      "<pre><span>raw JSON</span></pre><code><span>const value = 1</span></code><kbd><span>Enter</span></kbd><samp><span>received output</span></samp><p>ordinary chart detail</p>";
    value.document.body.append(diagnostics);
    const expectedMono = computedFamily(value, CHAT_MONO_FONT_FAMILY);
    const expectedSans = computedFamily(value, CHAT_SANS_FONT_FAMILY);
    for (const node of diagnostics.querySelectorAll("pre,code,kbd,samp,span")) {
      expect(value.window.getComputedStyle(node).fontFamily).toBe(expectedMono);
    }
    expect(value.window.getComputedStyle(diagnostics.querySelector("p")!).fontFamily).toBe(
      expectedSans,
    );
    const axis = value.chart.querySelector<SVGTextElement>("text")!;
    axis.style.setProperty("font-family", "monospace", "important");
    // A normal browser author style cannot beat a more-specific author-important
    // declaration. Do not weaken this honest boundary: native main must prove
    // its fixed user-origin policy wins in actual Electron independently.
    expect(value.window.getComputedStyle(axis).fontFamily).toBe("monospace");
    axis.style.removeProperty("font-family");
    expect(value.window.getComputedStyle(axis).fontFamily).toBe(expectedSans);
    diagnostics.remove();
    expectResponsive(value);
    expectSummary(value, 30);
    expect(value.window.__chartClock.pending()).toBe(0);
  });

  it("interpolates coupled paths and exact KPI endpoints for 7/90/30-day changes and settles without idle frames", async () => {
    const value = await fixture();
    settled(value);
    let time = 1_000;
    for (const days of [7, 90, 30]) {
      const before = line(value);
      const totalBefore = text(value, "total");
      select(value, days);
      expect(value.chart.dataset.animation).toBe("moving");
      expect(line(value)).toBe(before);
      expect(text(value, "total")).toBe(totalBefore);
      value.window.__chartClock.flush(time);
      value.window.__chartClock.flush(time + 300);
      expect(line(value)).not.toBe(before);
      expect(text(value, "total")).not.toBe(totalBefore);
      const intermediate = line(value);
      value.window.__chartClock.flush(time + 651);
      expect(line(value)).not.toBe(intermediate);
      expectSummary(value, days);
      expect(value.window.__chartClock.pending()).toBe(0);
      const final = line(value);
      value.window.__chartClock.flush(time + 10_000);
      expect(line(value)).toBe(final);
      time += 1_000;
    }
    expect(value.window.__chartClock.maximum()).toBe(1);
  });

  it("recomputes actual coordinates and settles current data after a real ResizeObserver delivery", async () => {
    const value = await fixture();
    settled(value);
    select(value, 90);
    value.window.__chartClock.flush(1_000);
    value.window.__chartClock.flush(1_300);
    value.frame.style.width = "280px";
    await vi.waitFor(() => {
      expect(value.chart.getBoundingClientRect().width).toBe(256);
      expectResponsive(value);
      expect(value.chart.dataset.animation).toBe("settled");
    });
    expectSummary(value, 90);
    expect(value.window.__chartClock.pending()).toBe(0);
  });

  it("settles hidden and reduced-motion charts and never renews entrance animation on leave/return", async () => {
    const value = await fixture(320, "dark", false);
    expect(value.chart.dataset.animation).toBe("settled");
    expect(value.window.__chartClock.pending()).toBe(0);
    expectSummary(value, 30);
    value.document.documentElement.dataset.cafeVisible = "true";
    await vi.waitFor(() => expect(value.chart.dataset.animation).toBe("moving"));
    value.window.__chartClock.flush(0);
    value.window.__chartClock.flush(200);
    value.document.documentElement.dataset.cafeVisible = "false";
    await vi.waitFor(() => expect(value.chart.dataset.animation).toBe("settled"));
    expectSummary(value, 30);
    value.document.documentElement.dataset.cafeVisible = "true";
    await vi.waitFor(() => expect(value.window.__chartClock.pending()).toBe(0));
    select(value, 7);
    expect(value.chart.dataset.animation).toBe("moving");
    value.document.documentElement.dataset.cafeReducedMotion = "true";
    await vi.waitFor(() => expect(value.chart.dataset.animation).toBe("settled"));
    expectSummary(value, 7);
    select(value, 90);
    expectSummary(value, 90);
    expect(value.window.__chartClock.pending()).toBe(0);
  });

  it("retires RAF, range handlers and observers on pagehide without later cue or resize replay", async () => {
    const value = await fixture();
    expect(value.window.__chartClock.pending()).toBe(1);
    value.window.dispatchEvent(new Event("pagehide"));
    const final = line(value);
    expect(value.chart.dataset.animation).toBe("disposed");
    expect(value.window.__chartClock.pending()).toBe(0);
    select(value, 7);
    value.document.documentElement.dataset.cafeVisible = "false";
    value.document.documentElement.dataset.cafeVisible = "true";
    value.frame.style.width = "280px";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(line(value)).toBe(final);
    expect(value.chart.dataset.days).toBe("30");
    expect(value.chart.dataset.animation).toBe("disposed");
    expect(value.window.__chartClock.pending()).toBe(0);
  });
});
