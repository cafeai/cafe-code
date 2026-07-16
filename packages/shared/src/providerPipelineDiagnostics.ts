// @effect-diagnostics globalTimers:off
import type { ProviderPipelineDiagnostics } from "@cafecode/contracts";

const EVENT_LOOP_SAMPLE_INTERVAL_MS = 100;
const EVENT_LOOP_SAMPLE_CAPACITY = 600;

type CompactionDelta = Partial<ProviderPipelineDiagnostics["compaction"]>;
type DaemonStreamDelta = Partial<ProviderPipelineDiagnostics["daemonStream"]>;
type BackendBridgeDelta = Partial<ProviderPipelineDiagnostics["backendBridge"]>;
type SubscriptionValues = Partial<ProviderPipelineDiagnostics["subscriptions"]>;
type WebSocketDelta = Partial<ProviderPipelineDiagnostics["webSocket"]>;
type MutableMetrics<T> = { -readonly [K in keyof T]: T[K] };

const eventLoopLagSamples: number[] = [];
let eventLoopMonitorStarted = false;

const compaction: MutableMetrics<ProviderPipelineDiagnostics["compaction"]> = {
  compactedEventCount: 0,
  historicalRepairCount: 0,
  quarantinedRowCount: 0,
  originalBytes: 0,
  canonicalBytes: 0,
  largestCanonicalBytes: 0,
};
const daemonStream: MutableMetrics<ProviderPipelineDiagnostics["daemonStream"]> = {
  activeStreamCount: 0,
  replayPageCount: 0,
  replayRecordCount: 0,
  replayBytes: 0,
  drainWaitCount: 0,
  queuedLiveRecords: 0,
  queuedLiveBytes: 0,
  laggingDisconnectCount: 0,
};
const backendBridge: MutableMetrics<ProviderPipelineDiagnostics["backendBridge"]> = {
  pendingBytes: 0,
  largestLineBytes: 0,
  pauseCount: 0,
  pausedMs: 0,
  decodedRecordCount: 0,
  decodeFailureCount: 0,
  acceptedRecordCount: 0,
};
const subscriptions: MutableMetrics<ProviderPipelineDiagnostics["subscriptions"]> = {
  cursor: 0,
  replayRingEvents: 0,
  replayRingBytes: 0,
  activeShellSubscribers: 0,
  activeThreadSubscribers: 0,
  durableTailReadCount: 0,
  durableEventCount: 0,
  catchupReadCount: 0,
  slowSubscriberCloseCount: 0,
  coalescedEventCount: 0,
};
const webSocket: MutableMetrics<ProviderPipelineDiagnostics["webSocket"]> = {
  activeBulkFrames: 0,
  activeBulkBytes: 0,
  largestFrameBytes: 0,
  serializationTimeMs: 0,
  overloadCloseCount: 0,
  connectionOpenCount: 0,
};

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function addNumericFields<T extends Record<string, number>>(target: T, delta: Partial<T>): void {
  for (const key of Object.keys(delta) as Array<keyof T>) {
    const value = delta[key];
    if (value !== undefined) {
      target[key] = finiteNonNegative((target[key] ?? 0) + value) as T[keyof T];
    }
  }
}

function setNumericFields<T extends Record<string, number>>(target: T, values: Partial<T>): void {
  for (const key of Object.keys(values) as Array<keyof T>) {
    const value = values[key];
    if (value !== undefined) target[key] = finiteNonNegative(value) as T[keyof T];
  }
}

