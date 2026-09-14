import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Never include the path or the input in errors: provider configs can contain credentials. */
export class McpFileError extends Error {
  readonly code: "configuration" | "bridge_missing";
  constructor(message: string, code: "configuration" | "bridge_missing" = "configuration") {
    super(message);
    this.code = code;
  }
}

export async function readMcpFile(
  filePath: string,
  options: { private?: boolean; maxBytes?: number } = {},
): Promise<string | undefined> {
  try {
    const entry = await fs.lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
      throw new McpFileError("Cafe MCP refuses linked or non-regular configuration files.");
    }
    const file = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.dev !== entry.dev ||
        info.ino !== entry.ino ||
        info.size > (options.maxBytes ?? MAX_CONFIG_BYTES) ||
        (process.platform !== "win32" &&
          (info.uid !== process.getuid?.() ||
            (options.private ? (info.mode & 0o077) !== 0 : (info.mode & 0o022) !== 0)))
      ) {
        throw new McpFileError(
          "Cafe MCP cannot use this configuration's ownership, permissions, or size.",
        );
      }
      // Read at most the limit even if another process grows the file after stat().
      const buffer = Buffer.alloc(
        Math.min(info.size + 1, (options.maxBytes ?? MAX_CONFIG_BYTES) + 1),
      );
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total !== info.size) throw new McpFileError("The configuration changed. Try again.");
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    if (error instanceof McpFileError) throw error;
    throw new McpFileError("Cafe MCP could not read the configuration safely.");
  }
}

async function checkParents(directory: string): Promise<void> {
  // Refuse symlinked directories rather than writing through a dotfile-manager
  // link. A user can register the bridge manually in such a managed config.
  let current = directory;
  while (true) {
    try {
      const info = await fs.lstat(current);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.platform !== "win32" &&
          ((info.uid !== 0 && info.uid !== process.getuid?.()) ||
            ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)))
      ) {
        throw new McpFileError("Cafe MCP refuses an unsafe configuration directory.");
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function writeMcpFile(
  filePath: string,
  contents: string,
  expected: string | undefined,
): Promise<void> {
  const directory = path.dirname(filePath);
  let temporary: string | undefined;
  try {
    await checkParents(directory);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await checkParents(directory);
    temporary = path.join(directory, `.cafe-mcp-${randomUUID()}.tmp`);
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    // Other applications also edit these files. Compare again immediately
    // before atomic replacement, and never overwrite an observed external edit.
    if ((await readMcpFile(filePath)) !== expected) {
      throw new McpFileError("The configuration changed in another application. Try again.");
    }
    await fs.rename(temporary, filePath);
  } catch (error) {
    if (error instanceof McpFileError) throw error;
    throw new McpFileError("Cafe MCP could not save the configuration safely.");
  } finally {
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
