// @effect-diagnostics nodeBuiltinImport:off
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readMcpFile, writeMcpFile } from "../mcp/privateFiles.ts";

const MAX_PUSH_STATE_BYTES = 1024 * 1024;

/** Fixed, content-free admission reasons may be shown in startup diagnostics.
 * Never attach the rejected path, file contents or original filesystem error.
 */
export class PrivatePushStatePathError extends Error {
  constructor(reason: "directory" | "file" | "changed") {
    super(
      reason === "directory"
        ? "Web Push private-state directories must be owner-controlled, unlinked and not group/other-writable."
        : reason === "file"
          ? "Web Push private state must be an owner-controlled regular file without links."
          : "Web Push private-state identity changed during its security check.",
    );
    this.name = "PrivatePushStatePathError";
  }
}

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
        throw new PrivatePushStatePathError("directory");
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
    throw new PrivatePushStatePathError("directory");
  if (process.platform !== "win32") {
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const held = await handle.stat();
      if (held.ino !== dir.ino || held.dev !== dir.dev)
        throw new PrivatePushStatePathError("changed");
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
      throw new PrivatePushStatePathError("file");
    const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const held = await handle.stat();
      if (held.ino !== entry.ino || held.dev !== entry.dev)
        throw new PrivatePushStatePathError("changed");
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
