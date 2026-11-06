import {
  appendFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { followDesktopLogs } from "./follow-desktop-logs.mjs";

const fixtures = [];
afterEach(async () => {
  for (const dispose of fixtures.splice(0)) await dispose();
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(context) {
  const controller = new AbortController();
  const releases = [];
  let root;
  let running;
  let cleanup;
  let preparation;
  const dispose = () =>
    (cleanup ??= (async () => {
      controller.abort();
      for (const release of releases) release();
      await preparation?.catch(() => {});
      await running?.catch(() => {});
      if (root) await rm(root, { recursive: true, force: true });
    })());
  context.signal.addEventListener(
    "abort",
    () => {
      void dispose();
    },
    { once: true },
  );
  onTestFinished(dispose);
  fixtures.push(dispose);
  preparation = (async () => {
    root = await mkdtemp(join(tmpdir(), "cafe-source-log-follower-"));
    const stdoutPath = join(root, "stdout.log");
    const stderrPath = join(root, "stderr.log");
    await writeFile(stdoutPath, "", { mode: 0o600, flag: "wx" });
    await writeFile(stderrPath, "", { mode: 0o600, flag: "wx" });
    return {
      stdoutPath,
      stderrPath,
      stdoutIdentity: await lstat(stdoutPath, { bigint: true }),
      stderrIdentity: await lstat(stderrPath, { bigint: true }),
    };
  })();
  const { stdoutPath, stderrPath, stdoutIdentity, stderrIdentity } = await preparation;
  if (controller.signal.aborted) throw new Error("The log fixture retired during setup.");
  return {
    controller,
    root,
    stdoutPath,
    stderrPath,
    releases,
    start(stdout, stderr) {
      running = followDesktopLogs({
        stdoutPath,
        stderrPath,
        stdoutIdentity,
        stderrIdentity,
        stdout,
        stderr,
        signal: controller.signal,
      });
      void running.catch(() => {});
      return running;
    },
  };
}

function recorder() {
  const chunks = [];
  let target = deferred();
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      target.resolve();
      done();
    },
  });
  return {
    stream,
    bytes: () => Buffer.concat(chunks),
    next() {
      target = deferred();
      return target.promise;
    },
    written: () => target.promise,
  };
}

