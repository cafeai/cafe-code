import { describe, expect, it } from "vitest";
import {
  clampVisualizationBounds,
  hasExclusiveVisualizationProcesses,
  isVisualizationMessage,
  rasterDimensions,
} from "./visualizationHostPolicy.ts";

describe("native visualization admission policy", () => {
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
