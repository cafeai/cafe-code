import { ProviderInstanceId, ThreadId, TurnId } from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  attachCommandIdToMutatingProviderDaemonRequest,
  guardRemoteProviderThreadOperation,
  isRetryableProviderDaemonControlError,
  isVoidProviderDaemonRpcMethod,
  ProviderDaemonRpcResponseError,
  providerDaemonReplayCursorForHealth,
  providerDaemonRequestThreadIds,
  remoteProviderCursorProjectorForConfig,
  requestProviderDaemonRpcJsonWithStableRetry,
  resolveProviderDaemonReplayCursor,
  toRemoteRequestError,
} from "./RemoteProviderService.ts";
import {
  PROVIDER_DAEMON_RUNTIME_CURSOR_PROJECTOR,
  PROVIDER_SUPERVISOR_RUNTIME_CURSOR_PROJECTOR,
} from "./ProviderDaemonRuntimeCursor.ts";

describe("RemoteProviderService", () => {
  it.each([
    { code: "ECONNRESET", message: "socket hang up" },
    { code: "EPIPE", message: "write EPIPE" },
  ])("retries one reset with the identical durable command identity: $code", async (fixture) => {
    const bodies: string[] = [];
    const requestJson = async (
      _endpoint: Parameters<typeof requestProviderDaemonRpcJsonWithStableRetry>[0],
      _path: string,
      options: { readonly body?: string } = {},
    ) => {
      bodies.push(options.body ?? "");
      if (bodies.length === 1) {
        throw Object.assign(new Error(fixture.message), { code: fixture.code });
      }
      return { statusCode: 200, body: '{"ok":true}' };
    };

    await requestProviderDaemonRpcJsonWithStableRetry(
      {
        httpBaseUrl: "http://127.0.0.1:3774",
        token: "provider-daemon-test-token-000000000000000000000000",
      },
      {
        method: "restartProviderRuntime",
        payload: { instanceId: ProviderInstanceId.make("codex") },
      },
      requestJson,
    );

    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    const decoded = JSON.parse(bodies[0] ?? "null") as { readonly commandId?: unknown };
    assert.equal(typeof decoded.commandId, "string");
  });

  it("does not retry timeouts or failures that are not connection resets", async () => {
    let attempts = 0;
    const requestJson = async () => {
      attempts += 1;
      throw Object.assign(new Error("provider daemon request timed out"), { code: "ETIMEDOUT" });
    };

    let observedError: unknown;
    try {
      await requestProviderDaemonRpcJsonWithStableRetry(
        {
          httpBaseUrl: "http://127.0.0.1:3774",
          token: "provider-daemon-test-token-000000000000000000000000",
        },
        { method: "listSessions", payload: {} },
        requestJson,
      );
    } catch (cause) {
      observedError = cause;
    }

    assert.equal(attempts, 1);
    assert.instanceOf(observedError, Error);
    assert.match(observedError.message, /timed out/u);
    assert.isFalse(
      isRetryableProviderDaemonControlError(
        Object.assign(new Error("provider daemon request timed out"), { code: "ETIMEDOUT" }),
      ),
    );
  });

  it("adds commandId to restartProviderRuntime daemon RPC requests", () => {
    const request = attachCommandIdToMutatingProviderDaemonRequest({
      method: "restartProviderRuntime",
      payload: {
        instanceId: ProviderInstanceId.make("codex"),
      },
    });

    assert.equal(request.method, "restartProviderRuntime");
    const commandId = request.commandId;
    assert.equal(typeof commandId, "string");
    if (commandId === undefined) {
      throw new Error("restartProviderRuntime request did not receive commandId");
    }
    assert.isAtLeast(commandId.length, 16);
  });

  it("adds commandId to goal mutation daemon RPC requests", () => {
    const request = attachCommandIdToMutatingProviderDaemonRequest({
      method: "setGoal",
      payload: {
        threadId: ThreadId.make("thread-1"),
        objective: "Finish the proof",
        status: "active",
        tokenBudget: null,
      },
    });

    assert.equal(request.method, "setGoal");
    assert.equal(typeof request.commandId, "string");
  });

  it("treats provider-native fork creation and cleanup as durable mutations", () => {
    const request = attachCommandIdToMutatingProviderDaemonRequest({
      method: "forkSession",
      payload: {
        operationId: "cmd-native-fork",
        sourceThreadId: ThreadId.make("thread-source"),
        targetThreadId: ThreadId.make("thread-target"),
        title: "Native fork",
      },
    });

    assert.equal(request.method, "forkSession");
    assert.equal(typeof request.commandId, "string");
    assert.isFalse(isVoidProviderDaemonRpcMethod("forkSession"));
    assert.isTrue(isVoidProviderDaemonRpcMethod("discardSessionFork"));
  });

  it("does not add commandId to read-only daemon RPC requests", () => {
    const request = attachCommandIdToMutatingProviderDaemonRequest({
      method: "listSessions",
      payload: {},
    });

    assert.equal(request.method, "listSessions");
    assert.isFalse("commandId" in request);

    const subagentDetailRequest = attachCommandIdToMutatingProviderDaemonRequest({
      method: "readSubagentDetail",
      payload: {
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        subagentId: "provider-child-1",
      },
    });
    assert.equal(subagentDetailRequest.method, "readSubagentDetail");
    assert.isFalse("commandId" in subagentDetailRequest);
    assert.isFalse(isVoidProviderDaemonRpcMethod("readSubagentDetail"));
  });

  it("does not treat restartProviderRuntime as a void daemon RPC", () => {
    assert.isFalse(isVoidProviderDaemonRpcMethod("restartProviderRuntime"));
    assert.isTrue(isVoidProviderDaemonRpcMethod("stopSession"));
    assert.isTrue(isVoidProviderDaemonRpcMethod("quiesceThreadForHardDelete"));
    assert.isTrue(isVoidProviderDaemonRpcMethod("rollbackConversation"));
  });

  it("makes hard-delete quiescence an idempotent daemon mutation", () => {
    const request = attachCommandIdToMutatingProviderDaemonRequest({
      method: "quiesceThreadForHardDelete",
      payload: { threadId: ThreadId.make("thread-permanent-delete") },
    });

    assert.equal(request.method, "quiesceThreadForHardDelete");
    assert.equal(typeof request.commandId, "string");
  });

  it.effect("rejects a retired fork source or target before evaluating the remote mutation", () =>
    Effect.gen(function* () {
      const sourceThreadId = ThreadId.make("thread-remote-fork-source");
      const targetThreadId = ThreadId.make("thread-remote-fork-target");
      const request = {
        method: "forkSession",
        payload: {
          operationId: "cmd-remote-retired-fork",
          sourceThreadId,
          targetThreadId,
          title: "Retired target",
        },
      } as const;
      assert.deepEqual(providerDaemonRequestThreadIds(request), [sourceThreadId, targetThreadId]);

      let evaluatedMutationCount = 0;
      const mutation = Effect.sync(() => {
        evaluatedMutationCount += 1;
      });
      const targetRetiredExit = yield* guardRemoteProviderThreadOperation({
        retiredThreadIds: new Set([String(targetThreadId)]),
        operation: "ProviderDaemonRemoteProviderService.forkSession",
        threadIds: providerDaemonRequestThreadIds(request),
        effect: mutation,
      }).pipe(Effect.exit);
      const sourceRetiredExit = yield* guardRemoteProviderThreadOperation({
        retiredThreadIds: new Set([String(sourceThreadId)]),
        operation: "ProviderDaemonRemoteProviderService.forkSession",
        threadIds: providerDaemonRequestThreadIds(request),
        effect: mutation,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(targetRetiredExit));
      assert.isTrue(Exit.isFailure(sourceRetiredExit));
      assert.equal(evaluatedMutationCount, 0);

      yield* guardRemoteProviderThreadOperation({
        retiredThreadIds: new Set(),
        operation: "ProviderDaemonRemoteProviderService.forkSession",
        threadIds: providerDaemonRequestThreadIds(request),
        effect: mutation,
      });
      assert.equal(evaluatedMutationCount, 1);
    }),
  );

  it("uses a separate cursor for daemon to supervisor event bridging", () => {
    assert.equal(
      remoteProviderCursorProjectorForConfig({ providerDaemon: {} }),
      PROVIDER_DAEMON_RUNTIME_CURSOR_PROJECTOR,
    );
    assert.equal(
      remoteProviderCursorProjectorForConfig({ providerSupervisor: {} }),
      PROVIDER_SUPERVISOR_RUNTIME_CURSOR_PROJECTOR,
    );
  });

  it("resumes at the exact durable cursor when daemon health proves the runtime is idle", () => {
    assert.equal(
      providerDaemonReplayCursorForHealth({
        persistedCursor: 44_289_959,
        activeSessionCount: 0,
      }),
      44_289_959,
    );
  });

  it("retains the bounded overlap while daemon sessions are active", () => {
    assert.equal(
      providerDaemonReplayCursorForHealth({
        persistedCursor: 44_289_959,
        activeSessionCount: 2,
      }),
      44_288_959,
    );
  });

  it("fails closed to the bounded overlap when daemon health is inconclusive", () => {
    assert.equal(
      providerDaemonReplayCursorForHealth({
        persistedCursor: 44_289_959,
        activeSessionCount: undefined,
      }),
      44_288_959,
    );
    assert.equal(
      providerDaemonReplayCursorForHealth({
        persistedCursor: 500,
        activeSessionCount: undefined,
      }),
      0,
    );
  });

  it.effect("executes the production Effect recovery path for inconclusive health", () =>
    Effect.gen(function* () {
      const cursor = yield* resolveProviderDaemonReplayCursor({
        persistedCursor: 44_289_959,
        projector: PROVIDER_DAEMON_RUNTIME_CURSOR_PROJECTOR,
        health: Effect.fail(new Error("synthetic health failure")),
      });

      assert.equal(cursor, 44_288_959);
    }),
  );

  it("retains a typed remote RPC error tag on adapter request errors", () => {
    const error = toRemoteRequestError(
      "getInstanceInfo",
      new ProviderDaemonRpcResponseError(
        "ProviderUnsupportedError",
        "ProviderUnsupportedError: provider instance is not configured",
      ),
    );

    assert.equal(error.remoteErrorTag, "ProviderUnsupportedError");
    assert.include(error.detail, "provider instance is not configured");
  });
});
