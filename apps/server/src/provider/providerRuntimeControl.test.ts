import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type ProviderSession,
} from "@cafecode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  restartProviderRuntimeWithPolicy,
  type ProviderRuntimeControlDependencies,
} from "./providerRuntimeControl.ts";

const instanceId = ProviderInstanceId.make("codex_work");
const otherInstanceId = ProviderInstanceId.make("codex_personal");
const runningThreadId = ThreadId.make("running-thread");
const readyThreadId = ThreadId.make("ready-thread");
const otherThreadId = ThreadId.make("other-thread");
const now = "2026-08-12T12:00:00.000Z";

function session(input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly status: ProviderSession["status"];
  readonly activeTurnId?: TurnId;
}): ProviderSession {
  return {
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: input.providerInstanceId,
    status: input.status,
    runtimeMode: "full-access",
    threadId: input.threadId,
    ...(input.activeTurnId ? { activeTurnId: input.activeTurnId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function thread(threadId: ThreadId): OrchestrationThreadShell {
  return {
    id: threadId,
    projectId: "project" as OrchestrationThreadShell["projectId"],
    title: `Thread ${threadId}`,
    modelSelection: { instanceId, model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "auto",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    session: null,
    latestUserMessageAt: now,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("restartProviderRuntimeWithPolicy", () => {
  it("restarts one instance and resumes only sessions that were active", async () => {
    const dispatched: Array<
      Parameters<ProviderRuntimeControlDependencies["orchestrationEngine"]["dispatch"]>[0]
    > = [];
    const dependencies: ProviderRuntimeControlDependencies = {
      orchestrationEngine: {
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      },
      projectionSnapshotQuery: {
        getThreadShellById: (threadId) => Effect.succeed(Option.some(thread(threadId))),
      },
      providerRegistry: {
        refreshInstance: () => Effect.succeed([]),
      },
      providerService: {
        listSessions: () =>
          Effect.succeed([
            session({
              threadId: runningThreadId,
              providerInstanceId: instanceId,
              status: "running",
              activeTurnId: TurnId.make("turn-running"),
            }),
            session({
              threadId: readyThreadId,
              providerInstanceId: instanceId,
              status: "ready",
            }),
            session({
              threadId: otherThreadId,
              providerInstanceId: otherInstanceId,
              status: "running",
              activeTurnId: TurnId.make("turn-other"),
            }),
          ]),
        restartProviderRuntime: () =>
          Effect.succeed({
            instanceId,
            provider: ProviderDriverKind.make("codex"),
            stoppedSessionCount: 2,
          }),
      },
    };

    const result = await Effect.runPromise(
      restartProviderRuntimeWithPolicy(dependencies, {
        instanceId,
        resumeActiveSessions: true,
        resumeMessage: "Continue after restart.",
      }),
    );

    expect(result).toMatchObject({
      instanceId,
      stoppedSessionCount: 2,
      activeSessionCount: 1,
      resumedThreadIds: [runningThreadId],
      failedResumeThreadIds: [],
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.turn.start",
      threadId: runningThreadId,
      runtimeMode: "full-access",
      interactionMode: "auto",
      message: { role: "user", text: "Continue after restart.", attachments: [] },
    });
  });

  it("does not dispatch resume turns in interrupt-only mode", async () => {
    const dependencies: ProviderRuntimeControlDependencies = {
      orchestrationEngine: {
        dispatch: () => Effect.die("resume dispatch should not run"),
      },
      projectionSnapshotQuery: {
        getThreadShellById: () => Effect.die("thread lookup should not run"),
      },
      providerRegistry: {
        refreshInstance: () => Effect.succeed([]),
      },
      providerService: {
        listSessions: () =>
          Effect.succeed([
            session({
              threadId: runningThreadId,
              providerInstanceId: instanceId,
              status: "running",
              activeTurnId: TurnId.make("turn-running"),
            }),
          ]),
        restartProviderRuntime: () =>
          Effect.succeed({
            instanceId,
            provider: ProviderDriverKind.make("codex"),
            stoppedSessionCount: 1,
          }),
      },
    };

    const result = await Effect.runPromise(
      restartProviderRuntimeWithPolicy(dependencies, {
        instanceId,
        resumeActiveSessions: false,
      }),
    );

    expect(result.activeSessionCount).toBe(1);
    expect(result.resumedThreadIds).toEqual([]);
  });
});
