import { scopeThreadRef } from "@cafecode/client-runtime";
import {
  EnvironmentId,
  EventId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  applyOrchestrationEvent,
  applyShellEvent,
  selectEnvironmentState,
  selectThreadByRef,
  setError,
  syncServerShellSnapshot,
  syncServerThreadDetail,
  type AppState,
} from "./store";

const localEnvironmentId = EnvironmentId.make("error-origin-local");
const remoteEnvironmentId = EnvironmentId.make("error-origin-remote");
const threadId = ThreadId.make("error-origin-chat");
const timestamp = "2026-10-12T00:00:00.000Z";
const providerError = "Synthetic provider stream disconnected before completion";
const localError = "Synthetic local attachment validation failed";
const empty: AppState = {
  activeEnvironmentId: localEnvironmentId,
  environmentStateById: {},
};

function session(lastError: string | null = providerError): OrchestrationSession {
  return {
    threadId,
    status: lastError === null ? "ready" : "error",
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "approval-required",
    activeTurnId: null,
    lastError,
    updatedAt: timestamp,
  };
}

function metadata(nativeSession: OrchestrationSession | null) {
  return {
    id: threadId,
    projectId: null,
    title: "Synthetic error provenance chat",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    deletedAt: null,
    session: nativeSession,
  };
}

function detail(nativeSession: OrchestrationSession | null = session()): OrchestrationThread {
  return {
    ...metadata(nativeSession),
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    goal: null,
  };
}

