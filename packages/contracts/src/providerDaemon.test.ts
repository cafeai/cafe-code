import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ProviderDaemonBootstrap,
  ProviderDaemonAdapterCapabilities,
  ProviderDaemonEventRecord,
  ProviderDaemonLiveness,
  ProviderDaemonHealth,
  ProviderDaemonGlideStartupDiagnostics,
  ProviderDaemonCapability,
  ProviderDaemonRetirementRequest,
  ProviderDaemonRetirementResponse,
  ProviderDaemonMarker,
  ProviderDaemonSubagentDetail,
  ProviderDaemonRpcRequest,
  ProviderDaemonRpcEnvelope,
  ProviderDaemonCommandDiagnostic,
  ProviderDaemonRecentRpcFailure,
  ProviderDaemonRpcResultByMethod,
  WindowsProcessIdentity,
} from "./providerDaemon.ts";

it("keeps optional desktop-tools failure observations numeric and finite in JSON health", () => {
  const decode = Schema.decodeUnknownSync(ProviderDaemonGlideStartupDiagnostics);
  const json = Schema.fromJsonString(ProviderDaemonGlideStartupDiagnostics);
  for (const phase of [undefined, "attach", "activate", "tray"] as const) {
    const observation = {
      attachFailureCount: 1,
      activationFailureCount: 2,
      trayFailureCount: 0,
      ...(phase === undefined ? {} : { lastFailurePhase: phase }),
    };
    assert.deepEqual(
      Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(observation)),
      observation,
    );
  }
  for (const invalid of [-1, 0.5, Infinity, "1", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      decode({ attachFailureCount: invalid, activationFailureCount: 0, trayFailureCount: 0 }),
    );
  }
  assert.throws(() =>
    decode({
      attachFailureCount: 0,
      activationFailureCount: 0,
      trayFailureCount: 0,
      lastFailurePhase: "arbitrary native error",
    }),
  );
});

it("keeps private phased recovery tokens and status shapes finite across the daemon codec", () => {
  const decodeRequest = Schema.decodeUnknownSync(ProviderDaemonRpcRequest);
  const decodePreparation = Schema.decodeUnknownSync(
    ProviderDaemonRpcResultByMethod.prepareFailedRootRecovery,
  );
  const common = {
    threadId: "thread-private",
    attemptId: "attempt-private",
    requestCommitment: "a".repeat(64),
    preparationSequence: 0,
  };
  const prepared = {
    ...common,
    state: "prepared",
    phase: "prepared",
    providerInstanceId: "codex",
    recoverySession: {
      previousSubagentRuntimeId: "10000000-0000-4000-8000-000000000001",
      subagentRuntimeId: "10000000-0000-4000-8000-000000000002",
      providerThreadId: "history-private",
    },
    permit: "b".repeat(64),
  };
  assert.deepEqual(decodePreparation(prepared), prepared);
  for (const bad of [
    { ...prepared, permit: "short" },
    { ...prepared, permit: "B".repeat(64) },
    { ...prepared, permit: `${"b".repeat(64)}\n` },
    { ...prepared, requestCommitment: "x".repeat(64) },
    { ...prepared, preparationSequence: -1 },
    { ...prepared, preparationSequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...common, state: "consumed", phase: "retired" },
  ])
    assert.throws(() => decodePreparation(bad));
  const payload = {
    attemptId: "attempt-private",
    preparationSequence: 0,
    request: { threadId: "thread-private", input: "synthetic" },
  };
  assert.deepEqual(
    decodeRequest({
      method: "prepareFailedRootRecovery",
      commandId: "10000000-0000-4000-8000-000000000001",
      payload,
    }),
    {
      method: "prepareFailedRootRecovery",
      commandId: "10000000-0000-4000-8000-000000000001",
      payload,
    },
  );
  assert.throws(() =>
    decodeRequest({
      method: "prepareFailedRootRecovery",
      commandId: "10000000-0000-4000-8000-000000000001",
      payload: { ...payload, continuationToken: "bad" },
    }),
  );
  const cancellation = {
    threadId: payload.request.threadId,
    attemptId: payload.attemptId,
    requestCommitment: "c".repeat(64),
  };
  assert.deepEqual(
    decodeRequest({
      method: "cancelFailedRootRecovery",
      commandId: "10000000-0000-4000-8000-000000000002",
      payload: cancellation,
    }),
    {
      method: "cancelFailedRootRecovery",
      commandId: "10000000-0000-4000-8000-000000000002",
      payload: cancellation,
    },
  );
  assert.throws(() =>
    decodeRequest({
      method: "cancelFailedRootRecovery",
      payload: { ...cancellation, requestCommitment: "bad" },
    }),
  );
});

