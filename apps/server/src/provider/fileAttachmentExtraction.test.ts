// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractFileAttachmentText,
  FILE_EXTRACTION_MAX_TEXT_BYTES,
} from "./fileAttachmentExtraction.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function parserChild() {
  const events = new EventEmitter();
  return Object.assign(events, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => events.emit("close", null));
      return true;
    }),
  });
}

let child = parserChild();
beforeEach(() => {
  child = parserChild();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("isolated document parser boundary", () => {
  it("passes bytes only through stdin, with no credentials, shell or unlimited heap", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-only-credential");
    vi.stubEnv("NODE_OPTIONS", "--require=untrusted-hook");
    const result = extractFileAttachmentText("docx", Buffer.from("private uploaded bytes"));
    const args = vi.mocked(spawn).mock.calls[0]!;
    expect(args[0]).toBe(process.execPath);
    expect(args[1]).toContain("--max-old-space-size=256");
    expect(JSON.stringify(args)).not.toContain("private uploaded bytes");
    expect(JSON.stringify(args)).not.toContain("test-only-credential");
    expect(JSON.stringify(args)).not.toContain("untrusted-hook");
    expect(args[2]).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdout.write(JSON.stringify({ text: "bounded text", truncated: false }));
    child.emit("close", 0);
    expect(await result).toEqual({ text: "bounded text", truncated: false });
  });

  it("kills a stalled parser at the fixed deadline and reports an unavailable view", async () => {
    vi.useFakeTimers();
    const result = extractFileAttachmentText("docx", Buffer.from("input"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(await result).toBeUndefined();
  });

  it.each([
    "not JSON private parser output",
    JSON.stringify({ text: "x".repeat(FILE_EXTRACTION_MAX_TEXT_BYTES + 1), truncated: false }),
    JSON.stringify({ text: "text", truncated: "false" }),
  ])("rejects malformed or over-budget results without propagating them", async (output) => {
    const result = extractFileAttachmentText("docx", Buffer.from("input"));
    child.stdout.write(output);
    child.emit("close", 0);
    expect(await result).toBeUndefined();
  });

  it("terminates excessive stdout instead of buffering an unbounded parser result", async () => {
    const result = extractFileAttachmentText("docx", Buffer.from("input"));
    child.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(await result).toBeUndefined();
  });

  it("does not accept invalid PDF page accounting", async () => {
    const result = extractFileAttachmentText("pdf", Buffer.from("input"));
    child.stdout.write(
      JSON.stringify({
        text: "text",
        truncated: false,
        pagesRead: 201,
        totalPages: 201,
        hasText: true,
      }),
    );
    child.emit("close", 0);
    expect(await result).toBeUndefined();
  });

  it("does not treat parser errors or nonzero exits as extraction success", async () => {
    const result = extractFileAttachmentText("pdf", Buffer.from("input"));
    child.emit("error", new Error("private parser detail"));
    expect(await result).toBeUndefined();
    const failed = extractFileAttachmentText("docx", Buffer.from("input"));
    child.emit("close", 1);
    expect(await failed).toBeUndefined();
  });
});
