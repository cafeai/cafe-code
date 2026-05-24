// @effect-diagnostics nodeBuiltinImport:off
import * as net from "node:net";

import {
  EventId,
  ProviderDaemonHealth,
  ProviderDaemonLeaseRequest,
  ProviderDaemonLeaseResponse,
  ProviderDaemonRpcRequest,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
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
} from "./ProviderDaemonServer.ts";
import { ProviderRuntimeInventoryLocalLive } from "./ProviderRuntimeInventory.ts";

const TEST_TOKEN = "provider-daemon-test-token-000000000000000000000000";

const decodeProviderDaemonHealth = Schema.decodeUnknownSync(ProviderDaemonHealth);
const encodeProviderDaemonLeaseRequestJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonLeaseRequest),
);
const decodeProviderDaemonLeaseResponseJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonLeaseResponse),
);
const encodeProviderDaemonRpcRequestJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonRpcRequest),
);

const asEventId = (value: string): EventId => EventId.make(value);

class AvailablePortError extends Data.TaggedError("AvailablePortError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

const getAvailablePort: Effect.Effect<number, AvailablePortError> = Effect.tryPromise({
  try: () =>
    new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          if (typeof address === "object" && address !== null) {
            resolve(address.port);
          } else {
            reject(
              new AvailablePortError({
                cause: "test port server did not bind to TCP",
              }),
            );
          }
        });
      });
    }),
  catch: (cause) => new AvailablePortError({ cause }),
});

const mockProviderService = {
  startSession: () => Effect.die("unexpected startSession"),
  sendTurn: () => Effect.die("unexpected sendTurn"),
  interruptTurn: () => Effect.die("unexpected interruptTurn"),
  respondToRequest: () => Effect.die("unexpected respondToRequest"),
  respondToUserInput: () => Effect.die("unexpected respondToUserInput"),
  stopSession: () => Effect.die("unexpected stopSession"),
  listSessions: () => Effect.succeed([]),
  getCapabilities: () => Effect.die("unexpected getCapabilities"),
  getInstanceInfo: () => Effect.die("unexpected getInstanceInfo"),
  rollbackConversation: () => Effect.die("unexpected rollbackConversation"),
  streamEvents: Stream.empty,
} satisfies ProviderServiceShape;

const mockProviderServiceLayer = Layer.succeed(ProviderService, mockProviderService);

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

const providerDaemonServerTestLayer = Layer.mergeAll(
  mockProviderServiceLayer,
  ProviderRuntimeInventoryLocalLive.pipe(Layer.provide(mockProviderAdapterRegistryLayer)),
  mockServerSettingsLayer,
  ProviderSupervisorRegistryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

describe("ProviderDaemonServer", () => {
  it.effect("rejects unauthenticated health requests and serves authorized health", () =>
    Effect.gen(function* () {
      const port = yield* getAvailablePort;
      yield* runProviderDaemonServer({
        host: "127.0.0.1",
        port,
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
    }).pipe(Effect.scoped, Effect.provide(providerDaemonServerTestLayer)),
  );

  it.effect("serves role-aware provider supervisor health", () =>
    Effect.gen(function* () {
      const port = yield* getAvailablePort;
      yield* runProviderDaemonServer({
        mode: "provider-supervisor",
        host: "127.0.0.1",
        port,
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
      const port = yield* getAvailablePort;
      yield* runProviderDaemonServer({
        host: "127.0.0.1",
        port,
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
      const port = yield* getAvailablePort;
      yield* runProviderDaemonServer({
        host: "127.0.0.1",
        port,
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
      const port = yield* getAvailablePort;
      yield* runProviderDaemonServer({
        host: "127.0.0.1",
        port,
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
      const port = yield* getAvailablePort;
      yield* runProviderDaemonServer({
        host: "127.0.0.1",
        port,
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
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const streamingProviderServiceLayer = Layer.succeed(ProviderService, {
        ...mockProviderService,
        streamEvents: Stream.fromPubSub(events),
      } satisfies ProviderServiceShape);
      const layer = Layer.mergeAll(
        streamingProviderServiceLayer,
        ProviderRuntimeInventoryLocalLive.pipe(Layer.provide(mockProviderAdapterRegistryLayer)),
        mockServerSettingsLayer,
        ProviderSupervisorRegistryLive,
      ).pipe(Layer.provideMerge(SqlitePersistenceMemory));

      yield* Effect.gen(function* () {
        const port = yield* getAvailablePort;
        yield* runProviderDaemonServer({
          host: "127.0.0.1",
          port,
          token: TEST_TOKEN,
          version: "0.0.0-test",
        });
        yield* Effect.yieldNow;

        const threadId = ThreadId.make("thread-timing");
        const turnId = TurnId.make("turn-timing");
        const base = {
          provider: ProviderDriverKind.make("codex"),
          threadId,
          turnId,
        } as const;

        yield* PubSub.publishAll(events, [
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
        yield* Effect.yieldNow;

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
});
