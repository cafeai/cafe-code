// Receipt admission needs native no-follow descriptors, bigint inode metadata,
// exclusive links and directory fsync; path-only IO cannot prove this boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstat, mkdir, open, opendir, unlink, type FileHandle } from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import * as Schema from "effect/Schema";
import type { LocalVerificationReceiptStore } from "./local-verification-cache-contract.ts";

const markerName = ".receipt-store-v1";
const keyName = ".authentication-key";
const writerName = ".writer";
const marker = Buffer.from("Cafe Code private local verification receipts v1\n");
const receiptDomain = "cafe-code/local-verification/success-receipt/v1\0";
const environmentDomain = "cafe-code/local-verification/environment/v1\0";
const digestPattern = /^[a-f0-9]{64}$/u;
const pendingPattern = /^\.pending-[a-f0-9]{48}$/u;
const receiptPattern = /^[a-f0-9]{64}\.json$/u;
const maximumEntryBytes = 2048;
const maximumEntries = 4096;
const maximumTotalBytes = maximumEntryBytes * maximumEntries;
const maximumEnvironmentBytes = 1024 * 1024;
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const unavailable = () => new Error("Local verification cache unavailable.");

interface NamespaceEntry {
  readonly path: string;
  readonly metadata: BigIntStats;
}

const sameFile = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;
const unchangedFile = (left: BigIntStats, right: BigIntStats): boolean =>
  sameFile(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
const privateFile = (metadata: BigIntStats, uid: bigint): boolean =>
  metadata.isFile() &&
  metadata.uid === uid &&
  metadata.nlink === 1n &&
  (metadata.mode & 0o7777n) === 0o600n;
const privateDirectory = (metadata: BigIntStats, uid: bigint): boolean =>
  metadata.isDirectory() && metadata.uid === uid && (metadata.mode & 0o7777n) === 0o700n;

// A writable sticky ancestor is safe only when its owner is root or this user.
// A different directory owner can rename children despite the sticky bit.
const safeAncestor = (metadata: BigIntStats, uid: bigint): boolean =>
  metadata.isDirectory() &&
  (metadata.uid === uid || metadata.uid === 0n) &&
  ((metadata.mode & 0o022n) === 0n || (metadata.mode & 0o1000n) !== 0n);

async function admitNamespace(directory: string, uid: bigint): Promise<readonly NamespaceEntry[]> {
  const paths: string[] = [];
  for (let current = directory; ; current = dirname(current)) {
    paths.unshift(current);
    if (paths.length > 128) throw unavailable();
    if (current === dirname(current)) break;
  }
  const chain: NamespaceEntry[] = [];
  for (const path of paths) {
    let metadata: BigIntStats;
    try {
      metadata = await lstat(path, { bigint: true });
    } catch (error) {
      if (!Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(error)) throw unavailable();
      // Never recursively follow or repair an existing namespace. Each missing
      // component is created under the independently admitted parent.
      await checkChain(chain, uid);
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (creationError) {
        if (!Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }))(creationError))
          throw unavailable();
      }
      metadata = await lstat(path, { bigint: true });
    }
    if (!safeAncestor(metadata, uid) || (path === directory && !privateDirectory(metadata, uid)))
      throw unavailable();
    chain.push({ path, metadata });
  }
  return chain;
}

async function checkChain(
  chain: readonly NamespaceEntry[],
  uid: bigint,
  handle?: FileHandle,
): Promise<void> {
  for (const entry of chain) {
    const now = await lstat(entry.path, { bigint: true });
    if (!sameFile(entry.metadata, now) || !safeAncestor(now, uid)) throw unavailable();
  }
  if (handle) {
    const root = chain.at(-1);
    const held = await handle.stat({ bigint: true });
    if (
      !root ||
      !privateDirectory(held, uid) ||
      !sameFile(root.metadata, held) ||
      !privateDirectory(await lstat(root.path, { bigint: true }), uid)
    )
      throw unavailable();
  }
}

function checkChainSync(chain: readonly NamespaceEntry[], uid: bigint, handle: FileHandle): void {
  for (const entry of chain) {
    const now = lstatSync(entry.path, { bigint: true });
    if (!sameFile(entry.metadata, now) || !safeAncestor(now, uid)) throw unavailable();
  }
  const root = chain.at(-1);
  const held = fstatSync(handle.fd, { bigint: true });
  if (
    !root ||
    !privateDirectory(held, uid) ||
    !sameFile(root.metadata, held) ||
    !privateDirectory(lstatSync(root.path, { bigint: true }), uid)
  )
    throw unavailable();
}

