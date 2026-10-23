import { describe, expect, it } from "vitest";
import type { VisualizationHostPresentation } from "@cafecode/contracts/visualizationHost";
import { GENERATED_VISUALIZATION_FONT_APPENDIX } from "@cafecode/shared/visualizationFonts";
import {
  createInlineVisualizationDocument,
  INLINE_VISUALIZATION_CSP,
} from "./inlineVisualizationDocument";

const frameId = "fe225063-3208-411e-af12-19a8a5a61b42";
const presentation: VisualizationHostPresentation = {
  locale: "en",
  reducedMotion: false,
  scale: 1,
  colors: {
    background: "#171717",
    foreground: "#fafafa",
    muted: "#a3a3a3",
    accent: "#0891b2",
    accentForeground: "#ffffff",
    chart1: "#0891b2",
    chart2: "#7c3aed",
    chart3: "#db2777",
    chart4: "#ca8a04",
    chart5: "#4f46e5",
    chart6: "#059669",
  },
};
describe("Full-access inline document presentation", () => {
  it("relocates the exact generated transport font prefix after the original doctype and head attributes", () => {
    const source =
      '<!doctype html><html data-author-root="yes"><head data-author-head="yes"><script>window.authorStarts=true</script></head><body data-author-body="yes">Chart</body></html>';
    const html = createInlineVisualizationDocument(
      GENERATED_VISUALIZATION_FONT_APPENDIX + source,
      presentation,
      false,
      frameId,
    );
    expect(
      html.startsWith('<!doctype html><html data-author-root="yes"><head data-author-head="yes">'),
    ).toBe(true);
    expect(html.split(GENERATED_VISUALIZATION_FONT_APPENDIX)).toHaveLength(2);
    expect(html.indexOf(GENERATED_VISUALIZATION_FONT_APPENDIX)).toBeLessThan(
      html.indexOf("window.authorStarts"),
    );
    expect(html.endsWith('<body data-author-body="yes">Chart</body></html>')).toBe(true);
  });
  it("preserves original mixed-case document indices after Unicode in a valid leading comment", () => {
    // U+0130 lowercases to two UTF-16 code units. A whole-source lowercase
    // copy therefore cannot supply offsets into this unchanged authored HTML.
    const throughHead =
      '<!doctype html><!-- Unicode: İ 🌸 --><HtMl data-author-root="İ"><HeAd data-author-head="🌸">';
    const remainder =
      '<script>window.unicodeDocumentStarts=true;</script></HeAd><BoDy data-author-body="İ">Chart</BoDy></HtMl>';
    const html = createInlineVisualizationDocument(
      throughHead + remainder,
      presentation,
      false,
      frameId,
    );
    expect(html.startsWith(throughHead)).toBe(true);
    expect(html.indexOf(INLINE_VISUALIZATION_CSP)).toBeGreaterThan(throughHead.length);
    expect(html.indexOf(INLINE_VISUALIZATION_CSP)).toBeLessThan(
      html.indexOf("window.unicodeDocumentStarts"),
    );
    expect(html.endsWith(remainder)).toBe(true);
  });
  it("keeps fixed-font fragments standards-wrapped without changing external App source", () => {
    const source = GENERATED_VISUALIZATION_FONT_APPENDIX + '<main id="chart-fragment">Chart</main>';
    const generated = createInlineVisualizationDocument(source, presentation, false, frameId);
    expect(generated.startsWith("<!doctype html><html><head>")).toBe(true);
    expect(generated.indexOf(GENERATED_VISUALIZATION_FONT_APPENDIX)).toBeLessThan(
      generated.indexOf("</head>"),
    );
    const app = createInlineVisualizationDocument(source, presentation, false, frameId, false);
    expect(app).toContain(`<body>${source}</body>`);
  });
  it("establishes offline policy and visible/theme metadata before any authored source", () => {
    const source =
      "<!doctype html><html><head><style>body{width:4000px;min-height:100vh}</style></head><body><main>chart-source-marker</main><script>window.chart=true;</script></body></html>";
    const html = createInlineVisualizationDocument(source, presentation, true, frameId);
    expect(html.indexOf(INLINE_VISUALIZATION_CSP)).toBeLessThan(
      html.indexOf("chart-source-marker"),
    );
    expect(html.indexOf('root.dataset.cafeVisible="true"')).toBeLessThan(
      html.indexOf("<script>window.chart"),
    );
    expect(html).toContain(`"frameId":"${frameId}"`);
    expect(html).toContain('["--chart-1","#0891b2"]');
    expect(html).toContain('"dark":true');
    expect(html).toContain("width:100%!important");
    expect(html).toContain("min-height:0!important");
    expect(html).toContain("<style>body{width:4000px;min-height:100vh}</style>");
    expect(html.endsWith("<script>window.chart=true;</script></body></html>")).toBe(true);
  });
  it("installs pointer-select presentation before generated handlers without modifying external Apps", () => {
    const source =
      '<select id="metric"><option>Original option</option></select><script>window.authorSelect=true;</script>';
    const generated = createInlineVisualizationDocument(source, presentation, true, frameId);
    expect(generated.indexOf('"pointerdown"')).toBeGreaterThanOrEqual(0);
    expect(generated.indexOf('"pointerdown"')).toBeLessThan(
      generated.indexOf("window.authorSelect"),
    );
    expect(generated).toContain('"box-shadow"');
    expect(generated).toContain("event.isTrusted");
    expect(generated.endsWith(`${source}</body></html>`)).toBe(true);
    const app = createInlineVisualizationDocument(source, presentation, true, frameId, false);
    expect(app).not.toContain('"pointerdown"');
    expect(app).not.toContain("installGeneratedSelectFocus");
    expect(app.endsWith(`${source}</body></html>`)).toBe(true);
  });
  it.each(['"><script>parent.bad=true</script>', frameId.toUpperCase(), "foreign", ""])(
    "rejects noncanonical frame display metadata %s",
    (value) => {
      expect(() =>
        createInlineVisualizationDocument("<p>chart</p>", presentation, false, value),
      ).toThrow("visualization-frame-invalid");
    },
  );
  it("bounds the complete wrapped UTF-8 allocation rather than the source alone", () => {
    expect(() =>
      createInlineVisualizationDocument("x".repeat(16 * 1024 * 1024), presentation, false, frameId),
    ).toThrow("visualization-document-too-large");
    expect(() =>
      createInlineVisualizationDocument("🌸".repeat(4 * 1024 * 1024), presentation, false, frameId),
    ).toThrow("visualization-document-too-large");
  });
  it("keeps the offline CSP explicit without claiming iframe sandbox containment", () => {
    expect(INLINE_VISUALIZATION_CSP).toContain("connect-src 'none'");
    expect(INLINE_VISUALIZATION_CSP).toContain("frame-src 'none'");
    expect(INLINE_VISUALIZATION_CSP).toContain("base-uri 'none'");
    expect(INLINE_VISUALIZATION_CSP).not.toContain("sandbox");
  });
  it("ignores raw document-tag strings inside template scripts before the actual head", () => {
    const decoy = "<template><script>const example='</template><html><head>';</script></template>";
    const actual =
      '<html class="authored-root" style="--owned-brand:cyan"><head><title>Original head</title></head><body><script>window.actualAuthoredScript=true;</script></body></html>';
    const html = createInlineVisualizationDocument(decoy + actual, presentation, false, frameId);
    expect(
      html.startsWith(decoy + '<html class="authored-root" style="--owned-brand:cyan"><head>'),
    ).toBe(true);
    expect(html.indexOf(INLINE_VISUALIZATION_CSP)).toBeGreaterThan(decoy.length);
    expect(html.indexOf(INLINE_VISUALIZATION_CSP)).toBeLessThan(
      html.indexOf("window.actualAuthoredScript"),
    );
    expect(html).toContain(decoy);
  });
  it("keeps Unicode raw text and mixed-case closing-tag boundary decoys outside the actual head", () => {
    const decoy =
      '<template><ScRiPt>const unicode="İ";const suffix="</sCrIpTed>";const example="</template><HtMl><HeAd>";</sCrIpT ></TeMpLaTe>';
    const throughHead = '<HtMl data-author-root="original"><HeAd data-author-head="original">';
    const remainder =
      "<title>Original head</title></HeAd><BoDy><script>window.actualMixedCaseScript=true;</script></BoDy></HtMl>";
    const html = createInlineVisualizationDocument(
      decoy + throughHead + remainder,
      presentation,
      false,
      frameId,
    );
    expect(html.startsWith(decoy + throughHead)).toBe(true);
    expect(html.indexOf(INLINE_VISUALIZATION_CSP)).toBeGreaterThan(
      decoy.length + throughHead.length,
    );
    expect(html.indexOf(INLINE_VISUALIZATION_CSP)).toBeLessThan(
      html.indexOf("window.actualMixedCaseScript"),
    );
    expect(html.endsWith(remainder)).toBe(true);
    expect(html).toContain(decoy);
  });
});
