// Native temporary namespace and launch boundary: preserve no-follow private
// files and exact bigint identity through publication and joined retirement.
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const unavailable = () => new Error("The private Cafe Secrets runner is unavailable.");
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const privateEntry = (entry: BigIntStats, directory: boolean) =>
  (directory ? entry.isDirectory() : entry.isFile() && entry.nlink === 1n) &&
  !entry.isSymbolicLink() &&
  (process.platform === "win32" ||
    (entry.uid === BigInt(process.getuid!()) && (entry.mode & 0o077n) === 0n));

export interface SecretRunnerConnection {
  readonly version: 1;
  readonly threadId: string;
  readonly secretsDir: string;
}
export async function readSecretRunnerConnection(
  filename: string,
): Promise<SecretRunnerConnection> {
  const directory = path.dirname(filename);
  const root = await fs.lstat(directory, { bigint: true });
  if (!privateEntry(root, true) || (await fs.realpath(directory)) !== directory)
    throw unavailable();
  const file = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!privateEntry(before, false) || before.size < 1n || before.size > 16_384n)
      throw unavailable();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const named = await fs.lstat(filename, { bigint: true });
    const currentRoot = await fs.lstat(directory, { bigint: true });
    if (
      BigInt(size) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      !sameFile(before, named) ||
      !privateEntry(named, false) ||
      !sameFile(root, currentRoot) ||
      !privateEntry(currentRoot, true)
    )
      throw unavailable();
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)),
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("threadId" in value) ||
      typeof value.threadId !== "string" ||
      !value.threadId ||
      value.threadId.length > 200 ||
      !("secretsDir" in value) ||
      typeof value.secretsDir !== "string" ||
      !path.isAbsolute(value.secretsDir) ||
      value.secretsDir.length > 8192
    )
      throw unavailable();
    return { version: 1, threadId: value.threadId, secretsDir: value.secretsDir };
  } finally {
    await file.close();
  }
}

export interface SecretRunnerSession {
  readonly instructions: string;
  readonly invocation: string;
  readonly connectionPath: string;
  readonly retire: () => void;
  readonly dispose: () => Promise<void>;
}
export async function makeSecretRunnerSession(input: {
  readonly threadId: string;
  readonly secretsDir: string;
}): Promise<SecretRunnerSession> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cafe-secrets-")));
  const rootIdentity = await fs.lstat(root, { bigint: true });
  if (!privateEntry(rootIdentity, true)) throw unavailable();
  const filename = path.join(root, "connection.json");
  const file = await fs.open(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let identity: BigIntStats;
  try {
    identity = await file.stat({ bigint: true });
    if (!privateEntry(identity, false)) throw unavailable();
    const admittedRoot = await fs.lstat(root, { bigint: true });
    if (!sameFile(admittedRoot, rootIdentity) || !privateEntry(admittedRoot, true))
      throw unavailable();
    await file.writeFile(
      JSON.stringify({
        version: 1,
        threadId: input.threadId,
        secretsDir: path.resolve(input.secretsDir),
      }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  const entry = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../../dist/bin.mjs" : "./bin.mjs", import.meta.url),
  );
  const quote = (value: string) =>
    process.platform === "win32"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", "'\\''")}'`;
  const invocation = `${process.platform === "win32" ? "$env:ELECTRON_RUN_AS_NODE='1'; & " : "ELECTRON_RUN_AS_NODE=1 "}${quote(process.execPath)} ${quote(entry)} --cafe-secret-exec ${quote(filename)}`;
  let retired = false;
  let disposed = false;
  let removal: Promise<void> | undefined;
  return {
    invocation,
    connectionPath: filename,
    instructions: `\n\nCafe Secrets: this chat uses opaque [CAFE_SECRET_<id>] references. Real values are private. For any operation requiring one, use the ordinary native shell tool to invoke this exact chat-bound helper:\n${invocation} '<JSON request>'\nRequests are {"operation":"run","argv":["node","scripts/setup.mjs"],"env":{"API_KEY":"[CAFE_SECRET_<id>]"},"stdin":"optional input","cwd":"optional absolute directory"}, {"operation":"write_file","path":"absolute path","content":"text containing references"}, or {"operation":"read_file","path":"absolute path"}. The JSON is an argument and must be correctly quoted for the native shell. Prefer env/stdin for values; references are forbidden in argv and paths. The helper expands only values in this chat and redacts its stdout/stderr before the native tool receives them. It retains ordinary sandbox and permission requirements. Never invent values, write references into configuration files, or use an unrelated chat's helper. An unavailable reference is a recoverable error; ask the user to restore it. Ordinary unwrapped tools remain available; they may reveal secrets previously written to files.`,
    retire: () => {
      retired = true;
    },
    dispose: () => {
      retired = true;
      if (disposed) return Promise.resolve();
      removal ??= (async () => {
        const currentRoot = await fs.lstat(root, { bigint: true });
        const currentFile = await fs.lstat(filename, { bigint: true });
        if (
          !retired ||
          !sameFile(currentRoot, rootIdentity) ||
          !privateEntry(currentRoot, true) ||
          !sameFile(currentFile, identity) ||
          !privateEntry(currentFile, false)
        )
          throw unavailable();
        await fs.unlink(filename);
        const lastRoot = await fs.lstat(root, { bigint: true });
        if (!sameFile(lastRoot, rootIdentity) || !privateEntry(lastRoot, true)) throw unavailable();
        await fs.rmdir(root);
        disposed = true;
      })().finally(() => {
        removal = undefined;
      });
      return removal;
    },
  };
}
