import { scopeProjectRef } from "@cafecode/client-runtime";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import {
  selectEnvironmentState,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarThreadsForProjectRef,
  syncServerShellSnapshot,
  syncServerThreadDetail,
  type AppState,
} from "./store";

const localEnvironmentId = EnvironmentId.make("snapshot-local");
const remoteEnvironmentId = EnvironmentId.make("snapshot-remote");
const firstProjectId = ProjectId.make("snapshot-first-project");
const secondProjectId = ProjectId.make("snapshot-second-project");
const timestamp = "2026-10-05T00:00:00.000Z";

function shell(id: string, projectId: ProjectId | null): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    deletedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function snapshot(
  threads: readonly OrchestrationThreadShell[],
  snapshotSequence: number,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence,
    projects: [firstProjectId, secondProjectId].map((id) => ({
      id,
      title: id,
      workspaceRoot: `/synthetic/${id}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    threads,
    updatedAt: timestamp,
  };
}

const empty: AppState = {
  activeEnvironmentId: localEnvironmentId,
  environmentStateById: {},
};

describe("shell snapshot project membership", () => {
  it.each([localEnvironmentId, remoteEnvironmentId])(
    "keeps project threads discoverable through repeated snapshots in %s",
    (environmentId) => {
      const otherEnvironmentId =
        environmentId === localEnvironmentId ? remoteEnvironmentId : localEnvironmentId;
      const threads = [
        shell("first-chat", firstProjectId),
        shell("second-chat", firstProjectId),
        shell("other-project-chat", secondProjectId),
        shell("standalone-chat", null),
      ];
      let state = syncServerShellSnapshot(empty, snapshot(threads, 1), otherEnvironmentId);
      const otherEnvironment = selectEnvironmentState(state, otherEnvironmentId);

      for (const sequence of [1, 2, 3]) {
        state = syncServerShellSnapshot(state, snapshot(threads, sequence), environmentId);
        const environment = selectEnvironmentState(state, environmentId);
        expect(environment.threadIds).toEqual(threads.map((thread) => thread.id));
        expect(environment.threadIdsByProjectId).toEqual({
          [firstProjectId]: [threads[0]!.id, threads[1]!.id],
          [secondProjectId]: [threads[2]!.id],
        });
        expect(
          selectSidebarThreadsForProjectRef(
            state,
            scopeProjectRef(environmentId, firstProjectId),
          ).map((thread) => thread.id),
        ).toEqual([threads[0]!.id, threads[1]!.id]);
        expect(selectSidebarThreadsAcrossEnvironments(state)).toHaveLength(8);
        expect(environment.messageIdsByThreadId).toEqual({});
        expect(selectEnvironmentState(state, otherEnvironmentId)).toBe(otherEnvironment);
      }
    },
  );

  it("registers a project thread whose Desk detail arrived before the shell snapshot", () => {
    const thread = shell("desk-chat", firstProjectId);
    const message = {
      id: MessageId.make("desk-message"),
      role: "user" as const,
      text: "Synthetic saved message",
      turnId: null,
      streaming: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const current = syncServerThreadDetail(
      empty,
      {
        ...thread,
        subagentLimits: { codex: 6 },
        messages: [message],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        goal: null,
      },
      localEnvironmentId,
      5,
    );
    const before = selectEnvironmentState(current, localEnvironmentId);
    const next = syncServerShellSnapshot(current, snapshot([thread], 4), localEnvironmentId);
    const environment = selectEnvironmentState(next, localEnvironmentId);

    expect(
      selectSidebarThreadsForProjectRef(
        next,
        scopeProjectRef(localEnvironmentId, firstProjectId),
      ).map((row) => row.id),
    ).toEqual([thread.id]);
    expect(environment.messageByThreadId[thread.id]).toBe(before.messageByThreadId[thread.id]);
    expect(environment.threadShellById[thread.id]?.subagentLimits).toEqual({ codex: 6 });
    expect(environment.subagentPolicySequenceByThreadId?.[thread.id]).toBe(5);
  });

  it("rebuilds only current project memberships when refreshed chats move or disappear", () => {
    const moved = shell("moved-chat", firstProjectId);
    const standalone = shell("detached-chat", firstProjectId);
    const removed = shell("removed-chat", secondProjectId);
    const current = syncServerShellSnapshot(
      empty,
      snapshot([moved, standalone, removed], 1),
      localEnvironmentId,
    );
    const next = syncServerShellSnapshot(
      current,
      snapshot(
        [
          { ...moved, projectId: secondProjectId },
          { ...standalone, projectId: null },
        ],
        2,
      ),
      localEnvironmentId,
    );
    const environment = selectEnvironmentState(next, localEnvironmentId);

    expect(environment.threadIdsByProjectId).toEqual({ [secondProjectId]: [moved.id] });
    expect(environment.threadIds).toEqual([moved.id, standalone.id]);
    expect(environment.threadShellById[removed.id]).toBeUndefined();
    expect(
      selectSidebarThreadsForProjectRef(next, scopeProjectRef(localEnvironmentId, firstProjectId)),
    ).toEqual([]);
    expect(
      selectSidebarThreadsForProjectRef(
        next,
        scopeProjectRef(localEnvironmentId, secondProjectId),
      ).map((thread) => thread.id),
    ).toEqual([moved.id]);
  });
});
