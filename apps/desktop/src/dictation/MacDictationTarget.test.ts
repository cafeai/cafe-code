import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { assert, describe, it } from "@effect/vitest";
import { vi } from "vitest";

import { createMacDictationTargetClient } from "./MacDictationTarget.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  if (process.platform !== "win32") return actual;
  return {
    ...actual,
    lstatSync: vi.fn((...args: Parameters<typeof actual.lstatSync>) => {
      const metadata = actual.lstatSync(...args);
      // Protocol tests replace the child with in-memory streams, but still
      // pass admission through the real Node executable's metadata. Windows
      // lacks POSIX execute bits: model them only for that exact fixture.
      // Preserve file type, symlink status, other paths/options and errors so
      // this test accommodation cannot turn a rejected helper into a valid one.
      if (args[0] === process.execPath && typeof metadata?.mode === "number") {
        metadata.mode |= 0o111;
      }
      return metadata;
    }),
  };
});

const validToken = "a".repeat(64);
const successfulCapture = { ok: true, token: validToken, insertionMethod: "accessibility" };

type Request = {
  readonly id: number;
  readonly command: string;
  readonly token?: string;
  readonly text?: string;
};

function fakeHelper(onRequest: (request: Request, reply: (value: object) => void) => void) {
  const input = new PassThrough();
  const output = new PassThrough();
  const events = new EventEmitter();
  const requests: Request[] = [];
  let killed = false;
  let inputBuffer = "";
  const reply = (value: object) => output.write(`${JSON.stringify(value)}\n`);
  input.on("data", (chunk: Buffer) => {
    inputBuffer += chunk.toString("utf8");
    let end: number;
    while ((end = inputBuffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(inputBuffer.slice(0, end)) as Request;
      inputBuffer = inputBuffer.slice(end + 1);
      requests.push(request);
      onRequest(request, reply);
    }
  });
  const child = Object.assign(events, {
    stdin: input,
    stdout: output,
    kill: () => {
      killed = true;
      return true;
    },
  }) as unknown as ChildProcess;
  return {
    child,
    requests,
    reply,
    get killed() {
      return killed;
    },
  };
}

describe("MacDictationTarget", () => {
  it.each(["missing", "directory", "non-executable"] as const)(
    "rejects a %s path outside the protocol executable fixture before spawning",
    async (kind) => {
      const directory = mkdtempSync(join(tmpdir(), "cafe-dictation-admission-"));
      const executablePath = kind === "directory" ? directory : join(directory, "helper");
      const helper = fakeHelper((request, reply) => {
        reply({ id: request.id, ...successfulCapture });
      });
      const spawnChild = vi.fn(() => helper.child);
      const client = createMacDictationTargetClient({ executablePath, spawnChild });
      try {
        if (kind === "non-executable") {
          writeFileSync(executablePath, "synthetic non-executable fixture", { mode: 0o600 });
        }
        assert.deepEqual(await client.capture(), {
          ok: false,
          reason: "helper_unavailable",
          uncertain: false,
        });
        assert.equal(spawnChild.mock.calls.length, 0);
        assert.equal(helper.requests.length, 0);
      } finally {
        client.dispose();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("keeps the opaque target token inside desktop main and sends draft only over stdin", async () => {
    const helper = fakeHelper((request, reply) => {
      if (request.command === "capture") {
        reply({ id: request.id, ...successfulCapture });
      } else {
        reply({ id: request.id, ok: true });
      }
    });
    const client = createMacDictationTargetClient({
      executablePath: process.execPath,
      spawnChild: () => helper.child,
    });

    assert.deepEqual(await client.capture(), { ok: true, insertionMethod: "accessibility" });
    assert.deepEqual(await client.insert("private dictated draft"), { ok: true });
    assert.deepEqual(
      helper.requests.map((request) => request.command),
      ["capture", "insert"],
    );
    assert.equal(helper.requests[1]?.token, validToken);
    assert.equal(helper.requests[1]?.text, "private dictated draft");
    assert.notInclude(
      JSON.stringify(await client.insert("do not replay")),
      "private dictated draft",
    );
    assert.equal(helper.requests.length, 2);
    client.dispose();
    assert.isTrue(helper.killed);
  });

  it("returns a stable target-changed failure without replaying insertion", async () => {
    const helper = fakeHelper((request, reply) => {
      reply(
        request.command === "capture"
          ? { id: request.id, ...successfulCapture }
          : { id: request.id, ok: false, code: "target_changed", uncertain: false },
      );
    });
    const client = createMacDictationTargetClient({
      executablePath: process.execPath,
      spawnChild: () => helper.child,
    });

    await client.capture();
    assert.deepEqual(await client.insert("text"), {
      ok: false,
      reason: "target_changed",
      uncertain: false,
    });
    assert.deepEqual(await client.insert("text"), {
      ok: false,
      reason: "target_unavailable",
      uncertain: false,
    });
    assert.equal(helper.requests.filter((request) => request.command === "insert").length, 1);
    client.dispose();
  });

  it("treats an insert timeout as uncertain, kills the helper, and never retries", async () => {
    const helper = fakeHelper((request, reply) => {
      if (request.command === "capture") reply({ id: request.id, ...successfulCapture });
    });
    const client = createMacDictationTargetClient({
      executablePath: process.execPath,
      spawnChild: () => helper.child,
      requestTimeoutMs: 100,
    });

    await client.capture();
    assert.deepEqual(await client.insert("private text"), {
      ok: false,
      reason: "insertion_uncertain",
      uncertain: true,
    });
    assert.isTrue(helper.killed);
    assert.deepEqual(await client.insert("private text"), {
      ok: false,
      reason: "target_unavailable",
      uncertain: false,
    });
    assert.equal(helper.requests.filter((request) => request.command === "insert").length, 1);
    client.dispose();
  });

  it("refuses empty, NUL, and oversized drafts before any helper write", async () => {
    const helper = fakeHelper((request, reply) => {
      if (request.command === "capture") reply({ id: request.id, ...successfulCapture });
    });
    const client = createMacDictationTargetClient({
      executablePath: process.execPath,
      spawnChild: () => helper.child,
    });

    await client.capture();
    for (const text of ["", "a\0b", "a".repeat(256 * 1024 + 1)]) {
      assert.deepEqual(await client.insert(text), {
        ok: false,
        reason: "invalid_text",
        uncertain: false,
      });
    }
    assert.equal(helper.requests.length, 1);
    client.dispose();
  });

  it("discards a capture invalidated while the helper was answering", async () => {
    let answerCapture: ((value: object) => void) | undefined;
    const helper = fakeHelper((request, reply) => {
      if (request.command === "capture") {
        answerCapture = (value) => reply({ id: request.id, ...value });
      } else {
        reply({ id: request.id, ok: true });
      }
    });
    const client = createMacDictationTargetClient({
      executablePath: process.execPath,
      spawnChild: () => helper.child,
    });

    const capturing = client.capture();
    // Wait for the serial operation to reach the helper before invalidating it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const discarding = client.discard();
    answerCapture?.(successfulCapture);
    assert.deepEqual(await capturing, {
      ok: false,
      reason: "target_unavailable",
      uncertain: false,
    });
    await discarding;
    assert.deepEqual(
      helper.requests.map((request) => request.command),
      ["capture", "discard"],
    );
    assert.deepEqual(await client.insert("text"), {
      ok: false,
      reason: "target_unavailable",
      uncertain: false,
    });
    client.dispose();
  });

  it("rejects unexpected helper responses without exposing their payload", async () => {
    const helper = fakeHelper((request, reply) => {
      reply({ id: request.id, ok: false, code: "private app name / secret", uncertain: false });
    });
    const client = createMacDictationTargetClient({
      executablePath: process.execPath,
      spawnChild: () => helper.child,
    });

    const result = await client.capture();
    assert.deepEqual(result, {
      ok: false,
      reason: "helper_protocol_error",
      uncertain: false,
    });
    assert.notInclude(JSON.stringify(result), "private app name");
    assert.isTrue(helper.killed);
    client.dispose();
  });

  it("reports the native-selected paste method without exposing a generic paste command", async () => {
    const helper = fakeHelper((request, reply) => {
      reply(
        request.command === "capture"
          ? { id: request.id, ...successfulCapture, insertionMethod: "paste" }
          : { id: request.id, ok: true },
      );
    });
    const client = createMacDictationTargetClient({
      executablePath: process.execPath,
      spawnChild: () => helper.child,
    });
    assert.deepEqual(await client.capture(), { ok: true, insertionMethod: "paste" });
    assert.deepEqual(await client.insert("synthetic draft"), { ok: true });
    assert.deepEqual(helper.requests[1], {
      id: 2,
      command: "insert",
      token: validToken,
      text: "synthetic draft",
    });
    client.dispose();
  });

  it("requires a valid insertion method on native capture responses", async () => {
    for (const insertionMethod of [undefined, "keys", {}, null]) {
      const helper = fakeHelper((request, reply) => {
        reply({ id: request.id, ...successfulCapture, insertionMethod });
      });
      const client = createMacDictationTargetClient({
        executablePath: process.execPath,
        spawnChild: () => helper.child,
      });
      assert.deepEqual(await client.capture(), {
        ok: false,
        reason: "helper_protocol_error",
        uncertain: false,
      });
      assert.isTrue(helper.killed);
      assert.deepEqual(await client.insert("must not dispatch"), {
        ok: false,
        reason: "target_unavailable",
        uncertain: false,
      });
      assert.equal(helper.requests.length, 1);
      client.dispose();
    }
  });

  it("keeps clipboard admission failure definitive and consumes its capture", async () => {
    const helper = fakeHelper((request, reply) => {
      reply(
        request.command === "capture"
          ? { id: request.id, ...successfulCapture, insertionMethod: "paste" }
          : { id: request.id, ok: false, code: "clipboard_unavailable", uncertain: false },
      );
    });
    const client = createMacDictationTargetClient({
      executablePath: process.execPath,
      spawnChild: () => helper.child,
    });
    await client.capture();
    assert.deepEqual(await client.insert("synthetic draft"), {
      ok: false,
      reason: "clipboard_unavailable",
      uncertain: false,
    });
    assert.deepEqual(await client.insert("synthetic draft"), {
      ok: false,
      reason: "target_unavailable",
      uncertain: false,
    });
    assert.equal(helper.requests.length, 2);
    client.dispose();
  });

  it("rejects an insertion response that tries to redefine the captured method", async () => {
    const helper = fakeHelper((request, reply) => {
      reply(
        request.command === "capture"
          ? { id: request.id, ...successfulCapture }
          : { id: request.id, ok: true, insertionMethod: "paste" },
      );
    });
    const client = createMacDictationTargetClient({
      executablePath: process.execPath,
      spawnChild: () => helper.child,
    });
    await client.capture();
    assert.deepEqual(await client.insert("synthetic draft"), {
      ok: false,
      reason: "helper_protocol_error",
      uncertain: true,
    });
    assert.isTrue(helper.killed);
    client.dispose();
  });
});
