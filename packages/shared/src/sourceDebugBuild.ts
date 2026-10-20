import { createHash, randomUUID } from "node:crypto";
import * as Data from "effect/Data";
// Native filesystem boundary: preserve descriptor, no-follow and bigint identity operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
// Native path boundary: preserve host drive, namespace and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path";

export type SourceDebugBuildRole = "desktop" | "server";
const CAPABILITY = "cafecode.debug-data-profile.v1";
const MAX_FILES = 256;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
// Apply one closure-wide IO budget, not MAX_FILES independent file budgets:
// a forged local receipt must not turn the synchronous startup guard into a
// multi-gigabyte hashing job. Current emitted closures are far below this cap.
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

export class SourceDebugBuildError extends Data.TaggedError("SourceDebugBuildError")<{}> {
  constructor() {
    super();
    this.name = "SourceDebugBuildError";
  }

  override get message() {
    return "Source Debug build is missing, outdated or inconsistent. Rebuild using yarn build:desktop before starting Cafe Code. No application or provider was started.";
  }
}

export function sourceDebugBuildManifestPath(entryPath: string): string {
  return `${entryPath}.debug-profile.json`;
}

function inspectFile(filePath: string) {
  const named = lstatSync(filePath, { bigint: true });
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
    named.size < 0n ||
    named.size > BigInt(MAX_FILE_BYTES)
  )
    throw new SourceDebugBuildError();
  return named;
}

function digestFile(filePath: string, expectedBytes: number) {
  const named = inspectFile(filePath);
  // Size admission occurs before opening candidate content, including when a
  // file changes between closure preflight and this particular hash.
  if (named.size !== BigInt(expectedBytes)) throw new SourceDebugBuildError();
  const fd = openSync(
    filePath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size)
      throw new SourceDebugBuildError();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const count = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, expectedBytes - bytes + 1),
        null,
      );
      if (count === 0) break;
      bytes += count;
      if (bytes > expectedBytes) throw new SourceDebugBuildError();
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd, { bigint: true });
    const renamed = lstatSync(filePath, { bigint: true });
    if (
      bytes !== Number(named.size) ||
      after.size !== named.size ||
      after.mtimeNs !== named.mtimeNs ||
      renamed.dev !== named.dev ||
      renamed.ino !== named.ino ||
      renamed.size !== named.size
    )
      throw new SourceDebugBuildError();
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

function addClosureBytes(total: number, bytes: number): number {
  const next = total + bytes;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > MAX_FILE_BYTES ||
    !Number.isSafeInteger(next) ||
    next > MAX_TOTAL_BYTES
  )
    throw new SourceDebugBuildError();
  return next;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function localFile(root: string, relative: string): string {
  if (
    relative.length === 0 ||
    relative.length > 1024 ||
    relative.includes("\\") ||
    path.isAbsolute(relative) ||
    relative.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new SourceDebugBuildError();
  return path.join(root, ...relative.split("/"));
}

function readManifest(filename: string): string {
  const named = lstatSync(filename, { bigint: true });
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
    named.size > BigInt(MAX_MANIFEST_BYTES)
  )
    throw new SourceDebugBuildError();
  const fd = openSync(
    filename,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== named.dev || opened.ino !== named.ino) throw new SourceDebugBuildError();
    const buffer = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      bytes > MAX_MANIFEST_BYTES ||
      bytes !== Number(named.size) ||
      after.size !== named.size ||
      after.mtimeNs !== named.mtimeNs
    )
      throw new SourceDebugBuildError();
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Build-only receipt, not an authentication signature or protection against
 * a same-user source editor forging outputs. The exact successful emitted JS
 * closure is bound so an old entry/chunk cannot silently regain Production
 * defaults after the source launcher has selected Debug. */
