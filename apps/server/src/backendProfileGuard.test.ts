// @effect-diagnostics nodeBuiltinImport:off
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireBackendProfileGuard,
  type BackendProfileGuard,
  type BackendProfileGuardInput,
} from "./backendProfileGuard.ts";

const directories: string[] = [];
const guards: BackendProfileGuard[] = [];
const children: ChildProcess[] = [];
const peerPath = fileURLToPath(new URL("./testUtils/backendProfileGuardPeer.ts", import.meta.url));
const guardPath = (input: BackendProfileGuardInput) =>
  path.join(input.stateDir, "backend-ownership", "backend-role-v1.sqlite");
async function fixture(): Promise<BackendProfileGuardInput> {
  // Canonicalize the OS temp parent, not an application path. On macOS /var is
  // an OS alias and must not be confused with a user-supplied profile symlink.
  const configuredBaseDir = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "cafe-backend-guard-"),
  );
  directories.push(configuredBaseDir);
  await fs.mkdir(path.join(configuredBaseDir, "userdata"), { mode: 0o700 });
  await fs.mkdir(path.join(configuredBaseDir, ".debug", "userdata"), {
    recursive: true,
    mode: 0o700,
  });
  return {
    dataProfile: "production",
    configuredBaseDir,
    baseDir: configuredBaseDir,
    stateDir: path.join(configuredBaseDir, "userdata"),
  };
}
async function acquire(input: BackendProfileGuardInput) {
  const guard = await acquireBackendProfileGuard(input);
  guards.push(guard);
  return guard;
}
const exit = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()));
function nextMessage(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      cleanup();
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        typeof message.type !== "string"
      )
        reject(new Error("Malformed fixture receipt."));
      else resolve(message.type);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("Fixture exited before receipt."));
    };
    const onError = () => {
      cleanup();
      reject(new Error("Fixture child failed."));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
async function startPeer(input: BackendProfileGuardInput) {
  const child = spawn(process.execPath, [peerPath, input.configuredBaseDir!, input.dataProfile], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    // Do not inherit preload/instrumentation or provider selectors into this
    // exact Node-owned fixture. No shell, credentials or real profiles exist.
    env: { ...process.env, NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "1" },
  });
  children.push(child);
  const message = await nextMessage(child);
  return { child, message };
}
afterEach(async () => {
  // Close SQLite before any fixture directory cleanup or raw DB reads.
  for (const guard of guards.splice(0)) await guard.close();
  for (const child of children.splice(0)) {
    const exited = exit(child);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

describe("profiled backend OS-held ownership", () => {
  it("keeps same-profile peers excluded after refused in-process reentry and releases after actual child exit", async () => {
    const input = await fixture();
    const first = await startPeer(input);
    expect(first.message).toBe("held");
    const reentry = nextMessage(first.child);
    first.child.send("reenter");
    expect(await reentry).toBe("reentry-refused");
    const denied = await startPeer(input);
    expect(denied.message).toBe("refused");
    await exit(denied.child);
    const nativeExit = exit(first.child);
    first.child.kill("SIGKILL");
    await nativeExit;
    const replacement = await startPeer(input);
    expect(replacement.message).toBe("held");
    const replacementExit = exit(replacement.child);
    replacement.child.send("close");
    await replacementExit;
    const later = await startPeer(input);
    expect(later.message).toBe("held");
  });

  it("allows Production and Debug backend processes at the same configured parent without sharing locks", async () => {
    const input = await fixture();
    const debugRoot = path.join(input.baseDir, ".debug");
    const debug = {
      ...input,
      dataProfile: "debug" as const,
      baseDir: debugRoot,
      stateDir: path.join(debugRoot, "userdata"),
    };
    const productionPeer = await startPeer(input);
    const debugPeer = await startPeer(debug);
    expect(productionPeer.message).toBe("held");
    expect(debugPeer.message).toBe("held");
    expect((await startPeer(input)).message).toBe("refused");
    expect((await startPeer(debug)).message).toBe("refused");
  });

  it("reuses its finite persisted guard only after the previous handle closes", async () => {
    const input = await fixture();
    const first = await acquire(input);
    await expect(acquireBackendProfileGuard(input)).rejects.toThrow("already running");
    expect((await startPeer(input)).message).toBe("refused");
    const closeOne = first.close();
    const closeTwo = first.close();
    expect(closeTwo).toBe(closeOne);
    await Promise.all([closeOne, closeTwo]);
    const second = await acquire(input);
    expect((await startPeer(input)).message).toBe("refused");
    await second.close();
    expect((await fs.stat(guardPath(input))).size).toBeGreaterThan(0);
  });

  it("rejects inconsistent profile roots before creating a guard namespace", async () => {
    const input = await fixture();
    await expect(acquireBackendProfileGuard({ ...input, dataProfile: "debug" })).rejects.toThrow(
      "ownership could not be verified",
    );
    await expect(
      acquireBackendProfileGuard({ ...input, configuredBaseDir: undefined }),
    ).rejects.toThrow("ownership could not be verified");
    await expect(fs.lstat(path.dirname(guardPath(input)))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains exact opening scalars when the caller mutates its input during filesystem admission", async () => {
    const input = await fixture();
    const mutable = { ...input };
    const pending = acquireBackendProfileGuard(mutable);
    // The async function has reached its first filesystem await, but no
    // continuation can run before this synchronous caller mutation completes.
    const debugRoot = path.join(input.baseDir, ".debug");
    Object.assign(mutable, {
      dataProfile: "debug",
      baseDir: debugRoot,
      stateDir: path.join(debugRoot, "userdata"),
    });
    const held = await pending;
    guards.push(held);
    expect((await startPeer(input)).message).toBe("refused");
    expect(
      (
        await startPeer({
          ...input,
          dataProfile: "debug",
          baseDir: debugRoot,
          stateDir: path.join(debugRoot, "userdata"),
        })
      ).message,
    ).toBe("held");
    await held.close();
    const database = new DatabaseSync(guardPath(input), { readOnly: true });
    try {
      expect(database.prepare("SELECT profile FROM cafecode_backend_guard").get()?.profile).toBe(
        "production",
      );
    } finally {
      database.close();
    }
  });

  it("refuses accessor-based opening metadata without evaluating it or creating files", async () => {
    const input = await fixture();
    let reads = 0;
    const received = { ...input };
    Object.defineProperty(received, "dataProfile", {
      get() {
        reads += 1;
        return "production";
      },
    });
    await expect(acquireBackendProfileGuard(received)).rejects.toThrow(
      "ownership could not be verified",
    );
    expect(reads).toBe(0);
    await expect(fs.lstat(path.dirname(guardPath(input)))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves corrupt and foreign SQLite content rather than initializing or deleting it", async () => {
    const input = await fixture();
    await fs.mkdir(path.dirname(guardPath(input)), { mode: 0o700 });
    const bytes = Buffer.from("synthetic unknown ownership file; no credentials");
    await fs.writeFile(guardPath(input), bytes, { mode: 0o600 });
    await expect(acquireBackendProfileGuard(input)).rejects.toThrow(
      "ownership could not be verified",
    );
    expect(await fs.readFile(guardPath(input))).toEqual(bytes);
    await fs.unlink(guardPath(input));
    const foreign = new DatabaseSync(guardPath(input));
    foreign.exec(
      "CREATE TABLE unrelated_content (value TEXT); INSERT INTO unrelated_content VALUES ('preserve');",
    );
    foreign.close();
    if (process.platform !== "win32") await fs.chmod(guardPath(input), 0o600);
    const original = await fs.readFile(guardPath(input));
    await expect(acquireBackendProfileGuard(input)).rejects.toThrow(
      "ownership could not be verified",
    );
    expect(await fs.readFile(guardPath(input))).toEqual(original);
  });

  it("refuses a cleanly closed foreign WAL database without creating or deleting sidecars", async () => {
    const input = await fixture();
    const directory = path.dirname(guardPath(input));
    await fs.mkdir(directory, { mode: 0o700 });
    const foreign = new DatabaseSync(guardPath(input));
    foreign.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE unrelated_content (value TEXT); INSERT INTO unrelated_content VALUES ('preserve');",
    );
    foreign.close();
    if (process.platform !== "win32") await fs.chmod(guardPath(input), 0o600);
    const bytes = await fs.readFile(guardPath(input));
    expect(bytes[18]).toBe(2);
    expect(bytes[19]).toBe(2);
    const entries = await fs.readdir(directory);
    expect(entries).toEqual(["backend-role-v1.sqlite"]);
    await expect(acquireBackendProfileGuard(input)).rejects.toThrow(
      "ownership could not be verified",
    );
    expect(await fs.readFile(guardPath(input))).toEqual(bytes);
    expect(await fs.readdir(directory)).toEqual(entries);
  });

  it.each([
    "magic",
    "write-format",
    "read-format",
    "application-id",
    "user-version",
    "truncated",
  ] as const)(
    "preserves a guard with a corrupted %s header before handing it to SQLite",
    async (phase) => {
      const input = await fixture();
      const initial = await acquire(input);
      await initial.close();
      let bytes = await fs.readFile(guardPath(input));
      if (phase === "magic") bytes[0] = 0;
      else if (phase === "write-format") bytes[18] = 2;
      else if (phase === "read-format") bytes[19] = 2;
      else if (phase === "application-id") bytes.writeUInt32BE(0, 68);
      else if (phase === "user-version") bytes.writeUInt32BE(2, 60);
      else bytes = bytes.subarray(0, 80);
      await fs.writeFile(guardPath(input), bytes);
      const entries = await fs.readdir(path.dirname(guardPath(input)));
      await expect(acquireBackendProfileGuard(input)).rejects.toThrow(
        "ownership could not be verified",
      );
      expect(await fs.readFile(guardPath(input))).toEqual(bytes);
      expect(await fs.readdir(path.dirname(guardPath(input)))).toEqual(entries);
    },
  );

  it("refuses a copied guard whose profile/root binding belongs to a different data root", async () => {
    const input = await fixture();
    const first = await acquire(input);
    await first.close();
    const target = await fixture();
    await fs.mkdir(path.dirname(guardPath(target)), { mode: 0o700 });
    await fs.copyFile(guardPath(input), guardPath(target));
    if (process.platform !== "win32") await fs.chmod(guardPath(target), 0o600);
    const before = await fs.readFile(guardPath(target));
    await expect(acquireBackendProfileGuard(target)).rejects.toThrow(
      "ownership could not be verified",
    );
    expect(await fs.readFile(guardPath(target))).toEqual(before);
  });

  it("refuses hard-linked guard files without opening or changing their original bytes", async () => {
    const input = await fixture();
    await fs.mkdir(path.dirname(guardPath(input)), { mode: 0o700 });
    const originalPath = path.join(input.baseDir, "synthetic-original");
    const bytes = Buffer.from("test-owned original");
    await fs.writeFile(originalPath, bytes, { mode: 0o600 });
    await fs.link(originalPath, guardPath(input));
    await expect(acquireBackendProfileGuard(input)).rejects.toThrow(
      "ownership could not be verified",
    );
    expect(await fs.readFile(originalPath)).toEqual(bytes);
    expect(await fs.readFile(guardPath(input))).toEqual(bytes);
  });

  it("refuses an aliased ownership directory without touching the target", async () => {
    const input = await fixture();
    const target = path.join(input.baseDir, "synthetic-other");
    await fs.mkdir(target, { mode: 0o700 });
    // Directory junctions do not require symlink privileges on Windows and
    // must be refused there just as ordinary symlink parents are on POSIX.
    await fs.symlink(
      target,
      path.dirname(guardPath(input)),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(acquireBackendProfileGuard(input)).rejects.toThrow(
      "ownership could not be verified",
    );
    expect(await fs.readdir(target)).toEqual([]);
  });

  it("refuses a foreign journal alias before SQLite can recover or remove it", async () => {
    const input = await fixture();
    const initial = await acquire(input);
    await initial.close();
    const target = path.join(input.baseDir, "synthetic-journal");
    const bytes = Buffer.from("retain unrelated sidecar target");
    await fs.writeFile(target, bytes, { mode: 0o600 });
    await fs.link(target, `${guardPath(input)}-journal`);
    await expect(acquireBackendProfileGuard(input)).rejects.toThrow(
      "ownership could not be verified",
    );
    expect(await fs.readFile(target)).toEqual(bytes);
    expect(await fs.readFile(`${guardPath(input)}-journal`)).toEqual(bytes);
  });

  it.each(["-journal", "-wal", "-shm"])(
    "preserves even a private regular %s sidecar instead of attempting native recovery",
    async (suffix) => {
      const input = await fixture();
      const initial = await acquire(input);
      await initial.close();
      const guardBytes = await fs.readFile(guardPath(input));
      const bytes = Buffer.from("unverified interrupted initialization or foreign sidecar");
      await fs.writeFile(`${guardPath(input)}${suffix}`, bytes, { mode: 0o600 });
      await expect(acquireBackendProfileGuard(input)).rejects.toThrow(
        "ownership could not be verified",
      );
      expect(await fs.readFile(guardPath(input))).toEqual(guardBytes);
      expect(await fs.readFile(`${guardPath(input)}${suffix}`)).toEqual(bytes);
    },
  );
});
