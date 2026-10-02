import { ProviderDriverKind } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  buildUsageTokenBreakdownView,
  formatCompactTokenCount,
  formatFullTokenCount,
  formatGeneratingTime,
  formatUsageRecordingDate,
  formatUsageModelLabel,
  getUsageModelExplanation,
  formatUsagePercentage,
  formatUsageProviderLabel,
} from "./usageStatsPresentation";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

describe("usageStatsPresentation", () => {
  it("formats recorded model durations consistently through seconds, hours and long histories", () => {
    expect(formatGeneratingTime(0)).toBe("0s");
    expect(formatGeneratingTime(999)).toBe("0s");
    expect(formatGeneratingTime(1_999)).toBe("1s");
    expect(formatGeneratingTime(61_000)).toBe("1m 01s");
    expect(formatGeneratingTime(3_661_000)).toBe("1h 01m 01s");
    expect(formatGeneratingTime(16 * 3_600_000)).toBe("16h 00m 00s");
    expect(formatGeneratingTime(86_400_000 + 3_661_000)).toBe("1d 01h 01m 01s");
    expect(formatGeneratingTime(1_234 * 86_400_000)).toBe("1,234d 00h 00m 00s");
    expect(formatGeneratingTime(Number.NaN)).toBe("0s");
    expect(formatGeneratingTime(Number.POSITIVE_INFINITY)).toBe("0s");
    expect(formatGeneratingTime(-1)).toBe("0s");
  });

  it("formats the recording boundary locally and refuses an invalid private source value", () => {
    const startedAt = "2026-10-01T23:59:00.000Z";
    expect(formatUsageRecordingDate(startedAt)).toBe(
      new Date(startedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    );
    expect(formatUsageRecordingDate("private-invalid-value")).toBeUndefined();
    expect(formatUsageRecordingDate(`2026-10-01${" ".repeat(1_000)}`)).toBeUndefined();
  });

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
    expect(formatUsageModelLabel("unknown")).toBe("Model not reported");
    expect(formatUsageModelLabel("gpt-5.6-codex")).toBe("gpt-5.6-codex");
    expect(getUsageModelExplanation("unknown")).toBe(
      "The provider reported token usage without identifying the effective model. Tokens remain counted; cost is unpriced unless you set a custom rate.",
    );
    expect(getUsageModelExplanation("gpt-5.6-codex")).toBeUndefined();
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
