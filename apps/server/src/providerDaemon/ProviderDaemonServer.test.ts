import {
  EventId,
  PROVIDER_DAEMON_HEALTH_PATH,
  PROVIDER_DAEMON_LIVENESS_PATH,
  ProviderDaemonHealth,
  ProviderDaemonLeaseRequest,
  ProviderDaemonLeaseResponse,
  ProviderDaemonLiveness,
  ProviderDaemonRpcRequest,
  ProviderDaemonRpcEnvelope,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRuntimeId,
  type ProviderDaemonEventRecord,
  type ProviderRuntimeEvent,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { EventEmitter } from "node:events";
// Native transport fixture: retain actual loopback socket, request and close ownership qualification.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as http from "node:http";
import type { Socket } from "node:net";

import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterRewindOutcomeUnknownError,
} from "../provider/Errors.ts";
import { ProviderValidationError } from "../provider/Errors.ts";
import { SqlitePersistenceTest } from "../persistence/Sqlite.test.fixture.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderSupervisorRegistryLive } from "../providerSupervisor/ProviderSupervisorRegistry.ts";
import {
  captureProviderDaemonProcessDiagnostic,
  captureProviderDaemonProcessIdentity,
  handleProviderDaemonEventStream,
  runProviderDaemonServer,
  writeProviderDaemonStreamLine,
  type ProviderDaemonServerOptions,
  type ProviderDaemonProcessIdentityDependencies,
} from "./ProviderDaemonServer.ts";
import type { ProviderDaemonPersistentEventJournal } from "./EventJournal.ts";
import { ProviderRuntimeInventoryLocalLive } from "./ProviderRuntimeInventory.ts";
import {
  ProviderDaemonRpcResponseError,
  RemoteProviderServiceLive,
  requestProviderDaemonCapabilities,
} from "./RemoteProviderService.ts";
import { ServerConfig } from "../config.ts";
import {
  SCHEDULING_SESSION_DAEMON_PATH,
  installSchedulingSessionRuntime,
  type SchedulingSessionAuthority,
} from "../scheduledFollowups/sessionRuntime.ts";
import {
  VISUALIZATION_SESSION_DAEMON_PATH,
  installVisualizationSessionRuntime,
  type VisualizationSessionAuthority,
} from "../visualizations/sessionRuntime.ts";
import { VisualizationGenerationId } from "@cafecode/contracts/visualizations";
import * as McpAppOwner from "../mcpApps/owner.ts";
import { privateVisualizationDaemonRequestCount } from "../visualizations/privateDaemonBody.ts";
import { MCP_APP_JSON_MAX_TRANSPORT_BYTES } from "@cafecode/shared/mcpAppJson";
import { dataProfileIdentity } from "@cafecode/shared/dataProfileIdentity";

const decodeProviderJsonString = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const decodeErrorKeysJsonString = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Record(Schema.String, Schema.Unknown) })),
);
const encodeProviderJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

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

function makeDaemonRecord(cursor: number): ProviderDaemonEventRecord {
  return {
    cursor,
    emittedAt: "2026-08-27T00:00:00.000Z",
    event: {
      eventId: asEventId(`stream-event-${cursor}`),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId: ThreadId.make("thread-stream"),
      createdAt: "2026-08-27T00:00:00.000Z",
      type: "session.started",
      payload: { message: `event-${cursor}` },
    },
  };
}

const startProviderDaemonServerOnEphemeralPort = (
  options: Omit<ProviderDaemonServerOptions, "port">,
  identityDependencies: ProviderDaemonProcessIdentityDependencies = { platform: "linux" },
) =>
  // Default unit tests never launch an OS identity helper, including on Windows.
  // Windows authority tests below inject deterministic native observations.
  runProviderDaemonServer({ ...options, port: 0 }, identityDependencies).pipe(
    Effect.map((snapshot) => {
      if (snapshot.port === null) {
        throw new Error("Expected provider daemon test server to bind a TCP port.");
      }
      return snapshot.port;
    }),
  );

/**
 * The command qualification uses the real daemon, but does not qualify a
 * perpetual event subscription. Keep that unrelated native stream finite at a
 * test-owned facade, while forwarding control requests and responses without
 * decoding, rewriting or replacing the real authenticated RPC/health path.
 * Cleanup owns only this facade's recorded sockets and upstream requests.
 */
const makeFiniteRemoteControlFacade = (
  daemonPort: number,
  eventsRefused: Deferred.Deferred<void>,
) => {
  const sockets = new Set<Socket>();
  const upstreamRequests = new Set<http.ClientRequest>();
  let eventRequests = 0;
  return Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<http.Server>((resolve, reject) => {
          const facade = http.createServer((request, response) => {
            const refuse = () => {
              response.writeHead(401, { "content-type": "application/json", connection: "close" });
              response.end('{"error":"synthetic subscription unavailable"}');
            };
            if (request.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
              refuse();
              return;
            }
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (
              request.method === "GET" &&
              url.pathname === "/api/provider-daemon/events" &&
              url.search === "?after=0"
            ) {
              eventRequests += 1;
              // Observe the exact native finite response, not merely a scheduled
              // event fiber, before issuing any command assertions below.
              response.once("finish", () =>
                Effect.runSync(Deferred.succeed(eventsRefused, undefined)),
              );
              refuse();
              return;
            }
            const controlPath =
              (request.method === "GET" && request.url === "/api/provider-daemon/health") ||
              (request.method === "POST" && request.url === "/api/provider-daemon/rpc");
            if (!controlPath) {
              response.writeHead(404, { connection: "close" });
              response.end();
              return;
            }
            const upstream = http.request(
              {
                hostname: "127.0.0.1",
                port: daemonPort,
                method: request.method,
                path: request.url,
                headers: {
                  authorization: request.headers.authorization,
                  ...(request.headers["content-type"] !== undefined
                    ? { "content-type": request.headers["content-type"] }
                    : {}),
                  ...(request.headers["content-length"] !== undefined
                    ? { "content-length": request.headers["content-length"] }
                    : {}),
                },
              },
              (nativeResponse) => {
                response.writeHead(nativeResponse.statusCode ?? 502, {
                  ...(nativeResponse.headers["content-type"] !== undefined
                    ? { "content-type": nativeResponse.headers["content-type"] }
                    : {}),
                  connection: "close",
                });
                nativeResponse.once("error", () => response.destroy());
                response.once("close", () => {
                  if (!response.writableFinished) nativeResponse.destroy();
                });
                nativeResponse.pipe(response);
              },
            );
            upstreamRequests.add(upstream);
            upstream.once("close", () => upstreamRequests.delete(upstream));
            upstream.once("error", () => {
              if (response.headersSent) response.destroy();
              else {
                response.writeHead(502, { connection: "close" });
                response.end();
              }
            });
            request.once("aborted", () => upstream.destroy());
            response.once("close", () => {
              if (!response.writableFinished) upstream.destroy();
            });
            request.pipe(upstream);
          });
          facade.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
          });
          facade.once("error", reject);
          facade.listen(0, "127.0.0.1", () => {
            facade.off("error", reject);
            resolve(facade);
          });
        }),
    ),
    (facade) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            for (const request of upstreamRequests) request.destroy();
            for (const socket of sockets) socket.destroy();
            facade.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
  ).pipe(
    Effect.map((facade) => {
      const address = facade.address();
      if (address === null || typeof address === "string")
        throw Error("Expected scoped native facade port");
      return {
        endpoint: { httpBaseUrl: `http://127.0.0.1:${address.port}`, token: TEST_TOKEN },
        eventRequestCount: () => eventRequests,
      };
    }),
  );
};

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
      getModels: () => Effect.succeed([]),
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
  ).pipe(Layer.provideMerge(SqlitePersistenceTest));

const providerDaemonServerTestLayer = makeProviderDaemonServerTestLayer(mockProviderService);

