import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { compressStaticAssets, shouldCompressStaticAsset } from "./compress-static-assets.mjs";

const tempDirs = [];

async function makeTempDir() {
  const directory = await mkdtemp(join(tmpdir(), "cafecode-compress-static-assets-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("compress-static-assets", () => {
  it("selects only compressible static assets", () => {
    expect(shouldCompressStaticAsset("assets/app.js")).toBe(true);
    expect(shouldCompressStaticAsset("assets/app.css")).toBe(true);
    expect(shouldCompressStaticAsset("index.html")).toBe(true);
    expect(shouldCompressStaticAsset("manifest.json")).toBe(true);
    expect(shouldCompressStaticAsset("image.svg")).toBe(true);
    expect(shouldCompressStaticAsset("module.wasm")).toBe(true);
    expect(shouldCompressStaticAsset("assets/app.js.map")).toBe(false);
    expect(shouldCompressStaticAsset("assets/app.js.br")).toBe(false);
    expect(shouldCompressStaticAsset("assets/app.js.gz")).toBe(false);
    expect(shouldCompressStaticAsset("font.woff2")).toBe(false);
    expect(shouldCompressStaticAsset("icon.png")).toBe(false);
  });

  it("writes Brotli and gzip sidecars idempotently", async () => {
    const distDir = await makeTempDir();
    await writeFile(join(distDir, "index.html"), "<html>hello</html>");
    await writeFile(join(distDir, "icon.png"), "not really a png");

    const first = await compressStaticAssets(distDir);
    const second = await compressStaticAssets(distDir);
    const entries = await readdir(distDir);

    expect(first.fileCount).toBe(1);
    expect(second.fileCount).toBe(1);
    expect(entries.toSorted()).toEqual([
      "icon.png",
      "index.html",
      "index.html.br",
      "index.html.gz",
    ]);
  });
});
