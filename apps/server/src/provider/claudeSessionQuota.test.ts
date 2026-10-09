import { describe, expect, it } from "vitest";
import { PROVIDER_SESSION_QUOTA_MAX_METERS } from "@cafecode/contracts";
import { mapClaudeSessionQuotaReport, stripClaudeUsageReport } from "./claudeSessionQuota.ts";

const observedAt = "2026-10-09T01:00:00.000Z";
const row = {
  kind: "weekly_scoped",
  group: "weekly",
  percent: 0.5,
  resets_at: "2026-10-09T10:00:00.000000+09:00",
  scope: { model: { display_name: "Future model" }, surface: { display_name: "Code" } },
  severity: "normal",
  is_active: false,
};
const raw = { session: { private_total: "not-a-quota-field" }, rate_limits: { limits: [row] } };
const map = (value: unknown) => mapClaudeSessionQuotaReport(value, observedAt);
const unavailable = { source: "claude-session", observedAt, meters: null };

describe("Claude passive session quota projection", () => {
  it("preserves all ordered model/surface meters without conflating decimal units or duplicate labels", () => {
    const report = map({
      ...raw,
      rate_limits: {
        limits: [
          { ...row, kind: "session", group: "session", percent: 0, scope: null, is_active: true },
          { ...row, kind: "weekly_all", percent: 100, scope: null },
          row,
          { ...row, severity: "future-inert-severity" },
        ],
      },
    });
    expect(report.meters?.map((meter) => meter.usedPercent)).toEqual([0, 100, 0.5, 0.5]);
    expect(report.meters?.[2]).toEqual({
      kind: "weekly_scoped",
      group: "weekly",
      usedPercent: 0.5,
      resetsAt: observedAt,
      modelLabel: "Future model",
      surfaceLabel: "Code",
      severity: "normal",
      isActive: false,
    });
    expect(report).not.toHaveProperty("session");
  });

  it("distinguishes missing current rows, explicit empty rows, and paid extra usage", () => {
    expect(map({ rate_limits: null })).toEqual(unavailable);
    expect(map({ rate_limits: { limits: null } })).toEqual(unavailable);
    expect(map({ rate_limits: { limits: [] } }).meters).toEqual([]);
    const extra = { is_enabled: false, monthly_limit: 0, used_credits: null, utilization: null };
    expect(map({ rate_limits: { limits: [], extra_usage: extra } }).extraUsage).toEqual({
      enabled: false,
      monthlyLimit: 0,
      usedCredits: null,
      usedPercent: null,
    });
    expect(map({ rate_limits: { limits: null, extra_usage: null } }).extraUsage).toBeNull();
    expect(
      map({
        rate_limits: { limits: [], extra_usage: { ...extra, currency: "JPY", used_credits: 125 } },
      }).extraUsage?.usedCredits,
    ).toBe(125);
  });

  it("drops arbitrary private/future fields without traversing them", () => {
    const secret = "never-persist-private-quota-field";
    const report = map({
      ...raw,
      privateIdentity: secret,
      behaviors: secret,
      rate_limits: { limits: [{ ...row, credentials: secret }], future: secret },
    });
    expect(JSON.stringify(report)).not.toContain(secret);
    const inherited = Object.create({ rate_limits: { limits: [row] } });
    expect(map(inherited)).toEqual(unavailable);
    const getter = Object.defineProperty({}, "rate_limits", {
      get() {
        throw new Error(secret);
      },
    });
    expect(map(getter)).toEqual(unavailable);
  });

  it("rejects an entire malformed level instead of silently removing a meter or retaining a balance", () => {
    const invalidRows = [
      { ...row, percent: NaN },
      { ...row, percent: Infinity },
      { ...row, percent: -1 },
      { ...row, percent: 101 },
      { ...row, percent: "20" },
      { ...row, is_active: "true" },
      { ...row, resets_at: "2026-02-30T00:00:00Z" },
      { ...row, resets_at: "2026-10-09" },
      { ...row, resets_at: "2026-10-09T24:00:00Z" },
      { ...row, scope: { model: { display_name: "bad\u202elabel" } } },
      { ...row, kind: "x".repeat(65) },
    ];
    for (const invalidRow of invalidRows)
      expect(map({ rate_limits: { limits: [row, invalidRow] } })).toEqual(unavailable);
    expect(
      map({
        rate_limits: {
          limits: Array.from({ length: PROVIDER_SESSION_QUOTA_MAX_METERS + 1 }, () => row),
        },
      }),
    ).toEqual(unavailable);
    expect(map({ rate_limits: {} })).toEqual(unavailable);
    expect(
      map({
        rate_limits: {
          limits: [row],
          extra_usage: { is_enabled: true, monthly_limit: 1.5, used_credits: 0, utilization: 0 },
        },
      }),
    ).toEqual(unavailable);
  });

  it("rejects accessor array entries without evaluating them or retaining valid sibling balances", () => {
    let getterReads = 0;
    const rows = [row, row];
    Object.defineProperty(rows, "1", {
      get() {
        getterReads++;
        return row;
      },
    });
    const report = map({ rate_limits: { limits: rows } });
    expect(getterReads).toBe(0);
    expect(report).toEqual(unavailable);
  });

  it("rejects sparse and inherited array entries without treating them as current meters", () => {
    const sparse = [row];
    sparse.length = 2;
    expect(map({ rate_limits: { limits: sparse } })).toEqual(unavailable);

    // The fixture owns this prototype. Never alter the ambient Array prototype.
    const inherited = [row];
    inherited.length = 2;
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 1: row }));
    expect(map({ rate_limits: { limits: inherited } })).toEqual(unavailable);

    let getterReads = 0;
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, "1", {
      get() {
        getterReads++;
        return row;
      },
    });
    Object.setPrototypeOf(inherited, prototype);
    const report = map({ rate_limits: { limits: inherited } });
    expect(getterReads).toBe(0);
    expect(report).toEqual(unavailable);
  });

  it("does not invoke array methods or species while projecting admitted own entries", () => {
    const rows = [row];
    const getterReads = { map: 0, constructor: 0 };
    for (const key of ["map", "constructor"] as const)
      Object.defineProperty(rows, key, {
        get() {
          getterReads[key]++;
          return undefined;
        },
      });
    expect(map({ rate_limits: { limits: rows } })).toEqual(map(raw));
    expect(getterReads).toEqual({ map: 0, constructor: 0 });

    let speciesReads = 0;
    const speciesRows = [row];
    Object.defineProperty(speciesRows, "constructor", {
      value: Object.defineProperty({}, Symbol.species, {
        get() {
          speciesReads++;
          return Array;
        },
      }),
    });
    expect(map({ rate_limits: { limits: speciesRows } })).toEqual(map(raw));
    expect(speciesReads).toBe(0);
  });

  it("preserves exactly the bounded maximum in order and rejects oversize before visiting indices", () => {
    const rows = Array.from({ length: PROVIDER_SESSION_QUOTA_MAX_METERS }, (_, index) => ({
      ...row,
      percent: index % 101,
    }));
    expect(
      map({ rate_limits: { limits: rows } }).meters?.map((meter) => meter.usedPercent),
    ).toEqual(rows.map((entry) => entry.percent));
    let getterReads = 0;
    const oversized: unknown[] = [];
    oversized.length = PROVIDER_SESSION_QUOTA_MAX_METERS + 1;
    Object.defineProperty(oversized, "0", {
      get() {
        getterReads++;
        return row;
      },
    });
    expect(map({ rate_limits: { limits: oversized } })).toEqual(unavailable);
    expect(getterReads).toBe(0);
  });

  it("strips every structured sibling before any downstream logger while preserving ordinary text", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "ordinary /usage text" }] },
      usage_report: raw,
    };
    const stripped = stripClaudeUsageReport(message);
    expect(stripped.hasReport).toBe(true);
    expect(stripped.report).toBe(raw);
    expect(stripped.message).not.toHaveProperty("usage_report");
    expect(stripped.message.message).toBe(message.message);
    expect(message.usage_report).toBe(raw);
    const getter = Object.defineProperty({ type: "assistant" }, "usage_report", {
      enumerable: true,
      get() {
        throw new Error("must-not-evaluate");
      },
    });
    expect(stripClaudeUsageReport(getter)).toEqual({
      message: { type: "assistant" },
      hasReport: true,
      report: undefined,
    });
    expect(stripClaudeUsageReport({ type: "system", usage_report: raw }).message).toEqual({
      type: "system",
    });
  });

  it("returns ordinary frames unchanged without enumerating or copying their descriptors", () => {
    const inspected: PropertyKey[] = [];
    const message = new Proxy(
      { type: "stream_event", event: { type: "content_block_delta", delta: "token" } },
      {
        getOwnPropertyDescriptor(target, key) {
          inspected.push(key);
          return Object.getOwnPropertyDescriptor(target, key);
        },
        ownKeys() {
          throw new Error("ordinary-frames-must-not-enumerate-descriptors");
        },
      },
    );
    const stripped = stripClaudeUsageReport(message);
    expect(stripped.message).toBe(message);
    expect(stripped.hasReport).toBe(false);
    expect(stripped.report).toBeUndefined();
    expect(inspected).toEqual(["usage_report"]);
  });

  it("never evaluates inherited report accessors and drops the prototype on report-bearing copies", () => {
    const prototype = Object.defineProperty({}, "usage_report", {
      get() {
        throw new Error("inherited-report-must-not-be-evaluated");
      },
    });
    const inherited = Object.assign(Object.create(prototype), { type: "assistant" });
    const absent = stripClaudeUsageReport(inherited);
    expect(absent.message).toBe(inherited);
    expect(absent.hasReport).toBe(false);
    expect(absent.report).toBeUndefined();
    const ownReport = Object.defineProperty(inherited, "usage_report", { value: raw });
    const present = stripClaudeUsageReport(ownReport);
    expect(present.hasReport).toBe(true);
    expect(present.report).toBe(raw);
    expect(present.message).toEqual({ type: "assistant" });
    expect(present.message).not.toHaveProperty("usage_report");
    expect(Object.getPrototypeOf(present.message)).toBe(Object.prototype);
  });
});
