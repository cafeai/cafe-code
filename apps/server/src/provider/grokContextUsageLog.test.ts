// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { readGrokLastCallUsageFromUnifiedLog } from "./grokContextUsageLog.ts";

function logRecord(input: {
  readonly pid: number;
  readonly sessionId: string;
  readonly message: string;
  readonly ctx: Record<string, unknown>;
}) {
  return JSON.stringify({
    ver: 1,
    lvl: "info",
    src: "shell",
    ts: "2026-08-17T02:01:56.819Z",
    pid: input.pid,
    sid: input.sessionId,
    msg: input.message,
    ctx: input.ctx,
  });
}

it("reads only the final inference counters for the exact Grok session and prompt", async () => {
  const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-usage-log-"));
  const logPath = NodePath.join(tempDir, "unified.jsonl");
  const lines = [
    logRecord({
      pid: 10,
      sessionId: "target-session",
      message: "shell.turn.inference_done",
      ctx: {
        prompt_tokens: 111_118,
        cached_prompt_tokens: 110_080,
        completion_tokens: 679,
        reasoning_tokens: 149,
      },
    }),
    logRecord({
      pid: 10,
      sessionId: "target-session",
      message: "shell.handle_prompt.done",
      ctx: { prompt_id: "target-prompt", ok: true },
    }),
    logRecord({
      pid: 20,
      sessionId: "other-session",
      message: "shell.turn.inference_done",
      ctx: { prompt_tokens: 900_000, completion_tokens: 100_000 },
    }),
    logRecord({
      pid: 20,
      sessionId: "other-session",
      message: "shell.handle_prompt.done",
      ctx: { prompt_id: "target-prompt", ok: true },
    }),
  ];
  await NodeFSP.writeFile(logPath, `${lines.join("\n")}\n`, "utf8");

  const usage = await readGrokLastCallUsageFromUnifiedLog({
    logPath,
    sessionId: "target-session",
    promptId: "target-prompt",
  });

  assert.deepEqual(usage, {
    totalTokens: 111_797,
    inputTokens: 111_118,
    outputTokens: 679,
    cachedInputTokens: 110_080,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 149,
  });
});

it("rejects a symlinked Grok unified log", async () => {
  const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-usage-symlink-"));
  const realPath = NodePath.join(tempDir, "real.jsonl");
  const linkedPath = NodePath.join(tempDir, "unified.jsonl");
  await NodeFSP.writeFile(
    realPath,
    `${logRecord({
      pid: 10,
      sessionId: "target-session",
      message: "shell.handle_prompt.done",
      ctx: { prompt_id: "target-prompt", ok: true },
    })}\n`,
    "utf8",
  );
  try {
    await NodeFSP.symlink(realPath, linkedPath, "file");
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "EPERM"
    ) {
      return;
    }
    throw error;
  }

  assert.isNull(
    await readGrokLastCallUsageFromUnifiedLog({
      logPath: linkedPath,
      sessionId: "target-session",
      promptId: "target-prompt",
    }),
  );
});