const OWNERSHIP_ID = "9a90b48d-868f-4614-ae9c-66d50293d52b";
const decodeDaemonLiveness = Schema.decodeUnknownSync(ProviderDaemonLiveness);

it("keeps cooperative retirement finite, exact and outside ordinary lease capabilities", () => {
  const request = {
    protocolVersion: 1,
    pid: 123,
    startedAt: "2026-10-29T00:00:00.000Z",
    runtimeBuildId: "a".repeat(64),
    dataProfile: "debug",
    dataProfileId: "b".repeat(64),
    nonce: "c".repeat(64),
  };
  const decode = Schema.decodeUnknownSync(ProviderDaemonRetirementRequest);
  const decodeResponse = Schema.decodeUnknownSync(ProviderDaemonRetirementResponse);
  assert.deepEqual(decode(request), request);
  assert.deepEqual(decodeResponse({ accepted: true, ...request }), { accepted: true, ...request });
  for (const [index, invalid] of [
    { ...request, protocolVersion: 2 },
    { ...request, pid: 0 },
    { ...request, pid: 1.5 },
    { ...request, startedAt: "not-a-time" },
    { ...request, runtimeBuildId: "A".repeat(64) },
    { ...request, runtimeBuildId: "a".repeat(65) },
    { ...request, runtimeBuildId: `${"a".repeat(64)}\n` },
    { ...request, dataProfile: "other" },
    { ...request, dataProfileId: "short" },
    { ...request, dataProfileId: `${"b".repeat(64)}\n` },
    { ...request, nonce: "c".repeat(63) },
    { ...request, nonce: `${"c".repeat(64)}\n` },
    { ...request, extra: "private-input-must-not-be-accepted" },
  ].entries())
    assert.throws(() => decode(invalid), `invalid retirement request case ${index}`);
  assert.throws(() => decodeResponse({ accepted: false, ...request }));
  assert.throws(() => decodeResponse({ accepted: true, ...request, extra: true }));
  assert.throws(() => Schema.decodeUnknownSync(ProviderDaemonCapability)("retire"));
  // Optional health proof is deliberately not a required legacy field.
  const legacyHealth = {
    ok: true,
    mode: "provider-daemon",
    pid: 123,
    ppid: 1,
    version: "0.0.0-test",
    startedAt: request.startedAt,
    activeSessionCount: 0,
    configuredInstanceCount: 0,
    eventCursor: 0,
  };
  const decodeHealth = Schema.decodeUnknownSync(ProviderDaemonHealth);
  assert.equal(Object.hasOwn(decodeHealth(legacyHealth), "retirementProtocol"), false);
  assert.equal(
    decodeHealth({ ...legacyHealth, startedAt: "legacy-native-time" }).startedAt,
    "legacy-native-time",
  );
  assert.equal(decodeHealth({ ...legacyHealth, retirementProtocol: 1 }).retirementProtocol, 1);
  for (const retirementProtocol of [0, 2, true, null, "1"])
    assert.throws(() => decodeHealth({ ...legacyHealth, retirementProtocol }));
});

