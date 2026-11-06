// Native fixture owns actual private files, no-follow handles and host identity.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as os from "node:os";
// Native fixture retains exact host path and temporary-directory semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path";
import { describe, expect, it, vi, type TestContext } from "vitest";
import {
  GLIDE_CATALOGUE_MAX_BYTES,
  GlideCatalogueCapacityError,
  makeGlideCatalogueBudget,
} from "../glide/catalogueBudget.ts";
import { makeSessionMcpFiles, type SessionMcpFiles } from "./sessionFiles.ts";

// Native ESM namespace descriptors cannot be replaced by a scoped spy. Expose
// a mutable module facade while delegating every filesystem operation to the
// real implementation; only each test's exact failure/held-write boundary is
// temporarily observed below. No in-memory filesystem supplies our assertions.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

/** Retire before the first native acquisition and join admitted operations
 * before restoring filesystem mocks or removing their exact synthetic roots. */
async function withFiles(
  context: TestContext,
  body: (fixture: {
    readonly source: string;
    readonly roots: Set<string>;
    readonly ownRetire: (retire: () => void) => void;
    readonly ownRestore: (restore: () => void) => void;
    readonly run: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly create: (
      input?: Partial<Parameters<typeof makeSessionMcpFiles>[0]>,
    ) => Promise<SessionMcpFiles>;
  }) => Promise<void>,
) {
  let retired = false;
  let acquisition: Promise<string> | undefined;
  let cleanup: Promise<void> | undefined;
  const roots = new Set<string>();
  const files = new Set<SessionMcpFiles>();
  const pending = new Set<Promise<unknown>>();
  const retirements: (() => void)[] = [];
  const restores: (() => void)[] = [];
  const retire = () => {
    if (!retired) {
      retired = true;
      // Gates for exact admitted native operations must retire before joining
      // those operations, including when the enclosing test times out.
      for (const release of retirements) release();
    }
    cleanup ??= (async () => {
      await acquisition?.catch(() => undefined);
      await Promise.allSettled([...pending]);
      await Promise.allSettled([...files].map((owned) => owned.remove()));
      for (const restore of restores.reverse()) restore();
      // These paths are returned by this fixture's own mkdtemp/publication,
      // never provider homes or an arbitrary path from a failing native error.
      for (const root of roots) await fs.rm(root, { recursive: true, force: true });
    })();
    return cleanup;
  };
  const onAbort = () => {
    void retire().catch(() => undefined);
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  context.onTestFinished(async () => {
    context.signal.removeEventListener("abort", onAbort);
    await retire();
  });
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (retired) throw new Error("The private-file fixture has retired.");
    const work = operation();
    pending.add(work);
    try {
      const result = await work;
      if (retired) throw new Error("The private-file fixture has retired.");
      return result;
    } finally {
      pending.delete(work);
    }
  };
  try {
    if (context.signal.aborted) return;
    acquisition = fs.mkdtemp(path.join(os.tmpdir(), "cafe-session-files-fixture-")).then((root) => {
      roots.add(root);
      return root;
    });
    const root = await acquisition;
    if (retired) return;
    const source = path.join(root, "source.mjs");
    await run(() => fs.writeFile(source, "// Trusted inert bridge: λ🌸\n"));
    await body({
      source,
      roots,
      ownRetire: (release) => retirements.push(release),
      ownRestore: (restore) => restores.push(restore),
      run,
      create: (input = {}) =>
        run(async () => {
          const owned = await makeSessionMcpFiles({
            bridgeSource: source,
            port: 12345,
            token: "a".repeat(64),
            audience: "cafe-glide",
            ...input,
          });
          files.add(owned);
          roots.add(path.dirname(owned.bridgePath));
          return owned;
        }),
    });
  } finally {
    await retire();
  }
}

