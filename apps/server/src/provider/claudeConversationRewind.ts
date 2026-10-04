/**
 * Bounded, immutable input for the SDK's public forkSession operation.
 *
 * Cafe does not rewrite Claude's conversation graph. The qualified SDK owns
 * compaction, parent rewiring and UUID remapping. This module only validates
 * the exact prompt boundary and the SDK's resulting identity correspondence.
 * Source transcripts are never overwritten or deleted by a rewind.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

const MAX_TRANSCRIPT_BYTES = 64 * 1_024 * 1_024;
const MAX_LINE_BYTES = 1_024 * 1_024;
const MAX_ENTRIES = 65_536;
const MAX_LINEAGE_ENTRIES = 4_096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Original Cafe prompt UUID -> UUID in this precise forked native session. */
export type ClaudeRewindMessageIds = Readonly<Record<string, string>>;

export interface ClaudeRewindSnapshot {
  readonly entries: SessionStoreEntry[];
  /** Content and filesystem identity, never exposed in user diagnostics. */
  readonly commitment: string;
  readonly directoryIdentities: ReadonlyArray<{
    readonly path: string;
    readonly dev: bigint;
    readonly ino: bigint;
  }>;
}

export function readClaudeRewindMessageIds(value: unknown): ClaudeRewindMessageIds | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claude rewind lineage is invalid.");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_LINEAGE_ENTRIES)
    throw new Error("Claude rewind lineage exceeds its bound.");
  const result: Record<string, string> = {};
  const nativeIds = new Set<string>();
  for (const [original, native] of entries) {
    if (
      !UUID.test(original) ||
      typeof native !== "string" ||
      !UUID.test(native) ||
      nativeIds.has(native)
    ) {
      throw new Error("Claude rewind lineage is not an exact UUID correspondence.");
    }
    nativeIds.add(native);
    result[original] = native;
  }
  return result;
}

/**
 * A no-follow read with a hard allocation limit and identity checks on both
 * sides of the read. Re-reading this snapshot after retirement closes the
 * admission-to-mutation gap without trusting provider event delivery timing.
 */
