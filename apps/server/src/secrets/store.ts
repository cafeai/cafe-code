// Private encrypted-vault filesystem boundary. Native descriptors retain
// no-follow, single-link, bigint identity and bounded reads on every operation.
// @effect-diagnostics nodeBuiltinImport:off
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { ThreadSecretMetadata } from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import {
  cafeSecretReference,
  findCafeSecretRanges,
  findCafeSecretReferenceRanges,
  parseCafeSecrets,
} from "@cafecode/shared/cafeSecrets";

const MAX_FILE_BYTES = 2_097_152;
const MAX_SECRETS = 64;
const MAX_VALUE_BYTES = 16_384;
const pendingWriters = new Map<string, Promise<unknown>>();
const pendingWriterCounts = new Map<string, number>();
const pendingKeys = new Map<string, Promise<Buffer>>();
interface StoredSecret extends ThreadSecretMetadata {
  readonly value: string;
}
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const hasCode = (error: unknown, code: string) =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;
export class CafeSecretsStoreError extends Error {
  constructor(message = "Cafe Secrets storage is unavailable.") {
    super(message);
  }
}
const validateReferences = (text: string, values: ReadonlyMap<string, string>) => {
  for (const reference of findCafeSecretReferenceRanges(text))
    if (!values.has(reference.id))
      throw new CafeSecretsStoreError("A Cafe Secret reference is unavailable in this chat.");
};
const metadata = (entry: StoredSecret): ThreadSecretMetadata => ({
  id: entry.id,
  label: entry.label,
  reference: entry.reference,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
});
const privateIdentity = (info: BigIntStats, directory: boolean): boolean =>
  (directory ? info.isDirectory() : info.isFile() && info.nlink === 1n) &&
  !info.isSymbolicLink() &&
  (process.platform === "win32" ||
    (info.uid === BigInt(process.getuid!()) && (info.mode & 0o077n) === 0n));

/** Keys and ciphertext live separately from event history in the profile's
 * private namespace. The key is a private local file, not an OS keychain claim. */