function percentile(sorted: ReadonlyArray<number>, quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function recordEventLoopLag(lagMs: number): void {
  eventLoopLagSamples.push(finiteNonNegative(lagMs));
  if (eventLoopLagSamples.length > EVENT_LOOP_SAMPLE_CAPACITY) eventLoopLagSamples.shift();
}

export function startProviderPipelineEventLoopMonitor(): void {
  if (eventLoopMonitorStarted) return;
  eventLoopMonitorStarted = true;
  let expectedAt = performance.now() + EVENT_LOOP_SAMPLE_INTERVAL_MS;
  const timer = setInterval(() => {
    const now = performance.now();
    recordEventLoopLag(now - expectedAt);
    expectedAt = now + EVENT_LOOP_SAMPLE_INTERVAL_MS;
  }, EVENT_LOOP_SAMPLE_INTERVAL_MS);
  timer.unref();
}

/** Deterministic monitor seam for percentile/window tests; do not call in production. */
export function recordProviderPipelineEventLoopLagForTest(lagMs: number): void {
  recordEventLoopLag(lagMs);
}

export function recordProviderCompaction(input: {
  readonly originalBytes: number;
  readonly canonicalBytes: number;
  readonly compacted: boolean;
  readonly historicalRepair?: boolean;
}): void {
  addNumericFields(compaction, {
    compactedEventCount: input.compacted ? 1 : 0,
    historicalRepairCount: input.compacted && input.historicalRepair === true ? 1 : 0,
    originalBytes: input.originalBytes,
    canonicalBytes: input.canonicalBytes,
  });
  compaction.largestCanonicalBytes = Math.max(
    compaction.largestCanonicalBytes,
    finiteNonNegative(input.canonicalBytes),
  );
}

export function recordProviderQuarantinedRow(): void {
  compaction.quarantinedRowCount += 1;
}

export function addProviderDaemonStreamDiagnostics(delta: DaemonStreamDelta): void {
  addNumericFields(daemonStream, delta);
}

export function setProviderDaemonStreamDiagnostics(values: DaemonStreamDelta): void {
  setNumericFields(daemonStream, values);
}

export function addProviderBackendBridgeDiagnostics(delta: BackendBridgeDelta): void {
  addNumericFields(backendBridge, delta);
}

export function recordProviderBackendBridgeLine(bytes: number): void {
  backendBridge.largestLineBytes = Math.max(
    backendBridge.largestLineBytes,
    finiteNonNegative(bytes),
  );
}

export function setProviderBackendBridgeDiagnostics(values: BackendBridgeDelta): void {
  setNumericFields(backendBridge, values);
}

export function setProviderSubscriptionDiagnostics(values: SubscriptionValues): void {
  setNumericFields(subscriptions, values);
}

export function addProviderWebSocketDiagnostics(delta: WebSocketDelta): void {
  addNumericFields(webSocket, delta);
}

export function recordProviderWebSocketFrame(bytes: number, serializationMs: number): void {
  const normalizedBytes = finiteNonNegative(bytes);
  addNumericFields(webSocket, {
    activeBulkFrames: 1,
    activeBulkBytes: normalizedBytes,
    serializationTimeMs: serializationMs,
  });
  webSocket.largestFrameBytes = Math.max(webSocket.largestFrameBytes, normalizedBytes);
}

export function releaseProviderWebSocketFrame(bytes: number): void {
  addNumericFields(webSocket, {
    activeBulkFrames: -1,
    activeBulkBytes: -finiteNonNegative(bytes),
  });
}

export function setProviderWebSocketDiagnostics(values: WebSocketDelta): void {
  setNumericFields(webSocket, values);
}

export function snapshotProviderPipelineDiagnostics(): ProviderPipelineDiagnostics {
  const sorted = eventLoopLagSamples.toSorted((left, right) => left - right);
  return {
    eventLoop: {
      sampleIntervalMs: EVENT_LOOP_SAMPLE_INTERVAL_MS,
      retainedSampleCount: sorted.length,
      currentLagMs: eventLoopLagSamples.at(-1) ?? 0,
      p50LagMs: percentile(sorted, 0.5),
      p95LagMs: percentile(sorted, 0.95),
      p99LagMs: percentile(sorted, 0.99),
      maxLagMs: sorted.at(-1) ?? 0,
    },
    compaction: { ...compaction },
    daemonStream: { ...daemonStream },
    backendBridge: { ...backendBridge },
    subscriptions: { ...subscriptions },
    webSocket: { ...webSocket },
  };
}

/** Test-only reset. Production code must preserve process-lifetime counters. */
export function resetProviderPipelineDiagnosticsForTest(): void {
  eventLoopLagSamples.length = 0;
  setNumericFields(compaction, {
    compactedEventCount: 0,
    historicalRepairCount: 0,
    quarantinedRowCount: 0,
    originalBytes: 0,
    canonicalBytes: 0,
    largestCanonicalBytes: 0,
  } satisfies CompactionDelta);
  setNumericFields(
    daemonStream,
    Object.fromEntries(Object.keys(daemonStream).map((key) => [key, 0])),
  );
  setNumericFields(
    backendBridge,
    Object.fromEntries(Object.keys(backendBridge).map((key) => [key, 0])),
  );
  setNumericFields(
    subscriptions,
    Object.fromEntries(Object.keys(subscriptions).map((key) => [key, 0])),
  );
  setNumericFields(webSocket, Object.fromEntries(Object.keys(webSocket).map((key) => [key, 0])));
}