it("requires a bounded real canonical UTC instant in both retirement wire directions", () => {
  const request = {
    protocolVersion: 1,
    pid: 123,
    startedAt: "2026-10-29T00:00:00.000Z",
    runtimeBuildId: "a".repeat(64),
    dataProfile: "debug",
    dataProfileId: "b".repeat(64),
    nonce: "c".repeat(64),
  };
  const requestJson = Schema.fromJsonString(ProviderDaemonRetirementRequest);
  const responseJson = Schema.fromJsonString(ProviderDaemonRetirementResponse);
  const decodeRequest = Schema.decodeUnknownSync(ProviderDaemonRetirementRequest);
  const decodeResponse = Schema.decodeUnknownSync(ProviderDaemonRetirementResponse);
  const decodeRequestJson = Schema.decodeUnknownSync(requestJson);
  const decodeResponseJson = Schema.decodeUnknownSync(responseJson);
  const encodeRequestJson = Schema.encodeSync(requestJson);
  const encodeResponseJson = Schema.encodeSync(responseJson);

  // A leap day and the Unix epoch remain valid through the actual JSON codecs.
  for (const startedAt of ["2024-02-29T23:59:59.123Z", "1970-01-01T00:00:00.000Z"]) {
    const value = { ...request, startedAt };
    const response = { accepted: true, ...value };
    assert.deepEqual(decodeRequestJson(encodeRequestJson(decodeRequest(value))), value);
    assert.deepEqual(decodeResponseJson(encodeResponseJson(decodeResponse(response))), response);
  }
  for (const [label, startedAt] of [
    ["invalid text", "not-a-time"],
    ["impossible month day", "2026-02-30T00:00:00.000Z"],
    ["non-leap February", "2025-02-29T00:00:00.000Z"],
    ["normalized next-day hour", "2026-10-29T24:00:00.000Z"],
    ["missing milliseconds", "2026-10-29T00:00:00Z"],
    ["alternate UTC offset", "2026-10-29T00:00:00.000+00:00"],
    ["trailing newline", "2026-10-29T00:00:00.000Z\n"],
    ["oversized input", "0".repeat(1024)],
  ] as const) {
    const value = { ...request, startedAt };
    const response = { accepted: true, ...value };
    assert.throws(() => decodeRequest(value), `${label}: request`);
    assert.throws(() => decodeResponse(response), `${label}: response`);
    assert.throws(() => decodeRequestJson(JSON.stringify(value)), `${label}: JSON request`);
    assert.throws(() => decodeResponseJson(JSON.stringify(response)), `${label}: JSON response`);
  }
});

it("retains only finite configuration-refusal evidence through current and legacy RPC codecs", () => {
  const decode = Schema.decodeUnknownSync(ProviderDaemonRpcEnvelope);
  const json = Schema.fromJsonString(ProviderDaemonRpcEnvelope);
  const decodeJson = Schema.decodeUnknownSync(json);
  const encodeJson = Schema.encodeSync(json);
  const legacy = {
    ok: false,
    error: { tag: "ProviderAdapterRequestError", message: "Configuration is deferred." },
  };
  for (const code of [undefined, "subagent-concurrency-active", "codex-context-window-active"]) {
    const value = {
      ...legacy,
      error: { ...legacy.error, ...(code ? { sessionReconfigurationRefusal: code } : {}) },
    };
    assert.deepEqual(decode(value), value);
    assert.deepEqual(JSON.parse(encodeJson(decode(value))), value);
    assert.deepEqual(decodeJson(JSON.stringify(value)), value);
    assert.deepEqual(decodeJson(encodeJson(decode(value))), value);
  }
  assert.equal(
    Object.hasOwn((decode(legacy) as typeof legacy).error, "sessionReconfigurationRefusal"),
    false,
  );
  for (const code of [
    null,
    false,
    17,
    {},
    [],
    "unknown",
    "codex-context-window-active ",
    "private-untrusted-tag-sentinel",
  ]) {
    const value = { ...legacy, error: { ...legacy.error, sessionReconfigurationRefusal: code } };
    assert.throws(() => decode(value));
    assert.throws(() => decodeJson(JSON.stringify(value)));
  }
});