export class ThreadSecretsStore {
  readonly root: string;
  constructor(secretsDir: string) {
    this.root = path.resolve(secretsDir, "cafe-secrets");
  }
  private filename(threadId: string) {
    if (!threadId || threadId.length > 200) throw new CafeSecretsStoreError();
    return path.join(this.root, `${createHash("sha256").update(threadId).digest("hex")}.bin`);
  }
  private async rootIdentity(create = false): Promise<BigIntStats | undefined> {
    try {
      if (create) await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const info = await fs.lstat(this.root, { bigint: true });
      // The configured parent may contain a system alias such as macOS /var.
      // The leaf remains a private non-link directory, with exact bigint
      // namespace rechecks around every native descriptor operation.
      if (!privateIdentity(info, true)) throw new CafeSecretsStoreError();
      return info;
    } catch (error) {
      if (!create && hasCode(error, "ENOENT")) return undefined;
      throw new CafeSecretsStoreError();
    }
  }
  private async assertRoot(identity: BigIntStats) {
    const current = await this.rootIdentity();
    if (!current || !sameFile(current, identity)) throw new CafeSecretsStoreError();
  }
  private async readFile(
    filePath: string,
    root: BigIntStats,
    limit = MAX_FILE_BYTES,
  ): Promise<Buffer | undefined> {
    await this.assertRoot(root);
    let handle;
    try {
      handle = await fs.open(
        filePath,
        constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
      );
      const before = await handle.stat({ bigint: true });
      if (!privateIdentity(before, false) || before.size > BigInt(limit))
        throw new CafeSecretsStoreError();
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const name = await fs.lstat(filePath, { bigint: true });
      await this.assertRoot(root);
      if (
        BigInt(size) !== before.size ||
        !sameFile(before, after) ||
        !sameFile(after, name) ||
        !privateIdentity(name, false) ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        throw new CafeSecretsStoreError();
      return buffer.subarray(0, size);
    } catch (error) {
      if (!handle && hasCode(error, "ENOENT")) return undefined;
      throw new CafeSecretsStoreError();
    } finally {
      await handle?.close();
    }
  }
  private key(root: BigIntStats, create: boolean): Promise<Buffer> {
    const pending = pendingKeys.get(this.root);
    if (pending)
      return pending.then(async (key) => {
        await this.assertRoot(root);
        return key;
      });
    const key = this.readKey(root, create);
    pendingKeys.set(this.root, key);
    void key
      .finally(() => {
        if (pendingKeys.get(this.root) === key) pendingKeys.delete(this.root);
      })
      .catch(() => undefined);
    return key;
  }
  private async readKey(root: BigIntStats, create: boolean) {
    const filename = path.join(this.root, "key.bin");
    let key = await this.readFile(filename, root, 32);
    if (!key && create) {
      const candidate = randomBytes(32);
      await this.assertRoot(root);
      try {
        const file = await fs.open(
          filename,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          const identity = await file.stat({ bigint: true });
          if (!privateIdentity(identity, false)) throw new CafeSecretsStoreError();
          await this.assertRoot(root);
          await file.writeFile(candidate);
          await file.sync();
        } finally {
          await file.close();
        }
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw new CafeSecretsStoreError();
      }
      key = await this.readFile(filename, root, 32);
    }
    if (!key || key.length !== 32) throw new CafeSecretsStoreError();
    return key;
  }
  private async load(threadId: string): Promise<StoredSecret[]> {
    const root = await this.rootIdentity();
    if (!root) return [];
    const encoded = await this.readFile(this.filename(threadId), root);
    if (!encoded) return [];
    try {
      if (encoded.length < 29) throw new CafeSecretsStoreError();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        await this.key(root, false),
        encoded.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(`cafe-secrets-v1:${this.root}:${threadId}`));
      decipher.setAuthTag(encoded.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]);
      const entries: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
      if (!Array.isArray(entries) || entries.length > MAX_SECRETS)
        throw new CafeSecretsStoreError();
      const ids = new Set<string>();
      for (const entry of entries) {
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof entry.id !== "string" ||
          !/^[a-f0-9]{32}$/.test(entry.id) ||
          ids.has(entry.id) ||
          typeof entry.value !== "string" ||
          entry.value.length === 0 ||
          Buffer.byteLength(entry.value) > MAX_VALUE_BYTES ||
          typeof entry.label !== "string" ||
          entry.label.length > 160 ||
          entry.reference !== cafeSecretReference(entry.id) ||
          typeof entry.createdAt !== "string" ||
          typeof entry.updatedAt !== "string" ||
          !Number.isFinite(Date.parse(entry.createdAt)) ||
          !Number.isFinite(Date.parse(entry.updatedAt))
        )
          throw new CafeSecretsStoreError();
        ids.add(entry.id);
      }
      return entries as StoredSecret[];
    } catch {
      throw new CafeSecretsStoreError();
    }
  }
  private async save(threadId: string, entries: readonly StoredSecret[]) {
    const root = (await this.rootIdentity(true))!;
    const key = await this.key(root, true);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`cafe-secrets-v1:${this.root}:${threadId}`));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(entries), "utf8"),
      cipher.final(),
    ]);
    const bytes = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    if (bytes.length > MAX_FILE_BYTES)
      throw new CafeSecretsStoreError("This chat's Cafe Secrets storage limit was reached.");
    const filename = this.filename(threadId);
    const temporary = path.join(this.root, `.${randomUUID()}.tmp`);
    let temporaryIdentity: BigIntStats | undefined;
    try {
      await this.assertRoot(root);
      const handle = await fs.open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      let identity: BigIntStats;
      try {
        identity = await handle.stat({ bigint: true });
        temporaryIdentity = identity;
        if (!privateIdentity(identity, false)) throw new CafeSecretsStoreError();
        await this.assertRoot(root);
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.assertRoot(root);
      const current = await fs.lstat(temporary, { bigint: true });
      if (!sameFile(current, identity) || !privateIdentity(current, false))
        throw new CafeSecretsStoreError();
      // Existing destinations must pass the same native ownership admission.
      await this.readFile(filename, root);
      await fs.rename(temporary, filename);
      await this.assertRoot(root);
    } catch {
      throw new CafeSecretsStoreError();
    } finally {
      if (temporaryIdentity)
        await (async () => {
          await this.assertRoot(root);
          const current = await fs.lstat(temporary, { bigint: true });
          if (sameFile(current, temporaryIdentity) && privateIdentity(current, false))
            await fs.unlink(temporary);
        })().catch(() => undefined);
    }
  }
  private mutate<A>(threadId: string, change: (entries: StoredSecret[]) => A): Promise<A> {
    const owner = this.filename(threadId);
    const count = pendingWriterCounts.get(owner) ?? 0;
    if (count >= 32 || (!pendingWriters.has(owner) && pendingWriters.size >= 128))
      return Promise.reject(new CafeSecretsStoreError("Cafe Secrets is busy. Try again."));
    pendingWriterCounts.set(owner, count + 1);
    const result = (pendingWriters.get(owner) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const entries = await this.load(threadId);
        const result = change(entries);
        await this.save(threadId, entries);
        return result;
      });
    pendingWriters.set(owner, result);
    void result
      .finally(() => {
        if (pendingWriters.get(owner) === result) pendingWriters.delete(owner);
        const remaining = (pendingWriterCounts.get(owner) ?? 1) - 1;
        if (remaining === 0) pendingWriterCounts.delete(owner);
        else pendingWriterCounts.set(owner, remaining);
      })
      .catch(() => undefined);
    return result;
  }
  async list(threadId: string) {
    return { secrets: (await this.load(threadId)).map(metadata) };
  }
  async snapshot(threadId: string): Promise<ReadonlyMap<string, string>> {
    return new Map((await this.load(threadId)).map((entry) => [entry.id, entry.value]));
  }
  async reveal(threadId: string, id: string) {
    const entry = (await this.load(threadId)).find((entry) => entry.id === id);
    if (!entry) throw new CafeSecretsStoreError("This Cafe Secret is no longer available.");
    return { value: entry.value };
  }
  set(input: { threadId: string; id?: string; label?: string; value: string }) {
    if (
      !input.value ||
      Buffer.byteLength(input.value) > MAX_VALUE_BYTES ||
      (input.label?.length ?? 0) > 160
    )
      return Promise.reject(
        new CafeSecretsStoreError("Cafe Secret values must contain 1–16,384 UTF-8 bytes."),
      );
    return this.mutate(input.threadId, (entries) => {
      const existing = input.id ? entries.find((entry) => entry.id === input.id) : undefined;
      if (input.id && !existing)
        throw new CafeSecretsStoreError("This Cafe Secret is no longer available.");
      if (!existing && entries.length >= MAX_SECRETS)
        throw new CafeSecretsStoreError("A chat can store at most 64 Cafe Secrets.");
      const now = DateTime.formatIso(DateTime.nowUnsafe());
      const id = existing?.id ?? randomBytes(16).toString("hex");
      const entry: StoredSecret = {
        id,
        reference: cafeSecretReference(id),
        label: input.label ?? existing?.label ?? "",
        value: input.value,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) entries[entries.indexOf(existing)] = entry;
      else entries.push(entry);
      return { secret: metadata(entry) };
    });
  }
  remove(threadId: string, id: string) {
    return this.mutate(threadId, (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index >= 0) entries.splice(index, 1);
      return { removed: index >= 0 };
    });
  }
  clear(threadId: string) {
    return this.mutate(threadId, (entries) => {
      const removed = entries.length;
      entries.splice(0);
      return { removed };
    });
  }
  prepare(threadId: string, text: string) {
    const { spans } = parseCafeSecrets(text);
    if (
      findCafeSecretRanges(text).length !== spans.length ||
      spans.some((span) => !span.value || Buffer.byteLength(span.value) > MAX_VALUE_BYTES)
    )
      return Promise.reject(
        new CafeSecretsStoreError(
          "Complete each Cafe Secret as [sec:VALUE], or escape literal text with a backslash.",
        ),
      );
    if (spans.length === 0)
      return this.snapshot(threadId).then((values) => {
        validateReferences(text, values);
        return { text };
      });
    return this.mutate(threadId, (entries) => {
      let output = "";
      let offset = 0;
      for (const span of spans) {
        let entry = entries.find((entry) => entry.value === span.value);
        if (!entry) {
          if (entries.length >= MAX_SECRETS)
            throw new CafeSecretsStoreError("A chat can store at most 64 Cafe Secrets.");
          const id = randomBytes(16).toString("hex");
          const now = DateTime.formatIso(DateTime.nowUnsafe());
          entry = {
            id,
            label: "",
            reference: cafeSecretReference(id),
            value: span.value,
            createdAt: now,
            updatedAt: now,
          };
          entries.push(entry);
        }
        output += text.slice(offset, span.start) + entry.reference;
        offset = span.end;
      }
      output += text.slice(offset);
      if (Buffer.byteLength(output) > 1_048_576)
        throw new CafeSecretsStoreError("This message has too many Cafe Secret references.");
      validateReferences(output, new Map(entries.map((entry) => [entry.id, entry.value])));
      return { text: output };
    });
  }
}

// One backend owns profile writes; provider runtimes and runners read atomic
// snapshots. Shared transient locks coordinate websocket owners without a
// permanent root/chat cache or an unbounded queue.
export function getThreadSecretsStore(secretsDir: string): ThreadSecretsStore {
  return new ThreadSecretsStore(secretsDir);
}
