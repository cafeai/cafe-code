// @effect-diagnostics nodeBuiltinImport:off
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { createObservedClaudeQuery, makeClaudeQueryProcessObserver } from "./claudeQueryProcess.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn(() => ({})) }));

function childFixture(pid: number | undefined = 123) {
  return Object.assign(new EventEmitter(), {
    pid: pid as number | undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
}

describe("Claude exact query process observation", () => {
  it("preserves SDK launch arguments, environment, cwd, forwarded signal and hidden piped stdio", async () => {
    const child = childFixture();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
    const stderr: string[] = [];
    const prompt: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    };
    const options: Options = {
      cwd: "/synthetic workspace",
      permissionMode: "default",
      stderr: (text) => stderr.push(text),
    };
    const runtime = createObservedClaudeQuery({ prompt, options });
    const forwarded = vi.mocked(query).mock.calls.at(-1)![0];
    expect(forwarded.prompt).toBe(prompt);
    expect(forwarded.options?.permissionMode).toBe("default");
    const signal = new AbortController().signal;
    const env = { ONLY_SYNTHETIC: "literal" };
    const args = ["--resume=literal-id", "argument with spaces", "$(inert)"];
    const hook = forwarded.options!.spawnClaudeCodeProcess!;
    expect(hook({ command: "synthetic command", args, cwd: options.cwd!, env, signal })).toBe(
      child,
    );
    expect(spawn).toHaveBeenLastCalledWith("synthetic command", args, {
      cwd: options.cwd,
      env,
      signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.write(Buffer.from([0xe3, 0x81]));
    child.stderr.write(Buffer.from([0x82]));
    expect(stderr.join("")).toBe("あ");
    let exited = false;
    void runtime.waitForExit().then(() => {
      exited = true;
    });
    child.killed = true;
    child.emit("error", new Error("Synthetic forwarded AbortError"));
    await Promise.resolve();
    expect(exited).toBe(false);
    child.emit("exit", null, "SIGTERM");
    await runtime.waitForExit();
    expect(exited).toBe(true);
    expect(() => hook({ command: "replacement", args: [], env: {}, signal })).toThrow(
      "replace its bound process",
    );
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });

  it("reports spawn failure without treating process errors as exit proof", async () => {
    const child = childFixture();
    child.pid = undefined;
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
    const observer = makeClaudeQueryProcessObserver(undefined);
    observer.spawnClaudeCodeProcess({
      command: "absent synthetic command",
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const failure = new Error("Synthetic ENOENT");
    child.emit("error", failure);
    await expect(observer.waitForExit()).rejects.toBe(failure);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });
});
