import assert from "node:assert/strict";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";
import { ProviderInstanceId, ProviderItemId, ThreadId, TurnId } from "@cafecode/contracts";
import { CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT } from "@cafecode/shared/codexCompaction";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  buildCodexAppServerArgs,
  buildCodexActiveContextCompactionSteerError,
  buildCodexThreadSnapshotBackfillEvents,
  buildTurnStartParams,
  buildTurnSteerParams,
  claimCodexSnapshotBackfillWatcher,
  codexAggregateNotificationMethod,
  codexAggregateTurnHasUnfinishedChildren,
  codexChildConversationThreadIdsForTurn,
  codexElapsedDelayMilliseconds,
  codexElapsedDelayRemainingMilliseconds,
  isRecoverableThreadResumeError,
  isCodexContextCompactionItemType,
  isCodexChildConversationWorkNotification,
  isCodexUserMessageItemType,
  isTerminalCodexChildThreadReadError,
  openCodexThread,
  readCodexExpectedActiveTurnMismatchActualTurnId,
  readCodexNotificationEmittedAtIso,
  readCodexNotificationRouteFields,
  readCodexSteerExpectedTurnMismatchActualTurnId,
  rememberCodexChildConversationTurns,
  resolveCodexThreadSettingsSessionModel,
  resolveCodexChildConversationNotification,
  selectCodexActiveSnapshotTurn,
  summarizeCodexAppServerChildProcesses,
  updateCodexChildConversationLiveness,
  updateCodexActiveContextCompactions,
  updateCodexPendingSteerProcessingFromNotification,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

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
    const params = Effect.runSync(
      buildTurnSteerParams({
        threadId: "provider-thread-1",
        expectedTurnId: TurnId.make("turn-active"),
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
  it("recognizes upstream user-message item type spellings", () => {
    assert.equal(isCodexUserMessageItemType("userMessage"), true);
    assert.equal(isCodexUserMessageItemType("user_message"), true);
    assert.equal(isCodexUserMessageItemType("user-message"), true);
    assert.equal(isCodexUserMessageItemType("commandExecution"), false);
    assert.equal(isCodexUserMessageItemType(undefined), false);
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

  it("binds a user message lifecycle pair to only one pending steer", () => {
    const turnId = TurnId.make("turn-active");
    const first = {
      steerId: "steer-1",
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
    assert.equal(completed.next.get("steer-1")?.providerUserMessageMethod, "item/started");
    assert.equal(completed.next.get("steer-2")?.processedAt, undefined);
  });

  it("ignores non-user-message notifications when tracking steer processing", () => {
    const turnId = TurnId.make("turn-active");
    const pendingSteer = {
      steerId: "steer-1",
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
      assert.deepStrictEqual(payload.config, {
        "features.remote_compaction_v2": false,
        model_auto_compact_token_limit: CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
        model_auto_compact_token_limit_scope: "total",
      });
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

  it("preserves workspace-write roots alongside Codex auto-compaction overrides", async () => {
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
      "features.remote_compaction_v2": false,
      model_auto_compact_token_limit: CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
      model_auto_compact_token_limit_scope: "total",
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
        "features.remote_compaction_v2": false,
        model_auto_compact_token_limit: 150_000,
        model_auto_compact_token_limit_scope: "total",
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
