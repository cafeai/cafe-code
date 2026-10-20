import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { compressStaticAssets, shouldCompressStaticAsset } from "./compress-static-assets.mjs";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { openStaticCompressionCache } from "./static-compression-cache.mjs";

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

    // An invoking developer's optional cache must not become fixture state.
    const first = await compressStaticAssets(distDir, { cacheDirectory: null });
    const second = await compressStaticAssets(distDir, { cacheDirectory: null });
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

  it("optionally reuses only validated local sidecars without changing canonical output", async () => {
    const root = await realpath(await makeTempDir());
    const distDir = join(root, "dist");
    const cacheDirectory = join(root, "cache");
    await mkdir(distDir);
    const source = Buffer.from("<html>owned cache qualification</html>".repeat(16));
    await writeFile(join(distDir, "index.html"), source);

    const canonical = await compressStaticAssets(distDir, { cacheDirectory: null });
    expect(canonical).not.toHaveProperty("cache");
    const canonicalBrotli = await readFile(join(distDir, "index.html.br"));
    const canonicalGzip = await readFile(join(distDir, "index.html.gz"));
    const cold = await compressStaticAssets(distDir, { cacheDirectory });
    const warm = await compressStaticAssets(distDir, { cacheDirectory });
    const qualifiedPosix = process.platform !== "win32" && typeof process.getuid === "function";
    expect(cold.cache).toEqual(
      qualifiedPosix
        ? { status: "active", hits: 0, misses: 1, stored: 1 }
        : { status: "unavailable", hits: 0, misses: 1, stored: 0 },
    );
    expect(warm.cache).toEqual(
      qualifiedPosix
        ? { status: "active", hits: 1, misses: 0, stored: 0 }
        : { status: "unavailable", hits: 0, misses: 1, stored: 0 },
    );
    const brotli = await readFile(join(distDir, "index.html.br"));
    const gz = await readFile(join(distDir, "index.html.gz"));
    expect(brotli).toEqual(canonicalBrotli);
    expect(gz).toEqual(canonicalGzip);
    expect(brotliDecompressSync(brotli)).toEqual(source);
    expect(gunzipSync(gz)).toEqual(source);
    expect(warm.files).toEqual(["index.html"]);

    const changed = Buffer.from("<html>changed current source</html>");
    await writeFile(join(distDir, "index.html"), changed);
    const next = await compressStaticAssets(distDir, { cacheDirectory });
    expect(next.cache.hits).toBe(0);
    expect(brotliDecompressSync(await readFile(join(distDir, "index.html.br")))).toEqual(changed);
    expect(gunzipSync(await readFile(join(distDir, "index.html.gz")))).toEqual(changed);
  });

  it.each(["private-cache", "..cache"])(
    "never creates the %s opt-in cache inside distribution payloads",
    async (name) => {
      const root = await realpath(await makeTempDir());
      await writeFile(join(root, "index.html"), "<html>uncached</html>");
      const result = await compressStaticAssets(root, { cacheDirectory: join(root, name) });
      expect(result.cache).toEqual({ status: "unavailable", hits: 0, misses: 1, stored: 0 });
      expect((await readdir(root)).toSorted()).toEqual([
        "index.html",
        "index.html.br",
        "index.html.gz",
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not hide cache bytes inside an aliased distribution root",
    async () => {
      const root = await realpath(await makeTempDir());
      const distDir = join(root, "dist");
      const alias = join(root, "dist-alias");
      await mkdir(distDir);
      await symlink(distDir, alias, "dir");
      await writeFile(join(distDir, "index.html"), "<html>uncached</html>");
      const result = await compressStaticAssets(alias, {
        cacheDirectory: join(distDir, "private-cache"),
      });
      expect(result.cache.status).toBe("unavailable");
      expect((await readdir(distDir)).toSorted()).toEqual([
        "index.html",
        "index.html.br",
        "index.html.gz",
      ]);
    },
  );

  it.runIf(process.platform !== "win32" && typeof process.getuid === "function")(
    "compresses afresh when an owned cache is corrupt or busy",
    async () => {
      const root = await realpath(await makeTempDir());
      const distDir = join(root, "dist");
      const cacheDirectory = join(root, "cache");
      await mkdir(distDir);
      const source = Buffer.from("<html>must survive optional cache failure</html>");
      await writeFile(join(distDir, "index.html"), source);
      await compressStaticAssets(distDir, { cacheDirectory });
      const names = (await readdir(cacheDirectory)).filter((name) =>
        /^[a-f0-9]{64}\.bin$/.test(name),
      );
      expect(names).toHaveLength(1);
      const entry = join(cacheDirectory, names[0]);
      const corrupt = Buffer.from("retained corrupt cache bytes");
      await writeFile(entry, corrupt);
      const repairedOutput = await compressStaticAssets(distDir, { cacheDirectory });
      expect(repairedOutput.cache).toEqual({ status: "read-only", hits: 0, misses: 1, stored: 0 });
      expect(await readFile(entry)).toEqual(corrupt);
      expect(brotliDecompressSync(await readFile(join(distDir, "index.html.br")))).toEqual(source);
      expect(gunzipSync(await readFile(join(distDir, "index.html.gz")))).toEqual(source);

      const owner = await openStaticCompressionCache(cacheDirectory);
      expect(owner).not.toBeNull();
      try {
        const busyOutput = await compressStaticAssets(distDir, { cacheDirectory });
        expect(busyOutput.cache).toEqual({ status: "unavailable", hits: 0, misses: 1, stored: 0 });
        expect(brotliDecompressSync(await readFile(join(distDir, "index.html.br")))).toEqual(
          source,
        );
        expect(gunzipSync(await readFile(join(distDir, "index.html.gz")))).toEqual(source);
      } finally {
        await owner?.close();
      }
    },
  );
});
