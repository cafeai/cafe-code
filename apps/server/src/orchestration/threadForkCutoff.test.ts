import {
  CheckpointRef,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import { resolveThreadForkMessageCutoff, threadForkPrefix } from "./threadForkCutoff.ts";

const now = "2026-10-05T00:00:00.000Z";
const source: OrchestrationThread = {
  id: ThreadId.make("source"),
  projectId: null,
  title: "Source",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  session: null,
  goal: null,
  messages: ["first-user", "first-block", "first-final", "second-user", "second-final"].map(
    (id, index) => ({
      id: MessageId.make(id),
      turnId: TurnId.make(index < 3 ? "turn-one" : "turn-two"),
      role: index === 0 || index === 3 ? "user" : "assistant",
      text: id,
      streaming: false,
      createdAt: `2026-10-05T00:00:0${index}.000Z`,
      updatedAt: `2026-10-05T00:00:0${index}.000Z`,
    }),
  ),
  checkpoints: ["turn-one", "turn-two"].map((turnId, index) => ({
    turnId: TurnId.make(turnId),
    checkpointTurnCount: index + 1,
    checkpointRef: CheckpointRef.make(`refs/checkpoint/${index + 1}`),
    status: "ready",
    files: [],
    assistantMessageId: MessageId.make(index === 0 ? "first-final" : "second-final"),
    completedAt: now,
  })),
  activities: ["turn-one", "turn-two"].map((turnId, index) => ({
    id: EventId.make(`activity-${index}`),
    turnId: TurnId.make(turnId),
    tone: "info",
    kind: "task.completed",
    summary: "Historic task",
    payload: {},
    createdAt: now,
  })),
  proposedPlans: [],
};

describe("selected-message projection boundary", () => {
  it("copies exact first, middle and latest messages without later turn context", () => {
    for (const index of [0, 1, 2, 4]) {
      const selected = source.messages[index]!;
      const cutoff = resolveThreadForkMessageCutoff(source, selected.id);
      const prefix = threadForkPrefix(
        source,
        cutoff,
        source.messages.slice(0, index + 1).map((entry) => entry.id),
      );
      expect(prefix.messages).toEqual(source.messages.slice(0, index + 1));
      expect(prefix.latestTurn?.state).toBe("interrupted");
      expect(prefix.checkpoints.length).toBe(index < 2 ? 0 : index === 2 ? 1 : 2);
      expect(prefix.activities.length).toBe(prefix.checkpoints.length);
      expect(source.messages).toHaveLength(5);
      expect(source.checkpoints).toHaveLength(2);
    }
  });
  it("rejects unknown, streaming, absent, ambiguous and changed boundaries", () => {
    expect(() => resolveThreadForkMessageCutoff(source, MessageId.make("foreign"))).toThrow();
    expect(() =>
      resolveThreadForkMessageCutoff(
        { ...source, messages: [{ ...source.messages[0]!, streaming: true }] },
        source.messages[0]!.id,
      ),
    ).toThrow();
    expect(() =>
      resolveThreadForkMessageCutoff({ ...source, checkpoints: [] }, source.messages[0]!.id),
    ).toThrow();
    expect(() =>
      resolveThreadForkMessageCutoff(
        { ...source, checkpoints: [source.checkpoints[0]!, source.checkpoints[0]!] },
        source.messages[0]!.id,
      ),
    ).toThrow();
    const cutoff = resolveThreadForkMessageCutoff(source, source.messages[1]!.id);
    expect(() =>
      threadForkPrefix(source, { ...cutoff, includesCompleteTurn: true }, [cutoff.sourceMessageId]),
    ).toThrow();
  });
  it("resolves a previously forked partial endpoint without inventing a file checkpoint", () => {
    const cutoff = resolveThreadForkMessageCutoff(source, source.messages[1]!.id);
    const first = threadForkPrefix(
      source,
      cutoff,
      source.messages.slice(0, 2).map((entry) => entry.id),
    );
    expect(first.checkpoints).toHaveLength(0);
    expect(resolveThreadForkMessageCutoff(first, source.messages[1]!.id)).toEqual(cutoff);
    expect(
      threadForkPrefix(
        first,
        cutoff,
        first.messages.map((entry) => entry.id),
      ).latestTurn?.state,
    ).toBe("interrupted");
  });
  it("never inherits actionable approval or input request handles from completed turns", () => {
    const withRequests: OrchestrationThread = {
      ...source,
      activities: [
        ...source.activities,
        ...["approval.requested", "user-input.requested"].map((kind) => ({
          ...source.activities[0]!,
          id: EventId.make(kind),
          kind,
        })),
      ],
    };
    const cutoff = resolveThreadForkMessageCutoff(withRequests, MessageId.make("second-final"));
    const copied = threadForkPrefix(
      withRequests,
      cutoff,
      source.messages.map((entry) => entry.id),
    );
    expect(copied.activities).toEqual(source.activities);
    expect(withRequests.activities).toHaveLength(4);
  });
});
