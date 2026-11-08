import { createHash } from "node:crypto";
// Test-owned native files exercise the production held-descriptor boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, writeFile, rm, symlink, link } from "node:fs/promises";
// These paths belong only to the native-file admission fixture above.
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES } from "@cafecode/contracts/settings";
import { WEB_APP_ICON_VARIANTS } from "@cafecode/shared/webAppBranding";
import { parseImageHeader } from "../rasterImageHeader.ts";
import { AppIconRenderError, AppIconRenderer, renderAppIconSet } from "./AppIconRenderer.ts";

async function sourceImage(color = "#ff0000") {
  const canvas = createCanvas(120, 60);
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, 120, 60);
  return canvas.encode("png");
}

async function fixture(task: (file: { root: string; path: string; id: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cafe-derived-app-icons-"));
  try {
    const bytes = await sourceImage();
    const id = `sha256-${createHash("sha256").update(bytes).digest("hex")}.png`;
    const path = join(root, id);
    await writeFile(path, bytes, { mode: 0o600 });
    await task({ root, path, id });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("bounded native app icon derivation", () => {
  it("produces real square PNGs, preserves the complete photo and pads its maskable safe area", async () => {
    const icons = await renderAppIconSet(await sourceImage());
    const sizes = [180, 192, 512, 512, 32, 96];
    for (const [index, variant] of WEB_APP_ICON_VARIANTS.entries()) {
      expect(parseImageHeader(icons.get(variant)!)).toEqual({
        mimeType: "image/png",
        width: sizes[index],
        height: sizes[index],
      });
    }
    const canvas = createCanvas(512, 512);
    const context = canvas.getContext("2d");
    context.drawImage(await loadImage(Buffer.from(icons.get("maskable-512")!)), 0, 0);
    const pixels = context.getImageData(0, 0, 512, 512).data;
    let left = 512,
      right = -1,
      top = 512,
      bottom = -1,
      radius = 0;
    for (let y = 0; y < 512; y += 1)
      for (let x = 0; x < 512; x += 1) {
        const index = (y * 512 + x) * 4;
        if (pixels[index]! < 240 || pixels[index + 1]! > 20) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        radius = Math.max(radius, Math.hypot(x - 256, y - 256));
      }
    // Assert the portable maskable safe circle and the photo's aspect ratio,
    // without pinning padding coordinates or a particular decorative layout.
    expect(right).toBeGreaterThan(left);
    expect(radius).toBeLessThanOrEqual(512 * 0.4);
    expect((right - left + 1) / (bottom - top + 1)).toBeCloseTo(2, 1);
    expect(
      [...icons.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0),
    ).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("refuses excessive encoded bytes, oversized raster headers and non-raster input", async () => {
    const oversized = Buffer.from(await sourceImage());
    oversized.writeUInt32BE(4097, 16);
    for (const bytes of [
      oversized,
      Buffer.alloc(MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES + 1),
      Buffer.from('<svg width="1" height="1"/>'),
    ]) {
      await expect(renderAppIconSet(bytes)).rejects.toBeInstanceOf(AppIconRenderError);
    }
  });

  it("accepts a phone JPEG with orientation metadata without weakening the raster bounds", async () => {
    const canvas = createCanvas(120, 60);
    const context = canvas.getContext("2d");
    context.fillStyle = "#336699";
    context.fillRect(0, 0, 120, 60);
    const jpeg = await canvas.encode("jpeg");
    // Test-owned EXIF orientation 6, an ordinary 90-degree phone rotation.
    const orientation = Buffer.from(
      "ffe1002245786966000049492a0008000000010012010300010000000600000000000000",
      "hex",
    );
    const image = Buffer.concat([jpeg.subarray(0, 2), orientation, jpeg.subarray(2)]);
    const icons = await renderAppIconSet(image);
    expect(parseImageHeader(icons.get("app-192")!)).toEqual({
      mimeType: "image/png",
      width: 192,
      height: 192,
    });
  });

  it("coalesces the admitted icon variants, bounds pending callers and refuses a competing upload", async () => {
    await fixture(async ({ path, id }) => {
      const renderer = new AppIconRenderer();
      // All calls are admitted synchronously before the held native read can
      // settle. No sleeps, native codec timing or replay establishes the gate.
      const admitted = Array.from({ length: 16 }, () => renderer.render(id, path, "app-192"));
      const overflow = renderer.render(id, path, "app-512");
      const foreign = renderer.render(`sha256-${"b".repeat(64)}.png`, path, "app-192");
      try {
        await expect(overflow).rejects.toMatchObject({ reason: "busy" });
        await expect(foreign).rejects.toMatchObject({ reason: "busy" });
        const results = await Promise.all(admitted);
        for (const bytes of results) expect(bytes).toBe(results[0]);
        expect(parseImageHeader(results[0]!)).toEqual({
          mimeType: "image/png",
          width: 192,
          height: 192,
        });
      } finally {
        await Promise.allSettled([...admitted, overflow, foreign]);
      }
    });
  });

  it("rejects a hash mismatch without exposing native file errors", async () => {
    await fixture(async ({ path }) => {
      await expect(
        new AppIconRenderer().render(`sha256-${"f".repeat(64)}.png`, path, "app-192"),
      ).rejects.toMatchObject({
        reason: "unavailable",
        message: "Application icon is unavailable.",
      });
    });
  });

  it("retains only two decoded sets and keeps another renderer's missing file unavailable", async () => {
    await fixture(async ({ root }) => {
      const renderer = new AppIconRenderer();
      const files: Array<{ id: string; path: string }> = [];
      for (const color of ["#ff0000", "#00ff00", "#0000ff"]) {
        const bytes = await sourceImage(color);
        const id = `sha256-${createHash("sha256").update(bytes).digest("hex")}.png`;
        const path = join(root, `cached-${id}`);
        await writeFile(path, bytes, { mode: 0o600 });
        await renderer.render(id, path, "app-192");
        files.push({ id, path });
      }
      for (const file of files) await rm(file.path);
      const [evicted, retained] = files;
      await expect(
        renderer.render(retained!.id, retained!.path, "app-192"),
      ).resolves.toBeInstanceOf(Uint8Array);
      await expect(renderer.render(evicted!.id, evicted!.path, "app-192")).rejects.toMatchObject({
        reason: "unavailable",
      });
      await expect(
        new AppIconRenderer().render(retained!.id, retained!.path, "app-192"),
      ).rejects.toMatchObject({ reason: "unavailable" });
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses symlinks and multiply linked source files",
    async () => {
      await fixture(async ({ root, path, id }) => {
        const symbolic = join(root, "symbolic.png");
        await symlink(path, symbolic);
        await expect(new AppIconRenderer().render(id, symbolic, "app-192")).rejects.toBeInstanceOf(
          AppIconRenderError,
        );
        const hard = join(root, "hard.png");
        await link(path, hard);
        await expect(new AppIconRenderer().render(id, path, "app-192")).rejects.toBeInstanceOf(
          AppIconRenderError,
        );
      });
    },
  );
});
