// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import { renderMacAppIcon } from "./build-macos-icons.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

const repoRoot = resolve(import.meta.dirname, "..");

async function checkMacIcon(png: Buffer, size: number) {
  const image = await loadImage(png);
  expect([image.width, image.height]).toEqual([size, size]);
  const context = createCanvas(size, size).getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, size, size);
  const alpha = (x: number, y: number) => data[(y * size + x) * 4 + 3]!;
  const center = Math.floor(size / 2);
  const visible = Array.from({ length: size }, (_, x) => x).filter((x) => alpha(x, center) > 128);
  expect(visible[0]).toBeGreaterThanOrEqual(Math.floor(size * 0.08));
  expect(visible[0]).toBeLessThanOrEqual(Math.ceil(size * 0.11));
  expect(visible.at(-1)).toBeLessThan(size * 0.92);
  expect(alpha(center, center)).toBe(255);
  for (const corner of [
    [0, 0],
    [size - 1, 0],
    [0, size - 1],
    [size - 1, size - 1],
  ]) {
    expect(alpha(corner[0]!, corner[1]!)).toBe(0);
  }
  // The tile itself also has transparent corners, rather than just an inset
  // full square that would retain the Dock's mismatched silhouette.
  expect(alpha(Math.floor(size * 0.1), Math.floor(size * 0.1))).toBe(0);
}

describe("Mac desktop icon assets", () => {
  it("ships matching inset artwork for stable, nightly, and source/development launches", async () => {
    expect(BRAND_ASSET_PATHS.productionMacIconPng).toBe(BRAND_ASSET_PATHS.appIconMacPng);
    expect(BRAND_ASSET_PATHS.nightlyMacIconPng).toBe(BRAND_ASSET_PATHS.appIconMacPng);
    expect(BRAND_ASSET_PATHS.developmentMacIconPng).toBe(BRAND_ASSET_PATHS.appIconMacPng);
    expect(BRAND_ASSET_PATHS.productionLinuxIconPng).not.toBe(BRAND_ASSET_PATHS.appIconMacPng);
    const png = readFileSync(join(repoRoot, BRAND_ASSET_PATHS.appIconMacPng));
    expect(readFileSync(join(repoRoot, "apps/desktop/resources/icon-macos.png")).equals(png)).toBe(
      true,
    );
    await checkMacIcon(png, 1024);
  });

  it.each([16, 32, 64, 128, 256, 512, 1024])("keeps transparent padding at %i px", async (size) => {
    const artwork = await loadImage(join(repoRoot, BRAND_ASSET_PATHS.appIconMasterPng));
    await checkMacIcon(await renderMacAppIcon(artwork, size), size);
  });
});