it("keeps failed-root retirement refusals finite and legacy omission unknown across RPC and diagnostics", () => {
  const schemas: ReadonlyArray<{
    readonly schema: Schema.Codec<unknown, unknown>;
    readonly legacy: unknown;
    readonly withReason: (reason: unknown) => unknown;
  }> = [
    {
      schema: ProviderDaemonRpcEnvelope,
      legacy: { ok: false, error: { tag: "ProviderAdapterRequestError", message: "Refused." } },
      withReason: (reason: unknown) => ({
        ok: false,
        error: {
          tag: "ProviderAdapterRequestError",
          message: "Refused.",
          failedRootRetirementRefusal: reason,
        },
      }),
    },
    {
      schema: ProviderDaemonCommandDiagnostic,
      legacy: {
        commandId: "command",
        method: "sendTurn",
        createdAt: "2026-10-19T01:00:00.000Z",
        updatedAt: "2026-10-19T01:00:00.001Z",
      },
      withReason: (reason: unknown) => ({
        commandId: "command",
        method: "sendTurn",
        createdAt: "2026-10-19T01:00:00.000Z",
        updatedAt: "2026-10-19T01:00:00.001Z",
        failedRootRetirementRefusal: reason,
      }),
    },
    {
      schema: ProviderDaemonRecentRpcFailure,
      legacy: {
        failedAt: "2026-10-19T01:00:00.001Z",
        method: "sendTurn",
        tag: "ProviderAdapterRequestError",
        message: "Refused.",
      },
      withReason: (reason: unknown) => ({
        failedAt: "2026-10-19T01:00:00.001Z",
        method: "sendTurn",
        tag: "ProviderAdapterRequestError",
        message: "Refused.",
        failedRootRetirementRefusal: reason,
      }),
    },
  ];
  for (const fixture of schemas) {
    const json = Schema.fromJsonString(fixture.schema);
    const decode = Schema.decodeUnknownSync(json);
    const encode = Schema.encodeSync(json);
    assert.deepEqual(decode(JSON.stringify(fixture.legacy)), fixture.legacy);
    for (const reason of [
      "invalid-request",
      "owner-changed",
      "native-context-unavailable",
      "history-unavailable",
      "compaction-pending",
      "root-start-pending",
      "closed",
      "root-proof-changed",
      "notifications-pending",
    ]) {
      const value = fixture.withReason(reason);
      assert.deepEqual(decode(JSON.stringify(value)), value);
      assert.deepEqual(JSON.parse(encode(decode(JSON.stringify(value)))), value);
    }
    for (const reason of [null, false, 7, {}, [], "unknown", "notifications-pending "]) {
      assert.throws(() => decode(JSON.stringify(fixture.withReason(reason))));
    }
  }
});

it("preserves finite refusal codes through bounded command diagnostic JSON without changing legacy fields", () => {
  const schema = Schema.fromJsonString(ProviderDaemonCommandDiagnostic);
  const decode = Schema.decodeUnknownSync(schema);
  const encode = Schema.encodeSync(schema);
  const legacy = {
    commandId: "command",
    method: "startSession",
    status: "failed" as const,
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.001Z",
    errorTag: "ProviderAdapterRequestError",
    errorMessage: "Configuration is deferred.",
  };
  for (const code of [undefined, "subagent-concurrency-active", "codex-context-window-active"]) {
    const value = { ...legacy, ...(code ? { sessionReconfigurationRefusal: code } : {}) };
    assert.deepEqual(decode(JSON.stringify(value)), value);
    assert.deepEqual(JSON.parse(encode(decode(JSON.stringify(value)))), value);
  }
  assert.throws(() =>
    decode(JSON.stringify({ ...legacy, sessionReconfigurationRefusal: "unknown" })),
  );
  const failureJson = Schema.fromJsonString(ProviderDaemonRecentRpcFailure);
  const decodeFailure = Schema.decodeUnknownSync(failureJson);
  const encodeFailure = Schema.encodeSync(failureJson);
  const rpcLegacy = {
    failedAt: legacy.updatedAt,
    method: "startSession",
    tag: legacy.errorTag,
    message: legacy.errorMessage,
  };
  for (const code of [undefined, "subagent-concurrency-active", "codex-context-window-active"]) {
    const value = { ...rpcLegacy, ...(code ? { sessionReconfigurationRefusal: code } : {}) };
    assert.deepEqual(decodeFailure(JSON.stringify(value)), value);
    assert.deepEqual(JSON.parse(encodeFailure(decodeFailure(JSON.stringify(value)))), value);
  }
  assert.throws(() =>
    decodeFailure(JSON.stringify({ ...rpcLegacy, sessionReconfigurationRefusal: "unknown" })),
  );
});

