import { describe, expect, it } from "vitest";
import {
  hasNativeFixtureClippedBlackContent,
  nativeFixtureClippedSampleOffsets,
} from "./nativeVisualizationFixturePixels.ts";

describe("clipped synthetic document content pixels", () => {
  it("samples exact opaque black content independently of a native15-pixel legacy gutter", () => {
    const width = 480,
      height = 320;
    const bitmap = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        if (x >= width - 15) bitmap.fill(159, offset, offset + 3);
        bitmap[offset + 3] = 255;
      }
    expect(hasNativeFixtureClippedBlackContent(bitmap, width, height)).toBe(true);
    const oldEdge = ((height - 10) * width + width - 10) * 4;
    expect(Array.from(bitmap.subarray(oldEdge, oldEdge + 4))).toEqual([159, 159, 159, 255]);
    expect(nativeFixtureClippedSampleOffsets(width, height)).toEqual(
      [120, 240, 360].map((x) => ((height - 10) * width + x) * 4),
    );
  });

  it("rejects any corrupted channel or alpha at each selected known-content point", () => {
    const width = 480,
      height = 320;
    const original = new Uint8Array(width * height * 4);
    for (let offset = 3; offset < original.length; offset += 4) original[offset] = 255;
    expect(hasNativeFixtureClippedBlackContent(original, width, height)).toBe(true);
    for (const offset of nativeFixtureClippedSampleOffsets(width, height)!)
      for (let channel = 0; channel < 4; channel++) {
        const corrupt = original.slice();
        corrupt[offset + channel] = channel === 3 ? 254 : 1;
        expect(hasNativeFixtureClippedBlackContent(corrupt, width, height)).toBe(false);
      }
    expect(hasNativeFixtureClippedBlackContent(original.subarray(4), width, height)).toBe(false);
    expect(
      hasNativeFixtureClippedBlackContent(new Uint8Array(original.length + 4), width, height),
    ).toBe(false);
  });

  it("rejects invalid native dimensions instead of selecting an unrelated pixel", () => {
    for (const invalid of [0, 79, -1, NaN, Infinity, 80.5, Number.MAX_SAFE_INTEGER]) {
      expect(nativeFixtureClippedSampleOffsets(invalid, 320)).toBeUndefined();
      expect(nativeFixtureClippedSampleOffsets(480, invalid)).toBeUndefined();
    }
    expect(nativeFixtureClippedSampleOffsets(1601, 320)).toBeUndefined();
    expect(nativeFixtureClippedSampleOffsets(480, 2001)).toBeUndefined();
    expect(nativeFixtureClippedSampleOffsets(1600, 2000)).toHaveLength(3);
  });
});
