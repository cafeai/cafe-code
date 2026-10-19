import {
  CommandId,
  ProviderDaemonRpcRequest,
  ProviderInstanceId,
  ProviderDriverKind,
  SubagentRuntimeId,
  ThreadId,
  TurnId,
  type ProviderSessionStartInput,
} from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDaemonHttpStatusError } from "@cafecode/shared/providerDaemonHttp";
import {
  resetProviderPipelineDiagnosticsForTest,
  snapshotProviderPipelineDiagnostics,
} from "@cafecode/shared/providerPipelineDiagnostics";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";

import {
  attachCommandIdToMutatingProviderDaemonRequest,
  providerDaemonCompactionRequest,
  providerDaemonConversationRollbackRequest,
  requestProviderDaemonConversationRollback,
  guardRemoteProviderThreadOperation,
  guardRemoteCodexContextWindowStart,
  guardRemoteCodexFailedRootRestart,
  isRetryableProviderDaemonControlError,
  isVoidProviderDaemonRpcMethod,
  ProviderDaemonRpcResponseError,
  ProviderDaemonAuthenticationError,
  ProviderDaemonSessionInventoryUnavailableError,
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
import {
  ProviderAdapterRequestError,
  ProviderAdapterRewindOutcomeUnknownError,
} from "../provider/Errors.ts";

const rewindIdentity = {
  threadId: ThreadId.make("rewind-thread"),
  operationId: "2d157a02-7309-45ee-8b1c-4bf5da146a51",
};
const rewindRequests = [
  {
    method: "prepareConversationRollback",
    payload: {
      ...rewindIdentity,
      numTurns: 2,
      firstRemovedTurnId: TurnId.make("removed-turn"),
      retainedTurnCount: 1,
      expectedControlSequence: 7,
    },
  },
  { method: "commitConversationRollback", payload: rewindIdentity },
  { method: "finishConversationRollback", payload: { ...rewindIdentity, outcome: "aborted" } },
  {
    method: "finishConversationRollback",
    payload: {
      ...rewindIdentity,
      outcome: "committed",
      completionCommandId: "rewind-completion",
    },
  },
] as const;
const rewindConfig = { httpBaseUrl: "http://127.0.0.1:3774", token: "synthetic-test-capability" };
const encodeRpcRequest = Schema.encodeSync(ProviderDaemonRpcRequest);

describe("RemoteProviderService", () => {
  it.each(["subagent-concurrency-active", "codex-context-window-active"] as const)(
    "preserves the finite %s refusal only for an exact startSession request error",
    (refusal) => {
      const response = new ProviderDaemonRpcResponseError(
        "ProviderAdapterRequestError",
        "Synthetic fixed refusal",
        refusal,
      );
      const accepted = toRemoteRequestError("startSession", response);
      assert.equal(accepted.remoteErrorTag, refusal);
      assert.strictEqual(accepted.cause, response);
      // Other methods and outer error classes cannot borrow the optional
      // start-only admission fact, including paid turn submission and rewind.
      for (const method of [
        "sendTurn",
        "steerTurn",
        "stopSession",
        "prepareConversationRollback",
        "getCapabilities",
      ]) {
        assert.equal(
          toRemoteRequestError(method, response).remoteErrorTag,
          "ProviderAdapterRequestError",
        );
      }
      const foreign = new ProviderDaemonRpcResponseError(
        "ProviderUnsupportedError",
        "Synthetic refusal",
        refusal,
      );
      assert.equal(
        toRemoteRequestError("startSession", foreign).remoteErrorTag,
        "ProviderUnsupportedError",
      );
      const legacy = new ProviderDaemonRpcResponseError("ProviderAdapterRequestError", refusal);
      assert.equal(
        toRemoteRequestError("startSession", legacy).remoteErrorTag,
        "ProviderAdapterRequestError",
      );
      for (const method of ["startSession", "sendTurn", "steerTurn", "stopSession"]) {
        const unqualifiedOuter = new ProviderDaemonRpcResponseError(
          refusal,
          "Synthetic finite spelling",
        );
        assert.equal(
          toRemoteRequestError(method, unqualifiedOuter).remoteErrorTag,
          "ProviderAdapterRequestError",
        );
      }
      let getterReads = 0;
      const accessor = new ProviderDaemonRpcResponseError(
        "ProviderAdapterRequestError",
        "Synthetic refusal",
      );
      Object.defineProperty(accessor, "sessionReconfigurationRefusal", {
        get: () => {
          getterReads += 1;
          return refusal;
        },
      });
      assert.equal(
        toRemoteRequestError("startSession", accessor).remoteErrorTag,
        "ProviderAdapterRequestError",
      );
      const inherited = new ProviderDaemonRpcResponseError(
        "ProviderAdapterRequestError",
        "Synthetic refusal",
      );
      Object.setPrototypeOf(
        inherited,
        Object.create(Object.getPrototypeOf(inherited), {
          sessionReconfigurationRefusal: { value: refusal },
        }),
      );
      assert.equal(
        toRemoteRequestError("startSession", inherited).remoteErrorTag,
        "ProviderAdapterRequestError",
      );
      const outerAccessor = new ProviderDaemonRpcResponseError(
        "ProviderAdapterRequestError",
        "Synthetic refusal",
        refusal,
      );
      Object.defineProperty(outerAccessor, "remoteErrorTag", {
        get: () => {
          getterReads += 1;
          return "ProviderAdapterRequestError";
        },
      });
      assert.equal(
        toRemoteRequestError("startSession", outerAccessor).remoteErrorTag,
        "ProviderAdapterRequestError",
      );
      assert.equal(getterReads, 0);
      // A plain received error carrying similarly named fields is not an
      // authenticated decoded RPC response and grants no semantic authority.
      const untyped = Object.assign(new Error("Synthetic refusal"), {
        remoteErrorTag: "ProviderAdapterRequestError",
        sessionReconfigurationRefusal: refusal,
      });
      assert.equal(toRemoteRequestError("startSession", untyped).remoteErrorTag, undefined);
      for (const malformed of ["unrecognized-refusal", "", null, true, { code: refusal }]) {
        const malformedResponse = new ProviderDaemonRpcResponseError(
          "ProviderAdapterRequestError",
          "Synthetic fixed refusal",
          malformed as never,
        );
        assert.equal(
          toRemoteRequestError("startSession", malformedResponse).remoteErrorTag,
          "ProviderAdapterRequestError",
        );
      }
    },
  );

  it("preserves retirement refusal only from a decoded response to a complete cold send", () => {
    const request = {
      method: "sendTurn" as const,
      payload: {
        threadId: ThreadId.make("retirement-refusal-thread"),
        input: "Continue existing work.",
        expectedFailedRoot: {
          turnId: TurnId.make("retirement-refusal-turn"),
          providerThreadId: "retirement-private-history",
          subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000188"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          observedAt: "2026-10-19T01:00:00.000Z",
          restartSession: true as const,
        },
      },
    };
    const reasons = [
      "invalid-request",
      "owner-changed",
      "native-context-unavailable",
      "history-unavailable",
      "compaction-pending",
      "root-start-pending",
      "closed",
      "root-proof-changed",
      "notifications-pending",
    ] as const;
    for (const reason of reasons) {
      const response = new ProviderDaemonRpcResponseError(
        "ProviderAdapterRequestError",
        "Fixed refusal.",
        undefined,
        reason,
      );
      const accepted = toRemoteRequestError("sendTurn", response, request);
      assert.equal(accepted.failedRootRetirementRefusal, reason);
      assert.equal(accepted.remoteErrorTag, "ProviderAdapterRequestError");
      assert.strictEqual(accepted.cause, response);
      // The actual request, rather than a matching method name, must carry the
      // complete cold-recovery identity. Legacy ordinary sends remain unknown.
      for (const unqualified of [
        undefined,
        { method: "stopSession" as const, payload: { threadId: request.payload.threadId } },
        {
          ...request,
          payload: { threadId: request.payload.threadId, input: request.payload.input },
        },
        {
          ...request,
          payload: {
            ...request.payload,
            expectedFailedRoot: {
              ...request.payload.expectedFailedRoot,
              restartSession: undefined,
            },
          },
        },
        {
          ...request,
          payload: {
            ...request.payload,
            expectedFailedRoot: {
              ...request.payload.expectedFailedRoot,
              providerInstanceId: undefined,
            },
          },
        },
        {
          ...request,
          payload: {
            ...request.payload,
            expectedFailedRoot: { ...request.payload.expectedFailedRoot, observedAt: undefined },
          },
        },
      ]) {
        assert.equal(
          toRemoteRequestError("sendTurn", response, unqualified).failedRootRetirementRefusal,
          undefined,
        );
      }
      for (const method of ["startSession", "steerTurn", "stopSession", "getCapabilities"])
        assert.equal(
          toRemoteRequestError(method, response, request).failedRootRetirementRefusal,
          undefined,
        );
      const wrongOuter = new ProviderDaemonRpcResponseError(
        "ProviderUnsupportedError",
        "Fixed refusal.",
        undefined,
        reason,
      );
      assert.equal(
        toRemoteRequestError("sendTurn", wrongOuter, request).failedRootRetirementRefusal,
        undefined,
      );
      const unauthorized = Object.assign(new ProviderDaemonAuthenticationError(401), {
        failedRootRetirementRefusal: reason,
      });
      assert.equal(
        toRemoteRequestError("sendTurn", unauthorized, request).failedRootRetirementRefusal,
        undefined,
      );
      const legacy = new ProviderDaemonRpcResponseError("ProviderAdapterRequestError", reason);
      assert.equal(
        toRemoteRequestError("sendTurn", legacy, request).failedRootRetirementRefusal,
        undefined,
      );
      const plain = Object.assign(new Error("Fixed refusal."), {
        remoteErrorTag: "ProviderAdapterRequestError",
        failedRootRetirementRefusal: reason,
      });
      assert.equal(
        toRemoteRequestError("sendTurn", plain, request).failedRootRetirementRefusal,
        undefined,
      );
      // Native tags/prose, transport failures and an inherited/accessor field
      // are not an authenticated finite pre-input witness.
      const tagOnly = new ProviderDaemonRpcResponseError(reason, "Fixed refusal.");
      assert.equal(
        toRemoteRequestError("sendTurn", tagOnly, request).failedRootRetirementRefusal,
        undefined,
      );
      let getterReads = 0;
      const accessor = new ProviderDaemonRpcResponseError(
        "ProviderAdapterRequestError",
        "Fixed refusal.",
      );
      Object.defineProperty(accessor, "failedRootRetirementRefusal", {
        get: () => {
          getterReads += 1;
          return reason;
        },
      });
      assert.equal(
        toRemoteRequestError("sendTurn", accessor, request).failedRootRetirementRefusal,
        undefined,
      );
      const outerAccessor = new ProviderDaemonRpcResponseError(
        "ProviderAdapterRequestError",
        "Fixed refusal.",
        undefined,
        reason,
      );
      Object.defineProperty(outerAccessor, "remoteErrorTag", {
        get: () => {
          getterReads += 1;
          return "ProviderAdapterRequestError";
        },
      });
      assert.equal(
        toRemoteRequestError("sendTurn", outerAccessor, request).failedRootRetirementRefusal,
        undefined,
      );
      const inherited = new ProviderDaemonRpcResponseError(
        "ProviderAdapterRequestError",
        "Fixed refusal.",
      );
      Object.setPrototypeOf(
        inherited,
        Object.create(Object.getPrototypeOf(inherited), {
          failedRootRetirementRefusal: { value: reason },
        }),
      );
      assert.equal(
        toRemoteRequestError("sendTurn", inherited, request).failedRootRetirementRefusal,
        undefined,
      );
      let proxyReads = 0;
      const proxy = new Proxy(response, {
        get: () => {
          proxyReads += 1;
          throw Error("Must not inspect proxy.");
        },
        getOwnPropertyDescriptor: () => {
          proxyReads += 1;
          throw Error("Must not inspect proxy.");
        },
        getPrototypeOf: () => {
          proxyReads += 1;
          throw Error("Must not inspect proxy.");
        },
      });
      assert.equal(
        toRemoteRequestError("sendTurn", proxy, request).failedRootRetirementRefusal,
        undefined,
      );
      const revoked = Proxy.revocable(response, {});
      revoked.revoke();
      assert.equal(
        toRemoteRequestError("sendTurn", revoked.proxy, request).failedRootRetirementRefusal,
        undefined,
      );
      assert.equal(proxyReads, 0);
      assert.equal(getterReads, 0);
      for (const malformed of [null, false, 7, {}, [], "unknown", `${reason} `]) {
        const invalid = new ProviderDaemonRpcResponseError(
          "ProviderAdapterRequestError",
          "Fixed refusal.",
          undefined,
          malformed as never,
        );
        assert.equal(
          toRemoteRequestError("sendTurn", invalid, request).failedRootRetirementRefusal,
          undefined,
        );
      }
    }
  });

  it.effect(
    "cold failed-root RPC requires the exact authenticated owner capability and complete failure identity before delivery",
    () =>
      Effect.gen(function* () {
        const account = ProviderInstanceId.make("exact-cold-recovery-owner");
        const request = {
          threadId: ThreadId.make("cold-recovery-remote-thread"),
          input: "Continue existing work.",
          expectedFailedRoot: {
            turnId: TurnId.make("exact-remote-failed-root"),
            providerThreadId: "same-private-native-history",
            subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000088"),
            providerInstanceId: account,
            observedAt: "2026-10-14T06:00:00.000Z",
            restartSession: true as const,
          },
        };
        let deliveries = 0;
        const observed: ProviderInstanceId[] = [];
        const delivery = Effect.sync(() => ++deliveries);
        for (const capability of [false, undefined, "true"] as const) {
          const outcome = yield* guardRemoteCodexFailedRootRestart({
            request,
            readCapabilities: (owner) =>
              Effect.sync(() => {
                observed.push(owner);
                return {
                  sessionModelSwitch: "in-session" as const,
                  liveSteer: "supported" as const,
                  ...(capability === undefined
                    ? {}
                    : { codexFailedRootRestart: capability as boolean }),
                };
              }),
            effect: delivery,
          }).pipe(Effect.exit);
          assert.equal(Exit.isFailure(outcome), true);
          assert.equal(deliveries, 0);
        }
        assert.deepEqual(observed, [account, account, account]);
        const unavailable = yield* guardRemoteCodexFailedRootRestart({
          request,
          readCapabilities: () => Effect.die("Synthetic authenticated-owner inventory unavailable"),
          effect: delivery,
        }).pipe(Effect.exit);
        assert.equal(Exit.isFailure(unavailable), true);
        assert.equal(deliveries, 0);
        for (const expected of [
          { ...request.expectedFailedRoot, providerInstanceId: undefined },
          { ...request.expectedFailedRoot, observedAt: undefined },
        ]) {
          const malformed = yield* guardRemoteCodexFailedRootRestart({
            request: { ...request, expectedFailedRoot: expected },
            readCapabilities: () => Effect.die("An incomplete owner must not be probed"),
            effect: delivery,
          }).pipe(Effect.exit);
          assert.equal(Exit.isFailure(malformed), true);
          assert.equal(deliveries, 0);
        }
        yield* guardRemoteCodexFailedRootRestart({
          request,
          readCapabilities: (owner) =>
            Effect.sync(() => {
              assert.equal(owner, account);
              return {
                sessionModelSwitch: "in-session" as const,
                liveSteer: "supported" as const,
                codexFailedRootRestart: true,
              };
            }),
          effect: delivery,
        });
        assert.equal(deliveries, 1);
        // Legacy explicit sends without a restart request remain ordinary
        // commands; they cannot be silently upgraded into cold recovery.
        yield* guardRemoteCodexFailedRootRestart({
          request: { ...request, expectedFailedRoot: undefined },
          readCapabilities: () => Effect.die("Ordinary send must not probe restart capability"),
          effect: delivery,
        });
        assert.equal(deliveries, 2);
      }),
  );
  it.effect(
    "requires exact authenticated context support before numeric or Reset reconfiguration delivery",
    () =>
      Effect.gen(function* () {
        const account = ProviderInstanceId.make("synthetic-context-owner");
        const base: ProviderSessionStartInput = {
          threadId: ThreadId.make("synthetic-context-thread"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: account,
          runtimeMode: "full-access",
        };
        const observed: Array<ProviderInstanceId> = [];
        let deliveries = 0;
        const delivery = Effect.sync(() => ++deliveries);
        for (const capability of [false, undefined, "true"] as const) {
          for (const policy of [
            { codexContextWindowOverride: 500_000 },
            { codexContextWindowOverride: null, requireIdleForCodexContextWindowChange: true },
          ] as const) {
            const result = yield* guardRemoteCodexContextWindowStart({
              request: { ...base, ...policy },
              readCapabilities: (instanceId) =>
                Effect.sync(() => {
                  observed.push(instanceId);
                  return {
                    sessionModelSwitch: "in-session" as const,
                    liveSteer: "unsupported" as const,
                    ...(capability !== undefined
                      ? { codexContextWindow: capability as boolean }
                      : {}),
                  };
                }),
              effect: delivery,
            }).pipe(Effect.result);
            assert.equal(result._tag, "Failure");
            assert.equal(deliveries, 0);
          }
        }
        assert.deepEqual(observed, Array(6).fill(account));
        const qualified = yield* guardRemoteCodexContextWindowStart({
          request: { ...base, codexContextWindowOverride: 500_000 },
          readCapabilities: (instanceId) =>
            Effect.sync(() => {
              assert.equal(instanceId, account);
              return {
                sessionModelSwitch: "in-session" as const,
                liveSteer: "unsupported" as const,
                codexContextWindow: true,
                codexContextCompaction: true,
              };
            }),
          effect: delivery,
        });
        assert.equal(qualified, 1);
        // A context-only legacy owner may understand the number but cannot
        // prove that this opening pairs the automatic-compaction request.
        for (const paired of [undefined, false, "true"] as const) {
          const refused = yield* guardRemoteCodexContextWindowStart({
            request: { ...base, codexContextWindowOverride: 800_000 },
            readCapabilities: () =>
              Effect.succeed({
                sessionModelSwitch: "in-session" as const,
                liveSteer: "supported" as const,
                codexContextWindow: true,
                ...(paired === undefined ? {} : { codexContextCompaction: paired as boolean }),
              }),
            effect: delivery,
          }).pipe(Effect.result);
          assert.equal(refused._tag, "Failure");
          assert.equal(deliveries, 1);
        }
        for (const request of [
          { ...base, providerInstanceId: undefined, codexContextWindowOverride: 500_000 },
          {
            ...base,
            provider: ProviderDriverKind.make("claudeAgent"),
            codexContextWindowOverride: 500_000,
          },
        ]) {
          const result = yield* guardRemoteCodexContextWindowStart({
            request,
            readCapabilities: () => Effect.die(new Error("Unbound policy must not read an owner.")),
            effect: delivery,
          }).pipe(Effect.result);
          assert.equal(result._tag, "Failure");
        }
        assert.equal(deliveries, 1);
        yield* guardRemoteCodexContextWindowStart({
          request: { ...base, codexContextWindowOverride: null },
          readCapabilities: () =>
            Effect.die(new Error("Native inheritance must not probe a legacy owner.")),
          effect: delivery,
        });
        assert.equal(deliveries, 2);
      }),
  );

  it("binds stable rewind command identities to their phase and finish outcome", () => {
    const ids = new Set<string>();
    for (const input of rewindRequests) {
      const request = providerDaemonConversationRollbackRequest(input);
      assert.deepEqual(request, providerDaemonConversationRollbackRequest(input));
      assert.deepEqual(attachCommandIdToMutatingProviderDaemonRequest(request), request);
      assert.doesNotThrow(() => encodeRpcRequest(request));
      assert.deepEqual(providerDaemonRequestThreadIds(request), [rewindIdentity.threadId]);
      assert.isTrue(isVoidProviderDaemonRpcMethod(request.method));
      ids.add(request.commandId!);
    }
    assert.equal(ids.size, 4);
  });

  it.each(rewindRequests)(
    "replays $method only with the same exact phase bytes after reset",
    async (request) => {
      const bodies: Array<string | undefined> = [];
      await requestProviderDaemonConversationRollback(
        rewindConfig,
        request,
        async (_config, _path, options) => {
          bodies.push(options?.body);
          if (bodies.length === 1)
            throw Object.assign(new Error("private-transport-details"), { code: "ECONNRESET" });
          return { statusCode: 200, body: '{"ok":true,"value":null}' };
        },
      );
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0], bodies[1]);
      assert.equal(
        JSON.parse(bodies[0]!).commandId,
        providerDaemonConversationRollbackRequest(request).commandId,
      );
    },
  );

  it.each([
    ["malformed envelope", { statusCode: 200, body: "private-provider-response" }],
    ["absent acknowledgement", { statusCode: 200, body: '{"ok":true}' }],
    [
      "invalid void value",
      { statusCode: 200, body: '{"ok":true,"value":"private-provider-response"}' },
    ],
    ["unsuccessful status", { statusCode: 503, body: '{"ok":true,"value":null}' }],
    [
      "provider mutation uncertainty",
      {
        statusCode: 200,
        body: '{"ok":false,"error":{"tag":"ProviderAdapterRewindOutcomeUnknownError","message":"private-provider-response"}}',
      },
    ],
    [
      "ledger in progress",
      {
        statusCode: 200,
        body: '{"ok":false,"error":{"tag":"ProviderDaemonCommandAlreadyRunning","message":"private-provider-response"}}',
      },
    ],
    [
      "ledger identity conflict",
      {
        statusCode: 200,
        body: '{"ok":false,"error":{"tag":"ProviderDaemonCommandIdentityMismatch","message":"private-provider-response"}}',
      },
    ],
    [
      "unknown server error",
      {
        statusCode: 500,
        body: '{"ok":false,"error":{"tag":"UnexpectedFailure","message":"private-provider-response"}}',
      },
    ],
  ] as const)("keeps %s rewind outcome unknown and redacted", async (_scenario, response) => {
    let attempts = 0;
    const error = await requestProviderDaemonConversationRollback(
      rewindConfig,
      rewindRequests[1],
      async () => {
        attempts += 1;
        return response;
      },
    ).catch((cause: unknown) => cause);
    assert.instanceOf(error, ProviderAdapterRewindOutcomeUnknownError);
    assert.equal(attempts, 1);
    assert.notProperty(error, "cause");
    assert.notInclude(JSON.stringify(error), "private-provider-response");
  });

  it("keeps exhausted transport retries unknown without exposing socket or capability data", async () => {
    let attempts = 0;
    const error = await requestProviderDaemonConversationRollback(
      rewindConfig,
      rewindRequests[1],
      async () => {
        attempts += 1;
        throw Object.assign(new Error("private-provider-socket-and-capability"), {
          code: "ECONNRESET",
        });
      },
    ).catch((cause: unknown) => cause);
    assert.instanceOf(error, ProviderAdapterRewindOutcomeUnknownError);
    assert.equal(attempts, 2);
    assert.notInclude(String(error), "private-provider");
  });

  it("does not treat authentication after a lost response as a definite rewind refusal", async () => {
    let attempts = 0;
    let bodyReads = 0;
    const error = await requestProviderDaemonConversationRollback(
      rewindConfig,
      rewindRequests[1],
      async () => {
        if (++attempts === 1) throw Object.assign(new Error("response lost"), { code: "EPIPE" });
        return {
          statusCode: 403,
          get body() {
            bodyReads += 1;
            return "private-provider-response";
          },
        };
      },
    ).catch((cause: unknown) => cause);
    assert.instanceOf(error, ProviderAdapterRewindOutcomeUnknownError);
    assert.equal(attempts, 2);
    assert.equal(bodyReads, 0);
  });

  it("preserves recognized definitive rewind refusal tags without native diagnostics", async () => {
    const error = await requestProviderDaemonConversationRollback(
      rewindConfig,
      rewindRequests[0],
      async () => ({
        statusCode: 200,
        body: JSON.stringify({
          ok: false,
          error: { tag: "ProviderAdapterValidationError", message: "private-checkpoint-path" },
        }),
      }),
    ).catch((cause: unknown) => cause);
    assert.instanceOf(error, ProviderAdapterRequestError);
    assert.equal(error.remoteErrorTag, "ProviderAdapterValidationError");
    assert.notInclude(JSON.stringify(error), "private-checkpoint-path");
  });

  it("rejects malformed local rewind identity without submitting an RPC", async () => {
    let attempts = 0;
    const request = {
      ...rewindRequests[1],
      payload: { ...rewindIdentity, operationId: "not-a-uuid" },
    };
    const error = await requestProviderDaemonConversationRollback(
      rewindConfig,
      request,
      async () => {
        attempts += 1;
        return { statusCode: 200, body: '{"ok":true,"value":null}' };
      },
    ).catch((cause: unknown) => cause);
    assert.equal(attempts, 0);
    assert.notInstanceOf(error, ProviderAdapterRewindOutcomeUnknownError);
  });
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
    }),
  );

  for (const [scenario, failure] of [
    [
      "timeout",
      Object.assign(new Error("timed out at /private/provider-secret.sock"), {
        code: "ETIMEDOUT",
      }),
    ],
    ["HTTP 500", new ProviderDaemonHttpStatusError(500)],
    [
      "malformed response",
      new Error('Cannot decode {"token":"provider-secret-capability","body":"private-output"}'),
    ],
    [
      "provider RPC failure",
      new ProviderDaemonRpcResponseError("ProviderInternalError", "private-output"),
    ],
  ] as const) {
    it.effect(`keeps ${scenario} inventory failure inconclusive and redacted`, () =>
      Effect.gen(function* () {
        const error = toRemoteRequestError("listSessions", failure);
        let reconciliationRan = false;
        const exit = yield* recoverRemoteSessionInventory(Effect.fail(error)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              reconciliationRan = true;
            }),
          ),
          Effect.exit,
        );
        assert.isFalse(reconciliationRan);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          const defect = exit.cause.reasons.find(Cause.isDieReason)?.defect;
          assert.instanceOf(defect, ProviderDaemonSessionInventoryUnavailableError);
          assert.notProperty(defect, "cause");
          assert.notInclude(Cause.pretty(exit.cause), "provider-secret");
          assert.notInclude(Cause.pretty(exit.cause), "private-output");
        }
        const observation = yield* recoverRemoteSessionInventory(Effect.fail(error)).pipe(
          Effect.map(() => "authoritative" as const),
          Effect.catchCause(() => Effect.succeed("unknown" as const)),
        );
        assert.equal(observation, "unknown");
      }),
    );
  }

  it.effect("preserves successful empty and nonempty session inventory", () =>
    Effect.gen(function* () {
      const sessions = [{ threadId: "thread-still-running", activeTurnId: "turn-active" }];
      assert.deepEqual(yield* recoverRemoteSessionInventory(Effect.succeed([])), []);
      assert.strictEqual(yield* recoverRemoteSessionInventory(Effect.succeed(sessions)), sessions);
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
  it("never replays native login or attestation consent after a lost acknowledgement", async () => {
    const input = {
      instanceId: ProviderInstanceId.make("axiom-fixture"),
      threadId: ThreadId.make("fixture-thread"),
      runtimeId: SubagentRuntimeId.make("10000000-0000-4000-8000-000000000001"),
      modelId: "model",
      configurationKey: "a".repeat(64),
      acceptOutdatedTee: true,
    };
    const requests = [
      { method: "loginProvider", payload: { instanceId: input.instanceId } },
      { method: "refreshSecurity", payload: input },
      {
        method: "manageMcp",
        payload: { ...input, expectedRevision: 1, action: { kind: "test", name: "fixture" } },
      },
    ] as const;
    for (const request of requests) {
      let attempts = 0;
      const reset = Object.assign(new Error("synthetic lost acknowledgement"), {
        code: "ECONNRESET",
      });
      let observed: unknown;
      try {
        await requestProviderDaemonRpcJsonWithStableRetry(
          rewindConfig,
          request,
          async (_config, _path, options = {}) => {
            attempts++;
            assert.notProperty(JSON.parse(options.body ?? "null"), "commandId");
            throw reset;
          },
        );
      } catch (error) {
        observed = error;
      }
      assert.equal(attempts, 1);
      assert.strictEqual(observed, reset);
    }
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

  it("keeps short compaction command ids valid, idempotent, and scoped to their thread", () => {
    const input = {
      threadId: ThreadId.make("thread-1"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      operationId: CommandId.make("a"),
    };
    const request = providerDaemonCompactionRequest(input);
    assert.doesNotThrow(() => Schema.encodeSync(ProviderDaemonRpcRequest)(request));
    assert.deepEqual(
      attachCommandIdToMutatingProviderDaemonRequest(request),
      providerDaemonCompactionRequest(input),
    );
    assert.deepEqual(providerDaemonRequestThreadIds(request), [input.threadId]);
    assert.isTrue(isVoidProviderDaemonRpcMethod(request.method));
    assert.notEqual(
      providerDaemonCompactionRequest({ ...input, operationId: CommandId.make("b") }).commandId,
      request.commandId,
    );
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
