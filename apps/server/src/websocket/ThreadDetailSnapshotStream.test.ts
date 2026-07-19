import * as Crypto from "node:crypto";

import {
  MessageId,
  OrchestrationThreadDetailSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES,
  TurnId,
  type OrchestrationThreadDetailSnapshot as OrchestrationThreadDetailSnapshotType,
} from "@cafecode/contracts";
import {
  encodedJsonByteLength,
  PROVIDER_PIPELINE_POLICY,
} from "@cafecode/shared/providerPipelinePolicy";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { encodeThreadDetailSnapshotStreamItems } from "./ThreadDetailSnapshotStream.ts";

const decodeThreadDetailSnapshotJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(OrchestrationThreadDetailSnapshot),
);

function makeSnapshot(text: string): OrchestrationThreadDetailSnapshotType {
  const threadId = ThreadId.make("thread-large-snapshot");
  const turnId = TurnId.make("turn-large-snapshot");
  const now = "2026-07-19T00:00:00.000Z";
  return {
    snapshotSequence: 42,
    thread: {
      id: threadId,
      projectId: ProjectId.make("project-large-snapshot"),
      title: "Large thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: MessageId.make("message-large-snapshot"),
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      messages: [
        {
          id: MessageId.make("message-large-snapshot"),
          role: "assistant",
          text,
          turnId,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: turnId,
        lastError: null,
        updatedAt: now,
      },
    },
  };
}

describe("thread detail snapshot stream encoding", () => {
  it("preserves the legacy snapshot item when it fits in one frame", () => {
    const snapshot = makeSnapshot("small response");
    expect(encodeThreadDetailSnapshotStreamItems(snapshot)).toEqual([
      { kind: "snapshot", snapshot },
    ]);
  });

  it("chunks an oversized snapshot below the WebSocket frame ceiling without data loss", () => {
    const snapshot = makeSnapshot(`start🙂${"x".repeat(7 * 1024 * 1024)}end`);
    const items = encodeThreadDetailSnapshotStreamItems(snapshot);

    expect(items.length).toBeGreaterThan(1);
    expect(items.every((item) => item.kind === "snapshot-chunk")).toBe(true);
    expect(
      items.every(
        (item) => encodedJsonByteLength(item) < PROVIDER_PIPELINE_POLICY.webSocketMaxFrameBytes,
      ),
    ).toBe(true);

    const chunks = items.flatMap((item) =>
      item.kind === "snapshot-chunk" ? [Buffer.from(item.data, "base64")] : [],
    );
    const bytes = Buffer.concat(chunks);
    const first = items[0];
    expect(first?.kind).toBe("snapshot-chunk");
    if (!first || first.kind !== "snapshot-chunk") {
      throw new Error("Expected chunked snapshot output");
    }

    expect(first.chunkCount).toBe(items.length);
    expect(first.chunkCount).toBe(
      Math.ceil(first.encodedBytes / THREAD_DETAIL_SNAPSHOT_CHUNK_RAW_BYTES),
    );
    expect(bytes.byteLength).toBe(first.encodedBytes);
    expect(Crypto.createHash("sha256").update(bytes).digest("hex")).toBe(first.sha256);
    expect(decodeThreadDetailSnapshotJson(bytes.toString("utf8"))).toEqual(snapshot);
  });
});
