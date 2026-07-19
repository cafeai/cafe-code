import { OrchestrationGetSnapshotError } from "@cafecode/contracts";
import {
  encodedJsonByteLength,
  PROVIDER_PIPELINE_POLICY,
} from "@cafecode/shared/providerPipelinePolicy";
import {
  addProviderWebSocketDiagnostics,
  recordProviderWebSocketFrame,
  releaseProviderWebSocketFrame,
} from "@cafecode/shared/providerPipelineDiagnostics";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface WebSocketConnectionFlowSnapshot {
  readonly activeBulkFrames: number;
  readonly activeBulkBytes: number;
  readonly largestFrameBytes: number;
  readonly serializationTimeMs: number;
  readonly overloadCloseCount: number;
}

export interface WebSocketConnectionFlowControl {
  readonly wrapBulkStream: <A, E, R>(
    stream: Stream.Stream<A, E, R>,
  ) => Stream.Stream<A, E | OrchestrationGetSnapshotError, R>;
  readonly snapshot: () => WebSocketConnectionFlowSnapshot;
}

/**
 * Effect RPC's public stream protocol writes one stream chunk, waits for Ack,
 * and only then invokes the next pull. This Cafe-owned adapter uses that next
 * pull invocation as the send-completion seam. The release must happen before
 * waiting for the upstream pull to produce another value: thread subscriptions
 * are intentionally idle between events, and retaining the previous frame while
 * awaiting an event would leak one permit per subscribed thread forever.
 *
 * Rechunking to one item also makes the accounting unit match Effect RPC's wire
 * unit (`Chunk.values`). Without it, a source chunk containing many individually
 * bounded snapshot parts could be serialized into one oversized RPC frame.
 * Unary/control RPCs bypass the bulk budget, which reserves capacity for Ack,
 * interrupt, approval, user-input, heartbeat, and error progress.
 */
export function makeWebSocketConnectionFlowControl(options?: {
  readonly maxConnectionBytes?: number;
  readonly reservedControlBytes?: number;
  readonly maxFrameBytes?: number;
}): WebSocketConnectionFlowControl {
  const maxConnectionBytes = Math.max(
    1,
    Math.trunc(options?.maxConnectionBytes ?? PROVIDER_PIPELINE_POLICY.webSocketConnectionMaxBytes),
  );
  const reservedControlBytes = Math.max(
    0,
    Math.min(
      maxConnectionBytes - 1,
      Math.trunc(
        options?.reservedControlBytes ?? PROVIDER_PIPELINE_POLICY.webSocketReservedControlBytes,
      ),
    ),
  );
  const bulkByteLimit = maxConnectionBytes - reservedControlBytes;
  const maxFrameBytes = Math.max(
    1,
    Math.trunc(options?.maxFrameBytes ?? PROVIDER_PIPELINE_POLICY.webSocketMaxFrameBytes),
  );
  let activeBulkFrames = 0;
  let activeBulkBytes = 0;
  let largestFrameBytes = 0;
  let serializationTimeMs = 0;
  let overloadCloseCount = 0;
  let turnFrames = 0;
  let turnBytes = 0;
  let turnStartedAt = performance.now();

  const wrapBulkStream: WebSocketConnectionFlowControl["wrapBulkStream"] = (stream) => {
    let heldBytes = 0;
    const release = (): void => {
      if (heldBytes === 0) return;
      activeBulkBytes = Math.max(0, activeBulkBytes - heldBytes);
      activeBulkFrames = Math.max(0, activeBulkFrames - 1);
      releaseProviderWebSocketFrame(heldBytes);
      heldBytes = 0;
    };

    return Stream.transformPull(Stream.rechunk(stream, 1), (pull) =>
      Effect.succeed(
        Effect.gen(function* () {
          // RpcServer starts this pull only after the previous Chunk is Acked.
          // Release before invoking upstream because that pull can remain
          // suspended indefinitely while a live subscription is idle.
          release();
          const values = yield* pull;
          const startedAt = performance.now();
          const bytes = encodedJsonByteLength(values);
          const serializationElapsedMs = performance.now() - startedAt;
          serializationTimeMs += serializationElapsedMs;
          largestFrameBytes = Math.max(largestFrameBytes, bytes);
          if (
            bytes > maxFrameBytes ||
            activeBulkFrames >= PROVIDER_PIPELINE_POLICY.webSocketConnectionMaxEvents ||
            activeBulkBytes + bytes > bulkByteLimit
          ) {
            overloadCloseCount += 1;
            addProviderWebSocketDiagnostics({ overloadCloseCount: 1 });
            return yield* new OrchestrationGetSnapshotError({
              message: "WebSocket subscription exceeded its bounded output window; reload snapshot",
              cause: "websocket-resync-required",
            });
          }
          heldBytes = bytes;
          activeBulkBytes += bytes;
          activeBulkFrames += 1;
          recordProviderWebSocketFrame(bytes, serializationElapsedMs);
          turnFrames += 1;
          turnBytes += bytes;
          if (
            turnFrames >= PROVIDER_PIPELINE_POLICY.workTurnMaxRecords ||
            turnBytes >= PROVIDER_PIPELINE_POLICY.workTurnMaxBytes ||
            performance.now() - turnStartedAt >= PROVIDER_PIPELINE_POLICY.workTurnMaxElapsedMs
          ) {
            yield* Effect.yieldNow;
            turnFrames = 0;
            turnBytes = 0;
            turnStartedAt = performance.now();
          }
          return values;
        }),
      ),
    ).pipe(Stream.ensuring(Effect.sync(release)));
  };

  return {
    wrapBulkStream,
    snapshot: () => ({
      activeBulkFrames,
      activeBulkBytes,
      largestFrameBytes,
      serializationTimeMs,
      overloadCloseCount,
    }),
  };
}
