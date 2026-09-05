import type { UsageAccountingSnapshot } from "@cafecode/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  makeClaudeUsageAccounting,
  observeClaudeResultUsage,
} from "../provider/claudeUsageAccounting.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * One-shot Claude JSON output contains a single result, including on provider
 * failures. Its modelUsage includes subagents/sidechains; never add result.usage
 * to it. Reuse the main adapter's validator so the two accounting paths agree.
 * Source: https://code.claude.com/docs/en/agent-sdk/cost-tracking
 */
export function readClaudeAuxiliaryUsage(
  stdout: string,
  scopeId: string,
): UsageAccountingSnapshot | undefined {
  const decoded = decodeJson(stdout);
  if (Option.isNone(decoded)) return undefined;
  const envelope = record(decoded.value);
  if (!envelope || envelope.type !== "result") return undefined;
  if (Object.hasOwn(envelope, "modelUsage")) {
    // A malformed/zeroed authoritative result is not permission to substitute
    // a differently scoped usage counter and accidentally inflate the ledger.
    return observeClaudeResultUsage(makeClaudeUsageAccounting(scopeId), envelope);
  }

  // Older CLIs can omit modelUsage. Retain only explicitly reported main-loop
  // counts in that case, marked incomplete because subagent work is unknown.
  const usage = record(envelope.usage);
  if (!usage) return undefined;
  const fresh = count(usage.input_tokens);
  const cached = count(usage.cache_read_input_tokens ?? 0);
  const written = count(usage.cache_creation_input_tokens ?? 0);
  const output = count(usage.output_tokens);
  if (fresh === undefined || cached === undefined || written === undefined || output === undefined)
    return undefined;
  const input = fresh + cached + written;
  if (!Number.isSafeInteger(input)) return undefined;
  return {
    scopeId,
    revision: 1,
    completeness: "input-only",
    models: [
      {
        // The legacy envelope does not prove which model served the request.
        model: "unknown",
        inputTokens: input,
        cachedInputTokens: cached,
        cacheWriteInputTokens: written,
        outputTokens: output,
        reasoningOutputTokens: 0,
      },
    ],
  };
}

/**
 * `codex exec --json` exposes usage only on turn.completed. Upstream 0.153.4
 * exec_events.rs and event_processor_with_jsonl_output.rs copy the thread's
 * total token counters there. Our ephemeral, non-resumed helper has one turn;
 * retain the last valid total once, never sum duplicates or item-level fields.
 * The exec event stream omits the effective model and rerouting notification,
 * so its model is unknown rather than assuming the requested model served it.
 * Source: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec/src/event_processor_with_jsonl_output.rs
 */
export function makeCodexAuxiliaryUsageReader(scopeId: string) {
  let snapshot: UsageAccountingSnapshot | undefined;
  let pending = "";
  let droppingOversizedLine = false;
  const readLine = (line: string) => {
    const decoded = decodeJson(line);
    if (Option.isNone(decoded)) return;
    const event = record(decoded.value);
    if (event?.type !== "turn.completed") return;
    const usage = record(event.usage);
    if (!usage) return;
    const input = count(usage.input_tokens);
    const cached = count(usage.cached_input_tokens);
    const written = count(usage.cache_write_input_tokens ?? 0);
    const output = count(usage.output_tokens);
    const reasoning = count(usage.reasoning_output_tokens ?? 0);
    if (
      input === undefined ||
      cached === undefined ||
      written === undefined ||
      output === undefined ||
      reasoning === undefined ||
      cached + written > input ||
      reasoning > output
    )
      return;
    const previous = snapshot?.models[0];
    if (
      previous &&
      (input < previous.inputTokens ||
        cached < previous.cachedInputTokens ||
        written < previous.cacheWriteInputTokens ||
        output < previous.outputTokens ||
        reasoning < previous.reasoningOutputTokens)
    )
      return;
    snapshot = {
      scopeId,
      revision: 1,
      completeness: "complete",
      models: [
        {
          model: "unknown",
          inputTokens: input,
          cachedInputTokens: cached,
          cacheWriteInputTokens: written,
          outputTokens: output,
          reasoningOutputTokens: reasoning,
        },
      ],
    };
  };
  return {
    push(chunk: string): void {
      // JSON stdout contains agent/tool output as well as usage. Keep only a
      // bounded line candidate and the numeric terminal snapshot; never collect
      // a second copy of the full helper transcript to measure a few counters.
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf("\n", start);
        const end = newline === -1 ? chunk.length : newline;
        if (!droppingOversizedLine) {
          if (pending.length + end - start > 16_384) {
            pending = "";
            droppingOversizedLine = true;
          } else {
            pending += chunk.slice(start, end);
          }
        }
        if (newline === -1) break;
        if (!droppingOversizedLine) readLine(pending);
        pending = "";
        droppingOversizedLine = false;
        start = newline + 1;
      }
    },
    finish(): UsageAccountingSnapshot | undefined {
      if (!droppingOversizedLine && pending.length > 0) readLine(pending);
      pending = "";
      return snapshot;
    },
  };
}
