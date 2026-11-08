#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

if (process.platform !== "darwin")
  throw new Error("Native closed-lid qualification requires macOS.");
if (process.argv.length > 3 || (process.argv[2] !== undefined && process.argv[2] !== "--live"))
  throw new Error("Use only the exact optional --live argument.");
const live = process.argv[2] === "--live";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "cafe-keep-awake-qualification-"));
const executable = join(directory, "qualified-helper");
const compiled = spawnSync(
  "xcrun",
  [
    "swiftc",
    "-D",
    "KEEP_AWAKE_TEST",
    "-O",
    join(desktop, "native/mac-keep-awake.swift"),
    "-o",
    executable,
  ],
  { shell: false, stdio: "inherit", timeout: 300_000 },
);
if (compiled.error || compiled.status !== 0) {
  await rm(directory, { recursive: true, force: true });
  throw new Error("Native qualification build failed.");
}
const owners = new WeakMap();
function scope(t) {
  let owner = owners.get(t);
  if (owner) return owner;
  owner = { retired: false, children: [], paths: [] };
  owners.set(t, owner);
  // Retirement and completion are registered before any native acquisition.
  t.signal.addEventListener(
    "abort",
    () => {
      owner.retired = true;
      for (const child of owner.children) child.retire();
    },
    { once: true },
  );
  t.after(async () => {
    owner.retired = true;
    for (const child of owner.children) child.retire();
    for (const child of owner.children) await child.done;
    for (const path of owner.paths) await rm(path, { recursive: true, force: true });
  });
  return owner;
}
async function mockDirectory(t) {
  const owner = scope(t);
  const path = join(directory, `case-${owner.paths.length}-${crypto.randomUUID()}`);
  owner.paths.push(path);
  await mkdir(path, { mode: 0o700 });
  if (owner.retired) throw new Error("Native fixture retired");
  return path;
}
function launch(t, args = [], heartbeat = false) {
  const owner = scope(t);
  if (owner.retired) throw new Error("Native fixture retired");
  let retire = () => {};
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  owner.children.push({ retire: () => retire(), done });
  const child = spawn(executable, args, { shell: false, stdio: ["pipe", "pipe", "ignore"] });
  const events = [];
  const notices = new EventEmitter();
  let buffer = "";
  let closed = false;
  let heartbeatTimer;
  let killTimer;
  const send = (command) => {
    if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ command }) + "\n");
  };
  const stopPings = () => clearInterval(heartbeatTimer);
  retire = () => {
    stopPings();
    if (closed) return;
    child.stdin.end();
    child.kill("SIGCONT");
    killTimer ??= setTimeout(() => {
      if (!closed) child.kill("SIGKILL");
    }, 2500);
  };
  child.stdin.on("error", () => {});
  child.once("error", () => {
    retire();
  });
  child.once("close", (code, signal) => {
    closed = true;
    stopPings();
    clearTimeout(killTimer);
    notices.emit("change");
    resolveDone({ code, signal });
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 4096) {
      retire();
      return;
    }
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const row = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      events.push(JSON.parse(row));
      notices.emit("change");
    }
  });
  const event = async (name) => {
    const expected = Array.isArray(name) ? name : [name];
    for (;;) {
      const found = events.find((value) => expected.includes(value.event));
      if (found) return found;
      if (closed) throw new Error(`Native owner closed before ${name}`);
      await once(notices, "change", {
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(12000)]),
      });
    }
  };
  if (heartbeat) {
    send("renew");
    heartbeatTimer = setInterval(() => send("renew"), 500);
  }
  return { child, send, event, done, retire, stopPings, events };
}
async function workerObserver(t, worker) {
  const observer = launch(t, [
    "--observe",
    String(worker.pid),
    String(worker.seconds),
    String(worker.micros),
  ]);
  await observer.event("observing");
  return observer;
}
const state = (path) => readFile(join(path, "power-state"), "utf8");

