import {
  EnvironmentId,
  EventId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type OrchestrationEvent,
} from "@cafecode/contracts";
import { describe, it, expect } from "vitest";
import {
  syncServerThreadDetail,
  syncServerShellSnapshot,
  applyShellEvent,
  applyOrchestrationEvent,
  selectEnvironmentState,
  type AppState,
} from "./store";

const environmentId = EnvironmentId.make("context-local");
const threadId = ThreadId.make("context-chat");
const timestamp = "2026-10-12T00:00:00.000Z";
const empty: AppState = { activeEnvironmentId: environmentId, environmentStateById: {} };
function detail(value?: number | null, id = threadId): OrchestrationThread {
  return {
    id,
    projectId: null,
    title: "Synthetic context chat",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    ...(value !== undefined ? { codexContextWindowOverride: value } : {}),
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
function shell(value?: number | null, id = threadId): OrchestrationThreadShell {
  return {
    ...detail(value, id),
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}
function meta(sequence: number, value?: number | null): OrchestrationEvent {
  return {
    type: "thread.meta-updated",
    sequence,
    eventId: EventId.make(`context-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: timestamp,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      title: "Unrelated metadata",
      updatedAt: timestamp,
      ...(value !== undefined ? { codexContextWindowOverride: value } : {}),
    },
  };
}
function authority(state: AppState) {
  const current = selectEnvironmentState(state, environmentId);
  return {
    value: current.threadShellById[threadId]?.codexContextWindowOverride,
    sequence: current.codexContextPolicySequenceByThreadId?.[threadId],
  };
}
describe("independent exact-chat Codex context-policy authority", () => {
  it.each([750_000, null, undefined])(
    "refuses old shell/detail replacements of a newer policy (%s)",
    (older) => {
      const current = syncServerThreadDetail(empty, detail(500_000), environmentId, 5);
      expect(
        authority(
          applyShellEvent(
            current,
            { kind: "thread-upserted", sequence: 4, thread: shell(older) },
            environmentId,
          ),
        ),
      ).toEqual({ value: 500_000, sequence: 5 });
      expect(authority(syncServerThreadDetail(current, detail(older), environmentId, 4))).toEqual({
        value: 500_000,
        sequence: 5,
      });
      expect(authority(syncServerThreadDetail(current, detail(older), environmentId))).toEqual({
        value: 500_000,
        sequence: 5,
      });
    },
  );
  it("retains explicit Reset and advances equal-value witnesses without unrelated certification", () => {
    let state = syncServerThreadDetail(empty, detail(500_000), environmentId, 5);
    state = applyOrchestrationEvent(state, meta(6, null), environmentId);
    expect(authority(state)).toEqual({ value: null, sequence: 6 });
    state = applyOrchestrationEvent(state, meta(9), environmentId);
    expect(authority(state)).toEqual({ value: null, sequence: 6 });
    const event = meta(10);
    if (event.type !== "thread.meta-updated") throw new Error("fixture discriminant");
    state = applyOrchestrationEvent(
      state,
      { ...event, payload: { ...event.payload, subagentLimits: { codex: 12 } } },
      environmentId,
    );
    expect(authority(state)).toEqual({ value: null, sequence: 6 });
    state = syncServerThreadDetail(state, detail(null), environmentId, 12);
    expect(authority(state)).toEqual({ value: null, sequence: 12 });
    expect(authority(applyOrchestrationEvent(state, meta(11, 1_000_000), environmentId))).toEqual({
      value: null,
      sequence: 12,
    });
  });
  it("another chat/environment or an old omission cannot retire the owning policy", () => {
    let current = syncServerThreadDetail(empty, detail(500_000), environmentId, 5);
    current = applyShellEvent(
      current,
      {
        kind: "thread-upserted",
        sequence: 30,
        thread: shell(750_000, ThreadId.make("other-chat")),
      },
      environmentId,
    );
    current = syncServerThreadDetail(
      current,
      detail(null),
      EnvironmentId.make("other-environment"),
      40,
    );
    const omitted = syncServerShellSnapshot(
      current,
      { snapshotSequence: 4, projects: [], threads: [], updatedAt: timestamp },
      environmentId,
    );
    expect(authority(omitted)).toEqual({ value: 500_000, sequence: 5 });
    expect(
      authority(
        applyShellEvent(omitted, { kind: "thread-removed", sequence: 4, threadId }, environmentId),
      ),
    ).toEqual({ value: 500_000, sequence: 5 });
    expect(
      authority(
        applyShellEvent(omitted, { kind: "thread-removed", sequence: 6, threadId }, environmentId),
      ),
    ).toEqual({ value: undefined, sequence: undefined });
  });
});
