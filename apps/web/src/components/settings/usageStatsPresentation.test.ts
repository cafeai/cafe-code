import { ProviderDriverKind } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  buildUsageTokenBreakdownView,
  formatCompactTokenCount,
  formatFullTokenCount,
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
          {
            provider: CODEX,
            model: "gpt-small",
            outputTokens: 20,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
          },
          {
            provider: CLAUDE,
            model: "claude-opus",
            outputTokens: 75,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
          },
          {
            provider: CODEX,
            model: "gpt-large",
            outputTokens: 40,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
          },
          {
            provider: CODEX,
            model: "gpt-small",
            outputTokens: 10,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
          },
          {
            provider: CLAUDE,
            model: "unused",
            outputTokens: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
          },
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

  it("formats full token counts and their compact companion consistently", () => {
    expect(formatFullTokenCount(3_539_966_200)).toBe("3,539,966,200");
    expect(formatCompactTokenCount(3_539_966_200)).toBe("3.54B");
    expect(formatCompactTokenCount(3_000_000)).toBe("3.00M");
    expect(formatCompactTokenCount(9_500)).toBe("9.5K");
    expect(formatCompactTokenCount(999_999)).toBe("1.00M");
    expect(formatCompactTokenCount(9_999_999)).toBe("10M");
    expect(formatCompactTokenCount(999_999_999)).toBe("1.00B");
    expect(formatCompactTokenCount(9_999_999_999)).toBe("10.0B");
    expect(formatFullTokenCount(Number.NaN)).toBe("0");
    expect(formatCompactTokenCount(Number.POSITIVE_INFINITY)).toBe("0");
  });
});
