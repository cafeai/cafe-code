import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { CodexCompactionObservation, type ProviderTaskOwner } from "@cafecode/contracts";
import {
  makeCodexCompactionDiagnosticsTracker,
  readCodexCompactionObservation,
  readMatchingCodexCompactionObservation,
  readMatchingCodexCompactionObservationField,
} from "./codexCompactionDiagnostics.ts";

const now = "2026-10-15T00:00:00.000Z";
const later = "2026-10-15T00:00:01.000Z";
const root = { type: "root" as const };
const child = { type: "child" as const, id: "native-child" };
const tokens = (usedTokens = 420_000) => ({
  last: {
    inputTokens: 400_000,
    cachedInputTokens: 300_000,
    outputTokens: 20_000,
    reasoningOutputTokens: 12_000,
    totalTokens: usedTokens,
  },
  total: {
    inputTokens: 900_000,
    cachedInputTokens: 700_000,
    outputTokens: 80_000,
    reasoningOutputTokens: 42_000,
    totalTokens: 980_000,
  },
  modelContextWindow: 760_000,
});
const source = (sourceOwner: ProviderTaskOwner = root, nativeTurnId = "native-turn") => ({
  sourceId: sourceOwner.type === "child" ? sourceOwner.id : "native-root",
  sourceOwner,
  observedAt: now,
  nativeTurnId,
});
function fixture() {
  const tracker = makeCodexCompactionDiagnosticsTracker();
  tracker.setRootOpeningRequests({ contextWindow: 800_000, autoCompactTokenLimit: 700_000 });
  tracker.observeUsage({ ...source(), tokenUsage: tokens() });
  const observation = tracker.observeCompaction({
    ...source(),
    phase: "started",
    nativeItemId: "native-item",
  });
  if (!observation) throw Error("Fixture must contain a finite compaction observation");
  return { tracker, observation };
}

