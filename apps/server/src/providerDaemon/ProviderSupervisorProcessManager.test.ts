// @effect-diagnostics nodeBuiltinImport:off
import * as http from "node:http";
import * as path from "node:path";

import {
  PROVIDER_DAEMON_LEASES_PATH,
  ProviderDaemonHealth,
  ProviderDaemonLeaseResponse,
  ProviderDaemonMarker,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { deriveServerPaths, ensureServerDirectories, type ServerConfigShape } from "../config.ts";
import { ensureProviderSupervisorProcess } from "./ProviderSupervisorProcessManager.ts";

const TEST_TOKEN = "provider-supervisor-test-token-0000000000000000000000";
const TEST_RUNTIME_BUILD_ID = "provider-supervisor-runtime-build-test";

const encodeProviderDaemonHealthJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonHealth),
);
const encodeProviderDaemonMarkerJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonMarker),
);
const encodeProviderDaemonLeaseResponseJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonLeaseResponse),
);

class FakeProviderSupervisorError extends Data.TaggedError("FakeProviderSupervisorError")<{
  readonly cause: unknown;
}> {}

interface FakeProviderSupervisor {
  readonly port: number;
  readonly close: Effect.Effect<void>;
}

const startFakeProviderSupervisor: Effect.Effect<
  FakeProviderSupervisor,
  FakeProviderSupervisorError
> = Effect.tryPromise({
  try: () =>
    new Promise<FakeProviderSupervisor>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        if (request.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
          response.writeHead(401, {
            "content-type": "application/json",
          });
          response.end('{"error":"unauthorized"}\n');
          return;
        }

        response.writeHead(200, {
          "content-type": "application/json",
        });
        if (request.url === PROVIDER_DAEMON_LEASES_PATH) {
          response.end(
            `${encodeProviderDaemonLeaseResponseJson({
              leaseId: "supervisor-lease-000000000000000000000",
              token: "provider-supervisor-lease-token-0000000000000000000",
              capabilities: ["health", "events", "rpc", "lease"],
              issuedAt: "1970-01-01T00:00:00.000Z",
            })}\n`,
          );
          return;
        }
        response.end(
          `${encodeProviderDaemonHealthJson({
            ok: true,
            mode: "provider-supervisor",
            protocolVersion: 1,
            pid: process.pid,
            ppid: process.ppid,
            version: "0.0.0-test",
            runtimeBuildId: TEST_RUNTIME_BUILD_ID,
            startedAt: "1970-01-01T00:00:00.000Z",
            activeSessionCount: 2,
            configuredInstanceCount: 3,
            eventCursor: 11,
            activeStreamCount: 1,
            retainedEventCount: 9,
            leaseCount: 1,
            commandCount: 4,
            completedCommandCount: 3,
            failedCommandCount: 1,
          })}\n`,
        );
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          reject(
            new FakeProviderSupervisorError({
              cause: "fake provider supervisor did not bind to TCP",
            }),
          );
          return;
        }
        resolve({
          port: address.port,
          close: Effect.promise(
            () =>
              new Promise<void>((closeResolve) => {
                server.close(() => closeResolve());
              }),
          ),
        });
      });
    }),
  catch: (cause) => new FakeProviderSupervisorError({ cause }),
});

const makeServerConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
    yield* ensureServerDirectories(derivedPaths);
    return {
      logLevel: "Error",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "cafe-code-provider-daemon",
      mode: "desktop",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      startupPresentation: "headless",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      providerDaemon: undefined,
      providerSupervisor: undefined,
    } satisfies ServerConfigShape;
  });

describe("ProviderSupervisorProcessManager", () => {
  it.effect("adopts an existing authorized provider supervisor marker", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cafe-provider-supervisor-manager-test-",
      });
      const config = yield* makeServerConfig(baseDir);
      const fakeSupervisor = yield* startFakeProviderSupervisor;
      yield* Effect.addFinalizer(() => fakeSupervisor.close);
      const httpBaseUrl = `http://127.0.0.1:${fakeSupervisor.port}`;
      const markerPath = path.join(config.stateDir, "provider-supervisor.json");
      const credentialPath = path.join(config.secretsDir, "provider-supervisor-token");

      yield* fileSystem.writeFileString(credentialPath, `${TEST_TOKEN}\n`);
      yield* fileSystem.writeFileString(
        markerPath,
        `${encodeProviderDaemonMarkerJson({
          version: 2,
          mode: "provider-supervisor",
          protocolVersion: 1,
          pid: process.pid,
          ppid: process.ppid,
          transport: "tcp",
          port: fakeSupervisor.port,
          host: "127.0.0.1",
          httpBaseUrl,
          credentialPath,
          createdAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
          appVersion: "0.0.0-test",
          runtimeBuildId: TEST_RUNTIME_BUILD_ID,
        })}\n`,
      );

      const supervisor = yield* ensureProviderSupervisorProcess({
        config,
        version: "0.0.0-test",
        runtimeBuildId: TEST_RUNTIME_BUILD_ID,
      });

      assert.equal(supervisor.endpoint.httpBaseUrl, httpBaseUrl);
      assert.equal(
        supervisor.endpoint.token,
        "provider-supervisor-lease-token-0000000000000000000",
      );
      assert.equal(supervisor.endpoint.leaseId, "supervisor-lease-000000000000000000000");
      assert.isTrue(supervisor.snapshot.adoptedExistingProcess);
      assert.equal(supervisor.snapshot.appVersion, "0.0.0-test");
      assert.equal(supervisor.snapshot.protocolVersion, 1);
      assert.equal(supervisor.snapshot.runtimeBuildId, TEST_RUNTIME_BUILD_ID);
      assert.equal(supervisor.snapshot.health.mode, "provider-supervisor");
      assert.equal(supervisor.snapshot.health.protocolVersion, 1);
      assert.equal(supervisor.snapshot.health.activeSessionCount, 2);
      assert.equal(supervisor.snapshot.health.configuredInstanceCount, 3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
