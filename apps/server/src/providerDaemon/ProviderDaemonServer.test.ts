import {
  EventId,
  PROVIDER_DAEMON_LIVENESS_PATH,
  ProviderDaemonHealth,
  ProviderDaemonLeaseRequest,
  ProviderDaemonLeaseResponse,
  ProviderDaemonLiveness,
  ProviderDaemonRpcRequest,
  ProviderDaemonRpcEnvelope,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { assert, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { EventEmitter } from "node:events";

import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import { ProviderValidationError } from "../provider/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderSupervisorRegistryLive } from "../providerSupervisor/ProviderSupervisorRegistry.ts";
import {
  captureProviderDaemonProcessDiagnostic,
  runProviderDaemonServer,
  writeProviderDaemonStreamLine,
  type ProviderDaemonServerOptions,
} from "./ProviderDaemonServer.ts";
import { ProviderRuntimeInventoryLocalLive } from "./ProviderRuntimeInventory.ts";

const TEST_TOKEN = "provider-daemon-test-token-000000000000000000000000";

const decodeProviderDaemonHealth = Schema.decodeUnknownSync(ProviderDaemonHealth);
const decodeProviderDaemonLiveness = Schema.decodeUnknownSync(ProviderDaemonLiveness);
const encodeProviderDaemonHealthJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonHealth),
);
const encodeProviderDaemonLeaseRequestJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonLeaseRequest),
);
const decodeProviderDaemonLeaseResponseJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonLeaseResponse),
);
const encodeProviderDaemonRpcRequestJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonRpcRequest),
);
const decodeProviderDaemonRpcEnvelopeJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonRpcEnvelope),
);

const asEventId = (value: string): EventId => EventId.make(value);

const startProviderDaemonServerOnEphemeralPort = (
  options: Omit<ProviderDaemonServerOptions, "port">,
) =>
  runProviderDaemonServer({ ...options, port: 0 }).pipe(
    Effect.map((snapshot) => {
      if (snapshot.port === null) {
        throw new Error("Expected provider daemon test server to bind a TCP port.");
      }
      return snapshot.port;
    }),
  );

const mockProviderService = {
  startSession: () => Effect.die("unexpected startSession"),
  forkSession: () => Effect.die("unexpected forkSession"),
  discardSessionFork: () => Effect.die("unexpected discardSessionFork"),
  sendTurn: () => Effect.die("unexpected sendTurn"),
  steerTurn: () => Effect.die("unexpected steerTurn"),
  interruptTurn: () => Effect.die("unexpected interruptTurn"),
  respondToRequest: () => Effect.die("unexpected respondToRequest"),
  respondToUserInput: () => Effect.die("unexpected respondToUserInput"),
  snoozeUserInput: () => Effect.die("unexpected snoozeUserInput"),
  stopSession: () => Effect.die("unexpected stopSession"),
  quiesceThreadForHardDelete: () => Effect.die("unexpected quiesceThreadForHardDelete"),
  restartProviderRuntime: () => Effect.die("unexpected restartProviderRuntime"),
  listSessions: () => Effect.succeed([]),
  getCapabilities: () => Effect.die("unexpected getCapabilities"),
  getInstanceInfo: () => Effect.die("unexpected getInstanceInfo"),
  rollbackConversation: () => Effect.die("unexpected rollbackConversation"),
  readSubagentDetail: () => Effect.die("unexpected readSubagentDetail"),
  streamEvents: Stream.empty,
} satisfies ProviderServiceShape;

const mockProviderAdapterRegistryLayer = Layer.effect(
  ProviderAdapterRegistry,
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<void>();
    return {
      getByInstance: () => Effect.die("unexpected getByInstance"),
      getInstanceInfo: () => Effect.die("unexpected getInstanceInfo"),
      listInstances: () => Effect.succeed([ProviderInstanceId.make("codex")]),
      listProviders: () => Effect.succeed([ProviderDriverKind.make("codex")]),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes),
    };
  }),
);

const mockServerSettingsLayer = Layer.succeed(ServerSettingsService, {
  start: Effect.void,
  ready: Effect.void,
  getSettings: Effect.die("unexpected getSettings"),
  updateSettings: () => Effect.die("unexpected updateSettings"),
  streamChanges: Stream.empty,
});

