import { ProviderDriverKind } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  formatCompactTokenCount,
  formatFullTokenCount,
  formatGeneratingTime,
  formatUsageRecordingDate,
  formatUsageModelLabel,
  getUsageModelExplanation,
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

  it("formats known providers and explains unknown models without pricing them", () => {
    expect(formatUsageProviderLabel(CODEX)).toBe("Codex");
    expect(formatUsageProviderLabel(CLAUDE)).toBe("Claude");
    expect(formatUsageProviderLabel(ProviderDriverKind.make("custom_driver"))).toBe(
      "Custom Driver",
    );
    expect(formatUsageModelLabel("unknown")).toBe("Model not reported");
    expect(formatUsageModelLabel("gpt-5.6-codex")).toBe("gpt-5.6-codex");
    expect(getUsageModelExplanation("unknown")).toBe(
      "The provider didn't report which model served these tokens. They're counted but not priced.",
    );
    expect(getUsageModelExplanation("gpt-5.6-codex")).toBeUndefined();
  });

  it("formats compact token readouts and their exact hover values consistently", () => {
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
