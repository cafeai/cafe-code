import { describe, expect, it } from "vitest";
import {
  admitVisualizationCapture,
  matchesVisualizationCapture,
} from "./visualizationCapturePolicy.ts";

describe("native visualization capture envelope", () => {
  it("binds Retina and fractional raster tuples without changing output viewport", () => {
    expect(admitVisualizationCapture(600, 400, 2)).toEqual({
      width: 600,
      height: 400,
      physicalWidth: 1200,
      physicalHeight: 800,
      dpr: 2,
    });
    expect(admitVisualizationCapture(501, 301, 1.25)).toEqual({
      width: 501,
      height: 301,
      physicalWidth: 627,
      physicalHeight: 377,
      dpr: 1.25,
    });
    expect(admitVisualizationCapture(1600, 2000, 2)).not.toBeNull();
  });
  it("refuses absent/invalid/excess DPR or physical work before capture", () => {
    for (const dpr of [undefined, null, 0, -1, NaN, Infinity, 4.01, "2"])
      expect(admitVisualizationCapture(400, 200, dpr)).toBeNull();
    expect(admitVisualizationCapture(1600, 2000, 3)).toBeNull();
    expect(admitVisualizationCapture(1601, 2000, 1)).toBeNull();
    expect(admitVisualizationCapture(400, 200.5, 1)).toBeNull();
  });
  it("rejects a different actual raster rather than silently normalize unknown capture", () => {
    const tuple = admitVisualizationCapture(600, 400, 2)!;
    expect(matchesVisualizationCapture(tuple, { width: 1200, height: 800 })).toBe(true);
    for (const size of [
      { width: 600, height: 400 },
      { width: 1201, height: 800 },
      { width: 1200, height: 801 },
      { width: NaN, height: 800 },
    ])
      expect(matchesVisualizationCapture(tuple, size)).toBe(false);
  });
});