export function publishSourceDebugBuildManifest(
  entryPath: string,
  role: SourceDebugBuildRole,
  outputFiles: readonly string[],
  expectedCode?: Readonly<Record<string, string>>,
): void {
  const root = path.dirname(entryPath);
  const files = [...new Set(outputFiles)].toSorted();
  if (files.length === 0 || files.length > MAX_FILES || !files.includes(entryPath))
    throw new SourceDebugBuildError();
  let totalBytes = 0;
  // Preflight the complete named closure before opening or hashing any file.
  // The verifier uses the identical bound for received and actual sizes.
  const prepared = files.map((file) => {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const filename = localFile(root, relative);
    const bytes = Number(inspectFile(filename).size);
    totalBytes = addClosureBytes(totalBytes, bytes);
    return { file, relative, filename, bytes };
  });
  const receipts = prepared.map(({ file, relative, filename, bytes }) => {
    const digest = digestFile(filename, bytes);
    if (expectedCode !== undefined) {
      const code = expectedCode[file];
      if (
        typeof code !== "string" ||
        Buffer.byteLength(code) !== digest.bytes ||
        createHash("sha256").update(code).digest("hex") !== digest.sha256
      )
        throw new SourceDebugBuildError();
    }
    return { file: relative, ...digest };
  });
  const manifestPath = sourceDebugBuildManifestPath(entryPath);
  const temporary = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, capability: CAPABILITY, role, entry: path.basename(entryPath), files: receipts })}\n`,
      // Public, non-secret build metadata travels with the readable bundle.
      // A system-wide staged runtime must not require the builder's UID to
      // inspect its capability receipt. Profile credentials remain private.
      { flag: "wx", mode: 0o644 },
    );
    renameSync(temporary, manifestPath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Preserve unrelated namespace entries. */
    }
    throw error;
  }
}

/** Metadata and hashes only. Never execute the candidate bundle to ask whether
 * it supports Debug: an old build could open Production during that probe. */
export function assertSourceDebugBuild(entryPath: string, role: SourceDebugBuildRole): void {
  try {
    const manifestPath = sourceDebugBuildManifestPath(entryPath);
    const manifest: unknown = JSON.parse(readManifest(manifestPath));
    if (
      !hasExactKeys(manifest, ["version", "capability", "role", "entry", "files"]) ||
      manifest.version !== 1 ||
      manifest.capability !== CAPABILITY ||
      manifest.role !== role ||
      manifest.entry !== path.basename(entryPath) ||
      !Array.isArray(manifest.files) ||
      manifest.files.length === 0 ||
      manifest.files.length > MAX_FILES
    )
      throw new SourceDebugBuildError();
    let foundEntry = false;
    let totalBytes = 0;
    const seen = new Set<string>();
    const prepared: {
      readonly filename: string;
      readonly bytes: number;
      readonly sha256: string;
    }[] = [];
    // Validate every received field and the aggregate budget before inspecting
    // candidate outputs. A later oversized receipt cannot follow earlier hash
    // work, even when its individual advertised files fit the per-file limit.
    for (const received of manifest.files) {
      if (!hasExactKeys(received, ["file", "bytes", "sha256"])) throw new SourceDebugBuildError();
      const receipt = received;
      if (
        typeof receipt.file !== "string" ||
        seen.has(receipt.file) ||
        typeof receipt.bytes !== "number" ||
        typeof receipt.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(receipt.sha256)
      )
        throw new SourceDebugBuildError();
      totalBytes = addClosureBytes(totalBytes, receipt.bytes);
      seen.add(receipt.file);
      prepared.push({
        filename: localFile(path.dirname(entryPath), receipt.file),
        bytes: receipt.bytes,
        sha256: receipt.sha256,
      });
      if (receipt.file === path.basename(entryPath)) foundEntry = true;
    }
    if (!foundEntry) throw new SourceDebugBuildError();
    // A small declared size cannot hide a large on-disk closure. Do this second
    // complete metadata pass before the first candidate content open/hash.
    for (const receipt of prepared) {
      if (inspectFile(receipt.filename).size !== BigInt(receipt.bytes))
        throw new SourceDebugBuildError();
    }
    for (const receipt of prepared) {
      const digest = digestFile(receipt.filename, receipt.bytes);
      if (digest.bytes !== receipt.bytes || digest.sha256 !== receipt.sha256)
        throw new SourceDebugBuildError();
    }
  } catch {
    throw new SourceDebugBuildError();
  }
}

export function assertSourceDebugDesktopBuilds(desktopDirectory: string): void {
  assertSourceDebugBuild(path.join(desktopDirectory, "dist-electron", "main.cjs"), "desktop");
  assertSourceDebugBuild(path.resolve(desktopDirectory, "../server/dist/bin.mjs"), "server");
}
