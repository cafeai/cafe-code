import { describe, expect, it, vi } from "vitest";
import { readInlineVisualizationDiagnostics } from "./inlineVisualizationDiagnostics.js";

describe("inline visualization debug projection", () => {
  it("reports the current mode and only finite admitted scalar counts", () => {
    const result = readInlineVisualizationDiagnostics({
      visualizations: {
        mode: "inline-browser",
        fullAccessRequired: true,
        pools: 1,
        anchors: 3,
        grantedFrames: 2,
        runningFrames: 2,
        activeReads: 1,
        waitingReads: 0,
        source: "private",
        ticket: "private",
        diagnosticsConstrained: false,
      },
    });
    expect(result).toEqual({
      mode: "inline-browser",
      fullAccessRequired: true,
      nativeExecutionHost: false,
      available: true,
      pools: 1,
      anchors: 3,
      grantedFrames: 2,
      runningFrames: 2,
      activeReads: 1,
      waitingReads: 0,
      diagnosticsConstrained: false,
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("does not invoke source getters and refuses unknown or excessive received values", () => {
    const getter = vi.fn(() => "private");
    const value = {
      mode: "inline-browser",
      fullAccessRequired: true,
      pools: 17,
      anchors: Infinity,
      grantedFrames: -1,
      runningFrames: 0.5,
      activeReads: 33,
      waitingReads: 129,
    };
    Object.defineProperty(value, "source", { enumerable: true, get: getter });
    expect(readInlineVisualizationDiagnostics({ visualizations: value })).toMatchObject({
      available: true,
      pools: null,
      anchors: null,
      grantedFrames: null,
      runningFrames: null,
      activeReads: null,
      waitingReads: null,
    });
    const root = {};
    Object.defineProperty(root, "visualizations", { enumerable: true, get: getter });
    expect(readInlineVisualizationDiagnostics(root).available).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(
      readInlineVisualizationDiagnostics({
        visualizations: { mode: "native", fullAccessRequired: true },
      }).available,
    ).toBe(false);
    expect(readInlineVisualizationDiagnostics(null).runningFrames).toBeNull();
  });
});
