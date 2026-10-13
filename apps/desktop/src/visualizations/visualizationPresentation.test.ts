import { describe, expect, it, vi } from "vitest";
import type { VisualizationHostPresentation } from "@cafecode/contracts/visualizationHost";
import {
  applyVisualizationPaintVisibility,
  applyVisualizationPresentation,
  GENERATED_VISUALIZATION_TOOLTIP_STYLE,
} from "./visualizationPresentation.ts";

const presentation: VisualizationHostPresentation = {
  locale: "en",
  reducedMotion: false,
  scale: 1,
  colors: {
    background: "#15171c",
    foreground: "#e8edf5",
    muted: "#94a3b8",
    accent: "#619cff",
    accentForeground: "#15171c",
    chart1: "#22d3ee",
    chart2: "#619cff",
    chart3: "#ae88ff",
    chart4: "#ec4899",
    chart5: "#38bdf8",
    chart6: "#a78bfa",
  },
};

/** DOM scalar doubles make every attribute/style publication observable. An
 * identical assignment still counts, as it would in an authored MutationObserver;
 * native media, renderer ownership and pixels are qualified separately. */
function fixture() {
  const attributes = vi.fn();
  const properties = new Map<string, string>();
  const style = {
    colorScheme: "",
    getPropertyValue: (name: string) => properties.get(name) ?? "",
    setProperty: vi.fn((name: string, value: string) => properties.set(name, value)),
  };
  const dataset = new Proxy({} as Record<string, string>, {
    set(target, key, value: string) {
      attributes(key, value);
      Reflect.set(target, key, value);
      return true;
    },
  });
  const root = { style, dataset, lang: "" };
  const dispatchEvent = vi.fn();
  const document = { documentElement: root } as unknown as Document;
  const window = { dispatchEvent } as unknown as Window;
  const apply = (
    value = presentation,
    generated = true,
    contextChanged = false,
    appearance: "light" | "dark" = "dark",
  ) =>
    applyVisualizationPresentation(document, window, appearance, value, generated, contextChanged);
  const paint = (raw: unknown, generatedViewer = true) =>
    applyVisualizationPaintVisibility(document, window, raw, generatedViewer);
  return { root, style, attributes, dispatchEvent, apply, paint };
}

describe("generated native presentation publication", () => {
  it("does not replay authored observers or presentation listeners for unchanged geometry", () => {
    const f = fixture();
    f.apply();
    expect(f.attributes).toHaveBeenCalledExactlyOnceWith("cafeReducedMotion", "false");
    expect(f.dispatchEvent).toHaveBeenCalledOnce();
    const writes = f.style.setProperty.mock.calls.length;
    for (let update = 0; update < 100; update++) f.apply();
    expect(f.attributes).toHaveBeenCalledOnce();
    expect(f.style.setProperty).toHaveBeenCalledTimes(writes);
    expect(f.dispatchEvent).toHaveBeenCalledOnce();
  });
  it("publishes actual scalar and inline/fullscreen context changes without redundant attribute writes", () => {
    const f = fixture();
    f.apply();
    f.apply({ ...presentation, reducedMotion: true });
    expect(f.attributes).toHaveBeenLastCalledWith("cafeReducedMotion", "true");
    expect(f.dispatchEvent).toHaveBeenCalledTimes(2);
    f.apply({ ...presentation, reducedMotion: true }, true, true);
    expect(f.attributes).toHaveBeenCalledTimes(2);
    expect(f.dispatchEvent).toHaveBeenCalledTimes(3);
    f.apply({ ...presentation, reducedMotion: true }, true, false, "light");
    expect(f.root.style.colorScheme).toBe("light");
    expect(f.dispatchEvent).toHaveBeenCalledTimes(4);
  });
  it("restores source-mutated presentation scalars rather than trusting a stale publication cache", () => {
    const f = fixture();
    f.apply();
    f.root.dataset.cafeReducedMotion = "true";
    f.root.style.setProperty("--chart-1", "#000000");
    f.apply();
    expect(f.root.dataset.cafeReducedMotion).toBe("false");
    expect(f.root.style.getPropertyValue("--chart-1")).toBe(presentation.colors.chart1);
    expect(f.dispatchEvent).toHaveBeenCalledTimes(2);
  });
  it("preserves external App repeated notifications and attributes", () => {
    const f = fixture();
    f.apply(presentation, false);
    f.apply(presentation, false);
    expect(f.attributes).toHaveBeenCalledTimes(2);
    expect(f.dispatchEvent).toHaveBeenCalledTimes(2);
  });
  it("publishes a separate generated paint cue without logical visibility or repeated entrance events", () => {
    const f = fixture();
    f.root.dataset.cafeVisible = "true";
    f.attributes.mockClear();
    expect(f.paint({ kind: "presentation-visibility", visible: false })).toBe(true);
    expect(f.attributes).toHaveBeenCalledExactlyOnceWith("cafePresentationVisible", "false");
    expect(f.root.dataset.cafeVisible).toBe("true");
    expect(f.dispatchEvent).toHaveBeenCalledOnce();
    expect(f.dispatchEvent.mock.calls[0]![0].type).toBe("cafe-presentation-visibility-changed");
    for (let update = 0; update < 100; update++)
      expect(f.paint({ kind: "presentation-visibility", visible: false })).toBe(true);
    expect(f.attributes).toHaveBeenCalledOnce();
    expect(f.dispatchEvent).toHaveBeenCalledOnce();
    expect(f.paint({ kind: "presentation-visibility", visible: true })).toBe(true);
    expect(f.root.dataset.cafeVisible).toBe("true");
    expect(f.dispatchEvent).toHaveBeenCalledTimes(2);
    f.root.dataset.cafePresentationVisible = "false";
    expect(f.paint({ kind: "presentation-visibility", visible: true })).toBe(true);
    expect(f.root.dataset.cafePresentationVisible).toBe("true");
    expect(f.dispatchEvent).toHaveBeenCalledTimes(3);
  });
  it("refuses App/preview, malformed or extended private paint messages without touching DOM", () => {
    const f = fixture();
    const valid = { kind: "presentation-visibility", visible: false };
    expect(f.paint(valid, false)).toBe(false);
    for (const raw of [
      null,
      [],
      false,
      {},
      { kind: "visibility", visible: false },
      { kind: "presentation-visibility", visible: "false" },
      { kind: "presentation-visibility", visible: 0 },
      { ...valid, extra: true },
      { kind: "presentation-visibility" },
    ])
      expect(f.paint(raw)).toBe(false);
    expect(f.attributes).not.toHaveBeenCalled();
    expect(f.dispatchEvent).not.toHaveBeenCalled();
  });
  it("themes only exact semantic tooltips without changing visibility, placement or author content", () => {
    expect(GENERATED_VISUALIZATION_TOOLTIP_STYLE).toContain('[role="tooltip"],[data-cafe-tooltip]');
    expect(GENERATED_VISUALIZATION_TOOLTIP_STYLE).toContain(
      "background:var(--background)!important",
    );
    expect(GENERATED_VISUALIZATION_TOOLTIP_STYLE).toContain("color:var(--foreground)!important");
    expect(GENERATED_VISUALIZATION_TOOLTIP_STYLE).not.toMatch(
      /(?:display|visibility|position|overflow|content|\.tip|#tip):/,
    );
  });
});
