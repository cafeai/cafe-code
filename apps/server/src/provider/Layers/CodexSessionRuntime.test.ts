import assert from "node:assert/strict";

import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";
import { describe, it, vi } from "vitest";
import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  CODEX_PENDING_STEER_UNRESOLVED_CAPACITY,
  acknowledgeCodexPendingSteerProcessing,
  acknowledgeCodexSteerLifecycleBoundary,
  admitCodexPendingSteerProcessing,
  buildCodexAppServerArgs,
  buildCodexActiveContextCompactionSteerError,
  buildCodexPendingSteerCapacityError,
  buildCodexThreadSnapshotBackfillEvents,
  buildTurnStartParams,
  buildTurnSteerParams,
  awaitCodexUserInputResolution,
  claimCodexSnapshotBackfillWatcher,
  claimCodexRestartedSteerProcessingObservation,
  codexAggregateNotificationMethod,
  codexAggregateTurnHasUnfinishedChildren,
  codexChildConversationThreadIdsForTurn,
  codexElapsedDelayMilliseconds,
  codexElapsedDelayRemainingMilliseconds,
  codexTerminalSessionPatch,
  codexSubagentProjectionMethod,
  isRecoverableThreadResumeError,
  isCodexContextCompactionItemType,
  isCodexChildConversationWorkNotification,
  isCodexUserMessageItemType,
  isTerminalCodexChildThreadReadError,
  openCodexThread,
  prunePendingSteerProcessing,
  publishCodexTurnCompletionAfterLifecycleBoundary,
  readCodexExpectedActiveTurnMismatchActualTurnId,
  readCodexSubagentThreadWithInitializedClient,
  readCodexNotificationEmittedAtIso,
  readCodexNotificationRouteFields,
  readCodexSteerExpectedTurnMismatchActualTurnId,
  reconcileCodexTerminalSnapshotSteerLifecycle,
  rememberCodexChildConversationTurns,
  retargetCodexPendingSteerProcessing,
  resolveCodexSessionRuntimeSteerClientCorrelationId,
  resolveCodexThreadSettingsSessionModel,
  resolveCodexChildConversationNotification,
  shouldForwardCodexRootGoalNotification,
  selectCodexActiveSnapshotTurn,
  summarizeCodexAppServerChildProcesses,
  terminalizeCodexPendingSteerProcessing,
  updateCodexChildConversationLiveness,
  updateCodexActiveContextCompactions,
  updateCodexPendingSteerProcessingFromNotification,
  validateCodexSubagentThreadReadMetadata,
  type CodexInitializedSubagentHistoryReadClient,
  type CodexPendingSteerProcessing,
  type CodexSubagentHistoryReadClient,
} from "./CodexSessionRuntime.ts";
import {
  buildCodexSteerClientCorrelationId,
  parseCodexSteerClientCorrelationId,
} from "../codexSteerCorrelation.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
const decodeMessageId = Schema.decodeUnknownSync(MessageId);

function makePendingSteerProcessingFixture(index: number): CodexPendingSteerProcessing {
  return {
    steerId: `steer-${index}`,
    clientCorrelationId: buildCodexSteerClientCorrelationId(`message-${index}`),
    providerThreadId: "provider-thread-1",
    turnId: TurnId.make("turn-active"),
    requestedAt: new Date(Date.UTC(2026, 4, 26) + index).toISOString(),
    promptByteLength: 10,
    attachmentCount: 0,
    warningCount: 0,
  };
}

describe("Codex non-blocking user input", () => {
  effectIt.effect("submits an empty answer map after the upstream 120-second deadline", () =>
    Effect.gen(function* () {
      const answers = yield* Deferred.make<ProviderUserInputAnswers>();
      const autoResolutionSnoozed = yield* Deferred.make<void>();
      const resolutionFiber = yield* awaitCodexUserInputResolution({
        answers,
        autoResolutionSnoozed,
        isBlocking: false,
      }).pipe(Effect.forkChild);

      yield* TestClock.adjust("119 seconds");
      assert.equal(resolutionFiber.pollUnsafe(), undefined);
      yield* TestClock.adjust("1 second");

      assert.deepEqual(yield* Fiber.join(resolutionFiber), {
        answers: {},
        source: "automatic",
      });
    }),
  );

  effectIt.effect("permanently retires the deadline after the user interacts", () =>
    Effect.gen(function* () {
      const answers = yield* Deferred.make<ProviderUserInputAnswers>();
      const autoResolutionSnoozed = yield* Deferred.make<void>();
      const resolutionFiber = yield* awaitCodexUserInputResolution({
        answers,
        autoResolutionSnoozed,
        isBlocking: false,
      }).pipe(Effect.forkChild);

      yield* Deferred.succeed(autoResolutionSnoozed, undefined);
      yield* TestClock.adjust("5 minutes");
      assert.equal(resolutionFiber.pollUnsafe(), undefined);

      yield* Deferred.succeed(answers, { choice: "continue" });
      assert.deepEqual(yield* Fiber.join(resolutionFiber), {
        answers: { choice: "continue" },
        source: "explicit",
      });
    }),
  );
});

describe("Codex subagent thread ownership validation", () => {
  const root = {
    id: "root-provider-thread",
    parentThreadId: null,
    sessionId: "session-tree-1",
    source: "appServer" as const,
  };
  const nestedChild = {
    id: "nested-provider-child",
    parentThreadId: "intermediate-provider-child",
    sessionId: "session-tree-1",
    source: {
      subAgent: {
        thread_spawn: {
          depth: 2,
          parent_thread_id: "intermediate-provider-child",
        },
      },
    } as const,
  };

  it("accepts a nested child in the recovered root session tree", () => {
    assert.equal(
      validateCodexSubagentThreadReadMetadata({
        expectedRootThreadId: "root-provider-thread",
        expectedChildThreadId: "nested-provider-child",
        root,
        child: nestedChild,
      }),
      undefined,
    );
  });

  it("rejects mismatched ids, provider session trees, and parent metadata", () => {
    assert.equal(
      validateCodexSubagentThreadReadMetadata({
        expectedRootThreadId: "different-root",
        expectedChildThreadId: "nested-provider-child",
        root,
        child: nestedChild,
      }),
      "root-identity-mismatch",
    );
    assert.equal(
      validateCodexSubagentThreadReadMetadata({
        expectedRootThreadId: "root-provider-thread",
        expectedChildThreadId: "different-child",
        root,
        child: nestedChild,
      }),
      "child-identity-mismatch",
    );
    assert.equal(
      validateCodexSubagentThreadReadMetadata({
        expectedRootThreadId: "root-provider-thread",
        expectedChildThreadId: "nested-provider-child",
        root,
        child: { ...nestedChild, sessionId: "other-session-tree" },
      }),
      "session-tree-mismatch",
    );
    assert.equal(
      validateCodexSubagentThreadReadMetadata({
        expectedRootThreadId: "root-provider-thread",
        expectedChildThreadId: "nested-provider-child",
        root,
        child: {
          ...nestedChild,
          source: {
            subAgent: {
              thread_spawn: {
                depth: 2,
                parent_thread_id: "wrong-immediate-parent",
              },
            },
          },
        },
      }),
      "parent-metadata-mismatch",
    );
    assert.equal(
      validateCodexSubagentThreadReadMetadata({
        expectedRootThreadId: "root-provider-thread",
        expectedChildThreadId: "nested-provider-child",
        root,
        child: { ...nestedChild, source: "appServer" },
      }),
      "missing-subagent-metadata",
    );
  });

  effectIt.effect("reads exact root metadata before the child without opening a thread", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const request = ((method: string, payload: unknown) =>
        Effect.sync(() => {
          calls.push({ method, payload });
          if (method === "initialize") {
            return { userAgent: "codex-test" };
          }
          const requestedThreadId = (payload as { threadId: string }).threadId;
          return {
            thread:
              requestedThreadId === root.id
                ? { ...root, turns: [] }
                : {
                    ...nestedChild,
                    turns: [
                      {
                        id: "child-turn-1",
                        items: [],
                      },
                    ],
                  },
          };
        })) as CodexSubagentHistoryReadClient["request"];
      const notify = ((method: string, payload: unknown) =>
        Effect.sync(() => {
          calls.push({ method, payload });
        })) as CodexInitializedSubagentHistoryReadClient["notify"];

      const snapshot = yield* readCodexSubagentThreadWithInitializedClient({
        client: { request, notify },
        rootProviderThreadId: root.id,
        subagentThreadId: nestedChild.id,
      });

      assert.equal(snapshot.threadId, nestedChild.id);
      assert.deepEqual(
        calls.map((call) => call.method),
        ["initialize", "initialized", "thread/read", "thread/read"],
      );
      assert.deepEqual(calls.slice(2), [
        { method: "thread/read", payload: { threadId: root.id, includeTurns: false } },
        { method: "thread/read", payload: { threadId: nestedChild.id, includeTurns: true } },
      ]);
      assert.equal(
        calls.some((call) => call.method === "thread/resume"),
        false,
      );
      assert.equal(
        calls.some((call) => call.method === "thread/start"),
        false,
      );
    }),
  );

  effectIt.effect("does not disclose the child id upstream when the exact root read fails", () =>
    Effect.gen(function* () {
      const requestMock = vi.fn((method: string, _payload: unknown) =>
        method === "initialize"
          ? Effect.succeed({ userAgent: "codex-test" })
          : Effect.fail(
              new CodexErrors.CodexAppServerTransportError({
                detail: "root history unavailable",
                cause: new Error("closed"),
              }),
            ),
      );
      const request = requestMock as unknown as CodexSubagentHistoryReadClient["request"];
      const notifyMock = vi.fn((_method: string, _payload: unknown) => Effect.void);
      const notify = notifyMock as unknown as CodexInitializedSubagentHistoryReadClient["notify"];

      const exit = yield* readCodexSubagentThreadWithInitializedClient({
        client: { request, notify },
        rootProviderThreadId: root.id,
        subagentThreadId: nestedChild.id,
      }).pipe(Effect.exit);

      assert.equal(exit._tag, "Failure");
      assert.equal(requestMock.mock.calls.length, 2);
      assert.equal(notifyMock.mock.calls.length, 1);
      assert.deepEqual(requestMock.mock.calls[1], [
        "thread/read",
        { threadId: root.id, includeTurns: false },
      ]);
    }),
  );
});