describe("private MCP catalogue file reservations", () => {
  it("charges exact UTF-8 files, bounds reserved rotation and releases only after native removal", async (context) => {
    await withFiles(context, async (f) => {
      const budget = makeGlideCatalogueBudget();
      let charged = 0;
      const release = vi.fn();
      const owned = await f.create({
        reserveBytes: (bytes) => {
          charged = bytes;
          const retire = budget.reserve(bytes);
          return () => {
            release();
            retire();
          };
        },
      });
      const sizes = await f.run(() =>
        Promise.all([fs.stat(owned.bridgePath), fs.stat(owned.connectionPath)]),
      );
      expect(charged).toBe(sizes[0].size + sizes[1].size);
      expect(release).not.toHaveBeenCalled();
      const remaining = budget.reserve(GLIDE_CATALOGUE_MAX_BYTES - charged);
      expect(() => budget.reserve(1)).toThrow(GlideCatalogueCapacityError);
      remaining();

      await f.run(() => owned.replaceToken("b".repeat(64)));
      const before = await f.run(() => fs.readFile(owned.connectionPath, "utf8"));
      await expect(f.run(() => owned.replaceToken("c".repeat(65)))).rejects.toThrow(
        "The private MCP session files are unavailable.",
      );
      expect(await f.run(() => fs.readFile(owned.connectionPath, "utf8"))).toBe(before);
      await f.run(() => Promise.all([owned.remove(), owned.remove()]));
      await f.run(() => owned.remove());
      expect(release).toHaveBeenCalledTimes(1);
      await expect(f.run(() => fs.lstat(path.dirname(owned.bridgePath)))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const full = budget.reserve(GLIDE_CATALOGUE_MAX_BYTES);
      full();

      // Management sessions do not opt into a fixed catalogue extent and keep
      // their existing variable-length and concurrently admitted renewals.
      const ordinary = await f.create();
      await f.run(() =>
        Promise.all([ordinary.replaceToken("d".repeat(65)), ordinary.replaceToken("e".repeat(66))]),
      );
      expect(
        JSON.parse(await f.run(() => fs.readFile(ordinary.connectionPath, "utf8"))).token,
      ).toBe("e".repeat(66));
    });
  });

  it("retains a charge across refused replacement cleanup and releases after the exact file returns", async (context) => {
    await withFiles(context, async (f) => {
      const release = vi.fn();
      const owned = await f.create({ reserveBytes: () => release });
      const saved = path.join(path.dirname(f.source), "saved-connection.json");
      await f.run(() => fs.rename(owned.connectionPath, saved));
      await f.run(() => fs.writeFile(owned.connectionPath, "foreign replacement"));
      await expect(f.run(() => owned.remove())).rejects.toThrow(
        "The private MCP session files are unavailable.",
      );
      expect(release).not.toHaveBeenCalled();
      expect(await f.run(() => fs.readFile(owned.connectionPath, "utf8"))).toBe(
        "foreign replacement",
      );
      await f.run(() => fs.unlink(owned.connectionPath));
      await f.run(() => fs.rename(saved, owned.connectionPath));
      await f.run(() => owned.remove());
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it("refuses a known oversized trusted source before reading or reserving private files", async (context) => {
    await withFiles(context, async (f) => {
      await f.run(() => fs.truncate(f.source, 4 * 1024 * 1024 + 1));
      const read = vi.spyOn(fs, "readFile");
      f.ownRestore(() => read.mockRestore());
      const allocate = vi.spyOn(fs, "mkdtemp");
      f.ownRestore(() => allocate.mockRestore());
      const reserve = vi.fn(() => () => undefined);
      await expect(f.create({ reserveBytes: reserve })).rejects.toThrow(
        "The private MCP session files are unavailable.",
      );
      expect(read).not.toHaveBeenCalled();
      expect(allocate).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
    });
  });

  it("drains admitted native token writes before removal and refuses later renewals", async (context) => {
    await withFiles(context, async (f) => {
      const release = vi.fn();
      const owned = await f.create({ reserveBytes: () => release });
      let releaseWrite!: () => void;
      const heldWrite = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      f.ownRetire(releaseWrite);
      let enteredWrite!: () => void;
      const writeEntered = new Promise<void>((resolve) => {
        enteredWrite = resolve;
      });
      const open = fs.open;
      let writes = 0;
      const heldNativeWrite = vi
        .spyOn(fs, "open")
        .mockImplementation(async (filePath, flags, mode) => {
          const handle = await open(filePath, flags, mode);
          if (
            typeof filePath === "string" &&
            path.dirname(filePath) === path.dirname(owned.connectionPath) &&
            path.basename(filePath).startsWith(".cafe-mcp-")
          ) {
            const writeFile = handle.writeFile.bind(handle);
            const hold = vi.spyOn(handle, "writeFile").mockImplementation(async (data, options) => {
              writes++;
              if (writes === 1) {
                // This is a real opened private replacement file. Hold only its
                // original native write, then execute it once after release.
                enteredWrite();
                await heldWrite;
              }
              await writeFile(data, options);
            });
            f.ownRestore(() => hold.mockRestore());
          }
          return handle;
        });
      f.ownRestore(() => heldNativeWrite.mockRestore());
      const first = f.run(() => owned.replaceToken("b".repeat(64)));
      void first.catch(() => undefined);
      await f.run(() => writeEntered);
      const second = f.run(() => owned.replaceToken("c".repeat(64)));
      void second.catch(() => undefined);
      const removal = f.run(() => owned.remove());
      void removal.catch(() => undefined);
      await expect(f.run(() => owned.replaceToken("d".repeat(64)))).rejects.toThrow(
        "The private MCP session files are unavailable.",
      );
      expect(writes).toBe(1);
      expect(release).not.toHaveBeenCalled();
      releaseWrite();
      await f.run(() => Promise.all([first, second, removal]));
      expect(writes).toBe(2);
      expect(release).toHaveBeenCalledTimes(1);
      await expect(f.run(() => fs.lstat(path.dirname(owned.bridgePath)))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(f.run(() => owned.replaceToken("e".repeat(64)))).rejects.toThrow(
        "The private MCP session files are unavailable.",
      );
    });
  });

  it.for([false, true])(
    "retains partial-publication charges exactly when cleanup is uncertain: %s",
    async (uncertain, context) => {
      await withFiles(context, async (f) => {
        const release = vi.fn();
        const open = fs.open;
        const unlink = fs.unlink;
        let partialRoot: string | undefined;
        const openFailure = vi.spyOn(fs, "open").mockImplementation((filePath, flags, mode) => {
          if (typeof filePath === "string" && path.basename(filePath) === "connection.json") {
            partialRoot = path.dirname(filePath);
            f.roots.add(partialRoot);
            return Promise.reject(new Error("Synthetic connection publication failure."));
          }
          return open(filePath, flags, mode);
        });
        f.ownRestore(() => openFailure.mockRestore());
        const cleanupFailure = vi.spyOn(fs, "unlink").mockImplementation((filePath) => {
          if (
            uncertain &&
            typeof filePath === "string" &&
            path.basename(filePath) === "bridge.mjs"
          ) {
            return Promise.reject(new Error("Synthetic exact-owner cleanup failure."));
          }
          return unlink(filePath);
        });
        f.ownRestore(() => cleanupFailure.mockRestore());
        await expect(f.create({ reserveBytes: () => release })).rejects.toThrow(
          "The private MCP session files are unavailable.",
        );
        expect(partialRoot).toBeDefined();
        expect(release).toHaveBeenCalledTimes(uncertain ? 0 : 1);
        if (uncertain) {
          expect(
            await f.run(() => fs.readFile(path.join(partialRoot!, "bridge.mjs"), "utf8")),
          ).toBe("// Trusted inert bridge: λ🌸\n");
        } else {
          await expect(f.run(() => fs.lstat(partialRoot!))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      });
    },
  );
});
