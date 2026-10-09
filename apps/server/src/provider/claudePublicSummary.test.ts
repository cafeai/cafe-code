import { describe, expect, it } from "vitest";
import {
  appendClaudePublicSummary,
  claudeCommandInspectionText,
  claudeCommandInspectionPreview,
  makeClaudePublicSummaryText,
  mergeClaudePublicSummarySnapshot,
  retireClaudePublicSummaryKey,
} from "./claudePublicSummary.ts";

describe("bounded disclosed Claude summaries", () => {
  it("never evicts retired source identities into snapshot fallback authority", () => {
    const keys = new Set<string>();
    for (let index = 0; index < 64; index += 1)
      expect(retireClaudePublicSummaryKey(keys, `source-${index}`)).toBe(true);
    expect(retireClaudePublicSummaryKey(keys, "overflow-source")).toBe(false);
    expect(keys.size).toBe(64);
    expect(keys.has("source-0")).toBe(true);
    expect(retireClaudePublicSummaryKey(keys, "source-0")).toBe(true);
  });
  it("repairs only a proven UTF-16 prefix and rejects divergence without replacement", () => {
    const state = makeClaudePublicSummaryText();
    appendClaudePublicSummary(state, "Plan \ud83d");
    appendClaudePublicSummary(state, "\ude00");
    expect(mergeClaudePublicSummarySnapshot(state, "Plan 😀 next")).toBe(true);
    expect(state.text).toBe("Plan 😀 next");
    expect(mergeClaudePublicSummarySnapshot(state, "different")).toBe(false);
    expect(state.text).toBe("Plan 😀 next");
  });
  it("bounds retained text and snapshot inspection while hashing received suffixes", () => {
    const state = makeClaudePublicSummaryText();
    appendClaudePublicSummary(state, "a".repeat(5_000));
    expect(state.text).toHaveLength(4_096);
    expect(state.truncated).toBe(true);
    expect(mergeClaudePublicSummarySnapshot(state, "a".repeat(5_000) + "b")).toBe(true);
    expect(state.receivedLength).toBe(5_001);
    expect(mergeClaudePublicSummarySnapshot(state, "a".repeat(65_537))).toBe(false);
    expect(state.text).toHaveLength(4_096);
  });
  it("preserves ordinary command text, redacts known tokens and makes controls visible", () => {
    expect(claudeCommandInspectionText("corepack yarn test --run", 4_096)).toBe(
      "corepack yarn test --run",
    );
    const text = claudeCommandInspectionText(
      "echo sk-ant-secret-value Bearer abc.def\u202e\u0000",
      2_048,
    );
    expect(text).not.toContain("sk-ant-secret-value");
    expect(text).not.toContain("abc.def");
    expect(text).toContain("\\u202e\\u0000");
    expect(claudeCommandInspectionText("x".repeat(3_000), 2_048)).toHaveLength(2_048);
  });
  it("reports truncation introduced by control expansion for each inspection bound", () => {
    for (const limit of [2_048, 4_096]) {
      const raw = "\u202e".repeat(Math.ceil(limit / 6));
      expect(raw.length < limit).toBe(true);
      const preview = claudeCommandInspectionPreview(raw, limit);
      expect(preview.text).toHaveLength(limit);
      expect(preview.truncated).toBe(true);
    }
  });
});