it("carries optional private history coordinates through authenticated daemon session results", () => {
  const legacy = {
    provider: "claudeAgent",
    providerInstanceId: "claude_personal",
    status: "running",
    runtimeMode: "full-access",
    threadId: "thread-history",
    createdAt: "2026-10-11T00:00:00Z",
    updatedAt: "2026-10-11T00:00:00Z",
  };
  const current = {
    ...legacy,
    subagentHistoryResumeCursor: { resume: "00000000-0000-4000-8000-000000000941" },
  };
  for (const session of [legacy, current]) {
    const start = ProviderDaemonRpcResultByMethod.startSession;
    const decodedSession = Schema.decodeUnknownSync(start)(session);
    assert.deepEqual(
      Schema.decodeUnknownSync(start)(Schema.encodeSync(start)(decodedSession)),
      session,
    );
    const list = ProviderDaemonRpcResultByMethod.listSessions;
    const decodedSessions = Schema.decodeUnknownSync(list)([session]);
    assert.deepEqual(Schema.decodeUnknownSync(list)(Schema.encodeSync(list)(decodedSessions)), [
      session,
    ]);
  }
});

it("rejects malformed or padded private Claude history roots across daemon session results", () => {
  const historySessionId = "00000000-0000-4000-8000-000000000941";
  const session = {
    provider: "claudeAgent",
    providerInstanceId: "claude_personal",
    status: "running",
    runtimeMode: "full-access",
    threadId: "thread-history",
    createdAt: "2026-10-11T00:00:00Z",
    updatedAt: "2026-10-11T00:00:00Z",
  };
  for (const subagentHistoryResumeCursor of [
    null,
    historySessionId,
    {},
    [],
    { sessionId: historySessionId },
    { resume: null },
    { resume: 15 },
    { resume: "not-a-uuid" },
    { resume: ` ${historySessionId}` },
    { resume: `${historySessionId} ` },
    { resume: `\t${historySessionId}\r\n` },
    { resume: "00000000-0000-0000-8000-000000000941" },
    { resume: "00000000-0000-4000-0000-000000000941" },
  ]) {
    const invalid = { ...session, subagentHistoryResumeCursor };
    assert.throws(() =>
      Schema.decodeUnknownSync(ProviderDaemonRpcResultByMethod.startSession)(invalid),
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(ProviderDaemonRpcResultByMethod.listSessions)([invalid]),
    );
  }
});

it("retains exact current and legacy Claude task roots through daemon-record JSON transport", () => {
  const historySessionId = "00000000-0000-4000-8000-000000000961";
  const recordJson = Schema.fromJsonString(ProviderDaemonEventRecord);
  const decodeRecord = Schema.decodeUnknownSync(ProviderDaemonEventRecord);
  const encodeRecordJson = Schema.encodeSync(recordJson);
  const decodeRecordJson = Schema.decodeUnknownSync(recordJson);
  const base = {
    eventId: "claude-history-task",
    provider: "claudeAgent",
    providerInstanceId: "claude_history_account",
    createdAt: "2026-10-11T00:00:00Z",
    threadId: "claude-history-parent",
    turnId: "claude-history-turn",
    subagentRuntimeId: "00000000-0000-4000-8000-000000000962",
  };
  const tasks = [
    { type: "task.started", payload: { taskId: "native-task" } },
    {
      type: "task.progress",
      payload: { taskId: "native-task", description: "Reviewing files" },
    },
    { type: "task.completed", payload: { taskId: "native-task", status: "completed" } },
  ];
  for (const task of tasks) {
    const legacy = { ...base, ...task };
    const current = { ...legacy, claudeSubagentHistorySessionId: historySessionId };
    for (const event of [legacy, current]) {
      const input = { cursor: 1, emittedAt: base.createdAt, event };
      const decoded = decodeRecord(input);
      assert.deepEqual(decoded, input);
      assert.deepEqual(JSON.parse(encodeRecordJson(decoded)), input);
      assert.deepEqual(decodeRecordJson(JSON.stringify(input)), input);
      assert.deepEqual(decodeRecordJson(encodeRecordJson(decoded)), input);
    }
    for (const claudeSubagentHistorySessionId of [
      "not-a-uuid",
      ` ${historySessionId}`,
      `${historySessionId} `,
      `\t${historySessionId}\r\n`,
      null,
      {},
    ]) {
      const input = {
        cursor: 1,
        emittedAt: base.createdAt,
        event: { ...legacy, claudeSubagentHistorySessionId },
      };
      assert.throws(() => decodeRecord(input));
      assert.throws(() => decodeRecordJson(JSON.stringify(input)));
    }
  }
});

