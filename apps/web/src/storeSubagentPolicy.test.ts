import {
  EnvironmentId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type SubagentLimits,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import {
  applyOrchestrationEvent,
  applyShellEvent,
  selectEnvironmentState,
  syncServerShellSnapshot,
  syncServerThreadDetail,
  type AppState,
} from "./store";

const environmentId = EnvironmentId.make("policy-local");
const threadId = ThreadId.make("policy-chat");
const timestamp = "2026-10-03T00:00:00.000Z";
const empty: AppState = { activeEnvironmentId: environmentId, environmentStateById: {} };

function detail(limits?: SubagentLimits, id = threadId): OrchestrationThread {
  return {
    id,
    projectId: null,
    title: "Synthetic policy chat",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    ...(limits !== undefined ? { subagentLimits: limits } : {}),
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    goal: null,
  };
}

function shell(limits?: SubagentLimits, id = threadId): OrchestrationThreadShell {
  return {
    ...detail(limits, id),
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function meta(sequence: number, limits?: SubagentLimits): OrchestrationEvent {
  return {
    type: "thread.meta-updated",
    sequence,
    eventId: EventId.make(`policy-event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: timestamp,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      title: "An unrelated metadata change",
      updatedAt: timestamp,
      ...(limits !== undefined ? { subagentLimits: limits } : {}),
    },
  };
}

function authority(state: AppState) {
  const current = selectEnvironmentState(state, environmentId);
  return {
    limits: current.threadShellById[threadId]?.subagentLimits,
    sequence: current.subagentPolicySequenceByThreadId?.[threadId],
  };
}

describe("exact-thread subagent policy authority", () => {
  it.each([{ codex: 9 }, undefined])(
    "preserves newer detail policy over older shell rows (%j)",
    (older) => {
      const current = syncServerThreadDetail(empty, detail({ codex: 6 }), environmentId, 5);
      const event = applyShellEvent(
        current,
        { kind: "thread-upserted", sequence: 4, thread: shell(older) },
        environmentId,
      );
      expect(authority(event)).toEqual({ limits: { codex: 6 }, sequence: 5 });
      const snapshot = syncServerShellSnapshot(
        current,
        {
          snapshotSequence: 4,
          projects: [],
          threads: [shell(older)],
          updatedAt: timestamp,
        },
        environmentId,
      );
      expect(authority(snapshot)).toEqual({ limits: { codex: 6 }, sequence: 5 });
    },
  );

  it.each([{ codex: 9 }, undefined])(
    "preserves newer shell policy over older or unsequenced detail (%j)",
    (older) => {
      const current = applyShellEvent(
        empty,
        { kind: "thread-upserted", sequence: 5, thread: shell({ codex: 6 }) },
        environmentId,
      );
      for (const sequence of [4, undefined]) {
        expect(
          authority(syncServerThreadDetail(current, detail(older), environmentId, sequence)),
        ).toEqual({ limits: { codex: 6 }, sequence: 5 });
      }
      const absent = syncServerThreadDetail(current, detail(), environmentId, 6);
      expect(authority(absent)).toEqual({ limits: undefined, sequence: 6 });
      const reset = syncServerThreadDetail(absent, detail({}), environmentId, 7);
      expect(authority(reset)).toEqual({ limits: {}, sequence: 7 });
    },
  );

  it("advances equal-policy snapshot witnesses while rejecting old metadata replacements", () => {
    let state = syncServerThreadDetail(empty, detail({ codex: 6 }), environmentId, 5);
    state = syncServerThreadDetail(state, detail({ codex: 6 }), environmentId, 8);
    expect(authority(state)).toEqual({ limits: { codex: 6 }, sequence: 8 });
    state = applyOrchestrationEvent(state, meta(7, { codex: 9 }), environmentId);
    expect(authority(state)).toEqual({ limits: { codex: 6 }, sequence: 8 });
    state = applyOrchestrationEvent(state, meta(9, {}), environmentId);
    expect(authority(state)).toEqual({ limits: {}, sequence: 9 });
  });

  it("does not certify policy through omitted metadata, another chat or another environment", () => {
    let state = syncServerThreadDetail(empty, detail({ codex: 6 }), environmentId, 5);
    state = applyOrchestrationEvent(state, meta(20), environmentId);
    state = applyShellEvent(
      state,
      {
        kind: "thread-upserted",
        sequence: 30,
        thread: shell({ codex: 10 }, ThreadId.make("other-chat")),
      },
      environmentId,
    );
    state = syncServerThreadDetail(
      state,
      detail({ codex: 12 }),
      EnvironmentId.make("other-environment"),
      40,
    );
    expect(authority(state)).toEqual({ limits: { codex: 6 }, sequence: 5 });
    const event = meta(50);
    const turn: OrchestrationEvent = {
      ...event,
      type: "thread.turn-start-requested",
      payload: {
        threadId,
        messageId: MessageId.make("policy-message"),
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: timestamp,
      },
    };
    state = applyOrchestrationEvent(state, turn, environmentId);
    expect(authority(state)).toEqual({ limits: { codex: 6 }, sequence: 5 });
    state = applyOrchestrationEvent(
      state,
      { ...turn, sequence: 51, payload: { ...turn.payload, subagentLimits: {} } },
      environmentId,
    );
    expect(authority(state)).toEqual({ limits: {}, sequence: 51 });
  });

  it("removes exact-thread authority with the deleted shell", () => {
    const current = syncServerThreadDetail(empty, detail({ codex: 6 }), environmentId, 5);
    const next = applyShellEvent(
      current,
      { kind: "thread-removed", sequence: 6, threadId },
      environmentId,
    );
    expect(authority(next)).toEqual({ limits: undefined, sequence: undefined });
  });
  it("preserves a newer focused row over old omission/removal and admits current deletion", () => {
    const current = syncServerThreadDetail(empty, detail({ codex: 6 }), environmentId, 5);
    const omitted = syncServerShellSnapshot(
      current,
      {
        snapshotSequence: 4,
        projects: [],
        threads: [],
        updatedAt: timestamp,
      },
      environmentId,
    );
    expect(authority(omitted)).toEqual({ limits: { codex: 6 }, sequence: 5 });
    expect(selectEnvironmentState(omitted, environmentId).threadIds).toContain(threadId);
    const shellRemoved = applyShellEvent(
      omitted,
      { kind: "thread-removed", sequence: 4, threadId },
      environmentId,
    );
    expect(shellRemoved).toBe(omitted);
    const deleted: OrchestrationEvent = {
      ...meta(4),
      type: "thread.deleted",
      payload: { threadId, deletedAt: timestamp },
    };
    expect(applyOrchestrationEvent(omitted, deleted, environmentId)).toBe(omitted);
    const newerOmission = syncServerShellSnapshot(
      omitted,
      {
        snapshotSequence: 6,
        projects: [],
        threads: [],
        updatedAt: timestamp,
      },
      environmentId,
    );
    expect(authority(newerOmission)).toEqual({ limits: undefined, sequence: undefined });
    expect(selectEnvironmentState(newerOmission, environmentId).threadIds).not.toContain(threadId);
  });
});
