import { ProviderInstanceId, ThreadId, TurnId } from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDaemonHttpStatusError } from "@cafecode/shared/providerDaemonHttp";
import {
  resetProviderPipelineDiagnosticsForTest,
  snapshotProviderPipelineDiagnostics,
} from "@cafecode/shared/providerPipelineDiagnostics";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";

import {
  attachCommandIdToMutatingProviderDaemonRequest,
  guardRemoteProviderThreadOperation,
  isRetryableProviderDaemonControlError,
  isVoidProviderDaemonRpcMethod,
  ProviderDaemonRpcResponseError,
  ProviderDaemonAuthenticationError,
  PROVIDER_DAEMON_AUTHENTICATION_RETRY_MS,
  providerDaemonReplayCursorForHealth,
  providerDaemonRequestThreadIds,
  remoteProviderCursorProjectorForConfig,
  requestProviderDaemonRpcJsonWithStableRetry,
  recoverRemoteSessionInventory,
  retryRemoteProviderEventStream,
  resolveProviderDaemonReplayCursor,
  toRemoteRequestError,
} from "./RemoteProviderService.ts";
import {
  PROVIDER_DAEMON_RUNTIME_CURSOR_PROJECTOR,
  PROVIDER_SUPERVISOR_RUNTIME_CURSOR_PROJECTOR,
} from "./ProviderDaemonRuntimeCursor.ts";

describe("RemoteProviderService", () => {
  it.each([401, 403] as const)(
    "rejects HTTP %s before reading the RPC body without retrying",
    async (status) => {
      let attempts = 0;
      let bodyReads = 0;
      const error = await requestProviderDaemonRpcJsonWithStableRetry(
        {
          httpBaseUrl: "http://127.0.0.1:3774",
          token: "synthetic-secret-capability-never-in-errors",
        },
        {
          method: "restartProviderRuntime",
          payload: { instanceId: ProviderInstanceId.make("codex") },
        },
        async () => {
          attempts += 1;
          return {
            statusCode: status,
            get body(): string {
              bodyReads += 1;
              throw new Error("synthetic-private-body-must-not-be-decoded");
            },
          };
        },
      ).catch((cause: unknown) => cause);

      assert.instanceOf(error, ProviderDaemonAuthenticationError);
      assert.equal(error.statusCode, status);
      assert.equal(attempts, 1);
      assert.equal(bodyReads, 0);
      assert.notInclude(String(error), "synthetic-secret");
      assert.notInclude(JSON.stringify(error), "synthetic-private");
      assert.isFalse(isRetryableProviderDaemonControlError(error));
    },
  );

  it("preserves non-auth HTTP responses for existing envelope handling", async () => {
    const response = { statusCode: 503, body: '{"ok":false}' };
    assert.strictEqual(
      await requestProviderDaemonRpcJsonWithStableRetry(
        { httpBaseUrl: "http://127.0.0.1:3774", token: "synthetic-test-capability" },
        { method: "listSessions", payload: {} },
        async () => response,
      ),
      response,
    );
  });

  it("normalizes stream authentication status into a fixed typed error and numeric diagnostics", () => {
    resetProviderPipelineDiagnosticsForTest();
    const error = toRemoteRequestError("streamEvents", new ProviderDaemonHttpStatusError(403));
    assert.equal(error.remoteErrorTag, "ProviderDaemonAuthenticationError");
    assert.instanceOf(error.cause, ProviderDaemonAuthenticationError);
    assert.equal(error.cause.statusCode, 403);
    assert.equal(snapshotProviderPipelineDiagnostics().backendBridge.authenticationFailureCount, 1);
    assert.equal(
      snapshotProviderPipelineDiagnostics().backendBridge.lastAuthenticationFailureStatus,
      403,
    );
  });

  it.effect("does not convert an authentication failure into authoritative empty inventory", () =>
    Effect.gen(function* () {
      const error = toRemoteRequestError(
        "listSessions",
        new ProviderDaemonAuthenticationError(401),
      );
      let reconciliationRan = false;
      const exit = yield* recoverRemoteSessionInventory(Effect.fail(error)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            reconciliationRan = true;
          }),
        ),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.equal(exit.cause.reasons.find(Cause.isDieReason)?.defect, error);
      }
      assert.isFalse(reconciliationRan);
      assert.deepEqual(yield* recoverRemoteSessionInventory(Effect.succeed([])), []);
      assert.deepEqual(
        yield* recoverRemoteSessionInventory(Effect.fail(new Error("synthetic ordinary failure"))),
        [],
      );
    }),
  );

  it.effect("retries rejected immutable stream credentials only after the bounded auth delay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        resetProviderPipelineDiagnosticsForTest();
        let attempts = 0;
        const firstAttempt = yield* Deferred.make<void>();
        yield* retryRemoteProviderEventStream({
          afterCursor: () => 17,
          read: Effect.gen(function* () {
            attempts += 1;
            yield* Deferred.succeed(firstAttempt, undefined);
            return yield* Effect.fail(
              toRemoteRequestError("streamEvents", new ProviderDaemonHttpStatusError(401)),
            );
          }),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(firstAttempt);
        yield* TestClock.adjust(PROVIDER_DAEMON_AUTHENTICATION_RETRY_MS - 1);
        assert.equal(attempts, 1);
        assert.equal(
          snapshotProviderPipelineDiagnostics().backendBridge.authenticationRetryDelayMs,
          PROVIDER_DAEMON_AUTHENTICATION_RETRY_MS,
        );
        yield* TestClock.adjust(1);
        assert.equal(attempts, 2);
        assert.equal(
          snapshotProviderPipelineDiagnostics().backendBridge.authenticationFailureCount,
          2,
        );
      }),
    ),
  );

  it.effect(
    "keeps ordinary stream reconnect timing even when error text mentions authentication",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let attempts = 0;
          const firstAttempt = yield* Deferred.make<void>();
          yield* retryRemoteProviderEventStream({
            afterCursor: () => 17,
            read: Effect.gen(function* () {
              attempts += 1;
              yield* Deferred.succeed(firstAttempt, undefined);
              return yield* Effect.fail(
                toRemoteRequestError(
                  "streamEvents",
                  new Error("authentication HTTP 401 text is not status evidence"),
                ),
              );
            }),
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(firstAttempt);
          yield* TestClock.adjust(499);
          assert.equal(attempts, 1);
          yield* TestClock.adjust(1);
          assert.equal(attempts, 2);
        }),
      ),
  );

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
