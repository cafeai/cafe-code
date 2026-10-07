import { describe, expect, it } from "vitest";
import { ProviderDriverKind } from "@cafecode/contracts";

import {
  formatCodexRateLimitResetAvailability,
  formatCodexRateLimitInlineText,
  formatCodexRateLimitSummary,
  formatCodexRateLimitBuckets,
  formatCodexRateLimitPresentation,
  selectCodexRateLimitBuckets,
  selectCodexRateLimitSnapshot,
  shouldSurfaceProviderAccountRateLimits,
} from "./codexRateLimits";

describe("codexRateLimits", () => {
  it("allows the shared account-quota surface for authenticated Grok", () => {
    expect(
      shouldSurfaceProviderAccountRateLimits({
        driver: ProviderDriverKind.make("grok"),
        auth: { status: "authenticated", type: "cached-token" },
      }),
    ).toBe(true);
    expect(
      shouldSurfaceProviderAccountRateLimits({
        driver: ProviderDriverKind.make("grok"),
        auth: { status: "unauthenticated" },
      }),
    ).toBe(false);
    expect(
      shouldSurfaceProviderAccountRateLimits({
        driver: ProviderDriverKind.make("opencode"),
        auth: { status: "authenticated" },
      }),
    ).toBe(false);
  });

  it("prefers the codex bucket when additional rate limit buckets are present", () => {
    const snapshot = selectCodexRateLimitSnapshot({
      checkedAt: "2026-05-28T00:00:00.000Z",
      rateLimits: {
        limitId: "other",
        primary: { usedPercent: 90 },
      },
      rateLimitsByLimitId: {
        other: {
          limitId: "other",
          primary: { usedPercent: 90 },
        },
        codex: {
          limitId: "codex",
          primary: { usedPercent: 20 },
        },
      },
    });

    expect(snapshot?.limitId).toBe("codex");
    expect(snapshot?.primary?.usedPercent).toBe(20);
  });

  it("formats primary hours, secondary days, left percentages, and local reset times", () => {
    const summary = formatCodexRateLimitSummary(
      {
        checkedAt: "2026-05-28T00:00:00.000Z",
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: 1_779_580_800,
          },
          secondary: {
            usedPercent: 62.5,
            windowDurationMins: 10_080,
            resetsAt: 1_780_172_059,
          },
        },
      },
      { locale: "en-US", timeZone: "Asia/Tokyo" },
    );

    expect(summary?.primary?.text).toBe("Primary window (5 hours): 75% left");
    expect(summary?.secondary?.text).toBe("Secondary window (7 days): 37.5% left");
    expect(summary?.primaryReset).toContain("5h reset:");
    expect(summary?.primaryReset).toContain("2026");
    expect(summary?.secondaryReset).toContain("7d reset:");
    expect(summary?.secondaryReset).toContain("2026");
  });

  it("formats both window durations as exact days, hours, and minutes", () => {
    const summary = formatCodexRateLimitSummary({
      checkedAt: "2026-07-15T00:00:00.000Z",
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 3,
          windowDurationMins: 10_080,
        },
        secondary: {
          usedPercent: 25,
          windowDurationMins: 1_572,
        },
      },
    });

    expect(summary?.primary?.text).toBe("Primary window (7 days): 97% left");
    expect(summary?.secondary?.text).toBe(
      "Secondary window (1 day, 2 hours, 12 minutes): 75% left",
    );
  });

  it("falls back to a generic primary reset label when window duration is unknown", () => {
    const summary = formatCodexRateLimitSummary(
      {
        checkedAt: "2026-05-28T00:00:00.000Z",
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 40,
            resetsAt: 1_779_580_800,
          },
        },
      },
      { locale: "en-US", timeZone: "UTC" },
    );

    expect(summary?.primaryReset).toContain("Primary reset:");
  });

  it("shows only the reset for a window with no usage figure, and omits absent windows", () => {
    const summary = formatCodexRateLimitSummary(
      {
        checkedAt: "2026-06-23T00:00:00.000Z",
        rateLimits: {
          limitId: "claude",
          // Claude often reports a window with only a reset time (no utilization),
          // and may not report the weekly window at all.
          primary: {
            windowDurationMins: 300,
            resetsAt: 1_782_274_800,
          },
        },
      },
      { locale: "en-US", timeZone: "UTC" },
    );

    // No usage figure → no usage line; the reset still surfaces.
    expect(summary?.primary).toBeNull();
    expect(summary?.primaryReset).toContain("5h reset:");
    // No weekly window was reported, so it must not appear at all.
    expect(summary?.secondary).toBeNull();
    expect(summary?.secondaryReset).toBeNull();
  });

  it("returns null when there is no rate-limit information at all", () => {
    const summary = formatCodexRateLimitSummary({
      checkedAt: "2026-06-23T00:00:00.000Z",
      rateLimits: { limitId: "claude" },
    });
    expect(summary).toBeNull();
  });

  it("formats the authoritative available reset count, including zero", () => {
    expect(
      formatCodexRateLimitResetAvailability({
        checkedAt: "2026-07-27T00:00:00.000Z",
        rateLimits: { limitId: "codex" },
        rateLimitResetCredits: { availableCount: 3, credits: null },
      }),
    ).toBe("Usage limit resets available: 3");

    expect(
      formatCodexRateLimitResetAvailability({
        checkedAt: "2026-07-27T00:00:00.000Z",
        rateLimits: { limitId: "codex" },
        rateLimitResetCredits: { availableCount: 0 },
      }),
    ).toBe("Usage limit resets available: 0");
  });

  it("omits reset availability when the provider did not report it", () => {
    expect(
      formatCodexRateLimitResetAvailability({
        checkedAt: "2026-07-27T00:00:00.000Z",
        rateLimits: { limitId: "codex" },
      }),
    ).toBeNull();
  });

  it("produces a compact inline string for settings rows", () => {
    const text = formatCodexRateLimitInlineText(
      {
        checkedAt: "2026-05-28T00:00:00.000Z",
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 0,
            windowDurationMins: 10_080,
          },
        },
      },
      { locale: "en-US", timeZone: "UTC" },
    );

    expect(text).toBe("Primary window (5 hours): 0% left · Secondary window (7 days): 100% left");
  });

  it("keeps every named bucket and deduplicates only the represented legacy identity", () => {
    const input = {
      checkedAt: "2026-09-29T00:00:00.000Z",
      rateLimits: { limitId: "codex", primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        research: { limitName: "Research quota", primary: { usedPercent: 25 } },
        codex: { limitId: "codex", primary: { usedPercent: 25 } },
        other: { limitName: "Other quota", primary: { usedPercent: 25 } },
      },
    };
    const buckets = formatCodexRateLimitBuckets(input);
    expect(buckets.map((bucket) => bucket.id)).toEqual(["codex", "research", "other"]);
    expect(buckets.map((bucket) => bucket.primary?.value)).toEqual([
      "75% left",
      "75% left",
      "75% left",
    ]);
    expect(buckets[1]?.label).toBe("Research quota");
    expect(
      selectCodexRateLimitBuckets({
        ...input,
        rateLimits: { limitId: "legacy-only", primary: { usedPercent: 10 } },
      }).map((bucket) => bucket.id),
    ).toContain("legacy-only");
    expect(formatCodexRateLimitInlineText(input)).toContain(
      "Research quota: Primary window: 75% left",
    );
  });

  it("shows named-only bucket data when the backward-compatible view is empty", () => {
    const presentation = formatCodexRateLimitPresentation({
      checkedAt: "2026-09-29T00:00:00.000Z",
      rateLimits: {},
      rateLimitsByLimitId: { unfamiliar: { primary: { usedPercent: 100 } } },
      rateLimitResetCredits: { availableCount: 0 },
    });
    expect(presentation?.buckets).toHaveLength(1);
    expect(presentation?.buckets[0]?.label).toBe("unfamiliar");
    expect(presentation?.buckets[0]?.primary?.value).toBe("0% left");
    expect(presentation?.resetAvailability).toBe("Usage limit resets available: 0");
  });

  it.each([
    { credits: null, expected: null },
    { credits: undefined, expected: null },
    {
      credits: { hasCredits: true, unlimited: true, balance: null },
      expected: ["Credits: Unlimited"],
    },
    {
      credits: { hasCredits: false, unlimited: true, balance: "9007199254740993.0001" },
      expected: ["Credits: Unlimited (balance: 9,007,199,254,740,993)"],
    },
    {
      credits: { hasCredits: true, unlimited: true, balance: "0" },
      expected: ["Credits: Unlimited (balance: 0)"],
    },
    {
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      expected: ["Credits: 0 available"],
    },
    {
      credits: { hasCredits: false, unlimited: false, balance: "000.000" },
      expected: ["Credits: 0 available"],
    },
    {
      credits: { hasCredits: true, unlimited: false, balance: "0.00" },
      expected: ["Credits: 0 available"],
    },
    {
      credits: { hasCredits: true, unlimited: false, balance: null },
      expected: ["Credits: Available (balance not reported)"],
    },
    {
      credits: { hasCredits: true, unlimited: false },
      expected: ["Credits: Available (balance not reported)"],
    },
    {
      credits: { hasCredits: true, unlimited: false, balance: "  " },
      expected: ["Credits: Available (balance not reported)"],
    },
    {
      credits: { hasCredits: false, unlimited: false, balance: null },
      expected: ["Credits: None available"],
    },
    {
      credits: { hasCredits: false, unlimited: false },
      expected: ["Credits: None available"],
    },
    {
      credits: { hasCredits: false, unlimited: false, balance: "  " },
      expected: ["Credits: None available"],
    },
    {
      credits: { hasCredits: true, unlimited: false, balance: "9007199254740993.0001" },
      expected: ["Credits: 9,007,199,254,740,993 available"],
    },
    {
      credits: { hasCredits: false, unlimited: false, balance: "9.99" },
      expected: ["Credits: None available (balance: 9.99)"],
    },
    {
      credits: { hasCredits: false, unlimited: false, balance: `0.${"0".repeat(400)}1` },
      expected: ["Credits: None available (balance: 0)"],
    },
    {
      credits: { hasCredits: false, unlimited: false, balance: "0e-9999" },
      expected: ["Credits: None available (balance: 0e-9999)"],
    },
    {
      credits: { hasCredits: false, unlimited: false, balance: "unknown" },
      expected: ["Credits: None available (balance: unknown)"],
    },
    {
      credits: { hasCredits: true, unlimited: false, balance: "Infinity" },
      expected: ["Credits: Available (balance: Infinity)"],
    },
    {
      credits: { hasCredits: true, unlimited: false, balance: "NaN" },
      expected: ["Credits: Available (balance: NaN)"],
    },
  ])(
    "preserves credits-only availability, nulls and decimal balances: $credits",
    ({ credits, expected }) => {
      const summary = formatCodexRateLimitSummary({
        checkedAt: "2026-09-29T00:00:00.000Z",
        rateLimits: credits === undefined ? {} : { credits },
      });
      expect(summary ? summary.details.map((line) => line.text) : null).toEqual(expected);
      expect(summary?.details.some((line) => line.label === "Credit balance") ?? false).toBe(false);
    },
  );

  it("uses the same single credit line in shared presentation and inline summaries", () => {
    const input = {
      checkedAt: "2026-09-29T00:00:00.000Z",
      rateLimits: {
        limitId: "codex",
        credits: { hasCredits: true, unlimited: false, balance: "10000000000000000.00001" },
      },
    };
    const text = "Credits: 10,000,000,000,000,000 available";
    expect(formatCodexRateLimitPresentation(input)?.buckets[0]?.details).toEqual([
      { label: "Credits", value: "10,000,000,000,000,000 available", text },
    ]);
    expect(formatCodexRateLimitInlineText(input)).toBe(text);
  });

  it.each([
    ["0", "0"],
    ["-0.000", "0"],
    ["+000.00", "0"],
    ["120.000", "120"],
    ["545.0317780000", "545.03"],
    ["62492.22", "62,492.22"],
    ["999.995", "1,000"],
    ["1000.005", "1,000.01"],
    ["-12345.678", "-12,345.68"],
    ["+0001000.00", "1,000"],
    ["1.200", "1.2"],
    ["1.00499999999999999999", "1"],
    ["1.005", "1.01"],
    ["-1.005", "-1.01"],
    ["-1.00499999999999999999", "-1"],
    ["9.999", "10"],
    ["-9.995", "-10"],
    [".005", "0.01"],
    ["-.005", "-0.01"],
    [".004", "0"],
    ["-.004", "0"],
    ["+0009.995", "10"],
    ["120.", "120"],
    ["9007199254740993.995", "9,007,199,254,740,994"],
    ["123456789012345678901234567890.0000001234", "123,456,789,012,345,678,901,234,567,890"],
    ["999999999999999999999999999999.995", "1,000,000,000,000,000,000,000,000,000,000"],
    [`0.${"0".repeat(400)}1`, "0"],
  ])("rounds and groups only the displayed balance %s to %s", (balance, expected) => {
    const credits = Object.freeze({ hasCredits: true, unlimited: false, balance });
    const input = Object.freeze({
      checkedAt: "2026-09-30T00:00:00.000Z",
      rateLimits: Object.freeze({ limitId: "codex", credits }),
    });
    expect(formatCodexRateLimitSummary(input)?.details.map((line) => line.text)).toEqual([
      `Credits: ${expected} available`,
    ]);
    expect(input.rateLimits.credits.balance).toBe(balance);
    expect(input.rateLimits.credits.hasCredits).toBe(true);
    expect(input.rateLimits.credits.unlimited).toBe(false);
  });

  it.each([
    {
      credits: { hasCredits: false, unlimited: false, balance: "0.000001" },
      expected: "None available (balance: 0)",
    },
    {
      credits: { hasCredits: false, unlimited: false, balance: "-0.000001" },
      expected: "None available (balance: 0)",
    },
    {
      credits: { hasCredits: false, unlimited: false, balance: "1.005" },
      expected: "None available (balance: 1.01)",
    },
    {
      credits: { hasCredits: false, unlimited: true, balance: "1.005" },
      expected: "Unlimited (balance: 1.01)",
    },
    {
      credits: { hasCredits: true, unlimited: true, balance: "<not-a-decimal>" },
      expected: "Unlimited (balance: <not-a-decimal>)",
    },
    {
      credits: { hasCredits: true, unlimited: false, balance: "1e-3" },
      expected: "Available (balance: 1e-3)",
    },
  ])(
    "keeps availability and opaque metadata independent of rounding: $credits",
    ({ credits, expected }) => {
      const snapshot = structuredClone(credits);
      expect(
        formatCodexRateLimitSummary({
          checkedAt: "2026-09-30T00:00:00.000Z",
          rateLimits: { credits },
        })?.details.map((line) => line.text),
      ).toEqual([`Credits: ${expected}`]);
      expect(credits).toEqual(snapshot);
    },
  );

  it("shows individual spend amounts, zero remaining and provider-classified exhaustion", () => {
    const summary = formatCodexRateLimitSummary(
      {
        checkedAt: "2026-09-29T00:00:00.000Z",
        rateLimits: {
          individualLimit: {
            used: "12.50",
            limit: "12.50",
            remainingPercent: 0,
            resetsAt: 1_780_172_059,
          },
          spendControlReached: true,
          rateLimitReachedType: "workspace_member_usage_limit_reached",
        },
      },
      { locale: "en-US", timeZone: "UTC" },
    );
    expect(summary?.details.map((line) => line.text)).toEqual([
      expect.stringMatching(/^Individual spend limit: 12\.50 used of 12\.50 \(0% left\), resets /),
      "Spend control: Limit reached",
      "Limit reached: Workspace member usage limit reached",
    ]);
  });

  it("does not interpret an unknown reason or infer exhaustion from absent fields", () => {
    const summary = formatCodexRateLimitSummary({
      checkedAt: "2026-09-29T00:00:00.000Z",
      rateLimits: {
        individualLimit: null,
        spendControlReached: false,
        rateLimitReachedType: "__proto__",
      },
    });
    // An unreached spend control is the normal state and gets no row.
    expect(summary?.details.map((line) => line.text)).toEqual(["Limit reached: __proto__"]);
  });

  it.each([
    [15, "15m reset:"],
    [1_440, "1d reset:"],
    [1_572, "1d 2h 12m reset:"],
    [null, "Secondary reset:"],
  ])("labels a secondary reset from its reported duration %s", (duration, expected) => {
    const summary = formatCodexRateLimitSummary(
      {
        checkedAt: "2026-09-29T00:00:00.000Z",
        rateLimits: { secondary: { windowDurationMins: duration, resetsAt: 1_780_172_059 } },
      },
      { locale: "en-US", timeZone: "UTC" },
    );
    expect(summary?.secondary).toBeNull();
    expect(summary?.secondaryReset).toContain(expected);
    expect(summary?.secondaryReset).not.toContain("Weekly");
  });
});
