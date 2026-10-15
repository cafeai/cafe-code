// @effect-diagnostics nodeBuiltinImport:off
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readMcpFile, writeMcpFile } from "../mcp/privateFiles.ts";

const MAX_PUSH_STATE_BYTES = 1024 * 1024;

/** Secure legacy state through held no-follow handles before reading it. The
 * state directory is Cafe-owned; Windows retains inherited user ACLs. */
async function secureStatePath(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  let ancestor = directory;
  while (true) {
    try {
      const info = await fs.lstat(ancestor);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.platform !== "win32" &&
          ((info.uid !== 0 && info.uid !== process.getuid?.()) ||
            ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)))
      )
        throw new Error("Unsafe push state.");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await fs.lstat(directory);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    (process.platform !== "win32" && dir.uid !== process.getuid?.())
  )
    throw new Error("Unsafe push state.");
  if (process.platform !== "win32") {
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const held = await handle.stat();
      if (held.ino !== dir.ino || held.dev !== dir.dev) throw new Error("Changed push state.");
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }
  try {
    const entry = await fs.lstat(filePath);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1 ||
      (process.platform !== "win32" && entry.uid !== process.getuid?.())
    )
      throw new Error("Unsafe push state.");
    const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const held = await handle.stat();
      if (held.ino !== entry.ino || held.dev !== entry.dev) throw new Error("Changed push state.");
      if (process.platform !== "win32") await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
}

export async function readPrivatePushState(filePath: string): Promise<string | undefined> {
  await secureStatePath(filePath);
  return readMcpFile(filePath, { private: true, maxBytes: MAX_PUSH_STATE_BYTES });
}
export async function writePrivatePushState(
  filePath: string,
  contents: string,
  expected: string | undefined,
): Promise<void> {
  if (Buffer.byteLength(contents, "utf8") > MAX_PUSH_STATE_BYTES)
    throw new Error("Push state exceeds its storage limit.");
  await secureStatePath(filePath);
  await writeMcpFile(filePath, contents, expected);
}
