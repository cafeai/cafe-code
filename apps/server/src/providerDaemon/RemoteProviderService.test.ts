import { ProviderInstanceId } from "@cafecode/contracts";
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

  it("does not add commandId to read-only daemon RPC requests", () => {
    const request = attachCommandIdToMutatingProviderDaemonRequest({
      method: "listSessions",
      payload: {},
    });

    assert.equal(request.method, "listSessions");
    assert.isFalse("commandId" in request);
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