describe("Codex notification emission timestamps", () => {
  it("accepts valid provider emission time and rejects malformed or future values", () => {
    const receivedAtMs = Date.parse("2026-07-14T08:00:00.000Z");
    assert.equal(
      readCodexNotificationEmittedAtIso(
        {
          method: "turn/started",
          params: {},
          emittedAtMs: Date.parse("2026-07-14T07:59:58.000Z"),
        },
        receivedAtMs,
      ),
      "2026-07-14T07:59:58.000Z",
    );
    assert.equal(
      readCodexNotificationEmittedAtIso(
        {
          method: "turn/started",
          params: {},
          emittedAtMs: Number.NaN,
        },
        receivedAtMs,
      ),
      undefined,
    );
    assert.equal(
      readCodexNotificationEmittedAtIso(
        {
          method: "turn/started",
          params: {},
          emittedAtMs: receivedAtMs + 5 * 60_000 + 1,
        },
        receivedAtMs,
      ),
      undefined,
    );
  });
});

describe("buildCodexAppServerArgs", () => {
  it("uses plain app-server args until a transport fallback policy is active", () => {
    assert.deepStrictEqual(buildCodexAppServerArgs(undefined), ["app-server"]);
    assert.deepStrictEqual(buildCodexAppServerArgs({ responsesWebsockets: "auto" }), [
      "app-server",
    ]);
  });

  it("uses a Cafe-scoped OpenAI provider when Responses WebSockets are disabled", () => {
    assert.deepStrictEqual(buildCodexAppServerArgs({ responsesWebsockets: "disabled" }), [
      "app-server",
      "-c",
      'model_provider="cafecode-openai-http"',
      "-c",
      'model_providers.cafecode-openai-http.name="OpenAI"',
      "-c",
      'model_providers.cafecode-openai-http.wire_api="responses"',
      "-c",
      "model_providers.cafecode-openai-http.requires_openai_auth=true",
      "-c",
      'model_providers.cafecode-openai-http.env_http_headers.OpenAI-Organization="OPENAI_ORGANIZATION"',
      "-c",
      'model_providers.cafecode-openai-http.env_http_headers.OpenAI-Project="OPENAI_PROJECT"',
      "-c",
      "model_providers.cafecode-openai-http.supports_websockets=false",
    ]);
  });
});

describe("Codex terminal session state", () => {
  it("clears a previous runtime error after successful completion", () => {
    assert.deepStrictEqual(codexTerminalSessionPatch({ turnStatus: "completed" }), {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });
  });

  it("retains the current failure message after failed completion", () => {
    assert.deepStrictEqual(
      codexTerminalSessionPatch({
        turnStatus: "failed",
        errorMessage: "current turn failed",
      }),
      {
        status: "error",
        activeTurnId: undefined,
        lastError: "current turn failed",
      },
    );
  });
});

describe("Codex thread settings reconciliation", () => {
  const notification = {
    threadId: "provider-thread-1",
    threadSettings: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.4",
          reasoning_effort: "ultra",
        },
      },
      cwd: "/workspace",
      effort: "ultra",
      model: "gpt-5.4",
      modelProvider: "openai",
      sandboxPolicy: { type: "workspaceWrite" },
    },
  } satisfies EffectCodexSchema.V2ThreadSettingsUpdatedNotification;

  it("accepts the authoritative model only for the current provider thread", () => {
    assert.equal(
      resolveCodexThreadSettingsSessionModel({
        currentProviderThreadId: "provider-thread-1",
        notification,
      }),
      "gpt-5.4",
    );
    assert.equal(
      resolveCodexThreadSettingsSessionModel({
        currentProviderThreadId: "provider-thread-child",
        notification,
      }),
      undefined,
    );
  });
});

describe("codex elapsed watchdog scheduling", () => {
  it("treats delay labels as elapsed deadlines instead of cumulative sleeps", () => {
    assert.equal(codexElapsedDelayMilliseconds("60 seconds"), 60_000);
    assert.equal(
      codexElapsedDelayRemainingMilliseconds({
        startedAtMs: 1_000,
        nowMs: 31_000,
        delay: "60 seconds",
      }),
      30_000,
    );
    assert.equal(
      codexElapsedDelayRemainingMilliseconds({
        startedAtMs: 1_000,
        nowMs: 90_000,
        delay: "60 seconds",
      }),
      0,
    );
  });

  it("allows only one snapshot backfill watcher per active turn", () => {
    const turnId = TurnId.make("turn-backfill");
    const [firstClaimed, afterFirstClaim] = claimCodexSnapshotBackfillWatcher(new Set(), turnId);
    const [duplicateClaimed, afterDuplicateClaim] = claimCodexSnapshotBackfillWatcher(
      afterFirstClaim,
      turnId,
    );

    assert.equal(firstClaimed, true);
    assert.equal(duplicateClaimed, false);
    assert.equal(afterDuplicateClaim, afterFirstClaim);
    assert.deepEqual([...afterDuplicateClaim], [String(turnId)]);
  });
});

