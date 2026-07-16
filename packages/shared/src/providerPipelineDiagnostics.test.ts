import { beforeEach, describe, expect, it } from "vitest";

import {
  addProviderBackendBridgeDiagnostics,
  addProviderDaemonStreamDiagnostics,
  addProviderWebSocketDiagnostics,
  recordProviderBackendBridgeLine,
  recordProviderCompaction,
  recordProviderPipelineEventLoopLagForTest,
  recordProviderQuarantinedRow,
  recordProviderWebSocketFrame,
  releaseProviderWebSocketFrame,
  resetProviderPipelineDiagnosticsForTest,
  setProviderBackendBridgeDiagnostics,
  setProviderDaemonStreamDiagnostics,
  setProviderSubscriptionDiagnostics,
  snapshotProviderPipelineDiagnostics,
} from "./providerPipelineDiagnostics.ts";

describe("provider pipeline diagnostics", () => {
  beforeEach(() => resetProviderPipelineDiagnosticsForTest());

  it("accounts for queue admission and release with bounded numeric fields", () => {
    recordProviderCompaction({
      originalBytes: 2_147_130,
      canonicalBytes: 200_000,
      compacted: true,
      historicalRepair: true,
    });
    recordProviderQuarantinedRow();
    setProviderDaemonStreamDiagnostics({
      activeStreamCount: 1,
      queuedLiveRecords: 2,
      queuedLiveBytes: 4_000,
    });
    addProviderDaemonStreamDiagnostics({ drainWaitCount: 1, replayRecordCount: 2 });
    setProviderBackendBridgeDiagnostics({ pendingBytes: 1_024 });
    addProviderBackendBridgeDiagnostics({ decodedRecordCount: 2, acceptedRecordCount: 2 });
    recordProviderBackendBridgeLine(512);
    recordProviderBackendBridgeLine(256);
    setProviderSubscriptionDiagnostics({
      cursor: 42,
      activeThreadSubscribers: 32,
      replayRingBytes: 8_192,
    });
    recordProviderWebSocketFrame(4_096, 1.25);
    releaseProviderWebSocketFrame(4_096);
    addProviderWebSocketDiagnostics({ overloadCloseCount: 1 });

    const snapshot = snapshotProviderPipelineDiagnostics();
    expect(snapshot.compaction).toMatchObject({
      compactedEventCount: 1,
      historicalRepairCount: 1,
      quarantinedRowCount: 1,
      originalBytes: 2_147_130,
      canonicalBytes: 200_000,
      largestCanonicalBytes: 200_000,
    });
    expect(snapshot.daemonStream).toMatchObject({
      activeStreamCount: 1,
      drainWaitCount: 1,
      queuedLiveRecords: 2,
      queuedLiveBytes: 4_000,
    });
    expect(snapshot.backendBridge).toMatchObject({
      pendingBytes: 1_024,
      largestLineBytes: 512,
      decodedRecordCount: 2,
      acceptedRecordCount: 2,
    });
    expect(snapshot.subscriptions.activeThreadSubscribers).toBe(32);
    expect(snapshot.webSocket).toMatchObject({
      activeBulkFrames: 0,
      activeBulkBytes: 0,
      largestFrameBytes: 4_096,
      overloadCloseCount: 1,
    });
  });

  it("has a payload-free, bounded-cardinality JSON shape", () => {
    const json = JSON.stringify(snapshotProviderPipelineDiagnostics());
    expect(json).not.toContain("prompt");
    expect(json).not.toContain("output");
    expect(json).not.toContain("token");
    expect(json).not.toContain("threadId");
    expect(Object.keys(snapshotProviderPipelineDiagnostics())).toEqual([
      "eventLoop",
      "compaction",
      "daemonStream",
      "backendBridge",
      "subscriptions",
      "webSocket",
    ]);
  });

  it("rotates the event-loop sample window and computes stable percentiles", () => {
    for (let lagMs = 0; lagMs <= 600; lagMs += 1) {
      recordProviderPipelineEventLoopLagForTest(lagMs);
    }

    const eventLoop = snapshotProviderPipelineDiagnostics().eventLoop;
    expect(eventLoop.retainedSampleCount).toBe(600);
    expect(eventLoop.currentLagMs).toBe(600);
    expect(eventLoop.p50LagMs).toBe(300);
    expect(eventLoop.p95LagMs).toBe(570);
    expect(eventLoop.p99LagMs).toBe(594);
    expect(eventLoop.maxLagMs).toBe(600);
  });
});
