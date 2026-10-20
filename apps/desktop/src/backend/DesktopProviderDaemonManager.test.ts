// @effect-diagnostics nodeBuiltinImport:off
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as fs from "node:fs/promises";

import {
  PROVIDER_DAEMON_HEALTH_PATH,
  PROVIDER_DAEMON_LEASES_PATH,
  ProviderDaemonBootstrap,
  ProviderDaemonHealth,
  ProviderDaemonLeaseResponse,
  ProviderDaemonMarker,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import type * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as NetService from "@cafecode/shared/Net";
import { dataProfileIdentity } from "@cafecode/shared/dataProfileIdentity";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopDebugServer from "../debug/DesktopDebugServer.ts";
import * as DesktopProviderDaemonManager from "./DesktopProviderDaemonManager.ts";

// Native ESM namespace bindings are not configurable. Keep the real filesystem
// implementation and record its calls through the imported module boundary;
// never replace successful reads with invented bytes or omit forbidden-access
// assertions merely because a namespace cannot be spied on directly.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: vi.fn(original.readFile) };
});

const TEST_TOKEN = "provider-daemon-test-token-000000000000000000000000";
const TEST_LEASE_TOKEN = "provider-daemon-lease-token-000000000000000000000000";
// Observation-only JSON snapshots retain native JSON field/value semantics.
const encodeDiagnosticJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
  baseDir: string,
  runtimeBuildId: string,
  failRequest?: (pathname: string) => boolean,
  proof: "matching" | "missing" | "foreign" = "matching",
  healthPatch: Partial<ProviderDaemonHealth> = {},
): Effect.Effect<FakeProviderDaemon, FakeProviderDaemonError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<FakeProviderDaemon>((resolve, reject) => {
        const server = http.createServer((request, response) => {
          if (
            request.headers.authorization !== `Bearer ${TEST_TOKEN}` &&
            request.headers.authorization !== `Bearer ${TEST_LEASE_TOKEN}`
          ) {
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
                token: TEST_LEASE_TOKEN,
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
              ...(proof === "missing"
                ? {}
                : {
                    dataProfile: "production" as const,
                    dataProfileId: dataProfileIdentity(
                      "production",
                      proof === "foreign" ? `${baseDir}/foreign` : baseDir,
                    ),
                  }),
              pid: process.pid,
              ppid: process.ppid,
              version: "0.0.0-test",
              protocolVersion: 1,
              runtimeBuildId,
              startedAt: "1970-01-01T00:00:00.000Z",
              activeSessionCount: 3,
              configuredInstanceCount: 2,
              eventCursor: 9,
              ...healthPatch,
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
    configuredBaseDir: baseDir,
    dataProfile: "production",
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
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  for (const phase of [
    "foreign-socket",
    "foreign-credential",
    "legacy-profile",
    "foreign-profile",
  ] as const) {
    it.effect(`preserves ${phase} markers before credential, network or process access`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafe-profile-admission-",
        });
        const markerPath = `${baseDir}/provider-daemon.json`;
        const credentialPath = `${baseDir}/provider-daemon-token.bin`;
        const backendEntryPath = `${baseDir}/backend.mjs`;
        const socketPath = `${baseDir}/provider-daemon-ipc/provider-daemon.sock`;
        const foreignCredentialPath = `${baseDir}/foreign-token.bin`;
        yield* fileSystem.writeFileString(backendEntryPath, "// synthetic profile boundary\n");
        yield* fileSystem.writeFileString(credentialPath, TEST_TOKEN);
        yield* fileSystem.writeFileString(foreignCredentialPath, TEST_TOKEN);
        yield* fileSystem.makeDirectory(`${baseDir}/provider-daemon-ipc`);
        yield* fileSystem.writeFileString(socketPath, "profile-socket-preserved");
        let requests = 0;
        let spawnCalls = 0;
        const runtimeBuildId = makeRuntimeBuildId({
          appVersion: "0.0.0-test",
          backendEntryPath,
          backendBundle: "// synthetic profile boundary\n",
        });
        const fake = yield* startFakeProviderDaemon(baseDir, runtimeBuildId, () => {
          requests += 1;
          return false;
        });
        yield* Effect.addFinalizer(() => fake.close);
        const marker = encodeProviderDaemonMarkerJson({
          version: 2,
          mode: "provider-daemon",
          ...(phase === "legacy-profile"
            ? {}
            : {
                dataProfile: "production" as const,
                dataProfileId: dataProfileIdentity(
                  "production",
                  phase === "foreign-profile" ? `${baseDir}/other` : baseDir,
                ),
              }),
          pid: process.pid,
          ppid: process.ppid,
          protocolVersion: 1,
          transport: phase === "foreign-socket" ? "ipc" : "tcp",
          ...(phase === "foreign-socket" ? { socketPath: `${baseDir}/foreign.sock` } : {}),
          httpBaseUrl: `http://127.0.0.1:${fake.port}`,
          credentialPath: phase === "foreign-credential" ? foreignCredentialPath : credentialPath,
          createdAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
          appVersion: "0.0.0-test",
          runtimeBuildId,
        });
        yield* fileSystem.writeFileString(markerPath, marker);
        const read = vi.mocked(fs.readFile);
        read.mockClear();
        const signals = vi.spyOn(process, "kill").mockReturnValue(true);
        const guardedSpawner: TestProcessSpawner = {
          ...spawner,
          spawn: () =>
            Effect.sync(() => {
              spawnCalls += 1;
            }).pipe(Effect.andThen(Effect.die("Unexpected competing owner"))),
        };
        yield* Effect.gen(function* () {
          const manager = yield* DesktopProviderDaemonManager.DesktopProviderDaemonManager;
          const refused = yield* manager.ensureRunning.pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(refused));
          assert.equal(requests, 0);
          assert.equal(spawnCalls, 0);
          assert.equal(
            read.mock.calls.filter(
              ([path]) => path === credentialPath || path === foreignCredentialPath,
            ).length,
            0,
          );
          assert.equal(signals.mock.calls.length, 0);
          assert.isTrue(Exit.isFailure(yield* manager.stop.pipe(Effect.exit)));
          assert.equal(yield* fileSystem.readFileString(markerPath), marker);
          assert.equal(yield* fileSystem.readFileString(credentialPath), TEST_TOKEN);
          assert.equal(yield* fileSystem.readFileString(foreignCredentialPath), TEST_TOKEN);
          assert.equal(yield* fileSystem.readFileString(socketPath), "profile-socket-preserved");
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
  }

  for (const proof of ["missing", "foreign", "matching"] as const) {
    it.effect(
      `requires matching native profile proof and never signals an adopted ${proof} owner`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const baseDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "cafe-profile-receipt-",
          });
          const markerPath = `${baseDir}/provider-daemon.json`;
          const credentialPath = `${baseDir}/provider-daemon-token.bin`;
          const backendEntryPath = `${baseDir}/backend.mjs`;
          const backendBundle = "// synthetic native receipt\n";
          yield* fileSystem.writeFileString(backendEntryPath, backendBundle);
          yield* fileSystem.writeFileString(credentialPath, TEST_TOKEN);
          const runtimeBuildId = makeRuntimeBuildId({
            appVersion: "0.0.0-test",
            backendEntryPath,
            backendBundle,
          });
          let requests = 0;
          let leaseRequests = 0;
          let spawnCalls = 0;
          const fake = yield* startFakeProviderDaemon(
            baseDir,
            runtimeBuildId,
            (pathname) => {
              requests += 1;
              if (pathname === PROVIDER_DAEMON_LEASES_PATH) leaseRequests += 1;
              return false;
            },
            proof,
          );
          yield* Effect.addFinalizer(() => fake.close);
          const marker = encodeProviderDaemonMarkerJson({
            version: 2,
            mode: "provider-daemon",
            dataProfile: "production",
            dataProfileId: dataProfileIdentity("production", baseDir),
            pid: process.pid,
            ppid: process.ppid,
            protocolVersion: 1,
            transport: "tcp",
            httpBaseUrl: `http://127.0.0.1:${fake.port}`,
            credentialPath,
            createdAt: "1970-01-01T00:00:00.000Z",
            updatedAt: "1970-01-01T00:00:00.000Z",
            appVersion: "0.0.0-test",
            runtimeBuildId,
          });
          yield* fileSystem.writeFileString(markerPath, marker);
          const signals = vi.spyOn(process, "kill").mockReturnValue(true);
          const guardedSpawner: TestProcessSpawner = {
            ...spawner,
            spawn: () =>
              Effect.sync(() => {
                spawnCalls += 1;
              }).pipe(Effect.andThen(Effect.die("Unexpected competing owner"))),
          };
          yield* Effect.gen(function* () {
            const manager = yield* DesktopProviderDaemonManager.DesktopProviderDaemonManager;
            const result = yield* manager.ensureRunning.pipe(Effect.exit);
            assert.equal(Exit.isSuccess(result), proof === "matching");
            assert.equal(requests, proof === "matching" ? 2 : 1);
            assert.equal(leaseRequests, proof === "matching" ? 1 : 0);
            assert.equal(spawnCalls, 0);
            assert.isTrue(Exit.isFailure(yield* manager.stop.pipe(Effect.exit)));
            assert.isTrue(
              Exit.isFailure(yield* manager.recover("synthetic failure").pipe(Effect.exit)),
            );
            assert.isTrue(signals.mock.calls.every(([, signal]) => signal === 0));
            assert.equal(yield* fileSystem.readFileString(markerPath), marker);
            assert.equal(yield* fileSystem.readFileString(credentialPath), TEST_TOKEN);
            if (proof === "matching") {
              const snapshot = yield* manager.snapshot;
              assert.equal(snapshot.status, "running");
              assert.isTrue(snapshot.adoptedExistingProcess);
              assert.isTrue(Option.isSome(yield* manager.currentConfig));
              const beforePreparationRequests = requests;
              assert.isTrue(Exit.isFailure(yield* manager.prepareForUpdate!.pipe(Effect.exit)));
              // Authentication/adoption is not a retained POSIX child handle.
              assert.equal(requests, beforePreparationRequests);
              assert.equal(leaseRequests, 1);
            }
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
  }

  for (const scenario of [
    { reason: "application-version", label: "application version" },
    { reason: "runtime-build", label: "runtime build" },
    { reason: "protocol-version", label: "provider protocol" },
    { reason: "cafe-mcp-port", label: "backend MCP port" },
    { reason: "process-id", label: "process identity" },
    { reason: "process-mode", label: "runtime role" },
  ] as const) {
    it.effect(
      `preserves an authenticated incompatible daemon with ${scenario.reason} guidance`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cafe-old-daemon-" });
          const markerPath = `${baseDir}/provider-daemon.json`;
          const credentialPath = `${baseDir}/provider-daemon-token.bin`;
          const socketPath = `${baseDir}/provider-daemon-ipc/provider-daemon.sock`;
          const backendEntryPath = `${baseDir}/backend.mjs`;
          const backendBundle = "// new synthetic installed bundle\n";
          yield* fileSystem.writeFileString(backendEntryPath, backendBundle);
          yield* fileSystem.writeFileString(credentialPath, TEST_TOKEN);
          yield* fileSystem.makeDirectory(`${baseDir}/provider-daemon-ipc`);
          yield* fileSystem.writeFileString(socketPath, "preserved old socket entry");
          const currentBuild = makeRuntimeBuildId({
            appVersion: "0.0.0-test",
            backendEntryPath,
            backendBundle,
          });
          const oldVersion = scenario.reason === "application-version" ? "0.0.0-old" : "0.0.0-test";
          const observedBuild =
            scenario.reason === "application-version" || scenario.reason === "runtime-build"
              ? makeRuntimeBuildId({
                  appVersion: oldVersion,
                  backendEntryPath,
                  backendBundle: "// old installed bundle\n",
                })
              : currentBuild;
          const protocol = scenario.reason === "protocol-version" ? 2 : 1;
          let requests = 0;
          let leases = 0;
          let spawns = 0;
          const fake = yield* startFakeProviderDaemon(
            baseDir,
            observedBuild,
            (pathname) => {
              requests += 1;
              if (pathname === PROVIDER_DAEMON_LEASES_PATH) leases += 1;
              return false;
            },
            "matching",
            {
              version: oldVersion,
              protocolVersion: protocol,
              ...(scenario.reason === "process-id" ? { pid: process.pid + 1 } : {}),
              ...(scenario.reason === "process-mode" ? { mode: "provider-supervisor" } : {}),
            },
          );
          yield* Effect.addFinalizer(() => fake.close);
          const marker = encodeProviderDaemonMarkerJson({
            version: 2,
            mode: "provider-daemon",
            dataProfile: "production",
            dataProfileId: dataProfileIdentity("production", baseDir),
            pid: process.pid,
            ppid: process.ppid,
            protocolVersion: protocol,
            transport: "tcp",
            httpBaseUrl: `http://127.0.0.1:${fake.port}`,
            credentialPath,
            credentialEncrypted: false,
            createdAt: "1970-01-01T00:00:00.000Z",
            updatedAt: "1970-01-01T00:00:00.000Z",
            appVersion: oldVersion,
            runtimeBuildId: observedBuild,
            cafeMcpPort: scenario.reason === "cafe-mcp-port" ? 3774 : 3773,
          });
          yield* fileSystem.writeFileString(markerPath, marker);
          const signals = vi.spyOn(process, "kill").mockReturnValue(true);
          const guardedSpawner: TestProcessSpawner = {
            ...spawner,
            spawn: () =>
              Effect.sync(() => {
                spawns += 1;
              }).pipe(
                Effect.andThen(
                  Effect.die(new FakeProviderDaemonError({ cause: "Unexpected competing owner" })),
                ),
              ),
          };
          yield* Effect.gen(function* () {
            const manager = yield* DesktopProviderDaemonManager.DesktopProviderDaemonManager;
            yield* manager.configureCafeMcpPort!(3773);
            assert.isTrue(Exit.isFailure(yield* manager.ensureRunning.pipe(Effect.exit)));
            const snapshot = yield* manager.snapshot;
            const message = Option.getOrThrow(snapshot.lastError);
            assert.include(message, scenario.label);
            assert.include(message, "Stop the owning runtime explicitly");
            assert.notInclude(message, "inconclusive");
            assert.notInclude(message, TEST_TOKEN);
            assert.notInclude(message, baseDir);
            assert.notInclude(message, oldVersion);
            assert.equal(requests, 1);
            assert.equal(leases, 0);
            assert.equal(spawns, 0);
            assert.isTrue(signals.mock.calls.every(([, signal]) => signal === 0));
            assert.equal(yield* fileSystem.readFileString(markerPath), marker);
            assert.equal(yield* fileSystem.readFileString(credentialPath), TEST_TOKEN);
            assert.equal(
              yield* fileSystem.readFileString(socketPath),
              "preserved old socket entry",
            );
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
  }

  // This is an actual POSIX socket/manager boundary. Windows exercises its
  // distinct guarded native-owner adapter in WindowsDesktopProviderDaemonManager.test.ts.
  if (process.platform !== "win32")
    for (const phase of [
      "matching",
      "changed-profile",
      "changed-build",
      "upstream",
      "exited-before",
      "exited-during-health",
      "interrupted",
    ] as const) {
      it.effect(`prepares an exact owned POSIX daemon without mutation: ${phase}`, () =>
        Effect.gen(function* () {
          const fixtureScope = yield* Scope.Scope;
          const fileSystem = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          // Keep the Unix-domain path below native socket length bounds on macOS
          // without changing the application namespace or using a shared socket.
          const baseDir = yield* fileSystem.makeTempDirectoryScoped({
            directory: "/tmp",
            prefix: "cafe-update-",
          });
          const markerPath = `${baseDir}/provider-daemon.json`;
          const credentialPath = `${baseDir}/provider-daemon-token.bin`;
          const backendEntryPath = `${baseDir}/backend.mjs`;
          yield* fileSystem.writeFileString(backendEntryPath, "// inert owned update fixture\n");
          let healthPatch: Partial<ProviderDaemonHealth> = {};
          let running = true;
          let preparing = false;
          let healthRequests = 0;
          let leases = 0;
          let spawns = 0;
          let kills = 0;
          let observations = 0;
          const heldRequest = yield* Deferred.make<void>();
          const closedRequest = yield* Deferred.make<void>();
          const guardedSpawner: TestProcessSpawner = {
            ...spawner,
            spawn: (command) =>
              Effect.gen(function* () {
                spawns += 1;
                if (command._tag !== "StandardCommand")
                  return yield* Effect.die(
                    new FakeProviderDaemonError({ cause: "Expected private bootstrap command" }),
                  );
                const fd3 = command.options.additionalFds?.fd3;
                if (fd3?.type !== "input" || !fd3.stream)
                  return yield* Effect.die(
                    new FakeProviderDaemonError({ cause: "Expected private fd3 bootstrap" }),
                  );
                const bootstrap = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(ProviderDaemonBootstrap),
                )(yield* fd3.stream.pipe(Stream.decodeText(), Stream.mkString)).pipe(Effect.orDie);
                assert.equal(bootstrap.mode, "provider-daemon");
                assert.equal(bootstrap.dataProfile, "production");
                assert.equal(bootstrap.cafeCodeHome, baseDir);
                assert.isString(bootstrap.socketPath);
                const server = http.createServer((request, response) => {
                  const expected =
                    request.url === PROVIDER_DAEMON_LEASES_PATH
                      ? bootstrap.token
                      : preparing
                        ? TEST_LEASE_TOKEN
                        : bootstrap.token;
                  if (request.headers.authorization !== `Bearer ${expected}`) {
                    response.writeHead(401);
                    response.end();
                    return;
                  }
                  response.writeHead(200, { "content-type": "application/json" });
                  if (request.url === PROVIDER_DAEMON_LEASES_PATH) {
                    leases += 1;
                    response.end(
                      encodeProviderDaemonLeaseResponseJson({
                        leaseId: "lease-000000000000000000000000000",
                        token: TEST_LEASE_TOKEN,
                        capabilities: ["health", "events", "rpc"],
                        issuedAt: "1970-01-01T00:00:00.000Z",
                      }),
                    );
                    return;
                  }
                  assert.equal(request.url, PROVIDER_DAEMON_HEALTH_PATH);
                  healthRequests += 1;
                  if (preparing && phase === "interrupted") {
                    response.once("close", () =>
                      Effect.runSync(Deferred.succeed(closedRequest, undefined)),
                    );
                    Effect.runSync(Deferred.succeed(heldRequest, undefined));
                    return;
                  }
                  if (preparing && phase === "exited-during-health") running = false;
                  response.end(
                    encodeProviderDaemonHealthJson({
                      ok: true,
                      mode: "provider-daemon",
                      dataProfile: "production",
                      dataProfileId: dataProfileIdentity("production", baseDir),
                      pid: 1_234_567,
                      ppid: process.pid,
                      version: "0.0.0-test",
                      protocolVersion: 1,
                      runtimeBuildId: bootstrap.runtimeBuildId,
                      startedAt: "1970-01-01T00:00:00.000Z",
                      activeSessionCount: 3,
                      configuredInstanceCount: 2,
                      eventCursor: 9,
                      ...healthPatch,
                    }),
                  );
                });
                // Capture the fixture's outer scope, not the intentionally durable
                // daemon scope supplied to spawn; register retirement before listen.
                yield* Scope.addFinalizer(
                  fixtureScope,
                  Effect.promise(
                    () =>
                      new Promise<void>((resolve) => {
                        server.closeAllConnections();
                        server.close(() => resolve());
                      }),
                  ),
                );
                yield* Effect.tryPromise({
                  try: () =>
                    new Promise<void>((resolve, reject) => {
                      server.once("error", reject);
                      server.listen(bootstrap.socketPath!, resolve);
                    }),
                  catch: (cause) => new FakeProviderDaemonError({ cause }),
                }).pipe(Effect.orDie);
                return ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(1_234_567),
                  stdout: Stream.empty,
                  stderr: Stream.empty,
                  all: Stream.empty,
                  exitCode: Effect.never,
                  isRunning: Effect.sync(() => {
                    observations += 1;
                    return running;
                  }),
                  kill: () =>
                    Effect.sync(() => {
                      kills += 1;
                      running = false;
                    }),
                  stdin: Sink.drain,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                  unref: Effect.succeed(Effect.void),
                });
              }),
          };
          yield* Effect.gen(function* () {
            const manager = yield* DesktopProviderDaemonManager.DesktopProviderDaemonManager;
            yield* manager.ensureRunning;
            const markerBefore = yield* fileSystem.readFileString(markerPath);
            const credentialBefore = yield* fileSystem.readFile(credentialPath);
            const snapshotBefore = yield* manager.snapshot;
            const observationsBefore = observations;
            preparing = true;
            if (phase === "changed-profile") healthPatch = { dataProfile: "debug" };
            if (phase === "changed-build")
              healthPatch = { runtimeBuildId: "private-invalid-build" };
            if (phase === "upstream")
              healthPatch = { upstreamSupervisor: { configured: true, reachable: true } };
            if (phase === "exited-before") running = false;
            const prepared =
              phase === "interrupted"
                ? yield* Effect.gen(function* () {
                    const attempt = yield* manager.prepareForUpdate!.pipe(Effect.forkScoped);
                    yield* Deferred.await(heldRequest);
                    yield* Fiber.interrupt(attempt);
                    const result = yield* Fiber.await(attempt);
                    assert.isTrue(Exit.isFailure(result));
                    if (Exit.isFailure(result)) assert.isTrue(Cause.hasInterrupts(result.cause));
                    // This receipt belongs to the actual held HTTP response, not a
                    // mock call: interruption must abort its exact native request.
                    yield* Deferred.await(closedRequest);
                    return result;
                  })
                : yield* manager.prepareForUpdate!.pipe(Effect.exit);
            assert.equal(Exit.isSuccess(prepared), phase === "matching");
            assert.equal(healthRequests, phase === "exited-before" ? 1 : 2);
            assert.equal(
              observations - observationsBefore,
              phase === "matching" || phase === "exited-during-health" ? 2 : 1,
            );
            assert.equal(spawns, 1);
            assert.equal(leases, 1);
            assert.equal(kills, 0);
            assert.deepEqual(yield* manager.snapshot, snapshotBefore);
            assert.equal(yield* fileSystem.readFileString(markerPath), markerBefore);
            assert.deepEqual(yield* fileSystem.readFile(credentialPath), credentialBefore);
            assert.isTrue(
              yield* fileSystem.exists(`${baseDir}/provider-daemon-ipc/provider-daemon.sock`),
            );
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
    }

  for (const phase of ["spawn", "publication"] as const) {
    it.effect(
      `finishes fresh-child recovery publication before honoring quit during ${phase}`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const baseDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "cafe-daemon-quit-",
          });
          const markerPath = `${baseDir}/provider-daemon.json`;
          const credentialPath = `${baseDir}/provider-daemon-token.bin`;
          const backendEntryPath = `${baseDir}/backend.mjs`;
          yield* fileSystem.writeFileString(backendEntryPath, "// inert quit fixture\n");
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const gated = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          );
          let spawnCalls = 0;
          let killCalls = 0;
          const handle = ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1_234_568),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () =>
              Effect.sync(() => {
                killCalls += 1;
              }),
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.fromEffect(Effect.never),
            unref: Effect.succeed(Effect.void),
          });
          const guardedSpawner: TestProcessSpawner = {
            ...spawner,
            spawn: () =>
              Effect.sync(() => {
                spawnCalls += 1;
              }).pipe(Effect.andThen(phase === "spawn" ? gated : Effect.void), Effect.as(handle)),
          };
          const safeStorage: ElectronSafeStorage.ElectronSafeStorageShape = {
            isEncryptionAvailable: Effect.succeed(true),
            encryptString: (value) =>
              (phase === "publication" ? gated : Effect.void).pipe(
                Effect.as(new TextEncoder().encode(value)),
              ),
            decryptString: (value) => Effect.succeed(new TextDecoder().decode(value)),
          };
          yield* Effect.gen(function* () {
            const manager = yield* DesktopProviderDaemonManager.DesktopProviderDaemonManager;
            const attempt = yield* manager.ensureRunning.pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            // The fixture requests only Effect cancellation; no native process
            // exists. Pending quit must not cut this ownership publication short.
            yield* Effect.sync(() => attempt.interruptUnsafe());
            yield* Deferred.succeed(release, undefined);
            const result = yield* Fiber.await(attempt);
            assert.equal(result._tag, "Failure");
            assert.isTrue(yield* fileSystem.exists(markerPath));
            assert.isTrue(yield* fileSystem.exists(credentialPath));
            assert.equal(spawnCalls, 1);
            assert.equal(killCalls, 0);
            const snapshot = yield* manager.snapshot;
            assert.equal(Option.getOrNull(snapshot.pid), 1_234_568);
            assert.equal((yield* manager.ensureRunning.pipe(Effect.exit))._tag, "Failure");
            assert.equal(spawnCalls, 1);
            assert.equal(killCalls, 0);
          }).pipe(
            Effect.provide(
              makeManagerLayer(baseDir, markerPath, backendEntryPath, safeStorage, {
                fileSystem,
                spawner: guardedSpawner,
              }),
            ),
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  for (const phase of ["readiness", "publication"] as const) {
    it.effect(
      `preserves failed-child recovery files and refuses competing spawn after ${phase} when exit stays uncertain`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const baseDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "cafe-daemon-exit-",
          });
          const markerPath = `${baseDir}/provider-daemon.json`;
          const credentialPath = `${baseDir}/provider-daemon-token.bin`;
          const backendEntryPath = `${baseDir}/backend.mjs`;
          yield* fileSystem.writeFileString(backendEntryPath, "// inert owned-child fixture\n");
          // An inert directory makes only the credential's atomic publication
          // fail. No real profile, injected process or private token is observed.
          if (phase === "publication") yield* fileSystem.makeDirectory(credentialPath);
          let spawnCalls = 0;
          const signals: string[] = [];
          const guardedSpawner: TestProcessSpawner = {
            ...spawner,
            spawn: (command) =>
              Effect.sync(() => {
                spawnCalls += 1;
                assert.equal(command._tag, "StandardCommand");
                if (command._tag === "StandardCommand") {
                  assert.equal(command.options.stdout, "ignore");
                  assert.equal(command.options.stderr, "ignore");
                  assert.deepEqual(command.options.additionalFds?.fd4, { type: "output" });
                }
                return ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(1_234_567),
                  stdout: Stream.empty,
                  stderr: Stream.empty,
                  all: Stream.empty,
                  exitCode: Effect.never,
                  isRunning: Effect.succeed(true),
                  kill: (options) => {
                    signals.push(options?.killSignal ?? "SIGTERM");
                    return Effect.never;
                  },
                  stdin: Sink.drain,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.fromEffect(Effect.never),
                  unref: Effect.succeed(Effect.void),
                });
              }),
          };
          yield* Effect.gen(function* () {
            const manager = yield* DesktopProviderDaemonManager.DesktopProviderDaemonManager;
            const attempt = yield* manager.ensureRunning.pipe(Effect.exit, Effect.forkScoped);
            // Real scoped filesystem setup settles before advancing virtual time.
            // Otherwise the startup baseline could be captured after the jump.
            if (phase === "readiness") {
              yield* fileSystem
                .exists(markerPath)
                .pipe(Effect.repeat({ until: (exists) => exists }));
              yield* TestClock.adjust(Duration.seconds(30));
            }
            yield* Effect.sync(() => signals.length).pipe(
              Effect.repeat({ until: (count) => count > 0 }),
            );
            yield* TestClock.adjust(Duration.seconds(18));
            const result = yield* Fiber.join(attempt);
            assert.equal(result._tag, "Failure");
            assert.equal(spawnCalls, 1);
            assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
            assert.equal(yield* fileSystem.exists(markerPath), phase === "readiness");
            assert.isTrue(yield* fileSystem.exists(credentialPath));
            const snapshot = yield* manager.snapshot;
            assert.equal(snapshot.status, "error");
            assert.equal(Option.getOrNull(snapshot.pid), 1_234_567);
            assert.equal(
              Option.getOrNull(snapshot.lastError),
              new DesktopProviderDaemonManager.ProviderDaemonTerminationUnconfirmedError().message,
            );
            const retry = yield* manager.ensureRunning.pipe(Effect.exit);
            assert.equal(retry._tag, "Failure");
            assert.equal(spawnCalls, 1);
            assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
            assert.equal(yield* fileSystem.exists(markerPath), phase === "readiness");
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
  }

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
        const fakeDaemon = yield* startFakeProviderDaemon(baseDir, runtimeBuildId, () => {
          requests += 1;
          return false;
        });
        yield* Effect.addFinalizer(() => fakeDaemon.close);
        const markerJson = encodeProviderDaemonMarkerJson({
          version: 2,
          mode: "provider-daemon",
          dataProfile: "production",
          dataProfileId: dataProfileIdentity("production", baseDir),
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
            const fakeDaemon = yield* startFakeProviderDaemon(
              baseDir,
              runtimeBuildId,
              (pathname) => {
                if ((pathname === PROVIDER_DAEMON_LEASES_PATH) !== (phase === "lease"))
                  return false;
                observedRequests += 1;
                if (failuresRemaining === 0) return false;
                failuresRemaining -= 1;
                return true;
              },
            );
            yield* Effect.addFinalizer(() => fakeDaemon.close);
            yield* fileSystem.writeFileString(credentialPath, TEST_TOKEN);
            const markerJson = encodeProviderDaemonMarkerJson({
              version: 2,
              mode: "provider-daemon",
              dataProfile: "production",
              dataProfileId: dataProfileIdentity("production", baseDir),
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
  it.effect("keeps rich-health observation time separate from liveness after adoption", () =>
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
      let failHealth = false;
      const fakeDaemon = yield* startFakeProviderDaemon(
        baseDir,
        runtimeBuildId,
        (pathname) => failHealth && pathname === PROVIDER_DAEMON_HEALTH_PATH,
      );
      yield* Effect.addFinalizer(() => fakeDaemon.close);
      let publishedSnapshot: Record<string, unknown> = {};
      const debugPublication = vi
        .spyOn(DesktopDebugServer, "publishProviderDaemonDebugSnapshot")
        .mockImplementation((snapshot) =>
          Effect.sync(() => {
            publishedSnapshot = snapshot;
          }),
        );
      yield* Effect.addFinalizer(() => Effect.sync(() => debugPublication.mockRestore()));
      const httpBaseUrl = `http://127.0.0.1:${fakeDaemon.port}`;

      yield* fileSystem.writeFileString(credentialPath, TEST_TOKEN);

      yield* fileSystem.writeFileString(
        markerPath,
        `${encodeProviderDaemonMarkerJson({
          version: 2,
          mode: "provider-daemon",
          dataProfile: "production",
          dataProfileId: dataProfileIdentity("production", baseDir),
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
        const adoptedHealthObservedAt = publishedSnapshot.lastHealthObservedAt;
        assert.isString(adoptedHealthObservedAt);

        yield* TestClock.adjust("6 seconds");
        assert.isTrue(Option.isSome(yield* manager.probeLiveness));
        assert.equal(publishedSnapshot.lastHealthObservedAt, adoptedHealthObservedAt);

        failHealth = true;
        assert.isTrue(Option.isNone(yield* manager.refreshHealth));
        assert.equal(publishedSnapshot.lastHealthObservedAt, adoptedHealthObservedAt);

        failHealth = false;
        assert.isTrue(Option.isSome(yield* manager.refreshHealth));
        assert.notEqual(publishedSnapshot.lastHealthObservedAt, adoptedHealthObservedAt);
        assert.isFalse(encodeDiagnosticJson(publishedSnapshot).includes(TEST_TOKEN));
        assert.isFalse(encodeDiagnosticJson(publishedSnapshot).includes(TEST_LEASE_TOKEN));
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
      const fakeDaemon = yield* startFakeProviderDaemon(baseDir, runtimeBuildId);
      yield* Effect.addFinalizer(() => fakeDaemon.close);
      const httpBaseUrl = `http://127.0.0.1:${fakeDaemon.port}`;

      // Token stored as plaintext, exactly as `writeCredential` does when the
      // OS keyring is unavailable.
      yield* fileSystem.writeFileString(credentialPath, TEST_TOKEN);

      yield* fileSystem.writeFileString(
        markerPath,
        `${encodeProviderDaemonMarkerJson({
          version: 2,
          mode: "provider-daemon",
          dataProfile: "production",
          dataProfileId: dataProfileIdentity("production", baseDir),
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
