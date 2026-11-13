// Test-owned native private directories qualify descriptor and persistence
// boundaries without provider credentials or changing user profiles.
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { expect, it, type TestContext } from "vitest";
import { cafeSecretReference, redactCafeSecretText } from "@cafecode/shared/cafeSecrets";
import { ThreadSecretsStore } from "./store.ts";
import { prepareDebugDataProfile } from "@cafecode/shared/dataProfileStorage";

async function fixture(context: TestContext) {
  let acquiring: Promise<string> | undefined;
  context.onTestFinished(async () => {
    if (acquiring) await fs.rm(await acquiring, { recursive: true, force: true });
  });
  acquiring = fs.mkdtemp(path.join(os.tmpdir(), "cafe-secret-test-"));
  const root = await fs.realpath(await acquiring);
  const store = new ThreadSecretsStore(root);
  return {
    root,
    store,
    vault: store.root,
    filename: (id: string) =>
      path.join(store.root, `${createHash("sha256").update(id).digest("hex")}.bin`),
  };
}

it("admits an encrypted Cafe Secrets vault on the next Debug profile startup without changing it", async (context) => {
  const { root } = await fixture(context);
  await prepareDebugDataProfile(root);
  const secrets = path.join(root, ".debug", "userdata", "secrets");
  const first = new ThreadSecretsStore(secrets);
  const prepared = await first.prepare("profile-restart", "Use [sec:synthetic-profile-secret].");
  const keyBefore = await fs.readFile(path.join(first.root, "key.bin"));
  await prepareDebugDataProfile(root);
  const reopened = new ThreadSecretsStore(secrets);
  const listing = await reopened.list("profile-restart");
  expect(listing.secrets).toHaveLength(1);
  expect(prepared.text).toContain(listing.secrets[0]!.reference);
  expect(await reopened.reveal("profile-restart", listing.secrets[0]!.id)).toEqual({
    value: "synthetic-profile-secret",
  });
  expect(await fs.readFile(path.join(first.root, "key.bin"))).toEqual(keyBefore);
  await expect(fs.stat(path.join(root, "userdata"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps plaintext out of durable ciphertext, metadata, and another chat", async (context) => {
  const { root, store, filename } = await fixture(context);
  const value = "synthetic-api-credential-123456789";
  const prepared = await store.prepare("chat-a", `Use [sec:${value}] and \\[sec:literal].`);
  expect(prepared.text).not.toContain(value);
  expect(prepared.text).toContain("\\[sec:literal]");
  const list = await new ThreadSecretsStore(root).list("chat-a");
  expect(list.secrets).toHaveLength(1);
  expect(JSON.stringify(list)).not.toContain(value);
  expect((await fs.readFile(filename("chat-a"))).includes(Buffer.from(value))).toBe(false);
  expect(await store.reveal("chat-a", list.secrets[0]!.id)).toEqual({ value });
  await expect(store.prepare("chat-b", list.secrets[0]!.reference)).rejects.toThrow("unavailable");
  expect(await store.list("chat-b")).toEqual({ secrets: [] });
});

it("deduplicates repeated capture and serializes concurrent edits", async (context) => {
  const { store } = await fixture(context);
  const prepared = await Promise.all(
    Array.from({ length: 8 }, () => store.prepare("chat", "[sec:one]")),
  );
  expect(new Set(prepared.map((entry) => entry.text)).size).toBe(1);
  expect((await store.list("chat")).secrets).toHaveLength(1);
  await Promise.all([
    store.prepare("other-a", "[sec:alpha]"),
    store.prepare("other-b", "[sec:beta]"),
  ]);
  expect((await store.list("other-a")).secrets).toHaveLength(1);
  expect((await store.list("other-b")).secrets).toHaveLength(1);
});

it("keeps exact old-value redaction snapshots through edit, removal, and clear", async (context) => {
  const { store } = await fixture(context);
  const { secret } = await store.set({ threadId: "chat", label: "Service", value: "old-value" });
  const held = await store.snapshot("chat");
  await store.set({ threadId: "chat", id: secret.id, value: "new-value" });
  expect(await store.reveal("chat", secret.id)).toEqual({ value: "new-value" });
  expect((await store.list("chat")).secrets[0]!.label).toBe("Service");
  expect(await store.remove("chat", secret.id)).toEqual({ removed: true });
  await expect(store.prepare("chat", cafeSecretReference(secret.id))).rejects.toThrow(
    "unavailable",
  );
  expect(redactCafeSecretText("old-value", held)).toBe(secret.reference);
  await store.set({ threadId: "chat", value: "another" });
  expect(await store.clear("chat")).toEqual({ removed: 1 });
  expect(await store.list("chat")).toEqual({ secrets: [] });
});

it("refuses incomplete, empty, oversized, and over-capacity capture atomically", async (context) => {
  const { store } = await fixture(context);
  for (const text of ["[sec:unfinished", "[sec:]", `[sec:${"a".repeat(16_385)}]`])
    await expect(store.prepare("chat", text)).rejects.toThrow();
  expect(await store.list("chat")).toEqual({ secrets: [] });
  await store.prepare("chat", Array.from({ length: 64 }, (_, i) => `[sec:value-${i}]`).join(" "));
  await expect(store.prepare("chat", "[sec:one-too-many]")).rejects.toThrow("64");
  expect((await store.list("chat")).secrets).toHaveLength(64);
});

it("refuses tampered ciphertext without replacing its prior durable bytes", async (context) => {
  const { store, filename } = await fixture(context);
  await store.prepare("chat", "[sec:private-value]");
  const contents = await fs.readFile(filename("chat"));
  contents[contents.length - 1] = contents[contents.length - 1]! ^ 1;
  await fs.writeFile(filename("chat"), contents);
  await expect(store.prepare("chat", "[sec:new-value]")).rejects.toThrow("unavailable");
  expect(await fs.readFile(filename("chat"))).toEqual(contents);
});

it("rejects linked vault files before decrypting or overwriting", async (context) => {
  const { store, root, filename } = await fixture(context);
  await store.prepare("chat", "[sec:private-value]");
  await fs.link(filename("chat"), path.join(root, "second-link"));
  await expect(store.list("chat")).rejects.toThrow("unavailable");
  await expect(store.prepare("chat", "[sec:new-value]")).rejects.toThrow("unavailable");
});

it.skipIf(process.platform === "win32")(
  "refuses a linked vault leaf while admitting a configured parent alias",
  async (context) => {
    const { root, store, vault } = await fixture(context);
    const alias = path.join(root, "parent-alias");
    const actual = path.join(root, "actual-parent");
    await fs.mkdir(actual, { mode: 0o700 });
    await fs.symlink(actual, alias);
    const throughParentAlias = new ThreadSecretsStore(alias);
    await throughParentAlias.prepare("chat", "[sec:alias-value]");
    expect((await throughParentAlias.list("chat")).secrets).toHaveLength(1);
    await fs.symlink(path.join(actual, "cafe-secrets"), vault);
    await expect(store.prepare("chat", "[sec:must-not-write]")).rejects.toThrow("unavailable");
  },
);

it.skipIf(process.platform === "win32")("rejects exposed vault permissions", async (context) => {
  const { store, filename } = await fixture(context);
  await store.prepare("chat", "[sec:private-value]");
  await fs.chmod(filename("chat"), 0o644);
  await expect(store.snapshot("chat")).rejects.toThrow("unavailable");
});