try {
  if (!live) {
    for (const action of [
      "stop",
      "parent-heartbeat-loss",
      "crash-worker",
      "freeze-worker",
      "malformed",
    ]) {
      await test(`native lease cleanup: ${action}`, { timeout: 18000 }, async (t) => {
        const path = await mockDirectory(t);
        const instance = launch(t, ["--mock-root", path], true);
        await instance.event("active");
        assert.equal(await state(path), "1");
        if (action === "stop") instance.retire();
        else if (action === "parent-heartbeat-loss") instance.stopPings();
        else if (action === "malformed") instance.child.stdin.write("x".repeat(300));
        else instance.send(action);
        assert.equal((await instance.event("stopped")).resetAccepted, true);
        await instance.done;
        assert.equal(await state(path), "0");
      });
    }
    for (const signal of ["SIGKILL", "SIGSTOP"]) {
      await test(
        `surviving worker retires a watchdog after ${signal}`,
        { timeout: 18000 },
        async (t) => {
          const path = await mockDirectory(t);
          const instance = launch(t, ["--mock-root", path], true);
          const worker = await instance.event("test-worker");
          await instance.event("active");
          const observer = await workerObserver(t, worker);
          instance.child.kill(signal);
          await observer.event("retired");
          await observer.done;
          assert.equal(await state(path), "0");
          if (signal === "SIGSTOP") instance.child.kill("SIGCONT");
          await instance.done;
          const next = launch(t, ["--mock-root", path], true);
          await next.event("active");
          next.retire();
          await next.done;
          assert.equal(await state(path), "0");
        },
      );
    }
    await test(
      "simultaneous native requests cannot claim another owner's flock",
      { timeout: 18000 },
      async (t) => {
        const path = await mockDirectory(t);
        const first = launch(t, ["--mock-root", path], true);
        await first.event("active");
        const other = launch(t, ["--mock-root", path], true);
        assert.equal((await other.event("paused")).reason, "lease-busy");
        await other.done;
        assert.equal(await state(path), "1");
        first.retire();
        await first.done;
        assert.equal(await state(path), "0");
      },
    );
    await test(
      "unsafe native lock symlinks are refused before any power mutation",
      { timeout: 18000 },
      async (t) => {
        const path = await mockDirectory(t);
        const target = join(path, "untouched");
        await writeFile(target, "unchanged", { mode: 0o600 });
        await symlink(target, join(path, "lease.lock"));
        const instance = launch(t, ["--mock-root", path], true);
        assert.equal((await instance.event("paused")).reason, "native-refused");
        await instance.done;
        assert.equal(await readFile(target, "utf8"), "unchanged");
      },
    );
  } else {
    await test(
      "real idle assertion renews beyond its OS timeout and retires without a display assertion",
      { timeout: 25000 },
      async (t) => {
        const before = launch(t, ["--inspect"]);
        const baseline = await before.event("inspection");
        await before.done;
        // The global lid switch cannot be isolated from an active user's
        // Cafe session. Never stop it or use a second lock namespace just to
        // qualify our test. This is an explicit opt-in resource precondition;
        // the isolated fault tests still assert exclusive ownership normally.
        if (baseline.count > 0) {
          t.skip("An active Cafe closed-lid session owns the shared native power state.");
          return;
        }
        assert.equal(baseline.count, 0);
        const instance = launch(t, [], true);
        const opening = await instance.event(["ready", "paused"]);
        if (opening.event === "paused" && opening.reason === "lease-busy") {
          await instance.done;
          t.skip("Another Cafe session acquired the native power lease before live admission.");
          return;
        }
        await instance.event("active");
        // Controlled passage beyond the eight-second OS deadline proves actual
        // renewal; this is not a retry, provider probe or altered production cap.
        await new Promise((resolve) => setTimeout(resolve, 9500));
        const during = launch(t, ["--inspect"]);
        const active = await during.event("inspection");
        await during.done;
        assert.equal(active.count, 1);
        assert.equal(active.displayCount, 0);
        instance.retire();
        assert.equal((await instance.event("stopped")).resetAccepted, true);
        await instance.done;
        const after = launch(t, ["--inspect"]);
        assert.equal((await after.event("inspection")).count, 0);
        await after.done;
      },
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
