import { MAX_PNG_BYTES, MAX_PNG_DIMENSION, MAX_PNG_PIXELS } from "@cafecode/contracts";
import type { SavePngResult } from "@cafecode/contracts";
import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

/** Fixed, content-free failures never reveal native decoder errors or paths. */
export class PngExportError extends Error {
  constructor() {
    super("The image could not be exported.");
    this.name = "PngExportError";
  }
}

interface AdmittedPng {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

export interface DecodedPngImage {
  readonly isEmpty: () => boolean;
  readonly getSize: () => { readonly width: number; readonly height: number };
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_CHUNKS = 4096;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function chunkCrc(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1)
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Admit only a complete, bounded static PNG before asking Electron's decoder
 * to allocate pixels. No URLs, SVG, APNG frames, compressed text/profile chunks,
 * trailing polyglot data or unknown chunks reach that decoder. Rasterization
 * produces this ordinary PNG subset; copy/save never interprets diagram source.
 */
export function admitPng(png: Uint8Array): AdmittedPng {
  if (!(png instanceof Uint8Array) || png.byteLength < 45 || png.byteLength > MAX_PNG_BYTES)
    throw new PngExportError();
  // Own a snapshot before any asynchronous picker or filesystem operation.
  // A renderer retaining its input buffer must not mutate already admitted data.
  const bytes = Buffer.from(png);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new PngExportError();

  let width = 0;
  let height = 0;
  let colorType = -1;
  let paletteEntries = 0;
  let idatBytes = 0;
  let endedIdat = false;
  const seen = new Set<string>();
  let offset = PNG_SIGNATURE.length;
  let chunks = 0;
  while (offset < bytes.length) {
    if (++chunks > MAX_PNG_CHUNKS || bytes.length - offset < 12) throw new PngExportError();
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new PngExportError();
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    // Buffer's ASCII decoder clears the high bit. Validate the literal octets
    // first so non-ASCII chunk tags cannot masquerade as an allowed PNG tag.
    if (
      !bytes
        .subarray(offset + 4, offset + 8)
        .every((value) => (value >= 65 && value <= 90) || (value >= 97 && value <= 122))
    )
      throw new PngExportError();
    const start = offset + 8;
    const end = start + length;
    if (chunkCrc(bytes, offset + 4, end) !== bytes.readUInt32BE(end)) throw new PngExportError();
    if (chunks === 1 && type !== "IHDR") throw new PngExportError();
    if (type !== "IDAT" && seen.has("IDAT")) endedIdat = true;

    if (type === "IHDR") {
      if (chunks !== 1 || length !== 13) throw new PngExportError();
      width = bytes.readUInt32BE(start);
      height = bytes.readUInt32BE(start + 4);
      const bitDepth = bytes[start + 8]!;
      colorType = bytes[start + 9]!;
      const allowedBitDepths: Readonly<Record<number, readonly number[]>> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        width < 1 ||
        height < 1 ||
        width > MAX_PNG_DIMENSION ||
        height > MAX_PNG_DIMENSION ||
        width * height > MAX_PNG_PIXELS ||
        !allowedBitDepths[colorType]?.includes(bitDepth) ||
        bytes[start + 10] !== 0 ||
        bytes[start + 11] !== 0 ||
        (bytes[start + 12] !== 0 && bytes[start + 12] !== 1)
      )
        throw new PngExportError();
    } else if (type === "IDAT") {
      if (endedIdat || (colorType === 3 && paletteEntries === 0)) throw new PngExportError();
      idatBytes += length;
    } else if (type === "IEND") {
      if (length !== 0 || !seen.has("IDAT") || idatBytes === 0 || end + 4 !== bytes.length)
        throw new PngExportError();
      return { bytes, width, height };
    } else {
      // These ancillary chunks have small, fixed representations and carry
      // only colors/physical dimensions. Reject duplicate or post-data metadata
      // and resource-bearing/compressed extension chunks instead of trusting the
      // native decoder's optional metadata handling.
      if (seen.has(type) || seen.has("IDAT")) throw new PngExportError();
      if (type === "PLTE") {
        if (colorType === 0 || colorType === 4 || length < 3 || length > 768 || length % 3 !== 0)
          throw new PngExportError();
        paletteEntries = length / 3;
      } else if (type === "tRNS") {
        if (
          !(
            (colorType === 0 && length === 2) ||
            (colorType === 2 && length === 6) ||
            (colorType === 3 && length > 0 && length <= paletteEntries)
          )
        )
          throw new PngExportError();
      } else if (type === "sRGB") {
        if (length !== 1 || bytes[start]! > 3) throw new PngExportError();
      } else if (type === "gAMA") {
        if (length !== 4 || bytes.readUInt32BE(start) === 0) throw new PngExportError();
      } else if (type === "cHRM") {
        if (length !== 32) throw new PngExportError();
      } else if (type === "pHYs") {
        if (length !== 9 || bytes[start + 8]! > 1) throw new PngExportError();
      } else if (type === "bKGD") {
        const expected = colorType === 3 ? 1 : colorType === 0 || colorType === 4 ? 2 : 6;
        if (length !== expected || (colorType === 3 && bytes[start]! >= paletteEntries))
          throw new PngExportError();
      } else throw new PngExportError();
    }
    seen.add(type);
    offset = end + 4;
  }
  throw new PngExportError();
}

/** The native decoder verifies pixel data after structural/resource admission. */
export function decodePng<Image extends DecodedPngImage>(
  png: Uint8Array,
  decode: (bytes: Buffer) => Image,
): { readonly bytes: Buffer; readonly image: Image } {
  try {
    const admitted = admitPng(png);
    const image = decode(admitted.bytes);
    const size = image.getSize();
    if (image.isEmpty() || size.width !== admitted.width || size.height !== admitted.height)
      throw new PngExportError();
    return { bytes: admitted.bytes, image };
  } catch {
    throw new PngExportError();
  }
}

export interface SavePngFileInput {
  /** Already admitted bytes owned by this request, never a caller-owned buffer. */
  readonly bytes: Buffer;
  readonly chooseDestination: () => Promise<{
    readonly canceled: boolean;
    readonly filePath?: string;
  }>;
  /** Closing the exact requesting window revokes the pending save authority. */
  readonly isCurrent: () => boolean;
}

const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino;

interface DirectoryIdentity {
  readonly path: string;
  readonly identity: BigIntStats;
}

/** Snapshot a bounded canonical ancestor chain, including the selected folder. */
async function exportDirectories(directory: string): Promise<readonly DirectoryIdentity[]> {
  const paths: string[] = [];
  let current = directory;
  for (;;) {
    if (paths.length >= 128) throw new PngExportError();
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const result: DirectoryIdentity[] = [];
  for (const path of paths.toReversed()) {
    const identity = await lstat(path, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new PngExportError();
    result.push({ path, identity });
  }
  return result;
}

/**
 * The native picker authorizes this one file publication. Write a private,
 * exclusive random sibling and flush it before atomic replacement, leaving an
 * existing file complete if cancellation or failure precedes the rename.
 * Never follow a destination symlink or turn renderer text into a path. Node
 * does not expose portable openat/renameat, so named identity checks are explicit
 * refusal fences, not a claim of absolute immunity to a hostile namespace race.
 */
export async function savePngFile({
  bytes,
  chooseDestination,
  isCurrent,
}: SavePngFileInput): Promise<SavePngResult> {
  let temporary: string | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let assertDirectories: (() => Promise<void>) | undefined;
  let published = false;
  try {
    if (!isCurrent()) return "cancelled";
    const selection = await chooseDestination();
    if (selection.canceled || !selection.filePath || !isCurrent()) return "cancelled";
    const selectedDestination = selection.filePath;
    if (!isAbsolute(selectedDestination)) return "failed";
    for (const character of selectedDestination) {
      const code = character.charCodeAt(0);
      if (code <= 0x1f || code === 0x7f) return "failed";
    }
    // Resolve the picker-selected folder once, then bind both its original
    // spelling and complete canonical chain. Normal host aliases (such as a
    // native temporary-directory alias) stay usable, but later alias retargeting
    // cannot silently change the destination authorized by this picker.
    const selectedDirectory = dirname(selectedDestination);
    const directory = await realpath(selectedDirectory);
    const directories = await exportDirectories(directory);
    const parentIdentity = directories.at(-1)!.identity;
    const destination = join(directory, basename(selectedDestination));
    assertDirectories = async () => {
      if ((await realpath(selectedDirectory)) !== directory) throw new PngExportError();
      for (const expected of directories) {
        const current = await lstat(expected.path, { bigint: true });
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          !sameIdentity(current, expected.identity)
        )
          throw new PngExportError();
      }
      if (directoryHandle) {
        const held = await directoryHandle.stat({ bigint: true });
        if (!held.isDirectory() || !sameIdentity(held, parentIdentity)) throw new PngExportError();
      }
    };
    await assertDirectories();
    // POSIX supplements the same named-chain fences with a no-follow held
    // directory descriptor. Windows retains inherited user ACLs and portable
    // bigint directory/file identity checks without requiring directory handles,
    // chmod or privileged symlink creation. See AGENTS.md's Windows notes.
    if (process.platform !== "win32") {
      directoryHandle = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await assertDirectories();
    }
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) return "failed";
    temporary = join(directory, `.${basename(destination)}.cafe-${randomUUID()}.tmp`);
    fileHandle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryIdentity = await fileHandle.stat({ bigint: true });
    if (
      !temporaryIdentity.isFile() ||
      temporaryIdentity.size !== 0n ||
      temporaryIdentity.nlink !== 1n
    )
      throw new PngExportError();
    const assertTemporary = async () => {
      const named = await lstat(temporary!, { bigint: true });
      const held = await fileHandle!.stat({ bigint: true });
      if (
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.nlink !== 1n ||
        !sameIdentity(named, temporaryIdentity!) ||
        !sameIdentity(held, temporaryIdentity!)
      )
        throw new PngExportError();
    };
    // Exclusive open first creates an empty private file. Revalidate the entire
    // namespace before writing any PNG bytes through that held descriptor: a
    // directory substitution during open may leave empty evidence, never pixels
    // in a newly redirected folder. Keep the same descriptor until publication.
    await assertDirectories();
    await assertTemporary();
    if (!isCurrent()) return "cancelled";
    await fileHandle.writeFile(bytes);
    await fileHandle.sync();
    await assertDirectories();
    await assertTemporary();
    if (!isCurrent()) return "cancelled";
    // Rename replaces the selected directory entry, rather than opening it for
    // writing; even a late symlink replacement cannot redirect bytes to its
    // target. Reject an observed late symlink/non-file before publication too.
    const latest = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (latest && (!latest.isFile() || latest.isSymbolicLink())) return "failed";
    if (!isCurrent()) return "cancelled";
    await assertDirectories();
    await assertTemporary();
    // These namespace observations await filesystem work. A close/reload
    // during either wait revokes publication before the rename is dispatched.
    if (!isCurrent()) return "cancelled";
    await rename(temporary, destination);
    published = true;
    if (directoryHandle) await directoryHandle.sync();
    return "saved";
  } catch {
    return "failed";
  } finally {
    // Namespace uncertainty revokes cleanup as well as publication. Never unlink
    // a replacement sibling or a file in a redirected parent. Preserving an
    // uncertain private orphan is safer than deleting evidence we no longer own.
    if (!published && temporary && temporaryIdentity && assertDirectories) {
      try {
        await assertDirectories();
        const named = await lstat(temporary, { bigint: true });
        if (
          named.isFile() &&
          !named.isSymbolicLink() &&
          named.nlink === 1n &&
          sameIdentity(named, temporaryIdentity)
        )
          await unlink(temporary);
      } catch {
        /* An inconclusive namespace never authorizes cleanup. */
      }
    }
    await fileHandle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  }
}
