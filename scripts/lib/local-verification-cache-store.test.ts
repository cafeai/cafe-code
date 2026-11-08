// These synthetic directories qualify real inode, permissions, exclusive-link
// and cancellation behavior without touching application/provider storage.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalVerificationReceiptStore } from "./local-verification-cache-store.ts";

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const keyA = "a".repeat(64);
const keyB = "b".repeat(64);
const roots: string[] = [];
async function fixture(): Promise<{ parent: string; directory: string }> {
  // On macOS tmpdir commonly traverses /var -> /private/var. Native cache
  // admission must still reject aliases, so normalize only this owned fixture.
  const parent = await mkdtemp(join(await realpath(tmpdir()), "cafe-local-receipt-"));
  roots.push(parent);
  return { parent, directory: join(parent, ".logs", "local-verification") };
}
async function requiredStore(directory: string) {
  const store = await createLocalVerificationReceiptStore(directory);
  expect(store).toBeDefined();
  if (!store) throw new Error("The synthetic private receipt namespace must be admitted.");
  return store;
}
afterEach(async () => {
  for (const parent of roots.splice(0)) await rm(parent, { recursive: true, force: true });
});

describe.runIf(process.platform !== "win32" && typeof process.getuid === "function")(
  "private local verification receipt store",
  () => {
    it("persists an exact success and authenticates environments without storing their values", async () => {
      const { directory } = await fixture();
      const store = await requiredStore(directory);
      const environment = {
        PRIVATE_FIXTURE_TOKEN: "low-entropy-private-value",
        PATH: "fixture-path",
        OMITTED: undefined,
      };
      const authenticated = store.authenticateEnvironment(environment);
      expect(authenticated).toMatch(/^[a-f0-9]{64}$/u);
      expect(
        store.authenticateEnvironment({
          OMITTED: undefined,
          PATH: "fixture-path",
          PRIVATE_FIXTURE_TOKEN: "low-entropy-private-value",
        }),
      ).toBe(authenticated);
      expect(store.authenticateEnvironment({ ...environment, PATH: "changed" })).not.toBe(
        authenticated,
      );
      expect(
        store.authenticateEnvironment({
          PATH: "fixture-path",
          PRIVATE_FIXTURE_TOKEN: "low-entropy-private-value",
        }),
      ).not.toBe(authenticated);
      expect(store.authenticateEnvironment({ ...environment, OMITTED: "" })).not.toBe(
        authenticated,
      );
      expect(await store.read(keyA)).toBe(false);
      expect(await store.publish(keyA, new AbortController().signal)).toBe(true);
      expect(await store.read(keyA)).toBe(true);
      const reopened = await requiredStore(directory);
      expect(reopened.authenticateEnvironment(environment)).toBe(authenticated);
      expect(await reopened.read(keyA)).toBe(true);
      const receipt = await readFile(join(directory, `${keyA}.json`), "utf8");
      expect(receipt).not.toContain(environment.PRIVATE_FIXTURE_TOKEN);
      expect(receipt).not.toContain(environment.PATH);
      expect((await lstat(directory)).mode & 0o7777).toBe(0o700);
      for (const name of await readdir(directory)) {
        const metadata = await lstat(join(directory, name));
        expect(metadata.nlink).toBe(1);
        expect(metadata.mode & 0o7777).toBe(0o600);
      }
    });

    it("does not adopt another private store's key, environment tag or copied success", async () => {
      const first = await fixture();
      const second = await fixture();
      const a = await requiredStore(first.directory);
      const b = await requiredStore(second.directory);
      expect(a.authenticateEnvironment({ SECRET: "same fixture secret" })).not.toBe(
        b.authenticateEnvironment({ SECRET: "same fixture secret" }),
      );
      expect(await a.publish(keyA, new AbortController().signal)).toBe(true);
      await copyFile(join(first.directory, `${keyA}.json`), join(second.directory, `${keyA}.json`));
      await chmod(join(second.directory, `${keyA}.json`), 0o600);
      expect(await b.read(keyA)).toBe(false);
      const foreign = await readFile(join(second.directory, `${keyA}.json`));
      expect(await b.publish(keyA, new AbortController().signal)).toBe(false);
      expect(await readFile(join(second.directory, `${keyA}.json`))).toEqual(foreign);
    });

    it("rejects corrupted, changed-schema and wrong-content-key envelopes without replacing them", async () => {
      const { directory } = await fixture();
      const store = await requiredStore(directory);
      expect(await store.publish(keyA, new AbortController().signal)).toBe(true);
      const path = join(directory, `${keyA}.json`);
      const original = await readFile(path);
      const decoded = decodeJson(original.toString("utf8"));
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
        throw new Error("Expected synthetic success envelope.");
      for (const bytes of [
        Buffer.from("malformed private receipt"),
        Buffer.from(encodeJson({ ...decoded, schema: 2 })),
        Buffer.from(encodeJson({ ...decoded, result: "failure" })),
        Buffer.from(encodeJson({ ...decoded, extra: true })),
        Buffer.from(encodeJson({ ...decoded, mac: "0".repeat(64) })),
        Buffer.concat([original, Buffer.from("\n")]),
      ]) {
        await writeFile(path, bytes);
        expect(await store.read(keyA)).toBe(false);
        expect(await store.publish(keyA, new AbortController().signal)).toBe(false);
        expect(await readFile(path)).toEqual(bytes);
      }
      await writeFile(path, original);
      await rename(path, join(directory, `${keyB}.json`));
      expect(await store.read(keyB)).toBe(false);
      expect(await store.read(keyA)).toBe(false);
    });

    it("serializes concurrent no-overwrite publication and preserves the winning inode", async () => {
      const { directory } = await fixture();
      const first = await requiredStore(directory);
      const second = await requiredStore(directory);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          (index % 2 === 0 ? first : second).publish(keyA, new AbortController().signal),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await first.read(keyA)).toBe(true);
      expect(await second.read(keyA)).toBe(true);
      const before = await lstat(join(directory, `${keyA}.json`), { bigint: true });
      const contents = await readFile(join(directory, `${keyA}.json`));
      expect(await first.publish(keyA, new AbortController().signal)).toBe(false);
      const after = await lstat(join(directory, `${keyA}.json`), { bigint: true });
      expect(after.ino).toBe(before.ino);
      expect(after.nlink).toBe(1n);
      expect(await readFile(join(directory, `${keyA}.json`))).toEqual(contents);
      expect(
        (await readdir(directory)).some(
          (name) => name === ".writer" || name.startsWith(".pending-"),
        ),
      ).toBe(false);
    });

    it("retains every distinct concurrent completion owned by the same verifier", async () => {
      const { directory } = await fixture();
      const store = await requiredStore(directory);
      const keys = Array.from({ length: 8 }, (_, index) => index.toString(16).padStart(64, "0"));
      expect(
        await Promise.all(keys.map((key) => store.publish(key, new AbortController().signal))),
      ).toEqual(keys.map(() => true));
      expect(await Promise.all(keys.map((key) => store.read(key)))).toEqual(keys.map(() => true));
    });

    it("bounds queued completions and cancels exact queued entries without writing them", async () => {
      const { directory } = await fixture();
      const store = await requiredStore(directory);
      const active = store.publish(keyA, new AbortController().signal);
      const controllers = Array.from({ length: 255 }, () => new AbortController());
      const pending = controllers.map((controller, index) =>
        store.publish(index.toString(16).padStart(64, "0"), controller.signal),
      );
      // No native await has completed: the one active item plus these 255 own
      // the finite queue. The next caller is a miss, never an unbounded waiter.
      const overflow = store.publish(keyB, new AbortController().signal);
      for (const controller of controllers) controller.abort();
      expect(await overflow).toBe(false);
      expect(await Promise.all(pending)).toEqual(controllers.map(() => false));
      expect(await active).toBe(true);
      expect(await store.read(keyA)).toBe(true);
      expect(await store.read(keyB)).toBe(false);
      expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toEqual([
        `${keyA}.json`,
      ]);
    });

    it("vetoes pre-aborted and in-flight publication without admitting a success", async () => {
      const { directory } = await fixture();
      const store = await requiredStore(directory);
      const preAborted = new AbortController();
      preAborted.abort();
      expect(await store.publish(keyA, preAborted.signal)).toBe(false);
      const duringAdmission = new AbortController();
      const pending = store.publish(keyB, duringAdmission.signal);
      duringAdmission.abort();
      expect(await pending).toBe(false);
      expect(await store.read(keyA)).toBe(false);
      expect(await store.read(keyB)).toBe(false);
      expect(
        (await readdir(directory)).some(
          (name) => name.endsWith(".json") || name === ".writer" || name.startsWith(".pending-"),
        ),
      ).toBe(false);
    });

    it("preserves a crashed writer lease while allowing already-authenticated reads", async () => {
      const { directory } = await fixture();
      const store = await requiredStore(directory);
      expect(await store.publish(keyA, new AbortController().signal)).toBe(true);
      const lease = Buffer.from("owned synthetic interrupted publisher");
      await writeFile(join(directory, ".writer"), lease, { flag: "wx", mode: 0o600 });
      expect(await store.read(keyA)).toBe(true);
      expect(await store.publish(keyB, new AbortController().signal)).toBe(false);
      expect(await readFile(join(directory, ".writer"))).toEqual(lease);
      expect(await (await requiredStore(directory)).read(keyA)).toBe(true);
    });

    it("does not invoke environment getters and rejects unbounded or malformed inputs", async () => {
      const { directory } = await fixture();
      const store = await requiredStore(directory);
      let getterCalls = 0;
      const getter: Record<string, string | undefined> = {};
      Object.defineProperty(getter, "SECRET", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "not admitted";
        },
      });
      expect(() => store.authenticateEnvironment(getter)).toThrow(
        "Local verification cache unavailable.",
      );
      expect(getterCalls).toBe(0);
      let proxyTraps = 0;
      const proxy = new Proxy(
        { SECRET: "not admitted" },
        {
          getPrototypeOf() {
            proxyTraps += 1;
            throw new Error("Private proxy details must not escape.");
          },
          ownKeys() {
            proxyTraps += 1;
            return ["SECRET"];
          },
          getOwnPropertyDescriptor() {
            proxyTraps += 1;
            return { configurable: true, enumerable: true, value: "not admitted" };
          },
        },
      );
      expect(() => store.authenticateEnvironment(proxy)).toThrow(
        "Local verification cache unavailable.",
      );
      expect(proxyTraps).toBe(0);
      expect(() => store.authenticateEnvironment({ LARGE: "x".repeat(1024 * 1024 + 1) })).toThrow(
        "Local verification cache unavailable.",
      );
      expect(() =>
        store.authenticateEnvironment(
          Object.create({ INHERITED: "foreign" }) as Record<string, string | undefined>,
        ),
      ).toThrow("Local verification cache unavailable.");
      for (const key of ["", "../foreign", "A".repeat(64), "a".repeat(65)]) {
        expect(await store.read(key)).toBe(false);
        expect(await store.publish(key, new AbortController().signal)).toBe(false);
      }
    });

    it("refuses unsafe namespace/entry modes and retains the original bytes", async () => {
      const { directory } = await fixture();
      const store = await requiredStore(directory);
      expect(await store.publish(keyA, new AbortController().signal)).toBe(true);
      const path = join(directory, `${keyA}.json`);
      const bytes = await readFile(path);
      await chmod(path, 0o644);
      expect(await store.read(keyA)).toBe(false);
      expect(await createLocalVerificationReceiptStore(directory)).toBeUndefined();
      expect(await readFile(path)).toEqual(bytes);
      await chmod(path, 0o600);
      await chmod(directory, 0o755);
      expect(await store.read(keyA)).toBe(false);
      expect(await createLocalVerificationReceiptStore(directory)).toBeUndefined();
      await chmod(directory, 0o700);
      expect(await store.read(keyA)).toBe(true);
    });

    it("refuses symbolic/hard aliases and never reads or mutates their targets", async () => {
      const { parent, directory } = await fixture();
      const store = await requiredStore(directory);
      expect(await store.publish(keyA, new AbortController().signal)).toBe(true);
      const receiptPath = join(directory, `${keyA}.json`);
      const alias = join(parent, "hard-alias");
      await link(receiptPath, alias);
      const before = await readFile(alias);
      expect(await store.read(keyA)).toBe(false);
      expect(await store.publish(keyB, new AbortController().signal)).toBe(false);
      expect(await readFile(alias)).toEqual(before);
      await rm(alias);
      await symlink(receiptPath, join(directory, `${keyB}.json`));
      expect(await store.read(keyB)).toBe(false);
      expect(await store.publish(keyB, new AbortController().signal)).toBe(false);
      expect(await readFile(receiptPath)).toEqual(before);
      const rootAlias = join(parent, "namespace-alias");
      await symlink(directory, rootAlias);
      expect(await createLocalVerificationReceiptStore(rootAlias)).toBeUndefined();
      const ancestorAlias = join(parent, "ancestor-alias");
      await symlink(join(parent, ".logs"), ancestorAlias);
      expect(
        await createLocalVerificationReceiptStore(join(ancestorAlias, "local-verification")),
      ).toBeUndefined();
    });

    it("refuses replaced roots and replaced authentication keys instead of adopting new ownership", async () => {
      const { parent, directory } = await fixture();
      const store = await requiredStore(directory);
      expect(await store.publish(keyA, new AbortController().signal)).toBe(true);
      const old = join(parent, "retained-original");
      await rename(directory, old);
      await mkdir(directory, { mode: 0o700 });
      const replacement = await requiredStore(directory);
      expect(await store.read(keyA)).toBe(false);
      expect(await store.publish(keyB, new AbortController().signal)).toBe(false);
      expect(replacement.authenticateEnvironment({ PATH: "same" })).not.toBe(
        store.authenticateEnvironment({ PATH: "same" }),
      );
      expect(await readFile(join(old, `${keyA}.json`))).toHaveLength(
        (await lstat(join(old, `${keyA}.json`))).size,
      );
      expect(await replacement.publish(keyA, new AbortController().signal)).toBe(true);
      const authentication = join(directory, ".authentication-key");
      await rename(authentication, join(parent, "retained-key"));
      await writeFile(authentication, Buffer.alloc(32, 7), { mode: 0o600, flag: "wx" });
      expect(await replacement.read(keyA)).toBe(false);
      expect(await replacement.publish(keyB, new AbortController().signal)).toBe(false);
      expect(await readFile(authentication)).toEqual(Buffer.alloc(32, 7));
    });

    it("refuses foreign initialization and oversized sparse records before allocating their bytes", async () => {
      const first = await fixture();
      await mkdir(first.directory, { recursive: true, mode: 0o700 });
      await writeFile(join(first.directory, "unrelated-user-file"), "preserve", { mode: 0o600 });
      expect(await createLocalVerificationReceiptStore(first.directory)).toBeUndefined();
      expect(await readdir(first.directory)).toEqual(["unrelated-user-file"]);
      const second = await fixture();
      const store = await requiredStore(second.directory);
      const path = join(second.directory, `${keyA}.json`);
      const file = await open(path, "wx", 0o600);
      try {
        await file.truncate(1024 * 1024 * 1024);
      } finally {
        await file.close();
      }
      expect(await store.read(keyA)).toBe(false);
      expect(await createLocalVerificationReceiptStore(second.directory)).toBeUndefined();
      expect((await lstat(path)).size).toBe(1024 * 1024 * 1024);
    });
  },
);

it.runIf(process.platform === "win32")(
  "uses fresh verification when POSIX privacy is not qualified",
  async () => {
    const { directory } = await fixture();
    expect(await createLocalVerificationReceiptStore(directory)).toBeUndefined();
  },
);
