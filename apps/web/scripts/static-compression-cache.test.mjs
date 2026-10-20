import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  isSafeStaticCompressionCacheAncestor,
  openStaticCompressionCache,
  staticCompressionCacheLimits,
  staticCompressionOptions,
} from "./static-compression-cache.mjs";

const directories = [];
const handles = [];
const qualifiedPosix = process.platform !== "win32" && typeof process.getuid === "function";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const input = Buffer.from("owned static compression input ".repeat(32));
const compressed = (raw) => ({
  brotliData: brotliCompressSync(raw, staticCompressionOptions.brotli),
  gzipData: gzipSync(raw, staticCompressionOptions.gzip),
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cafe-compression-cache-")));
  directories.push(root);
  return { root, path: join(root, "cache") };
}
async function opened(path, options) {
  const cache = await openStaticCompressionCache(path, options);
  expect(cache).not.toBeNull();
  handles.push(cache);
  return cache;
}
async function entryPath(path) {
  const names = (await readdir(path)).filter((name) => /^[a-f0-9]{64}\.bin$/.test(name));
  expect(names).toHaveLength(1);
  return join(path, names[0]);
}
async function seed(path, raw = input) {
  const cache = await opened(path);
  const pair = compressed(raw);
  expect(await cache.get(raw)).toBeNull();
  expect(await cache.put(raw, pair)).toBe(true);
  await cache.close();
  return { pair, entry: await entryPath(path) };
}
function replacePayload(bytes, replacement, codec) {
  const headerLength = bytes.readUInt32BE(8);
  const header = JSON.parse(bytes.subarray(12, 12 + headerLength).toString("utf8"));
  const brotliData =
    codec === "brotli"
      ? replacement
      : bytes.subarray(12 + headerLength, 12 + headerLength + header.brotliBytes);
  const gzipData =
    codec === "gzip" ? replacement : bytes.subarray(12 + headerLength + header.brotliBytes);
  header.brotliBytes = brotliData.byteLength;
  header.brotliSha256 = digest(brotliData);
  header.gzipBytes = gzipData.byteLength;
  header.gzipSha256 = digest(gzipData);
  const updated = Buffer.from(JSON.stringify(header));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(updated.byteLength);
  return Buffer.concat([bytes.subarray(0, 8), size, updated, brotliData, gzipData]);
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("uses the actual maximum codec parameters and fixed finite production ceilings", () => {
  expect(staticCompressionOptions.brotli.params[constants.BROTLI_PARAM_QUALITY]).toBe(
    constants.BROTLI_MAX_QUALITY,
  );
  expect(staticCompressionOptions.gzip.level).toBe(constants.Z_BEST_COMPRESSION);
  expect(staticCompressionCacheLimits.maxRawBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(staticCompressionCacheLimits.maxEntryBytes).toBeLessThanOrEqual(34 * 1024 * 1024);
  expect(staticCompressionCacheLimits.maxBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
  expect(staticCompressionCacheLimits.maxEntries).toBeLessThanOrEqual(2048);
});

it("admits only root/current-owner ancestors whose writable children are protected", () => {
  const currentUid = 123n;
  const metadata = (uid, mode, directory = true) => ({ uid, mode, isDirectory: () => directory });
  expect(isSafeStaticCompressionCacheAncestor(metadata(currentUid, 0o700n), currentUid)).toBe(true);
  expect(isSafeStaticCompressionCacheAncestor(metadata(0n, 0o755n), currentUid)).toBe(true);
  expect(isSafeStaticCompressionCacheAncestor(metadata(0n, 0o1777n), currentUid)).toBe(true);
  expect(isSafeStaticCompressionCacheAncestor(metadata(currentUid, 0o1777n), currentUid)).toBe(
    true,
  );
  expect(isSafeStaticCompressionCacheAncestor(metadata(currentUid, 0o777n), currentUid)).toBe(
    false,
  );
  expect(isSafeStaticCompressionCacheAncestor(metadata(currentUid, 0o775n), currentUid)).toBe(
    false,
  );
  expect(isSafeStaticCompressionCacheAncestor(metadata(456n, 0o755n), currentUid)).toBe(false);
  expect(isSafeStaticCompressionCacheAncestor(metadata(456n, 0o1777n), currentUid)).toBe(false);
  expect(
    isSafeStaticCompressionCacheAncestor(metadata(currentUid, 0o700n, false), currentUid),
  ).toBe(false);
});

// These cases qualify POSIX UID/private-mode admission. Native Windows keeps
// the unchanged fresh compressor, not a false ACL qualification through chmod.
describe.runIf(qualifiedPosix)("private local compression inputs", () => {
  it("reopens an exact current raw/codec/runtime entry and rejects another raw input", async () => {
    const { path } = await fixture();
    const { pair } = await seed(path);
    const cache = await opened(path);
    expect(await cache.get(input)).toEqual(pair);
    expect(await cache.get(Buffer.from("different bytes"))).toBeNull();
    expect(cache.snapshot()).toEqual({ status: "active", hits: 1, misses: 1, stored: 0 });
    await cache.close();
    expect(await cache.get(input)).toBeNull();
  });

  it.each(["corrupt", "truncated", "runtime"])(
    "treats %s entries as misses without overwriting them",
    async (kind) => {
      const { path } = await fixture();
      const { entry } = await seed(path);
      const original = await readFile(entry);
      let altered;
      if (kind === "truncated") altered = original.subarray(0, original.byteLength - 3);
      else if (kind === "corrupt") {
        altered = Buffer.from(original);
        altered[altered.byteLength - 1] ^= 0xff;
      } else {
        altered = Buffer.from(original);
        const index = altered.indexOf(Buffer.from(process.versions.node));
        expect(index).toBeGreaterThan(12);
        altered[index] ^= 1;
      }
      await writeFile(entry, altered);
      const cache = await opened(path);
      expect(await cache.get(input)).toBeNull();
      expect(await cache.put(input, compressed(input))).toBe(false);
      expect(await readFile(entry)).toEqual(altered);
    },
  );

  it.each(["brotli", "gzip"])(
    "checks real decoded %s bytes despite a self-consistent payload hash",
    async (codec) => {
      const { path } = await fixture();
      const { entry } = await seed(path);
      const wrong = compressed(Buffer.alloc(input.byteLength, 0x78));
      await writeFile(entry, replacePayload(await readFile(entry), wrong[codec + "Data"], codec));
      const cache = await opened(path);
      expect(await cache.get(input)).toBeNull();
    },
  );

  it.each(["brotli", "gzip"])(
    "bounds %s expansion by the exact current raw length",
    async (codec) => {
      const { path } = await fixture();
      const { entry } = await seed(path);
      const expanded = compressed(Buffer.alloc(input.byteLength * 32, 0x61));
      await writeFile(
        entry,
        replacePayload(await readFile(entry), expanded[codec + "Data"], codec),
      );
      const cache = await opened(path);
      expect(await cache.get(input)).toBeNull();
      expect(cache.snapshot().hits).toBe(0);
    },
  );

  it("does not reap a busy lease and can qualify a fresh entry after its exact owner closes", async () => {
    const { path } = await fixture();
    const owner = await opened(path);
    const lease = await readFile(join(path, ".writer"));
    expect(await openStaticCompressionCache(path)).toBeNull();
    expect(await readFile(join(path, ".writer"))).toEqual(lease);
    await owner.close();
    const next = await opened(path);
    expect(await next.put(input, compressed(input))).toBe(true);
  });

  it("retains a replaced lease rather than deleting somebody else's named file", async () => {
    const { path } = await fixture();
    const owner = await opened(path);
    await unlink(join(path, ".writer"));
    const replacement = "retained replacement lease";
    await writeFile(join(path, ".writer"), replacement, { mode: 0o600, flag: "wx" });
    await owner.close();
    expect(await readFile(join(path, ".writer"), "utf8")).toBe(replacement);
    expect(await openStaticCompressionCache(path)).toBeNull();
  });

  it("preserves both namespaces after a root replacement instead of cleaning an uncertain lease", async () => {
    const { root, path } = await fixture();
    const owner = await opened(path);
    const retired = join(root, "retired-cache");
    await rename(path, retired);
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, ".writer"), "new namespace", { mode: 0o600 });
    await owner.close();
    expect(await readFile(join(path, ".writer"), "utf8")).toBe("new namespace");
    expect(
      (await readFile(join(retired, ".writer"), "utf8")).startsWith("cafe-compression-writer-v1 "),
    ).toBe(true);
  });

  it.each(["root", "ancestor", "entry", "hardlink"])(
    "refuses a %s redirection without touching its target",
    async (kind) => {
      const { root, path } = await fixture();
      const target = join(root, "retained-target");
      if (kind === "root" || kind === "ancestor") {
        await mkdir(target, { mode: 0o700 });
        await symlink(target, path, "dir");
        expect(
          await openStaticCompressionCache(kind === "root" ? path : join(path, "child-cache")),
        ).toBeNull();
        expect(await readdir(target)).toEqual([]);
      } else {
        const { entry } = await seed(path);
        await writeFile(target, "not a cache payload", { mode: 0o600 });
        await unlink(entry);
        if (kind === "entry") await symlink(target, entry);
        else await link(target, entry);
        expect(await openStaticCompressionCache(path)).toBeNull();
        expect(await readFile(target, "utf8")).toBe("not a cache payload");
        expect(
          kind === "entry"
            ? (await lstat(entry)).isSymbolicLink()
            : (await lstat(entry)).nlink === 2,
        ).toBe(true);
      }
    },
  );

  it("does not claim unknown existing files or chmod a nonprivate root", async () => {
    const { path } = await fixture();
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "keep-me.txt"), "unrelated");
    expect(await openStaticCompressionCache(path)).toBeNull();
    expect(await readdir(path)).toEqual(["keep-me.txt"]);
    await chmod(path, 0o755);
    expect(await openStaticCompressionCache(path)).toBeNull();
    expect((await lstat(path)).mode & 0o777).toBe(0o755);
    expect(await readFile(join(path, "keep-me.txt"), "utf8")).toBe("unrelated");
  });

  it("keeps full caches readable without evicting entries or exceeding entry/byte quotas", async () => {
    const { path } = await fixture();
    const owner = await opened(path, { limits: { maxEntries: 1 } });
    const pair = compressed(input);
    expect(await owner.put(input, pair)).toBe(true);
    expect(await owner.put(Buffer.from("new input"), compressed(Buffer.from("new input")))).toBe(
      false,
    );
    expect(owner.snapshot().status).toBe("read-only");
    expect(await owner.get(input)).toEqual(pair);
    await owner.close();
    const entry = await entryPath(path);
    const length = (await lstat(entry)).size;
    const byteBound = await opened(path, { limits: { maxBytes: length } });
    expect(byteBound.snapshot().status).toBe("read-only");
    expect(await byteBound.get(input)).toEqual(pair);
    expect(
      await byteBound.put(Buffer.from("new input"), compressed(Buffer.from("new input"))),
    ).toBe(false);
    expect((await lstat(entry)).size).toBe(length);
  });

  it("treats stale/future entries as misses and never refreshes or deletes them", async () => {
    const { path } = await fixture();
    const { entry } = await seed(path);
    for (const age of [staticCompressionCacheLimits.maxAgeMs + 60_000, -60_000]) {
      const time = new Date(Date.now() - age);
      await utimes(entry, time, time);
      const cache = await opened(path);
      expect(await cache.get(input)).toBeNull();
      await cache.close();
      expect((await lstat(entry)).mtimeMs).toBeCloseTo(time.getTime(), 0);
    }
  });

  it("allows only tighter finite bounds and leaves oversized inputs uncached", async () => {
    const { root, path } = await fixture();
    for (const limits of [
      { maxEntries: 0 },
      { maxBytes: Infinity },
      { maxAgeMs: -1 },
      { maxRawBytes: staticCompressionCacheLimits.maxRawBytes + 1 },
    ]) {
      expect(await openStaticCompressionCache(path, { limits })).toBeNull();
    }
    expect(await readdir(root)).toEqual([]);
    const cache = await opened(path, { limits: { maxRawBytes: 8, maxEntryBytes: 32 } });
    expect(await cache.get(input)).toBeNull();
    expect(await cache.put(input, compressed(input))).toBe(false);
    expect(await cache.put(Buffer.from("tiny"), compressed(Buffer.from("tiny")))).toBe(false);
    expect((await readdir(path)).filter((name) => name.endsWith(".bin"))).toEqual([]);
    expect(cache.snapshot().stored).toBe(0);
  });
});

it.runIf(!qualifiedPosix)(
  "does not pretend POSIX modes prove private native Windows ACLs",
  async () => {
    const { root, path } = await fixture();
    expect(await openStaticCompressionCache(path)).toBeNull();
    expect(await readdir(root)).toEqual([]);
  },
);
