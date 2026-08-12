import {
  DEFAULT_THREAD_AUTO_NUDGE_SUMMARY,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentState } from "./store";
import type { SidebarThreadSummary, ThreadSession, ThreadShell } from "./types";
import {
  AutoNudgeCompletionLedger,
  AutoNudgeCompletionTracker,
  autoNudgeForegroundThreadFromPathname,
  autoNudgeMessageBelongsToTurn,
  projectedAutoNudgeAuthority,
  projectedCompletedTurnKey,
} from "./autoNudgeCoordinator";

const environmentId = EnvironmentId.make("environment-auto-nudge");
const threadId = ThreadId.make("thread-auto-nudge");
const turnId = TurnId.make("turn-completed");
const now = "2026-08-11T12:00:00.000Z";

function makeEnvironment(): EnvironmentState {
  const autoNudge = {
    ...DEFAULT_THREAD_AUTO_NUDGE_SUMMARY,
    authorityRevision: 3,
    mode: "steady-progress" as const,
    armedAt: "2026-08-11T11:00:00.000Z",
  };
  const session: ThreadSession = {
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    status: "ready",
    orchestrationStatus: "ready",
    createdAt: now,
    updatedAt: now,
  };
  const latestTurn = {
    turnId,
    state: "completed" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    assistantMessageId: null,
  };
  const shell: ThreadShell = {
    id: threadId,
    environmentId,
    codexThreadId: null,
    projectId: ProjectId.make("project-auto-nudge"),
    title: "Auto Nudge",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    error: null,
    createdAt: now,
    archivedAt: null,
    updatedAt: now,
    branch: null,
    worktreePath: null,
    autoNudge,
  };
  const summary: SidebarThreadSummary = {
    id: threadId,
    environmentId,
    projectId: shell.projectId,
    title: shell.title,
    interactionMode: "default",
    session,
    createdAt: now,
    archivedAt: null,
    updatedAt: now,
    latestTurn,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: now,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    autoNudge,
    manualFollowUpCount: 0,
  };
  return {
    projectIds: [],
    projectById: {},
    threadIds: [threadId],
    threadIdsByProjectId: {},
    threadShellById: { [threadId]: shell },
    threadSessionById: { [threadId]: session },
    threadTurnStateById: { [threadId]: { latestTurn } },
    threadAutoNudgeConfigById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: { [threadId]: summary },
    bootstrapComplete: true,
  };
}

