// @effect-diagnostics nodeBuiltinImport:off
import * as crypto from "node:crypto";
import * as http from "node:http";

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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as NetService from "@cafecode/shared/Net";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopProviderDaemonManager from "./DesktopProviderDaemonManager.ts";

const TEST_TOKEN = "provider-daemon-test-token-000000000000000000000000";
const encodeProviderDaemonHealthJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonHealth),
);
const encodeProviderDaemonMarkerJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonMarker),
);
const encodeProviderDaemonLeaseResponseJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonLeaseResponse),
);

class FakeProviderDaemonError extends Data.TaggedError("FakeProviderDaemonError")<{
  readonly cause: unknown;
}> {}

interface FakeProviderDaemon {
  readonly port: number;
  readonly close: Effect.Effect<void>;
}

function makeRuntimeBuildId(input: {
  readonly appVersion: string;
  readonly backendEntryPath: string;
  readonly backendBundle: string;
}): string {
  return crypto
    .createHash("sha256")
    .update("cafecode-provider-runtime-v1\0")
    .update(input.appVersion)
    .update("\0")
    .update(input.backendEntryPath)
    .update("\0")
    .update(input.backendBundle)
    .digest("hex");
}

const startFakeProviderDaemon = (
  runtimeBuildId: string,
): Effect.Effect<FakeProviderDaemon, FakeProviderDaemonError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<FakeProviderDaemon>((resolve, reject) => {
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
                leaseId: "lease-000000000000000000000000000",
                token: "provider-daemon-lease-token-000000000000000000000000",
                capabilities: ["health", "events", "rpc"],
                issuedAt: "1970-01-01T00:00:00.000Z",
              })}\n`,
            );
            return;
          }
          response.end(
            `${encodeProviderDaemonHealthJson({
              ok: true,
              mode: "provider-daemon",
              pid: process.pid,
              ppid: process.ppid,
              version: "0.0.0-test",
              protocolVersion: 1,
              runtimeBuildId,
              startedAt: "1970-01-01T00:00:00.000Z",
              activeSessionCount: 3,
              configuredInstanceCount: 2,
              eventCursor: 9,
            })}\n`,
          );
        });
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (typeof address !== "object" || address === null) {
            reject(
              new FakeProviderDaemonError({
                cause: "fake provider daemon did not bind to TCP",
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
    catch: (cause) => new FakeProviderDaemonError({ cause }),
  });

function makeEnvironmentLayer(baseDir: string, markerPath: string, backendEntryPath: string) {
  return Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    baseDir,
    providerDaemonMarkerPath: markerPath,
    providerDaemonCredentialPath: `${baseDir}/provider-daemon-token.bin`,
    providerDaemonIpcDir: `${baseDir}/provider-daemon-ipc`,
    otlpTracesUrl: Option.none(),
    appVersion: "0.0.0-test",
    backendEntryPath,
    backendCwd: baseDir,
  } as DesktopEnvironment.DesktopEnvironmentShape);
}

function makeManagerLayer(
  baseDir: string,
  markerPath: string,
  backendEntryPath: string,
  safeStorage?: ElectronSafeStorage.ElectronSafeStorageShape,
) {
  const safeStorageLayer = Layer.succeed(
    ElectronSafeStorage.ElectronSafeStorage,
    safeStorage ??
      ({
        isEncryptionAvailable: Effect.succeed(true),
        encryptString: (value) => Effect.succeed(new TextEncoder().encode(value)),
        decryptString: (value) => Effect.succeed(new TextDecoder().decode(value)),
      } satisfies ElectronSafeStorage.ElectronSafeStorageShape),
  );
  const outputLogLayer = Layer.succeed(DesktopObservability.DesktopBackendOutputLog, {
    writeSessionBoundary: () => Effect.void,
    writeOutputChunk: () => Effect.void,
  } satisfies DesktopObservability.DesktopBackendOutputLogShape);

  return DesktopProviderDaemonManager.layer.pipe(
    Layer.provideMerge(makeEnvironmentLayer(baseDir, markerPath, backendEntryPath)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NetService.layer),
    Layer.provideMerge(safeStorageLayer),
    Layer.provideMerge(outputLogLayer),
  );
}

describe("DesktopProviderDaemonManager", () => {
  it.effect("adopts an existing authorized loopback provider daemon marker", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cafe-provider-daemon-manager-test-",
      });
      const markerPath = `${baseDir}/provider-daemon.json`;
      const credentialPath = `${baseDir}/provider-daemon-token.bin`;
      const backendEntryPath = `${baseDir}/backend.mjs`;
      const backendBundle = "console.log('provider daemon test backend');\n";
      const runtimeBuildId = makeRuntimeBuildId({
        appVersion: "0.0.0-test",
        backendEntryPath,
        backendBundle,
      });
      yield* fileSystem.writeFileString(backendEntryPath, backendBundle);
      const fakeDaemon = yield* startFakeProviderDaemon(runtimeBuildId);
      yield* Effect.addFinalizer(() => fakeDaemon.close);
      const httpBaseUrl = `http://127.0.0.1:${fakeDaemon.port}`;

      yield* fileSystem.writeFileString(credentialPath, TEST_TOKEN);

      yield* fileSystem.writeFileString(
        markerPath,
        `${encodeProviderDaemonMarkerJson({
          version: 2,
          protocolVersion: 1,
          pid: process.pid,
          ppid: process.ppid,
          transport: "tcp",
          port: fakeDaemon.port,
          host: "127.0.0.1",
          httpBaseUrl,
          credentialPath,
          createdAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
          appVersion: "0.0.0-test",
          runtimeBuildId,
        })}\n`,
      );

      yield* Effect.gen(function* () {
        const manager = yield* DesktopProviderDaemonManager.DesktopProviderDaemonManager;
        const endpoint = yield* manager.ensureRunning;
        const snapshot = yield* manager.snapshot;

        assert.equal(endpoint.httpBaseUrl, httpBaseUrl);
        assert.equal(endpoint.token, "provider-daemon-lease-token-000000000000000000000000");
        assert.equal(endpoint.leaseId, "lease-000000000000000000000000000");
        assert.isTrue(snapshot.adoptedExistingProcess);
        assert.equal(Option.getOrUndefined(snapshot.pid), process.pid);
        assert.equal(Option.getOrUndefined(snapshot.lastHealth)?.activeSessionCount, 3);
        assert.equal(snapshot.runtimeBuildId, runtimeBuildId);
      }).pipe(Effect.provide(makeManagerLayer(baseDir, markerPath, backendEntryPath)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "adopts a plaintext credential marker when keyring encryption is unavailable",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafe-provider-daemon-manager-plaintext-test-",
        });
        const markerPath = `${baseDir}/provider-daemon.json`;
        const credentialPath = `${baseDir}/provider-daemon-token.bin`;
        const backendEntryPath = `${baseDir}/backend.mjs`;
        const backendBundle = "console.log('provider daemon test backend');\n";
        const runtimeBuildId = makeRuntimeBuildId({
          appVersion: "0.0.0-test",
          backendEntryPath,
          backendBundle,
        });
        yield* fileSystem.writeFileString(backendEntryPath, backendBundle);
        const fakeDaemon = yield* startFakeProviderDaemon(runtimeBuildId);
        yield* Effect.addFinalizer(() => fakeDaemon.close);
        const httpBaseUrl = `http://127.0.0.1:${fakeDaemon.port}`;

        // Token stored as plaintext, exactly as `writeCredential` does when the
        // OS keyring is unavailable.
        yield* fileSystem.writeFileString(credentialPath, TEST_TOKEN);

        yield* fileSystem.writeFileString(
          markerPath,
          `${encodeProviderDaemonMarkerJson({
            version: 2,
            protocolVersion: 1,
            pid: process.pid,
            ppid: process.ppid,
            transport: "tcp",
            port: fakeDaemon.port,
            host: "127.0.0.1",
            httpBaseUrl,
            credentialPath,
            credentialEncrypted: false,
            createdAt: "1970-01-01T00:00:00.000Z",
            updatedAt: "1970-01-01T00:00:00.000Z",
            appVersion: "0.0.0-test",
            runtimeBuildId,
          })}\n`,
        );

        // safeStorage reports unavailable and throws if asked to decrypt: the
        // plaintext path must never touch it.
        const unavailableSafeStorage = {
          isEncryptionAvailable: Effect.succeed(false),
          encryptString: () =>
            Effect.die(
              new Error("encryptString must not be called when encryption is unavailable"),
            ),
          decryptString: () =>
            Effect.die(new Error("decryptString must not be called for a plaintext credential")),
        } satisfies ElectronSafeStorage.ElectronSafeStorageShape;

        yield* Effect.gen(function* () {
          const manager = yield* DesktopProviderDaemonManager.DesktopProviderDaemonManager;
          const endpoint = yield* manager.ensureRunning;
          const snapshot = yield* manager.snapshot;

          assert.equal(endpoint.httpBaseUrl, httpBaseUrl);
          assert.equal(endpoint.token, "provider-daemon-lease-token-000000000000000000000000");
          assert.isTrue(snapshot.adoptedExistingProcess);
          assert.equal(Option.getOrUndefined(snapshot.pid), process.pid);
        }).pipe(
          Effect.provide(
            makeManagerLayer(baseDir, markerPath, backendEntryPath, unavailableSafeStorage),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
