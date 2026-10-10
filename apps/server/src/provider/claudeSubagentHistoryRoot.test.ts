import { describe, expect, it } from "vitest";
import { normalizeClaudeSubagentHistoryRoot } from "./claudeSubagentHistoryRoot.ts";

const ROOT = "00000000-0000-4000-8000-000000000001";
const OTHER_ROOT = "00000000-0000-4000-8000-000000000002";

describe("Claude child history native root", () => {
  it("retains the exact native UUID while ignoring mutable resume checkpoints", () => {
    expect(normalizeClaudeSubagentHistoryRoot({ resume: ROOT, turnCount: 1 })).toEqual({
      resume: ROOT,
    });
    expect(normalizeClaudeSubagentHistoryRoot({ sessionId: ROOT, turnCount: 99 })).toEqual({
      resume: ROOT,
    });
    expect(normalizeClaudeSubagentHistoryRoot({ resume: ROOT, sessionId: OTHER_ROOT })).toEqual({
      resume: ROOT,
    });
    expect(normalizeClaudeSubagentHistoryRoot({ resume: null, sessionId: ROOT })).toEqual({
      resume: ROOT,
    });
  });

  it("refuses incomplete, malformed, padded and oversized identities without alias rescue", () => {
    for (const value of [
      undefined,
      null,
      ROOT,
      [],
      { threadId: "cafe-thread" },
      { resume: ` ${ROOT}` },
      { resume: `${ROOT} ` },
      { resume: "x".repeat(10_000) },
      { resume: "malformed", sessionId: ROOT },
      { resume: "00000000-0000-0000-0000-000000000000" },
    ])
      expect(normalizeClaudeSubagentHistoryRoot(value)).toBeUndefined();
  });

  it("never invokes identity getters, inherited identities or unrelated serialization hooks", () => {
    let executions = 0;
    const accessor = Object.defineProperty({ sessionId: ROOT }, "resume", {
      get() {
        executions += 1;
        return ROOT;
      },
    });
    expect(normalizeClaudeSubagentHistoryRoot(accessor)).toBeUndefined();
    expect(normalizeClaudeSubagentHistoryRoot(Object.create({ resume: ROOT }))).toBeUndefined();
    const inert = Object.defineProperties(
      { resume: ROOT },
      {
        turnCount: {
          get() {
            executions += 1;
            return 99;
          },
        },
        toJSON: {
          value() {
            executions += 1;
            return { resume: OTHER_ROOT };
          },
        },
      },
    );
    expect(normalizeClaudeSubagentHistoryRoot(inert)).toEqual({ resume: ROOT });
    expect(executions).toBe(0);
  });
});