const makeProviderDaemonServerTestLayer = (providerService: ProviderServiceShape) =>
  Layer.mergeAll(
    Layer.succeed(ProviderService, providerService),
    ProviderRuntimeInventoryLocalLive.pipe(Layer.provide(mockProviderAdapterRegistryLayer)),
    mockServerSettingsLayer,
    ProviderSupervisorRegistryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const providerDaemonServerTestLayer = makeProviderDaemonServerTestLayer(mockProviderService);

describe("ProviderDaemonServer", () => {
  it("waits for drain and rejects close for a slow daemon event response", async () => {
    class FakeSlowResponse extends EventEmitter {
      writes: string[] = [];
      write(line: string): boolean {
        this.writes.push(line);
        return false;
      }
    }

    const draining = new FakeSlowResponse();
    const drainPromise = writeProviderDaemonStreamLine(
      draining as unknown as Parameters<typeof writeProviderDaemonStreamLine>[0],
      "record\n",
    );
    let settled = false;
    void drainPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.isFalse(settled);
    draining.emit("drain");
    await drainPromise;
    assert.deepEqual(draining.writes, ["record\n"]);

    const closing = new FakeSlowResponse();
    const closePromise = writeProviderDaemonStreamLine(
      closing as unknown as Parameters<typeof writeProviderDaemonStreamLine>[0],
      "record\n",
    );
    const closeResult = closePromise.then(
      () => null,
      (error: unknown) => error,
    );
    closing.emit("close");
    const closeError = await closeResult;
    assert.instanceOf(closeError, Error);
    assert.match(closeError.message, /closed before drain/u);
  });

  it.effect("serves authenticated liveness without reading provider diagnostics", () => {
    let listSessionsCallCount = 0;
    const providerService: ProviderServiceShape = {
      ...mockProviderService,
      listSessions: () =>
        Effect.sync(() => {
          listSessionsCallCount += 1;
          return [];
        }),
    };

    return Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
        protocolVersion: 1,
        runtimeBuildId: "runtime-build-test",
      });

      const unauthenticated = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}${PROVIDER_DAEMON_LIVENESS_PATH}`),
      );
      assert.equal(unauthenticated.status, 401);

      const authenticated = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}${PROVIDER_DAEMON_LIVENESS_PATH}`, {
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
          },
        }),
      );
      const liveness = decodeProviderDaemonLiveness(
        yield* Effect.promise(() => authenticated.json()),
      );

      assert.equal(authenticated.status, 200);
      assert.equal(liveness.ok, true);
      assert.equal(liveness.mode, "provider-daemon");
      assert.equal(liveness.runtimeBuildId, "runtime-build-test");
      assert.equal(listSessionsCallCount, 0);
    }).pipe(Effect.scoped, Effect.provide(makeProviderDaemonServerTestLayer(providerService)));
  });

  it.effect("rejects unauthenticated health requests and serves authorized health", () =>
    Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
        protocolVersion: 1,
        supervisorProcess: {
          status: "spawned",
          pid: process.pid,
          httpBaseUrl: "http://provider-supervisor.local",
          transport: "ipc",
          socketPath: "/tmp/provider-supervisor.sock",
          leaseId: "lease-000000000000000000000000000",
          markerPath: "/tmp/provider-supervisor.json",
          appVersion: "0.0.0-test",
          protocolVersion: 1,
          adoptedExistingProcess: false,
          durationMs: 12.34,
        },
      });

      const unauthenticated = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`),
      );
      assert.equal(unauthenticated.status, 401);

      const authenticated = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
          },
        }),
      );
      const health = decodeProviderDaemonHealth(yield* Effect.promise(() => authenticated.json()));

      assert.equal(authenticated.status, 200);
      assert.equal(health.ok, true);
      assert.equal(health.mode, "provider-daemon");
      assert.equal(health.protocolVersion, 1);
      assert.equal(health.activeSessionCount, 0);
      assert.equal(health.configuredInstanceCount, 1);
      assert.equal(health.supervisor?.sessionCount, 0);
      assert.equal(health.supervisorProcess?.status, "spawned");
      assert.equal(health.supervisorProcess?.appVersion, "0.0.0-test");
      assert.equal(health.supervisorProcess?.protocolVersion, 1);
      assert.equal(health.supervisorProcess?.leaseId, "lease-000000000000000000000000000");
      assert.isDefined(health.pipelineDiagnostics);
      assert.equal(health.pipelineDiagnostics?.daemonStream.activeStreamCount, 0);
      assert.notInclude(encodeProviderDaemonHealthJson(health), TEST_TOKEN);
    }).pipe(Effect.scoped, Effect.provide(providerDaemonServerTestLayer)),
  );

  it.effect("serves role-aware provider supervisor health", () =>
    Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        mode: "provider-supervisor",
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
        protocolVersion: 1,
      });

      const authenticated = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
          },
        }),
      );
      const health = decodeProviderDaemonHealth(yield* Effect.promise(() => authenticated.json()));

      assert.equal(authenticated.status, 200);
      assert.equal(health.ok, true);
      assert.equal(health.mode, "provider-supervisor");
      assert.equal(health.protocolVersion, 1);
      assert.equal(health.activeSessionCount, 0);
      assert.equal(health.configuredInstanceCount, 1);
    }).pipe(Effect.scoped, Effect.provide(providerDaemonServerTestLayer)),
  );

  it.effect("denies RPC access to health-only lease tokens", () =>
    Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
      });

      const leaseResponse = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/leases`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            "content-type": "application/json",
          },
          body: encodeProviderDaemonLeaseRequestJson({
            clientKind: "test",
            capabilities: ["health"],
          }),
        }),
      );
      const lease = decodeProviderDaemonLeaseResponseJson(
        yield* Effect.promise(() => leaseResponse.text()),
      );

      const healthResponse = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
          headers: {
            authorization: `Bearer ${lease.token}`,
          },
        }),
      );
      assert.equal(healthResponse.status, 200);

      const rpcResponse = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/rpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${lease.token}`,
            "content-type": "application/json",
          },
          body: encodeProviderDaemonRpcRequestJson({
            method: "stopSession",
            commandId: "command-000000000000000000000000000",
            payload: {
              threadId: ThreadId.make("thread-1"),
            },
          }),
        }),
      );
      assert.equal(rpcResponse.status, 401);
    }).pipe(Effect.scoped, Effect.provide(providerDaemonServerTestLayer)),
  );

  it.effect("records RPC and command failure diagnostics in health", () =>
    Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
      });

      const rpcResponse = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/rpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            "content-type": "application/json",
          },
          body: encodeProviderDaemonRpcRequestJson({
            method: "stopSession",
            commandId: "command-failure-0000000000000000000",
            payload: {
              threadId: ThreadId.make("thread-1"),
            },
          }),
        }),
      );
      assert.equal(rpcResponse.status, 400);

      const healthResponse = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
          },
        }),
      );
      const health = decodeProviderDaemonHealth(yield* Effect.promise(() => healthResponse.json()));

      assert.equal(health.failedCommandCount, 1);
      assert.equal(health.runningCommandCount, 0);
      assert.equal(health.persistence?.sqliteBusyTimeoutMs, 15_000);
      assert.equal(
        health.recentFailedCommands?.[0]?.errorTag,
        "ProviderDaemonCommandExecutionFailed",
      );
      assert.equal(health.rpc?.failedRpcCount, 1);
      assert.equal(health.rpc?.recentFailures?.[0]?.tag, "ProviderDaemonCommandExecutionFailed");
    }).pipe(Effect.scoped, Effect.provide(providerDaemonServerTestLayer)),
  );

  it.effect("forwards bounded subagent detail as a read-only daemon RPC", () => {
    const rootToJsonSentinel = "provider-root-to-json-must-not-cross-daemon";
    const nestedToJsonSentinel = "provider-message-to-json-must-not-cross-daemon";
    const privateFieldSentinel = "provider-private-field-must-not-cross-daemon";
    const readSubagentDetail = vi.fn(
      (_input: { threadId: ThreadId; turnId: TurnId; subagentId: string }) =>
        Effect.succeed({
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          messages: [
            {
              key: "m0",
              role: "user" as const,
              text: "Audit the provider",
              privateProviderField: privateFieldSentinel,
              toJSON: () => ({ leaked: nestedToJsonSentinel }),
            },
            { key: "m1", role: "assistant" as const, text: "## Result\n\nComplete." },
          ],
          gaps: [],
          truncated: false,
          privateProviderField: privateFieldSentinel,
          toJSON: () => ({ leaked: rootToJsonSentinel }),
        }),
    );
    const detailProviderServiceLayer = Layer.succeed(ProviderService, {
      ...mockProviderService,
      readSubagentDetail,
    } satisfies ProviderServiceShape);
    const layer = Layer.mergeAll(
      detailProviderServiceLayer,
      ProviderRuntimeInventoryLocalLive.pipe(Layer.provide(mockProviderAdapterRegistryLayer)),
      mockServerSettingsLayer,
      ProviderSupervisorRegistryLive,
    ).pipe(Layer.provideMerge(SqlitePersistenceMemory));

    return Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
      });
      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/rpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            "content-type": "application/json",
          },
          body: encodeProviderDaemonRpcRequestJson({
            method: "readSubagentDetail",
            payload: {
              threadId: ThreadId.make("thread-1"),
              turnId: TurnId.make("turn-1"),
              subagentId: "provider-child-1",
            },
          }),
        }),
      );
      assert.equal(response.status, 200);
      const responseText = yield* Effect.promise(() => response.text());
      assert.notInclude(responseText, rootToJsonSentinel);
      assert.notInclude(responseText, nestedToJsonSentinel);
      assert.notInclude(responseText, privateFieldSentinel);
      const envelope = decodeProviderDaemonRpcEnvelopeJson(responseText);
      assert.equal(envelope.ok, true);
      if (envelope.ok) {
        assert.deepEqual(envelope.value, {
          provider: "codex",
          providerInstanceId: "codex",
          messages: [
            { key: "m0", role: "user", text: "Audit the provider" },
            { key: "m1", role: "assistant", text: "## Result\n\nComplete." },
          ],
          gaps: [],
          truncated: false,
        });
      }
      assert.equal(readSubagentDetail.mock.calls.length, 1);
      assert.deepEqual(readSubagentDetail.mock.calls[0]?.[0], {
        threadId: "thread-1",
        turnId: "turn-1",
        subagentId: "provider-child-1",
      });

      const healthResponse = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        }),
      );
      const health = decodeProviderDaemonHealth(yield* Effect.promise(() => healthResponse.json()));
      assert.equal(health.completedCommandCount, 0);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("rejects noncanonical provider detail before it crosses the daemon boundary", () => {
    const invalidDetailSentinel = "invalid-provider-detail-must-not-cross-daemon";
    const providerService = {
      ...mockProviderService,
      readSubagentDetail: () =>
        Effect.succeed({
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          messages: [
            { key: "duplicate", role: "user" as const, text: invalidDetailSentinel },
            { key: "duplicate", role: "assistant" as const, text: "invalid duplicate key" },
          ],
          gaps: [],
          truncated: false,
        }),
    } satisfies ProviderServiceShape;

    return Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
      });
      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/rpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            "content-type": "application/json",
          },
          body: encodeProviderDaemonRpcRequestJson({
            method: "readSubagentDetail",
            payload: {
              threadId: ThreadId.make("thread-invalid"),
              turnId: TurnId.make("turn-invalid"),
              subagentId: "provider-child-invalid",
            },
          }),
        }),
      );
      assert.equal(response.status, 400);
      const responseText = yield* Effect.promise(() => response.text());
      assert.notInclude(responseText, invalidDetailSentinel);
      const envelope = decodeProviderDaemonRpcEnvelopeJson(responseText);
      assert.equal(envelope.ok, false);
      if (!envelope.ok) {
        assert.equal(envelope.error.tag, "ProviderSubagentDetailReadError");
        assert.equal(
          envelope.error.message,
          "Subagent detail read failed: provider-request-failed",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(makeProviderDaemonServerTestLayer(providerService)));
  });

  it.effect("does not ledger a failed exact subagent-history recovery as a mutation", () => {
    const readSubagentDetail = vi.fn((_input: { threadId: ThreadId; subagentId: string }) =>
      Effect.fail(
        new ProviderValidationError({
          operation: "ProviderService.readSubagentDetail",
          issue: "Exact provider history resume is unavailable.",
        }),
      ),
    );
    const detailProviderServiceLayer = Layer.succeed(ProviderService, {
      ...mockProviderService,
      readSubagentDetail,
    } satisfies ProviderServiceShape);
    const layer = Layer.mergeAll(
      detailProviderServiceLayer,
      ProviderRuntimeInventoryLocalLive.pipe(Layer.provide(mockProviderAdapterRegistryLayer)),
      mockServerSettingsLayer,
      ProviderSupervisorRegistryLive,
    ).pipe(Layer.provideMerge(SqlitePersistenceMemory));

    return Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
      });
      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/rpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            "content-type": "application/json",
          },
          body: encodeProviderDaemonRpcRequestJson({
            method: "readSubagentDetail",
            payload: {
              threadId: ThreadId.make("thread-ended"),
              turnId: TurnId.make("turn-ended"),
              subagentId: "provider-child-ended",
            },
          }),
        }),
      );
      assert.equal(response.status, 400);
      assert.equal(readSubagentDetail.mock.calls.length, 1);

      const healthResponse = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        }),
      );
      const health = decodeProviderDaemonHealth(yield* Effect.promise(() => healthResponse.json()));
      assert.equal(health.completedCommandCount, 0);
      assert.equal(health.failedCommandCount, 0);
      assert.equal(health.runningCommandCount, 0);
      assert.equal(health.rpc?.failedRpcCount, 1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("redacts subagent read failures from RPC, health diagnostics, and logs", () => {
    const childId = "sentinel-provider-child-id";
    const threadId = ThreadId.make("sentinel-cafe-thread-id");
    const sentinels = [
      childId,
      String(threadId),
      "/Users/private-account/.codex/rollouts/provider-child.jsonl",
      "owner-account@example.invalid",
      "raw-provider-response-body",
      "raw-provider-cause",
      "raw-provider-stack",
    ];
    const rawCause = new Error(`${sentinels[5]} ${sentinels[2]} ${sentinels[3]}`);
    rawCause.stack = `Error: ${sentinels[6]}\n    at ${sentinels[2]}:1:1`;
    const logMessages: unknown[] = [];
    const logCapture = Logger.make<unknown, void>(({ message }) => {
      if (Array.isArray(message)) {
        logMessages.push(...message);
      } else {
        logMessages.push(message);
      }
    });
    const providerService = {
      ...mockProviderService,
      readSubagentDetail: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread/read-subagent-detail",
            detail: `${sentinels[4]} ${childId}`,
            cause: {
              account: sentinels[3],
              responseBody: sentinels[4],
              cause: rawCause,
            },
          }),
        ),
    } satisfies ProviderServiceShape;
    const layer = Layer.mergeAll(
      makeProviderDaemonServerTestLayer(providerService),
      Logger.layer([logCapture], { mergeWithExisting: false }),
    );

    return Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
      });
      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/rpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            "content-type": "application/json",
          },
          body: encodeProviderDaemonRpcRequestJson({
            method: "readSubagentDetail",
            payload: { threadId, turnId: TurnId.make("turn-defect"), subagentId: childId },
          }),
        }),
      );
      assert.equal(response.status, 400);
      const responseText = yield* Effect.promise(() => response.text());
      const envelope = decodeProviderDaemonRpcEnvelopeJson(responseText);
      assert.equal(envelope.ok, false);
      if (!envelope.ok) {
        assert.equal(envelope.error.tag, "ProviderSubagentDetailReadError");
        assert.equal(
          envelope.error.message,
          "Subagent detail read failed: provider-request-failed",
        );
        assert.equal(envelope.error.diagnostics?.stack, undefined);
        assert.deepEqual(
          envelope.error.diagnostics?.causeChain.map((entry) => entry.stack),
          [undefined],
        );
      }

      const healthResponse = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        }),
      );
      const healthText = yield* Effect.promise(() => healthResponse.text());
      const health = decodeProviderDaemonHealth(JSON.parse(healthText));
      assert.equal(health.rpc?.recentFailures?.[0]?.tag, "ProviderSubagentDetailReadError");

      const serializedLogs = JSON.stringify(logMessages);
      assert.match(serializedLogs, /provider daemon rpc failed/u);
      const observableOutput = `${responseText}\n${healthText}\n${serializedLogs}`;
      for (const sentinel of sentinels) {
        assert.notInclude(observableOutput, sentinel);
      }
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("exposes recent completed command summaries without prompt text in health", () => {
    const successfulSendTurnLayer = Layer.succeed(ProviderService, {
      ...mockProviderService,
      sendTurn: (input) =>
        Effect.succeed({
          threadId: input.threadId,
          turnId: TurnId.make("turn-success"),
          resumeCursor: {
            threadId: "provider-thread-success",
          },
        }),
    } satisfies ProviderServiceShape);
    const layer = Layer.mergeAll(
      successfulSendTurnLayer,
      ProviderRuntimeInventoryLocalLive.pipe(Layer.provide(mockProviderAdapterRegistryLayer)),
      mockServerSettingsLayer,
      ProviderSupervisorRegistryLive,
    ).pipe(Layer.provideMerge(SqlitePersistenceMemory));

    return Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
      });

      const rpcResponse = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/rpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            "content-type": "application/json",
          },
          body: encodeProviderDaemonRpcRequestJson({
            method: "sendTurn",
            commandId: "command-success-0000000000000000000",
            payload: {
              threadId: ThreadId.make("thread-1"),
              input: "prompt text must not be exposed by command diagnostics",
              attachments: [],
            },
          }),
        }),
      );
      assert.equal(rpcResponse.status, 200);

      const healthResponse = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
          },
        }),
      );
      const health = decodeProviderDaemonHealth(yield* Effect.promise(() => healthResponse.json()));
      const completed = health.recentCompletedCommands?.[0];

      assert.equal(health.completedCommandCount, 1);
      assert.equal(completed?.method, "sendTurn");
      assert.equal(completed?.status, "completed");
      assert.equal(typeof completed?.durationMs, "number");
      assert.deepEqual(completed?.requestSummary, {
        method: "sendTurn",
        commandId: "command-success-0000000000000000000",
        threadId: "thread-1",
        inputByteLength: 54,
        attachmentCount: 0,
      });
      assert.deepEqual(completed?.responseSummary, {
        ok: true,
        threadId: "thread-1",
        turnId: "turn-success",
        hasResumeCursor: true,
        resumeCursorThreadId: "provider-thread-success",
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("exposes recent process diagnostics with stack traces in health", () =>
    Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
      });

      const diagnosticError = new Error("process diagnostic test error");
      captureProviderDaemonProcessDiagnostic("manual", diagnosticError, "test");

      const healthResponse = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
          },
        }),
      );
      const health = decodeProviderDaemonHealth(yield* Effect.promise(() => healthResponse.json()));
      const diagnostic = health.processDiagnostics?.recent.find(
        (entry) => entry.diagnostics.message === "process diagnostic test error",
      );

      assert.isDefined(diagnostic);
      assert.equal(diagnostic?.kind, "manual");
      assert.equal(diagnostic?.origin, "test");
      assert.include(diagnostic?.diagnostics.stack ?? "", "process diagnostic test error");
    }).pipe(Effect.scoped, Effect.provide(providerDaemonServerTestLayer)),
  );

  it.effect("exposes provider turn timing diagnostics in health", () =>
    Effect.gen(function* () {
      let releaseRuntimeEvents!: (events: ReadonlyArray<ProviderRuntimeEvent>) => void;
      const runtimeEvents = new Promise<ReadonlyArray<ProviderRuntimeEvent>>((resolve) => {
        releaseRuntimeEvents = resolve;
      });
      const streamingProviderServiceLayer = Layer.succeed(ProviderService, {
        ...mockProviderService,
        streamEvents: Stream.fromEffect(Effect.promise(() => runtimeEvents)).pipe(
          Stream.flatMap(Stream.fromIterable),
          Stream.concat(Stream.never),
        ),
      } satisfies ProviderServiceShape);
      const layer = Layer.mergeAll(
        streamingProviderServiceLayer,
        ProviderRuntimeInventoryLocalLive.pipe(Layer.provide(mockProviderAdapterRegistryLayer)),
        mockServerSettingsLayer,
        ProviderSupervisorRegistryLive,
      ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
      let signalCompletedEventJournaled!: () => void;
      const completedEventJournaled = new Promise<void>((resolve) => {
        signalCompletedEventJournaled = resolve;
      });

      yield* Effect.gen(function* () {
        const port = yield* startProviderDaemonServerOnEphemeralPort({
          host: "127.0.0.1",
          token: TEST_TOKEN,
          version: "0.0.0-test",
          onRuntimeEventJournaled: (event) => {
            if (event.eventId === asEventId("evt-timing-completed")) {
              signalCompletedEventJournaled();
            }
          },
        });

        const threadId = ThreadId.make("thread-timing");
        const turnId = TurnId.make("turn-timing");
        const base = {
          provider: ProviderDriverKind.make("codex"),
          threadId,
          turnId,
        } as const;

        releaseRuntimeEvents([
          {
            ...base,
            eventId: asEventId("evt-timing-accepted"),
            type: "task.progress",
            createdAt: "2026-01-01T00:00:00.000Z",
            payload: {
              taskId: RuntimeTaskId.make("codex-turn-start:turn-timing"),
              description: "Codex app-server accepted turn/start.",
              usage: {
                model: "gpt-5.3-codex",
                effort: "xhigh",
                promptByteLength: 42,
              },
            },
            raw: {
              source: "codex.app-server.notification",
              method: "codex.turnStart/accepted",
              payload: {},
            },
          },
          {
            ...base,
            eventId: asEventId("evt-timing-started"),
            type: "turn.started",
            createdAt: "2026-01-01T00:00:01.000Z",
            payload: {},
            raw: {
              source: "codex.app-server.notification",
              method: "turn/started",
              payload: {},
            },
          },
          {
            ...base,
            eventId: asEventId("evt-timing-retry"),
            type: "runtime.warning",
            createdAt: "2026-01-01T00:00:02.000Z",
            payload: {
              message: "Reconnecting... 5/5",
              detail: {
                willRetry: true,
                error: {
                  message: "Reconnecting... 5/5",
                  additionalDetails:
                    "stream disconnected before completion: websocket closed by server before response.completed",
                },
              },
            },
            raw: {
              source: "codex.app-server.notification",
              method: "error",
              payload: {},
            },
          },
          {
            ...base,
            eventId: asEventId("evt-timing-fallback"),
            type: "runtime.warning",
            createdAt: "2026-01-01T00:00:03.000Z",
            payload: {
              message: "Falling back from WebSockets to HTTPS transport.",
            },
            raw: {
              source: "codex.app-server.notification",
              method: "warning",
              payload: {},
            },
          },
          {
            ...base,
            eventId: asEventId("evt-timing-delta"),
            type: "content.delta",
            createdAt: "2026-01-01T00:00:05.000Z",
            payload: {
              streamKind: "assistant_text",
              delta: "yes",
            },
            raw: {
              source: "codex.app-server.notification",
              method: "item/agentMessage/delta",
              payload: {},
            },
          },
          {
            ...base,
            eventId: asEventId("evt-timing-delta-2"),
            type: "content.delta",
            createdAt: "2026-01-01T00:00:06.000Z",
            payload: {
              streamKind: "assistant_text",
              delta: " done",
            },
            raw: {
              source: "codex.app-server.notification",
              method: "item/agentMessage/delta",
              payload: {},
            },
          },
          {
            ...base,
            eventId: asEventId("evt-timing-completed"),
            type: "turn.completed",
            createdAt: "2026-01-01T00:00:07.000Z",
            payload: {
              state: "completed",
            },
            raw: {
              source: "codex.app-server.notification",
              method: "turn/completed",
              payload: {},
            },
          },
        ] satisfies ReadonlyArray<ProviderRuntimeEvent>);
        yield* Effect.promise(() => completedEventJournaled);

        const healthResponse = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
            headers: {
              authorization: `Bearer ${TEST_TOKEN}`,
            },
          }),
        );
        const health = decodeProviderDaemonHealth(
          yield* Effect.promise(() => healthResponse.json()),
        );
        const timing = health.runtimeEvents?.recentTurnTimings[0];

        assert.equal(timing?.threadId, "thread-timing");
        assert.equal(timing?.turnId, "turn-timing");
        assert.equal(timing?.acceptedToTurnStartedMs, 1000);
        assert.equal(timing?.acceptedToFirstAssistantDeltaMs, 5000);
        assert.equal(timing?.acceptedToTurnCompletedMs, 7000);
        assert.equal(timing?.lastAssistantDeltaAt, "2026-01-01T00:00:06.000Z");
        assert.equal(timing?.firstAssistantDeltaTextBytes, 3);
        assert.equal(timing?.assistantDeltaCount, 2);
        assert.equal(timing?.assistantDeltaTextBytes, 8);
        assert.equal(timing?.largestAssistantDeltaTextBytes, 5);
        assert.equal(timing?.maxAssistantDeltaGapMs, 1000);
        assert.equal(timing?.transportRetryCount, 1);
        assert.equal(timing?.responseStreamDisconnectedCount, 1);
        assert.equal(timing?.runtimeWarningCount, 2);
        assert.equal(timing?.httpFallbackAt, "2026-01-01T00:00:03.000Z");
        assert.equal(timing?.model, "gpt-5.3-codex");
        assert.equal(timing?.effort, "xhigh");
        assert.equal(timing?.inputByteLength, 42);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("keeps journaling runtime events after one malformed event", () =>
    Effect.gen(function* () {
      let releaseRuntimeEvents!: (events: ReadonlyArray<ProviderRuntimeEvent>) => void;
      const runtimeEvents = new Promise<ReadonlyArray<ProviderRuntimeEvent>>((resolve) => {
        releaseRuntimeEvents = resolve;
      });
      const streamingProviderServiceLayer = Layer.succeed(ProviderService, {
        ...mockProviderService,
        streamEvents: Stream.fromEffect(Effect.promise(() => runtimeEvents)).pipe(
          Stream.flatMap(Stream.fromIterable),
          Stream.concat(Stream.never),
        ),
      } satisfies ProviderServiceShape);
      const layer = Layer.mergeAll(
        streamingProviderServiceLayer,
        ProviderRuntimeInventoryLocalLive.pipe(Layer.provide(mockProviderAdapterRegistryLayer)),
        mockServerSettingsLayer,
        ProviderSupervisorRegistryLive,
      ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
      let signalValidEventJournaled!: () => void;
      const validEventJournaled = new Promise<void>((resolve) => {
        signalValidEventJournaled = resolve;
      });

      yield* Effect.gen(function* () {
        const port = yield* startProviderDaemonServerOnEphemeralPort({
          host: "127.0.0.1",
          token: TEST_TOKEN,
          version: "0.0.0-test",
          onRuntimeEventJournaled: (event) => {
            if (event.eventId === asEventId("evt-journal-after-malformed")) {
              signalValidEventJournaled();
            }
          },
        });

        // This intentionally invalid object models a provider protocol or
        // serialization edge case at the journal boundary. The daemon must log
        // and discard it without killing the long-lived event bridge; otherwise
        // later valid provider output never reaches the backend/UI projections.
        const malformedEvent = {
          type: "turn.completed",
          provider: ProviderDriverKind.make("codex"),
          threadId: ThreadId.make("thread-journal-resilience"),
          createdAt: "2026-01-01T00:00:00.000Z",
        } as unknown as ProviderRuntimeEvent;

        const validEvent: ProviderRuntimeEvent = {
          type: "turn.completed",
          eventId: asEventId("evt-journal-after-malformed"),
          provider: ProviderDriverKind.make("codex"),
          threadId: ThreadId.make("thread-journal-resilience"),
          turnId: TurnId.make("turn-journal-resilience"),
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: {
            state: "completed",
          },
        };
        releaseRuntimeEvents([malformedEvent, validEvent]);
        yield* Effect.promise(() => validEventJournaled);

        const healthResponse = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
            headers: {
              authorization: `Bearer ${TEST_TOKEN}`,
            },
          }),
        );
        const health = decodeProviderDaemonHealth(
          yield* Effect.promise(() => healthResponse.json()),
        );

        assert.isAtLeast(health.eventCursor, 1);
        assert.equal(
          health.runtimeEvents?.recentTurnTimings[0]?.threadId,
          "thread-journal-resilience",
        );
        assert.equal(health.runtimeEvents?.recentTurnTimings[0]?.turnId, "turn-journal-resilience");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
});