describe("Auto Nudge coordinator policy", () => {
  afterEach(() => vi.useRealTimers());

  it("treats hydration as a baseline and reports only new completion edges", () => {
    const tracker = new AutoNudgeCompletionTracker();
    expect(tracker.observe("thread-route", "turn-one")).toBeNull();
    expect(tracker.observe("thread-route", "turn-one")).toBeNull();
    expect(tracker.observe("thread-route", null)).toBeNull();
    expect(tracker.observe("thread-route", "turn-two")).toBe("turn-two");
  });

  it("does not create an edge when only elapsed time changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    const tracker = new AutoNudgeCompletionTracker();
    expect(tracker.observe("thread-route", "turn-one")).toBeNull();

    vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));
    expect(tracker.observe("thread-route", "turn-one")).toBeNull();
  });

  it("requires a later completion after manual queued work drains", () => {
    const environment = makeEnvironment();
    const tracker = new AutoNudgeCompletionTracker();
    const ledger = new AutoNudgeCompletionLedger(null);
    const routeKey = "thread-route";
    const firstCompletion = projectedCompletedTurnKey(environment, threadId)!;

    expect(tracker.observe(routeKey, firstCompletion)).toBeNull();
    environment.threadTurnStateById[threadId] = {
      latestTurn: { ...environment.threadTurnStateById[threadId]!.latestTurn!, state: "running" },
    };
    expect(tracker.observe(routeKey, null)).toBeNull();

    const manualCompletionTurnId = TurnId.make("turn-after-manual-work");
    environment.threadTurnStateById[threadId] = {
      latestTurn: {
        ...environment.threadTurnStateById[threadId]!.latestTurn!,
        turnId: manualCompletionTurnId,
        state: "completed",
      },
    };
    environment.sidebarThreadSummaryById[threadId]!.latestTurn =
      environment.threadTurnStateById[threadId]!.latestTurn;
    environment.sidebarThreadSummaryById[threadId]!.manualFollowUpCount = 1;
    const manualCompletion = projectedCompletedTurnKey(environment, threadId)!;
    expect(tracker.observe(routeKey, manualCompletion)).toBe(manualCompletion);
    expect(
      projectedAutoNudgeAuthority({
        environment,
        threadId,
        foregroundThread: { environmentId, threadId },
      }),
    ).toBeNull();
    ledger.mark(manualCompletion);

    environment.sidebarThreadSummaryById[threadId]!.manualFollowUpCount = 0;
    expect(tracker.observe(routeKey, manualCompletion)).toBeNull();
    expect(ledger.has(manualCompletion)).toBe(true);

    environment.threadTurnStateById[threadId] = {
      latestTurn: { ...environment.threadTurnStateById[threadId]!.latestTurn!, state: "running" },
    };
    expect(tracker.observe(routeKey, null)).toBeNull();
    const drainedCompletionTurnId = TurnId.make("turn-after-queue-drained");
    environment.threadTurnStateById[threadId] = {
      latestTurn: {
        ...environment.threadTurnStateById[threadId]!.latestTurn!,
        turnId: drainedCompletionTurnId,
        state: "completed",
      },
    };
    environment.sidebarThreadSummaryById[threadId]!.latestTurn =
      environment.threadTurnStateById[threadId]!.latestTurn;
    const drainedCompletion = projectedCompletedTurnKey(environment, threadId)!;
    expect(tracker.observe(routeKey, drainedCompletion)).toBe(drainedCompletion);
    expect(
      projectedAutoNudgeAuthority({
        environment,
        threadId,
        foregroundThread: { environmentId, threadId },
      })?.completedTurnId,
    ).toBe(drainedCompletionTurnId);
  });

  it("parses only one exact environment and thread route", () => {
    expect(autoNudgeForegroundThreadFromPathname("/environment-one/thread-one")).toEqual({
      environmentId: "environment-one",
      threadId: "thread-one",
    });
    expect(autoNudgeForegroundThreadFromPathname("/settings/providers")).toBeNull();
    expect(autoNudgeForegroundThreadFromPathname("/draft/thread-one")).toBeNull();
  });

  it("uses foreground authority only for the exact visible thread", () => {
    const environment = makeEnvironment();
    expect(
      projectedAutoNudgeAuthority({
        environment,
        threadId,
        foregroundThread: { environmentId, threadId },
      })?.dispatchSource,
    ).toBe("foreground");
    expect(
      projectedAutoNudgeAuthority({
        environment,
        threadId,
        foregroundThread: {
          environmentId,
          threadId: ThreadId.make("different-thread"),
        },
      }),
    ).toBeNull();
  });

  it("lets an opted-in exact thread continue in the background", () => {
    const environment = makeEnvironment();
    const shell = environment.threadShellById[threadId];
    const summary = environment.sidebarThreadSummaryById[threadId];
    shell!.autoNudge = { ...shell!.autoNudge!, backgroundContinuation: true };
    summary!.autoNudge = shell!.autoNudge;
    expect(
      projectedAutoNudgeAuthority({ environment, threadId, foregroundThread: null })
        ?.dispatchSource,
    ).toBe("background");
  });

  it("keeps manual FIFO work ahead of Auto Nudge", () => {
    const environment = makeEnvironment();
    environment.sidebarThreadSummaryById[threadId]!.manualFollowUpCount = 1;
    expect(
      projectedAutoNudgeAuthority({
        environment,
        threadId,
        foregroundThread: { environmentId, threadId },
      }),
    ).toBeNull();
  });

  it("reads completion identity without a clock", () => {
    const environment = makeEnvironment();
    expect(projectedCompletedTurnKey(environment, threadId)).toContain(String(turnId));
    environment.threadTurnStateById[threadId] = {
      latestTurn: { ...environment.threadTurnStateById[threadId]!.latestTurn!, state: "running" },
    };
    expect(projectedCompletedTurnKey(environment, threadId)).toBeNull();
  });

  it("keeps the completion ledger bounded and fail closed", () => {
    const values = new Map<string, string>();
    const ledger = new AutoNudgeCompletionLedger({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    });
    ledger.mark("turn-one");
    expect(ledger.has("turn-one")).toBe(true);
    expect(JSON.parse(values.values().next().value ?? "[]")).toEqual(["turn-one"]);
  });

  it("identifies only the dispatched message's provider turn", () => {
    const environment = makeEnvironment();
    const messageId = MessageId.make("message-auto-nudge");
    environment.messageByThreadId[threadId] = {
      [messageId]: {
        id: messageId,
        role: "user",
        text: "saved prompt",
        turnId,
        createdAt: now,
        streaming: false,
      },
    };
    expect(autoNudgeMessageBelongsToTurn({ environment, threadId, messageId, turnId })).toBe(true);
    expect(
      autoNudgeMessageBelongsToTurn({
        environment,
        threadId,
        messageId,
        turnId: TurnId.make("different-turn"),
      }),
    ).toBe(false);
  });
});