async function boundedDirectory(directory: string, uid: bigint): Promise<number> {
  const entries = await opendir(directory);
  let count = 0;
  let total = 0n;
  for await (const entry of entries) {
    if (
      ++count > maximumEntries ||
      !(
        entry.name === markerName ||
        entry.name === keyName ||
        entry.name === writerName ||
        pendingPattern.test(entry.name) ||
        receiptPattern.test(entry.name)
      )
    )
      throw unavailable();
    const metadata = await lstat(join(directory, entry.name), { bigint: true });
    // A concurrent immutable publication briefly has two links. Treat that as
    // unavailable, never as authority or a reason to repair/delete its bytes.
    if (!privateFile(metadata, uid) || metadata.size > BigInt(maximumEntryBytes))
      throw unavailable();
    total += metadata.size;
    if (total > BigInt(maximumTotalBytes)) throw unavailable();
  }
  return count;
}

async function readPrivate(
  directory: string,
  name: string,
  uid: bigint,
  maximum: number,
  chain: readonly NamespaceEntry[],
  root: FileHandle,
): Promise<{ bytes: Buffer; metadata: BigIntStats }> {
  await checkChain(chain, uid, root);
  const path = join(directory, name);
  const before = await lstat(path, { bigint: true });
  if (!privateFile(before, uid) || before.size > BigInt(maximum)) throw unavailable();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!unchangedFile(before, await file.stat({ bigint: true }))) throw unavailable();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw unavailable();
      offset += result.bytesRead;
    }
    if (
      (await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0 ||
      !unchangedFile(before, await file.stat({ bigint: true })) ||
      !unchangedFile(before, await lstat(path, { bigint: true }))
    )
      throw unavailable();
    await checkChain(chain, uid, root);
    return { bytes, metadata: before };
  } finally {
    await file.close();
  }
}

/** Mint one immutable inode, never overwrite a pre-existing final name. The
 * small synchronous commit is intentional: an already-observed AbortSignal
 * cannot interleave between final admission and the no-overwrite publication.
 * Async candidate creation/write/fsync remains cancellation-fenced beforehand.
 * Only this call's exact temporary inode may be removed, never an old receipt. */