it("preserves explicit subagent concurrency support across daemon capability encode/decode", () => {
  const decode = Schema.decodeUnknownSync(ProviderDaemonAdapterCapabilities);
  const encode = Schema.encodeSync(ProviderDaemonAdapterCapabilities);
  const capabilities = {
    sessionModelSwitch: "restart-resume",
    liveSteer: "unsupported",
    manualCompaction: "supported",
    threadGoals: "unsupported",
    sessionFork: "supported",
  } as const;
  for (const subagentConcurrency of [true, false]) {
    const value = { ...capabilities, subagentConcurrency };
    assert.deepEqual(decode(value), value);
    assert.deepEqual(decode(encode(value)), value);
  }
  // Older daemons omit optional capabilities. Preserve that absence: a missing
  // field is not evidence that native concurrency controls are supported.
  assert.deepEqual(decode(capabilities), capabilities);
  assert.deepEqual(encode(capabilities), capabilities);
  assert.equal(decode(capabilities).subagentConcurrency, undefined);
});

it("rejects malformed concurrency support without relaxing other required daemon capabilities", () => {
  const decode = Schema.decodeUnknownSync(ProviderDaemonAdapterCapabilities);
  const capabilities = { sessionModelSwitch: "in-session", liveSteer: "supported" };
  for (const subagentConcurrency of [null, "true", "false", 0, 1, {}, [], () => true]) {
    assert.throws(() => decode({ ...capabilities, subagentConcurrency }));
  }
  for (const invalid of [
    { subagentConcurrency: true },
    { sessionModelSwitch: "in-session", subagentConcurrency: true },
    { liveSteer: "supported", subagentConcurrency: true },
    { ...capabilities, sessionModelSwitch: "unknown", subagentConcurrency: true },
    { ...capabilities, liveSteer: true, subagentConcurrency: true },
  ]) {
    assert.throws(() => decode(invalid));
  }
});

it("keeps Cafe unchanged-policy continuation distinct from native support and binds its full tuple", () => {
  const decodeCapabilities = Schema.decodeUnknownSync(ProviderDaemonAdapterCapabilities);
  const capabilities = { sessionModelSwitch: "in-session", liveSteer: "supported" } as const;
  assert.deepEqual(
    decodeCapabilities({
      ...capabilities,
      subagentConcurrency: false,
      subagentPolicyContinuation: true,
    }),
    { ...capabilities, subagentConcurrency: false, subagentPolicyContinuation: true },
  );
  assert.equal(decodeCapabilities(capabilities).subagentPolicyContinuation, undefined);
  for (const invalid of [null, "true", 1, {}])
    assert.throws(() =>
      decodeCapabilities({ ...capabilities, subagentPolicyContinuation: invalid }),
    );
  const decodeRequest = Schema.decodeUnknownSync(ProviderDaemonRpcRequest);
  const expectedSubagentPolicySession = {
    threadId: "thread-1",
    providerInstanceId: "codex",
    subagentRuntimeId: OWNERSHIP_ID,
    maxConcurrentSubagents: 16,
  };
  for (const method of ["sendTurn", "steerTurn"] as const) {
    const payload = {
      threadId: "thread-1",
      input: "Synthetic continuation",
      ...(method === "steerTurn" ? { expectedTurnId: "turn-1" } : {}),
      expectedSubagentPolicySession,
    };
    assert.deepEqual(decodeRequest({ method, payload }), { method, payload });
    for (const key of Object.keys(expectedSubagentPolicySession)) {
      const invalid = Object.fromEntries(
        Object.entries(expectedSubagentPolicySession).filter(([field]) => field !== key),
      );
      assert.throws(() =>
        decodeRequest({ method, payload: { ...payload, expectedSubagentPolicySession: invalid } }),
      );
    }
    for (const maxConcurrentSubagents of [null, 0, 65, 1.5, "16"])
      assert.throws(() =>
        decodeRequest({
          method,
          payload: {
            ...payload,
            expectedSubagentPolicySession: {
              ...expectedSubagentPolicySession,
              maxConcurrentSubagents,
            },
          },
        }),
      );
  }
});

