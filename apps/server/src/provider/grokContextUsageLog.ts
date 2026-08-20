// @effect-diagnostics nodeBuiltinImport:off
import * as NodeConstants from "node:constants";
import * as NodeFS from "node:fs/promises";

const GROK_UNIFIED_LOG_TAIL_MAX_BYTES = 16 * 1024 * 1024;
const GROK_UNIFIED_LOG_MAX_LINE_BYTES = 256 * 1024;

export interface GrokLastCallUsageFromLog {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly reasoningOutputTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (Buffer.byteLength(line) > GROK_UNIFIED_LOG_MAX_LINE_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Grok 1.0.4 can finish a prompt through its private `turn_completed`
 * notification without returning the standard ACP prompt response that carries
 * last-model-call counters. Its unified log records those counters in a
 * metadata-only `shell.turn.inference_done` entry immediately before the
 * matching `shell.handle_prompt.done` entry.
 *
 * This fallback deliberately reads only a bounded tail, rejects symlinks, and
 * retains only numeric counters for the exact session and Cafe prompt id. Raw
 * log messages, prompts, model output, and unrelated session data never leave
 * this function.
 */
export async function readGrokLastCallUsageFromUnifiedLog(input: {
  readonly logPath: string;
  readonly sessionId: string;
  readonly promptId: string;
}): Promise<GrokLastCallUsageFromLog | null> {
  let handle: NodeFS.FileHandle | undefined;
  try {
    handle = await NodeFS.open(input.logPath, NodeConstants.O_RDONLY | NodeConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) return null;

    const bytesToRead = Math.min(stat.size, GROK_UNIFIED_LOG_TAIL_MAX_BYTES);
    const start = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    // A bounded tail can begin in the middle of a JSON line. Never attempt to
    // interpret that fragment as provider metadata.
    if (start > 0) lines.shift();

    let completionProcessId: number | undefined;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      const record = parseRecord(line);
      if (!record || record.sid !== input.sessionId) continue;
      const ctx = isRecord(record.ctx) ? record.ctx : undefined;
      if (!ctx) continue;

      if (completionProcessId === undefined) {
        if (
          record.msg !== "shell.handle_prompt.done" ||
          ctx.prompt_id !== input.promptId ||
          ctx.ok !== true
        ) {
          continue;
        }
        completionProcessId = nonNegativeFinite(record.pid);
        if (completionProcessId === undefined) return null;
        continue;
      }

      if (record.pid !== completionProcessId) continue;
      // Do not cross another completed prompt in the same process. Prompt ids
      // are unique, so that would make the older inference ambiguous.
      if (record.msg === "shell.handle_prompt.done") return null;
      if (record.msg !== "shell.turn.inference_done") continue;

      const inputTokens = nonNegativeFinite(ctx.prompt_tokens);
      const outputTokens = nonNegativeFinite(ctx.completion_tokens);
      if (inputTokens === undefined || outputTokens === undefined) return null;
      const cachedInputTokens = Math.min(
        inputTokens,
        nonNegativeFinite(ctx.cached_prompt_tokens) ?? 0,
      );
      const reasoningOutputTokens = Math.min(
        outputTokens,
        nonNegativeFinite(ctx.reasoning_tokens) ?? 0,
      );
      return {
        totalTokens: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
