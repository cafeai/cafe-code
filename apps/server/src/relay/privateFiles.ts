// @effect-diagnostics nodeBuiltinImport:off
// Native private configuration/key boundary. No account/profile copying and no
// user-provided file destination: names are fixed inside this exact data profile.
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import * as path from "node:path";
import { RelayError, requireRelay } from "@cafecode/relay/errors";

function privateOwner(stat: BigIntStats, mode: bigint): boolean {
  // Windows uses the already-qualified profile's inherited user ACL, just as
  // the backend secret store does. POSIX additionally requires exact private
  // ownership/mode. Both paths retain no-follow namespace/held-handle checks.
  return (
    process.platform === "win32" ||
    ((process.platform === "darwin" || process.platform === "linux") &&
      typeof process.getuid === "function" &&
      stat.uid === BigInt(process.getuid()) &&
      (stat.mode & 0o777n) === mode)
  );
}

async function directory(root: string) {
  const target = path.join(root, "relay");
  const stat = await fs.lstat(target, { bigint: true });
  requireRelay(path.isAbsolute(root) && (await fs.realpath(root)) === root);
  requireRelay(stat.isDirectory() && !stat.isSymbolicLink() && privateOwner(stat, 0o700n));
  return { target, stat };
}
export async function ensureRelayPrivateDirectory(root: string): Promise<void> {
  try {
    await fs.mkdir(path.join(root, "relay"), { mode: 0o700 });
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
    )
      throw new RelayError("UNAVAILABLE");
  }
  await directory(root);
}

export async function readRelayPrivate(
  root: string,
  name: "config.json" | `host-${string}.key`,
  maximum: number,
): Promise<Uint8Array | undefined> {
  requireRelay(name === "config.json" || /^host-(?:admission-)?[A-Za-z0-9_-]{43}\.key$/.test(name));
  try {
    const admitted = await directory(root);
    const filename = path.join(admitted.target, name);
    const named = await fs.lstat(filename, { bigint: true });
    requireRelay(named.isFile() && !named.isSymbolicLink() && named.nlink === 1n);
    const file = await fs.open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat({ bigint: true });
      requireRelay(
        stat.isFile() &&
          stat.nlink === 1n &&
          stat.dev === named.dev &&
          stat.ino === named.ino &&
          privateOwner(stat, 0o600n) &&
          stat.size > 0n &&
          stat.size <= BigInt(maximum),
      );
      const bytes = new Uint8Array(Number(stat.size));
      let used = 0;
      while (used < bytes.byteLength) {
        const result = await file.read(bytes, used, bytes.byteLength - used, used);
        requireRelay(result.bytesRead > 0);
        used += result.bytesRead;
      }
      const after = await file.stat({ bigint: true }),
        parent = await directory(root),
        current = await fs.lstat(filename, { bigint: true });
      requireRelay(
        after.size === stat.size &&
          after.mtimeNs === stat.mtimeNs &&
          after.ctimeNs === stat.ctimeNs &&
          after.nlink === 1n &&
          current.dev === stat.dev &&
          current.ino === stat.ino &&
          !current.isSymbolicLink() &&
          parent.stat.dev === admitted.stat.dev &&
          parent.stat.ino === admitted.stat.ino &&
          privateOwner(after, 0o600n),
      );
      return bytes;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new RelayError("UNAVAILABLE");
  }
}
export async function createRelayPrivate(
  root: string,
  name: `host-${string}.key`,
  bytes: Uint8Array,
): Promise<void> {
  requireRelay(
    /^host-(?:admission-)?[A-Za-z0-9_-]{43}\.key$/.test(name) && bytes.byteLength <= 128,
  );
  try {
    const admitted = await directory(root);
    const file = await fs.open(
      path.join(admitted.target, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const stat = await file.stat({ bigint: true });
      requireRelay(stat.isFile() && stat.nlink === 1n && privateOwner(stat, 0o600n));
      await file.writeFile(bytes);
      await file.sync();
      const parent = await directory(root);
      const named = await fs.lstat(path.join(admitted.target, name), { bigint: true });
      requireRelay(
        named.dev === stat.dev &&
          named.ino === stat.ino &&
          !named.isSymbolicLink() &&
          named.nlink === 1n &&
          parent.stat.dev === admitted.stat.dev &&
          parent.stat.ino === admitted.stat.ino,
      );
    } finally {
      await file.close();
    }
  } catch {
    throw new RelayError("UNAVAILABLE");
  }
}
