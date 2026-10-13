import { describe, expect, it } from "vitest";
import {
  clampVisualizationBounds,
  admitVisualizationGeometry,
  hasVisualizationPresentationGeometry,
  hasExclusiveVisualizationProcesses,
  isVisualizationMessage,
  rasterDimensions,
} from "./visualizationHostPolicy.ts";

describe("native visualization admission policy", () => {
  it("separates positive hidden presentation from qualified visible mask geometry", () => {
    const bounds = { x: 0, y: 0, width: 400, height: 200 };
    for (const zoom of [0.8, 1, 1.3]) {
      const clip = { ...bounds, height: 20 };
      expect(admitVisualizationGeometry(bounds, clip, [640, 480], zoom)).toBeNull();
      expect(hasVisualizationPresentationGeometry(bounds, clip, [640, 480], zoom)).toBe(true);
    }
    for (const clip of [
      { ...bounds, height: 0 },
      { ...bounds, x: -1 },
      { ...bounds, width: 401 },
      { ...bounds, y: 200 },
      { ...bounds, height: NaN },
    ])
      expect(hasVisualizationPresentationGeometry(bounds, clip, [640, 480], 1)).toBe(false);
    expect(
      hasVisualizationPresentationGeometry({ ...bounds, x: 700 }, undefined, [640, 480], 1),
    ).toBe(false);
    expect(hasVisualizationPresentationGeometry(bounds, undefined, [640, 480], Infinity)).toBe(
      false,
    );
  });
  it("separates an unchanged full viewport from the native visible scroll slice", () => {
    const full = { x: 20, y: -120, width: 400, height: 600 };
    const clip = { x: 20, y: 80, width: 300, height: 200 };
    expect(admitVisualizationGeometry(full, clip, [640, 480], 1)).toEqual({
      viewport: full,
      clip,
      child: { x: 0, y: -200, width: 400, height: 600 },
      ownerZoom: 1,
      clipping: "partial",
    });
    for (const zoom of [0.8, 1.3]) {
      const value = admitVisualizationGeometry(full, clip, [640, 480], zoom)!;
      expect(value.viewport.width).toBe(Math.round(400 * zoom));
      expect(value.viewport.height).toBe(Math.round(600 * zoom));
      expect(value.child.y).toBe(Math.floor(-120 * zoom) - Math.ceil(80 * zoom));
      expect(value.clip.width).toBe(Math.floor(320 * zoom) - Math.ceil(20 * zoom));
      expect(value.ownerZoom).toBe(zoom);
    }
  });
  it("refuses unknown zoom, non-subset clips, tiny masks and viewport cap expansion", () => {
    const bounds = { x: 0, y: 0, width: 400, height: 200 };
    for (const zoom of [0, -1, NaN, Infinity, Number.MAX_VALUE])
      expect(admitVisualizationGeometry(bounds, undefined, [640, 480], zoom)).toBeNull();
    for (const clip of [
      { x: -1, y: 0, width: 400, height: 200 },
      { x: 0, y: 0, width: 401, height: 200 },
      { x: 0, y: 0, width: 31, height: 200 },
      { x: 0, y: 0, width: 400, height: 31 },
    ])
      expect(admitVisualizationGeometry(bounds, clip, [640, 480], 1)).toBeNull();
    expect(
      admitVisualizationGeometry({ ...bounds, width: 1600 }, undefined, [3000, 3000], 1.3),
    ).toBeNull();
    expect(
      admitVisualizationGeometry({ ...bounds, height: 2000 }, undefined, [3000, 3000], 1.3),
    ).toBeNull();
    expect(
      admitVisualizationGeometry(
        { x: 0, y: 0, width: 1600, height: 2000 },
        undefined,
        [1600, 2000],
        1,
      )?.viewport,
    ).toEqual({ x: 0, y: 0, width: 1600, height: 2000 });
    expect(admitVisualizationGeometry(bounds, undefined, [NaN, 480], 1)).toBeNull();
    expect(admitVisualizationGeometry({ ...bounds, x: 700 }, undefined, [640, 480], 1)).toBeNull();
  });
  it("rounds fractional visible edges inward without shifting or reflowing the full document", () => {
    const bounds = { x: -1, y: -1, width: 401, height: 201 };
    const value = admitVisualizationGeometry(bounds, undefined, [640, 480], 1.3)!;
    expect(value.viewport).toEqual({ x: -2, y: -2, width: 521, height: 261 });
    expect(value.clip).toEqual({ x: 0, y: 0, width: 519, height: 259 });
    expect(value.child).toEqual({ x: -2, y: -2, width: 521, height: 261 });
  });
  it("clips finite bounds to the exact owner window and rejects offscreen geometry", () => {
    expect(clampVisualizationBounds({ x: -10, y: 5, width: 200, height: 300 }, [100, 100])).toEqual(
      { x: 0, y: 5, width: 100, height: 95 },
    );
    expect(
      clampVisualizationBounds({ x: 101, y: 0, width: 20, height: 20 }, [100, 100]),
    ).toBeNull();
    expect(clampVisualizationBounds({ x: 0, y: 0, width: 20, height: 20 }, [NaN, 100])).toBeNull();
  });
  it("refuses unknown and shared native process identities", () => {
    expect(hasExclusiveVisualizationProcesses([123], [124, 125])).toBe(true);
    for (const own of [[], [0], [-1], [1.5], [123]])
      expect(hasExclusiveVisualizationProcesses(own, [123])).toBe(false);
    expect(hasExclusiveVisualizationProcesses([123, 124], [125])).toBe(false);
    for (const others of [[0], [-1], [NaN], [1.5]])
      expect(hasExclusiveVisualizationProcesses([123], others)).toBe(false);
  });
  it("refuses nonobject, malformed, deeply nested and excessive JSON before relaying it", () => {
    expect(isVisualizationMessage('{"jsonrpc":"2.0","method":"ping"}')).toBe(true);
    for (const value of [
      null,
      {},
      "[]",
      "null",
      '"text"',
      "{broken",
      "{}".repeat(70_000),
      `{"data":${"[".repeat(17)}0${"]".repeat(17)}}`,
      JSON.stringify({ x: Array.from({ length: 5000 }, () => 0) }),
    ])
      expect(isVisualizationMessage(value)).toBe(false);
  });
  it("checks PNG dimensions before calling any native raster decoder", () => {
    const bytes = Buffer.alloc(33);
    Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12);
    bytes.writeUInt32BE(200, 16);
    bytes.writeUInt32BE(100, 20);
    expect(rasterDimensions(bytes, "image/png")).toEqual({ width: 200, height: 100 });
    bytes.writeUInt32BE(100_000, 16);
    expect(rasterDimensions(bytes, "image/png")).toBeNull();
    expect(rasterDimensions(bytes, "image/jpeg")).toBeNull();
  });
  it("rejects JPEG entropy before a bounded SOF and admits an exact baseline header", () => {
    const bytes = Buffer.from("ffd8ffc00008080190032000", "hex");
    expect(rasterDimensions(bytes, "image/jpeg")).toEqual({ width: 800, height: 400 });
    expect(
      rasterDimensions(Buffer.from("ffd8ffda0008ffffffffffff", "hex"), "image/jpeg"),
    ).toBeNull();
  });
  it("refuses animated WebP and preserves finite lossless header dimensions", () => {
    const bytes = Buffer.alloc(30);
    bytes.write("RIFF");
    bytes.write("WEBP", 8);
    bytes.write("VP8X", 12);
    bytes.writeUInt32LE(10, 16);
    bytes.writeUIntLE(99, 24, 3);
    bytes.writeUIntLE(49, 27, 3);
    expect(rasterDimensions(bytes, "image/webp")).toEqual({ width: 100, height: 50 });
    bytes[20] = 2;
    expect(rasterDimensions(bytes, "image/webp")).toBeNull();
  });
});
