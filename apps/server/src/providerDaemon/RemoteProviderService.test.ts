import { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  attachCommandIdToMutatingProviderDaemonRequest,
  isVoidProviderDaemonRpcMethod,
  ProviderDaemonRpcResponseError,
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
    assert.isTrue(isVoidProviderDaemonRpcMethod("rollbackConversation"));
  });

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
