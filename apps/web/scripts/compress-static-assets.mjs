import { constants as zlibConstants, brotliCompress, gzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative } from "node:path";
import { promisify } from "node:util";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";

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

async function writeCompressedSidecars(filePath) {
  const input = await readFile(filePath);
  const [brotliData, gzipData] = await Promise.all([
    brotliCompressAsync(input, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
      },
    }),
    gzipAsync(input, { level: zlibConstants.Z_BEST_COMPRESSION }),
  ]);

  await Promise.all([
    writeFile(`${filePath}.br`, brotliData),
    writeFile(`${filePath}.gz`, gzipData),
  ]);

  return {
    sourceBytes: input.byteLength,
    brotliBytes: brotliData.byteLength,
    gzipBytes: gzipData.byteLength,
  };
}

export async function compressStaticAssets(distDir = defaultDistDir) {
  const distStat = await stat(distDir).catch(() => null);
  if (!distStat?.isDirectory()) {
    throw new Error(`Static asset dist directory does not exist: ${distDir}`);
  }

  const files = await collectFiles(distDir);
  const compressibleFiles = files.filter(shouldCompressStaticAsset);
  let sourceBytes = 0;
  let brotliBytes = 0;
  let gzipBytes = 0;

  for (const filePath of compressibleFiles) {
    const result = await writeCompressedSidecars(filePath);
    sourceBytes += result.sourceBytes;
    brotliBytes += result.brotliBytes;
    gzipBytes += result.gzipBytes;
  }

  return {
    distDir,
    fileCount: compressibleFiles.length,
    sourceBytes,
    brotliBytes,
    gzipBytes,
    files: compressibleFiles.map((filePath) => relative(distDir, filePath)),
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
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
