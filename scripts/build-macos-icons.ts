// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const macIconSizes = [16, 32, 128, 256, 512] as const;

export async function renderMacAppIcon(artwork: Image, size: number): Promise<Buffer> {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  // Traditional Electron PNG/ICNS icons need their own transparent outer
  // canvas. Keep the visible tile at 832/1024 on every scale; resizing a
  // full-bleed square makes the Dock artwork larger than neighboring icons.
  const inset = (size * 96) / 1024;
  const tileSize = size - inset * 2;
  context.beginPath();
  context.roundRect(inset, inset, tileSize, tileSize, (tileSize * 184) / 832);
  context.clip();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(artwork, inset, inset, tileSize, tileSize);
  return canvas.encode("png");
}

export async function buildMacIcons(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Regenerating the Mac ICNS requires macOS iconutil.");
  }
  const artwork = await loadImage(join(repoRoot, BRAND_ASSET_PATHS.appIconMasterPng));
  const macPng = await renderMacAppIcon(artwork, 1024);
  const sourcePng = join(repoRoot, BRAND_ASSET_PATHS.appIconMacPng);
  const resources = join(repoRoot, "apps/desktop/resources");
  mkdirSync(dirname(sourcePng), { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(sourcePng, macPng);
  writeFileSync(join(resources, "icon-macos.png"), macPng);

  const temporaryRoot = mkdtempSync(join(tmpdir(), "cafe-mac-icons-"));
  try {
    const iconset = join(temporaryRoot, "icon.iconset");
    mkdirSync(iconset);
    for (const size of macIconSizes) {
      writeFileSync(
        join(iconset, `icon_${size}x${size}.png`),
        await renderMacAppIcon(artwork, size),
      );
      writeFileSync(
        join(iconset, `icon_${size}x${size}@2x.png`),
        await renderMacAppIcon(artwork, size * 2),
      );
    }
    const result = spawnSync(
      "iconutil",
      ["-c", "icns", iconset, "-o", join(resources, "icon.icns")],
      {
        encoding: "utf8",
        shell: false,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Mac icon generation failed: ${(result.stderr || result.stdout).trim()}`);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildMacIcons();
  console.log("Updated the Mac PNG, Dock resource, and complete Retina ICNS icon set.");
}
