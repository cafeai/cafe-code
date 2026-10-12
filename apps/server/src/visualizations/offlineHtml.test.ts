import { describe, expect, it } from "vitest";
import { embedStaticVisualizationAssets } from "./offlineHtml.ts";

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
});
