import { describe, expect, it } from "vitest";

import {
  CLAUDE_RESPONSE_LIMIT_MESSAGE,
  CLAUDE_SHORTER_CONTINUATION_PROMPT,
  isClaudeResponseLimitError,
} from "./claudeResponseLimits.ts";

describe("Claude response-limit recovery copy", () => {
  it("recognizes only the exact fixed guidance, never arbitrary native prose", () => {
    expect(isClaudeResponseLimitError(CLAUDE_RESPONSE_LIMIT_MESSAGE)).toBe(true);
    for (const unrelated of [
      "",
      "max_output_tokens",
      "Claude's response exceeded the 64000 output token maximum.",
      ` ${CLAUDE_RESPONSE_LIMIT_MESSAGE}`,
      `${CLAUDE_RESPONSE_LIMIT_MESSAGE}\n`,
      `Provider said: ${CLAUDE_RESPONSE_LIMIT_MESSAGE}`,
      CLAUDE_RESPONSE_LIMIT_MESSAGE.toLowerCase(),
    ]) {
      expect(isClaudeResponseLimitError(unrelated)).toBe(false);
    }
  });

  it("provides bounded editable continuation text without changing execution policy", () => {
    expect(CLAUDE_SHORTER_CONTINUATION_PROMPT).toContain("without repeating completed actions");
    expect(CLAUDE_SHORTER_CONTINUATION_PROMPT.length).toBeLessThan(256);
    expect(CLAUDE_SHORTER_CONTINUATION_PROMPT).not.toMatch(
      /bypass|permission|credentials|restart|128000/i,
    );
  });
});
