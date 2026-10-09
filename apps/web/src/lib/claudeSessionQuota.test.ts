import { describe, expect, it } from "vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionQuotaReport,
} from "@cafecode/contracts";
import {
  CLAUDE_QUOTA_STALE_AFTER_MS,
  formatClaudeSessionQuota,
  selectedQuotaDriver,
} from "./claudeSessionQuota";

const observedAt = "2026-10-09T00:00:00.000Z";
const report: ProviderSessionQuotaReport = {
  source: "claude-session",
  observedAt,
  meters: [
    {
      kind: "session",
      group: "session",
      usedPercent: 23.456,
      resetsAt: "2026-10-09T05:00:00.000Z",
      severity: "normal",
      isActive: true,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      usedPercent: 100,
      resetsAt: null,
      severity: "critical",
      isActive: false,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      modelLabel: "Same label",
      surfaceLabel: "CLI",
      usedPercent: 0,
      resetsAt: null,
      severity: "normal",
      isActive: false,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      modelLabel: "Same label",
      surfaceLabel: "CLI",
      usedPercent: 0,
      resetsAt: null,
      severity: "normal",
      isActive: false,
    },
  ],
};
const options = { now: Date.parse(observedAt), locale: "en-US", timeZone: "Asia/Tokyo" };
const localZoneLabel = (timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(new Date(observedAt))
    .find((part) => part.type === "timeZoneName")!.value;
describe("Claude session quota presentation", () => {
  it("does not borrow an old Claude driver when the selected account has changed", () => {
    const old = {
      instanceId: ProviderInstanceId.make("claude-personal"),
      driver: ProviderDriverKind.make("claudeAgent"),
    };
    const session = { providerInstanceId: old.instanceId, provider: old.driver };
    expect(
      selectedQuotaDriver({ instanceId: ProviderInstanceId.make("codex"), snapshot: old, session }),
    ).toBe("codex");
    expect(
      selectedQuotaDriver({ instanceId: ProviderInstanceId.make("grok"), snapshot: old, session }),
    ).toBe("grok");
    expect(
      selectedQuotaDriver({
        instanceId: ProviderInstanceId.make("new-unconfigured"),
        snapshot: old,
        session,
      }),
    ).toBeUndefined();
    expect(selectedQuotaDriver({ instanceId: old.instanceId, session })).toBe("claudeAgent");
    expect(
      selectedQuotaDriver({
        instanceId: old.instanceId,
        configuredDriver: ProviderDriverKind.make("codex"),
        snapshot: old,
        session,
      }),
    ).toBe("codex");
  });
  it("preserves provider row order, duplicate scope labels and reported precision", () => {
    const result = formatClaudeSessionQuota(report, options);
    expect(result.meters?.map((row) => row.label)).toEqual([
      "Session window",
      "Weekly (all models)",
      "Weekly · Same label · CLI",
      "Weekly · Same label · CLI",
    ]);
    expect(new Set(result.meters?.map((row) => row.id)).size).toBe(4);
    expect(result.meters?.map((row) => row.value)).toEqual([
      "76.544% left",
      "0% left",
      "100% left",
      "100% left",
    ]);
    expect(result.meters?.[0]).toMatchObject({
      severity: "normal",
      isActive: true,
      group: "Session",
    });
    expect(result.observed).toContain(localZoneLabel("Asia/Tokyo"));
    expect(result.meters?.[0]?.reset).toContain(localZoneLabel("Asia/Tokyo"));
  });
  it("marks aged and expired observations stale without refilling allowance", () => {
    const aged = formatClaudeSessionQuota(report, {
      ...options,
      now: options.now + CLAUDE_QUOTA_STALE_AFTER_MS,
    });
    expect(aged.stale).toBe(true);
    expect(aged.meters?.[0]?.value).toBe("Last reported: 76.544% left");
    const reset = formatClaudeSessionQuota(
      { ...report, observedAt: "2026-10-09T05:00:00.000Z" },
      { ...options, now: Date.parse("2026-10-09T05:00:00.000Z") },
    );
    expect(reset.stale).toBe(false);
    expect(reset.meters?.[0]).toMatchObject({ stale: true, remainingPercent: 76.544 });
    expect(reset.meters?.[0]?.reset).toContain("Reset passed");
    expect(reset.meters?.[1]?.stale).toBe(false);
  });
  it("keeps missing and explicitly empty meters distinct", () => {
    expect(formatClaudeSessionQuota({ ...report, meters: null }, options).meters).toBeNull();
    expect(formatClaudeSessionQuota({ ...report, meters: [] }, options).meters).toEqual([]);
  });
  it("keeps extra usage separate and preserves zero, disabled and exact currency units", () => {
    const extra = {
      enabled: false,
      monthlyLimit: 0,
      usedCredits: 0,
      usedPercent: 0,
      currency: "USD",
    };
    expect(formatClaudeSessionQuota({ ...report, extraUsage: extra }, options).extraUsage).toEqual([
      "Extra usage: Disabled",
      "0% of extra-usage limit used",
      "Used: USD 0.00",
      "Monthly limit: USD 0.00",
    ]);
    expect(
      formatClaudeSessionQuota(
        { ...report, extraUsage: { ...extra, usedCredits: Number.MAX_SAFE_INTEGER } },
        options,
      ).extraUsage?.[2],
    ).toBe("Used: USD 90,071,992,547,409.91");
    expect(
      formatClaudeSessionQuota(
        { ...report, extraUsage: { ...extra, currency: "JPY", usedCredits: 1234 } },
        options,
      ).extraUsage?.[2],
    ).toBe("Used: JPY 1,234");
    expect(
      formatClaudeSessionQuota(
        { ...report, extraUsage: { ...extra, currency: "KWD", usedCredits: 1234 } },
        options,
      ).extraUsage?.[2],
    ).toBe("Used: KWD 1.234");
    expect(
      formatClaudeSessionQuota(
        { ...report, extraUsage: { ...extra, currency: null, usedCredits: 1234 } },
        options,
      ).extraUsage?.[2],
    ).toBe("Used: 1,234 minor units (currency unavailable)");
    expect(formatClaudeSessionQuota({ ...report, extraUsage: null }, options).extraUsage).toEqual([
      "Extra usage unavailable.",
    ]);
    expect(formatClaudeSessionQuota(report, options).extraUsage).toEqual([
      "Extra usage not reported.",
    ]);
    expect(
      formatClaudeSessionQuota(
        {
          ...report,
          extraUsage: { ...extra, usedCredits: null, monthlyLimit: null, usedPercent: null },
        },
        options,
      ).extraUsage,
    ).toEqual([
      "Extra usage: Disabled",
      "Extra-usage utilization: Unavailable",
      "Used: Unavailable",
      "Monthly limit: Unavailable",
    ]);
    expect(
      formatClaudeSessionQuota(
        { ...report, extraUsage: { ...extra, currency: "unrecognized", usedCredits: 1234 } },
        options,
      ).extraUsage[2],
    ).toBe("Used: 1,234 minor units (currency: unrecognized; conversion unavailable)");
  });
  it("uses explicit local zone labels and leaves unknown kinds inert", () => {
    const result = formatClaudeSessionQuota(
      {
        ...report,
        meters: [
          {
            ...report.meters![0]!,
            kind: "future_meter",
            group: "future group",
            modelLabel: '<img src=x onerror="evil()">',
          },
        ],
      },
      { ...options, timeZone: "America/New_York" },
    );
    expect(result.observed).toContain(localZoneLabel("America/New_York"));
    expect(result.meters?.[0]?.label).toBe('future_meter · <img src=x onerror="evil()">');
    expect(result.meters?.[0]?.reset).toContain(localZoneLabel("America/New_York"));
  });
});
