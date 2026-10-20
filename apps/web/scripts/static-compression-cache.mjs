import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliDecompress, constants as zlibConstants, gunzip } from "node:zlib";

// Both the actual compressor and its input-cache identity consume these exact
// options. Opting into a local cache never lowers release compression quality.
export const staticCompressionOptions = Object.freeze({
  brotli: Object.freeze({
    params: Object.freeze({
      [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
    }),
  }),
  gzip: Object.freeze({ level: zlibConstants.Z_BEST_COMPRESSION }),
});

export const staticCompressionCacheLimits = Object.freeze({
  maxRawBytes: 16 * 1024 * 1024,
  maxEntryBytes: 34 * 1024 * 1024,
  maxBytes: 256 * 1024 * 1024,
  maxEntries: 2048,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
});
const magic = Buffer.from("CAFECMP1");
const markerContents = Buffer.from("Cafe Code private static compression cache v1\n");
const markerName = ".cafe-compression-v1";
const leaseName = ".writer";
const headerLimit = 4096;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const brotliDecompressAsync = promisify(brotliDecompress);
const gunzipAsync = promisify(gunzip);
const runtime = Object.freeze({
  node: process.versions.node,
  zlib: process.versions.zlib,
  brotli: process.versions.brotli ?? null,
  platform: process.platform,
  arch: process.arch,
  options: staticCompressionOptions,
});
const keyFor = (input) =>
  digest(
    Buffer.from(
      "cafe-static-compression-v1\0" +
        JSON.stringify(runtime) +
        "\0" +
        input.byteLength +
        "\0" +
        digest(input),
    ),
  );
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchangedFile = (a, b) =>
  sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function tightenedLimits(requested = {}) {
  const limits = { ...staticCompressionCacheLimits, ...requested };
  for (const [name, maximum] of Object.entries(staticCompressionCacheLimits)) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] <= 0 || limits[name] > maximum)
      return null;
  }
  return limits;
}

// A directory owner can rename its children even when the directory is sticky.
// Therefore sticky /tmp is admitted because its owner is root, not because the
// sticky bit grants an unrelated owner authority over this private cache.
export function isSafeStaticCompressionCacheAncestor(metadata, uid) {
  return (
    metadata.isDirectory() &&
    (metadata.uid === uid || metadata.uid === 0n) &&
    ((metadata.mode & 0o022n) === 0n || (metadata.mode & 0o1000n) !== 0n)
  );
}

/** This opt-in local optimization never grants authority from a cache hit.
 * POSIX ownership/modes are qualified here; Windows deliberately compresses
 * afresh instead of pretending Node's mode bits prove private native ACLs. */