function shell(nativeSession: OrchestrationSession | null = session()): OrchestrationThreadShell {
  return {
    ...metadata(nativeSession),
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function shellSnapshot(
  nativeSession: OrchestrationSession | null = session(),
  sequence = 1,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: sequence,
    projects: [],
    threads: [shell(nativeSession)],
    updatedAt: timestamp,
  };
}

function sessionEvent(
  nativeSession: OrchestrationSession,
  sequence = 2,
): Extract<OrchestrationEvent, { type: "thread.session-set" }> {
  return {
    sequence,
    eventId: EventId.make(`error-origin-session-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: timestamp,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.session-set",
    payload: { threadId, session: nativeSession },
  };
}

describe("renderer thread error provenance", () => {
  it.each([localEnvironmentId, remoteEnvironmentId])(
    "marks provider errors received through detail or shell snapshots in %s",
    (environmentId) => {
      const ref = scopeThreadRef(environmentId, threadId);
      const nativeDetail = detail();
      const nativeShell = shellSnapshot();
      const beforeDetail = JSON.stringify(nativeDetail);
      const beforeShell = JSON.stringify(nativeShell);
      for (const state of [
        syncServerThreadDetail(empty, nativeDetail, environmentId, 1),
        syncServerShellSnapshot(empty, nativeShell, environmentId),
      ]) {
        const thread = selectThreadByRef(state, ref);
        expect(thread?.error).toBe(providerError);
        expect(thread?.errorOrigin).toBe("provider");
        expect(thread?.session?.lastError).toBe(providerError);
        // Provenance comes from the receiving path, not a Work Log receipt,
        // terminal-turn witness, or a materialized native runtime identity.
        expect(thread?.activities).toEqual([]);
        expect(thread?.latestTurn).toBeNull();
        expect(thread?.session?.subagentRuntimeId).toBeUndefined();
      }
      expect(JSON.stringify(nativeDetail)).toBe(beforeDetail);
      expect(JSON.stringify(nativeShell)).toBe(beforeShell);
    },
  );

  it("marks local validation without altering the canonical provider failure", () => {
    const ref = scopeThreadRef(localEnvironmentId, threadId);
    const received = syncServerThreadDetail(empty, detail(), localEnvironmentId, 1);
    const canonicalSession = selectThreadByRef(received, ref)?.session;
    const failedLocally = setError(received, ref, localError);

    expect(selectThreadByRef(failedLocally, ref)).toMatchObject({
      error: localError,
      errorOrigin: "local",
    });
    expect(selectThreadByRef(failedLocally, ref)?.session).toBe(canonicalSession);
    expect(canonicalSession?.lastError).toBe(providerError);
    expect(setError(failedLocally, ref, localError)).toBe(failedLocally);

    const cleared = setError(failedLocally, ref, null);
    expect(selectThreadByRef(cleared, ref)?.error).toBeNull();
    expect(selectThreadByRef(cleared, ref)?.errorOrigin).toBeUndefined();
    expect(selectThreadByRef(cleared, ref)?.session).toBe(canonicalSession);
    expect(canonicalSession?.lastError).toBe(providerError);
  });

  it("changes same-text local provenance back to provider on an authoritative session event", () => {
    const ref = scopeThreadRef(localEnvironmentId, threadId);
    const received = syncServerThreadDetail(empty, detail(), localEnvironmentId, 1);
    const failedLocally = setError(received, ref, providerError);
    const localEnvironment = selectEnvironmentState(failedLocally, localEnvironmentId);
    const localThread = selectThreadByRef(failedLocally, ref);

    expect(failedLocally).not.toBe(received);
    expect(localThread?.errorOrigin).toBe("local");
    const refreshed = applyOrchestrationEvent(
      failedLocally,
      sessionEvent(session()),
      localEnvironmentId,
    );
    const refreshedEnvironment = selectEnvironmentState(refreshed, localEnvironmentId);
    const refreshedThread = selectThreadByRef(refreshed, ref);
    expect(refreshedThread?.error).toBe(providerError);
    expect(refreshedThread?.errorOrigin).toBe("provider");
    expect(refreshedThread).not.toBe(localThread);
    expect(refreshedEnvironment.threadShellById[threadId]).not.toBe(
      localEnvironment.threadShellById[threadId],
    );
    // Even with identical provider error text and timestamps, an origin-only
    // update must invalidate the renderer shell without rewriting native truth.
    expect(refreshedThread?.session).toBe(localThread?.session);
    expect(refreshedEnvironment.threadSessionById).toBe(localEnvironment.threadSessionById);
  });

  it.each(["snapshot", "upsert", "detail"] as const)(
    "does not carry local provenance into a same-text authoritative %s refresh",
    (channel) => {
      const ref = scopeThreadRef(localEnvironmentId, threadId);
      const received = syncServerShellSnapshot(empty, shellSnapshot(), localEnvironmentId);
      const failedLocally = setError(received, ref, providerError);
      const localThread = selectThreadByRef(failedLocally, ref);
      expect(localThread?.errorOrigin).toBe("local");

      const refreshed =
        channel === "snapshot"
          ? syncServerShellSnapshot(failedLocally, shellSnapshot(session(), 2), localEnvironmentId)
          : channel === "upsert"
            ? applyShellEvent(
                failedLocally,
                { kind: "thread-upserted", sequence: 2, thread: shell() },
                localEnvironmentId,
              )
            : syncServerThreadDetail(failedLocally, detail(), localEnvironmentId, 2);
      const refreshedThread = selectThreadByRef(refreshed, ref);
      expect(refreshedThread?.error).toBe(providerError);
      expect(refreshedThread?.errorOrigin).toBe("provider");
      expect(refreshedThread?.session?.lastError).toBe(providerError);
      expect(refreshedThread).not.toBe(localThread);
      expect(
        selectEnvironmentState(refreshed, localEnvironmentId).threadShellById[threadId],
      ).not.toBe(
        selectEnvironmentState(failedLocally, localEnvironmentId).threadShellById[threadId],
      );
    },
  );

  it.each(["snapshot", "upsert", "detail", "session"] as const)(
    "clears the renderer origin when the authoritative %s clears the error",
    (channel) => {
      const ref = scopeThreadRef(localEnvironmentId, threadId);
      const received = syncServerThreadDetail(empty, detail(), localEnvironmentId, 1);
      const failedLocally = setError(received, ref, localError);
      const healthySession = session(null);
      const cleared =
        channel === "snapshot"
          ? syncServerShellSnapshot(
              failedLocally,
              shellSnapshot(healthySession, 2),
              localEnvironmentId,
            )
          : channel === "upsert"
            ? applyShellEvent(
                failedLocally,
                { kind: "thread-upserted", sequence: 2, thread: shell(healthySession) },
                localEnvironmentId,
              )
            : channel === "detail"
              ? syncServerThreadDetail(failedLocally, detail(healthySession), localEnvironmentId, 2)
              : applyOrchestrationEvent(
                  failedLocally,
                  sessionEvent(healthySession),
                  localEnvironmentId,
                );
      expect(selectThreadByRef(cleared, ref)?.error).toBeNull();
      expect(selectThreadByRef(cleared, ref)?.errorOrigin).toBeUndefined();
      expect(selectThreadByRef(cleared, ref)?.session?.lastError).toBeUndefined();
    },
  );

  it("does not retain a local origin across detail hydration without a provider session", () => {
    const ref = scopeThreadRef(localEnvironmentId, threadId);
    const received = syncServerShellSnapshot(empty, shellSnapshot(null), localEnvironmentId);
    const failedLocally = setError(received, ref, localError);
    const hydrated = syncServerThreadDetail(failedLocally, detail(null), localEnvironmentId, 2);

    expect(selectThreadByRef(failedLocally, ref)?.errorOrigin).toBe("local");
    expect(selectThreadByRef(hydrated, ref)?.error).toBeNull();
    expect(selectThreadByRef(hydrated, ref)?.errorOrigin).toBeUndefined();
    expect(selectThreadByRef(hydrated, ref)?.session).toBeNull();
  });

  it("binds local provenance to the exact environment even for equal thread identifiers", () => {
    const localRef = scopeThreadRef(localEnvironmentId, threadId);
    const remoteRef = scopeThreadRef(remoteEnvironmentId, threadId);
    const withLocal = syncServerThreadDetail(empty, detail(), localEnvironmentId, 1);
    const both = syncServerThreadDetail(withLocal, detail(), remoteEnvironmentId, 1);
    const remoteBefore = selectEnvironmentState(both, remoteEnvironmentId);
    const failedLocally = setError(both, localRef, providerError);

    expect(selectThreadByRef(failedLocally, localRef)?.errorOrigin).toBe("local");
    expect(selectThreadByRef(failedLocally, remoteRef)?.errorOrigin).toBe("provider");
    expect(selectEnvironmentState(failedLocally, remoteEnvironmentId)).toBe(remoteBefore);

    const localBefore = selectEnvironmentState(failedLocally, localEnvironmentId);
    const refreshedRemote = applyOrchestrationEvent(
      failedLocally,
      sessionEvent(session()),
      remoteEnvironmentId,
    );
    expect(selectEnvironmentState(refreshedRemote, localEnvironmentId)).toBe(localBefore);
    expect(selectThreadByRef(refreshedRemote, localRef)?.errorOrigin).toBe("local");
    expect(selectThreadByRef(refreshedRemote, remoteRef)?.errorOrigin).toBe("provider");
  });
});
