// @effect-diagnostics nodeBuiltinImport:off
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readMcpFile, writeMcpFile } from "./privateFiles.ts";

/** A server-minted temporary capability directory avoids writing into provider
 * homes or weakening the external installer's deliberately strict ancestor
 * policy. The OS chooses the namespace; no chat/profile text becomes a path. */
export interface SessionMcpFiles {
  readonly bridgePath: string;
  readonly connectionPath: string;
  readonly replaceToken: (token: string) => Promise<void>;
  readonly remove: () => Promise<void>;
}

const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const unavailable = () => new Error("The private MCP session files are unavailable.");
const MAX_BRIDGE_BYTES = 4 * 1024 * 1024;
const MAX_CONNECTION_BYTES = 16 * 1024;

export async function makeSessionMcpFiles(input: {
  readonly bridgeSource: string;
  readonly port: number;
  readonly token: string;
  readonly audience?: "cafe-code" | "cafe-scheduling" | "cafe-visualizations" | "cafe-glide";
  /** Production catalogue owners may charge the exact prepared private-file
   * extent before any directory allocation. Retirement is permitted only after
   * confirmed cleanup; an uncertain namespace intentionally retains its charge. */
  readonly reserveBytes?: (bytes: number) => () => void;
}): Promise<SessionMcpFiles> {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw unavailable();
  // Keep the bundled-asset filesystem semantics used by Electron's ASAR reader
  // and root-owned application installs. This is not a private-config read.
  // Refuse a known oversized/non-file source before readFile allocates it, then
  // recheck the accepted bytes. A trusted asset mutated during that read is not
  // a hard RSS bound; this guards the published payload and ordinary allocation.
  const sourceInfo = await fs.stat(input.bridgeSource);
  if (!sourceInfo.isFile() || sourceInfo.size > MAX_BRIDGE_BYTES) throw unavailable();
  const source = await fs.readFile(input.bridgeSource);
  if (source.length > MAX_BRIDGE_BYTES) throw unavailable();
  const connection = (token: string) => {
    // The private reader already has this finite connection-file allowance.
    // Bound serialization before admission instead of charging an arbitrarily
    // large token or relying on a later reader to reject the written file.
    if (typeof token !== "string" || token.length > MAX_CONNECTION_BYTES) throw unavailable();
    const contents = JSON.stringify({
      audience: input.audience ?? "cafe-scheduling",
      url: `http://127.0.0.1:${input.port}${input.audience === "cafe-code" ? "/mcp" : input.audience === "cafe-visualizations" ? "/mcp/visualizations" : input.audience === "cafe-glide" ? "/mcp/glide" : "/mcp/scheduling"}`,
      token,
    });
    const bytes = Buffer.byteLength(contents, "utf8");
    if (bytes > MAX_CONNECTION_BYTES) throw unavailable();
    return { contents, bytes };
  };
  const initialConnection = connection(input.token);
  // Keep capacity errors outside the publication catch: the owning runtime
  // needs their finite category, rather than an opaque filesystem failure.
  const releaseBytes = input.reserveBytes?.(source.length + initialConnection.bytes);
  let remove: (() => Promise<void>) | undefined;
  try {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cafe-mcp-")));
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
    let removed = false;
    let removalAdmitted = false;
    let removing: Promise<void> | undefined;
    // A token renewal owns its native write through its final namespace check.
    // Normalize only the queue tail, not the caller's result: a failed renewal
    // stays observable while an independently admitted later renewal may run.
    let rotationTail: Promise<void> = Promise.resolve();
    const removeOwned = async () => {
      // Removal fences new renewals synchronously before joining every admitted
      // one. Otherwise writeMcpFile's recursive mkdir/rename could recreate a
      // namespace after rmdir had released this catalogue's byte reservation.
      await rotationTail;
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
      removed = true;
      releaseBytes?.();
    };
    remove = () => {
      removalAdmitted = true;
      if (removed) return Promise.resolve();
      // Dispose and shutdown may meet at the same exact owner. Join removal,
      // but permit a later explicit cleanup attempt after a refused namespace;
      // neither a partial failure nor its catch may release the held extent.
      removing ??= removeOwned().finally(() => {
        removing = undefined;
      });
      return removing;
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
    const bridgePath = await publish("bridge.mjs", source);
    const connectionPath = await publish("connection.json", initialConnection.contents);
    const replaceToken = async (token: string) => {
      if (removalAdmitted || removed) throw unavailable();
      const next = connection(token);
      // Reserved catalogues cannot grow their private-file footprint through
      // rotation. Glide's fixed-size minted tokens retain this exact extent;
      // ordinary unreserved management sessions keep their existing rotation.
      if (releaseBytes && next.bytes > initialConnection.bytes) throw unavailable();
      // Publish the queue ownership before the first await. Legitimate
      // concurrent unreserved renewals retain their order and original result;
      // cleanup can neither overtake them nor release their private extent.
      const rotation = rotationTail.then(async () => {
        await assertRoot();
        const current = await fs.lstat(connectionPath, { bigint: true });
        if (
          !sameFile(current, files.get(connectionPath)!) ||
          !current.isFile() ||
          current.isSymbolicLink()
        )
          throw unavailable();
        const previous = await readMcpFile(connectionPath, {
          private: true,
          maxBytes: MAX_CONNECTION_BYTES,
        });
        await writeMcpFile(connectionPath, next.contents, previous);
        await assertRoot();
        files.set(connectionPath, await fs.lstat(connectionPath, { bigint: true }));
      });
      rotationTail = rotation.catch(() => undefined);
      await rotation;
    };
    return { bridgePath, connectionPath, replaceToken, remove };
  } catch {
    // A missing remover means allocation never established an exact private
    // namespace owner. Preserve its charge rather than claiming that unknown
    // native allocation or cleanup has certainly retired.
    await remove?.().catch(() => undefined);
    throw unavailable();
  }
}
