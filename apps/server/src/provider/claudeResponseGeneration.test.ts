import { describe, expect, it } from "vitest";

import {
  isClaudeServerSideContentBlock,
  observeClaudeResponseGeneration,
} from "./claudeResponseGeneration.ts";
import { ResponseGenerationClock } from "./responseGenerationClock.ts";

const block = (type: string) => ({ type: "content_block_start", content_block: { type } });
const delta = { type: "content_block_delta" };
const stop = { type: "content_block_stop" };
const messageDelta = (outputTokens: unknown) => ({
  type: "message_delta",
  usage: { output_tokens: outputTokens },
});

describe("observeClaudeResponseGeneration", () => {
  it("times one message from its first content block to message_delta", () => {
    const clock = new ResponseGenerationClock();
    observeClaudeResponseGeneration(clock, { type: "message_start" }, 0);
    observeClaudeResponseGeneration(clock, block("thinking"), 800);
    observeClaudeResponseGeneration(clock, delta, 1_200);
    observeClaudeResponseGeneration(clock, stop, 2_000);
    observeClaudeResponseGeneration(clock, block("tool_use"), 2_100);
    observeClaudeResponseGeneration(clock, delta, 2_600);
    expect(observeClaudeResponseGeneration(clock, messageDelta(360), 2_800)).toEqual({
      outputTokens: 360,
      durationMs: 2_000,
    });
  });

  it("does not sample a message that contains a server-side tool", () => {
    const clock = new ResponseGenerationClock();
    observeClaudeResponseGeneration(clock, { type: "message_start" }, 0);
    observeClaudeResponseGeneration(clock, block("text"), 100);
    observeClaudeResponseGeneration(clock, block("server_tool_use"), 500);
    observeClaudeResponseGeneration(clock, block("web_search_tool_result"), 6_000);
    expect(observeClaudeResponseGeneration(clock, messageDelta(500), 9_000)).toBeUndefined();
  });

  it("starts fresh at each message_start and ignores messages without content", () => {
    const clock = new ResponseGenerationClock();
    observeClaudeResponseGeneration(clock, block("text"), 0);
    // A retried request restarts before reporting usage for the first attempt.
    observeClaudeResponseGeneration(clock, { type: "message_start" }, 5_000);
    expect(observeClaudeResponseGeneration(clock, messageDelta(10), 5_100)).toBeUndefined();

    observeClaudeResponseGeneration(clock, { type: "message_start" }, 6_000);
    observeClaudeResponseGeneration(clock, block("text"), 6_200);
    expect(observeClaudeResponseGeneration(clock, messageDelta("12"), 6_500)).toBeUndefined();
  });

  it("recognizes Anthropic-hosted tool blocks", () => {
    for (const type of [
      "server_tool_use",
      "mcp_tool_use",
      "mcp_tool_result",
      "web_fetch_tool_result",
      "code_execution_tool_result",
      "container_upload",
    ]) {
      expect(isClaudeServerSideContentBlock(type)).toBe(true);
    }
    for (const type of ["text", "thinking", "redacted_thinking", "tool_use", undefined]) {
      expect(isClaudeServerSideContentBlock(type)).toBe(false);
    }
  });
});
