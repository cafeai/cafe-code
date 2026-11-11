// @effect-diagnostics nodeBuiltinImport:off
// Exact fixture-owned private files qualify the native no-follow boundary.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { expect, it, type TestContext } from "vitest";
import { randomOpaque } from "@cafecode/relay/bytes";
import {
  createRelayPrivate,
  ensureRelayPrivateDirectory,
  readRelayPrivate,
} from "./privateFiles.ts";

async function fixture(test: TestContext) {
  let retired = false,
    root: string | undefined,
    removal: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const retire = () => {
    retired = true;
  };
  const cleanup = async () => {
    retire();
    await Promise.allSettled([...pending]);
    if (root) await (removal ??= fs.rm(root, { recursive: true, force: true }));
    test.signal.removeEventListener("abort", retire);
  };
  test.signal.addEventListener("abort", retire, { once: true });
  test.onTestFinished(cleanup);
  const own = async <A>(operation: () => Promise<A>) => {
    if (retired || test.signal.aborted) throw new Error("private-file-fixture-retired");
    const job = operation();
    pending.add(job);
    try {
      const result = await job;
      if (retired || test.signal.aborted) throw new Error("private-file-fixture-retired");
      return result;
    } finally {
      pending.delete(job);
    }
  };
  await own(async () => {
    const created = await fs.mkdtemp(path.join(tmpdir(), "cafe-relay-private-"));
    root = created;
    root = await fs.realpath(created);
  });
  return { root: root!, own };
}

it("creates stable private admission keys once and reads the exact held file", async (test) => {
  const f = await fixture(test),
    name = `host-admission-${randomOpaque()}.key` as const;
  await f.own(() => ensureRelayPrivateDirectory(f.root));
  expect(await f.own(() => readRelayPrivate(f.root, name, 128))).toBeUndefined();
  const bytes = new Uint8Array(32).fill(7);
  await f.own(() => createRelayPrivate(f.root, name, bytes));
  expect(await f.own(() => readRelayPrivate(f.root, name, 128))).toEqual(bytes);
  await expect(
    f.own(() => createRelayPrivate(f.root, name, new Uint8Array(32).fill(8))),
  ).rejects.toThrow();
  expect(await f.own(() => readRelayPrivate(f.root, name, 128))).toEqual(bytes);
  await expect(f.own(() => readRelayPrivate(f.root, name, 16))).rejects.toThrow();
});

it.skipIf(process.platform === "win32")(
  "refuses broad modes, hard links and substituted symlinks",
  async (test) => {
    const f = await fixture(test),
      name = `host-${randomOpaque()}.key` as const;
    await f.own(() => ensureRelayPrivateDirectory(f.root));
    const filename = path.join(f.root, "relay", name),
      linked = path.join(f.root, "extra-link");
    await f.own(() => createRelayPrivate(f.root, name, new Uint8Array(32).fill(1)));
    await f.own(() => fs.chmod(filename, 0o644));
    await expect(f.own(() => readRelayPrivate(f.root, name, 128))).rejects.toThrow();
    await f.own(() => fs.chmod(filename, 0o600));
    await f.own(() => fs.link(filename, linked));
    await expect(f.own(() => readRelayPrivate(f.root, name, 128))).rejects.toThrow();
    await f.own(() => fs.unlink(linked));
    await f.own(() => fs.rename(filename, linked));
    await f.own(() => fs.symlink(linked, filename));
    await expect(f.own(() => readRelayPrivate(f.root, name, 128))).rejects.toThrow();
  },
);
