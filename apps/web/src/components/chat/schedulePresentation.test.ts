import { describe, expect, it } from "vitest";
import { ProviderInstanceId } from "@cafecode/contracts";
import {
  formatScheduleTime,
  parseScheduleNumbers,
  parseScheduleUtcInput,
  scheduleModelLabel,
  scheduleUtcInput,
} from "./schedulePresentation";

describe("schedule presentation", () => {
  it("round-trips absolute UTC inputs without inheriting the browser timezone", () => {
    expect(parseScheduleUtcInput("2026-10-04T09:30")).toBe("2026-10-04T09:30:00.000Z");
    expect(scheduleUtcInput("2026-10-04T09:30:00.000Z")).toBe("2026-10-04T09:30");
    expect(parseScheduleUtcInput("2026-02-30T09:30")).toBeNull();
    expect(parseScheduleUtcInput("2026-10-04T25:30")).toBeNull();
    expect(parseScheduleUtcInput("2026-10-04T09:30+09:00")).toBeNull();
  });

  it("strictly parses bounded structured calendar selections", () => {
    expect(parseScheduleNumbers("", 0, 6)).toBeUndefined();
    expect(parseScheduleNumbers("5, 1, 1", 0, 6)).toEqual([1, 5]);
    for (const input of ["-1", "7", "1,,2", "1;2", "1e0", "1.5", "1,2,3,4,5,6,0,1"]) {
      expect(() => parseScheduleNumbers(input, 0, 6)).toThrow();
    }
  });

  it("labels saved model options without inventing provider-observed settings", () => {
    expect(
      scheduleModelLabel({
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6.1-sol",
        options: [
          { id: "reasoningEffort", value: "medium" },
          { id: "fastMode", value: false },
        ],
      }),
    ).toBe("gpt-6.1-sol · Effort: medium · Fast: off");
  });

  it("fails closed for invalid dates and timezone names", () => {
    expect(formatScheduleTime("invalid", "Asia/Tokyo")).toBe("Time unavailable");
    expect(formatScheduleTime("2026-10-04T09:30:00.000Z", "invalid")).toBe("Time unavailable");
    expect(formatScheduleTime("2026-10-04T09:30:00.000Z", "Asia/Tokyo")).not.toBe(
      "Time unavailable",
    );
  });
});