export async function openStaticCompressionCache(directory, options = {}) {
  const limits = tightenedLimits(options.limits);
  if (
    !limits ||
    typeof process.getuid !== "function" ||
    process.platform === "win32" ||
    typeof directory !== "string" ||
    directory.length > 4096 ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    directory === parse(directory).root
  )
    return null;
  if (options.forbiddenRoot) {
    // The distribution root may have been reached through a normal path alias.
    // Compare its actual directory, and distinguish a parent component from a
    // legitimate child name such as "..cache" so cache bytes can never ship.
    let forbidden;
    try {
      forbidden = await realpath(options.forbiddenRoot);
    } catch {
      return null;
    }
    const within = relative(forbidden, directory);
    if (within === "" || (within !== ".." && !within.startsWith(".." + sep) && !isAbsolute(within)))
      return null;
  }
  const uid = BigInt(process.getuid());
  const privateFile = (metadata) =>
    metadata.isFile() &&
    metadata.uid === uid &&
    metadata.nlink === 1n &&
    (metadata.mode & 0o7077n) === 0n;
  const privateDirectory = (metadata) =>
    metadata.isDirectory() && metadata.uid === uid && (metadata.mode & 0o7077n) === 0n;
  const ancestorNames = [];
  for (let current = directory; ; current = dirname(current)) {
    ancestorNames.unshift(current);
    if (current === dirname(current)) break;
    if (ancestorNames.length > 256) return null;
  }
  const chain = [];
  let rootHandle;
  let lease;
  let leaseMetadata;
  let closed = false;
  let writable = true;
  let totalBytes = 0;
  let entryCount = 0;
  const stats = { hits: 0, misses: 0, stored: 0 };
  const checkChain = async () => {
    for (const entry of chain) {
      const now = await lstat(entry.path, { bigint: true });
      if (!sameFile(now, entry.metadata)) throw new Error("Cache namespace changed");
      // Normal system/user ancestors need not be private. A sticky writable
      // ancestor (e.g. a native temporary directory) protects its owned children;
      // a non-sticky group/world-writable ancestor cannot qualify this cache.
      if (!isSafeStaticCompressionCacheAncestor(now, uid)) throw new Error("Unsafe cache ancestor");
    }
    const held = await rootHandle.stat({ bigint: true });
    if (!privateDirectory(held) || !sameFile(held, chain.at(-1).metadata))
      throw new Error("Cache root changed");
  };
  const readPrivate = async (name, maximum) => {
    await checkChain();
    const path = join(directory, name);
    const before = await lstat(path, { bigint: true });
    if (!privateFile(before) || before.size > BigInt(maximum))
      throw new Error("Unsafe cache entry");
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      if (!unchangedFile(before, await handle.stat({ bigint: true })))
        throw new Error("Cache entry changed");
      // A checked stat followed by readFile is not bounded if another writer
      // grows the file. Read only the admitted size plus one overflow byte.
      const data = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < data.byteLength) {
        const result = await handle.read(data, offset, data.byteLength - offset, offset);
        if (result.bytesRead === 0) throw new Error("Truncated cache entry");
        offset += result.bytesRead;
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0)
        throw new Error("Growing cache entry");
      if (
        !unchangedFile(before, await handle.stat({ bigint: true })) ||
        !unchangedFile(before, await lstat(path, { bigint: true }))
      )
        throw new Error("Cache entry changed");
      await checkChain();
      return { data, metadata: before };
    } finally {
      await handle.close();
    }
  };
  const createPrivate = async (name, data) => {
    await checkChain();
    const path = join(directory, name);
    const handle = await open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!privateFile(before)) throw new Error("Unsafe created cache entry");
      await handle.writeFile(data);
      const after = await handle.stat({ bigint: true });
      if (
        !privateFile(after) ||
        !sameFile(before, after) ||
        after.size !== BigInt(data.byteLength) ||
        !sameFile(after, await lstat(path, { bigint: true }))
      )
        throw new Error("Created cache entry changed");
      await checkChain();
    } finally {
      await handle.close();
    }
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (lease && leaseMetadata) {
        await checkChain();
        const named = await lstat(join(directory, leaseName), { bigint: true });
        if (privateFile(named) && sameFile(named, leaseMetadata))
          await unlink(join(directory, leaseName));
      }
    } catch {
      // Preserve uncertain names. Never remove a stale PID's lock, a replaced
      // lease, any entry, or an unrelated object to make this optimization work.
    } finally {
      await lease?.close().catch(() => undefined);
      await rootHandle?.close().catch(() => undefined);
    }
  };

  try {
    for (const path of ancestorNames) {
      let metadata;
      try {
        metadata = await lstat(path, { bigint: true });
      } catch (error) {
        if (path !== directory || error?.code !== "ENOENT") throw error;
        await mkdir(path, { mode: 0o700 }); // Exact leaf only; never chmod existing paths.
        metadata = await lstat(path, { bigint: true });
      }
      if (!isSafeStaticCompressionCacheAncestor(metadata, uid))
        throw new Error("Unsafe cache ancestor");
      chain.push({ path, metadata });
    }
    if (!privateDirectory(chain.at(-1).metadata)) throw new Error("Cache root is not private");
    rootHandle = await open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    await checkChain();
    lease = await open(
      join(directory, leaseName),
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    leaseMetadata = await lease.stat({ bigint: true });
    if (!privateFile(leaseMetadata)) throw new Error("Unsafe cache lease");
    await lease.writeFile("cafe-compression-writer-v1 " + randomUUID() + "\n");
    const names = [];
    const listing = await opendir(directory);
    for await (const entry of listing) {
      if (names.length >= limits.maxEntries + 2) throw new Error("Cache entry limit reached");
      names.push(entry.name);
    }
    for (const name of names) {
      if (name === leaseName || name === markerName) continue;
      if (!/^[a-f0-9]{64}\.bin$/.test(name)) throw new Error("Unowned cache namespace");
      const metadata = await lstat(join(directory, name), { bigint: true });
      if (!privateFile(metadata) || metadata.size > BigInt(limits.maxEntryBytes))
        throw new Error("Unsafe cache entry");
      totalBytes += Number(metadata.size);
      entryCount++;
    }
    if (!names.includes(markerName)) {
      if (entryCount !== 0) throw new Error("Missing cache marker");
      await createPrivate(markerName, markerContents);
    } else if (
      !(await readPrivate(markerName, markerContents.byteLength)).data.equals(markerContents)
    ) {
      throw new Error("Unknown cache marker");
    }
    writable = entryCount < limits.maxEntries && totalBytes < limits.maxBytes;
    return {
      snapshot: () => ({ ...stats, status: writable ? "active" : "read-only" }),
      close,
      async get(input) {
        const miss = () => {
          stats.misses++;
          return null;
        };
        if (closed || input.byteLength > limits.maxRawBytes) return miss();
        try {
          const key = keyFor(input);
          const rawHash = digest(input);
          const { data, metadata } = await readPrivate(key + ".bin", limits.maxEntryBytes);
          const age = Date.now() - Number(metadata.mtimeMs);
          if (
            age < -1000 ||
            age > limits.maxAgeMs ||
            data.byteLength < magic.byteLength + 4 ||
            !data.subarray(0, magic.byteLength).equals(magic)
          )
            return miss();
          const headerBytes = data.readUInt32BE(magic.byteLength);
          if (headerBytes > headerLimit || headerBytes > data.byteLength - magic.byteLength - 4)
            return miss();
          const start = magic.byteLength + 4;
          const header = JSON.parse(data.subarray(start, start + headerBytes).toString("utf8"));
          const expectedKeys =
            "brotliBytes,brotliSha256,gzipBytes,gzipSha256,key,rawBytes,rawSha256,runtime,version";
          if (
            !header ||
            typeof header !== "object" ||
            Object.keys(header).sort().join(",") !== expectedKeys ||
            header.version !== 1 ||
            header.key !== key ||
            header.rawBytes !== input.byteLength ||
            header.rawSha256 !== rawHash ||
            JSON.stringify(header.runtime) !== JSON.stringify(runtime) ||
            !Number.isSafeInteger(header.brotliBytes) ||
            header.brotliBytes < 0 ||
            !Number.isSafeInteger(header.gzipBytes) ||
            header.gzipBytes < 0 ||
            start + headerBytes + header.brotliBytes + header.gzipBytes !== data.byteLength
          )
            return miss();
          const brotliData = data.subarray(
            start + headerBytes,
            start + headerBytes + header.brotliBytes,
          );
          const gzipData = data.subarray(start + headerBytes + header.brotliBytes);
          if (digest(brotliData) !== header.brotliSha256 || digest(gzipData) !== header.gzipSha256)
            return miss();
          // Decode serially under the exact current raw length, never a cached
          // claimed length. A valid raw file cannot excuse a stale sidecar.
          for (const [decode, bytes] of [
            [brotliDecompressAsync, brotliData],
            [gunzipAsync, gzipData],
          ]) {
            const decoded = await decode(bytes, { maxOutputLength: input.byteLength + 1 });
            if (decoded.byteLength !== input.byteLength || digest(decoded) !== rawHash)
              return miss();
          }
          if (closed || digest(input) !== rawHash) return miss();
          stats.hits++;
          return { brotliData, gzipData };
        } catch {
          return miss();
        }
      },
      async put(input, { brotliData, gzipData }) {
        if (closed || !writable || input.byteLength > limits.maxRawBytes) return false;
        const key = keyFor(input);
        const header = Buffer.from(
          JSON.stringify({
            version: 1,
            key,
            rawBytes: input.byteLength,
            rawSha256: digest(input),
            runtime,
            brotliBytes: brotliData.byteLength,
            gzipBytes: gzipData.byteLength,
            brotliSha256: digest(brotliData),
            gzipSha256: digest(gzipData),
          }),
        );
        const length =
          magic.byteLength + 4 + header.byteLength + brotliData.byteLength + gzipData.byteLength;
        if (
          header.byteLength > headerLimit ||
          length > limits.maxEntryBytes ||
          entryCount >= limits.maxEntries ||
          totalBytes + length > limits.maxBytes
        ) {
          writable = false;
          return false;
        }
        const size = Buffer.alloc(4);
        size.writeUInt32BE(header.byteLength);
        try {
          await createPrivate(
            key + ".bin",
            Buffer.concat([magic, size, header, brotliData, gzipData], length),
          );
          totalBytes += length;
          entryCount++;
          stats.stored++;
          writable = entryCount < limits.maxEntries && totalBytes < limits.maxBytes;
          return true;
        } catch {
          // Exclusive creation never repairs/overwrites an old or corrupt key.
          // A partial write is retained and prevents further writes this run.
          writable = false;
          return false;
        }
      },
    };
  } catch {
    await close();
    return null;
  }
}
