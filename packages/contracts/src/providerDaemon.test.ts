import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ProviderDaemonBootstrap,
  ProviderDaemonAdapterCapabilities,
  ProviderDaemonLiveness,
  ProviderDaemonMarker,
  ProviderDaemonSubagentDetail,
  ProviderDaemonRpcRequest,
  WindowsProcessIdentity,
} from "./providerDaemon.ts";

const OWNERSHIP_ID = "9a90b48d-868f-4614-ae9c-66d50293d52b";
const decodeDaemonLiveness = Schema.decodeUnknownSync(ProviderDaemonLiveness);

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
