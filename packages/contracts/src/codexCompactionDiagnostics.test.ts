import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { CodexCompactionObservation } from "./codexCompactionDiagnostics.ts";
import { ProviderEvent } from "./provider.ts";
import { ProviderRuntimeEvent } from "./providerRuntime.ts";

const observation = {
  version: 1,
  phase: "started",
  sourceOwner: { type: "root" },
  observedAt: "2026-10-15T00:00:01.000Z",
  order: 2,
  nativeTurnId: "turn",
  nativeItemId: "compaction",
  startObservedAt: "2026-10-15T00:00:01.000Z",
  rootOpeningRequests: { contextWindow: 800000, autoCompactTokenLimit: 800000 },
  lastReportedUsageBeforeStart: {
    observedAt: "2026-10-15T00:00:00.000Z",
    order: 1,
    nativeTurnId: "turn",
    usedTokens: 420000,
    inputTokens: 410000,
    cachedInputTokens: 390000,
    outputTokens: 10000,
    reasoningOutputTokens: 9000,
    totalProcessedTokens: 2500000,
    reportedUsableContextWindow: 760000,
  },
  usageEvidence: "received-before-start",
  evictedSourceCount: 0,
  evictedItemCount: 0,
  triggerReason: "unreported",
  accountingScope: "unreported",
  resolvedThreshold: null,
};

describe("content-free Codex compaction diagnostic contracts", () => {
  it("roundtrips nominal requests and native accounting without inventing a resolved threshold", () => {
    const json = Schema.fromJsonString(CodexCompactionObservation);
    const decoded = Schema.decodeUnknownSync(CodexCompactionObservation)(observation);
    expect(decoded).toEqual(observation);
    expect(Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(decoded))).toEqual(observation);
    expect(decoded.lastReportedUsageBeforeStart?.usedTokens).toBe(420000);
    expect(decoded.lastReportedUsageBeforeStart?.reasoningOutputTokens).toBe(9000);
    expect(decoded.resolvedThreshold).toBeNull();
  });

  it("preserves known omission, unknown opening and exact child source as distinct evidence", () => {
    const decode = Schema.decodeUnknownSync(CodexCompactionObservation);
    for (const rootOpeningRequests of [
      null,
      { contextWindow: null, autoCompactTokenLimit: null },
    ]) {
      expect(
        decode({
          ...observation,
          sourceOwner: { type: "child", id: "exact-child" },
          rootOpeningRequests,
        }),
      ).toMatchObject({
        sourceOwner: { type: "child", id: "exact-child" },
        rootOpeningRequests,
      });
    }
    expect(
      decode({ ...observation, lastReportedUsageBeforeStart: null, usageEvidence: "not-observed" }),
    ).toHaveProperty("lastReportedUsageBeforeStart", null);
  });

  it("refuses unsafe counters, invalid dates/identities and guessed native policy", () => {
    const decode = Schema.decodeUnknownSync(CodexCompactionObservation);
    for (const patch of [
      { order: Number.MAX_SAFE_INTEGER + 1 },
      { evictedSourceCount: -1 },
      { evictedItemCount: 0.5 },
      { observedAt: "2026-02-30T00:00:00.000Z" },
      { observedAt: "2026-10-15T00:00:00+00:00" },
      { nativeItemId: "" },
      { nativeItemId: "x".repeat(513) },
      { nativeItemId: "item\u202e" },
      { resolvedThreshold: 720000 },
      { triggerReason: "reasoning-overhead" },
      { accountingScope: "total" },
      { rootOpeningRequests: { contextWindow: Infinity, autoCompactTokenLimit: null } },
      {
        lastReportedUsageBeforeStart: {
          ...observation.lastReportedUsageBeforeStart,
          reasoningOutputTokens: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    ])
      expect(() => decode({ ...observation, ...patch })).toThrow();
  });

  it("keeps the optional evidence outside native payload and allows legacy lifecycle omission", () => {
    const native = {
      id: "event",
      kind: "notification",
      provider: "codex",
      threadId: "chat",
      createdAt: observation.observedAt,
      method: "item/started",
      taskOwner: observation.sourceOwner,
      payload: { item: { type: "contextCompaction" } },
    };
    expect(Schema.decodeUnknownSync(ProviderEvent)(native)).not.toHaveProperty(
      "codexCompactionObservation",
    );
    expect(
      Schema.decodeUnknownSync(ProviderEvent)({
        ...native,
        codexCompactionObservation: observation,
      }),
    ).toHaveProperty("codexCompactionObservation", observation);
    const runtime = {
      eventId: "event",
      type: "item.started",
      provider: "codex",
      threadId: "chat",
      turnId: "turn",
      createdAt: observation.observedAt,
      itemId: "compaction",
      payload: { itemType: "context_compaction", taskOwner: observation.sourceOwner },
    };
    expect(Schema.decodeUnknownSync(ProviderRuntimeEvent)(runtime).payload).not.toHaveProperty(
      "codexCompactionObservation",
    );
    expect(
      Schema.decodeUnknownSync(ProviderRuntimeEvent)({
        ...runtime,
        payload: { ...runtime.payload, codexCompactionObservation: observation },
      }).payload,
    ).toHaveProperty("codexCompactionObservation", observation);
  });
});
