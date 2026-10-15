/**
 * Claude response-generation timing for the tokens-per-second display.
 *
 * Claude Code forwards the Anthropic Messages stream for each API call
 * (`includePartialMessages`): `message_start`, then content blocks, then one
 * `message_delta` whose usage carries the message's cumulative
 * `output_tokens`, then `message_stop`. Tools run after `message_stop`, so a
 * message's interval from its first content block to `message_delta` contains
 * only decoding. Server-side tools (web search/fetch, code execution, remote
 * MCP) execute inside the message and are reported as their own content
 * blocks; a message containing one is not sampled.
 *
 * Feed primary-stream frames only. Nested subagent streams (frames carrying a
 * parent tool-use id) belong to concurrent child loops.
 * https://docs.claude.com/en/docs/build-with-claude/streaming
 */
import type { ResponseGenerationSample } from "@cafecode/contracts";

import type { ResponseGenerationClock } from "./responseGenerationClock.ts";

interface ClaudeStreamFrame {
  readonly type: string;
  readonly content_block?: { readonly type?: unknown } | undefined;
  readonly usage?: { readonly output_tokens?: unknown } | null | undefined;
}

/** Content blocks produced by Anthropic-hosted tools rather than decoding. */
export function isClaudeServerSideContentBlock(type: unknown): boolean {
  return (
    typeof type === "string" &&
    (type === "server_tool_use" ||
      type === "mcp_tool_use" ||
      type === "container_upload" ||
      type.endsWith("_tool_result"))
  );
}

/**
 * Advance the per-session clock with one primary stream frame received at
 * `atMs`. Returns a validated sample when `frame` is the `message_delta` that
 * closes a fully observed message.
 */
export function observeClaudeResponseGeneration(
  clock: ResponseGenerationClock,
  frame: ClaudeStreamFrame,
  atMs: number,
): ResponseGenerationSample | undefined {
  switch (frame.type) {
    case "message_start":
      // A new API call (including a Claude Code retry) starts a new window.
      clock.reset();
      return undefined;
    case "content_block_start":
      if (isClaudeServerSideContentBlock(frame.content_block?.type)) clock.invalidate();
      else clock.observeOutput(atMs);
      return undefined;
    case "content_block_delta":
      clock.observeOutput(atMs);
      return undefined;
    case "content_block_stop":
      clock.observeEdge(atMs);
      return undefined;
    case "message_delta": {
      const outputTokens = frame.usage?.output_tokens;
      return clock.finish(typeof outputTokens === "number" ? outputTokens : undefined, atMs);
    }
    default:
      return undefined;
  }
}
