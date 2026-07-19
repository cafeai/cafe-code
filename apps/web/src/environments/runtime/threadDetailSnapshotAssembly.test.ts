import {
  MessageId,
  OrchestrationThreadDetailSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES,
  TurnId,
  type OrchestrationThreadDetailSnapshot as OrchestrationThreadDetailSnapshotType,
  type OrchestrationThreadDetailSnapshotChunk,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  appendThreadDetailSnapshotChunk,
  decodeThreadDetailSnapshotAssembly,
  type ThreadDetailSnapshotAssembly,
} from "./threadDetailSnapshotAssembly";

const encodeThreadDetailSnapshotJson = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationThreadDetailSnapshot),
);

function makeSnapshot(): OrchestrationThreadDetailSnapshotType {
  const threadId = ThreadId.make("thread-chunk-assembly");
  const turnId = TurnId.make("turn-chunk-assembly");
  const now = "2026-07-19T00:00:00.000Z";
  return {
    snapshotSequence: 73,
    thread: {
      id: threadId,
      projectId: ProjectId.make("project-chunk-assembly"),
      title: "Chunk assembly",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      messages: [
        {
          id: MessageId.make("message-chunk-assembly"),
          role: "assistant",
          text: `prefix🙂${"m".repeat(THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES + 128)}suffix`,
          turnId,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}

async function makeChunks(snapshot: OrchestrationThreadDetailSnapshotType): Promise<{
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly chunks: OrchestrationThreadDetailSnapshotChunk[];
}> {
  const bytes = new TextEncoder().encode(encodeThreadDetailSnapshotJson(snapshot));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const chunkCount = Math.ceil(bytes.byteLength / THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES);
  const chunks = Array.from({ length: chunkCount }, (_, chunkIndex) => {
    const start = chunkIndex * THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES;
    const end = Math.min(start + THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES, bytes.byteLength);
    return {
      kind: "snapshot-chunk" as const,
      snapshotSequence: snapshot.snapshotSequence,
      sha256,
      chunkIndex,
      chunkCount,
      encodedBytes: bytes.byteLength,
      data: encodeBase64(bytes.subarray(start, end)),
    };
  });
  return { bytes, chunks };
}

describe("thread detail snapshot assembly", () => {
  it("reassembles, verifies, and decodes a multi-frame snapshot", async () => {
    const snapshot = makeSnapshot();
    const { chunks } = await makeChunks(snapshot);
    let assembly: ThreadDetailSnapshotAssembly | null = null;
    let completedBytes: Uint8Array<ArrayBuffer> | null = null;

    for (const chunk of chunks) {
      const result = appendThreadDetailSnapshotChunk(assembly, chunk);
      assembly = result.assembly;
      completedBytes = result.completedBytes;
    }

    expect(assembly).toBeNull();
    expect(completedBytes).not.toBeNull();
    if (completedBytes === null) {
      throw new Error("Expected completed snapshot bytes");
    }
    await expect(
      decodeThreadDetailSnapshotAssembly({
        bytes: completedBytes,
        expectedSha256: chunks[0]!.sha256,
        expectedSnapshotSequence: snapshot.snapshotSequence,
        expectedThreadId: snapshot.thread.id,
      }),
    ).resolves.toEqual(snapshot);
  });

  it("rejects a content mutation before applying the decoded snapshot", async () => {
    const snapshot = makeSnapshot();
    const { chunks } = await makeChunks(snapshot);
    const first = chunks[0]!;
    chunks[0] = {
      ...first,
      data: `${first.data[0] === "A" ? "B" : "A"}${first.data.slice(1)}`,
    };

    let assembly: ThreadDetailSnapshotAssembly | null = null;
    let completedBytes: Uint8Array<ArrayBuffer> | null = null;
    for (const chunk of chunks) {
      const result = appendThreadDetailSnapshotChunk(assembly, chunk);
      assembly = result.assembly;
      completedBytes = result.completedBytes;
    }
    if (completedBytes === null) {
      throw new Error("Expected completed mutated snapshot bytes");
    }

    await expect(
      decodeThreadDetailSnapshotAssembly({
        bytes: completedBytes,
        expectedSha256: first.sha256,
        expectedSnapshotSequence: snapshot.snapshotSequence,
        expectedThreadId: snapshot.thread.id,
      }),
    ).rejects.toThrow("SHA-256 verification failed");
  });

  it("rejects a nonzero first chunk instead of allocating a partial assembly", async () => {
    const { chunks } = await makeChunks(makeSnapshot());
    expect(() => appendThreadDetailSnapshotChunk(null, chunks[1]!)).toThrow(
      "did not begin with chunk zero",
    );
  });
});