export async function readClaudeRewindSnapshot(input: {
  readonly filePath: string;
  readonly directories: ReadonlyArray<string>;
}): Promise<ClaudeRewindSnapshot> {
  const directories = await Promise.all(
    input.directories.map((directory) => lstat(directory, { bigint: true })),
  );
  for (const info of directories) {
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Claude rewind directory is unsafe.");
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      info.uid !== BigInt(process.getuid())
    ) {
      throw new Error("Claude rewind directory has a different owner.");
    }
  }
  const before = await lstat(input.filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_TRANSCRIPT_BYTES)) {
    throw new Error("Claude rewind transcript is not a bounded regular file.");
  }
  if (process.platform !== "win32" && (before.mode & 0o077n) !== 0n) {
    throw new Error("Claude rewind transcript is not private.");
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    before.uid !== BigInt(process.getuid())
  ) {
    throw new Error("Claude rewind transcript has a different owner.");
  }
  const handle = await open(
    input.filePath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
  );
  const identity = (info: typeof before) =>
    `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  try {
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || identity(held) !== identity(before))
      throw new Error("Claude rewind transcript changed before read.");
    // Read at most the admitted size plus one byte. readFile() could allocate
    // without bound if another process kept appending after the initial stat.
    const bytes = Buffer.alloc(Number(held.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(
        bytes,
        offset,
        Math.min(65_536, bytes.length - offset),
        offset,
      );
      if (part.bytesRead === 0) break;
      offset += part.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(input.filePath, { bigint: true });
    if (
      offset !== Number(held.size) ||
      identity(after) !== identity(held) ||
      identity(current) !== identity(held) ||
      current.isSymbolicLink()
    ) {
      throw new Error("Claude rewind transcript changed during read.");
    }
    const directoryAfter = await Promise.all(
      input.directories.map((directory) => lstat(directory, { bigint: true })),
    );
    for (let index = 0; index < directories.length; index += 1) {
      const old = directories[index]!;
      const fresh = directoryAfter[index]!;
      if (
        !fresh.isDirectory() ||
        fresh.isSymbolicLink() ||
        old.dev !== fresh.dev ||
        old.ino !== fresh.ino
      ) {
        throw new Error("Claude rewind directory changed during read.");
      }
    }
    const contents = bytes.subarray(0, offset);
    // JSONL must be completely published. Do not admit a partial final line
    // merely because a prefix happened to parse as a complete JSON value.
    if (contents.length > 0 && contents.at(-1) !== 10)
      throw new Error("Claude rewind transcript is not completely published.");
    const entries: SessionStoreEntry[] = [];
    for (const line of new TextDecoder("utf-8", { fatal: true }).decode(contents).split(/\r?\n/u)) {
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES || entries.length >= MAX_ENTRIES) {
        throw new Error("Claude rewind transcript exceeds its entry bound.");
      }
      const entry: unknown = JSON.parse(line);
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof (entry as { type?: unknown }).type !== "string"
      ) {
        throw new Error("Claude rewind transcript contains an invalid entry.");
      }
      entries.push(entry as SessionStoreEntry);
    }
    return {
      entries,
      directoryIdentities: directories.map((info, index) => ({
        path: input.directories[index]!,
        dev: info.dev,
        ino: info.ino,
      })),
      commitment: createHash("sha256")
        .update("cafe/claude-rewind-snapshot/v1\0")
        .update(identity(held))
        .update(directories.map((info) => `${info.dev}:${info.ino}`).join(";"))
        .update(contents)
        .digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Publish only through an exclusively created, revalidated file handle.
 *
 * Node does not expose openat and macOS /dev/fd cannot resolve child paths.
 * Therefore create an empty private UUID file first, then prove the complete
 * original directory chain and leaf/handle identity before writing any native
 * transcript bytes. A directory swap during open can leave an empty private
 * orphan, but cannot redirect conversation data into an unrelated file.
 * Once validated, later pathname changes cannot retarget the held file handle.
 */
export async function publishClaudeRewindCandidate(input: {
  readonly filePath: string;
  readonly snapshot: ClaudeRewindSnapshot;
  readonly entries: ReadonlyArray<SessionStoreEntry>;
}): Promise<void> {
  const contents = `${input.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  if (
    input.entries.length > MAX_ENTRIES ||
    Buffer.byteLength(contents, "utf8") > MAX_TRANSCRIPT_BYTES
  ) {
    throw new Error("Claude rewind candidate exceeds its publication bound.");
  }
  const assertDirectories = async () => {
    for (const expected of input.snapshot.directoryIdentities) {
      const current = await lstat(expected.path, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino
      ) {
        throw new Error("Claude rewind publication directory changed.");
      }
    }
  };
  await assertDirectories();
  const directoryHandles: Array<Awaited<ReturnType<typeof open>>> = [];
  try {
    // POSIX held descriptors supplement the named-chain checks and permit
    // directory fsync. Windows uses the same bigint identity checks plus its
    // user-owned directory ACL; no symlink privileges or chmod are required.
    if (process.platform !== "win32") {
      for (const expected of input.snapshot.directoryIdentities) {
        const held = await open(
          expected.path,
          constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
        );
        directoryHandles.push(held);
        const info = await held.stat({ bigint: true });
        if (!info.isDirectory() || info.dev !== expected.dev || info.ino !== expected.ino) {
          throw new Error("Claude rewind publication directory changed before opening.");
        }
      }
    }
    const handle = await open(
      input.filePath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
      0o600,
    );
    try {
      const held = await handle.stat({ bigint: true });
      const assertLeaf = async () => {
        const named = await lstat(input.filePath, { bigint: true });
        if (
          !named.isFile() ||
          named.isSymbolicLink() ||
          named.dev !== held.dev ||
          named.ino !== held.ino ||
          named.nlink !== 1n
        ) {
          throw new Error("Claude rewind publication target changed.");
        }
      };
      if (!held.isFile() || held.size !== 0n || held.nlink !== 1n)
        throw new Error("Claude rewind publication target is not an exclusive empty file.");
      // Crucially these checks happen after open but before write. Merely
      // checking before and after write would disclose history on a raced path.
      await assertDirectories();
      await assertLeaf();
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await assertDirectories();
      await assertLeaf();
      const projectHandle = directoryHandles.at(-1);
      if (projectHandle) await projectHandle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    await Promise.all(directoryHandles.map((handle) => handle.close()));
  }
}

/**
 * Initial Cafe prompts use the canonical turn UUID on the SDK wire. Select
 * their immediate parent, not the last assistant frame: tool-result carriers,
 * structured-output attachments and in-turn steers must remain in the prefix.
 * The SDK subsequently validates/rewires the selected native chain itself.
 */
export function selectClaudeRewindCutoff(input: {
  readonly entries: ReadonlyArray<SessionStoreEntry>;
  readonly sessionId: string;
  readonly firstRemovedTurnId: string;
  readonly messageIds?: ClaudeRewindMessageIds;
}): string | null {
  if (!UUID.test(input.firstRemovedTurnId))
    throw new Error("Claude checkpoint has no native prompt UUID.");
  const target = input.messageIds?.[input.firstRemovedTurnId] ?? input.firstRemovedTurnId;
  const matching = input.entries.filter(
    (entry) => entry.uuid === target && entry.isSidechain !== true,
  );
  if (matching.length !== 1)
    throw new Error("Claude checkpoint prompt is unavailable or ambiguous.");
  const entry = matching[0]!;
  if (entry.type !== "user" || entry.sessionId !== input.sessionId || entry.isMeta === true) {
    throw new Error("Claude checkpoint is not a primary user prompt in this native session.");
  }
  const parent = entry.parentUuid;
  if (parent === null) return null;
  if (typeof parent !== "string" || !UUID.test(parent))
    throw new Error("Claude checkpoint has no exact native parent.");
  const parents = input.entries.filter(
    (candidate) => candidate.uuid === parent && candidate.isSidechain !== true,
  );
  if (parents.length !== 1 || parents[0]!.sessionId !== input.sessionId)
    throw new Error("Claude checkpoint parent is unavailable or ambiguous.");
  return parent;
}

/** Preserve stable prompt identity across arbitrary successive SDK forks. */
export function remapClaudeRewindMessageIds(input: {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly entries: ReadonlyArray<SessionStoreEntry>;
  readonly previous?: ClaudeRewindMessageIds;
}): ClaudeRewindMessageIds {
  const previousByNative = new Map(
    Object.entries(input.previous ?? {}).map(([original, native]) => [native, original]),
  );
  const result: Record<string, string> = {};
  for (const entry of input.entries) {
    if (entry.type !== "user" || entry.isSidechain === true) continue;
    const source = entry.forkedFrom;
    if (
      entry.sessionId !== input.targetSessionId ||
      typeof entry.uuid !== "string" ||
      !UUID.test(entry.uuid) ||
      !source ||
      typeof source !== "object" ||
      Array.isArray(source)
    ) {
      throw new Error("Claude fork did not preserve exact prompt lineage.");
    }
    const provenance = source as { sessionId?: unknown; messageUuid?: unknown };
    if (
      provenance.sessionId !== input.sourceSessionId ||
      typeof provenance.messageUuid !== "string" ||
      !UUID.test(provenance.messageUuid)
    ) {
      throw new Error("Claude fork did not identify its exact source prompt.");
    }
    const original = previousByNative.get(provenance.messageUuid) ?? provenance.messageUuid;
    if (Object.hasOwn(result, original))
      throw new Error("Claude fork produced ambiguous prompt lineage.");
    result[original] = entry.uuid;
  }
  return readClaudeRewindMessageIds(result)!;
}
