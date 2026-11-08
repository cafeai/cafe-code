// Exact no-follow descriptors and bigint namespace identity are required before
// retiring one generated compiler file; Effect filesystem APIs do not expose them.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { constants, type BigIntStats } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstat, mkdtemp, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { isAbsolute, join, resolve } from "node:path";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const limit = 16_777_216n;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class LocalTypecheckMetadataError extends Error {
  constructor() {
    super("Local typecheck metadata could not be safely retired; fresh qualification was refused.");
    this.name = "LocalTypecheckMetadataError";
  }
}

function sameFile(left: BigIntStats, right: BigIntStats, includeChangeTime = true) {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === 1n &&
    right.nlink === 1n &&
    left.mtimeNs === right.mtimeNs &&
    (!includeChangeTime || left.ctimeNs === right.ctimeNs)
  );
}

function generatedBuildInfo(value: unknown) {
  return (
    record(value) &&
    value.version === "5.9.3" &&
    Array.isArray(value.fileNames) &&
    value.fileNames.length > 0 &&
    value.fileNames.every((name) => typeof name === "string" && name.length > 0) &&
    Array.isArray(value.fileInfos) &&
    value.fileInfos.length === value.fileNames.length &&
    value.fileInfos.every(
      (info) => typeof info === "string" || (record(info) && typeof info.version === "string"),
    )
  );
}

/** Only an actual cache miss calls this helper. Default generated build-info
 * is not trusted semantic qualification after diagnostic/Effect changes. Never
 * chase configured paths, alter compiler options, or remove unknown contents.
 * The local receipt session is disabled on Windows rather than borrowing POSIX
 * ownership evidence. This boundary does not protect against a malicious same-
 * UID actor who can also rewrite this runner and its private quarantine. */
export async function retireLocalTypecheckMetadata(program: {
  readonly cwd: string;
}): Promise<void> {
  if (
    process.platform === "win32" ||
    !isAbsolute(program.cwd) ||
    resolve(program.cwd) !== program.cwd
  )
    throw new LocalTypecheckMetadataError();
  try {
    const cwd = program.cwd;
    if ((await realpath(cwd)) !== cwd) throw new LocalTypecheckMetadataError();
    const uid = BigInt(process.getuid!());
    const directory = await open(
      cwd,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const owner = await directory.stat({ bigint: true });
      const checkDirectory = async (path: string, expected: BigIntStats, privateOnly = false) => {
        const named = await lstat(path, { bigint: true });
        if (
          !named.isDirectory() ||
          named.dev !== expected.dev ||
          named.ino !== expected.ino ||
          named.uid !== uid ||
          (named.mode & (privateOnly ? 0o077n : 0o022n)) !== 0n
        )
          throw new LocalTypecheckMetadataError();
      };
      await checkDirectory(cwd, owner);
      const path = join(cwd, "tsconfig.tsbuildinfo");
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!file) {
        await checkDirectory(cwd, owner);
        return;
      }
      try {
        const before = await file.stat({ bigint: true });
        if (
          !before.isFile() ||
          before.uid !== uid ||
          before.nlink !== 1n ||
          before.size <= 0n ||
          before.size > limit ||
          (before.mode & 0o022n) !== 0n
        )
          throw new LocalTypecheckMetadataError();
        const bytes = Buffer.alloc(Number(before.size) + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await file.read(bytes, length, bytes.length - length, length);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        if (
          length !== Number(before.size) ||
          !generatedBuildInfo(decode(bytes.subarray(0, length).toString("utf8"))) ||
          !sameFile(before, await file.stat({ bigint: true })) ||
          !sameFile(before, await lstat(path, { bigint: true }))
        )
          throw new LocalTypecheckMetadataError();
        await checkDirectory(cwd, owner);
        // Rename into a newly created private namespace before deletion, so a
        // replacement racing rename is retained rather than blindly unlinked.
        // Any uncertainty preserves the quarantine for manual inspection.
        const quarantine = await mkdtemp(join(cwd, ".typecheck-retirement-"));
        const quarantineOwner = await lstat(quarantine, { bigint: true });
        const retired = join(quarantine, "tsconfig.tsbuildinfo");
        await checkDirectory(quarantine, quarantineOwner, true);
        await checkDirectory(cwd, owner);
        if (!sameFile(before, await lstat(path, { bigint: true })))
          throw new LocalTypecheckMetadataError();
        await rename(path, retired);
        // Rename may legitimately update ctime. All other held file identity
        // and content-change metadata remain exact, and named/held post-rename
        // stats must agree including that new ctime.
        const transferred = await file.stat({ bigint: true });
        if (
          !sameFile(before, transferred, false) ||
          !sameFile(transferred, await lstat(retired, { bigint: true }))
        )
          throw new LocalTypecheckMetadataError();
        await checkDirectory(cwd, owner);
        await checkDirectory(quarantine, quarantineOwner, true);
        await unlink(retired);
        await checkDirectory(quarantine, quarantineOwner, true);
        await rmdir(quarantine);
      } finally {
        await file.close();
      }
    } finally {
      await directory.close();
    }
  } catch {
    throw new LocalTypecheckMetadataError();
  }
}
