import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

export const ProviderPipelineEventLoopDiagnostics = Schema.Struct({
  sampleIntervalMs: NonNegativeInt,
  retainedSampleCount: NonNegativeInt,
  currentLagMs: Schema.Number,
  p50LagMs: Schema.Number,
  p95LagMs: Schema.Number,
  p99LagMs: Schema.Number,
  maxLagMs: Schema.Number,
});

export const ProviderPipelineCompactionDiagnostics = Schema.Struct({
  compactedEventCount: NonNegativeInt,
  historicalRepairCount: NonNegativeInt,
  quarantinedRowCount: NonNegativeInt,
  originalBytes: NonNegativeInt,
  canonicalBytes: NonNegativeInt,
  largestCanonicalBytes: NonNegativeInt,
});

export const ProviderPipelineDaemonStreamDiagnostics = Schema.Struct({
  activeStreamCount: NonNegativeInt,
  replayPageCount: NonNegativeInt,
  replayRecordCount: NonNegativeInt,
  replayBytes: NonNegativeInt,
  drainWaitCount: NonNegativeInt,
  queuedLiveRecords: NonNegativeInt,
  queuedLiveBytes: NonNegativeInt,
  laggingDisconnectCount: NonNegativeInt,
});

export const ProviderPipelineBackendBridgeDiagnostics = Schema.Struct({
  pendingBytes: NonNegativeInt,
  largestLineBytes: NonNegativeInt,
  pauseCount: NonNegativeInt,
  pausedMs: Schema.Number,
  decodedRecordCount: NonNegativeInt,
  decodeFailureCount: NonNegativeInt,
  acceptedRecordCount: NonNegativeInt,
});

export const ProviderPipelineSubscriptionDiagnostics = Schema.Struct({
  cursor: NonNegativeInt,
  replayRingEvents: NonNegativeInt,
  replayRingBytes: NonNegativeInt,
  activeShellSubscribers: NonNegativeInt,
  activeThreadSubscribers: NonNegativeInt,
  durableTailReadCount: NonNegativeInt,
  durableEventCount: NonNegativeInt,
  catchupReadCount: NonNegativeInt,
  slowSubscriberCloseCount: NonNegativeInt,
  coalescedEventCount: NonNegativeInt,
});

export const ProviderPipelineWebSocketDiagnostics = Schema.Struct({
  activeBulkFrames: NonNegativeInt,
  activeBulkBytes: NonNegativeInt,
  largestFrameBytes: NonNegativeInt,
  serializationTimeMs: Schema.Number,
  overloadCloseCount: NonNegativeInt,
  connectionOpenCount: NonNegativeInt,
});

/**
 * Payload-free, bounded-cardinality metrics for the provider-to-WebSocket path.
 * These contracts intentionally contain no labels, prompts, paths, event bodies,
 * bearer material, or provider error strings.
 */
export const ProviderPipelineDiagnostics = Schema.Struct({
  eventLoop: ProviderPipelineEventLoopDiagnostics,
  compaction: ProviderPipelineCompactionDiagnostics,
  daemonStream: ProviderPipelineDaemonStreamDiagnostics,
  backendBridge: ProviderPipelineBackendBridgeDiagnostics,
  subscriptions: ProviderPipelineSubscriptionDiagnostics,
  webSocket: ProviderPipelineWebSocketDiagnostics,
});
export type ProviderPipelineDiagnostics = typeof ProviderPipelineDiagnostics.Type;