describe.skipIf(process.platform === "win32")("source desktop log follower", () => {
  it("streams startup and appended stdout/stderr byte for byte without replay or ending caller streams", async (context) => {
    const owned = await fixture(context);
    const out = recorder();
    const err = recorder();
    const initial = Buffer.from([0, 0xff, 0xe2, 0x98, 0x95, 10]);
    await writeFile(owned.stdoutPath, initial);
    await writeFile(owned.stderrPath, "initial error\n");
    const running = owned.start(out.stream, err.stream);
    await Promise.all([out.written(), err.written()]);
    const appended = Buffer.from("appended\r\n");
    const nextOut = out.next();
    const nextErr = err.next();
    await appendFile(owned.stdoutPath, appended);
    await appendFile(owned.stderrPath, "later error\n");
    await Promise.all([nextOut, nextErr]);
    owned.controller.abort();
    await running;
    expect(out.bytes()).toEqual(Buffer.concat([initial, appended]));
    expect(err.bytes().toString()).toBe("initial error\nlater error\n");
    expect(out.stream.writableEnded).toBe(false);
    expect(err.stream.writableEnded).toBe(false);
    expect(out.stream.listenerCount("error")).toBe(0);
    expect(err.stream.listenerCount("close")).toBe(0);
  });

  it("bounds chunks and holds cancellation until an admitted backpressured write completes", async (context) => {
    const owned = await fixture(context);
    const entered = deferred();
    let held;
    let writes = 0;
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, done) {
        expect(chunk.byteLength).toBeLessThanOrEqual(64 * 1024);
        writes += 1;
        held = done;
        entered.resolve();
      },
    });
    const release = () => {
      const done = held;
      held = undefined;
      done?.();
    };
    owned.releases.push(release);
    await writeFile(owned.stdoutPath, Buffer.alloc(4 * 64 * 1024, 97));
    const running = owned.start(output, recorder().stream);
    let completed = false;
    void running.then(() => {
      completed = true;
    });
    await entered.promise;
    owned.controller.abort();
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(writes).toBe(1);
    release();
    await running;
    expect(writes).toBe(1);
  });

  for (const kind of ["symlink", "hardlink", "directory", "public-file"])
    it(`refuses an unsafe ${kind} without emitting its content`, async (context) => {
      const owned = await fixture(context);
      const out = recorder();
      await rm(owned.stdoutPath);
      const other = join(owned.root, "other.log");
      await writeFile(other, "must stay private", { mode: 0o600 });
      if (kind === "symlink") await symlink(other, owned.stdoutPath);
      else if (kind === "hardlink") await link(other, owned.stdoutPath);
      else if (kind === "directory") await mkdir(owned.stdoutPath);
      else await writeFile(owned.stdoutPath, "must stay private", { mode: 0o644 });
      await expect(owned.start(out.stream, recorder().stream)).rejects.toThrow(
        "Could not follow this launch's desktop logs.",
      );
      expect(out.bytes().byteLength).toBe(0);
      expect(out.stream.listenerCount("error")).toBe(0);
    });

  it("refuses a replaced log inode instead of following unrelated output", async (context) => {
    const owned = await fixture(context);
    const out = recorder();
    await writeFile(owned.stdoutPath, "original\n");
    const running = owned.start(out.stream, recorder().stream);
    await out.written();
    await rename(owned.stdoutPath, join(owned.root, "retired.log"));
    await writeFile(owned.stdoutPath, "unrelated\n", { mode: 0o600, flag: "wx" });
    await expect(running).rejects.toThrow("Could not follow this launch's desktop logs.");
    expect(out.bytes().toString()).toBe("original\n");
  });

  it("continues from the start after the same owned file is truncated", async (context) => {
    const owned = await fixture(context);
    const out = recorder();
    await writeFile(owned.stdoutPath, "original longer output\n");
    const running = owned.start(out.stream, recorder().stream);
    await out.written();
    const next = out.next();
    await writeFile(owned.stdoutPath, "short\n");
    await next;
    owned.controller.abort();
    await running;
    expect(out.bytes().toString()).toBe("original longer output\nshort\n");
  });

  it("joins both readers on an output failure without exposing the native error", async (context) => {
    const owned = await fixture(context);
    await writeFile(owned.stdoutPath, "an output chunk\n");
    const output = new Writable({
      write(_chunk, _encoding, done) {
        done(new Error("opaque private failure"));
      },
    });
    const other = recorder();
    await expect(owned.start(output, other.stream)).rejects.toThrow(
      "Could not follow this launch's desktop logs.",
    );
    expect(other.stream.listenerCount("error")).toBe(0);
    expect(other.stream.writableEnded).toBe(false);
  });

  it("binds admission to the launch-created inode, even before the first read", async (context) => {
    const owned = await fixture(context);
    const out = recorder();
    await rename(owned.stdoutPath, join(owned.root, "original.log"));
    await writeFile(owned.stdoutPath, "foreign private log\n", { mode: 0o600, flag: "wx" });
    await expect(owned.start(out.stream, recorder().stream)).rejects.toThrow(
      "Could not follow this launch's desktop logs.",
    );
    expect(out.bytes().byteLength).toBe(0);
  });

  it("cancels idle polling and admits no files after prior retirement", async (context) => {
    const owned = await fixture(context);
    owned.controller.abort();
    await rm(owned.stdoutPath);
    const out = recorder();
    await owned.start(out.stream, recorder().stream);
    expect(out.bytes().byteLength).toBe(0);
    expect(out.stream.listenerCount("error")).toBe(0);
  });
});
