import { describe, expect, it } from "vitest";
import { rasterDimensions } from "./visualizationRasterPolicy.ts";

describe("bounded committed raster header admission", () => {
  it("admits exact PNG dimensions and refuses malformed or excessive pixels before decoding", () => {
    const bytes = Buffer.alloc(33);
    Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(800, 16);
    bytes.writeUInt32BE(400, 20);
    expect(rasterDimensions(bytes, "image/png")).toEqual({ width: 800, height: 400 });
    expect(rasterDimensions(bytes, "image/jpeg")).toBeNull();
    bytes.writeUInt32BE(4097, 16);
    expect(rasterDimensions(bytes, "image/png")).toBeNull();
    bytes.writeUInt32BE(4000, 16);
    bytes.writeUInt32BE(4000, 20);
    expect(rasterDimensions(bytes, "image/png")).toBeNull();
    expect(rasterDimensions(Buffer.alloc(8 * 1024 * 1024 + 1), "image/png")).toBeNull();
  });
  it("bounds JPEG metadata and requires a supported frame before entropy data", () => {
    const bytes = Buffer.from("ffd8ffc00008080190032001", "hex");
    expect(rasterDimensions(bytes, "image/jpeg")).toEqual({ width: 800, height: 400 });
    for (const hex of ["ffd8ffda0008ffffffffffff", "ffd8ffc00001", "ffd8ffe100ff00"])
      expect(rasterDimensions(Buffer.from(hex, "hex"), "image/jpeg")).toBeNull();
  });
  it("admits bounded static WebP and refuses animation or unknown formats", () => {
    const bytes = Buffer.alloc(30);
    bytes.write("RIFF", 0, "ascii");
    bytes.write("WEBPVP8X", 8, "ascii");
    bytes.writeUInt32LE(10, 16);
    bytes.writeUIntLE(99, 24, 3);
    bytes.writeUIntLE(49, 27, 3);
    expect(rasterDimensions(bytes, "image/webp")).toEqual({ width: 100, height: 50 });
    bytes[20] = 2;
    expect(rasterDimensions(bytes, "image/webp")).toBeNull();
    bytes[20] = 0;
    bytes.write("VP8Z", 12, "ascii");
    expect(rasterDimensions(bytes, "image/webp")).toBeNull();
  });
});
