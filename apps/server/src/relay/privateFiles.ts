// @effect-diagnostics nodeBuiltinImport:off
// Native private configuration/key boundary. No account/profile copying and no
// user-provided file destination: names are fixed inside this exact data profile.
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { RelayError, requireRelay } from "@cafecode/relay/errors";

async function directory(root: string) {
  const target = path.join(root, "relay");
  const stat = await fs.lstat(target, { bigint: true });
  requireRelay(
    (process.platform === "darwin" || process.platform === "linux") &&
      typeof process.getuid === "function",
  );
  requireRelay(path.isAbsolute(root) && (await fs.realpath(root)) === root);
  requireRelay(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === BigInt(process.getuid()) &&
      (stat.mode & 0o777n) === 0o700n,
  );
  return { target, stat };
}
export async function readRelayPrivate(
  root: string,
  name: "config.json" | `host-${string}.key`,
  maximum: number,
): Promise<Uint8Array | undefined> {
  requireRelay(name === "config.json" || /^host-[A-Za-z0-9_-]{43}\.key$/.test(name));
  try {
    const admitted = await directory(root);
    const file = await fs.open(
      path.join(admitted.target, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat({ bigint: true });
      requireRelay(
        stat.isFile() &&
          stat.nlink === 1n &&
          stat.uid === BigInt(process.getuid!()) &&
          (stat.mode & 0o777n) === 0o600n &&
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
        parent = await fs.lstat(admitted.target, { bigint: true });
      requireRelay(
        after.size === stat.size &&
          after.mtimeNs === stat.mtimeNs &&
          after.ctimeNs === stat.ctimeNs &&
          after.nlink === 1n &&
          parent.dev === admitted.stat.dev &&
          parent.ino === admitted.stat.ino &&
          !parent.isSymbolicLink(),
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
  requireRelay(/^host-[A-Za-z0-9_-]{43}\.key$/.test(name) && bytes.byteLength <= 128);
  try {
    const admitted = await directory(root);
    const file = await fs.open(
      path.join(admitted.target, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await file.stat({ bigint: true });
      requireRelay(
        stat.isFile() &&
          stat.nlink === 1n &&
          stat.uid === BigInt(process.getuid!()) &&
          (stat.mode & 0o777n) === 0o600n,
      );
      await file.writeFile(bytes);
      await file.sync();
      const parent = await fs.lstat(admitted.target, { bigint: true });
      requireRelay(
        parent.dev === admitted.stat.dev &&
          parent.ino === admitted.stat.ino &&
          !parent.isSymbolicLink(),
      );
    } finally {
      await file.close();
    }
  } catch {
    throw new RelayError("UNAVAILABLE");
  }
}
