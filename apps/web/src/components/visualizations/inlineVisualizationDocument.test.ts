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
});
