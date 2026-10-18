import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import * as path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

export type ApplicationBuildComponent = "web" | "server";
export const APPLICATION_BUILD_VERSION_MANIFEST_FILENAME = "application-build-version.json";

const MAX_VERSION_LENGTH = 128;
const MAX_FILES = 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_RELATIVE_PATH_LENGTH = 1024;
// Build inputs use exact SemVer, not the deliberately lenient compatibility
// parser used for legacy runtime checks. Numeric prerelease identifiers must
// not have leading zeroes; build identifiers may contain them under SemVer2.
const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const OUTPUT_SEGMENT = /^[0-9A-Za-z][0-9A-Za-z._-]*$/u;

export class ApplicationBuildVersionError extends Error {
  constructor() {
    super(
      "Application build version or emitted output is missing, invalid or inconsistent. Rebuild the web and server outputs with the intended application version before packaging.",
    );
    this.name = "ApplicationBuildVersionError";
  }
}

function refuse(): never {
  throw new ApplicationBuildVersionError();
}

function admittedVersion(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_VERSION_LENGTH)
    refuse();
  const match = SEMVER.exec(value);
  if (!match || ![match[1], match[2], match[3]].every((part) => Number.isSafeInteger(Number(part))))
    refuse();
  if (
    match[4]
      ?.split(".")
      .some((part) => /^[0-9]+$/u.test(part) && part.length > 1 && part[0] === "0")
  )
    refuse();
  return value;
}

/** One build identity, resolved before compiling any component. Whitespace-only
 * configuration means omission; a nonblank invalid override must never quietly
 * fall back to a package version and produce mislabeled release artifacts. */
export function resolveApplicationBuildVersion(
  configured: string | undefined,
  fallback: string,
): string {
  if (
    configured !== undefined &&
    (typeof configured !== "string" || configured.length > MAX_VERSION_LENGTH * 2)
  )
    refuse();
  if (typeof fallback !== "string" || fallback.length > MAX_VERSION_LENGTH * 2) refuse();
  return admittedVersion(configured?.trim() || fallback.trim());
}

function assertComponent(component: unknown): asserts component is ApplicationBuildComponent {
  if (component !== "web" && component !== "server") refuse();
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function outputRoot(directory: string): string {
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    directory.length > 4096 ||
    directory.includes("\0")
  )
    refuse();
  return path.resolve(directory);
}

function outputFile(root: string, relative: unknown): string {
  if (
    typeof relative !== "string" ||
    relative.length === 0 ||
    relative.length > MAX_RELATIVE_PATH_LENGTH ||
    relative.includes("\\") ||
    relative
      .split("/")
      .some((segment) => !OUTPUT_SEGMENT.test(segment) || segment === "." || segment === "..") ||
    !/\.(?:[cm]?js|html)$/u.test(relative)
  )
    refuse();
  return path.join(root, ...relative.split("/"));
}

type DirectoryObservation = { readonly name: string; readonly metadata: BigIntStats };

/** Reject output-root and descendant directory links, not just the last file.
 * Build receipts are local consistency checks, not a sandbox against a person
 * controlling this same checkout and changing names between native operations. */
function observeDirectories(root: string, filename: string): readonly DirectoryObservation[] {
  const directories = [root];
  const relative = path.relative(root, path.dirname(filename));
  if (relative) {
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      directories.push(current);
    }
  }
  return directories.map((name) => {
    const metadata = lstatSync(name, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) refuse();
    return { name, metadata };
  });
}

function recheckDirectories(observations: readonly DirectoryObservation[]): void {
  for (const { name, metadata } of observations) {
    const current = lstatSync(name, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino
    )
      refuse();
  }
}

function inspectFile(filename: string, maxBytes: number): BigIntStats {
  const metadata = lstatSync(filename, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size < 0n ||
    metadata.size > BigInt(maxBytes)
  )
    refuse();
  return metadata;
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    after.nlink === 1n &&
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.mtimeNs === before.mtimeNs &&
    after.ctimeNs === before.ctimeNs
  );
}

function addBytes(total: number, bytes: number): number {
  const next = total + bytes;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > MAX_FILE_BYTES ||
    !Number.isSafeInteger(next) ||
    next > MAX_TOTAL_BYTES
  )
    refuse();
  return next;
}

function digestFile(root: string, filename: string, expectedBytes: number): string {
  const directories = observeDirectories(root, filename);
  const before = inspectFile(filename, MAX_FILE_BYTES);
  if (before.size !== BigInt(expectedBytes)) refuse();
  const fd = openSync(
    filename,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    if (!sameFile(before, fstatSync(fd, { bigint: true }))) refuse();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let observed = 0;
    for (;;) {
      const count = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, expectedBytes - observed + 1),
        null,
      );
      if (count === 0) break;
      observed += count;
      if (observed > expectedBytes) refuse();
      hash.update(buffer.subarray(0, count));
    }
    if (
      observed !== expectedBytes ||
      !sameFile(before, fstatSync(fd, { bigint: true })) ||
      !sameFile(before, lstatSync(filename, { bigint: true }))
    )
      refuse();
    recheckDirectories(directories);
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

