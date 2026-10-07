// @effect-diagnostics nodeBuiltinImport:off
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** A server-minted temporary capability directory avoids writing into provider
 * homes or weakening the external installer's deliberately strict ancestor
 * policy. The OS chooses the namespace; no chat/profile text becomes a path. */
export interface SchedulingSessionFiles {
  readonly bridgePath: string;
  readonly connectionPath: string;
  readonly remove: () => Promise<void>;
}

const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const unavailable = () => new Error("The private scheduling session files are unavailable.");

export async function makeSchedulingSessionFiles(input: {
  readonly bridgeSource: string;
  readonly port: number;
  readonly token: string;
  readonly audience?: "cafe-scheduling" | "cafe-native-control";
}): Promise<SchedulingSessionFiles> {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw unavailable();
  // Read the trusted bundled asset before allocating anything. Missing build
  // assets must not leave an empty capability directory on every attempted chat.
  const source = await fs.readFile(input.bridgeSource);
  if (source.length > 4 * 1024 * 1024) throw unavailable();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cafe-scheduling-")));
  const rootIdentity = await fs.lstat(root, { bigint: true });
  if (
    !rootIdentity.isDirectory() ||
    rootIdentity.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (rootIdentity.uid !== BigInt(process.getuid!()) || (rootIdentity.mode & 0o077n) !== 0n))
  )
    throw unavailable();
  const files = new Map<string, BigIntStats>();
  const assertRoot = async () => {
    const current = await fs.lstat(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(current, rootIdentity))
      throw unavailable();
  };
  const remove = async () => {
    // Never recursively remove a path that might now name someone else's
    // directory. Only exact files created here may be removed; replacements,
    // unexpected children, and renamed namespaces are preserved for inspection.
    await assertRoot();
    for (const [filePath, identity] of files) {
      await assertRoot();
      const current = await fs.lstat(filePath, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, identity))
        throw unavailable();
      await fs.unlink(filePath);
      files.delete(filePath);
    }
    await assertRoot();
    await fs.rmdir(root);
  };
  const publish = async (name: string, contents: string | Uint8Array) => {
    await assertRoot();
    const filePath = path.join(root, name);
    const file = await fs.open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const identity = await file.stat({ bigint: true });
      if (!identity.isFile() || identity.nlink !== 1n) throw unavailable();
      files.set(filePath, identity);
      // Validate the minted directory again before writing the token through
      // the held file handle, including on hosts with different rename rules.
      await assertRoot();
      await file.writeFile(contents);
      await file.sync();
      await assertRoot();
      return filePath;
    } finally {
      await file.close();
    }
  };
  try {
    const bridgePath = await publish("bridge.mjs", source);
    const connectionPath = await publish(
      "connection.json",
      JSON.stringify({
        audience: input.audience ?? "cafe-scheduling",
        url: `http://127.0.0.1:${input.port}${input.audience === "cafe-native-control" ? "/mcp/native-control" : "/mcp/scheduling"}`,
        token: input.token,
      }),
    );
    return { bridgePath, connectionPath, remove };
  } catch {
    await remove().catch(() => undefined);
    throw unavailable();
  }
}