describe("finite Codex compaction diagnostics", () => {
  it("reconstructs only finite own fields without inferring thresholds or double-counting reasoning", () => {
    const { observation } = fixture();
    const value = {
      ...observation,
      privateExtra: "private-diagnostic-extra",
      sourceOwner: { ...observation.sourceOwner, secret: "private-owner-extra" },
      rootOpeningRequests: { ...observation.rootOpeningRequests, secret: "private-opening-extra" },
      lastReportedUsageBeforeStart: {
        ...observation.lastReportedUsageBeforeStart,
        secret: "private-usage-extra",
      },
    };
    const read = readCodexCompactionObservation(value);
    expect(read).toEqual(observation);
    expect(read).not.toBe(value);
    expect(JSON.stringify(read)).not.toContain("private-");
    expect(read?.lastReportedUsageBeforeStart).toMatchObject({
      usedTokens: 420_000,
      reasoningOutputTokens: 12_000,
      totalProcessedTokens: 980_000,
      reportedUsableContextWindow: 760_000,
    });
    expect(read).toMatchObject({
      triggerReason: "unreported",
      accountingScope: "unreported",
      resolvedThreshold: null,
    });
    expect(Schema.is(CodexCompactionObservation)(read)).toBe(true);
  });

  it("refuses legacy, malformed scalars, impossible dates and inconsistent pre-start ordering", () => {
    const { observation } = fixture();
    for (const value of [
      undefined,
      null,
      [],
      {},
      Object.create(observation),
      { ...observation, version: 2 },
      { ...observation, phase: "updated" },
      { ...observation, observedAt: "2026-02-30T00:00:00.000Z" },
      { ...observation, observedAt: "2026-10-15T00:00:00Z" },
      { ...observation, startObservedAt: "2026-02-29T00:00:00.000Z" },
      { ...observation, nativeItemId: "" },
      { ...observation, nativeItemId: "x".repeat(513) },
      { ...observation, nativeTurnId: "bad\u0000" },
      { ...observation, sourceOwner: { type: "child", id: "bad\u202e" } },
      { ...observation, rootOpeningRequests: {} },
      { ...observation, lastReportedUsageBeforeStart: null },
      { ...observation, usageEvidence: "not-observed" },
      { ...observation, startObservedAt: null },
      { ...observation, triggerReason: "token-limit" },
      { ...observation, resolvedThreshold: 700_000 },
      {
        ...observation,
        lastReportedUsageBeforeStart: {
          ...observation.lastReportedUsageBeforeStart,
          order: observation.order,
        },
      },
    ])
      expect(readCodexCompactionObservation(value)).toBeNull();
    for (const bad of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1n, "1"]) {
      for (const field of ["order", "evictedSourceCount", "evictedItemCount"])
        expect(readCodexCompactionObservation({ ...observation, [field]: bad })).toBeNull();
      expect(
        readCodexCompactionObservation({
          ...observation,
          lastReportedUsageBeforeStart: {
            ...observation.lastReportedUsageBeforeStart,
            usedTokens: bad,
          },
        }),
      ).toBeNull();
      expect(
        readCodexCompactionObservation({
          ...observation,
          rootOpeningRequests: {
            contextWindow: bad,
            autoCompactTokenLimit: null,
          },
        }),
      ).toBeNull();
    }
  });

  it("does not execute accessors or read inherited nested fields", () => {
    const { observation } = fixture();
    let reads = 0;
    const getter = () => {
      reads++;
      throw Error("Never execute received getters");
    };
    for (const field of Object.keys(observation)) {
      const value = Object.defineProperty({ ...observation }, field, { get: getter });
      expect(readCodexCompactionObservation(value)).toBeNull();
    }
    for (const [field, nested] of [
      ["sourceOwner", child],
      ["rootOpeningRequests", observation.rootOpeningRequests],
      ["lastReportedUsageBeforeStart", observation.lastReportedUsageBeforeStart],
    ] as const) {
      expect(
        readCodexCompactionObservation({ ...observation, [field]: Object.create(nested) }),
      ).toBeNull();
      for (const key of Object.keys(nested ?? {}))
        expect(
          readCodexCompactionObservation({
            ...observation,
            [field]: Object.defineProperty({ ...nested }, key, { get: getter }),
          }),
        ).toBeNull();
    }
    expect(
      readMatchingCodexCompactionObservationField(
        Object.defineProperty({}, "codexCompactionObservation", { get: getter }),
        { phase: "started", nativeItemId: "native-item", sourceOwner: root },
      ),
    ).toBeNull();
    expect(
      readCodexCompactionObservation(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw Error("Descriptor unavailable");
            },
          },
        ),
      ),
    ).toBeNull();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    // Revocation makes Array.isArray throw before descriptor inspection. It
    // must remain inert unknown evidence at every received nesting boundary.
    expect(readCodexCompactionObservation(revoked.proxy)).toBeNull();
    for (const field of ["sourceOwner", "rootOpeningRequests", "lastReportedUsageBeforeStart"])
      expect(readCodexCompactionObservation({ ...observation, [field]: revoked.proxy })).toBeNull();
    expect(
      readMatchingCodexCompactionObservationField(revoked.proxy, {
        phase: "started",
        nativeItemId: "native-item",
        sourceOwner: root,
      }),
    ).toBeNull();
    expect(reads).toBe(0);
  });

  it("requires exact phase, native item/turn and admitted source rather than receiver targets", () => {
    const { observation } = fixture();
    const expected = {
      phase: "started" as const,
      nativeItemId: "native-item",
      nativeTurnId: "native-turn",
      sourceOwner: root,
    };
    expect(readMatchingCodexCompactionObservation(observation, expected)).toEqual(observation);
    for (const mismatch of [
      { ...expected, phase: "completed" as const },
      { ...expected, nativeItemId: "other-item" },
      { ...expected, nativeTurnId: "parent-routed-turn" },
      { ...expected, sourceOwner: child },
    ])
      expect(readMatchingCodexCompactionObservation(observation, mismatch)).toBeNull();
    expect(
      readMatchingCodexCompactionObservationField(
        { data: { codexCompactionObservation: observation } },
        expected,
      ),
    ).toBeNull();
  });

  it("isolates exact root/child/native-turn tuples and explicitly labels root-only opening requests", () => {
    const tracker = makeCodexCompactionDiagnosticsTracker();
    tracker.setRootOpeningRequests({ contextWindow: 800_000, autoCompactTokenLimit: 600_000 });
    tracker.observeUsage({ ...source(root), tokenUsage: tokens(420_000) });
    tracker.observeUsage({ ...source(child, "child-turn"), tokenUsage: tokens(120_000) });
    tracker.observeUsage({ ...source(child), sourceId: "receiver-child", tokenUsage: tokens(1) });
    const rootStart = tracker.observeCompaction({
      ...source(root),
      phase: "started",
      nativeItemId: "same-id",
    });
    const childStart = tracker.observeCompaction({
      ...source(child, "child-turn"),
      phase: "started",
      nativeItemId: "same-id",
    });
    expect(rootStart?.lastReportedUsageBeforeStart?.usedTokens).toBe(420_000);
    expect(childStart?.lastReportedUsageBeforeStart?.usedTokens).toBe(120_000);
    expect(childStart?.sourceOwner).toEqual(child);
    expect(childStart?.rootOpeningRequests).toEqual({
      contextWindow: 800_000,
      autoCompactTokenLimit: 600_000,
    });
    const otherTurn = tracker.observeCompaction({
      ...source(child, "other-native-turn"),
      phase: "completed",
      nativeItemId: "same-id",
    });
    expect(otherTurn).toMatchObject({
      usageEvidence: "start-not-observed",
      startObservedAt: null,
      lastReportedUsageBeforeStart: null,
    });
  });

  it("preserves the first pre-start sample through duplicate start/completion and post-start usage", () => {
    const { tracker, observation } = fixture();
    tracker.observeUsage({ ...source(), observedAt: later, tokenUsage: tokens(15_000) });
    for (const phase of ["started", "completed", "completed", "started"] as const) {
      const edge = tracker.observeCompaction({
        ...source(),
        observedAt: later,
        phase,
        nativeItemId: "native-item",
      });
      expect(edge?.startObservedAt).toBe(now);
      expect(edge?.lastReportedUsageBeforeStart).toEqual(observation.lastReportedUsageBeforeStart);
      expect(edge?.rootOpeningRequests).toEqual(observation.rootOpeningRequests);
      expect(Schema.is(CodexCompactionObservation)(readCodexCompactionObservation(edge))).toBe(
        true,
      );
    }
    if (!observation.lastReportedUsageBeforeStart) throw Error("Fixture sample must be present");
    expect(() =>
      Object.defineProperty(observation.lastReportedUsageBeforeStart!, "usedTokens", { value: 1 }),
    ).toThrow();
  });

  it("never borrows post-start usage when the start or its original sample was absent", () => {
    const tracker = makeCodexCompactionDiagnosticsTracker();
    const noSample = tracker.observeCompaction({
      ...source(),
      phase: "started",
      nativeItemId: "empty-start",
    });
    tracker.observeUsage({ ...source(), tokenUsage: tokens() });
    expect(
      tracker.observeCompaction({ ...source(), phase: "started", nativeItemId: "empty-start" })
        ?.lastReportedUsageBeforeStart,
    ).toBeNull();
    expect(
      tracker.observeCompaction({ ...source(), phase: "completed", nativeItemId: "empty-start" })
        ?.usageEvidence,
    ).toBe("not-observed");
    const missing = tracker.observeCompaction({
      ...source(),
      phase: "completed",
      nativeItemId: "missing-start",
    });
    expect(missing).toMatchObject({
      usageEvidence: "start-not-observed",
      startObservedAt: null,
      lastReportedUsageBeforeStart: null,
    });
    expect(
      tracker.observeCompaction({ ...source(), phase: "completed", nativeItemId: "missing-start" })
        ?.lastReportedUsageBeforeStart,
    ).toBeNull();
    expect(
      tracker.observeCompaction({ ...source(), phase: "started", nativeItemId: "missing-start" }),
    ).toBeNull();
    expect(noSample?.rootOpeningRequests).toBeNull();
  });

  it("bounds all source and terminal item receipts and reports eviction without backfilling proof", () => {
    const { tracker } = fixture();
    for (let index = 0; index < 32; index++) {
      const sourceOwner = { type: "child" as const, id: `bounded-child-${index}` };
      tracker.observeUsage({ ...source(sourceOwner), tokenUsage: tokens(index) });
    }
    const evicted = tracker.observeCompaction({
      ...source(),
      phase: "completed",
      nativeItemId: "native-item",
    });
    expect(evicted).toMatchObject({
      usageEvidence: "start-not-observed",
      lastReportedUsageBeforeStart: null,
      evictedSourceCount: 2,
      evictedItemCount: 1,
    });
    const itemTracker = makeCodexCompactionDiagnosticsTracker();
    for (let index = 0; index < 9; index++) {
      const edge = itemTracker.observeCompaction({
        ...source(),
        phase: "completed",
        nativeItemId: `terminal-${index}`,
      });
      expect(edge?.evictedItemCount).toBe(index === 8 ? 1 : 0);
    }
    expect(
      itemTracker.observeCompaction({
        ...source(),
        phase: "completed",
        nativeItemId: "terminal-0",
      }),
    ).toMatchObject({
      usageEvidence: "start-not-observed",
      evictedItemCount: 2,
    });
    const startTracker = makeCodexCompactionDiagnosticsTracker();
    startTracker.observeUsage({ ...source(), tokenUsage: tokens() });
    for (let index = 0; index < 9; index++)
      startTracker.observeCompaction({
        ...source(),
        phase: "started",
        nativeItemId: `started-${index}`,
      });
    expect(
      startTracker.observeCompaction({
        ...source(),
        phase: "completed",
        nativeItemId: "started-0",
      }),
    ).toMatchObject({
      usageEvidence: "start-not-observed",
      lastReportedUsageBeforeStart: null,
      evictedItemCount: 2,
    });
  });

  it("rejects malformed native samples and resets only for successful-opening calls or retirement", () => {
    const tracker = makeCodexCompactionDiagnosticsTracker();
    let reads = 0;
    tracker.observeUsage({
      ...source(),
      tokenUsage: Object.defineProperty({}, "last", {
        get() {
          reads++;
          return tokens().last;
        },
      }),
    });
    tracker.observeUsage({ ...source(), tokenUsage: Object.create(tokens()) });
    tracker.observeUsage({
      ...source(),
      tokenUsage: { ...tokens(), last: { ...tokens().last, totalTokens: -1 } },
    });
    expect(
      tracker.observeCompaction({ ...source(), phase: "started", nativeItemId: "no-safe-sample" })
        ?.usageEvidence,
    ).toBe("not-observed");
    expect(reads).toBe(0);
    tracker.observeUsage({ ...source(), tokenUsage: tokens() });
    tracker.setRootOpeningRequests({ contextWindow: null, autoCompactTokenLimit: null });
    expect(
      tracker.observeCompaction({
        ...source(),
        phase: "completed",
        nativeItemId: "no-safe-sample",
      }),
    ).toMatchObject({
      order: 1,
      usageEvidence: "start-not-observed",
      rootOpeningRequests: { contextWindow: null, autoCompactTokenLimit: null },
      evictedItemCount: 0,
      evictedSourceCount: 0,
    });
    tracker.retire();
    tracker.setRootOpeningRequests({ contextWindow: 800_000, autoCompactTokenLimit: 800_000 });
    tracker.observeUsage({ ...source(), tokenUsage: tokens() });
    expect(
      tracker.observeCompaction({ ...source(), phase: "started", nativeItemId: "late-item" }),
    ).toBeNull();
  });
});