describe("ProviderDaemonServer", () => {
  for (const profile of ["production", "debug", undefined] as const) {
    it.effect(
      `echoes only actual admitted ${profile ?? "legacy-unknown"} profile in native health and liveness`,
      () => {
        const profileLayer = Layer.effect(
          ServerConfig,
          Effect.gen(function* () {
            const config = yield* ServerConfig;
            const { dataProfile: _previousProfile, ...legacy } = config;
            return { ...legacy, ...(profile === undefined ? {} : { dataProfile: profile }) };
          }),
        ).pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "cafe-native-profile-receipt-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        return Effect.gen(function* () {
          const config = yield* ServerConfig;
          const port = yield* startProviderDaemonServerOnEphemeralPort({
            host: "127.0.0.1",
            token: TEST_TOKEN,
            version: "0.0.0-test",
            protocolVersion: 1,
          });
          for (const route of [PROVIDER_DAEMON_HEALTH_PATH, PROVIDER_DAEMON_LIVENESS_PATH]) {
            const unauthenticated = yield* Effect.promise(() =>
              fetch(`http://127.0.0.1:${port}${route}`),
            );
            assert.equal(unauthenticated.status, 401);
            const response = yield* Effect.promise(() =>
              fetch(`http://127.0.0.1:${port}${route}`, {
                headers: { authorization: `Bearer ${TEST_TOKEN}` },
              }),
            );
            const text = yield* Effect.promise(() => response.text());
            const receipt = decodeProviderJsonString(text) as Record<string, unknown>;
            assert.equal(response.status, 200);
            assert.equal(receipt.dataProfile, profile);
            assert.equal(
              receipt.dataProfileId,
              profile === undefined ? undefined : dataProfileIdentity(profile, config.baseDir),
            );
            assert.notInclude(text, config.baseDir);
            assert.notInclude(text, TEST_TOKEN);
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(Layer.merge(providerDaemonServerTestLayer, profileLayer)),
        );
      },
    );
  }

  it.effect(
    "carries only exact pre-retirement refusals through a real authenticated cold-send RPC",
    () => {
      const account = ProviderInstanceId.make("codex");
      const threadId = ThreadId.make("synthetic-cold-retirement-thread");
      const privateExtra = "private-retirement-payload-must-not-enter-rpc";
      const coldInput = {
        threadId,
        input: "Continue preserved work.",
        expectedFailedRoot: {
          turnId: TurnId.make("synthetic-cold-retirement-turn"),
          providerThreadId: "synthetic-private-native-history",
          subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000211"),
          providerInstanceId: account,
          observedAt: "2026-10-19T01:00:00.000Z",
          restartSession: true as const,
        },
      };
      let getterReads = 0;
      let proxyReads = 0;
      const requestError = (options?: { provider?: string; method?: string; reason?: unknown }) => {
        const error = Object.assign(
          new ProviderAdapterRequestError({
            provider: options?.provider ?? "codex",
            method: options?.method ?? "turn/start",
            detail: "The failed Codex root changed before retirement.",
          }),
          { privateProviderPayload: { content: privateExtra } },
        );
        // Preserve a real typed producer while exercising the mapper's own-data
        // finite-value checks, rather than failing in the schema constructor.
        if (options?.reason !== undefined)
          Object.defineProperty(error, "failedRootRetirementRefusal", {
            value: options.reason,
            configurable: true,
          });
        return error;
      };
      const cases = [
        {
          name: "definite",
          error: () => requestError({ reason: "notifications-pending" }),
          expected: "notifications-pending",
        },
        {
          name: "unknown-reason",
          error: () => requestError({ reason: "unrecognized-native-reason" }),
        },
        {
          name: "other-provider",
          error: () => requestError({ provider: "claudeAgent", reason: "notifications-pending" }),
        },
        {
          name: "other-native-method",
          error: () => requestError({ method: "turn/steer", reason: "notifications-pending" }),
        },
        { name: "prose-only", error: () => requestError() },
        {
          name: "tag-only",
          error: () => Object.assign(requestError(), { remoteErrorTag: "notifications-pending" }),
        },
        {
          name: "other-error-class",
          error: () =>
            Object.assign(
              new ProviderValidationError({ operation: "Synthetic.send", issue: "Fixed refusal." }),
              {
                provider: "codex",
                method: "turn/start",
                failedRootRetirementRefusal: "notifications-pending",
              },
            ),
        },
        {
          name: "accessor-reason",
          error: () =>
            Object.defineProperty(requestError(), "failedRootRetirementRefusal", {
              get: () => {
                getterReads += 1;
                return "notifications-pending";
              },
            }),
        },
        {
          name: "inherited-reason",
          error: () => {
            const error = requestError();
            Object.setPrototypeOf(
              error,
              Object.create(Object.getPrototypeOf(error), {
                failedRootRetirementRefusal: { value: "notifications-pending" },
              }),
            );
            return error;
          },
        },
        {
          name: "proxy-reason",
          error: () =>
            new Proxy(requestError({ reason: "notifications-pending" }), {
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
            }),
        },
        {
          name: "revoked-proxy",
          error: () => {
            const pair = Proxy.revocable(requestError({ reason: "notifications-pending" }), {});
            pair.revoke();
            return pair.proxy;
          },
        },
      ] as const;
      let current = 0;
      let sendCalls = 0;
      let startCalls = 0;
      let stopCalls = 0;
      const capabilityOwners: ProviderInstanceId[] = [];
      const providerService: ProviderServiceShape = {
        ...mockProviderService,
        sendTurn: () =>
          Effect.suspend(() => {
            sendCalls += 1;
            return Effect.fail(cases[current]!.error());
          }),
        startSession: () =>
          Effect.suspend(() => {
            startCalls += 1;
            return Effect.fail(requestError({ reason: "notifications-pending" }));
          }),
        stopSession: () =>
          Effect.sync(() => {
            stopCalls += 1;
          }),
        getCapabilities: (instanceId) =>
          Effect.sync(() => {
            capabilityOwners.push(instanceId);
            return {
              sessionModelSwitch: "in-session" as const,
              liveSteer: "supported" as const,
              codexFailedRootRestart: true,
            };
          }),
      };
      return Effect.gen(function* () {
        const port = yield* startProviderDaemonServerOnEphemeralPort({
          host: "127.0.0.1",
          token: TEST_TOKEN,
          version: "0.0.0-test",
        });
        yield* Effect.gen(function* () {
          const eventsRefused = yield* Deferred.make<void>();
          const facade = yield* makeFiniteRemoteControlFacade(port, eventsRefused);
          const remoteConfigLayer = Layer.effect(
            ServerConfig,
            Effect.gen(function* () {
              const config = yield* ServerConfig;
              return { ...config, providerDaemon: facade.endpoint };
            }),
          ).pipe(
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "cafe-retirement-refusal-rpc-",
              }).pipe(Layer.provide(NodeServices.layer)),
            ),
          );
          const remoteLayer = RemoteProviderServiceLive.pipe(Layer.provide(remoteConfigLayer));
          yield* Effect.gen(function* () {
            const remote = yield* ProviderService;
            yield* Deferred.await(eventsRefused);
            for (current = 0; current < cases.length; current += 1) {
              const testCase = cases[current]!;
              const result = yield* remote.sendTurn(coldInput).pipe(Effect.flip);
              assert.instanceOf(result, ProviderAdapterRequestError);
              // This fixture requires the exact local error class; structural lookalikes must not satisfy its provenance assertion.
              // @effect-diagnostics-next-line instanceOfSchema:off
              if (!(result instanceof ProviderAdapterRequestError))
                return yield* Effect.die("Expected typed remote refusal");
              assert.equal(result.method, "sendTurn");
              assert.equal(
                result.failedRootRetirementRefusal,
                "expected" in testCase ? testCase.expected : undefined,
              );
              assert.instanceOf(result.cause, ProviderDaemonRpcResponseError);
              if (!(result.cause instanceof ProviderDaemonRpcResponseError))
                return yield* Effect.die("Expected actual decoded RPC response");
              assert.equal(
                result.cause.failedRootRetirementRefusal,
                "expected" in testCase ? testCase.expected : undefined,
              );
              assert.notInclude(encodeProviderJsonString(result.cause), privateExtra);
              assert.equal(sendCalls, current + 1);
              assert.equal(stopCalls, 0);
              if ("expected" in testCase) {
                // Observe this exact receipt before unrelated later failures can
                // legitimately evict it from the existing bounded health tail.
                const healthResponse = yield* Effect.promise(() =>
                  fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
                    headers: { authorization: `Bearer ${TEST_TOKEN}` },
                  }),
                );
                assert.equal(healthResponse.status, 200);
                const rawHealth = yield* Effect.promise(() => healthResponse.text());
                assert.notInclude(rawHealth, privateExtra);
                const health = decodeProviderDaemonHealth(decodeProviderJsonString(rawHealth));
                assert.isTrue(
                  health.rpc?.recentFailures?.some(
                    (failure) =>
                      failure.method === "sendTurn" &&
                      failure.failedRootRetirementRefusal === testCase.expected,
                  ),
                );
                assert.isTrue(
                  health.recentFailedCommands?.some(
                    (failure) =>
                      failure.method === "sendTurn" &&
                      failure.failedRootRetirementRefusal === testCase.expected,
                  ),
                );
              }
            }
            // A definite producer error cannot lend its witness to another RPC
            // or an ordinary same-account send without cold-recovery identity.
            const start = yield* remote
              .startSession(threadId, {
                threadId,
                provider: ProviderDriverKind.make("codex"),
                providerInstanceId: account,
                runtimeMode: "full-access",
              })
              .pipe(Effect.flip);
            assert.instanceOf(start, ProviderAdapterRequestError);
            // This fixture requires the exact local error class; structural lookalikes must not satisfy its provenance assertion.
            // @effect-diagnostics-next-line instanceOfSchema:off
            if (start instanceof ProviderAdapterRequestError)
              assert.equal(start.failedRootRetirementRefusal, undefined);
            current = 0;
            const ordinary = yield* remote
              .sendTurn({ threadId, input: coldInput.input })
              .pipe(Effect.flip);
            assert.instanceOf(ordinary, ProviderAdapterRequestError);
            // This fixture requires the exact local error class; structural lookalikes must not satisfy its provenance assertion.
            // @effect-diagnostics-next-line instanceOfSchema:off
            if (ordinary instanceof ProviderAdapterRequestError)
              assert.equal(ordinary.failedRootRetirementRefusal, undefined);
          }).pipe(Effect.provide(remoteLayer), Effect.scoped);
          assert.deepEqual(capabilityOwners, Array(cases.length).fill(account));
          assert.equal(sendCalls, cases.length + 1);
          assert.equal(startCalls, 1);
          assert.equal(stopCalls, 0);
          assert.equal(getterReads, 0);
          assert.equal(proxyReads, 0);
          assert.equal(facade.eventRequestCount(), 1);
        }).pipe(Effect.scoped);
        // Bypass only the remote capability guard with a direct synthetic RPC to
        // qualify the daemon's independent completeness fence. These requests
        // still pass real authentication, schema decoding and the command ledger.
        for (const [index, expectedFailedRoot] of [
          { ...coldInput.expectedFailedRoot, observedAt: undefined },
          { ...coldInput.expectedFailedRoot, providerInstanceId: undefined },
          { ...coldInput.expectedFailedRoot, restartSession: undefined },
        ].entries()) {
          const response = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${port}/api/provider-daemon/rpc`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${TEST_TOKEN}`,
                "content-type": "application/json",
              },
              body: encodeProviderDaemonRpcRequestJson({
                method: "sendTurn",
                commandId: `incomplete-cold-refusal-${index}`,
                payload: { ...coldInput, expectedFailedRoot },
              }),
            }),
          );
          assert.equal(response.status, 400);
          const envelope = decodeProviderDaemonRpcEnvelopeJson(
            yield* Effect.promise(() => response.text()),
          );
          assert.isFalse(envelope.ok);
          if (!envelope.ok) assert.equal(envelope.error.failedRootRetirementRefusal, undefined);
        }
        const healthResponse = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
            headers: { authorization: `Bearer ${TEST_TOKEN}` },
          }),
        );
        assert.equal(healthResponse.status, 200);
        const rawHealth = yield* Effect.promise(() => healthResponse.text());
        assert.notInclude(rawHealth, privateExtra);
        const health = decodeProviderDaemonHealth(decodeProviderJsonString(rawHealth));
        assert.equal(health.rpc?.failedRpcCount, cases.length + 5);
        assert.equal(sendCalls, cases.length + 4);
        assert.equal(startCalls, 1);
        assert.equal(stopCalls, 0);
      }).pipe(Effect.scoped, Effect.provide(makeProviderDaemonServerTestLayer(providerService)));
    },
  );

  it.effect(
    "carries only exact native reconfiguration refusals through the guarded remote start transport",
    () => {
      const account = ProviderInstanceId.make("codex");
      const threadId = ThreadId.make("synthetic-retained-policy-thread");
      const privateExtra = "private-provider-payload-must-not-enter-rpc";
      let getterReads = 0;
      const requestError = (input?: { provider?: string; method?: string; tag?: string }) =>
        Object.assign(
          new ProviderAdapterRequestError({
            provider: input?.provider ?? "codex",
            method: input?.method ?? "session/reconfigure",
            detail:
              "Provider configuration cannot change while provider work is active or uncertain.",
            ...(input?.tag !== undefined ? { remoteErrorTag: input.tag } : {}),
          }),
          { privateProviderPayload: { content: privateExtra } },
        );
      const cases = [
        {
          name: "subagent",
          error: () => requestError({ tag: "subagent-concurrency-active" }),
          expected: "subagent-concurrency-active",
          outer: "ProviderAdapterRequestError",
        },
        {
          name: "context",
          error: () => requestError({ tag: "codex-context-window-active" }),
          expected: "codex-context-window-active",
          outer: "ProviderAdapterRequestError",
        },
        {
          name: "unknown-tag",
          error: () => requestError({ tag: "unrecognized-native-refusal" }),
          outer: "ProviderAdapterRequestError",
        },
        {
          name: "other-provider",
          error: () =>
            requestError({ provider: "claudeAgent", tag: "subagent-concurrency-active" }),
          outer: "ProviderAdapterRequestError",
        },
        {
          name: "other-native-method",
          error: () => requestError({ method: "turn/start", tag: "codex-context-window-active" }),
          outer: "ProviderAdapterRequestError",
        },
        {
          name: "message-only",
          // The exact refusal prose is insufficient without typed provenance.
          error: () => requestError(),
          outer: "ProviderAdapterRequestError",
        },
        {
          name: "other-error-class",
          error: () =>
            Object.assign(
              new ProviderValidationError({
                operation: "Synthetic.start",
                issue: "Synthetic refusal",
              }),
              {
                provider: "codex",
                method: "session/reconfigure",
                remoteErrorTag: "codex-context-window-active",
              },
            ),
          outer: "ProviderValidationError",
        },
        {
          name: "accessor-tag",
          error: () =>
            Object.defineProperty(requestError(), "remoteErrorTag", {
              get: () => {
                getterReads += 1;
                return "codex-context-window-active";
              },
            }),
          outer: "ProviderAdapterRequestError",
        },
        {
          name: "inherited-tag",
          error: () => {
            const error = requestError();
            const prototype = Object.create(Object.getPrototypeOf(error));
            Object.defineProperty(prototype, "remoteErrorTag", {
              value: "codex-context-window-active",
            });
            Object.setPrototypeOf(error, prototype);
            return error;
          },
          outer: "ProviderAdapterRequestError",
        },
      ] as const;
      let current = 0;
      let startCalls = 0;
      let sendCalls = 0;
      let stopCalls = 0;
      const capabilityOwners: ProviderInstanceId[] = [];
      const providerService: ProviderServiceShape = {
        ...mockProviderService,
        startSession: () =>
          Effect.suspend(() => {
            startCalls += 1;
            return Effect.fail(cases[current]!.error());
          }),
        getCapabilities: (instanceId) =>
          Effect.sync(() => {
            capabilityOwners.push(instanceId);
            return {
              sessionModelSwitch: "in-session" as const,
              liveSteer: "supported" as const,
              codexContextWindow: true,
              codexContextCompaction: true,
              subagentConcurrency: true,
            };
          }),
        sendTurn: () =>
          Effect.sync(() => {
            sendCalls += 1;
          }).pipe(Effect.andThen(Effect.die("A refused start must never submit provider input"))),
        stopSession: () =>
          Effect.sync(() => {
            stopCalls += 1;
          }),
      };
      return Effect.gen(function* () {
        const port = yield* startProviderDaemonServerOnEphemeralPort({
          host: "127.0.0.1",
          token: TEST_TOKEN,
          version: "0.0.0-test",
        });
        yield* Effect.gen(function* () {
          const eventsRefused = yield* Deferred.make<void>();
          const facade = yield* makeFiniteRemoteControlFacade(port, eventsRefused);
          const endpoint = facade.endpoint;
          // The remote service's real guards and codec run within the isolated
          // daemon scope. Its native peer is this finite fake service; configuration
          // files are scoped test-owned temporaries, never a profile or provider.
          const remoteConfigLayer = Layer.effect(
            ServerConfig,
            Effect.gen(function* () {
              const config = yield* ServerConfig;
              return { ...config, providerDaemon: endpoint };
            }),
          ).pipe(
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), { prefix: "cafe-session-refusal-rpc-" }).pipe(
                Layer.provide(NodeServices.layer),
              ),
            ),
          );
          const remoteLayer = RemoteProviderServiceLive.pipe(Layer.provide(remoteConfigLayer));
          yield* Effect.gen(function* () {
            const remote = yield* ProviderService;
            yield* Deferred.await(eventsRefused);
            for (current = 0; current < cases.length; current += 1) {
              const testCase = cases[current]!;
              const result = yield* remote
                .startSession(threadId, {
                  threadId,
                  provider: ProviderDriverKind.make("codex"),
                  providerInstanceId: account,
                  runtimeMode: "full-access",
                  ...(testCase.name === "subagent"
                    ? { maxConcurrentSubagents: 9, requireIdleForSubagentLimitChange: true }
                    : {
                        codexContextWindowOverride: null,
                        requireIdleForCodexContextWindowChange: true,
                      }),
                })
                .pipe(Effect.flip);
              assert.instanceOf(result, ProviderAdapterRequestError);
              // This fixture requires the exact local error class; structural lookalikes must not satisfy its provenance assertion.
              // @effect-diagnostics-next-line instanceOfSchema:off
              if (!(result instanceof ProviderAdapterRequestError)) {
                return yield* Effect.die("Expected reconstructed typed remote refusal");
              }
              assert.equal(result.method, "startSession");
              assert.equal(
                result.remoteErrorTag,
                "expected" in testCase ? testCase.expected : testCase.outer,
              );
              assert.instanceOf(result.cause, ProviderDaemonRpcResponseError);
              if (!(result.cause instanceof ProviderDaemonRpcResponseError)) {
                return yield* Effect.die("Expected actual RPC envelope reconstruction");
              }
              assert.equal(result.cause.remoteErrorTag, testCase.outer);
              assert.equal(
                result.cause.sessionReconfigurationRefusal,
                "expected" in testCase ? testCase.expected : undefined,
              );
              assert.notInclude(encodeProviderJsonString(result.cause), privateExtra);
              assert.equal(startCalls, current + 1);
              assert.equal(sendCalls, 0);
              assert.equal(stopCalls, 0);
            }
          }).pipe(
            // Finish this scoped client's bridge fibers and provided layer before
            // the facade closes, then let the outer real daemon close. Its native
            // subscription already ended with the witnessed finite 401; this is
            // not evidence that production cancels a perpetual HTTP stream.
            // No caller-inherited fiber or global transport cleanup is assumed.
            Effect.provide(remoteLayer),
            Effect.scoped,
          );
          assert.deepEqual(capabilityOwners, Array(cases.length - 1).fill(account));
          assert.equal(getterReads, 0);
          assert.equal(startCalls, cases.length);
          assert.equal(sendCalls, 0);
          assert.equal(stopCalls, 0);
          assert.equal(facade.eventRequestCount(), 1);
        }).pipe(Effect.scoped);
      }).pipe(Effect.scoped, Effect.provide(makeProviderDaemonServerTestLayer(providerService)));
    },
  );

  it.effect("publishes only the finite refusal field without copying private native extras", () => {
    const privateExtra = "private-native-extra-must-not-enter-envelope";
    let calls = 0;
    const providerService: ProviderServiceShape = {
      ...mockProviderService,
      startSession: () =>
        Effect.sync(() => {
          calls += 1;
        }).pipe(
          Effect.andThen(
            Effect.fail(
              Object.assign(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "session/reconfigure",
                  remoteErrorTag: "subagent-concurrency-active",
                  detail: "Synthetic whole-tree admission refused",
                }),
                { nativePayload: { prompt: privateExtra }, providerSpecificRefusal: privateExtra },
              ),
            ),
          ),
        ),
    };
    return Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
      });
      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/rpc`, {
          method: "POST",
          headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
          body: encodeProviderDaemonRpcRequestJson({
            method: "startSession",
            commandId: "synthetic-reconfiguration-envelope-only",
            payload: {
              threadId: ThreadId.make("finite-refusal-thread"),
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
            },
          }),
        }),
      );
      assert.equal(response.status, 400);
      const raw = yield* Effect.promise(() => response.text());
      assert.notInclude(raw, privateExtra);
      const envelope = decodeProviderDaemonRpcEnvelopeJson(raw);
      assert.isFalse(envelope.ok);
      if (envelope.ok) return yield* Effect.die("Expected finite failed RPC envelope");
      assert.equal(envelope.error.tag, "ProviderAdapterRequestError");
      assert.equal(envelope.error.sessionReconfigurationRefusal, "subagent-concurrency-active");
      assert.deepEqual(Object.keys(decodeErrorKeysJsonString(raw).error).sort(), [
        "diagnostics",
        "message",
        "sessionReconfigurationRefusal",
        "tag",
      ]);
      const healthResponse = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/api/provider-daemon/health`, {
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        }),
      );
      assert.equal(healthResponse.status, 200);
      const health = decodeProviderDaemonHealth(yield* Effect.promise(() => healthResponse.json()));
      assert.equal(
        health.rpc?.recentFailures?.[0]?.sessionReconfigurationRefusal,
        "subagent-concurrency-active",
      );
      assert.equal(health.rpc?.recentFailures?.[0]?.tag, "ProviderAdapterRequestError");
      assert.equal(calls, 1);
    }).pipe(Effect.scoped, Effect.provide(makeProviderDaemonServerTestLayer(providerService)));
  });

  it.effect(
    "preserves exact-instance concurrency capability through authenticated remote RPC",
    () => {
      const requestedInstances: ProviderInstanceId[] = [];
      const supported = ProviderInstanceId.make("codex-qualified-account");
      const unsupported = ProviderInstanceId.make("claude-unsupported-account");
      const legacy = ProviderInstanceId.make("legacy-account");
      const malformed = ProviderInstanceId.make("malformed-account");
      const malformedContext = ProviderInstanceId.make("malformed-context-account");
      const malformedCompaction = ProviderInstanceId.make("malformed-compaction-account");
      const otherCapabilities = {
        sessionModelSwitch: "restart-resume",
        liveSteer: "unsupported",
        manualCompaction: "supported",
        threadGoals: "unsupported",
        sessionFork: "supported",
      } as const;
      const providerService: ProviderServiceShape = {
        ...mockProviderService,
        getCapabilities: (instanceId) =>
          Effect.sync(() => {
            requestedInstances.push(instanceId);
            if (instanceId === supported)
              return {
                ...otherCapabilities,
                subagentConcurrency: true,
                codexContextWindow: true,
                codexContextCompaction: true,
              };
            if (instanceId === unsupported)
              return {
                ...otherCapabilities,
                subagentConcurrency: false,
                codexContextWindow: false,
                codexContextCompaction: false,
              };
            if (instanceId === legacy) return otherCapabilities;
            if (instanceId === malformed) {
              // Deliberately malformed synthetic wire data must fail decoding,
              // never become truthy support or silently turn into omission.
              return { ...otherCapabilities, subagentConcurrency: "true" as unknown as boolean };
            }
            if (instanceId === malformedContext)
              return {
                ...otherCapabilities,
                subagentConcurrency: true,
                codexContextWindow: "true" as unknown as boolean,
              };
            if (instanceId === malformedCompaction)
              return {
                ...otherCapabilities,
                codexContextWindow: true,
                codexContextCompaction: "true" as unknown as boolean,
              };
            throw new Error("Unexpected synthetic provider instance");
          }),
      };
      return Effect.gen(function* () {
        const port = yield* startProviderDaemonServerOnEphemeralPort({
          host: "127.0.0.1",
          token: TEST_TOKEN,
          version: "0.0.0-test",
          protocolVersion: 1,
        });
        const denied = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${port}/api/provider-daemon/rpc`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: encodeProviderDaemonRpcRequestJson({
              method: "getCapabilities",
              payload: { instanceId: supported },
            }),
          }),
        );
        assert.equal(denied.status, 401);
        assert.deepEqual(requestedInstances, []);
        // Exercise the actual finite request used by remote getCapabilities,
        // including both method-result and adapter-capability decoding, rather
        // than a test-local replacement. Its only peer is this scoped synthetic
        // daemon; there is no perpetual event bridge, provider/profile, prompt,
        // provider process or process-reaping assumption in this default test.
        const endpoint = { httpBaseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN };
        const unauthorized = yield* requestProviderDaemonCapabilities(
          { ...endpoint, token: "invalid-synthetic-capability" },
          supported,
        ).pipe(Effect.flip);
        assert.instanceOf(unauthorized, ProviderAdapterRequestError);
        assert.equal(unauthorized.remoteErrorTag, "ProviderDaemonAuthenticationError");
        assert.deepEqual(requestedInstances, []);
        assert.deepEqual(yield* requestProviderDaemonCapabilities(endpoint, supported), {
          ...otherCapabilities,
          subagentConcurrency: true,
          codexContextWindow: true,
          codexContextCompaction: true,
        });
        assert.deepEqual(yield* requestProviderDaemonCapabilities(endpoint, unsupported), {
          ...otherCapabilities,
          subagentConcurrency: false,
          codexContextWindow: false,
          codexContextCompaction: false,
        });
        const oldCapabilities = yield* requestProviderDaemonCapabilities(endpoint, legacy);
        assert.deepEqual(oldCapabilities, otherCapabilities);
        assert.equal(oldCapabilities.subagentConcurrency, undefined);
        assert.equal(oldCapabilities.codexContextWindow, undefined);
        assert.equal(oldCapabilities.codexContextCompaction, undefined);
        const invalid = yield* requestProviderDaemonCapabilities(endpoint, malformed).pipe(
          Effect.flip,
        );
        assert.instanceOf(invalid, ProviderAdapterRequestError);
        assert.equal(invalid.method, "getCapabilities");
        const invalidContext = yield* requestProviderDaemonCapabilities(
          endpoint,
          malformedContext,
        ).pipe(Effect.flip);
        assert.instanceOf(invalidContext, ProviderAdapterRequestError);
        assert.equal(invalidContext.method, "getCapabilities");
        const invalidCompaction = yield* requestProviderDaemonCapabilities(
          endpoint,
          malformedCompaction,
        ).pipe(Effect.flip);
        assert.instanceOf(invalidCompaction, ProviderAdapterRequestError);
        assert.equal(invalidCompaction.method, "getCapabilities");
        assert.deepEqual(requestedInstances, [
          supported,
          unsupported,
          legacy,
          malformed,
          malformedContext,
          malformedCompaction,
        ]);
        const sql = yield* SqlClient.SqlClient;
        const ledger = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM provider_daemon_commands`;
        assert.equal(ledger[0]?.count, 0);
      }).pipe(Effect.scoped, Effect.provide(makeProviderDaemonServerTestLayer(providerService)));
    },
  );

  it.effect(
    "bounds the two private visualization lanes without changing scheduling or liveness",
    () =>
      Effect.gen(function* () {
        const token = "ab".repeat(32);
        const generation = VisualizationGenerationId.make("11111111-1111-4111-8111-111111111111");
        const authority: VisualizationSessionAuthority = {
          threadId: ThreadId.make("visualization-private-daemon-fixture"),
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          sessionGeneration: generation,
          runtimeGeneration: generation,
          tokenDigest: "cd".repeat(32),
          serverName: `cafe-visualizations-${"a".repeat(22)}`,
        };
        let calls = 0;
        const uninstall = installVisualizationSessionRuntime({
          bind: async () => undefined,
          close: async () => {},
          authorize: async (candidate) => {
            calls++;
            if (candidate !== token) throw new Error("PRIVATE AUTH ERROR");
            return authority;
          },
        });
        yield* Effect.addFinalizer(() => Effect.sync(uninstall));
        const port = yield* startProviderDaemonServerOnEphemeralPort({
          host: "127.0.0.1",
          token: TEST_TOKEN,
          version: "0.0.0-test",
          protocolVersion: 1,
        });
        const request = (endpoint: string, body: Uint8Array | string) =>
          Effect.promise(() =>
            fetch(`http://127.0.0.1:${port}${endpoint}`, {
              method: "POST",
              headers: { authorization: `Bearer ${TEST_TOKEN}` },
              body,
            }),
          );
        for (const endpoint of [
          VISUALIZATION_SESSION_DAEMON_PATH,
          McpAppOwner.MCP_APP_OWNER_PATH,
        ]) {
          for (const body of [
            Buffer.from([0xff]),
            '{"source":"PRIVATE PARSER MARKER"',
            "[".repeat(25) + "0" + "]".repeat(25),
          ]) {
            const rejected = yield* request(endpoint, body);
            assert.equal(rejected.status, 403);
            const error = yield* Effect.promise(() => rejected.text());
            assert.equal(error.includes("PRIVATE"), false);
            assert.equal(rejected.headers.get("connection"), "close");
          }
        }
        const tooLarge = yield* request(VISUALIZATION_SESSION_DAEMON_PATH, "x".repeat(1025));
        assert.equal(tooLarge.status, 403);
        yield* Effect.promise(() => tooLarge.arrayBuffer());
        assert.equal(calls, 0);
        const held: http.ClientRequest[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const pending of held) pending.destroy();
          }),
        );
        for (const endpoint of [
          McpAppOwner.MCP_APP_OWNER_PATH,
          VISUALIZATION_SESSION_DAEMON_PATH,
          McpAppOwner.MCP_APP_OWNER_PATH,
          VISUALIZATION_SESSION_DAEMON_PATH,
        ]) {
          const pending = http.request(`http://127.0.0.1:${port}${endpoint}`, {
            method: "POST",
            headers: { authorization: `Bearer ${TEST_TOKEN}`, "transfer-encoding": "chunked" },
          });
          // Only a scoped synthetic body is held open; no provider or daemon
          // process is started. Swallow client cancellation after our teardown.
          pending.on("error", () => {});
          held.push(pending);
          pending.write("{");
        }
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.equal(privateVisualizationDaemonRequestCount(), 4)),
        );
        const busy = yield* Effect.promise(
          () =>
            new Promise<{ status: number | undefined; json: unknown }>((resolve, reject) => {
              const pending = http.request(
                `http://127.0.0.1:${port}${VISUALIZATION_SESSION_DAEMON_PATH}`,
                {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${TEST_TOKEN}`,
                    "transfer-encoding": "chunked",
                  },
                },
                (response) => {
                  const chunks: Buffer[] = [];
                  response.on("data", (chunk: Buffer) => chunks.push(chunk));
                  response.once("error", reject);
                  response.once("end", () => {
                    try {
                      resolve({
                        status: response.statusCode,
                        json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                      });
                    } catch (error) {
                      reject(error);
                    } finally {
                      pending.destroy();
                    }
                  });
                },
              );
              pending.once("error", reject);
              held.push(pending);
              // Deliberately do not end this body: a saturated lane must reply
              // and close before reading/waiting on another slow producer.
              pending.write("{");
            }),
        );
        assert.equal(busy.status, 503);
        assert.deepEqual(busy.json, {
          error: "Visualization session is unavailable.",
        });
        assert.equal(calls, 0);
        const liveness = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${port}${PROVIDER_DAEMON_LIVENESS_PATH}`, {
            headers: { authorization: `Bearer ${TEST_TOKEN}` },
          }),
        );
        assert.equal(liveness.status, 200);
        yield* Effect.promise(() => liveness.arrayBuffer());
        const scheduling = yield* request(SCHEDULING_SESSION_DAEMON_PATH, "{}");
        assert.equal(scheduling.status, 403);
        yield* Effect.promise(() => scheduling.arrayBuffer());
        for (const pending of held) pending.destroy();
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.equal(privateVisualizationDaemonRequestCount(), 0)),
        );
        const accepted = yield* request(
          VISUALIZATION_SESSION_DAEMON_PATH,
          encodeProviderJsonString({ token }),
        );
        assert.equal(accepted.status, 200);
        assert.deepEqual(yield* Effect.promise(() => accepted.json()), authority);
        assert.equal(calls, 1);
        const sql = yield* SqlClient.SqlClient;
        const ledger = yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM provider_daemon_commands`;
        assert.equal(ledger[0]?.count, 0);
      }).pipe(Effect.scoped, Effect.provide(providerDaemonServerTestLayer)),
  );

  it.effect(
    "admits the separately bounded escaped App transport without enlarging native JSON",
    () =>
      Effect.gen(function* () {
        const requestJson = encodeProviderJsonString({
          name: "quote-fixture",
          arguments: { text: '"'.repeat(50_000) },
        });
        const resultJson = encodeProviderJsonString({
          content: [{ type: "text", text: '"'.repeat(50_000) }],
        });
        const input = {
          threadId: "app-transport-fixture",
          providerInstanceId: "codex_fixture",
          sessionGeneration: "11111111-1111-4111-8111-111111111111",
          nativeThreadId: "native-transport-fixture",
          serverName: "fixture-server",
          originCallId: "fixture-call",
          method: "tool" as const,
          requestJson,
        };
        // Mock only the authenticated native dispatch boundary. This proves
        // real HTTP admission without any native provider/session/profile.
        const dispatch = vi
          .spyOn(McpAppOwner, "dispatchMcpAppOwnerOperation")
          .mockImplementation(async (received) => {
            assert.deepEqual(received, input);
            return resultJson;
          });
        yield* Effect.addFinalizer(() => Effect.sync(() => dispatch.mockRestore()));
        const port = yield* startProviderDaemonServerOnEphemeralPort({
          host: "127.0.0.1",
          token: TEST_TOKEN,
          version: "0.0.0-test",
          protocolVersion: 1,
        });
        const body = encodeProviderJsonString(input);
        assert.equal(Buffer.byteLength(requestJson, "utf8") < 128 * 1024, true);
        assert.equal(Buffer.byteLength(resultJson, "utf8") < 128 * 1024, true);
        assert.equal(Buffer.byteLength(body, "utf8") > 128 * 1024, true);
        assert.equal(Buffer.byteLength(body, "utf8") < MCP_APP_JSON_MAX_TRANSPORT_BYTES, true);
        const request = (text: string) =>
          Effect.promise(() =>
            fetch(`http://127.0.0.1:${port}${McpAppOwner.MCP_APP_OWNER_PATH}`, {
              method: "POST",
              headers: { authorization: `Bearer ${TEST_TOKEN}` },
              body: text,
            }),
          );
        const accepted = yield* request(body);
        assert.equal(accepted.status, 200);
        const result = yield* Effect.promise(() => accepted.text());
        assert.equal(Buffer.byteLength(result, "utf8") > 128 * 1024, true);
        assert.deepEqual(decodeProviderJsonString(result), { json: resultJson });
        assert.equal(dispatch.mock.calls.length, 1);
        const rejected = yield* request(" ".repeat(MCP_APP_JSON_MAX_TRANSPORT_BYTES + 1));
        assert.equal(rejected.status, 403);
        assert.deepEqual(yield* Effect.promise(() => rejected.json()), {
          error: "MCP App operation is unavailable.",
        });
        assert.equal(dispatch.mock.calls.length, 1);
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.equal(privateVisualizationDaemonRequestCount(), 0)),
        );
      }).pipe(Effect.scoped, Effect.provide(providerDaemonServerTestLayer)),
  );

  it.effect(
    "verifies scheduling capabilities only over authenticated ephemeral RPC without ledger writes",
    () =>
      Effect.gen(function* () {
        const token = "ab".repeat(32);
        const authority: SchedulingSessionAuthority = {
          threadId: ThreadId.make("scheduling-daemon-fixture"),
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          sessionGeneration: "11111111-1111-4111-8111-111111111111",
          tokenDigest: "cd".repeat(32),
        };
        let calls = 0;
        const uninstall = installSchedulingSessionRuntime({
          bind: async () => {
            throw new Error("Fixture must not start a provider");
          },
          close: async () => {},
          authorize: async (candidate) => {
            calls++;
            if (candidate !== token) throw new Error("Fixture denied");
            return authority;
          },
        });
        yield* Effect.addFinalizer(() => Effect.sync(uninstall));
        const port = yield* startProviderDaemonServerOnEphemeralPort({
          host: "127.0.0.1",
          token: TEST_TOKEN,
          version: "0.0.0-test",
          protocolVersion: 1,
        });
        const call = (authenticated: boolean, candidate: string) =>
          Effect.promise(() =>
            fetch(`http://127.0.0.1:${port}${SCHEDULING_SESSION_DAEMON_PATH}`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(authenticated ? { authorization: `Bearer ${TEST_TOKEN}` } : {}),
              },
              body: JSON.stringify({ token: candidate }),
            }),
          );
        const unauthenticated = yield* call(false, token);
        assert.equal(unauthenticated.status, 401);
        yield* Effect.promise(() => unauthenticated.arrayBuffer());
        assert.equal(calls, 0);
        const malformed = yield* call(true, "not-a-token");
        assert.equal(malformed.status, 403);
        yield* Effect.promise(() => malformed.arrayBuffer());
        assert.equal(calls, 0);
        const rejected = yield* call(true, "ef".repeat(32));
        assert.equal(rejected.status, 403);
        yield* Effect.promise(() => rejected.arrayBuffer());
        const accepted = yield* call(true, token);
        assert.equal(accepted.status, 200);
        assert.deepEqual(yield* Effect.promise(() => accepted.json()), authority);
        const sql = yield* SqlClient.SqlClient;
        const commands = yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM provider_daemon_commands`;
        assert.equal(commands[0]?.count, 0);
      }).pipe(Effect.scoped, Effect.provide(providerDaemonServerTestLayer)),
  );
  it.effect("routes authenticated rewind phases with durable exact-once receipts", () => {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const providerService: ProviderServiceShape = {
      ...mockProviderService,
      prepareConversationRollback: (payload) =>
        Effect.sync(() => {
          calls.push({ method: "prepareConversationRollback", payload });
        }),
      commitConversationRollback: (payload) =>
        Effect.sync(() => {
          calls.push({ method: "commitConversationRollback", payload });
        }),
      finishConversationRollback: (payload) =>
        Effect.sync(() => {
          calls.push({ method: "finishConversationRollback", payload });
        }),
    };
    return Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
        protocolVersion: 1,
      });
      const identity = {
        threadId: ThreadId.make("rewind-thread"),
        operationId: "2d157a02-7309-45ee-8b1c-4bf5da146a51",
      };
      const requests = [
        {
          method: "prepareConversationRollback",
          commandId: "rewind-prepare-command-0001",
          payload: {
            ...identity,
            numTurns: 2,
            firstRemovedTurnId: TurnId.make("removed-turn"),
            retainedTurnCount: 1,
            expectedControlSequence: 7,
          },
        },
        {
          method: "commitConversationRollback",
          commandId: "rewind-commit-command-0001",
          payload: identity,
        },
        {
          method: "finishConversationRollback",
          commandId: "rewind-finish-command-0001",
          payload: { ...identity, outcome: "committed", completionCommandId: "completion-proof" },
        },
      ] as const;
      for (const request of requests) {
        const body = encodeProviderDaemonRpcRequestJson(request);
        const denied = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${port}/api/provider-daemon/rpc`, { method: "POST", body }),
        );
        assert.equal(denied.status, 401);
        for (let repeat = 0; repeat < 2; repeat += 1) {
          const response = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${port}/api/provider-daemon/rpc`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${TEST_TOKEN}`,
                "content-type": "application/json",
              },
              body,
            }),
          );
          const envelope = decodeProviderDaemonRpcEnvelopeJson(
            yield* Effect.promise(() => response.text()),
          );
          assert.deepEqual(envelope, { ok: true, value: null });
        }
      }
      assert.deepEqual(
        calls,
        requests.map(({ method, payload }) => ({ method, payload })),
      );
    }).pipe(Effect.scoped, Effect.provide(makeProviderDaemonServerTestLayer(providerService)));
  });

  it.effect("refuses unavailable rewind phases and preserves explicit uncertain outcomes", () => {
    const providerService: ProviderServiceShape = {
      ...mockProviderService,
      commitConversationRollback: () =>
        Effect.fail(new ProviderAdapterRewindOutcomeUnknownError({})),
    };
    return Effect.gen(function* () {
      const port = yield* startProviderDaemonServerOnEphemeralPort({
        host: "127.0.0.1",
        token: TEST_TOKEN,
        version: "0.0.0-test",
        protocolVersion: 1,
      });
      const identity = {
        threadId: ThreadId.make("rewind-thread"),
        operationId: "2d157a02-7309-45ee-8b1c-4bf5da146a51",
      };
      for (const [request, expectedTag] of [
        [
          {
            method: "prepareConversationRollback",
            commandId: "rewind-prepare-command-0001",
            payload: {
              ...identity,
              numTurns: 2,
              firstRemovedTurnId: TurnId.make("removed-turn"),
              retainedTurnCount: 1,
              expectedControlSequence: 7,
            },
          },
          "ProviderValidationError",
        ],
        [
          {
            method: "commitConversationRollback",
            commandId: "rewind-commit-command-0001",
            payload: identity,
          },
          "ProviderAdapterRewindOutcomeUnknownError",
        ],
      ] as const) {
        const response = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${port}/api/provider-daemon/rpc`, {
            method: "POST",
            headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
            body: encodeProviderDaemonRpcRequestJson(request),
          }),
        );
        const envelope = decodeProviderDaemonRpcEnvelopeJson(
          yield* Effect.promise(() => response.text()),
        );
        assert.isFalse(envelope.ok);
        if (!envelope.ok) assert.equal(envelope.error.tag, expectedTag);
      }
    }).pipe(Effect.scoped, Effect.provide(makeProviderDaemonServerTestLayer(providerService)));
  });

  it("fails closed for generation-bound Windows self-capture but preserves legacy/POSIX startup", async () => {
    const windowsOwnershipId = "9a90b48d-868f-4614-ae9c-66d50293d52b";
    const privateError = "private credential or profile content";
    for (const capture of [
      async () => ({ status: "unknown" as const }),
      async () => ({ status: "exited" as const }),
      async () => {
        throw new Error(privateError);
      },
      async () => ({
        status: "present" as const,
        identity: { pid: process.pid + 1, creationTime100ns: "1" },
      }),
    ]) {
      await expect(
        captureProviderDaemonProcessIdentity(windowsOwnershipId, { platform: "win32", capture }),
      ).rejects.toThrow("Windows provider runtime could not verify its own process identity.");
      assert.deepEqual(
        await captureProviderDaemonProcessIdentity(undefined, { platform: "win32", capture }),
        {},
      );
      for (const platform of ["darwin", "linux"] as const) {
        let calls = 0;
        assert.deepEqual(
          await captureProviderDaemonProcessIdentity(windowsOwnershipId, {
            platform,
            capture: async () => {
              calls += 1;
              return capture();
            },
          }),
          {},
        );
        assert.equal(calls, 0);
      }
    }
  });

  it.effect(
    "binds authenticated health and database-free liveness to a single cached Windows self-capture",
    () => {
      let captureCount = 0;
      const windowsOwnershipId = "9a90b48d-868f-4614-ae9c-66d50293d52b";
      const identity = { pid: process.pid, creationTime100ns: "134348901321234567" };
      return Effect.gen(function* () {
        const port = yield* startProviderDaemonServerOnEphemeralPort(
          {
            host: "127.0.0.1",
            token: TEST_TOKEN,
            version: "0.0.0-test",
            windowsOwnershipId,
          },
          {
            platform: "win32",
            capture: async () => {
              captureCount += 1;
              return { status: "present", identity };
            },
          },
        );
        for (const endpoint of [
          PROVIDER_DAEMON_LIVENESS_PATH,
          PROVIDER_DAEMON_LIVENESS_PATH,
          PROVIDER_DAEMON_HEALTH_PATH,
        ]) {
          const denied = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}${endpoint}`));
          assert.equal(denied.status, 401);
          assert.deepEqual(yield* Effect.promise(() => denied.json()), { error: "unauthorized" });
          const response = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${port}${endpoint}`, {
              headers: { authorization: `Bearer ${TEST_TOKEN}` },
            }),
          );
          const body = decodeProviderDaemonLiveness(yield* Effect.promise(() => response.json()));
          assert.deepEqual(body.windowsProcessIdentity, identity);
          assert.equal(body.windowsOwnershipId, windowsOwnershipId);
        }
        assert.equal(captureCount, 1);
      }).pipe(Effect.scoped, Effect.provide(providerDaemonServerTestLayer));
    },
  );
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

  it("filters replay/live overlap before it can overflow the finite live queue", async () => {
    class FakeRequest extends EventEmitter {}
    class FakeResponse extends EventEmitter {
      destroyed = false;
      writableEnded = false;
      readonly lines: string[] = [];
      readonly destroyCauses: unknown[] = [];
      writeHead(): void {}
      write(line: string): boolean {
        this.lines.push(line);
        if (this.lines.length === 305) queueMicrotask(() => this.emit("close"));
        return true;
      }
      end(): void {
        this.writableEnded = true;
      }
      destroy(cause?: unknown): void {
        this.destroyed = true;
        this.destroyCauses.push(cause);
        this.emit("close");
      }
    }

    let liveListener: ((record: ProviderDaemonEventRecord) => void) | null = null;
    let replayCallCount = 0;
    const journal = {
      publish: () => Effect.die("unexpected publish"),
      replayAfter: () => Effect.die("unexpected replayAfter"),
      replayPageAfter: () => Effect.die("unexpected replayPageAfter"),
      replayPageThrough: () =>
        Effect.sync(() => {
          replayCallCount += 1;
          if (replayCallCount > 1) return [];
          // These 300 callbacks are the historical records the current replay
          // page will also return. Before boundary filtering they exceeded the
          // 256-record live queue and disconnected the stream.
          for (let cursor = 1; cursor <= 305; cursor += 1) {
            liveListener?.(makeDaemonRecord(cursor));
          }
          return Array.from({ length: 300 }, (_, index) => makeDaemonRecord(index + 1));
        }),
      subscribe: () => () => undefined,
      subscribeWithReplayBoundary: (listener: (record: ProviderDaemonEventRecord) => void) =>
        Effect.sync(() => {
          liveListener = listener;
          return {
            replayBoundaryCursor: 300,
            unsubscribe: () => {
              liveListener = null;
            },
          };
        }),
      snapshot: Effect.succeed({
        eventCursor: 300,
        retainedEventCount: 300,
        oldestCursor: 1,
        newestCursor: 300,
      }),
      startupMaintenance: Effect.void,
    } satisfies ProviderDaemonPersistentEventJournal;
    const request = new FakeRequest();
    const response = new FakeResponse();
    let cleanupCount = 0;

    await handleProviderDaemonEventStream(
      request as unknown as Parameters<typeof handleProviderDaemonEventStream>[0],
      response as unknown as Parameters<typeof handleProviderDaemonEventStream>[1],
      journal,
      0,
      (effect) => Effect.runPromise(effect),
      () => {
        cleanupCount += 1;
      },
    );

    expect(response.destroyCauses).toEqual([]);
    expect(response.lines).toHaveLength(305);
    expect(
      response.lines.map((line) => (JSON.parse(line) as ProviderDaemonEventRecord).cursor),
    ).toEqual(Array.from({ length: 305 }, (_, index) => index + 1));
    expect(cleanupCount).toBe(1);
    expect(liveListener).toBeNull();
  });

  it("cleans up the HTTP stream when replay-boundary acquisition fails", async () => {
    class FakeRequest extends EventEmitter {}
    class FakeResponse extends EventEmitter {
      destroyed = false;
      writableEnded = false;
      readonly destroyCauses: unknown[] = [];
      writeHead(): void {}
      write(): boolean {
        return true;
      }
      end(): void {
        this.writableEnded = true;
      }
      destroy(cause?: unknown): void {
        this.destroyed = true;
        this.destroyCauses.push(cause);
        this.emit("close");
      }
    }

    const journal = {
      publish: () => Effect.die("unexpected publish"),
      replayAfter: () => Effect.die("unexpected replayAfter"),
      replayPageAfter: () => Effect.die("unexpected replayPageAfter"),
      replayPageThrough: () => Effect.die("unexpected replayPageThrough"),
      subscribe: () => () => undefined,
      subscribeWithReplayBoundary: () => Effect.die(new Error("boundary snapshot failed")),
      snapshot: Effect.die("unexpected snapshot"),
      startupMaintenance: Effect.void,
    } satisfies ProviderDaemonPersistentEventJournal;
    const response = new FakeResponse();
    let cleanupCount = 0;

    await handleProviderDaemonEventStream(
      new FakeRequest() as unknown as Parameters<typeof handleProviderDaemonEventStream>[0],
      response as unknown as Parameters<typeof handleProviderDaemonEventStream>[1],
      journal,
      0,
      (effect) => Effect.runPromise(effect),
      () => {
        cleanupCount += 1;
      },
    );

    expect(cleanupCount).toBe(1);
    expect(response.destroyed).toBe(true);
    expect(response.destroyCauses).toHaveLength(1);
    expect(response.destroyCauses[0]).toBeInstanceOf(Error);
  });

  it("unsubscribes when the response closes during replay-boundary acquisition", async () => {
    class FakeRequest extends EventEmitter {}
    class FakeResponse extends EventEmitter {
      destroyed = false;
      writableEnded = false;
      writeHead(): void {}
      write(): boolean {
        return true;
      }
      end(): void {
        this.writableEnded = true;
      }
      destroy(): void {
        this.destroyed = true;
        this.emit("close");
      }
    }

    let signalBoundaryStarted!: () => void;
    const boundaryStarted = new Promise<void>((resolve) => {
      signalBoundaryStarted = resolve;
    });
    let releaseBoundary!: () => void;
    const boundaryGate = new Promise<void>((resolve) => {
      releaseBoundary = resolve;
    });
    let unsubscribeCount = 0;
    const journal = {
      publish: () => Effect.die("unexpected publish"),
      replayAfter: () => Effect.die("unexpected replayAfter"),
      replayPageAfter: () => Effect.die("unexpected replayPageAfter"),
      replayPageThrough: () => Effect.die("unexpected replayPageThrough"),
      subscribe: () => () => undefined,
      subscribeWithReplayBoundary: () =>
        Effect.promise(async () => {
          signalBoundaryStarted();
          await boundaryGate;
          return {
            replayBoundaryCursor: 0,
            unsubscribe: () => {
              unsubscribeCount += 1;
            },
          };
        }),
      snapshot: Effect.die("unexpected snapshot"),
      startupMaintenance: Effect.void,
    } satisfies ProviderDaemonPersistentEventJournal;
    const request = new FakeRequest();
    const response = new FakeResponse();
    let cleanupCount = 0;

    const stream = handleProviderDaemonEventStream(
      request as unknown as Parameters<typeof handleProviderDaemonEventStream>[0],
      response as unknown as Parameters<typeof handleProviderDaemonEventStream>[1],
      journal,
      0,
      (effect) => Effect.runPromise(effect),
      () => {
        cleanupCount += 1;
      },
    );

    await boundaryStarted;
    response.emit("close");
    releaseBoundary();
    await stream;

    expect(cleanupCount).toBe(1);
    expect(unsubscribeCount).toBe(1);
    expect(response.writableEnded).toBe(true);
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
    const activityToJsonSentinel = "provider-activity-to-json-must-not-cross-daemon";
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
            {
              key: "m1",
              role: "assistant" as const,
              text: "## Result\n\nComplete.",
              timestamp: "2026-10-07T00:00:00.000Z",
              phase: "final_answer" as const,
            },
          ],
          activities: [
            {
              key: "a0",
              kind: "command" as const,
              detail: "git status --short",
              timestamp: "2026-10-06T23:59:59.000Z",
              command: privateFieldSentinel,
              toJSON: () => ({ leaked: activityToJsonSentinel }),
            },
          ],
          activityHistoryIncomplete: true,
          historyIncomplete: true,
          gaps: [],
          truncated: true,
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
    ).pipe(Layer.provideMerge(SqlitePersistenceTest));

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
      assert.notInclude(responseText, activityToJsonSentinel);
      assert.notInclude(responseText, privateFieldSentinel);
      const envelope = decodeProviderDaemonRpcEnvelopeJson(responseText);
      assert.equal(envelope.ok, true);
      if (envelope.ok) {
        assert.deepEqual(envelope.value, {
          provider: "codex",
          providerInstanceId: "codex",
          messages: [
            { key: "m0", role: "user", text: "Audit the provider" },
            {
              key: "m1",
              role: "assistant",
              text: "## Result\n\nComplete.",
              timestamp: "2026-10-07T00:00:00.000Z",
              phase: "final_answer",
            },
          ],
          activities: [
            {
              key: "a0",
              kind: "command",
              detail: "git status --short",
              timestamp: "2026-10-06T23:59:59.000Z",
            },
          ],
          activityHistoryIncomplete: true,
          historyIncomplete: true,
          gaps: [],
          truncated: true,
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
    ).pipe(Layer.provideMerge(SqlitePersistenceTest));

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
      const health = decodeProviderDaemonHealth(decodeProviderJsonString(healthText));
      assert.equal(health.rpc?.recentFailures?.[0]?.tag, "ProviderSubagentDetailReadError");

      const serializedLogs = encodeProviderJsonString(logMessages);
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
    ).pipe(Layer.provideMerge(SqlitePersistenceTest));

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
      ).pipe(Layer.provideMerge(SqlitePersistenceTest));
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

  it.effect(
    "retains ordered events across a transient insert failure and exposes degraded health",
    () =>
      Effect.gen(function* () {
        const events = yield* Deferred.make<ReadonlyArray<ProviderRuntimeEvent>>();
        const failedWrite = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const delivered: string[] = [];
        const streamingProviderServiceLayer = Layer.succeed(ProviderService, {
          ...mockProviderService,
          streamEvents: Stream.fromEffect(Deferred.await(events)).pipe(
            Stream.flatMap(Stream.fromIterable),
            Stream.concat(Stream.never),
          ),
        } satisfies ProviderServiceShape);
        const layer = Layer.mergeAll(
          streamingProviderServiceLayer,
          ProviderRuntimeInventoryLocalLive.pipe(Layer.provide(mockProviderAdapterRegistryLayer)),
          mockServerSettingsLayer,
          ProviderSupervisorRegistryLive,
        ).pipe(Layer.provideMerge(SqlitePersistenceTest));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          let insertAttempts = 0;
          // Inject one typed SQLite lock at the exact body INSERT, while keeping
          // real transactions/replay/health reads on the in-memory database.
          const faultSql = new Proxy(sql, {
            apply(target, thisArg, args) {
              const template = args[0] as TemplateStringsArray;
              if (
                Array.isArray(template) &&
                template.join("?").includes("INSERT INTO provider_daemon_events")
              ) {
                insertAttempts += 1;
                if (insertAttempts === 1)
                  return Deferred.succeed(failedWrite, undefined).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new SqlError.SqlError({
                          reason: new SqlError.LockTimeoutError({
                            operation: "execute",
                            cause: "private sql parameters",
                          }),
                        }),
                      ),
                    ),
                  );
              }
              return Reflect.apply(target, thisArg, args);
            },
          });
          const port = yield* startProviderDaemonServerOnEphemeralPort({
            host: "127.0.0.1",
            token: TEST_TOKEN,
            version: "0.0.0-test",
            onRuntimeEventJournaled: (event) => {
              delivered.push(event.eventId);
              if (delivered.length === 2) Effect.runSync(Deferred.succeed(completed, undefined));
            },
          }).pipe(Effect.provideService(SqlClient.SqlClient, faultSql));
          yield* Deferred.succeed(
            events,
            [1, 2].map((index) => ({
              type: "turn.completed" as const,
              eventId: asEventId(`ordered-journal-${index}`),
              provider: ProviderDriverKind.make("codex"),
              threadId: ThreadId.make("ordered-journal-thread"),
              createdAt: "2026-01-01T00:00:00.000Z",
              payload: { state: "completed" as const },
            })),
          );
          yield* Deferred.await(failedWrite);
          const read = (route: string) =>
            Effect.promise(() =>
              fetch(`http://127.0.0.1:${port}${route}`, {
                headers: { authorization: `Bearer ${TEST_TOKEN}` },
              }),
            );
          const unavailable = yield* read("/api/provider-daemon/health");
          assert.equal(unavailable.status, 503);
          assert.deepEqual(yield* Effect.promise(() => unavailable.json()), {
            error: "provider-journal-unavailable",
            state: "retrying",
          });
          assert.equal((yield* read(PROVIDER_DAEMON_LIVENESS_PATH)).status, 200);
          assert.deepEqual(delivered, []);
          assert.equal(insertAttempts, 1);
          yield* TestClock.adjust(100);
          yield* Deferred.await(completed);
          assert.deepEqual(delivered, ["ordered-journal-1", "ordered-journal-2"]);
          assert.equal(insertAttempts, 3);
          const healthy = yield* read("/api/provider-daemon/health");
          assert.equal(healthy.status, 200);
          assert.equal(
            decodeProviderDaemonHealth(yield* Effect.promise(() => healthy.json())).eventCursor,
            2,
          );
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
      ).pipe(Layer.provideMerge(SqlitePersistenceTest));
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