describe("Codex child conversation routing", () => {
  it("keeps child errors out of primary runtime error state", () => {
    assert.equal(codexAggregateNotificationMethod("error", true), "codex.subagent/error");
    assert.equal(codexAggregateNotificationMethod("error", false), "error");
    assert.equal(codexAggregateNotificationMethod("item/completed", true), "item/completed");
  });

  it("projects only bounded child lifecycle snapshots needed by the subagent UI", () => {
    assert.equal(
      codexSubagentProjectionMethod({
        method: "thread/status/changed",
        params: { threadId: "thread-child", status: { type: "active", activeFlags: [] } },
      }),
      "codex.subagent/threadStatusChanged",
    );
    assert.equal(
      codexSubagentProjectionMethod({
        method: "item/completed",
        params: {
          threadId: "thread-child",
          item: { id: "reasoning-1", type: "reasoning", summary: ["Working"] },
        },
      }),
      "codex.subagent/itemCompleted",
    );
    assert.equal(
      codexSubagentProjectionMethod({
        method: "item/reasoning/summaryTextDelta",
        params: { threadId: "thread-child", delta: "token" },
      }),
      undefined,
    );
  });

  it("routes multi-agent-v2 child output to the parent without forwarding child lifecycle", () => {
    const parentTurnId = TurnId.make("turn-parent");
    const routes = new Map<string, TurnId>();

    rememberCodexChildConversationTurns(
      routes,
      {
        method: "item/completed",
        params: {
          threadId: "thread-parent",
          turnId: "turn-parent",
          item: {
            type: "subAgentActivity",
            id: "subagent-activity-1",
            kind: "started",
            agentThreadId: "thread-child",
            agentPath: "/root/workers/audit",
          },
        },
      },
      parentTurnId,
      "thread-parent",
    );

    assert.equal(routes.get("thread-child"), parentTurnId);
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "turn/started",
          params: {
            threadId: "thread-child",
            turn: {
              id: "turn-child",
              status: "inProgress",
            },
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: true,
      },
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "autoApprovalReview/strictReviewRequired",
          params: {
            threadId: "thread-child",
            turnId: "turn-child",
            startedAtMs: 1_778_000_000_000,
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: false,
      },
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-child",
            turnId: "turn-child",
            itemId: "message-child",
            delta: "progress",
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: false,
      },
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "guardianWarning",
          params: {
            threadId: "thread-child",
            message: "Automatic approval review denied the requested action.",
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: false,
      },
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "thread/environment/disconnected",
          params: {
            threadId: "thread-child",
            environmentId: "local",
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: true,
      },
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "thread/goal/updated",
          params: {
            threadId: "thread-child",
            goal: {
              threadId: "thread-child",
              objective: "Child objective",
              status: "active",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: true,
      },
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "turn/plan/updated",
          params: {
            threadId: "thread-child",
            turnId: "turn-child",
            explanation: "Child-only checklist",
            plan: [{ step: "Inspect child workspace", status: "inProgress" }],
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: true,
      },
    );
  });

  it("forwards goal notifications only from the root provider thread", () => {
    const rootGoal = {
      method: "thread/goal/cleared",
      params: { threadId: "thread-parent" },
    } as const;
    const childGoal = {
      method: "thread/goal/cleared",
      params: { threadId: "thread-child" },
    } as const;

    assert.equal(shouldForwardCodexRootGoalNotification(rootGoal, "thread-parent"), true);
    assert.equal(shouldForwardCodexRootGoalNotification(childGoal, "thread-parent"), false);
    assert.equal(shouldForwardCodexRootGoalNotification(rootGoal, undefined), false);
    assert.equal(
      shouldForwardCodexRootGoalNotification(
        {
          method: "item/completed",
          params: { threadId: "thread-child" },
        },
        "thread-parent",
      ),
      true,
    );
  });

  it("keeps nested subagent output on the original visible parent turn", () => {
    const parentTurnId = TurnId.make("turn-parent");
    const routes = new Map<string, TurnId>([["thread-child", parentTurnId]]);
    const nestedActivity = {
      method: "item/completed",
      params: {
        threadId: "thread-child",
        turnId: "turn-child",
        item: {
          type: "subAgentActivity",
          id: "subagent-activity-2",
          kind: "started",
          agentThreadId: "thread-grandchild",
          agentPath: "/root/workers/nested-audit",
        },
      },
    };
    const childRoute = resolveCodexChildConversationNotification(routes, nestedActivity);

    rememberCodexChildConversationTurns(
      routes,
      nestedActivity,
      childRoute?.parentTurnId ?? TurnId.make("turn-child"),
      "thread-parent",
    );

    assert.equal(routes.get("thread-grandchild"), parentTurnId);
  });

  it("does not reverse-route the primary thread when a child interacts with root", () => {
    const parentTurnId = TurnId.make("turn-parent");
    const routes = new Map<string, TurnId>([
      ["thread-child", parentTurnId],
      // Reproduce the poisoned state created by the older implementation so
      // the regression also proves that processing later activity heals it.
      ["thread-parent", TurnId.make("turn-stale")],
    ]);

    rememberCodexChildConversationTurns(
      routes,
      {
        method: "item/completed",
        params: {
          threadId: "thread-child",
          turnId: "turn-child",
          item: {
            type: "subAgentActivity",
            id: "subagent-activity-to-root",
            kind: "interacted",
            agentThreadId: "thread-parent",
            agentPath: "/root",
          },
        },
      },
      parentTurnId,
      "thread-parent",
    );

    assert.equal(routes.has("thread-parent"), false);
    assert.equal(routes.get("thread-child"), parentTurnId);
    assert.equal(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-parent",
            turnId: "turn-current",
            itemId: "message-root",
            delta: "root output",
          },
        },
        "thread-parent",
      ),
      undefined,
    );
  });

  it("tracks aggregate child liveness from the same live-channel events as the TUI", () => {
    const parentTurnId = TurnId.make("turn-parent");
    const routes = new Map<string, TurnId>([
      ["thread-child-b", parentTurnId],
      ["thread-child-a", parentTurnId],
    ]);
    const registered = updateCodexChildConversationLiveness(
      new Map(),
      routes,
      { method: "item/completed", params: { threadId: "thread-parent" } },
      "2026-07-14T00:00:00.000Z",
    );

    assert.deepEqual(codexChildConversationThreadIdsForTurn(routes, parentTurnId), [
      "thread-child-a",
      "thread-child-b",
    ]);
    assert.equal(codexAggregateTurnHasUnfinishedChildren(routes, registered, parentTurnId), true);

    const childAStarted = updateCodexChildConversationLiveness(
      registered,
      routes,
      {
        method: "turn/started",
        params: {
          threadId: "thread-child-a",
          turn: { id: "turn-child-a", status: "inProgress" },
        },
      },
      "2026-07-14T00:00:01.000Z",
    );
    const childACompleted = updateCodexChildConversationLiveness(
      childAStarted,
      routes,
      {
        method: "turn/completed",
        params: {
          threadId: "thread-child-a",
          turn: { id: "turn-child-a", status: "completed" },
        },
      },
      "2026-07-14T00:00:02.000Z",
    );
    const allCompleted = updateCodexChildConversationLiveness(
      childACompleted,
      routes,
      {
        method: "thread/status/changed",
        params: { threadId: "thread-child-b", status: { type: "idle" } },
      },
      "2026-07-14T00:00:03.000Z",
    );

    assert.equal(childAStarted.get("thread-child-a")?.state, "active");
    assert.equal(childACompleted.get("thread-child-a")?.state, "inactive");
    assert.equal(allCompleted.get("thread-child-b")?.state, "inactive");
    assert.equal(
      codexAggregateTurnHasUnfinishedChildren(routes, allCompleted, parentTurnId),
      false,
    );
  });

  it("uses parent-emitted completed subagent activity as authoritative child liveness", () => {
    const parentTurnId = TurnId.make("turn-parent");
    const routes = new Map<string, TurnId>([["thread-child", parentTurnId]]);
    const started = updateCodexChildConversationLiveness(
      new Map(),
      routes,
      {
        method: "item/started",
        params: {
          threadId: "thread-parent",
          turnId: "turn-parent",
          item: {
            type: "subAgentActivity",
            id: "subagent-activity-started",
            kind: "started",
            agentThreadId: "thread-child",
            agentPath: "/root/workers/audit",
          },
        },
      },
      "2026-08-27T00:00:00.000Z",
    );
    const completed = updateCodexChildConversationLiveness(
      started,
      routes,
      {
        method: "item/completed",
        params: {
          threadId: "thread-parent",
          turnId: "turn-parent",
          item: {
            type: "subAgentActivity",
            id: "subagent-activity-completed",
            kind: "completed",
            agentThreadId: "thread-child",
            agentPath: "/root/workers/audit",
          },
        },
      },
      "2026-08-27T00:00:01.000Z",
    );

    assert.deepStrictEqual(started.get("thread-child"), {
      parentTurnId,
      state: "active",
      observedAt: "2026-08-27T00:00:00.000Z",
      method: "subAgentActivity:started",
    });
    assert.deepStrictEqual(completed.get("thread-child"), {
      parentTurnId,
      state: "inactive",
      observedAt: "2026-08-27T00:00:01.000Z",
      method: "subAgentActivity:completed",
    });
    assert.equal(codexAggregateTurnHasUnfinishedChildren(routes, completed, parentTurnId), false);
  });

  it("resets child liveness when Codex reuses a child thread for a later parent turn", () => {
    const firstParentTurnId = TurnId.make("turn-parent-first");
    const secondParentTurnId = TurnId.make("turn-parent-second");
    const firstRoutes = new Map<string, TurnId>([["thread-child", firstParentTurnId]]);
    const firstTurnCompleted = updateCodexChildConversationLiveness(
      new Map(),
      firstRoutes,
      {
        method: "turn/completed",
        params: {
          threadId: "thread-child",
          turn: { id: "turn-child-first", status: "completed" },
        },
      },
      "2026-07-14T00:00:00.000Z",
    );
    assert.equal(firstTurnCompleted.get("thread-child")?.state, "inactive");

    const secondRoutes = new Map<string, TurnId>([["thread-child", secondParentTurnId]]);
    const reassigned = updateCodexChildConversationLiveness(
      firstTurnCompleted,
      secondRoutes,
      { method: "item/completed", params: { threadId: "thread-parent" } },
      "2026-07-14T00:00:01.000Z",
    );

    assert.equal(reassigned.get("thread-child")?.parentTurnId, secondParentTurnId);
    assert.equal(reassigned.get("thread-child")?.state, "unknown");
    assert.equal(
      codexAggregateTurnHasUnfinishedChildren(secondRoutes, reassigned, secondParentTurnId),
      true,
    );
  });

  it("classifies live child work and terminal thread/read errors conservatively", () => {
    assert.equal(
      isCodexChildConversationWorkNotification({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-child", turnId: "turn-child", delta: "progress" },
      }),
      true,
    );
    assert.equal(
      isCodexChildConversationWorkNotification({
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-child" },
      }),
      false,
    );
    assert.equal(
      isTerminalCodexChildThreadReadError(new Error("thread not loaded: child-1")),
      true,
    );
    assert.equal(
      isTerminalCodexChildThreadReadError(new Error("thread/read transport error: broken pipe")),
      false,
    );
  });
});

describe("Codex notification route fields", () => {
  it("retains turn and native item identities for hook and approval review lifecycle", () => {
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "hook/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          run: { id: "hook-1" },
        },
      }),
      {
        turnId: TurnId.make("turn-1"),
        itemId: ProviderItemId.make("hook-1"),
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "item/autoApprovalReview/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          reviewId: "review-1",
        },
      }),
      {
        turnId: TurnId.make("turn-1"),
        itemId: ProviderItemId.make("review-1"),
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "autoApprovalReview/strictReviewRequired",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          startedAtMs: 1_778_000_000_000,
        },
      }),
      {
        turnId: TurnId.make("turn-1"),
        itemId: undefined,
      },
    );
  });

  it("retains turn and item identities for progress and model lifecycle notifications", () => {
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "item/mcpToolCall/progress",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "mcp-1",
        },
      }),
      {
        turnId: TurnId.make("turn-1"),
        itemId: ProviderItemId.make("mcp-1"),
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "rawResponse/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          responseId: "response-1",
          usage: null,
        },
      }),
      {
        turnId: TurnId.make("turn-1"),
        itemId: undefined,
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "model/rerouted",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }),
      {
        turnId: TurnId.make("turn-1"),
        itemId: undefined,
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "thread/realtime/item/started",
        params: {
          threadId: "thread-1",
          item: {
            type: "bemItemPromoted",
            id: "realtime-item-1",
            realtimeSessionId: "realtime-session-1",
            item_id: "provider-item-1",
            turn_id: "turn-realtime-1",
            presentation: { type: "wholeItem" },
          },
        },
      }),
      {
        turnId: TurnId.make("turn-realtime-1"),
        itemId: ProviderItemId.make("realtime-item-1"),
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "thread/realtime/item/transcript/delta",
        params: {
          threadId: "thread-1",
          itemId: "realtime-transcript-1",
          delta: "private transcript text",
        },
      }),
      {
        turnId: undefined,
        itemId: ProviderItemId.make("realtime-transcript-1"),
      },
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      cliVersion: "0.143.0",
      createdAt: 1_713_403_200,
      cwd: "/tmp/project",
      ephemeral: false,
      id: threadId,
      modelProvider: "openai",
      preview: "",
      projectId: null,
      sessionId: "session-1",
      source: "cli",
      turns: [],
      status: {
        type: "idle",
      },
      updatedAt: 1_713_403_200,
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("normalizes a persisted Claude auto mode when a thread switches to Codex", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Continue with Codex",
        model: "gpt-5.3-codex",
        interactionMode: "auto",
      }),
    );

    assert.equal(params.collaborationMode?.mode, "default");
    assert.equal(
      params.collaborationMode?.settings.developer_instructions,
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    );
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });

  it("includes additional directories as workspace-write writable roots", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        cwd: "/tmp/project",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        additionalDirectories: ["/tmp/docs", "/tmp/tools"],
      }),
    );

    assert.equal(params.cwd, "/tmp/project");
    assert.deepStrictEqual(params.environments, [
      {
        environmentId: "local",
        cwd: "/tmp/project",
        runtimeWorkspaceRoots: ["/tmp/project", "/tmp/docs", "/tmp/tools"],
      },
    ]);
    assert.deepStrictEqual(params.runtimeWorkspaceRoots, [
      "/tmp/project",
      "/tmp/docs",
      "/tmp/tools",
    ]);
    assert.deepStrictEqual(params.sandboxPolicy, {
      type: "workspaceWrite",
      writableRoots: ["/tmp/docs", "/tmp/tools"],
    });
  });
});

