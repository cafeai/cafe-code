import { ProviderInstanceId, ThreadId, TurnId } from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  attachCommandIdToMutatingProviderDaemonRequest,
  guardRemoteProviderThreadOperation,
  isVoidProviderDaemonRpcMethod,
  ProviderDaemonRpcResponseError,
  providerDaemonRequestThreadIds,
  remoteProviderCursorProjectorForConfig,
  toRemoteRequestError,
} from "./RemoteProviderService.ts";
import {
  PROVIDER_DAEMON_RUNTIME_CURSOR_PROJECTOR,
  PROVIDER_SUPERVISOR_RUNTIME_CURSOR_PROJECTOR,
} from "./ProviderDaemonRuntimeCursor.ts";

describe("RemoteProviderService", () => {
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
