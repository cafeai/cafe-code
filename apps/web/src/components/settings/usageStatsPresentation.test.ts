import { ProviderDriverKind } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  buildUsageTokenBreakdownView,
  formatUsageModelLabel,
  formatUsagePercentage,
  formatUsageProviderLabel,
} from "./usageStatsPresentation";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

describe("usageStatsPresentation", () => {
  it("groups duplicate rows and sorts providers and models by generated tokens", () => {
    expect(
      buildUsageTokenBreakdownView(
        [
          { provider: CODEX, model: "gpt-small", outputTokens: 20 },
          { provider: CLAUDE, model: "claude-opus", outputTokens: 75 },
          { provider: CODEX, model: "gpt-large", outputTokens: 40 },
          { provider: CODEX, model: "gpt-small", outputTokens: 10 },
          { provider: CLAUDE, model: "unused", outputTokens: 0 },
        ],
        200,
      ),
    ).toEqual({
      providers: [
        {
          provider: CLAUDE,
          outputTokens: 75,
          models: [{ model: "claude-opus", outputTokens: 75 }],
        },
        {
          provider: CODEX,
          outputTokens: 70,
          models: [
            { model: "gpt-large", outputTokens: 40 },
            { model: "gpt-small", outputTokens: 30 },
          ],
        },
      ],
      attributedOutputTokens: 145,
      unattributedOutputTokens: 55,
    });
  });

  it("formats known providers, unknown models, and compact percentages", () => {
    expect(formatUsageProviderLabel(CODEX)).toBe("Codex");
    expect(formatUsageProviderLabel(CLAUDE)).toBe("Claude");
    expect(formatUsageProviderLabel(ProviderDriverKind.make("custom_driver"))).toBe(
      "Custom Driver",
    );
    expect(formatUsageModelLabel("unknown")).toBe("Unknown model");
    expect(formatUsageModelLabel("gpt-5.6-codex")).toBe("gpt-5.6-codex");
    expect(formatUsagePercentage(1, 2_000)).toBe("<0.1%");
    expect(formatUsagePercentage(5, 100)).toBe("5.0%");
    expect(formatUsagePercentage(1, 0)).toBe("0%");
  });
});