describe("buildTurnSteerParams", () => {
  it("builds the upstream Codex turn/steer shape without turn-start overrides", () => {
    const clientCorrelationId = buildCodexSteerClientCorrelationId("message-1");
    const params = Effect.runSync(
      buildTurnSteerParams({
        threadId: "provider-thread-1",
        expectedTurnId: TurnId.make("turn-active"),
        clientUserMessageId: clientCorrelationId,
        prompt: "stay on this path",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      expectedTurnId: "turn-active",
      clientUserMessageId: clientCorrelationId,
      input: [
        {
          type: "text",
          text: "stay on this path",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
    });
  });
});

describe("readCodexSteerExpectedTurnMismatchActualTurnId", () => {
  it("extracts the app-server reported active turn id from upstream mismatch errors", () => {
    const actualTurnId = readCodexSteerExpectedTurnMismatchActualTurnId(
      CodexErrors.CodexAppServerRequestError.invalidRequest(
        "expected active turn id `turn-old` but found `turn-new`",
      ),
    );

    assert.equal(actualTurnId, "turn-new");
  });

  it("extracts the app-server reported active turn id from upstream interrupt mismatches", () => {
    const actualTurnId = readCodexExpectedActiveTurnMismatchActualTurnId(
      CodexErrors.CodexAppServerRequestError.invalidRequest(
        "expected active turn id turn-old but found turn-new",
      ),
    );

    assert.equal(actualTurnId, "turn-new");
  });

  it("ignores unrelated turn/steer request errors", () => {
    const actualTurnId = readCodexSteerExpectedTurnMismatchActualTurnId(
      CodexErrors.CodexAppServerRequestError.invalidRequest("cannot steer a review turn"),
    );

    assert.equal(actualTurnId, undefined);
  });
});

describe("Codex context compaction steer guard", () => {
  it("recognizes upstream context-compaction item type spellings", () => {
    assert.equal(isCodexContextCompactionItemType("contextCompaction"), true);
    assert.equal(isCodexContextCompactionItemType("context_compaction"), true);
    assert.equal(isCodexContextCompactionItemType("context-compaction"), true);
    assert.equal(isCodexContextCompactionItemType("commandExecution"), false);
    assert.equal(isCodexContextCompactionItemType(undefined), false);
  });

  it("tracks context compaction item lifecycle until item or turn completion", () => {
    const turnId = TurnId.make("turn-active");
    const itemId = ProviderItemId.make("context-1");

    const started = updateCodexActiveContextCompactions(new Map(), {
      method: "item/started",
      providerThreadId: "provider-thread-1",
      turnId,
      itemId,
      itemType: "contextCompaction",
      observedAt: "2026-05-26T00:00:00.000Z",
    });

    assert.deepStrictEqual(Array.from(started.values()), [
      {
        providerThreadId: "provider-thread-1",
        turnId,
        itemId,
        startedAt: "2026-05-26T00:00:00.000Z",
      },
    ]);

    const ignored = updateCodexActiveContextCompactions(started, {
      method: "item/started",
      providerThreadId: "provider-thread-1",
      turnId,
      itemId: ProviderItemId.make("command-1"),
      itemType: "commandExecution",
      observedAt: "2026-05-26T00:00:01.000Z",
    });
    assert.equal(ignored.size, 1);

    const completed = updateCodexActiveContextCompactions(started, {
      method: "item/completed",
      providerThreadId: "provider-thread-1",
      turnId,
      itemId,
      itemType: undefined,
      observedAt: "2026-05-26T00:00:02.000Z",
    });
    assert.equal(completed.size, 0);

    const restarted = updateCodexActiveContextCompactions(completed, {
      method: "item/started",
      providerThreadId: "provider-thread-1",
      turnId,
      itemId,
      itemType: "contextCompaction",
      observedAt: "2026-05-26T00:00:03.000Z",
    });
    const turnCompleted = updateCodexActiveContextCompactions(restarted, {
      method: "turn/completed",
      providerThreadId: "provider-thread-1",
      turnId,
      observedAt: "2026-05-26T00:00:04.000Z",
    });
    assert.equal(turnCompleted.size, 0);
  });

  it("builds a structured compact-turn steer precondition error without prompt data", () => {
    const error = buildCodexActiveContextCompactionSteerError({
      providerThreadId: "provider-thread-1",
      turnId: TurnId.make("turn-active"),
      itemId: ProviderItemId.make("context-1"),
      startedAt: "2026-05-26T00:00:00.000Z",
    });

    assert.equal(error.code, -32600);
    assert.equal(error.errorMessage, "cannot steer a compact turn");
    assert.deepStrictEqual(error.data, {
      message: "cannot steer a compact turn",
      codexErrorInfo: {
        activeTurnNotSteerable: {
          turnKind: "compact",
        },
      },
      additionalDetails: {
        providerThreadId: "provider-thread-1",
        turnId: "turn-active",
        itemId: "context-1",
        contextCompactionStartedAt: "2026-05-26T00:00:00.000Z",
      },
    });
  });
});

describe("Codex steer processing diagnostics", () => {
  it("accepts only fixed-size correlations inside provider runtime state", () => {
    const token = buildCodexSteerClientCorrelationId("message-1");

    assert.equal(
      resolveCodexSessionRuntimeSteerClientCorrelationId({
        clientCorrelationId: token,
        fallbackSource: "unused",
      }),
      token,
    );
    assert.equal(
      resolveCodexSessionRuntimeSteerClientCorrelationId({
        clientCorrelationId: `raw-message-${"x".repeat(4_096)}`,
        fallbackSource: "unused",
      }),
      undefined,
    );
    assert.equal(
      resolveCodexSessionRuntimeSteerClientCorrelationId({
        clientCorrelationId: undefined,
        fallbackSource: "steer-random-source",
      }),
      buildCodexSteerClientCorrelationId("steer-random-source"),
    );
  });

  it("recognizes upstream user-message item type spellings", () => {
    assert.equal(isCodexUserMessageItemType("userMessage"), true);
    assert.equal(isCodexUserMessageItemType("user_message"), true);
    assert.equal(isCodexUserMessageItemType("user-message"), true);
    assert.equal(isCodexUserMessageItemType("commandExecution"), false);
    assert.equal(isCodexUserMessageItemType(undefined), false);
  });

  it("recovers a bounded content-free message correlation after runtime restart", () => {
    const clientCorrelationId = buildCodexSteerClientCorrelationId("message-after-restart");
    const result = updateCodexPendingSteerProcessingFromNotification(new Map(), {
      method: "item/started",
      providerThreadId: "provider-thread-1",
      turnId: TurnId.make("turn-active"),
      itemId: ProviderItemId.make("user-message-after-restart"),
      itemType: "userMessage",
      clientUserMessageId: clientCorrelationId,
      observedAt: "2026-05-26T00:00:03.000Z",
      observedAtMs: 3_000,
    });

    assert.equal(result.pending, undefined);
    assert.deepStrictEqual(result.restartedObservation, {
      clientCorrelationId,
      providerThreadId: "provider-thread-1",
      turnId: "turn-active",
      providerUserMessageItemId: "user-message-after-restart",
      providerUserMessageMethod: "item/started",
      observedAt: "2026-05-26T00:00:03.000Z",
    });
    assert.equal(result.next.size, 0);
  });

  it("rejects malformed or oversized provider client ids from restart correlation", () => {
    const valid = buildCodexSteerClientCorrelationId("message-1");
    assert.equal(parseCodexSteerClientCorrelationId(" message-1"), undefined);
    assert.equal(parseCodexSteerClientCorrelationId("message-1\nspoof"), undefined);
    assert.equal(parseCodexSteerClientCorrelationId(`message-${"x".repeat(600)}`), undefined);
    assert.equal(parseCodexSteerClientCorrelationId(valid), valid);

    const malformed = updateCodexPendingSteerProcessingFromNotification(new Map(), {
      method: "item/started",
      turnId: TurnId.make("turn-active"),
      itemType: "userMessage",
      clientUserMessageId: "message-1\u202Espoof",
      observedAt: "2026-05-26T00:00:03.000Z",
      observedAtMs: 3_000,
    });
    assert.equal(malformed.restartedObservation, undefined);
  });

  it("deduplicates restart observations across the provider item lifecycle with bounded history", () => {
    const observation = {
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-after-restart"),
      providerThreadId: "provider-thread-1",
      turnId: TurnId.make("turn-active"),
      providerUserMessageItemId: ProviderItemId.make("item-after-restart"),
      providerUserMessageMethod: "item/started",
      observedAt: "2026-05-26T00:00:03.000Z",
    };
    const started = claimCodexRestartedSteerProcessingObservation(new Map(), observation);
    const completed = claimCodexRestartedSteerProcessingObservation(started.next, {
      ...observation,
      providerUserMessageMethod: "item/completed",
      observedAt: "2026-05-26T00:00:03.100Z",
    });

    assert.equal(started.claimed, true);
    assert.equal(completed.claimed, false);
    assert.equal(completed.next.size, 1);

    let bounded = completed.next;
    for (let index = 0; index < 1_000; index += 1) {
      const claim = claimCodexRestartedSteerProcessingObservation(bounded, {
        ...observation,
        clientCorrelationId: buildCodexSteerClientCorrelationId(`message-${index}`),
        observedAt: new Date(Date.UTC(2026, 4, 26) + index).toISOString(),
      });
      assert.equal(claim.claimed, true);
      bounded = claim.next;
    }
    assert.equal(bounded.size, 256);
    assert.equal(bounded.has(buildCodexSteerClientCorrelationId("message-after-restart")), false);
    assert.equal(bounded.has(buildCodexSteerClientCorrelationId("message-999")), true);
  });

  it("summarizes active app-server child processes without leaking credential material", () => {
    const diagnostics = summarizeCodexAppServerChildProcesses({
      appServerPid: 100,
      diagnosticsRootPid: 1,
      rows: [
        {
          pid: 100,
          ppid: 1,
          pgid: 100,
          status: "S",
          cpuPercent: 0.1,
          rssBytes: 10_000,
          elapsed: "12:00",
          command: "codex app-server",
        },
        {
          pid: 101,
          ppid: 100,
          pgid: 100,
          status: "S",
          cpuPercent: 1.5,
          rssBytes: 20_000,
          elapsed: "21:50",
          command:
            "/opt/anaconda3/bin/python /opt/anaconda3/bin/selene burst . 262 --token npm_abcdEFGHijklMNOPqrstUVWX",
        },
        {
          pid: 102,
          ppid: 101,
          pgid: 100,
          status: "R",
          cpuPercent: 2.25,
          rssBytes: 30_000,
          elapsed: "00:05",
          command: "codex exec --model gpt-5.5 --auth-file /Users/mike/.codex/auth.json",
        },
        {
          pid: 200,
          ppid: 1,
          pgid: 200,
          status: "S",
          cpuPercent: 99,
          rssBytes: 99_000,
          elapsed: "00:01",
          command: "unrelated",
        },
      ],
    });

    assert.equal(diagnostics.status, "available");
    if (diagnostics.status !== "available") return;
    assert.equal(diagnostics.processCount, 2);
    assert.equal(diagnostics.activeProcessCount, 2);
    assert.equal(diagnostics.supportProcessCount, 0);
    assert.equal(diagnostics.totalCpuPercent, 3.75);
    assert.equal(diagnostics.totalRssBytes, 50_000);
    assert.equal(diagnostics.longestElapsed, "21:50");
    assert.deepStrictEqual(
      diagnostics.processes.map((process) => [
        process.pid,
        process.ppid,
        process.depth,
        process.role,
        process.command,
      ]),
      [
        [101, 100, 0, "active", "selene burst . 262"],
        [102, 101, 1, "active", "codex exec --model gpt-5.5"],
      ],
    );
    assert.equal(diagnostics.processes[0]?.childPids[0], 102);
    assert.ok(!diagnostics.processes[0]?.command.includes("npm_abcd"));
    assert.ok(!diagnostics.processes[1]?.command.includes("auth.json"));
  });

  it("classifies persistent Codex helper processes as support instead of active turn work", () => {
    const diagnostics = summarizeCodexAppServerChildProcesses({
      appServerPid: 100,
      diagnosticsRootPid: 1,
      rows: [
        {
          pid: 100,
          ppid: 1,
          pgid: 100,
          status: "S",
          cpuPercent: 0,
          rssBytes: 10_000,
          elapsed: "12:00",
          command: "codex app-server",
        },
        {
          pid: 101,
          ppid: 100,
          pgid: 100,
          status: "S",
          cpuPercent: 0,
          rssBytes: 20_000,
          elapsed: "11:50",
          command: "/Applications/Codex.app/Contents/Resources/SkyComputerUseClient mcp",
        },
        {
          pid: 102,
          ppid: 100,
          pgid: 100,
          status: "S",
          cpuPercent: 0,
          rssBytes: 30_000,
          elapsed: "11:45",
          command: "/Applications/Codex.app/Contents/Resources/node_repl",
        },
        {
          pid: 103,
          ppid: 100,
          pgid: 100,
          status: "S",
          cpuPercent: 0,
          rssBytes: 40_000,
          elapsed: "11:40",
          command: "/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://",
        },
        {
          pid: 104,
          ppid: 100,
          pgid: 100,
          status: "R",
          cpuPercent: 5,
          rssBytes: 50_000,
          elapsed: "00:02",
          command: "bash -lc yarn build",
        },
        {
          pid: 105,
          ppid: 100,
          pgid: 100,
          status: "S",
          cpuPercent: 0,
          rssBytes: 60_000,
          elapsed: "11:35",
          command:
            "/Users/mike/.nvm/versions/node/v25.9.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex app-server",
        },
      ],
    });

    assert.equal(diagnostics.status, "available");
    if (diagnostics.status !== "available") return;
    assert.equal(diagnostics.processCount, 5);
    assert.equal(diagnostics.activeProcessCount, 1);
    assert.equal(diagnostics.supportProcessCount, 4);
    assert.deepStrictEqual(
      diagnostics.processes.map((process) => [process.pid, process.role, process.supportReason]),
      [
        [101, "support", "codex-bundled-computer-use-mcp"],
        [102, "support", "codex-bundled-node-repl"],
        [103, "support", "codex-bundled-nested-app-server"],
        [104, "active", undefined],
        [105, "support", "codex-app-server-runtime"],
      ],
    );
  });

  it("marks the oldest unprocessed steer when Codex emits the injected user message item", () => {
    const turnId = TurnId.make("turn-active");
    const first = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };
    const second = {
      ...first,
      steerId: "steer-2",
      requestedAt: "2026-05-26T00:00:02.000Z",
      acknowledgedAt: "2026-05-26T00:00:02.100Z",
      acknowledgedAtMs: 2_100,
    };

    const { pending, next } = updateCodexPendingSteerProcessingFromNotification(
      new Map([
        [first.steerId, first],
        [second.steerId, second],
      ]),
      {
        method: "item/started",
        providerThreadId: "provider-thread-1",
        turnId,
        itemId: ProviderItemId.make("user-message-1"),
        itemType: "userMessage",
        observedAt: "2026-05-26T00:00:03.000Z",
        observedAtMs: 3_000,
      },
    );

    assert.equal(pending?.steerId, "steer-1");
    assert.equal(pending?.providerUserMessageItemId, "user-message-1");
    assert.equal(pending?.providerUserMessageMethod, "item/started");
    assert.equal(pending?.ackToProviderItemMs, 2_900);
    assert.equal(next.get("steer-2")?.processedAt, undefined);
  });

  it("matches an injected user message to its client correlation instead of acknowledgement order", () => {
    const turnId = TurnId.make("turn-active");
    const secondMessageId = decodeMessageId(`message-\u0000-\u202e-${"x".repeat(600)}-tail`);
    const first: CodexPendingSteerProcessing = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };
    const second: CodexPendingSteerProcessing = {
      ...first,
      steerId: "steer-2",
      clientCorrelationId: buildCodexSteerClientCorrelationId(secondMessageId),
      requestedAt: "2026-05-26T00:00:02.000Z",
      acknowledgedAt: "2026-05-26T00:00:02.100Z",
      acknowledgedAtMs: 2_100,
    };

    const { pending, next } = updateCodexPendingSteerProcessingFromNotification(
      new Map([
        [first.steerId, first],
        [second.steerId, second],
      ]),
      {
        method: "item/started",
        providerThreadId: "provider-thread-1",
        turnId,
        itemId: ProviderItemId.make("user-message-2"),
        itemType: "userMessage",
        clientUserMessageId: second.clientCorrelationId,
        observedAt: "2026-05-26T00:00:03.000Z",
        observedAtMs: 3_000,
      },
    );

    assert.equal(pending?.steerId, "steer-2");
    assert.equal(pending?.clientCorrelationId, buildCodexSteerClientCorrelationId(secondMessageId));
    assert.equal(pending?.providerUserMessageItemId, "user-message-2");
    assert.equal(next.get("steer-1")?.processedAt, undefined);
    const serializedPendingState = JSON.stringify([...next]);
    assert.equal(serializedPendingState.includes('"messageId"'), false);
    assert.equal(serializedPendingState.includes("x".repeat(600)), false);
  });

  it("does not consume another pending steer for an unknown client correlation", () => {
    const turnId = TurnId.make("turn-active");
    const pendingSteer = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };

    const { pending, restartedObservation, next } =
      updateCodexPendingSteerProcessingFromNotification(
        new Map([[pendingSteer.steerId, pendingSteer]]),
        {
          method: "item/started",
          providerThreadId: "provider-thread-1",
          turnId,
          itemId: ProviderItemId.make("unrelated-user-message"),
          itemType: "userMessage",
          clientUserMessageId: buildCodexSteerClientCorrelationId("some-other-client-message"),
          observedAt: "2026-05-26T00:00:03.000Z",
          observedAtMs: 3_000,
        },
      );

    assert.equal(pending, undefined);
    assert.equal(
      restartedObservation?.clientCorrelationId,
      buildCodexSteerClientCorrelationId("some-other-client-message"),
    );
    assert.equal(next.get("steer-1")?.processedAt, undefined);
  });

  it("does not let an exact client id rebind a steer from another turn", () => {
    const targetTurnId = TurnId.make("turn-target");
    const unrelatedTurnId = TurnId.make("turn-unrelated");
    const pendingSteer = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId: targetTurnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };

    const { pending, restartedObservation, next } =
      updateCodexPendingSteerProcessingFromNotification(
        new Map([[pendingSteer.steerId, pendingSteer]]),
        {
          method: "item/started",
          providerThreadId: pendingSteer.providerThreadId,
          turnId: unrelatedTurnId,
          itemId: ProviderItemId.make("spoofed-user-message"),
          itemType: "userMessage",
          clientUserMessageId: pendingSteer.clientCorrelationId,
          observedAt: "2026-05-26T00:00:03.000Z",
          observedAtMs: 3_000,
        },
      );

    assert.equal(pending, undefined);
    assert.equal(restartedObservation, undefined);
    assert.equal(next.get(pendingSteer.steerId)?.turnId, targetTurnId);
    assert.equal(next.get(pendingSteer.steerId)?.processedAt, undefined);
  });

  it("records provider processing when the correlated user message arrives before acknowledgement", () => {
    const turnId = TurnId.make("turn-active");
    const inFlightSteer = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };

    const { pending, next } = updateCodexPendingSteerProcessingFromNotification(
      new Map([[inFlightSteer.steerId, inFlightSteer]]),
      {
        method: "item/started",
        providerThreadId: "provider-thread-1",
        turnId,
        itemId: ProviderItemId.make("user-message-1"),
        itemType: "userMessage",
        clientUserMessageId: inFlightSteer.clientCorrelationId,
        observedAt: "2026-05-26T00:00:00.050Z",
        observedAtMs: 50,
      },
    );

    assert.equal(pending?.steerId, "steer-1");
    assert.equal(pending?.processedAt, "2026-05-26T00:00:00.050Z");
    assert.equal(pending?.providerUserMessageItemId, "user-message-1");
    assert.equal(pending?.ackToProviderItemMs, undefined);
    assert.equal(next.get("steer-1")?.processedAt, "2026-05-26T00:00:00.050Z");
  });

  it("preserves terminal state when acknowledgement arrives after completion", () => {
    const turnId = TurnId.make("turn-active");
    const inFlightSteer = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };

    const terminal = terminalizeCodexPendingSteerProcessing(
      new Map([[inFlightSteer.steerId, inFlightSteer]]),
      {
        turnId,
        terminalState: "interrupted",
        observedAt: "2026-05-26T00:00:00.050Z",
      },
    );
    const acknowledged = acknowledgeCodexPendingSteerProcessing(terminal.next, {
      steerId: inFlightSteer.steerId,
      turnId,
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
    });
    assert.equal(acknowledged.pending?.steerId, inFlightSteer.steerId);
    assert.equal(acknowledged.pending?.terminalState, "interrupted");

    const replayedTerminal = terminalizeCodexPendingSteerProcessing(acknowledged.next, {
      turnId,
      terminalState: "interrupted",
      observedAt: "2026-05-26T00:00:00.200Z",
    });
    assert.equal(replayedTerminal.next.get(inFlightSteer.steerId)?.terminalState, "interrupted");
  });

  effectIt.effect(
    "keeps an authoritative thread/read terminal snapshot final when the steer ACK resumes late",
    () =>
      Effect.gen(function* () {
        const turnId = TurnId.make("turn-active");
        const pending = makePendingSteerProcessingFixture(1);
        const pendingRef = yield* Ref.make(
          new Map<string, CodexPendingSteerProcessing>([[pending.steerId, pending]]),
        );
        const sessionRef = yield* Ref.make<ProviderSession>({
          provider: ProviderDriverKind.make("codex"),
          status: "running",
          runtimeMode: "full-access",
          cwd: "/workspace",
          threadId: ThreadId.make("thread-1"),
          activeTurnId: turnId,
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z",
          lastError: "stale failure from a previous turn",
        });
        const semaphore = yield* Semaphore.make(1);
        const ackWaiting = yield* Deferred.make<void>();
        const releaseAck = yield* Deferred.make<void>();

        // Model the JSON-RPC response continuation being runnable but held
        // until the authoritative thread/read handler has committed. This
        // gives the regression a deterministic late-ACK order without sleeps.
        const acknowledgementFiber = yield* Effect.gen(function* () {
          yield* Deferred.succeed(ackWaiting, undefined);
          yield* Deferred.await(releaseAck);
          return yield* acknowledgeCodexSteerLifecycleBoundary({
            semaphore,
            pendingRef,
            sessionRef,
            steerId: pending.steerId,
            expectedTurnId: turnId,
            turnId,
            acknowledgedAt: "2026-05-26T00:00:00.100Z",
            acknowledgedAtMs: 100,
            ackLatencyMs: 100,
          });
        }).pipe(Effect.forkChild);

        yield* Deferred.await(ackWaiting);
        yield* reconcileCodexTerminalSnapshotSteerLifecycle({
          semaphore,
          pendingRef,
          sessionRef,
          turnId,
          turnStatus: "completed",
          observedAt: "2026-05-26T00:00:00.050Z",
        });
        yield* Deferred.succeed(releaseAck, undefined);

        const acknowledgement = yield* Fiber.join(acknowledgementFiber);
        const finalSession = yield* Ref.get(sessionRef);
        const finalPending = (yield* Ref.get(pendingRef)).get(pending.steerId);

        assert.equal(acknowledgement.restoredRunning, false);
        assert.equal(acknowledgement.pending?.acknowledgedAt, "2026-05-26T00:00:00.100Z");
        assert.equal(finalSession.status, "ready");
        assert.equal(finalSession.activeTurnId, undefined);
        assert.equal(finalSession.lastError, undefined);
        assert.equal(finalSession.updatedAt, "2026-05-26T00:00:00.050Z");
        assert.equal(finalPending?.terminalState, "completed");
        assert.equal(finalPending?.terminalObservedAt, "2026-05-26T00:00:00.050Z");
        assert.equal(finalPending?.acknowledgedAt, "2026-05-26T00:00:00.100Z");
      }),
  );

  effectIt.effect("commits a late T1 completion before publication without clearing live T2", () =>
    Effect.gen(function* () {
      const firstTurnId = TurnId.make("turn-1");
      const secondTurnId = TurnId.make("turn-2");
      const pending = {
        ...makePendingSteerProcessingFixture(1),
        turnId: firstTurnId,
      } satisfies CodexPendingSteerProcessing;
      const pendingRef = yield* Ref.make(
        new Map<string, CodexPendingSteerProcessing>([[pending.steerId, pending]]),
      );
      const sessionRef = yield* Ref.make<ProviderSession>({
        provider: ProviderDriverKind.make("codex"),
        status: "running",
        runtimeMode: "full-access",
        cwd: "/workspace",
        threadId: ThreadId.make("thread-1"),
        activeTurnId: firstTurnId,
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z",
      });
      const semaphore = yield* Semaphore.make(1);
      const terminalWaiting = yield* Deferred.make<void>();
      const releaseTerminal = yield* Deferred.make<void>();
      const stateObservedAtPublication = yield* Ref.make<{
        readonly session: ProviderSession;
        readonly pending: CodexPendingSteerProcessing | undefined;
      } | null>(null);

      // Hold the old turn's terminal handler until the newer turn has become
      // visible. This models independent notification fibers without sleeps
      // or relying on scheduler/semaphore FIFO behavior.
      const terminalFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(terminalWaiting, undefined);
        yield* Deferred.await(releaseTerminal);
        return yield* publishCodexTurnCompletionAfterLifecycleBoundary({
          semaphore,
          pendingRef,
          sessionRef,
          turnId: firstTurnId,
          turnStatus: "completed",
          observedAt: "2026-05-26T00:00:00.200Z",
          publish: Effect.gen(function* () {
            const session = yield* Ref.get(sessionRef);
            const pendingAtPublication = (yield* Ref.get(pendingRef)).get(pending.steerId);
            yield* Ref.set(stateObservedAtPublication, {
              session,
              pending: pendingAtPublication,
            });
          }),
        });
      }).pipe(Effect.forkChild);

      yield* Deferred.await(terminalWaiting);
      yield* Ref.update(sessionRef, (session) => ({
        ...session,
        status: "running" as const,
        activeTurnId: secondTurnId,
        lastError: "turn-2 remains live",
        updatedAt: "2026-05-26T00:00:00.100Z",
      }));
      yield* Deferred.succeed(releaseTerminal, undefined);

      const terminalizedVisibleSession = yield* Fiber.join(terminalFiber);
      const finalSession = yield* Ref.get(sessionRef);
      const finalPending = (yield* Ref.get(pendingRef)).get(pending.steerId);
      const publishedState = yield* Ref.get(stateObservedAtPublication);

      assert.equal(terminalizedVisibleSession, false);
      assert.equal(finalSession.status, "running");
      assert.equal(finalSession.activeTurnId, secondTurnId);
      assert.equal(finalSession.lastError, "turn-2 remains live");
      assert.equal(finalSession.updatedAt, "2026-05-26T00:00:00.100Z");
      assert.equal(finalPending?.terminalState, "completed");
      assert.equal(finalPending?.terminalObservedAt, "2026-05-26T00:00:00.200Z");
      assert.equal(publishedState?.session.activeTurnId, secondTurnId);
      assert.equal(publishedState?.pending?.terminalState, "completed");
    }),
  );

  effectIt.effect("does not apply a late T1 failure to live T2", () =>
    Effect.gen(function* () {
      const firstTurnId = TurnId.make("turn-1");
      const secondTurnId = TurnId.make("turn-2");
      const pending = {
        ...makePendingSteerProcessingFixture(1),
        turnId: firstTurnId,
      } satisfies CodexPendingSteerProcessing;
      const pendingRef = yield* Ref.make(
        new Map<string, CodexPendingSteerProcessing>([[pending.steerId, pending]]),
      );
      const sessionRef = yield* Ref.make<ProviderSession>({
        provider: ProviderDriverKind.make("codex"),
        status: "running",
        runtimeMode: "full-access",
        cwd: "/workspace",
        threadId: ThreadId.make("thread-1"),
        activeTurnId: secondTurnId,
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.100Z",
        lastError: "turn-2 diagnostic",
      });
      const semaphore = yield* Semaphore.make(1);
      const stateObservedAtPublication = yield* Ref.make<ProviderSession | null>(null);

      const terminalizedVisibleSession = yield* publishCodexTurnCompletionAfterLifecycleBoundary({
        semaphore,
        pendingRef,
        sessionRef,
        turnId: firstTurnId,
        turnStatus: "failed",
        errorMessage: "turn-1 failed late",
        observedAt: "2026-05-26T00:00:00.200Z",
        publish: Ref.get(sessionRef).pipe(
          Effect.flatMap((session) => Ref.set(stateObservedAtPublication, session)),
        ),
      });

      const finalSession = yield* Ref.get(sessionRef);
      const finalPending = (yield* Ref.get(pendingRef)).get(pending.steerId);
      const publishedSession = yield* Ref.get(stateObservedAtPublication);

      assert.equal(terminalizedVisibleSession, false);
      assert.equal(finalSession.activeTurnId, secondTurnId);
      assert.equal(finalSession.status, "running");
      assert.equal(finalSession.lastError, "turn-2 diagnostic");
      assert.equal(finalPending?.terminalState, "failed");
      assert.equal(publishedSession?.activeTurnId, secondTurnId);
      assert.equal(publishedSession?.lastError, "turn-2 diagnostic");
    }),
  );

  it("does not recover a steer whose correlated user message was processed before terminal", () => {
    const turnId = TurnId.make("turn-active");
    const inFlightSteer = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };
    const processed = updateCodexPendingSteerProcessingFromNotification(
      new Map([[inFlightSteer.steerId, inFlightSteer]]),
      {
        method: "item/started",
        providerThreadId: inFlightSteer.providerThreadId,
        turnId,
        itemId: ProviderItemId.make("user-message-1"),
        itemType: "userMessage",
        clientUserMessageId: inFlightSteer.clientCorrelationId,
        observedAt: "2026-05-26T00:00:00.050Z",
        observedAtMs: 50,
      },
    );
    const acknowledged = acknowledgeCodexPendingSteerProcessing(processed.next, {
      steerId: inFlightSteer.steerId,
      turnId,
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
    });
    assert.equal(acknowledged.pending?.ackToProviderItemMs, 0);

    const terminal = terminalizeCodexPendingSteerProcessing(acknowledged.next, {
      turnId,
      terminalState: "completed",
      observedAt: "2026-05-26T00:00:00.200Z",
    });
    assert.equal(terminal.next.get(inFlightSteer.steerId)?.processedAt !== undefined, true);
  });

  it("retargets a stale expected-turn correlation before retrying provider I/O", () => {
    const staleTurnId = TurnId.make("turn-stale");
    const activeTurnId = TurnId.make("turn-active");
    const pending = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId: staleTurnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
      terminalObservedAt: "2026-05-26T00:00:00.050Z",
      terminalState: "completed" as const,
    };

    const retargeted = retargetCodexPendingSteerProcessing(new Map([[pending.steerId, pending]]), {
      steerId: pending.steerId,
      turnId: activeTurnId,
    });
    assert.equal(retargeted.get(pending.steerId)?.turnId, activeTurnId);
    assert.equal(retargeted.get(pending.steerId)?.terminalObservedAt, undefined);

    const terminal = terminalizeCodexPendingSteerProcessing(retargeted, {
      turnId: activeTurnId,
      terminalState: "interrupted",
      observedAt: "2026-05-26T00:00:00.100Z",
    });
    const acknowledged = acknowledgeCodexPendingSteerProcessing(terminal.next, {
      steerId: pending.steerId,
      turnId: activeTurnId,
      acknowledgedAt: "2026-05-26T00:00:00.150Z",
      acknowledgedAtMs: 150,
      ackLatencyMs: 150,
    });
    assert.equal(acknowledged.pending?.turnId, activeTurnId);
    assert.equal(acknowledged.pending?.terminalState, "interrupted");
  });

  it("never evicts unresolved steer correlations to enforce the history cap", () => {
    const unresolved = new Map<string, CodexPendingSteerProcessing>(
      Array.from({ length: 51 }, (_, index) => {
        const steerId = `steer-${index.toString().padStart(2, "0")}`;
        return [
          steerId,
          {
            steerId,
            clientCorrelationId: buildCodexSteerClientCorrelationId(`message-${index}`),
            providerThreadId: "provider-thread-1",
            turnId: TurnId.make("turn-active"),
            requestedAt: `2026-05-26T00:00:${index.toString().padStart(2, "0")}.000Z`,
            promptByteLength: 10,
            attachmentCount: 0,
            warningCount: 0,
          },
        ] as const;
      }),
    );

    assert.equal(prunePendingSteerProcessing(unresolved).size, 51);

    const withSettledOldest = new Map(unresolved);
    const oldest = withSettledOldest.get("steer-00")!;
    withSettledOldest.set("steer-00", {
      ...oldest,
      processedAt: "2026-05-26T00:01:00.000Z",
    });
    const pruned = prunePendingSteerProcessing(withSettledOldest);
    assert.equal(pruned.size, 50);
    assert.equal(pruned.has("steer-00"), false);
  });

  it("applies bounded backpressure without evicting unresolved accepted or ambiguous steers", () => {
    let current = new Map<string, CodexPendingSteerProcessing>();
    for (let index = 0; index < CODEX_PENDING_STEER_UNRESOLVED_CAPACITY; index += 1) {
      const admission = admitCodexPendingSteerProcessing(
        current,
        makePendingSteerProcessingFixture(index),
      );
      assert.equal(admission.admitted, true);
      current = admission.next;
    }

    const protectedIds = [...current.keys()];
    for (let index = 0; index < 2_000; index += 1) {
      const denied = admitCodexPendingSteerProcessing(
        current,
        makePendingSteerProcessingFixture(CODEX_PENDING_STEER_UNRESOLVED_CAPACITY + index),
      );
      assert.equal(denied.admitted, false);
      assert.equal(denied.unresolvedCount, CODEX_PENDING_STEER_UNRESOLVED_CAPACITY);
      assert.equal(denied.next.size, CODEX_PENDING_STEER_UNRESOLVED_CAPACITY);
      current = denied.next;
    }
    assert.deepStrictEqual([...current.keys()], protectedIds);

    const settled = current.get("steer-0")!;
    current.set("steer-0", {
      ...settled,
      processedAt: "2026-05-26T00:01:00.000Z",
    });
    const admittedAfterSettlement = admitCodexPendingSteerProcessing(
      current,
      makePendingSteerProcessingFixture(CODEX_PENDING_STEER_UNRESOLVED_CAPACITY + 2_001),
    );
    assert.equal(admittedAfterSettlement.admitted, true);
    assert.equal(admittedAfterSettlement.next.has("steer-0"), false);
    assert.equal(admittedAfterSettlement.next.size, CODEX_PENDING_STEER_UNRESOLVED_CAPACITY);
    for (const id of protectedIds.slice(1)) {
      assert.equal(admittedAfterSettlement.next.has(id), true);
    }
  });

  it("builds content-free steer admission backpressure errors", () => {
    const error = buildCodexPendingSteerCapacityError({
      unresolvedCount: CODEX_PENDING_STEER_UNRESOLVED_CAPACITY,
      capacity: CODEX_PENDING_STEER_UNRESOLVED_CAPACITY,
    });

    assert.equal(error.code, -32600);
    assert.equal(error.errorMessage, "cannot steer while unresolved steer capacity is exhausted");
    assert.deepStrictEqual(error.data, {
      message: "cannot steer while unresolved steer capacity is exhausted",
      additionalDetails: {
        unresolvedCount: CODEX_PENDING_STEER_UNRESOLVED_CAPACITY,
        capacity: CODEX_PENDING_STEER_UNRESOLVED_CAPACITY,
        retryableAfterReconciliation: true,
      },
    });
  });

  it("binds a user message lifecycle pair to only one pending steer", () => {
    const turnId = TurnId.make("turn-active");
    const first = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };
    const second = {
      ...first,
      steerId: "steer-2",
      requestedAt: "2026-05-26T00:00:02.000Z",
      acknowledgedAt: "2026-05-26T00:00:02.100Z",
      acknowledgedAtMs: 2_100,
    };
    const itemId = ProviderItemId.make("user-message-1");
    const started = updateCodexPendingSteerProcessingFromNotification(
      new Map([
        [first.steerId, first],
        [second.steerId, second],
      ]),
      {
        method: "item/started",
        providerThreadId: "provider-thread-1",
        turnId,
        itemId,
        itemType: "userMessage",
        observedAt: "2026-05-26T00:00:03.000Z",
        observedAtMs: 3_000,
      },
    );

    const completed = updateCodexPendingSteerProcessingFromNotification(started.next, {
      method: "item/completed",
      providerThreadId: "provider-thread-1",
      turnId,
      itemId,
      itemType: "userMessage",
      observedAt: "2026-05-26T00:00:03.100Z",
      observedAtMs: 3_100,
    });

    assert.equal(started.pending?.steerId, "steer-1");
    assert.equal(completed.pending, undefined);
    assert.equal(completed.restartedObservation, undefined);
    assert.equal(completed.next.get("steer-1")?.providerUserMessageMethod, "item/started");
    assert.equal(completed.next.get("steer-2")?.processedAt, undefined);
  });

  it("ignores non-user-message notifications when tracking steer processing", () => {
    const turnId = TurnId.make("turn-active");
    const pendingSteer = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAtMs: 0,
      ackLatencyMs: 0,
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };

    const result = updateCodexPendingSteerProcessingFromNotification(
      new Map([[pendingSteer.steerId, pendingSteer]]),
      {
        method: "item/started",
        providerThreadId: "provider-thread-1",
        turnId,
        itemId: ProviderItemId.make("command-1"),
        itemType: "commandExecution",
        observedAt: "2026-05-26T00:00:03.000Z",
        observedAtMs: 3_000,
      },
    );

    assert.equal(result.pending, undefined);
    assert.equal(result.next.get("steer-1")?.processedAt, undefined);
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("buildCodexThreadSnapshotBackfillEvents", () => {
  it("emits normal lifecycle events for the latest assistant snapshot turn", () => {
    const events = buildCodexThreadSnapshotBackfillEvents({
      threadId: ThreadId.make("thread-1"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerThread: {
        id: "provider-thread-1",
        turns: [
          {
            id: "turn-old",
            status: "completed",
            startedAt: 1_779_000_000,
            completedAt: 1_779_000_001,
            items: [
              {
                id: "old-message",
                type: "agentMessage",
                text: "old response",
              },
            ],
          },
          {
            id: "turn-new",
            status: "interrupted",
            startedAt: 1_779_000_100,
            completedAt: null,
            items: [
              {
                id: "new-message",
                type: "agentMessage",
                text: "new response",
              },
              {
                id: "empty-message",
                type: "agentMessage",
                text: "   ",
              },
              {
                id: "context-1",
                type: "contextCompaction",
              },
            ],
          },
        ],
      },
      createdAt: "2026-05-24T00:00:00.000Z",
      reason: "session-resume",
    });

    assert.deepStrictEqual(
      events.map((event) => ({
        id: event.id,
        method: event.method,
        turnId: event.turnId,
        itemId: event.itemId,
        createdAt: event.createdAt,
      })),
      [
        {
          id: "codex-snapshot:session-resume:provider-thread-1:turn-new:turn-started",
          method: "turn/started",
          turnId: "turn-new",
          itemId: undefined,
          createdAt: "2026-05-17T06:41:40.000Z",
        },
        {
          id: "codex-snapshot:session-resume:provider-thread-1:turn-new:new-message:item-completed",
          method: "item/completed",
          turnId: "turn-new",
          itemId: "new-message",
          createdAt: "2026-05-24T00:00:00.000Z",
        },
        {
          id: "codex-snapshot:session-resume:provider-thread-1:turn-new:turn-completed",
          method: "turn/completed",
          turnId: "turn-new",
          itemId: undefined,
          createdAt: "2026-05-24T00:00:00.000Z",
        },
      ],
    );
    assert.deepStrictEqual(events[1]?.payload, {
      completedAtMs: Date.parse("2026-05-24T00:00:00.000Z"),
      threadId: "provider-thread-1",
      turnId: "turn-new",
      item: {
        id: "new-message",
        type: "agentMessage",
        text: "new response",
      },
    });
  });

  it("can focus a non-latest turn for delayed send-turn snapshot polling", () => {
    const events = buildCodexThreadSnapshotBackfillEvents({
      threadId: ThreadId.make("thread-1"),
      providerThread: {
        id: "provider-thread-1",
        turns: [
          {
            id: "turn-target",
            status: "completed",
            startedAt: 1_779_000_000,
            completedAt: 1_779_000_010,
            items: [
              {
                id: "target-message",
                type: "agentMessage",
                text: "target response",
              },
            ],
          },
          {
            id: "turn-latest",
            status: "completed",
            startedAt: 1_779_000_020,
            completedAt: 1_779_000_030,
            items: [
              {
                id: "latest-message",
                type: "agentMessage",
                text: "latest response",
              },
            ],
          },
        ],
      },
      createdAt: "2026-05-24T00:00:00.000Z",
      reason: "send-turn-follow-up",
      focusTurnId: TurnId.make("turn-target"),
    });

    assert.deepStrictEqual(
      events.map((event) => event.turnId),
      ["turn-target", "turn-target", "turn-target"],
    );
    assert.equal(events[1]?.itemId, "target-message");
  });

  it("keeps in-progress turns running when thread/read reports idle with a live in-progress turn", () => {
    const events = buildCodexThreadSnapshotBackfillEvents({
      threadId: ThreadId.make("thread-1"),
      providerThread: {
        id: "provider-thread-1",
        status: { type: "idle" },
        turns: [
          {
            id: "turn-stale",
            status: "inProgress",
            startedAt: 1_779_000_000,
            completedAt: null,
            items: [
              {
                id: "target-message",
                type: "agentMessage",
                text: "target response",
              },
            ],
          },
        ],
      },
      createdAt: "2026-05-24T00:00:00.000Z",
      reason: "thread-status-idle-reconciliation",
      focusTurnId: TurnId.make("turn-stale"),
    });

    assert.deepStrictEqual(
      events.map((event) => event.method),
      ["turn/started", "item/completed"],
    );
    assert.equal(events.at(-1)?.method, "item/completed");
  });

  it("interrupts in-progress turns when thread/read reports a system error thread", () => {
    const events = buildCodexThreadSnapshotBackfillEvents({
      threadId: ThreadId.make("thread-1"),
      providerThread: {
        id: "provider-thread-1",
        status: { type: "systemError" },
        turns: [
          {
            id: "turn-stale",
            status: "inProgress",
            startedAt: 1_779_000_000,
            completedAt: null,
            items: [
              {
                id: "target-message",
                type: "agentMessage",
                text: "target response",
              },
            ],
          },
        ],
      },
      createdAt: "2026-05-24T00:00:00.000Z",
      reason: "thread-status-idle-reconciliation",
      focusTurnId: TurnId.make("turn-stale"),
    });

    assert.deepStrictEqual(
      events.map((event) => event.method),
      ["turn/started", "item/completed", "turn/completed"],
    );
    assert.deepStrictEqual(events[2]?.payload, {
      threadId: "provider-thread-1",
      turn: {
        id: "turn-stale",
        status: "interrupted",
        startedAt: 1_779_000_000,
        completedAt: null,
        items: [
          {
            id: "target-message",
            type: "agentMessage",
            text: "target response",
          },
        ],
      },
    });
  });
});

describe("selectCodexActiveSnapshotTurn", () => {
  it("restores only an in-progress Codex turn from a resumed thread snapshot", () => {
    const activeTurn = selectCodexActiveSnapshotTurn({
      id: "provider-thread-1",
      status: { type: "active", activeFlags: [] },
      turns: [
        {
          id: "turn-completed",
          status: "completed",
          items: [],
        },
        {
          id: "turn-running",
          status: "inProgress",
          items: [],
        },
      ],
    });

    assert.equal(activeTurn?.id, "turn-running");
  });

  it("does not restore stale active state when thread/read has no in-progress turn", () => {
    const activeTurn = selectCodexActiveSnapshotTurn({
      id: "provider-thread-1",
      status: { type: "active", activeFlags: [] },
      turns: [
        {
          id: "turn-completed",
          status: "completed",
          items: [],
        },
      ],
    });

    assert.equal(activeTurn, undefined);
  });

  it("does not restore active state from an idle Codex thread snapshot", () => {
    const activeTurn = selectCodexActiveSnapshotTurn({
      id: "provider-thread-1",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-completed",
          status: "completed",
          items: [],
        },
      ],
    });

    assert.equal(activeTurn, undefined);
  });
});

