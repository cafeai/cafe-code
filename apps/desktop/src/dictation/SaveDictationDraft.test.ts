// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs";
// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { saveDictationDraft } from "./SaveDictationDraft.ts";

async function withPrivateTestDirectory(task: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cafe-dictation-save-"));
  try {
    await task(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("SaveDictationDraft", () => {
  it("leaves the directory untouched when the picker is cancelled or fails", async () => {
    await withPrivateTestDirectory(async (directory) => {
      const destination = join(directory, "draft.txt");
      const chooseCancelled = async () => ({ canceled: true, filePath: destination });
      assert.equal(
        await saveDictationDraft({
          text: "private words",
          chooseDestination: chooseCancelled,
          isCurrent: () => true,
        }),
        "cancelled",
      );
      assert.deepEqual(await readdir(directory), []);

      const chooseFailed = async (): Promise<never> => {
        throw new Error(`native picker failed at ${destination}`);
      };
      assert.equal(
        await saveDictationDraft({
          text: "private words",
          chooseDestination: chooseFailed,
          isCurrent: () => true,
        }),
        "failed",
      );
      assert.deepEqual(await readdir(directory), []);
    });
  });

  it("refuses a symlink destination without changing its target or leaving a temporary file", async () => {
    await withPrivateTestDirectory(async (directory) => {
      const original = join(directory, "original.txt");
      const destination = join(directory, "draft.txt");
      await writeFile(original, "unchanged", "utf8");
      try {
        await symlink(original, destination);
      } catch (error) {
        // Unprivileged Windows runners may not have symlink creation rights.
        // Preserve the full assertion on macOS/Linux and capable Windows hosts.
        if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")
          return;
        throw error;
      }

      assert.equal(
        await saveDictationDraft({
          text: "must not follow link",
          chooseDestination: async () => ({ canceled: false, filePath: destination }),
          isCurrent: () => true,
        }),
        "failed",
      );
      assert.equal(await readFile(original, "utf8"), "unchanged");
      assert.isTrue((await lstat(destination)).isSymbolicLink());
      assert.deepEqual((await readdir(directory)).sort(), ["draft.txt", "original.txt"]);
    });
  });

  it("atomically replaces an existing file with private UTF-8 text and removes its temporary sibling", async () => {
    await withPrivateTestDirectory(async (directory) => {
      const destination = join(directory, "draft.txt");
      await writeFile(destination, "previous draft", "utf8");
      let currentChecks = 0;
      const text = "こんにちは 🌸 café";
      assert.equal(
        await saveDictationDraft({
          text,
          chooseDestination: async () => ({ canceled: false, filePath: destination }),
          isCurrent: () => {
            currentChecks += 1;
            // The previous draft is still complete immediately before the
            // final rename; readers never see a partially written file.
            if (currentChecks === 2)
              assert.equal(readFileSync(destination, "utf8"), "previous draft");
            return true;
          },
        }),
        "saved",
      );
      assert.equal(currentChecks, 2);
      assert.equal(await readFile(destination, "utf8"), text);
      assert.deepEqual(await readdir(directory), ["draft.txt"]);
      if (process.platform !== "win32") assert.equal((await stat(destination)).mode & 0o777, 0o600);
    });
  });

  it("drops the pending file if the panel loses authority before the commit", async () => {
    await withPrivateTestDirectory(async (directory) => {
      const destination = join(directory, "draft.txt");
      let checks = 0;
      assert.equal(
        await saveDictationDraft({
          text: "never committed",
          chooseDestination: async () => ({ canceled: false, filePath: destination }),
          isCurrent: () => ++checks === 1,
        }),
        "cancelled",
      );
      assert.equal(checks, 2);
      assert.deepEqual(await readdir(directory), []);
    });
  });
});
