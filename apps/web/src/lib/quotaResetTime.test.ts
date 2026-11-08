import { describe, expect, it } from "vitest";

import { formatQuotaResetTime } from "./quotaResetTime";

const now = Date.parse("2026-11-06T00:00:00Z");
const options = { locale: "en-US", timeZone: "America/Los_Angeles", now };

describe("formatQuotaResetTime", () => {
  it("shows the local date and time without a zone name or the current year", () => {
    const text = formatQuotaResetTime(Date.parse("2026-11-06T09:50:00Z"), options);
    expect(text).toBe("Nov 6, 1:50 AM");
  });

  it("adds the year only when the reset falls in another year", () => {
    const text = formatQuotaResetTime(Date.parse("2027-01-02T20:00:00Z"), options);
    expect(text).toContain("2027");
    expect(text).not.toMatch(/PST|PDT|GMT/u);
  });

  it("returns nothing for an unusable instant", () => {
    expect(formatQuotaResetTime(Number.NaN, options)).toBeNull();
    expect(formatQuotaResetTime(0, options)).toBeNull();
  });
});