describe("openCodexThread", () => {
  it("falls back to thread/start when resume fails recoverably", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const started = makeThreadOpenResponse("fresh-thread");
    const client = {
      raw: {
        request: (method: "thread/start" | "thread/resume", payload: unknown) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started);
        },
      },
    };

    const opened = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }),
    );

    assert.equal(opened.thread.id, "fresh-thread");
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/resume", "thread/start"],
    );
    for (const call of calls) {
      const payload = call.payload as {
        readonly config?: Record<string, unknown>;
        readonly environments?: ReadonlyArray<{
          readonly environmentId: string;
          readonly cwd: string;
          readonly runtimeWorkspaceRoots?: ReadonlyArray<string>;
        }>;
        readonly runtimeWorkspaceRoots?: ReadonlyArray<string>;
      };
      assert.deepStrictEqual(payload.config, {});
      assert.deepStrictEqual(payload.environments, [
        {
          environmentId: "local",
          cwd: "/tmp/project",
          runtimeWorkspaceRoots: ["/tmp/project"],
        },
      ]);
      assert.deepStrictEqual(payload.runtimeWorkspaceRoots, ["/tmp/project"]);
    }
  });

  it("preserves workspace-write roots without injecting Codex compaction defaults", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const client = {
      raw: {
        request: (method: "thread/start" | "thread/resume", payload: unknown) => {
          calls.push({ method, payload });
          return Effect.succeed(makeThreadOpenResponse("fresh-thread"));
        },
      },
    };

    await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "auto-accept-edits",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: undefined,
        additionalDirectories: ["/tmp/extra"],
      }),
    );

    const payload = calls[0]?.payload as {
      readonly config?: Record<string, unknown>;
      readonly environments?: ReadonlyArray<{
        readonly environmentId: string;
        readonly cwd: string;
        readonly runtimeWorkspaceRoots?: ReadonlyArray<string>;
      }>;
      readonly runtimeWorkspaceRoots?: ReadonlyArray<string>;
    };
    assert.deepStrictEqual(payload.config, {
      sandbox_workspace_write: {
        writable_roots: ["/tmp/extra"],
      },
    });
    assert.deepStrictEqual(payload.environments, [
      {
        environmentId: "local",
        cwd: "/tmp/project",
        runtimeWorkspaceRoots: ["/tmp/project", "/tmp/extra"],
      },
    ]);
    assert.deepStrictEqual(payload.runtimeWorkspaceRoots, ["/tmp/project", "/tmp/extra"]);
  });

  it("uses a configured auto-compact token limit for both thread/start and thread/resume", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const client = {
      raw: {
        request: (method: "thread/start" | "thread/resume", payload: unknown) => {
          calls.push({ method, payload });
          return Effect.succeed(makeThreadOpenResponse("fresh-thread"));
        },
      },
    };

    await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: undefined,
        autoCompactTokenLimit: 150_000,
      }),
    );
    await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "existing-thread",
        autoCompactTokenLimit: 150_000,
      }),
    );

    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/start", "thread/resume"],
    );
    for (const call of calls) {
      const payload = call.payload as { readonly config?: Record<string, unknown> };
      assert.deepStrictEqual(payload.config, {
        model_auto_compact_token_limit: 150_000,
      });
    }
  });

  it("propagates non-recoverable resume failures", async () => {
    const client = {
      raw: {
        request: (method: "thread/start" | "thread/resume", _payload: unknown) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(makeThreadOpenResponse("fresh-thread"));
        },
      },
    };

    await assert.rejects(
      Effect.runPromise(
        openCodexThread({
          client,
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          resumeThreadId: "stale-thread",
        }),
      ),
      (error: unknown) =>
        isCodexAppServerRequestError(error) &&
        error.errorMessage === "timed out waiting for server",
    );
  });
});
