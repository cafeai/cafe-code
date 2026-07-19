import * as Crypto from "node:crypto";

import {
  OrchestrationThreadDetailSnapshot,
  THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES,
  THREAD_DETAIL_SNAPSHOT_MAX_BYTES,
  THREAD_DETAIL_SNAPSHOT_MAX_CHUNKS,
  type OrchestrationThreadDetailSnapshot as OrchestrationThreadDetailSnapshotType,
  type OrchestrationThreadStreamItem,
} from "@cafecode/contracts";
import { PROVIDER_PIPELINE_POLICY } from "@cafecode/shared/providerPipelinePolicy";
import * as Schema from "effect/Schema";

const encodeThreadDetailSnapshotJson = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationThreadDetailSnapshot),
);

// The object wrapper adds only a few dozen bytes. Keeping a full KiB of
// headroom avoids coupling this decision to Effect RPC's current envelope while
// the connection flow controller remains the final authority for frame size.
const LEGACY_SNAPSHOT_FRAME_HEADROOM_BYTES = 1024;

export class ThreadDetailSnapshotEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadDetailSnapshotEncodingError";
  }
}

/**
 * Encode one projection snapshot into the existing single-frame shape when it
 * fits, otherwise into fixed-size base64 chunks. The SHA-256 is calculated over
 * the exact UTF-8 JSON bytes so the renderer can reject missing, reordered, or
 * corrupted assemblies before any partial state reaches the store.
 */
export function encodeThreadDetailSnapshotStreamItems(
  snapshot: OrchestrationThreadDetailSnapshotType,
): ReadonlyArray<OrchestrationThreadStreamItem> {
  const json = encodeThreadDetailSnapshotJson(snapshot);
  const bytes = Buffer.from(json, "utf8");

  if (
    bytes.byteLength + LEGACY_SNAPSHOT_FRAME_HEADROOM_BYTES <=
    PROVIDER_PIPELINE_POLICY.webSocketMaxFrameBytes
  ) {
    return [{ kind: "snapshot", snapshot }];
  }

  if (bytes.byteLength > THREAD_DETAIL_SNAPSHOT_MAX_BYTES) {
    throw new ThreadDetailSnapshotEncodingError(
      `Thread detail snapshot is ${bytes.byteLength} bytes; maximum is ${THREAD_DETAIL_SNAPSHOT_MAX_BYTES}`,
    );
  }

  const chunkCount = Math.ceil(bytes.byteLength / THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES);
  if (chunkCount < 1 || chunkCount > THREAD_DETAIL_SNAPSHOT_MAX_CHUNKS) {
    throw new ThreadDetailSnapshotEncodingError(
      `Thread detail snapshot requires invalid chunk count ${chunkCount}`,
    );
  }

  const sha256 = Crypto.createHash("sha256").update(bytes).digest("hex");
  const items: OrchestrationThreadStreamItem[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES;
    const end = Math.min(start + THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES, bytes.byteLength);
    items.push({
      kind: "snapshot-chunk",
      snapshotSequence: snapshot.snapshotSequence,
      sha256,
      chunkIndex,
      chunkCount,
      encodedBytes: bytes.byteLength,
      data: bytes.subarray(start, end).toString("base64"),
    });
  }

  return items;
}
