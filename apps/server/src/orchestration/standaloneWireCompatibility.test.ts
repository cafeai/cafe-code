import { OrchestrationEvent, OrchestrationShellSnapshot, ThreadId } from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  compatibleStandaloneReplayEvents,
  compatibleStandaloneShellEvent,
  compatibleStandaloneShellSnapshot,
} from "./standaloneWireCompatibility.ts";

const now = "2026-10-03T04:00:00.000Z";
const snapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot)({
  snapshotSequence: 10,
  projects: [],
  threads: [null, "project-linked"].map((projectId, index) => ({
    id: `thread-${index}`,
    projectId,
    title: `Chat ${index}`,
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  })),
  updatedAt: now,
});

function event(sequence: number, threadId: string, payload: { projectId?: string | null }) {
  return Schema.decodeUnknownSync(OrchestrationEvent)({
    sequence,
    eventId: `event-${sequence}`,
    type: "thread.meta-updated",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: `command-${sequence}`,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, updatedAt: now, ...payload },
  });
}

describe("standalone read-side wire compatibility", () => {
  it.each([undefined, false])("preserves linked-only catalog for opt-in %s", (optIn) => {
    const result = compatibleStandaloneShellSnapshot(snapshot, optIn);
    expect(result.threads.map((thread) => thread.id)).toEqual(["thread-1"]);
    expect(result.snapshotSequence).toBe(10);
    expect(snapshot.threads).toHaveLength(2);
    expect(result.projects).toBe(snapshot.projects);
  });

  it("returns the exact authoritative catalog when opted in", () => {
    expect(compatibleStandaloneShellSnapshot(snapshot, true)).toBe(snapshot);
  });

  it("removes a detached linked row from only the legacy shell view", () => {
    const standalone = snapshot.threads[0]!;
    const upsert = { kind: "thread-upserted" as const, sequence: 11, thread: standalone };
    expect(compatibleStandaloneShellEvent(upsert, undefined)).toEqual({
      kind: "thread-removed",
      sequence: 11,
      threadId: standalone.id,
    });
    expect(compatibleStandaloneShellEvent(upsert, true)).toBe(upsert);
    expect(standalone.deletedAt).toBeNull();
    expect(standalone.archivedAt).toBeNull();
  });

  it("keeps linked upserts and authoritative removal events unchanged", () => {
    const linked = { kind: "thread-upserted" as const, sequence: 11, thread: snapshot.threads[1]! };
    const removed = {
      kind: "thread-removed" as const,
      sequence: 12,
      threadId: ThreadId.make("thread-1"),
    };
    expect(compatibleStandaloneShellEvent(linked, false)).toBe(linked);
    expect(compatibleStandaloneShellEvent(removed, false)).toBe(removed);
  });

  it("never feeds explicit null event payloads to a legacy replay decoder", () => {
    const events = [
      event(1, "standalone", { projectId: null }),
      event(2, "linked", {}),
      event(3, "standalone", { projectId: "later-project" }),
    ];
    expect(compatibleStandaloneReplayEvents(events, false)).toEqual([events[1]]);
    expect(compatibleStandaloneReplayEvents(events, true)).toEqual(events);
    expect(events).toHaveLength(3);
  });

  it("uses canonical association summaries for a replay page after creation", () => {
    const events = [event(20, "standalone", {}), event(21, "linked", {})];
    expect(
      compatibleStandaloneReplayEvents(events, undefined, [
        { id: ThreadId.make("standalone"), projectId: null },
      ]),
    ).toEqual([events[1]]);
  });
});
