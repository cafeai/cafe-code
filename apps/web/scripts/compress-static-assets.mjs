import { brotliCompress, gzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative } from "node:path";
import { promisify } from "node:util";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import {
  openStaticCompressionCache,
  staticCompressionOptions,
} from "./static-compression-cache.mjs";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultDistDir = join(scriptDir, "..", "dist");

export const compressibleExtensions = new Set([".js", ".css", ".html", ".json", ".svg", ".wasm"]);
const excludedExtensions = new Set([
  ".br",
  ".gz",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
]);

export function shouldCompressStaticAsset(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (excludedExtensions.has(extension)) return false;
  if (filePath.endsWith(".map")) return false;
  return compressibleExtensions.has(extension);
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

async function writeCompressedSidecars(filePath, cache) {
  const input = await readFile(filePath);
  const cached = await cache?.get(input);
  const [brotliData, gzipData] = cached
    ? [cached.brotliData, cached.gzipData]
    : await Promise.all([
        brotliCompressAsync(input, staticCompressionOptions.brotli),
        gzipAsync(input, staticCompressionOptions.gzip),
      ]);

  await Promise.all([
    writeFile(`${filePath}.br`, brotliData),
    writeFile(`${filePath}.gz`, gzipData),
  ]);
  if (!cached) await cache?.put(input, { brotliData, gzipData });

  return {
    sourceBytes: input.byteLength,
    brotliBytes: brotliData.byteLength,
    gzipBytes: gzipData.byteLength,
  };
}

export async function compressStaticAssets(distDir = defaultDistDir, options = {}) {
  const distStat = await stat(distDir).catch(() => null);
  if (!distStat?.isDirectory()) {
    throw new Error(`Static asset dist directory does not exist: ${distDir}`);
  }

  const files = await collectFiles(distDir);
  const compressibleFiles = files.filter(shouldCompressStaticAsset);
  let sourceBytes = 0;
  let brotliBytes = 0;
  let gzipBytes = 0;
  const cacheDirectory =
    options.cacheDirectory === undefined
      ? process.env.CAFE_CODE_ASSET_COMPRESSION_CACHE
      : options.cacheDirectory;
  const optedIn = typeof cacheDirectory === "string" && cacheDirectory !== "";
  const cache = optedIn
    ? await openStaticCompressionCache(cacheDirectory, { forbiddenRoot: distDir })
    : null;
  let cacheSummary;
  try {
    // Files remain serial; only the same two existing codec operations overlap.
    for (const filePath of compressibleFiles) {
      const result = await writeCompressedSidecars(filePath, cache);
      sourceBytes += result.sourceBytes;
      brotliBytes += result.brotliBytes;
      gzipBytes += result.gzipBytes;
    }
    if (optedIn)
      cacheSummary = cache?.snapshot() ?? {
        status: "unavailable",
        hits: 0,
        misses: compressibleFiles.length,
        stored: 0,
      };
  } finally {
    await cache?.close();
  }

  return {
    distDir,
    fileCount: compressibleFiles.length,
    sourceBytes,
    brotliBytes,
    gzipBytes,
    files: compressibleFiles.map((filePath) => relative(distDir, filePath)),
    ...(cacheSummary ? { cache: cacheSummary } : {}),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const distDir = process.argv[2] ?? defaultDistDir;
  compressStaticAssets(distDir)
    .then((result) => {
      console.log(
        `[compress-static-assets] wrote ${result.fileCount} Brotli/gzip sidecar pairs ` +
          `(${result.sourceBytes} source bytes, ${result.brotliBytes} Brotli bytes, ` +
          `${result.gzipBytes} gzip bytes)`,
      );
      if (result.cache)
        console.log(
          `[compress-static-assets] local input cache ${result.cache.status}: ` +
            `${result.cache.hits} reused, ${result.cache.misses} fresh, ${result.cache.stored} stored`,
        );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