it("requires exact rewind identities, checkpoint boundaries and outcome values across daemon RPC", () => {
  const decode = Schema.decodeUnknownSync(ProviderDaemonRpcRequest);
  const identity = { threadId: "thread-1", operationId: OWNERSHIP_ID };
  const prepare = {
    method: "prepareConversationRollback",
    payload: {
      ...identity,
      numTurns: 2,
      firstRemovedTurnId: "turn-2",
      retainedTurnCount: 1,
      expectedControlSequence: 8,
    },
  };
  for (const request of [
    prepare,
    { method: "commitConversationRollback", payload: identity },
    { method: "finishConversationRollback", payload: { ...identity, outcome: "aborted" } },
    {
      method: "finishConversationRollback",
      payload: { ...identity, outcome: "committed", completionCommandId: "completion-receipt" },
    },
  ])
    assert.deepEqual(decode(request), request);
  for (const patch of [
    { operationId: "not-a-uuid" },
    { numTurns: 0 },
    { numTurns: 1.5 },
    { firstRemovedTurnId: "" },
    { retainedTurnCount: -1 },
    { expectedControlSequence: -1 },
    { expectedControlSequence: undefined },
  ])
    assert.throws(() => decode({ ...prepare, payload: { ...prepare.payload, ...patch } }));
  assert.throws(() =>
    decode({ method: "finishConversationRollback", payload: { ...identity, outcome: "maybe" } }),
  );
});

it("validates Windows PID and exact canonical unsigned FILETIME boundaries", () => {
  const decode = Schema.decodeUnknownSync(WindowsProcessIdentity);
  for (const identity of [
    { pid: 1, creationTime100ns: "1" },
    { pid: 4_294_967_295, creationTime100ns: "18446744073709551615" },
    { pid: 27424, creationTime100ns: "134348901321234567" },
  ]) {
    assert.deepEqual(decode(identity), identity);
    assert.equal(typeof decode(identity).creationTime100ns, "string");
  }
  for (const pid of [0, -1, 4_294_967_296, 1.5, NaN, Infinity, "1"]) {
    assert.throws(() => decode({ pid, creationTime100ns: "1" }));
  }
  for (const creationTime100ns of [
    "0",
    "01",
    "-1",
    "+1",
    "1.0",
    "1e3",
    " 1",
    "1 ",
    "18446744073709551616",
    "999999999999999999999",
    Number("134348901321234567"),
    null,
  ]) {
    assert.throws(() => decode({ pid: 1, creationTime100ns }));
  }
});

it("preserves legacy marker and POSIX payload shape while accepting Windows ownership fields", () => {
  const decodeMarker = Schema.decodeUnknownSync(ProviderDaemonMarker);
  const legacy = {
    version: 2,
    pid: 27,
    httpBaseUrl: "http://provider-daemon.local",
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    appVersion: "0.2.0",
  } as const;
  assert.deepEqual(decodeMarker(legacy), legacy);
  assert.deepEqual(decodeMarker({ ...legacy, version: 1 }), { ...legacy, version: 1 });
  const windows = {
    ...legacy,
    windowsProcessIdentity: { pid: 27, creationTime100ns: "134348901321234567" },
    windowsOwnershipId: OWNERSHIP_ID,
    windowsOwnershipState: "committed",
  };
  assert.deepEqual(decodeMarker(windows), windows);
  assert.throws(() => decodeMarker({ ...windows, windowsOwnershipId: "not-a-uuid" }));
  assert.throws(() => decodeMarker({ ...windows, windowsOwnershipState: "unknown" }));
  assert.equal(
    decodeMarker({ ...windows, windowsOwnershipState: "prepared" }).windowsOwnershipState,
    "prepared",
  );

  const bootstrap = {
    mode: "provider-daemon",
    cafeCodeHome: "/synthetic-profile",
    token: "synthetic-bootstrap-capability-000000000000",
  } as const;
  const decodeBootstrap = Schema.decodeUnknownSync(ProviderDaemonBootstrap);
  assert.deepEqual(decodeBootstrap(bootstrap), bootstrap);
  assert.equal(
    decodeBootstrap({ ...bootstrap, windowsOwnershipId: OWNERSHIP_ID }).windowsOwnershipId,
    OWNERSHIP_ID,
  );
  const liveness = {
    ok: true,
    mode: "provider-daemon",
    pid: 27,
    ppid: 1,
    version: "0.2.0",
    startedAt: legacy.createdAt,
  } as const;
  assert.deepEqual(decodeDaemonLiveness(liveness), liveness);
  assert.deepEqual(
    decodeDaemonLiveness({
      ...liveness,
      windowsProcessIdentity: windows.windowsProcessIdentity,
      windowsOwnershipId: OWNERSHIP_ID,
    }).windowsProcessIdentity,
    windows.windowsProcessIdentity,
  );
});

