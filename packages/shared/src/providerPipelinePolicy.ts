/**
 * Finite limits for the provider -> daemon -> backend -> WebSocket hot path.
 *
 * These defaults are deliberately centralized.  A count-only queue is not a
 * meaningful bound when one provider event can contain megabytes of command
 * output, and an Effect fiber cannot preempt synchronous JSON work.  Tests may
 * construct smaller policies, but production code must never replace these
 * limits with an unbounded queue or callback loop.
 */
export const PROVIDER_PIPELINE_POLICY = {
  canonicalEventMaxBytes: 256 * 1024,
  canonicalTextPreviewChars: 4 * 1024,
  canonicalCommandPreviewChars: 8 * 1024,
  canonicalMaxDepth: 6,
  canonicalMaxObjectKeys: 64,
  canonicalMaxArrayItems: 64,
  daemonReplayPageRecords: 128,
  daemonReplayPageBytes: 2 * 1024 * 1024,
  daemonWriterMaxRecords: 256,
  daemonWriterMaxBytes: 4 * 1024 * 1024,
  ndjsonMaxLineBytes: 512 * 1024,
  ndjsonMaxPendingBytes: 4 * 1024 * 1024,
  bridgeQueueMaxRecords: 256,
  bridgeQueueMaxBytes: 4 * 1024 * 1024,
  bridgeQueueHighWaterBytes: 3 * 1024 * 1024,
  bridgeQueueLowWaterBytes: 1024 * 1024,
  workTurnMaxRecords: 32,
  workTurnMaxBytes: 512 * 1024,
  workTurnMaxElapsedMs: 8,
  subscriptionReplayMaxEvents: 2_048,
  subscriptionReplayMaxBytes: 8 * 1024 * 1024,
  subscriptionQueueMaxEvents: 512,
  subscriptionQueueMaxBytes: 4 * 1024 * 1024,
  webSocketConnectionMaxEvents: 512,
  webSocketConnectionMaxBytes: 8 * 1024 * 1024,
  webSocketReservedControlBytes: 512 * 1024,
  // Small thread detail snapshots may still use one frame. Larger histories are
  // emitted as bounded snapshot-chunk items, so this remains a per-frame ceiling
  // and must never be raised to accommodate an entire long-running thread.
  webSocketMaxFrameBytes: 7 * 1024 * 1024,
} as const;

export interface ProviderPipelinePolicy {
  readonly canonicalEventMaxBytes: number;
  readonly canonicalTextPreviewChars: number;
  readonly canonicalCommandPreviewChars: number;
  readonly canonicalMaxDepth: number;
  readonly canonicalMaxObjectKeys: number;
  readonly canonicalMaxArrayItems: number;
  readonly daemonReplayPageRecords: number;
  readonly daemonReplayPageBytes: number;
  readonly daemonWriterMaxRecords: number;
  readonly daemonWriterMaxBytes: number;
  readonly ndjsonMaxLineBytes: number;
  readonly ndjsonMaxPendingBytes: number;
  readonly bridgeQueueMaxRecords: number;
  readonly bridgeQueueMaxBytes: number;
  readonly bridgeQueueHighWaterBytes: number;
  readonly bridgeQueueLowWaterBytes: number;
  readonly workTurnMaxRecords: number;
  readonly workTurnMaxBytes: number;
  readonly workTurnMaxElapsedMs: number;
  readonly subscriptionReplayMaxEvents: number;
  readonly subscriptionReplayMaxBytes: number;
  readonly subscriptionQueueMaxEvents: number;
  readonly subscriptionQueueMaxBytes: number;
  readonly webSocketConnectionMaxEvents: number;
  readonly webSocketConnectionMaxBytes: number;
  readonly webSocketReservedControlBytes: number;
  readonly webSocketMaxFrameBytes: number;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Encoded JSON size helper kept outside Effectful hot paths and diagnostics. */
export function encodedJsonByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
}

export function validateProviderPipelinePolicy(policy: ProviderPipelinePolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new RangeError(`${name} must be a positive finite integer`);
    }
  }
  if (policy.bridgeQueueLowWaterBytes >= policy.bridgeQueueHighWaterBytes) {
    throw new RangeError("bridgeQueueLowWaterBytes must be below bridgeQueueHighWaterBytes");
  }
  if (policy.bridgeQueueHighWaterBytes > policy.bridgeQueueMaxBytes) {
    throw new RangeError("bridgeQueueHighWaterBytes must not exceed bridgeQueueMaxBytes");
  }
  if (policy.ndjsonMaxLineBytes > policy.ndjsonMaxPendingBytes) {
    throw new RangeError("ndjsonMaxLineBytes must not exceed ndjsonMaxPendingBytes");
  }
  if (policy.webSocketReservedControlBytes >= policy.webSocketConnectionMaxBytes) {
    throw new RangeError("webSocketReservedControlBytes must be below webSocketConnectionMaxBytes");
  }
  if (
    policy.webSocketMaxFrameBytes >
    policy.webSocketConnectionMaxBytes - policy.webSocketReservedControlBytes
  ) {
    throw new RangeError("webSocketMaxFrameBytes must fit inside the bulk connection lane");
  }
}

validateProviderPipelinePolicy(PROVIDER_PIPELINE_POLICY);
