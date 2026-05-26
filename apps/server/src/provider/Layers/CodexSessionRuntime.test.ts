import assert from "node:assert/strict";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";
import { ProviderInstanceId, ProviderItemId, ThreadId, TurnId } from "@cafecode/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

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
  isRecoverableThreadResumeError,
  isCodexContextCompactionItemType,
  openCodexThread,
  updateCodexActiveContextCompactions,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

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

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
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
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        additionalDirectories: ["/tmp/docs", "/tmp/tools"],
      }),
    );

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
});

describe("openCodexThread", () => {
  it("falls back to thread/start when resume fails recoverably", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const started = makeThreadOpenResponse("fresh-thread");
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "thread not found",
            }),
          );
        }
        return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
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
  });

  it("propagates non-recoverable resume failures", async () => {
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        _payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "timed out waiting for server",
            }),
          );
        }
        return Effect.succeed(
          makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
        );
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
