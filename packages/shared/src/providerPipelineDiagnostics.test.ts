import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addProviderBackendBridgeDiagnostics,
  addProviderDaemonStreamDiagnostics,
  addProviderWebSocketDiagnostics,
  recordProviderBackendBridgeLine,
  recordProviderCompaction,
  recordProviderPipelineEventLoopLagForTest,
  recordProviderQuarantinedRow,
  recordProviderWebSocketFrame,
  registerSqliteWorkerDiagnostics,
  releaseProviderWebSocketFrame,
  resetProviderPipelineDiagnosticsForTest,
  setProviderBackendBridgeDiagnostics,
  setProviderDaemonStreamDiagnostics,
  setProviderSubscriptionDiagnostics,
  snapshotProviderPipelineDiagnostics,
} from "./providerPipelineDiagnostics.ts";

describe("provider pipeline diagnostics", () => {
  beforeEach(() => resetProviderPipelineDiagnosticsForTest());

  it("retains authentication failure totals separately from the current retry delay", () => {
    addProviderBackendBridgeDiagnostics({ authenticationFailureCount: 1 });
    setProviderBackendBridgeDiagnostics({
      lastAuthenticationFailureStatus: 401,
      authenticationRetryDelayMs: 30_000,
    });
    expect(snapshotProviderPipelineDiagnostics().backendBridge).toMatchObject({
      authenticationFailureCount: 1,
      lastAuthenticationFailureStatus: 401,
      authenticationRetryDelayMs: 30_000,
    });

    // Recovery clears the current wait, not the evidence of a prior rejected
    // credential. Process-wide reset is reserved for isolated test fixtures.
    setProviderBackendBridgeDiagnostics({ authenticationRetryDelayMs: 0 });
    expect(snapshotProviderPipelineDiagnostics().backendBridge).toMatchObject({
      authenticationFailureCount: 1,
      lastAuthenticationFailureStatus: 401,
      authenticationRetryDelayMs: 0,
    });
    resetProviderPipelineDiagnosticsForTest();
    expect(snapshotProviderPipelineDiagnostics().backendBridge).toMatchObject({
      authenticationFailureCount: 0,
      lastAuthenticationFailureStatus: 0,
      authenticationRetryDelayMs: 0,
    });
  });

  it("tracks only live SQLite owners and ignores duplicate or retired completions", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const first = registerSqliteWorkerDiagnostics();
    const second = registerSqliteWorkerDiagnostics();
    try {
      const finishFirst = first.beginOperation();
      clock.mockReturnValue(150);
      const finishSecond = second.beginOperation();
      clock.mockReturnValue(200);
      expect(snapshotProviderPipelineDiagnostics().sqlite).toEqual({
        activeConnectionCount: 2,
        activeOperationCount: 2,
        completedOperationCount: 0,
        failedOperationCount: 0,
        workerFailureCount: 0,
        longestActiveOperationMs: 100,
      });

      finishFirst("success");
      clock.mockReturnValue(230);
      const finishNewFirst = first.beginOperation();
      // A duplicate completion belongs to the former operation. It cannot
      // erase the newer active operation or increment successful work twice.
      finishFirst("success");
      finishSecond("failure");
      expect(snapshotProviderPipelineDiagnostics().sqlite).toMatchObject({
        activeConnectionCount: 2,
        activeOperationCount: 1,
        completedOperationCount: 1,
        failedOperationCount: 1,
        longestActiveOperationMs: 0,
      });

      first.recordWorkerFailure();
      first.recordWorkerFailure();
      first.close();
      first.close();
      finishNewFirst("success");
      first.beginOperation()("failure");
      second.close();
      expect(snapshotProviderPipelineDiagnostics().sqlite).toEqual({
        activeConnectionCount: 0,
        activeOperationCount: 0,
        completedOperationCount: 1,
        failedOperationCount: 1,
        workerFailureCount: 1,
        longestActiveOperationMs: 0,
      });
    } finally {
      first.close();
      second.close();
      clock.mockRestore();
    }
  });

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
      "sqlite",
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
