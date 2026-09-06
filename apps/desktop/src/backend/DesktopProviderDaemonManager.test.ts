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
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as NetService from "@cafecode/shared/Net";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopProviderDaemonManager from "./DesktopProviderDaemonManager.ts";

const TEST_TOKEN = "provider-daemon-test-token-000000000000000000000000";
type TestProcessSpawner = Context.Service.Shape<typeof ChildProcessSpawner.ChildProcessSpawner>;
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
  failRequest?: (pathname: string) => boolean,
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

          if (failRequest?.(request.url ?? "")) {
            response.writeHead(503, { "content-type": "application/json" });
            response.end('{"error":"temporarily-unavailable"}\n');
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
  overrides?: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly spawner: TestProcessSpawner;
  },
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
    Layer.provideMerge(
      overrides
        ? Layer.mergeAll(
            Layer.succeed(FileSystem.FileSystem, overrides.fileSystem),
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, overrides.spawner),
          )
        : Layer.empty,
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NetService.layer),
    Layer.provideMerge(safeStorageLayer),
    Layer.provideMerge(outputLogLayer),
  );
}

describe("DesktopProviderDaemonManager", () => {
  for (const phase of ["exists", "read", "json", "schema"] as const) {
    it.effect(`preserves the owner after inconclusive marker ${phase} inspection`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cafe-marker-test-" });
        const markerPath = `${baseDir}/provider-daemon.json`;
        const credentialPath = `${baseDir}/provider-daemon-token.bin`;
        const backendEntryPath = `${baseDir}/backend.mjs`;
        const socketPath = `${baseDir}/provider-daemon-ipc/provider-daemon.sock`;
        const backendBundle = "throw new Error('unexpected spawn');\n";
        yield* fileSystem.writeFileString(backendEntryPath, backendBundle);
        const runtimeBuildId = makeRuntimeBuildId({
          appVersion: "0.0.0-test",
          backendEntryPath,
          backendBundle,
        });
        let requests = 0;
        const fakeDaemon = yield* startFakeProviderDaemon(runtimeBuildId, () => {
          requests += 1;
          return false;
        });
        yield* Effect.addFinalizer(() => fakeDaemon.close);
        const markerJson = encodeProviderDaemonMarkerJson({
          version: 2,
          protocolVersion: 1,
          pid: process.pid,
          ppid: process.ppid,
          transport: "tcp",
          port: fakeDaemon.port,
          host: "127.0.0.1",
          httpBaseUrl: `http://127.0.0.1:${fakeDaemon.port}`,
          credentialPath,
          createdAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
          appVersion: "0.0.0-test",
          runtimeBuildId,
        });
        const markerBytes =
          phase === "json"
            ? '{"private":"secret-fragment"'
            : phase === "schema"
              ? '{"private":"secret-fragment"}'
              : markerJson;
        yield* fileSystem.writeFileString(markerPath, markerBytes);
        yield* fileSystem.writeFileString(credentialPath, TEST_TOKEN);
        yield* fileSystem.makeDirectory(`${baseDir}/provider-daemon-ipc`);
        // A would-be spawn unlinks this path before launching. It is just an
        // inert sentinel, never a live socket or an external process fixture.
        yield* fileSystem.writeFileString(socketPath, "socket-must-remain");
        let failing = true;
        let spawnCalls = 0;
        const failure = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: phase,
          description: "secret-fragment",
          pathOrDescriptor: markerPath,
        });
        const guardedFs: FileSystem.FileSystem = {
          ...fileSystem,
          exists: (file) =>
            failing && phase === "exists" && file === markerPath
              ? Effect.fail(failure)
              : fileSystem.exists(file),
          readFileString: (file, encoding) =>
            failing && phase === "read" && file === markerPath
              ? Effect.fail(failure)
              : fileSystem.readFileString(file, encoding),
        };
        const guardedSpawner: TestProcessSpawner = {
          ...spawner,
          spawn: () =>
            Effect.sync(() => {
              spawnCalls += 1;
            }).pipe(Effect.andThen(Effect.die(new Error("Test forbids process spawning")))),
        };
        yield* Effect.gen(function* () {
          const manager = yield* DesktopProviderDaemonManager.DesktopProviderDaemonManager;
          const result = yield* manager.ensureRunning.pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(result));
          const snapshot = yield* manager.snapshot;
          assert.equal(snapshot.status, "error");
          assert.include(
            Option.getOrElse(snapshot.lastError, () => ""),
            "preserved",
          );
          assert.notInclude(
            Option.getOrElse(snapshot.lastError, () => ""),
            "secret-fragment",
          );
          assert.notInclude(
            Option.getOrElse(snapshot.lastError, () => ""),
            baseDir,
          );
          assert.equal(spawnCalls, 0);
          assert.equal(requests, 0);
          assert.equal(yield* fileSystem.readFileString(markerPath), markerBytes);
          assert.equal(yield* fileSystem.readFileString(credentialPath), TEST_TOKEN);
          assert.equal(yield* fileSystem.readFileString(socketPath), "socket-must-remain");
          // Once the same marker can be read conclusively, an explicit retry
          // adopts that exact live identity instead of creating a replacement.
          failing = false;
          yield* fileSystem.writeFileString(markerPath, markerJson);
          yield* manager.ensureRunning;
          assert.isTrue((yield* manager.snapshot).adoptedExistingProcess);
          assert.equal(spawnCalls, 0);
        }).pipe(
          Effect.provide(
            makeManagerLayer(baseDir, markerPath, backendEntryPath, undefined, {
              fileSystem: guardedFs,
              spawner: guardedSpawner,
            }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("continues to the fresh-spawn path only when the marker is confirmed missing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cafe-marker-missing-" });
      const markerPath = `${baseDir}/provider-daemon.json`;
      const backendEntryPath = `${baseDir}/backend.mjs`;
      yield* fileSystem.writeFileString(backendEntryPath, "// no process is launched\n");
      let spawnCalls = 0;
      const guardedSpawner: TestProcessSpawner = {
        ...spawner,
        spawn: () =>
          Effect.sync(() => {
            spawnCalls += 1;
          }).pipe(Effect.andThen(Effect.die(new Error("Test stops before actual process spawn")))),
      };
      yield* Effect.gen(function* () {
        const manager = yield* DesktopProviderDaemonManager.DesktopProviderDaemonManager;
        assert.isFalse(yield* fileSystem.exists(markerPath));
        yield* manager.ensureRunning.pipe(Effect.exit);
        assert.equal(spawnCalls, 1);
      }).pipe(
        Effect.provide(
          makeManagerLayer(baseDir, markerPath, backendEntryPath, undefined, {
            fileSystem,
            spawner: guardedSpawner,
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const phase of ["health", "lease"] as const) {
    for (const initialFailures of [1, 2]) {
      it.live(
        `preserves the daemon through ${initialFailures} inconclusive ${phase} observations`,
        () =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const baseDir = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "cafe-adoption-retry-",
            });
            const markerPath = `${baseDir}/provider-daemon.json`;
            const credentialPath = `${baseDir}/provider-daemon-token.bin`;
            const backendEntryPath = `${baseDir}/backend.mjs`;
            // A spawn would fail rather than launch a provider. The test only
            // serves an authenticated fake daemon in this test process.
            const backendBundle = "throw new Error('unexpected spawn');\n";
            const runtimeBuildId = makeRuntimeBuildId({
              appVersion: "0.0.0-test",
              backendEntryPath,
              backendBundle,
            });
            yield* fileSystem.writeFileString(backendEntryPath, backendBundle);
            let failuresRemaining = initialFailures;
            let observedRequests = 0;
            const fakeDaemon = yield* startFakeProviderDaemon(runtimeBuildId, (pathname) => {
              if ((pathname === PROVIDER_DAEMON_LEASES_PATH) !== (phase === "lease")) return false;
              observedRequests += 1;
              if (failuresRemaining === 0) return false;
              failuresRemaining -= 1;
              return true;
            });
            yield* Effect.addFinalizer(() => fakeDaemon.close);
            yield* fileSystem.writeFileString(credentialPath, TEST_TOKEN);
            const markerJson = encodeProviderDaemonMarkerJson({
              version: 2,
              protocolVersion: 1,
              pid: process.pid,
              ppid: process.ppid,
              transport: "tcp",
              port: fakeDaemon.port,
              host: "127.0.0.1",
              httpBaseUrl: `http://127.0.0.1:${fakeDaemon.port}`,
              credentialPath,
              createdAt: "1970-01-01T00:00:00.000Z",
              updatedAt: "1970-01-01T00:00:00.000Z",
              appVersion: "0.0.0-test",
              runtimeBuildId,
            });
            yield* fileSystem.writeFileString(markerPath, markerJson);
            yield* Effect.gen(function* () {
              const manager = yield* DesktopProviderDaemonManager.DesktopProviderDaemonManager;
              const first = yield* manager.ensureRunning.pipe(Effect.exit);
              assert.equal(observedRequests, 2);
              assert.equal(yield* fileSystem.readFileString(markerPath), markerJson);
              assert.equal(yield* fileSystem.readFileString(credentialPath), TEST_TOKEN);
              if (initialFailures === 2) {
                assert.isTrue(Exit.isFailure(first));
                const failed = yield* manager.snapshot;
                assert.equal(failed.status, "error");
                assert.equal(Option.getOrUndefined(failed.pid), process.pid);
                assert.include(
                  Option.getOrElse(failed.lastError, () => ""),
                  "preserved",
                );
                // A subsequent user/backend connection attempt adopts the exact
                // preserved daemon once the transient condition has cleared.
                yield* manager.ensureRunning;
              } else {
                assert.isTrue(Exit.isSuccess(first));
              }
              assert.isTrue((yield* manager.snapshot).adoptedExistingProcess);
            }).pipe(Effect.provide(makeManagerLayer(baseDir, markerPath, backendEntryPath)));
          }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    }
  }
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

  it.effect("adopts a plaintext credential marker when keyring encryption is unavailable", () =>
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
          Effect.die(new Error("encryptString must not be called when encryption is unavailable")),
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
