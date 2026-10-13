import { describe, expect, it } from "vitest";
import { visualizationFluidScript } from "@cafecode/shared/visualizationFluidRuntime";
import { GENERATED_VISUALIZATION_FONT_APPENDIX } from "@cafecode/shared/visualizationFonts";
import { VISUALIZATION_FONT_LICENSE } from "@cafecode/shared/visualizationFontData";
import { embedStaticVisualizationAssets, exportGeneratedVisualizationHtml } from "./offlineHtml.ts";

const assets = [{ id: "chart", mime: "image/png" as const, base64: "aGVsbG8=" }];
describe("bounded static visualization export", () => {
  it("rewrites exact URL attributes while preserving external URLs, prefixes and inert text", () => {
    const source =
      "<img src='asset/chart'><img src=asset/chart><a href=\"asset/chart\">asset/chart</a><img src='https://example.test/asset/chart'><img src='asset/chart-longer'><!-- <img src='asset/chart'> --><script>const x='asset/chart';</script><style>.x{background:url('asset/chart')}</style>";
    const result = embedStaticVisualizationAssets(source, assets);
    expect(result).toBe(
      "<img src='data:image/png;base64,aGVsbG8='><img src=data:image/png;base64,aGVsbG8=><a href=\"data:image/png;base64,aGVsbG8=\">asset/chart</a><img src='https://example.test/asset/chart'><img src='asset/chart-longer'><!-- <img src='asset/chart'> --><script>const x='asset/chart';</script><style>.x{background:url('asset/chart')}</style>",
    );
  });
  it("keeps quoted greater-than signs and raw-text boundaries intact", () => {
    const source =
      "<div data-x='>'><img SRC = 'asset/chart'></div><textarea><img src='asset/chart'></textarea><script>x='</scriptish><img src=asset/chart>'</script><img src=asset/chart>";
    expect(embedStaticVisualizationAssets(source, assets)).toBe(
      "<div data-x='>'><img SRC = 'data:image/png;base64,aGVsbG8='></div><textarea><img src='asset/chart'></textarea><script>x='</scriptish><img src=asset/chart>'</script><img src=data:image/png;base64,aGVsbG8=>",
    );
  });
  it("refuses expansion before assembling oversized output", () => {
    expect(() =>
      embedStaticVisualizationAssets("<img src=asset/chart>".repeat(5), [
        { ...assets[0]!, base64: "a".repeat(4 * 1024 * 1024) },
      ]),
    ).toThrow("Portable visualization export is unavailable.");
  });
  it("appends the canonical licensed helper only to the derived generated export", () => {
    const source =
      '<!doctype html><html><body><canvas data-cafe-fluid></canvas><img src="asset/chart"><script>const text="asset/chart";</script></body></html>';
    const staticHtml = embedStaticVisualizationAssets(source, assets);
    const result = exportGeneratedVisualizationHtml(source, assets);
    expect(result).toBe(
      staticHtml +
        GENERATED_VISUALIZATION_FONT_APPENDIX +
        "\n" +
        visualizationFluidScript("generated"),
    );
    expect(result.startsWith("<!doctype html>")).toBe(true);
    expect(result).toContain("Copyright (c) Pavel Dobryakov");
    expect(result).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(result).toContain(VISUALIZATION_FONT_LICENSE);
    expect(result.match(/@font-face\{/g)).toHaveLength(4);
    expect(result).not.toContain('data-cafe-visible="true"');
    expect(source).toContain('src="asset/chart"');
    expect(source).not.toContain("WebGL Fluid Simulation");
    expect(visualizationFluidScript("mcp-app")).toBe("");
  });
  it("preserves no-marker source exactly with only fixed fonts, including inert and quoted markers", () => {
    const sources = [
      "<!doctype html><p>Ordinary saved chart</p>",
      "<!-- <canvas data-cafe-fluid></canvas> --><img src=asset/chart>",
      '<script>const html="<canvas data-cafe-fluid></canvas>";</script>',
      "<style>.x::after{content:'<canvas data-cafe-fluid>'}</style>",
      "<textarea><canvas data-cafe-fluid></canvas></textarea>",
      "<div data-html='<canvas data-cafe-fluid>'>Text</div>",
      "<div data-cafe-fluid></div><canvas data-cafe-fluid-other></canvas>",
      "<plaintext><canvas data-cafe-fluid></canvas>",
      "<canvas data-cafe-fluid",
    ];
    for (const source of sources)
      expect(exportGeneratedVisualizationHtml(source, assets)).toBe(
        embedStaticVisualizationAssets(source, assets) + GENERATED_VISUALIZATION_FONT_APPENDIX,
      );
    const exact = "x".repeat(
      16 * 1024 * 1024 - Buffer.byteLength(GENERATED_VISUALIZATION_FONT_APPENDIX, "utf8"),
    );
    expect(exportGeneratedVisualizationHtml(exact, [])).toBe(
      exact + GENERATED_VISUALIZATION_FONT_APPENDIX,
    );
    expect(() => exportGeneratedVisualizationHtml(exact + "x", [])).toThrow(
      "Portable visualization export is unavailable.",
    );
  });
  it("recognizes only complete canvas start tags with the exact case-insensitive marker", () => {
    const source = '<CANVAS DATA-CAFE-FLUID=""></CANVAS>';
    expect(exportGeneratedVisualizationHtml(source, [])).toBe(
      source + GENERATED_VISUALIZATION_FONT_APPENDIX + "\n" + visualizationFluidScript("generated"),
    );
  });
  it("includes the helper's actual UTF8 bytes in the independent portable output bound", () => {
    const helperBytes = Buffer.byteLength(
      GENERATED_VISUALIZATION_FONT_APPENDIX + "\n" + visualizationFluidScript("generated"),
      "utf8",
    );
    const prefix = "<canvas data-cafe-fluid></canvas>";
    const available = 16 * 1024 * 1024 - helperBytes - Buffer.byteLength(prefix, "utf8");
    // Non-ASCII source proves this limit measures bytes, not UTF16 length.
    const exact = prefix + "界".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
    expect(Buffer.byteLength(exportGeneratedVisualizationHtml(exact, []), "utf8")).toBe(
      16 * 1024 * 1024,
    );
    expect(() => exportGeneratedVisualizationHtml(exact + "x", [])).toThrow(
      "Portable visualization export is unavailable.",
    );
    expect(() => embedStaticVisualizationAssets("x".repeat(16 * 1024 * 1024 + 1), [])).toThrow(
      "Portable visualization export is unavailable.",
    );
  });
  it("reserves helper bytes before static asset expansion reaches the final concatenation", () => {
    const helperBytes = Buffer.byteLength(
      GENERATED_VISUALIZATION_FONT_APPENDIX + "\n" + visualizationFluidScript("generated"),
      "utf8",
    );
    const prefix = "<canvas data-cafe-fluid></canvas><img src=asset/chart>";
    const dataUrl = "data:image/png;base64," + assets[0]!.base64;
    const increase = Buffer.byteLength(dataUrl, "utf8") - Buffer.byteLength("asset/chart", "utf8");
    const available = 16 * 1024 * 1024 - helperBytes;
    const exact = prefix + "x".repeat(available - Buffer.byteLength(prefix, "utf8") - increase);
    expect(Buffer.byteLength(exportGeneratedVisualizationHtml(exact, assets), "utf8")).toBe(
      16 * 1024 * 1024,
    );
    expect(() => exportGeneratedVisualizationHtml(exact + "x", assets)).toThrow(
      "Portable visualization export is unavailable.",
    );
  });
});
