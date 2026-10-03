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
          processedTokens: 75,
          models: [{ model: "claude-opus", outputTokens: 75, processedTokens: 75 }],
        },
        {
          provider: CODEX,
          outputTokens: 70,
          processedTokens: 70,
          models: [
            { model: "gpt-large", outputTokens: 40, processedTokens: 40 },
            { model: "gpt-small", outputTokens: 30, processedTokens: 30 },
          ],
        },
      ],
      attributedOutputTokens: 145,
      unattributedOutputTokens: 55,
    });
  });

  it("retains input-only Fable without changing generated-output totals or adding cache twice", () => {
    const detail = [
      {
        provider: CODEX,
        model: "gpt-6-astra",
        inputTokens: 1_453_045_932,
        outputTokens: 5_037_075,
      },
      {
        provider: CODEX,
        model: "gpt-6.1-sol",
        inputTokens: 1_174_928_287,
        outputTokens: 4_975_605,
      },
      { provider: CLAUDE, model: "claude-fable-5-1", inputTokens: 2_853_296, outputTokens: 0 },
    ].map((row) => ({
      ...row,
      cachedInputTokens: 1_000_000,
      cacheWriteInputTokens: 10_000,
      reasoningOutputTokens: 0,
    }));
    const view = buildUsageTokenBreakdownView(detail, 10_012_680);
    expect(view.attributedOutputTokens).toBe(10_012_680);
    expect(view.unattributedOutputTokens).toBe(0);
    expect(view.providers.map((provider) => provider.provider)).toEqual([CODEX, CLAUDE]);
    expect(view.providers[1]).toEqual({
      provider: CLAUDE,
      outputTokens: 0,
      processedTokens: 2_853_296,
      models: [{ model: "claude-fable-5-1", outputTokens: 0, processedTokens: 2_853_296 }],
    });
    expect(view.providers.reduce((sum, provider) => sum + provider.processedTokens, 0)).toBe(
      2_640_840_195,
    );
    expect(
      formatUsagePercentage(view.providers[1]!.outputTokens, view.attributedOutputTokens),
    ).toBe("0%");
  });

  it("merges input-only duplicates and orders them without fabricating output or unattributed usage", () => {
    const base = {
      provider: CLAUDE,
      inputTokens: 100,
      cachedInputTokens: 90,
      cacheWriteInputTokens: 10,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    };
    const view = buildUsageTokenBreakdownView(
      [
        { ...base, model: "small" },
        { ...base, model: "large", inputTokens: 150 },
        { ...base, model: "large" },
        { ...base, model: "empty", inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
        {
          ...base,
          model: "invalid",
          inputTokens: Number.NaN,
          outputTokens: Number.POSITIVE_INFINITY,
        },
      ],
      0,
    );
    expect(view).toEqual({
      providers: [
        {
          provider: CLAUDE,
          outputTokens: 0,
          processedTokens: 350,
          models: [
            { model: "large", outputTokens: 0, processedTokens: 250 },
            { model: "small", outputTokens: 0, processedTokens: 100 },
          ],
        },
      ],
      attributedOutputTokens: 0,
      unattributedOutputTokens: 0,
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
