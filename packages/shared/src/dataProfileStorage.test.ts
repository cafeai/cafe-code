// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as os from "node:os";
// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { DebugDataProfileError, prepareDebugDataProfile } from "./dataProfileStorage.ts";

describe("Debug storage admission", () => {
  let root: string;
  let activeOwner: { root: string; retire: () => void; settled: Promise<void> } | undefined;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cafe-profile-"));
  });
  afterEach(async () => {
    const owner = activeOwner;
    if (owner) {
      // onTestFinished runs after afterEach. Retire and join the exact body
      // here before its private directory can be removed or reused.
      owner.retire();
      await owner.settled;
      activeOwner = undefined;
    }
    await fs.rm(owner?.root ?? root, { recursive: true, force: true });
  });

  function runOwned(
    context: TestContext,
    body: (root: string, step: <T>(operation: () => Promise<T>) => Promise<T>) => Promise<void>,
  ): Promise<void> {
    const ownedRoot = root;
    let retired = context.signal.aborted;
    const retire = () => {
      retired = true;
    };
    const check = () => {
      if (retired || context.signal.aborted) throw new Error("Profile fixture retired");
    };
    const step = async <T>(operation: () => Promise<T>): Promise<T> => {
      check();
      try {
        const result = await operation();
        check();
        return result;
      } catch (error) {
        check();
        throw error;
      }
    };
    context.signal.addEventListener("abort", retire, { once: true });
    // Defer the body until ownership and both cleanup paths are registered.
    const work = Promise.resolve().then(() => {
      check();
      return body(ownedRoot, step);
    });
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    activeOwner = { root: ownedRoot, retire, settled };
    context.onTestFinished(async () => {
      retire();
      await settled;
      context.signal.removeEventListener("abort", retire);
    });
    return work;
  }

  it("retires an admitted filesystem operation before starting its next step", async (context) => {
    let release!: () => void;
    let enter!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    // A real timeout must release the synthetic hold before afterEach joins it.
    context.signal.addEventListener("abort", () => release(), { once: true });
    const work = runOwned(context, async (ownedRoot, step) => {
      await step(async () => {
        enter();
        await held;
      });
      await step(() => fs.writeFile(path.join(ownedRoot, "late"), "must not be written"));
    });
    try {
      await entered;
      const owner = activeOwner!;
      owner.retire();
      let joined = false;
      void owner.settled.then(() => {
        joined = true;
      });
      await Promise.resolve();
      expect(joined).toBe(false);
    } finally {
      release();
    }
    await expect(work).rejects.toThrow("Profile fixture retired");
    await expect(fs.stat(path.join(root, "late"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps real SQLite histories, WAL ownership and schema versions independent", async () => {
    await fs.mkdir(path.join(root, "userdata"));
    const production = new DatabaseSync(path.join(root, "userdata", "state.sqlite"));
    let debug: DatabaseSync | undefined;
    try {
      production.exec(
        "PRAGMA journal_mode=WAL; PRAGMA user_version=7; CREATE TABLE history(value TEXT); INSERT INTO history VALUES ('production');",
      );
      await prepareDebugDataProfile(root);
      debug = new DatabaseSync(path.join(root, ".debug", "userdata", "state.sqlite"));
      debug.exec(
        "PRAGMA journal_mode=WAL; PRAGMA user_version=9; CREATE TABLE history(value TEXT); INSERT INTO history VALUES ('debug');",
      );
      await prepareDebugDataProfile(root);
      expect(production.prepare("SELECT value FROM history").get()?.value).toBe("production");
      expect(debug.prepare("SELECT value FROM history").get()?.value).toBe("debug");
      expect(production.prepare("PRAGMA user_version").get()?.user_version).toBe(7);
      expect(debug.prepare("PRAGMA user_version").get()?.user_version).toBe(9);
      expect(await fs.stat(path.join(root, "userdata", "state.sqlite-wal"))).toBeDefined();
      expect(
        await fs.stat(path.join(root, ".debug", "userdata", "state.sqlite-wal")),
      ).toBeDefined();
    } finally {
      debug?.close();
      production.close();
    }
  });

  it("refuses a hard-linked production DB without changing either entry", async () => {
    await fs.mkdir(path.join(root, "userdata"));
    const original = path.join(root, "userdata", "state.sqlite");
    await fs.writeFile(original, "production sentinel");
    await prepareDebugDataProfile(root);
    const alias = path.join(root, ".debug", "userdata", "state.sqlite");
    await fs.link(original, alias);
    await expect(prepareDebugDataProfile(root)).rejects.toBeInstanceOf(DebugDataProfileError);
    expect(await fs.readFile(original, "utf8")).toBe("production sentinel");
    expect((await fs.stat(alias)).nlink).toBe(2);
  });

  it("refuses a Debug root alias without writing through it", async () => {
    const target = path.join(root, "production");
    await fs.mkdir(target);
    await fs.symlink(
      target,
      path.join(root, ".debug"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(prepareDebugDataProfile(root)).rejects.toBeInstanceOf(DebugDataProfileError);
    expect(await fs.readdir(target)).toEqual([]);
  });

  it("refuses a non-directory profile and retains its bytes with a fixed safe error", async () => {
    const entry = path.join(root, ".debug");
    await fs.writeFile(entry, "private sentinel");
    const error = await prepareDebugDataProfile(root).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DebugDataProfileError);
    expect(String(error)).not.toContain(root);
    expect(String(error)).not.toContain("private sentinel");
    expect(await fs.readFile(entry, "utf8")).toBe("private sentinel");
    await expect(fs.stat(path.join(root, "userdata"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports capacity failure without initializing any alternate profile", async () => {
    let attempts = 0;
    const filesystem = {
      ...fs,
      mkdir: async () => {
        attempts += 1;
        throw Object.assign(new Error("private received storage details"), { code: "ENOSPC" });
      },
    };
    await expect(prepareDebugDataProfile(root, filesystem)).rejects.toBeInstanceOf(
      DebugDataProfileError,
    );
    expect(attempts).toBe(1);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.for(["server-signing-key.bin", "provider-environment-fixture.bin"])(
    "refuses linked secret metadata without reading or changing the target: %s",
    (name, context) =>
      runOwned(context, async (root, step) => {
        const original = path.join(root, "production-secret");
        await step(() => fs.writeFile(original, "private sentinel", { mode: 0o600 }));
        await step(() => prepareDebugDataProfile(root));
        const linked = path.join(root, ".debug", "userdata", "secrets", name);
        await step(() => fs.link(original, linked));
        await expect(step(() => prepareDebugDataProfile(root))).rejects.toBeInstanceOf(
          DebugDataProfileError,
        );
        expect(await step(() => fs.readFile(original, "utf8"))).toBe("private sentinel");
        expect((await step(() => fs.stat(linked))).nlink).toBe(2);
      }),
  );

  it.for(["keybindings.json", "system-prompt.md", "tls/server-cert.pem"])(
    "refuses linked configuration before its consumer can read production bytes: %s",
    (name, context) =>
      runOwned(context, async (root, step) => {
        const original = path.join(root, "production-config");
        await step(() => fs.writeFile(original, "production sentinel", { mode: 0o600 }));
        await step(() => prepareDebugDataProfile(root));
        const linked = path.join(root, ".debug", "userdata", ...name.split("/"));
        await step(() => fs.link(original, linked));
        await expect(step(() => prepareDebugDataProfile(root))).rejects.toBeInstanceOf(
          DebugDataProfileError,
        );
        expect(await step(() => fs.readFile(original, "utf8"))).toBe("production sentinel");
        expect((await step(() => fs.stat(linked))).nlink).toBe(2);
      }),
  );
});