/** Native decompression needs the bounded compressed input in memory. Admit
 * its full metadata budget first, read at most the admitted bytes plus one,
 * and retain the same named/held identity checks as ordinary payload hashing. */
function readSidecar(root: string, filename: string, expectedBytes: number): Buffer {
  const directories = observeDirectories(root, filename);
  const before = inspectFile(filename, MAX_FILE_BYTES);
  if (before.size !== BigInt(expectedBytes)) refuse();
  const fd = openSync(
    filename,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    if (!sameFile(before, fstatSync(fd, { bigint: true }))) refuse();
    const buffer = Buffer.allocUnsafe(expectedBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (
      bytes !== expectedBytes ||
      !sameFile(before, fstatSync(fd, { bigint: true })) ||
      !sameFile(before, lstatSync(filename, { bigint: true }))
    )
      refuse();
    recheckDirectories(directories);
    return buffer.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
}

function requireEntries(component: ApplicationBuildComponent, files: ReadonlySet<string>): void {
  if (component === "web") {
    if (!files.has("index.html") || ![...files].some((name) => /\.[cm]?js$/u.test(name))) refuse();
  } else if (!files.has("bin.mjs") || !files.has("launcher.mjs")) refuse();
}

function readManifest(root: string): unknown {
  const filename = path.join(root, APPLICATION_BUILD_VERSION_MANIFEST_FILENAME);
  const directories = observeDirectories(root, filename);
  const before = inspectFile(filename, MAX_MANIFEST_BYTES);
  const fd = openSync(
    filename,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    if (!sameFile(before, fstatSync(fd, { bigint: true }))) refuse();
    const buffer = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (
      bytes !== Number(before.size) ||
      bytes > MAX_MANIFEST_BYTES ||
      !sameFile(before, fstatSync(fd, { bigint: true })) ||
      !sameFile(before, lstatSync(filename, { bigint: true }))
    )
      refuse();
    recheckDirectories(directories);
    return JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

/** Bind the exact successful emitted bytes, not whichever older files happened
 * to be present in dist. No component is executed or rewritten to discover its
 * version. A missing/changed payload cannot acquire a successful new receipt. */
export function publishApplicationBuildVersionManifest(
  outputDirectory: string,
  component: ApplicationBuildComponent,
  version: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): void {
  let temporary: { filename: string; metadata: BigIntStats } | undefined;
  try {
    assertComponent(component);
    const applicationVersion = admittedVersion(version);
    const root = outputRoot(outputDirectory);
    if (
      !files ||
      typeof files !== "object" ||
      Array.isArray(files) ||
      Object.getOwnPropertySymbols(files).length !== 0
    )
      refuse();
    const descriptors = Object.getOwnPropertyDescriptors(files);
    const names = Object.keys(descriptors).toSorted();
    if (names.length === 0 || names.length > MAX_FILES) refuse();
    requireEntries(component, new Set(names));
    let total = 0;
    const seenIdentities = new Set<string>();
    // Admit every expected and actual size, name and namespace before the first
    // content hash; a forged large tail cannot cause earlier unbounded work.
    const prepared = names.map((file) => {
      const descriptor = descriptors[file]!;
      if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) refuse();
      const code: unknown = descriptor.value;
      if (typeof code !== "string" && !(code instanceof Uint8Array)) refuse();
      const bytes = typeof code === "string" ? Buffer.byteLength(code) : code.byteLength;
      total = addBytes(total, bytes);
      const filename = outputFile(root, file);
      observeDirectories(root, filename);
      const metadata = inspectFile(filename, MAX_FILE_BYTES);
      const identity = `${metadata.dev}:${metadata.ino}`;
      if (metadata.size !== BigInt(bytes) || seenIdentities.has(identity)) refuse();
      seenIdentities.add(identity);
      return { file, filename, bytes, code };
    });
    const receipts = prepared.map(({ file, filename, bytes, code }) => {
      const sha256 = digestFile(root, filename, bytes);
      if (createHash("sha256").update(code).digest("hex") !== sha256) refuse();
      return { file, bytes, sha256 };
    });
    const manifest = Buffer.from(
      `${JSON.stringify({ version: 1, component, applicationVersion, files: receipts })}\n`,
    );
    if (manifest.byteLength > MAX_MANIFEST_BYTES) refuse();
    const filename = path.join(root, APPLICATION_BUILD_VERSION_MANIFEST_FILENAME);
    const directories = observeDirectories(root, filename);
    try {
      const previous = lstatSync(filename, { bigint: true });
      if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1n) refuse();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const candidate = `${filename}.${randomUUID()}.tmp`;
    const fd = openSync(
      candidate,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      0o644,
    );
    try {
      temporary = { filename: candidate, metadata: fstatSync(fd, { bigint: true }) };
      writeFileSync(fd, manifest);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    recheckDirectories(directories);
    const ready = lstatSync(candidate, { bigint: true });
    if (
      !ready.isFile() ||
      ready.isSymbolicLink() ||
      ready.nlink !== 1n ||
      ready.dev !== temporary.metadata.dev ||
      ready.ino !== temporary.metadata.ino ||
      ready.size !== BigInt(manifest.byteLength)
    )
      refuse();
    renameSync(candidate, filename);
    temporary = undefined;
    recheckDirectories(directories);
  } catch {
    if (temporary) {
      try {
        const named = lstatSync(temporary.filename, { bigint: true });
        if (
          named.dev === temporary.metadata.dev &&
          named.ino === temporary.metadata.ino &&
          named.isFile() &&
          !named.isSymbolicLink() &&
          named.nlink === 1n
        )
          unlinkSync(temporary.filename);
      } catch {
        /* An uncertain replacement is preserved, never removed. */
      }
    }
    throw new ApplicationBuildVersionError();
  }
}

/** Rehash inert emitted files before packaging. Every existing preferred HTTP
 * representation must also decode to those exact bytes: a current raw bundle
 * beside stale .br/.gz files otherwise still serves the wrong application.
 * This is not publisher authentication and cannot defend against a same-user
 * editor forging both payload bytes and their local build receipt. */
export function verifyApplicationBuildVersionManifest(
  outputDirectory: string,
  component: ApplicationBuildComponent,
  expectedVersion: string,
): void {
  try {
    assertComponent(component);
    const expected = admittedVersion(expectedVersion);
    const root = outputRoot(outputDirectory);
    const manifest = readManifest(root);
    if (
      !exactKeys(manifest, ["version", "component", "applicationVersion", "files"]) ||
      manifest.version !== 1 ||
      manifest.component !== component ||
      manifest.applicationVersion !== expected ||
      !Array.isArray(manifest.files) ||
      manifest.files.length === 0 ||
      manifest.files.length > MAX_FILES
    )
      refuse();
    let total = 0;
    const seen = new Set<string>();
    const prepared = manifest.files.map((received: unknown) => {
      if (
        !exactKeys(received, ["file", "bytes", "sha256"]) ||
        typeof received.file !== "string" ||
        seen.has(received.file) ||
        typeof received.bytes !== "number" ||
        typeof received.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(received.sha256)
      )
        refuse();
      total = addBytes(total, received.bytes);
      seen.add(received.file);
      return {
        filename: outputFile(root, received.file),
        bytes: received.bytes,
        sha256: received.sha256,
      };
    });
    requireEntries(component, seen);
    const seenIdentities = new Set<string>();
    const sidecars: {
      readonly filename: string;
      readonly compressedBytes: number;
      readonly encoding: "br" | "gz";
      readonly payloadBytes: number;
      readonly payloadSha256: string;
    }[] = [];
    for (const receipt of prepared) {
      observeDirectories(root, receipt.filename);
      const metadata = inspectFile(receipt.filename, MAX_FILE_BYTES);
      const identity = `${metadata.dev}:${metadata.ino}`;
      if (metadata.size !== BigInt(receipt.bytes) || seenIdentities.has(identity)) refuse();
      seenIdentities.add(identity);
      for (const encoding of ["br", "gz"] as const) {
        const filename = `${receipt.filename}.${encoding}`;
        let compressed: BigIntStats;
        try {
          compressed = inspectFile(filename, MAX_FILE_BYTES);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
        const compressedBytes = Number(compressed.size);
        // Raw and compressed representations share one finite IO budget. No
        // candidate hashing/decompression begins before this complete pass.
        total = addBytes(total, compressedBytes);
        const sidecarIdentity = `${compressed.dev}:${compressed.ino}`;
        if (seenIdentities.has(sidecarIdentity)) refuse();
        seenIdentities.add(sidecarIdentity);
        sidecars.push({
          filename,
          compressedBytes,
          encoding,
          payloadBytes: receipt.bytes,
          payloadSha256: receipt.sha256,
        });
      }
    }
    for (const receipt of prepared) {
      if (digestFile(root, receipt.filename, receipt.bytes) !== receipt.sha256) refuse();
    }
    for (const sidecar of sidecars) {
      const compressed = readSidecar(root, sidecar.filename, sidecar.compressedBytes);
      // Native zlib applies this bound while decoding, not after allocating a
      // decompression bomb. Node requires a positive allowance, so an empty raw
      // file gets1 byte and the exact-length check still requires zero output.
      const options = { maxOutputLength: Math.max(1, sidecar.payloadBytes) };
      const decoded =
        sidecar.encoding === "br"
          ? brotliDecompressSync(compressed, options)
          : gunzipSync(compressed, options);
      if (
        decoded.byteLength !== sidecar.payloadBytes ||
        createHash("sha256").update(decoded).digest("hex") !== sidecar.payloadSha256
      )
        refuse();
    }
  } catch {
    throw new ApplicationBuildVersionError();
  }
}
