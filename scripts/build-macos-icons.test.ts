// @effect-diagnostics nodeBuiltinImport:off
import { loadImage } from "@napi-rs/canvas";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { renderMacAppIcon } from "./build-macos-icons.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

const repoRoot = resolve(import.meta.dirname, "..");

async function checkMacIcon(png: Buffer, size: number) {
  const image = await loadImage(png);
  expect([image.width, image.height]).toEqual([size, size]);
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

  it.each([16, 32, 64, 128, 256, 512, 1024])(
    "renders a decodable icon at required %i px",
    async (size) => {
      const artwork = await loadImage(join(repoRoot, BRAND_ASSET_PATHS.appIconMasterPng));
      await checkMacIcon(await renderMacAppIcon(artwork, size), size);
    },
  );
});
