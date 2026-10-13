import { describe, expect, it } from "vitest";
import {
  readVisualizationDiagnostics,
  registerVisualizationDiagnostics,
  type VisualizationHostDiagnostics,
} from "./visualizationDiagnostics.ts";

describe("bounded native visualization diagnostics", () => {
  it("reads only on demand and revokes only the exact registration", () => {
    let calls = 0;
    const value: VisualizationHostDiagnostics = {
      available: true,
      status: "ready",
      activeCount: 0,
      pendingViewerCount: 0,
      pendingPreviewCount: 0,
      retainedInputBytes: 0,
      retirementCount: 0,
      lastRetirementReason: "none",
      native: null,
      viewerCount: 0,
      previewCount: 0,
      nativeWorkCount: 0,
      continuationCount: 0,
    };
    const first = registerVisualizationDiagnostics(() => {
      calls += 1;
      return value;
    });
    expect(calls).toBe(0);
    expect(readVisualizationDiagnostics()).toEqual(value);
    expect(calls).toBe(1);
    const second = registerVisualizationDiagnostics(() => value);
    first();
    expect(readVisualizationDiagnostics()).toEqual(value);
    second();
    expect(readVisualizationDiagnostics()).toBeNull();
  });
  it("does not disclose native exceptions", () => {
    const close = registerVisualizationDiagnostics(() => {
      throw new Error("private source sentinel");
    });
    expect(readVisualizationDiagnostics()).toBeNull();
    close();
  });
  it("projects explicit scalars rather than arbitrary producer properties", () => {
    const close = registerVisualizationDiagnostics(() => ({
      available: true,
      status: "ready",
      activeCount: 0,
      pendingViewerCount: 0,
      pendingPreviewCount: 0,
      retainedInputBytes: 0,
      retirementCount: 0,
      lastRetirementReason: "none",
      native: null,
      viewerCount: 0,
      previewCount: 0,
      nativeWorkCount: 0,
      continuationCount: 0,
      source: "private source sentinel",
      token: "private bearer",
    }));
    expect(JSON.stringify(readVisualizationDiagnostics())).not.toContain("private");
    close();
  });
});
