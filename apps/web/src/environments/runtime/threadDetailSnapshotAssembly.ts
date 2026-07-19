import {
  OrchestrationThreadDetailSnapshot,
  THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES,
  type OrchestrationThreadDetailSnapshot as OrchestrationThreadDetailSnapshotType,
  type OrchestrationThreadDetailSnapshotChunk,
  type ThreadId,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";

const decodeThreadDetailSnapshotJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(OrchestrationThreadDetailSnapshot),
);

type OwnedBytes = Uint8Array<ArrayBuffer>;

export interface ThreadDetailSnapshotAssembly {
  readonly snapshotSequence: number;
  readonly sha256: string;
  readonly chunkCount: number;
  readonly encodedBytes: number;
  readonly chunks: Array<OwnedBytes | null>;
  receivedChunkCount: number;
}

export interface ThreadDetailSnapshotAppendResult {
  readonly assembly: ThreadDetailSnapshotAssembly | null;
  readonly completedBytes: OwnedBytes | null;
}

function isBase64AlphabetCode(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f
  );
}

/**
 * Decode canonical base64 without accepting whitespace or alternate spellings.
 * Strict decoding prevents a remote environment from smuggling unexpectedly
 * large data through a short-looking chunk and makes duplicate detection exact.
 */
function decodeCanonicalBase64(data: string): OwnedBytes {
  if (data.length === 0 || data.length % 4 !== 0) {
    throw new Error("Thread detail snapshot chunk has invalid base64 length");
  }

  let paddingStart = data.length;
  if (data.endsWith("==")) {
    paddingStart -= 2;
  } else if (data.endsWith("=")) {
    paddingStart -= 1;
  }
  for (let index = 0; index < paddingStart; index += 1) {
    if (!isBase64AlphabetCode(data.charCodeAt(index))) {
      throw new Error("Thread detail snapshot chunk has invalid base64 data");
    }
  }
  for (let index = paddingStart; index < data.length; index += 1) {
    if (data.charCodeAt(index) !== 0x3d) {
      throw new Error("Thread detail snapshot chunk has invalid base64 padding");
    }
  }

  const binary = globalThis.atob(data);
  if (globalThis.btoa(binary) !== data) {
    throw new Error("Thread detail snapshot chunk base64 data is not canonical");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function makeAssembly(chunk: OrchestrationThreadDetailSnapshotChunk): ThreadDetailSnapshotAssembly {
  const expectedChunkCount = Math.ceil(chunk.encodedBytes / THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES);
  if (chunk.chunkCount !== expectedChunkCount) {
    throw new Error("Thread detail snapshot chunk count does not match its declared byte length");
  }
  if (chunk.chunkIndex !== 0) {
    throw new Error("Thread detail snapshot assembly did not begin with chunk zero");
  }

  return {
    snapshotSequence: chunk.snapshotSequence,
    sha256: chunk.sha256,
    chunkCount: chunk.chunkCount,
    encodedBytes: chunk.encodedBytes,
    chunks: Array.from({ length: chunk.chunkCount }, () => null),
    receivedChunkCount: 0,
  };
}

function assertMatchingAssembly(
  assembly: ThreadDetailSnapshotAssembly,
  chunk: OrchestrationThreadDetailSnapshotChunk,
): void {
  if (
    assembly.snapshotSequence !== chunk.snapshotSequence ||
    assembly.sha256 !== chunk.sha256 ||
    assembly.chunkCount !== chunk.chunkCount ||
    assembly.encodedBytes !== chunk.encodedBytes
  ) {
    throw new Error("Thread detail snapshot chunk metadata changed during assembly");
  }
}

/**
 * Append one validated wire chunk. The function allocates the final contiguous
 * buffer only after every exact-size chunk is present, so partial reconnects do
 * not repeatedly copy an ever-growing snapshot.
 */
export function appendThreadDetailSnapshotChunk(
  current: ThreadDetailSnapshotAssembly | null,
  chunk: OrchestrationThreadDetailSnapshotChunk,
): ThreadDetailSnapshotAppendResult {
  const assembly = current ?? makeAssembly(chunk);
  assertMatchingAssembly(assembly, chunk);

  if (chunk.chunkIndex >= assembly.chunkCount) {
    throw new Error("Thread detail snapshot chunk index is out of bounds");
  }

  const decoded = decodeCanonicalBase64(chunk.data);
  const expectedLength =
    chunk.chunkIndex === chunk.chunkCount - 1
      ? chunk.encodedBytes - THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES * (chunk.chunkCount - 1)
      : THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES;
  if (decoded.byteLength !== expectedLength) {
    throw new Error("Thread detail snapshot chunk byte length is invalid");
  }

  const existing = assembly.chunks[chunk.chunkIndex] ?? null;
  if (existing !== null) {
    if (!equalBytes(existing, decoded)) {
      throw new Error("Thread detail snapshot duplicate chunk content changed");
    }
  } else {
    assembly.chunks[chunk.chunkIndex] = decoded;
    assembly.receivedChunkCount += 1;
  }

  if (assembly.receivedChunkCount !== assembly.chunkCount) {
    return { assembly, completedBytes: null };
  }

  const completedBytes = new Uint8Array(assembly.encodedBytes);
  let offset = 0;
  for (const part of assembly.chunks) {
    if (part === null) {
      throw new Error("Thread detail snapshot assembly completed with a missing chunk");
    }
    completedBytes.set(part, offset);
    offset += part.byteLength;
  }
  if (offset !== assembly.encodedBytes) {
    throw new Error("Thread detail snapshot assembled byte length is invalid");
  }

  return { assembly: null, completedBytes };
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

async function verifySha256(bytes: OwnedBytes, expectedSha256: string): Promise<void> {
  // Web Crypto is present in Electron and secure browser contexts. In an
  // explicitly insecure HTTP browser context it may be unavailable; the
  // authenticated RPC stream, exact byte/chunk bounds, and schema validation
  // remain authoritative there, while WSS/desktop receive the extra corruption
  // check. Cafe must not make its documented HTTP compatibility listener
  // unusable solely because the browser withholds SubtleCrypto.
  if (!globalThis.crypto?.subtle) {
    return;
  }

  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  if (bytesToHex(digest) !== expectedSha256) {
    throw new Error("Thread detail snapshot SHA-256 verification failed");
  }
}

/** Verify, decode, and schema-check a complete snapshot before store mutation. */
export async function decodeThreadDetailSnapshotAssembly(input: {
  readonly bytes: OwnedBytes;
  readonly expectedSha256: string;
  readonly expectedSnapshotSequence: number;
  readonly expectedThreadId: ThreadId;
}): Promise<OrchestrationThreadDetailSnapshotType> {
  await verifySha256(input.bytes, input.expectedSha256);
  const json = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  const snapshot = decodeThreadDetailSnapshotJson(json);
  if (snapshot.snapshotSequence !== input.expectedSnapshotSequence) {
    throw new Error("Thread detail snapshot sequence does not match chunk metadata");
  }
  if (snapshot.thread.id !== input.expectedThreadId) {
    throw new Error("Thread detail snapshot thread does not match its subscription");
  }
  return snapshot;
}
