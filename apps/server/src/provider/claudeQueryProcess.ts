/**
 * Observe the exact process handle through the SDK's supported spawn hook.
 * Query.close() requests shutdown but is not an exit acknowledgement. Rewind
 * uses this separate promise; ordinary query controls retain their SDK owner.
 */
import { spawn } from "node:child_process";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export function makeClaudeQueryProcessObserver(stderr: Options["stderr"]) {
  let resolveExit!: () => void;
  let rejectExit!: (cause: unknown) => void;
  const exited = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  // A launch failure may precede any rewind request. Observe rejection now;
  // callers still receive the original failure when they await the promise.
  void exited.catch(() => undefined);
  let spawned = false;
  const spawnClaudeCodeProcess: NonNullable<Options["spawnClaudeCodeProcess"]> = ({
    command,
    args,
    cwd,
    env,
    signal,
  }) => {
    if (spawned) throw new Error("Claude query attempted to replace its bound process.");
    spawned = true;
    // Match the qualified SDK's default local spawn exactly. In
    // particular, retain its delayed/forwarded abort signal, shell-free
    // structured arguments, and native Windows no-console behavior.
    const child = spawn(command, args, {
      cwd,
      env,
      signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.once("exit", () => resolveExit());
    child.on("error", (cause) => {
      // AbortError from the SDK's forwarded grace signal is not exit.
      // Keep waiting for this same handle; only an unsuccessful spawn
      // with no process identity can reject the observation immediately.
      if (child.pid === undefined) rejectExit(cause);
    });
    // The custom-spawn contract assigns stderr handling to the host.
    // Keep the existing redacted Cafe callback, using stream decoding to
    // preserve UTF-8 split across chunks. Never retain another raw tail.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr?.(chunk));
    child.stderr.on("error", () => undefined);
    return child;
  };
  return { spawnClaudeCodeProcess, waitForExit: () => exited };
}

export function createObservedClaudeQuery(input: {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}) {
  const observer = makeClaudeQueryProcessObserver(input.options.stderr);
  const runtime = query({
    prompt: input.prompt,
    options: { ...input.options, spawnClaudeCodeProcess: observer.spawnClaudeCodeProcess },
  });
  return Object.assign(runtime, { waitForExit: observer.waitForExit });
}
