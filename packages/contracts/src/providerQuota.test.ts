import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { ProviderSession } from "./provider.ts";
import { ProviderRuntimeEvent } from "./providerRuntime.ts";
import {
  ProviderSessionQuotaInput,
  ProviderSessionQuotaReport,
  ProviderSessionQuotaResult,
  PROVIDER_SESSION_QUOTA_MAX_METERS,
} from "./providerQuota.ts";

const observedAt = "2026-10-09T01:00:00.000Z";
const meter = {
  kind: "weekly_scoped",
  group: "weekly",
  usedPercent: 0.5,
  resetsAt: null,
  modelLabel: "Future model",
  surfaceLabel: "Code",
  severity: "normal",
  isActive: false,
};
const report = { source: "claude-session", observedAt, meters: [meter] } as const;
const decode = Schema.decodeUnknownSync(ProviderSessionQuotaReport);
const decodeResult = Schema.decodeUnknownSync(ProviderSessionQuotaResult);
const decodeSession = Schema.decodeUnknownSync(ProviderSession);
const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodeInput = Schema.decodeUnknownSync(ProviderSessionQuotaInput);
const json = Schema.fromJsonString(ProviderSessionQuotaReport);
const decodeJson = Schema.decodeUnknownSync(json);
const encodeJson = Schema.encodeSync(json);

describe("passive session quota contracts", () => {
  it("preserves independent rows, decimal percentage units and unavailable/empty distinctions", () => {
    expect(decode({ ...report, meters: [meter, meter] }).meters).toHaveLength(2);
    expect(decode(report).meters?.[0]?.usedPercent).toBe(0.5);
    expect(decode({ ...report, meters: null }).meters).toBeNull();
    expect(decode({ ...report, meters: [] }).meters).toEqual([]);
    expect(decodeResult({ report: null })).toEqual({
      report: null,
    });
    expect(decodeJson(encodeJson(report))).toEqual(report);
  });

  it("accepts safe minor-unit amounts without assuming a currency", () => {
    const extraUsage = { enabled: false, monthlyLimit: 0, usedCredits: null, usedPercent: null };
    expect(decode({ ...report, extraUsage }).extraUsage).toEqual(extraUsage);
    expect(
      decode({ ...report, extraUsage: { ...extraUsage, currency: null } }).extraUsage?.currency,
    ).toBeNull();
    expect(
      decode({ ...report, extraUsage: { ...extraUsage, currency: "unknown" } }).extraUsage
        ?.currency,
    ).toBe("unknown");
    expect(decode({ ...report, extraUsage: null }).extraUsage).toBeNull();
    expect(() =>
      decode({
        ...report,
        extraUsage: { ...extraUsage, usedCredits: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow();
    expect(() => decode({ ...report, extraUsage: { ...extraUsage, monthlyLimit: 0.5 } })).toThrow();
  });

  it.each([NaN, Infinity, -Infinity, -0.1, 100.1])(
    "rejects invalid percentage %s",
    (usedPercent) => {
      expect(() => decode({ ...report, meters: [{ ...meter, usedPercent }] })).toThrow();
    },
  );

  it("bounds rows and rejects ambiguous timestamps or hostile metadata", () => {
    expect(() =>
      decode({
        ...report,
        meters: Array.from({ length: PROVIDER_SESSION_QUOTA_MAX_METERS + 1 }, () => meter),
      }),
    ).toThrow();
    for (const label of ["", "   ", "bad\nlabel", "bad\u202elabel", "\ud800", "x".repeat(257)]) {
      expect(() => decode({ ...report, meters: [{ ...meter, modelLabel: label }] })).toThrow();
    }
    for (const timestamp of [
      "2026-02-30T00:00:00.000Z",
      "2026-10-09",
      "2026-10-09T01:00:00+00:00",
    ]) {
      expect(() => decode({ ...report, observedAt: timestamp })).toThrow();
      expect(() => decode({ ...report, meters: [{ ...meter, resetsAt: timestamp }] })).toThrow();
    }
  });

  it("keeps old session snapshots decodable and sends only an invalidation in runtime events", () => {
    const session = {
      provider: "claudeAgent",
      status: "ready",
      runtimeMode: "full-access",
      threadId: "quota-thread",
      createdAt: observedAt,
      updatedAt: observedAt,
    };
    expect(decodeSession(session).quotaReport).toBeUndefined();
    expect(decodeSession({ ...session, quotaReport: report }).quotaReport).toEqual(report);
    const event = decodeRuntimeEvent({
      type: "session.configured",
      eventId: "quota-event",
      provider: "claudeAgent",
      createdAt: observedAt,
      threadId: "quota-thread",
      payload: { config: {}, quotaReportChanged: true },
    });
    expect(event.payload).toEqual({ config: {}, quotaReportChanged: true });
    expect(decodeInput({ instanceId: "claude-one" })).toEqual({ instanceId: "claude-one" });
    expect(() =>
      decodeInput({
        instanceId: "claude-one",
        session: { threadId: "quota-thread", runtimeId: "not-a-query-uuid" },
      }),
    ).toThrow();
  });
});