const decodeProviderDaemonSubagentDetail = Schema.decodeUnknownEffect(ProviderDaemonSubagentDetail);

it("admits only the explicit private startup-progress descriptor in daemon bootstrap", () => {
  const bootstrap = {
    mode: "provider-daemon",
    cafeCodeHome: "/synthetic-profile",
    token: "synthetic-bootstrap-capability-000000000000",
  } as const;
  const decode = Schema.decodeUnknownSync(ProviderDaemonBootstrap);
  assert.deepEqual(decode(bootstrap), bootstrap);
  const admitted = { ...bootstrap, startupProgressFd: 4 } as const;
  assert.deepEqual(decode(admitted), admitted);
  const json = Schema.fromJsonString(ProviderDaemonBootstrap);
  assert.deepEqual(Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(admitted)), admitted);
  for (const startupProgressFd of [null, "4", 0, 3, 5, 4.1]) {
    assert.throws(() => decode({ ...bootstrap, startupProgressFd }));
  }
});

it("preserves byte-exact child/history authorization keys through daemon RPC", () => {
  const decode = Schema.decodeUnknownSync(ProviderDaemonRpcRequest);
  const request = {
    method: "readSubagentDetail",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      subagentId: " child-1 ",
      historyId: " history-1 ",
    },
  };
  assert.deepEqual(decode(request), request);
  for (const subagentId of ["child\u0000", "child\u202e", "x".repeat(513)]) {
    assert.throws(() => decode({ ...request, payload: { ...request.payload, subagentId } }));
  }
});

it.effect("bounds provider-daemon subagent detail by aggregate UTF-8 bytes", () =>
  Effect.gen(function* () {
    const detail = yield* decodeProviderDaemonSubagentDetail({
      provider: "claudeAgent",
      providerInstanceId: "claude-primary",
      messages: [
        { key: "m0", role: "user", text: "Audit the provider" },
        { key: "m1", role: "assistant", text: "Done." },
      ],
      gaps: [],
      truncated: false,
    });
    assert.equal(detail.provider, "claudeAgent");

    const overflow = yield* Effect.exit(
      decodeProviderDaemonSubagentDetail({
        provider: "codex",
        providerInstanceId: "codex",
        messages: Array.from({ length: 5 }, (_, index) => ({
          key: `m${index}`,
          role: "assistant",
          // 8,192 four-byte scalars exactly fill the per-message limit; the
          // fifth message crosses only the aggregate boundary.
          text: "🙂".repeat(8_192),
        })),
        gaps: [],
        truncated: true,
      }),
    );
    assert.equal(overflow._tag, "Failure");
  }),
);

it.effect("shares stable omission invariants with the orchestration detail contract", () =>
  Effect.gen(function* () {
    for (const invalid of [
      {
        provider: "codex",
        providerInstanceId: "codex",
        messages: [
          { key: "m0", role: "user", text: "Assignment" },
          { key: "m0", role: "assistant", text: "Latest" },
        ],
        gaps: [],
        truncated: false,
      },
      {
        provider: "codex",
        providerInstanceId: "codex",
        messages: [
          { key: "m0", role: "user", text: "Assignment" },
          { key: "m1", role: "assistant", text: "Stale" },
        ],
        gaps: [{ afterMessageKey: "m1", omittedMessages: 1, omittedUtf8Bytes: 8 }],
        truncated: true,
      },
      {
        provider: "codex",
        providerInstanceId: "codex",
        messages: [
          {
            key: "m0",
            role: "assistant",
            text: "Head",
            omission: { tail: "tail", omittedUtf8Bytes: 8 },
          },
        ],
        gaps: [],
        truncated: false,
      },
    ] as const) {
      const exit = yield* Effect.exit(decodeProviderDaemonSubagentDetail(invalid));
      assert.equal(exit._tag, "Failure");
    }
  }),
);