async function publishImmutable(
  directory: string,
  name: string,
  bytes: Buffer,
  uid: bigint,
  chain: readonly NamespaceEntry[],
  root: FileHandle,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted || bytes.length > maximumEntryBytes) return false;
  const candidate = join(directory, `.pending-${randomBytes(24).toString("hex")}`);
  const writerPath = join(directory, writerName);
  let writer: FileHandle | undefined;
  let ownedWriter: BigIntStats | undefined;
  let file: FileHandle | undefined;
  let owned: BigIntStats | undefined;
  let published = false;
  let cleanupFailed = false;
  try {
    await checkChain(chain, uid, root);
    if (signal?.aborted) return false;
    // A non-waiting exclusive lease bounds aggregate entry admission across
    // publishers. A crashed lease is never identified by PID or removed by a
    // later caller: it conservatively disables writes, not verified reads.
    writer = await open(
      writerPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    ownedWriter = await writer.stat({ bigint: true });
    if (
      !privateFile(ownedWriter, uid) ||
      (await boundedDirectory(directory, uid)) > maximumEntries - 2
    )
      throw unavailable();
    await checkChain(chain, uid, root);
    if (signal?.aborted) return false;
    file = await open(
      candidate,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    owned = await file.stat({ bigint: true });
    if (!privateFile(owned, uid)) throw unavailable();
    await file.writeFile(bytes);
    await file.sync();
    const written = await file.stat({ bigint: true });
    if (
      !privateFile(written, uid) ||
      !sameFile(owned, written) ||
      written.size !== BigInt(bytes.length) ||
      !unchangedFile(written, await lstat(candidate, { bigint: true }))
    )
      throw unavailable();
    await checkChain(chain, uid, root);
    if (signal?.aborted) return false;
    checkChainSync(chain, uid, root);
    if (
      !privateFile(fstatSync(writer.fd, { bigint: true }), uid) ||
      !sameFile(ownedWriter, lstatSync(writerPath, { bigint: true }))
    )
      throw unavailable();
    if (
      !unchangedFile(written, fstatSync(file.fd, { bigint: true })) ||
      !unchangedFile(written, lstatSync(candidate, { bigint: true }))
    )
      throw unavailable();
    linkSync(candidate, join(directory, name));
    unlinkSync(candidate);
    fsyncSync(root.fd);
    checkChainSync(chain, uid, root);
    const committed = lstatSync(join(directory, name), { bigint: true });
    if (
      !privateFile(committed, uid) ||
      !sameFile(written, committed) ||
      committed.size !== BigInt(bytes.length)
    )
      throw unavailable();
    published = true;
  } catch {
    published = false;
  } finally {
    // Namespace replacement must not make cleanup unlink an unrelated inode.
    if (owned) {
      try {
        await checkChain(chain, uid, root);
        const now = await lstat(candidate, { bigint: true });
        if (!sameFile(owned, now)) throw unavailable();
        await unlink(candidate);
      } catch (error) {
        // A committed candidate was already unlinked. Any other uncertain
        // cleanup is a miss; a replacement is preserved, never removed.
        if (!Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(error))
          cleanupFailed = true;
      }
    }
    await file?.close().catch(() => {
      cleanupFailed = true;
    });
    if (ownedWriter) {
      try {
        await checkChain(chain, uid, root);
        const now = await lstat(writerPath, { bigint: true });
        if (!sameFile(ownedWriter, now)) throw unavailable();
        await unlink(writerPath);
        // Also make retirement of this exact lease durable. A different or
        // crashed lease is never removed to restore cache availability.
        await root.sync();
      } catch {
        cleanupFailed = true;
      }
    }
    await writer?.close().catch(() => {
      cleanupFailed = true;
    });
  }
  return published && !cleanupFailed;
}

function environmentBytes(environment: Readonly<Record<string, string | undefined>>): string {
  if (
    environment === null ||
    typeof environment !== "object" ||
    types.isProxy(environment) ||
    Array.isArray(environment)
  )
    throw unavailable();
  const prototype: unknown = Object.getPrototypeOf(environment);
  if (prototype !== null && prototype !== Object.prototype) throw unavailable();
  const names = Reflect.ownKeys(environment);
  if (names.length > 4096 || names.some((name) => typeof name !== "string")) throw unavailable();
  const pairs: [string, 0 | 1, string][] = [];
  let bytes = 0;
  for (const name of (names as string[]).sort()) {
    const property = Object.getOwnPropertyDescriptor(environment, name);
    if (
      !property ||
      !("value" in property) ||
      !property.enumerable ||
      name.length > 1024 ||
      (property.value !== undefined && typeof property.value !== "string")
    )
      throw unavailable();
    const value: unknown = property.value;
    if (typeof value === "string" && value.length > maximumEnvironmentBytes) throw unavailable();
    const text = typeof value === "string" ? value : "";
    bytes += Buffer.byteLength(name) + Buffer.byteLength(text) + 32;
    if (bytes > maximumEnvironmentBytes) throw unavailable();
    pairs.push([name, value === undefined ? 0 : 1, text]);
  }
  // Sorting and the explicit presence tag distinguish absent/undefined/empty;
  // raw environment values exist only in this bounded transient HMAC input.
  const encoded = encodeJson(pairs);
  if (Buffer.byteLength(encoded) > maximumEnvironmentBytes) throw unavailable();
  return encoded;
}

/** POSIX-only local trust store. Modes do not attest Windows ACL privacy, so
 * Windows deliberately executes tasks afresh. HMAC prevents accidental/foreign
 * receipt adoption, not a malicious process already running as this same user
 * (which can read the key, mutate source or replace the verifier itself).
 * The store holds no persistent descriptors and never prunes existing data. */
export async function createLocalVerificationReceiptStore(
  directory: string,
): Promise<LocalVerificationReceiptStore | undefined> {
  if (
    process.platform === "win32" ||
    typeof process.getuid !== "function" ||
    typeof directory !== "string" ||
    directory.length > 4096 ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    directory === parse(directory).root
  )
    return undefined;
  const uid = BigInt(process.getuid());
  let root: FileHandle | undefined;
  try {
    const chain = await admitNamespace(directory, uid);
    root = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await checkChain(chain, uid, root);
    await boundedDirectory(directory, uid);
    await publishImmutable(directory, markerName, marker, uid, chain, root);
    const admittedMarker = await readPrivate(
      directory,
      markerName,
      uid,
      marker.length,
      chain,
      root,
    );
    if (!admittedMarker.bytes.equals(marker)) return undefined;
    await publishImmutable(directory, keyName, randomBytes(32), uid, chain, root);
    const admittedKey = await readPrivate(directory, keyName, uid, 32, chain, root);
    if (admittedKey.bytes.length !== 32) return undefined;
    const key = admittedKey.bytes;
    const authenticate = (domain: string, value: string): string =>
      createHmac("sha256", key).update(domain).update(value).digest("hex");
    const receipt = (contentKey: string): Buffer =>
      Buffer.from(
        encodeJson({
          schema: 1,
          key: contentKey,
          result: "success",
          mac: authenticate(receiptDomain, contentKey),
        }),
      );
    const withAdmittedRoot = async (
      operation: (held: FileHandle) => Promise<boolean>,
    ): Promise<boolean> => {
      let held: FileHandle | undefined;
      try {
        held = await open(
          directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        await checkChain(chain, uid, held);
        await boundedDirectory(directory, uid);
        const currentMarker = await readPrivate(
          directory,
          markerName,
          uid,
          marker.length,
          chain,
          held,
        );
        const currentKey = await readPrivate(directory, keyName, uid, 32, chain, held);
        if (
          !unchangedFile(admittedMarker.metadata, currentMarker.metadata) ||
          !currentMarker.bytes.equals(marker) ||
          !unchangedFile(admittedKey.metadata, currentKey.metadata) ||
          currentKey.bytes.length !== 32 ||
          !timingSafeEqual(key, currentKey.bytes)
        )
          return false;
        return await operation(held);
      } catch {
        return false;
      } finally {
        await held?.close().catch(() => undefined);
      }
    };
    interface PendingPublication {
      readonly contentKey: string;
      readonly signal: AbortSignal;
      readonly resolve: (published: boolean) => void;
      readonly abort: () => void;
    }
    const publications: PendingPublication[] = [];
    let publishing = false;
    const nextPublication = (): void => {
      if (publishing) return;
      const pending = publications.shift();
      if (!pending) return;
      publishing = true;
      void (async () => {
        let published = false;
        try {
          if (!pending.signal.aborted)
            published = await withAdmittedRoot((held) =>
              publishImmutable(
                directory,
                `${pending.contentKey}.json`,
                receipt(pending.contentKey),
                uid,
                chain,
                held,
                pending.signal,
              ),
            );
        } catch {
          published = false;
        } finally {
          pending.signal.removeEventListener("abort", pending.abort);
          // An admitted operation joins its actual descriptor/temp cleanup even
          // after cancellation. Only a still-queued item can settle immediately.
          pending.resolve(published && !pending.signal.aborted);
          publishing = false;
          nextPublication();
        }
      })();
    };
    return Object.freeze({
      authenticateEnvironment(environment: Readonly<Record<string, string | undefined>>): string {
        try {
          return authenticate(environmentDomain, environmentBytes(environment));
        } catch {
          throw unavailable();
        }
      },
      async read(contentKey: string): Promise<boolean> {
        if (typeof contentKey !== "string" || !digestPattern.test(contentKey)) return false;
        return withAdmittedRoot(async (held) => {
          const stored = await readPrivate(
            directory,
            `${contentKey}.json`,
            uid,
            maximumEntryBytes,
            chain,
            held,
          );
          const decoded = decodeJson(stored.bytes.toString("utf8"));
          if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
            return false;
          const fields = Object.getOwnPropertyDescriptors(decoded);
          if (
            Reflect.ownKeys(fields).length !== 4 ||
            fields.schema?.value !== 1 ||
            fields.key?.value !== contentKey ||
            fields.result?.value !== "success" ||
            typeof fields.mac?.value !== "string" ||
            !digestPattern.test(fields.mac.value)
          )
            return false;
          const expected = receipt(contentKey);
          // The MAC and exact finite canonical envelope are both required. No
          // received timestamp, status prose or extra field grants authority.
          return (
            timingSafeEqual(
              Buffer.from(fields.mac.value, "hex"),
              Buffer.from(authenticate(receiptDomain, contentKey), "hex"),
            ) && stored.bytes.equals(expected)
          );
        });
      },
      async publish(contentKey: string, signal: AbortSignal): Promise<boolean> {
        if (typeof contentKey !== "string" || !digestPattern.test(contentKey) || signal.aborted)
          return false;
        // Parallel tasks in this one verification run should not discard useful
        // successes merely because their closes coincide. This bounded FIFO is
        // not a cross-process retry/lock-stealing mechanism.
        if (publications.length + (publishing ? 1 : 0) >= 256) return false;
        return new Promise<boolean>((resolvePublication) => {
          const pending: PendingPublication = {
            contentKey,
            signal,
            resolve: resolvePublication,
            abort() {
              const index = publications.indexOf(pending);
              if (index === -1) return;
              publications.splice(index, 1);
              signal.removeEventListener("abort", pending.abort);
              resolvePublication(false);
            },
          };
          publications.push(pending);
          signal.addEventListener("abort", pending.abort, { once: true });
          if (signal.aborted) pending.abort();
          nextPublication();
        });
      },
    });
  } catch {
    return undefined;
  } finally {
    await root?.close().catch(() => undefined);
  }
}
