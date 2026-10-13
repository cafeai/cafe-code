import { describe, expect, it } from "vitest";
import {
  readVisualizationDiagnostics,
  registerVisualizationDiagnostics,
  copyVisualizationSurfaceDiagnostics,
  type VisualizationHostDiagnostics,
  type VisualizationSurfaceDiagnostics,
} from "./visualizationDiagnostics.ts";

const surface: VisualizationSurfaceDiagnostics = {
  phase: "quarantined",
  rejection: "native-policy",
  exclusiveProcess: false,
  frameCount: 1,
  rendererCount: 1,
  gone: false,
  destroyed: false,
  watchdogArmed: false,
  heartbeatMissed: false,
  assetBytes: 0,
  requestCount: 1,
  servedBytes: 68,
  captureOutcome: "not-attempted",
  captureWidth: 0,
  captureHeight: 0,
  geometryOutcome: "uncommitted",
  viewportWidth: 0,
  viewportHeight: 0,
  clipWidth: 0,
  clipHeight: 0,
  ownerZoom: 0,
  nativeVisibility: "hidden",
  visibilityHintSent: "not-sent",
  visibilityCommitted: false,
  layoutHeight: 0,
  layoutConstrained: false,
  layoutSequence: 0,
  layoutPublications: 0,
  layoutRefusals: 0,
  layoutRefusal: "none",
};
const host: VisualizationHostDiagnostics = {
  available: false,
  status: "quarantined",
  activeCount: 1,
  pendingViewerCount: 0,
  pendingPreviewCount: 0,
  retainedInputBytes: 64,
  retirementCount: 1,
  lastRetirementReason: "retirement-uncertain",
  native: surface,
  viewerCount: 1,
  previewCount: 0,
  nativeWorkCount: 0,
  continuationCount: 0,
  failureCount: 1,
  lastFailure: { lane: "viewer", stage: "initialize", outcome: "exception", allowanceSpent: false },
  quarantine: {
    stage: "retire",
    reason: "retirement-uncertain",
    failure: { lane: "viewer", stage: "initialize", outcome: "exception", allowanceSpent: false },
    native: surface,
  },
};

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
      failureCount: 0,
      lastFailure: null,
      quarantine: null,
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
  it("copies every bounded native scalar and does not preserve nested aliases", () => {
    const close = registerVisualizationDiagnostics(() => host);
    const first = readVisualizationDiagnostics()!;
    expect(first).toEqual(host);
    expect(first.native).not.toBe(surface);
    expect(first.quarantine!.native).not.toBe(surface);
    expect(first.native).not.toBe(first.quarantine!.native);
    expect(first.lastFailure).not.toBe(first.quarantine!.failure);
    Object.assign(first.native!, { phase: "retired" });
    Object.assign(first.quarantine!.failure, { stage: "create" });
    expect(readVisualizationDiagnostics()).toEqual(host);
    close();
  });
  it.each([
    { stage: "source-install" },
    { outcome: "private source sentinel" },
    { allowanceSpent: "false" },
    { lane: "private account sentinel" },
    { source: "private source sentinel" },
    { toJSON: () => ({ source: "private source sentinel" }) },
  ])("refuses malformed or extra failure tuple fields without disclosure: %j", (extra) => {
    const close = registerVisualizationDiagnostics(
      () =>
        ({
          ...host,
          lastFailure: { ...host.lastFailure!, ...extra },
        }) as VisualizationHostDiagnostics,
    );
    expect(readVisualizationDiagnostics()).toBeNull();
    close();
  });
  it.each([
    { phase: "alive" },
    { frameCount: -1 },
    { captureWidth: 1601 },
    { ownerZoom: Infinity },
    { nativeVisibility: "true" },
    { rawError: "private source sentinel" },
    { toJSON: () => ({ source: "private source sentinel" }) },
  ])("refuses malformed or extra native scalar fields: %j", (extra) => {
    expect(copyVisualizationSurfaceDiagnostics({ ...surface, ...extra })).toBeNull();
    const close = registerVisualizationDiagnostics(
      () => ({ ...host, native: { ...surface, ...extra } }) as VisualizationHostDiagnostics,
    );
    expect(readVisualizationDiagnostics()).toBeNull();
    close();
  });
  it("never evaluates a received getter or serializer while projecting diagnostics", () => {
    let reads = 0;
    const getter = { ...surface };
    Object.defineProperty(getter, "phase", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("private sentinel");
      },
    });
    expect(copyVisualizationSurfaceDiagnostics(getter)).toBeNull();
    const serialized = {
      ...host,
      toJSON: () => {
        reads += 1;
        return "private sentinel";
      },
    };
    const close = registerVisualizationDiagnostics(() => serialized);
    expect(readVisualizationDiagnostics()).toBeNull();
    expect(reads).toBe(0);
    close();
  });
  it("defaults only absent new fields for a legacy unavailable producer", () => {
    const {
      failureCount: _count,
      lastFailure: _failure,
      quarantine: _quarantine,
      ...legacy
    } = host;
    const close = registerVisualizationDiagnostics(() => legacy);
    expect(readVisualizationDiagnostics()).toEqual({
      ...legacy,
      failureCount: 0,
      lastFailure: null,
      quarantine: null,
    });
    close();
    for (const extra of [
      { failureCount: undefined },
      { lastFailure: undefined },
      { quarantine: undefined },
    ]) {
      const stop = registerVisualizationDiagnostics(
        () => ({ ...legacy, ...extra }) as unknown as VisualizationHostDiagnostics,
      );
      expect(readVisualizationDiagnostics()).toBeNull();
      stop();
    }
  });
  it("refuses quarantine-stage aliases, inconsistent reasons and extra received payload", () => {
    for (const extra of [
      { stage: "constructor" },
      { reason: "timeout" },
      { stage: "create" },
      { source: "private sentinel" },
    ]) {
      const close = registerVisualizationDiagnostics(
        () =>
          ({
            ...host,
            quarantine: { ...host.quarantine!, ...extra },
          }) as VisualizationHostDiagnostics,
      );
      expect(readVisualizationDiagnostics()).toBeNull();
      close();
    }
  });
});
