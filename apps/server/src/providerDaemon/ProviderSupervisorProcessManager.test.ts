// @effect-diagnostics nodeBuiltinImport:off
import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as childProcess from "node:child_process";

import {
  PROVIDER_DAEMON_LEASES_PATH,
  ProviderDaemonHealth,
  ProviderDaemonLeaseResponse,
  ProviderDaemonMarker,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type {
  WindowsProviderRuntime,
  WindowsProviderRuntimeOptions,
  WindowsProviderRuntimeResult,
} from "@cafecode/shared/windowsProviderRuntime";
import { WindowsProviderRuntimeError } from "@cafecode/shared/windowsProviderRuntime";
import { dataProfileIdentity } from "@cafecode/shared/dataProfileIdentity";

import { deriveServerPaths, ensureServerDirectories, type ServerConfigShape } from "../config.ts";
import { ensureProviderSupervisorProcess } from "./ProviderSupervisorProcessManager.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: vi.fn(original.readFile),
    writeFile: vi.fn(original.writeFile),
    rm: vi.fn(original.rm),
    mkdir: vi.fn(original.mkdir),
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(() => {
      throw new Error("A default supervisor fixture must not launch a native process.");
    }),
  };
});

const TEST_TOKEN = "provider-supervisor-test-token-0000000000000000000000";
const TEST_RUNTIME_BUILD_ID = "provider-supervisor-runtime-build-test";
const TEST_WINDOWS_OWNERSHIP_ID = "9a90b48d-868f-4614-ae9c-66d50293d52b";

function fakeWindowsRuntime(ensure: WindowsProviderRuntime["ensure"]): WindowsProviderRuntime {
  return {
    ensure,
    observe: async () => {
      throw new Error("unexpected observe");
    },
    stop: async () => {
      throw new Error("unexpected stop");
    },
    recover: async () => {
      throw new Error("unexpected recover");
    },
    current: () => null,
  };
}

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

const startFakeProviderSupervisor = (
  baseDir: string,
  proof: "matching" | "missing" | "foreign" = "matching",
  onRequest?: (path: string) => void,
): Effect.Effect<FakeProviderSupervisor, FakeProviderSupervisorError> =>
  Effect.tryPromise({
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
          onRequest?.(request.url ?? "");

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
              ...(proof === "missing"
                ? {}
                : {
                    dataProfile: "production" as const,
                    dataProfileId: dataProfileIdentity(
                      "production",
                      proof === "foreign" ? `${baseDir}/foreign` : baseDir,
                    ),
                  }),
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
      httpsEnabled: false,
      httpsPort: undefined,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      configuredBaseDir: baseDir,
      dataProfile: "production",
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
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it.effect(
    "refuses fresh POSIX handoff without creating a process or mutating recovery files",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafe-supervisor-capability-",
        });
        const config = yield* makeServerConfig(baseDir);
        const credentialPath = path.join(config.secretsDir, "provider-supervisor-token");
        const socketPath = path.join(
          config.stateDir,
          "provider-supervisor-ipc",
          "provider-supervisor.sock",
        );
        yield* fileSystem.makeDirectory(path.dirname(socketPath));
        yield* fileSystem.writeFileString(credentialPath, "retained-credential");
        yield* fileSystem.writeFileString(socketPath, "retained-socket");
        const spawn = vi.mocked(childProcess.spawn);
        const write = vi.mocked(fs.writeFile);
        const remove = vi.mocked(fs.rm);
        spawn.mockClear();
        write.mockClear();
        remove.mockClear();
        const result = yield* ensureProviderSupervisorProcess(
          { config, version: "0.0.0-test" },
          { platform: "linux" },
        ).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.include(
            result.failure.message,
            "Fresh provider supervisor handoff is not supported",
          );
        assert.equal(spawn.mock.calls.length, 0);
        assert.equal(write.mock.calls.length, 0);
        assert.equal(remove.mock.calls.length, 0);
        assert.equal(yield* fileSystem.readFileString(credentialPath), "retained-credential");
        assert.equal(yield* fileSystem.readFileString(socketPath), "retained-socket");
        assert.isFalse(
          yield* fileSystem.exists(path.join(config.stateDir, "provider-supervisor.json")),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const phase of [
    "invalid-marker",
    "unknown-profile",
    "foreign-socket",
    "foreign-credential",
    "missing-health",
    "foreign-health",
  ] as const) {
    it.effect(`preserves a POSIX supervisor with ${phase} instead of replacing it`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafe-supervisor-profile-",
        });
        const config = yield* makeServerConfig(baseDir);
        const markerPath = path.join(config.stateDir, "provider-supervisor.json");
        const credentialPath = path.join(config.secretsDir, "provider-supervisor-token");
        const foreignCredentialPath = path.join(baseDir, "foreign-token");
        yield* fileSystem.writeFileString(credentialPath, TEST_TOKEN);
        yield* fileSystem.writeFileString(foreignCredentialPath, TEST_TOKEN);
        let requests = 0;
        let leases = 0;
        const proof =
          phase === "missing-health"
            ? "missing"
            : phase === "foreign-health"
              ? "foreign"
              : "matching";
        const fake = yield* startFakeProviderSupervisor(baseDir, proof, (pathname) => {
          requests += 1;
          if (pathname === PROVIDER_DAEMON_LEASES_PATH) leases += 1;
        });
        yield* Effect.addFinalizer(() => fake.close);
        const marker =
          phase === "invalid-marker"
            ? "unreadable marker contents"
            : encodeProviderDaemonMarkerJson({
                version: 2,
                mode: "provider-supervisor",
                ...(phase === "unknown-profile"
                  ? {}
                  : {
                      dataProfile: "production" as const,
                      dataProfileId: dataProfileIdentity("production", baseDir),
                    }),
                protocolVersion: 1,
                pid: process.pid,
                ppid: process.ppid,
                transport: phase === "foreign-socket" ? "ipc" : "tcp",
                ...(phase === "foreign-socket"
                  ? { socketPath: path.join(baseDir, "foreign.sock") }
                  : {}),
                httpBaseUrl: `http://127.0.0.1:${fake.port}`,
                credentialPath:
                  phase === "foreign-credential" ? foreignCredentialPath : credentialPath,
                createdAt: "1970-01-01T00:00:00.000Z",
                updatedAt: "1970-01-01T00:00:00.000Z",
                appVersion: "0.0.0-test",
                runtimeBuildId: TEST_RUNTIME_BUILD_ID,
              });
        yield* fileSystem.writeFileString(markerPath, marker);
        const read = vi.mocked(fs.readFile);
        const remove = vi.mocked(fs.rm);
        const spawn = vi.mocked(childProcess.spawn);
        read.mockClear();
        remove.mockClear();
        spawn.mockClear();
        const signals = vi.spyOn(process, "kill").mockReturnValue(true);
        const result = yield* ensureProviderSupervisorProcess(
          { config, version: "0.0.0-test", runtimeBuildId: TEST_RUNTIME_BUILD_ID },
          { platform: "linux" },
        ).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        const healthPhase = phase === "missing-health" || phase === "foreign-health";
        assert.equal(requests, healthPhase ? 1 : 0);
        assert.equal(leases, 0);
        assert.equal(spawn.mock.calls.length, 0);
        assert.equal(remove.mock.calls.length, 0);
        assert.equal(
          read.mock.calls.filter(
            ([path]) => path === credentialPath || path === foreignCredentialPath,
          ).length,
          healthPhase ? 1 : 0,
        );
        assert.isTrue(signals.mock.calls.every(([, signal]) => signal === 0));
        if (!healthPhase) assert.equal(signals.mock.calls.length, 0);
        assert.equal(yield* fileSystem.readFileString(markerPath), marker);
        assert.equal(yield* fileSystem.readFileString(credentialPath), TEST_TOKEN);
        assert.equal(yield* fileSystem.readFileString(foreignCredentialPath), TEST_TOKEN);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("adopts an existing authorized provider supervisor marker", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cafe-provider-supervisor-manager-test-",
      });
      const config = yield* makeServerConfig(baseDir);
      const fakeSupervisor = yield* startFakeProviderSupervisor(baseDir);
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
          dataProfile: "production",
          dataProfileId: dataProfileIdentity("production", baseDir),
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

      const supervisor = yield* ensureProviderSupervisorProcess(
        {
          config,
          version: "0.0.0-test",
          runtimeBuildId: TEST_RUNTIME_BUILD_ID,
        },
        {
          platform: "linux",
          createWindowsRuntime: () => {
            throw new Error("POSIX must not create a Windows controller");
          },
        },
      );

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
      assert.isFalse("windowsProcessIdentity" in supervisor.snapshot);
      assert.isFalse("windowsOwnershipId" in supervisor.snapshot);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "routes Windows supervisor ownership through the fenced runtime without legacy cleanup",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafe-windows-supervisor-",
        });
        const config = yield* makeServerConfig(baseDir);
        const markerPath = path.join(config.stateDir, "provider-supervisor.json");
        const credentialPath = path.join(config.secretsDir, "provider-supervisor-token");
        // Invalid ownership is deliberately present: the old Windows path turned
        // this into absence and spawned another process. Only the injected fenced
        // controller now receives authority to interpret it; this wrapper does not.
        yield* fileSystem.writeFileString(markerPath, "inconclusive record");
        yield* fileSystem.writeFileString(credentialPath, "retained synthetic credential");
        for (const privateFailure of [
          "access denied",
          "bad credential token=private-value",
          "helper died after mutation",
        ]) {
          let ensureCalls = 0;
          const outcome = yield* ensureProviderSupervisorProcess(
            { config, version: "0.0.0-test" },
            {
              platform: "win32",
              createWindowsRuntime: () =>
                fakeWindowsRuntime(async () => {
                  ensureCalls += 1;
                  throw new Error(privateFailure);
                }),
              spawnWindowsChild: async () => {
                throw new Error("must not spawn outside ownership controller");
              },
            },
          ).pipe(Effect.result);
          assert.equal(outcome._tag, "Failure");
          if (outcome._tag === "Failure") {
            assert.equal(
              outcome.failure.message,
              "Windows supervisor ownership: Provider supervisor ownership could not be verified. Existing processes and ownership records were preserved.",
            );
            assert.isFalse(outcome.failure.message.includes(privateFailure));
          }
          assert.equal(ensureCalls, 1);
          assert.equal(yield* fileSystem.readFileString(markerPath), "inconclusive record");
          assert.equal(
            yield* fileSystem.readFileString(credentialPath),
            "retained synthetic credential",
          );
        }
        const legacyError = new WindowsProviderRuntimeError("legacy-identity-unknown");
        legacyError.message = "private mutated exception details";
        const legacyOutcome = yield* ensureProviderSupervisorProcess(
          { config, version: "0.0.0-test" },
          {
            platform: "win32",
            createWindowsRuntime: () =>
              fakeWindowsRuntime(async () => {
                throw legacyError;
              }),
          },
        ).pipe(Effect.result);
        assert.equal(legacyOutcome._tag, "Failure");
        if (legacyOutcome._tag === "Failure") {
          assert.include(legacyOutcome.failure.message, "guided legacy recovery");
          assert.notInclude(legacyOutcome.failure.message, "private mutated");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects mismatched Windows profile intent before directory or native-process work",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafe-windows-profile-refusal-",
        });
        const config = yield* makeServerConfig(baseDir);
        for (const operation of [fs.mkdir, fs.readFile, fs.writeFile, fs.rm])
          vi.mocked(operation).mockClear();
        const outcome = yield* ensureProviderSupervisorProcess(
          {
            config: { ...config, configuredBaseDir: path.join(baseDir, "foreign") },
            version: "0.0.0-test",
          },
          { platform: "win32" },
        ).pipe(Effect.result);
        assert.equal(outcome._tag, "Failure");
        if (outcome._tag === "Failure") assert.include(outcome.failure.message, "profile-mismatch");
        assert.equal(vi.mocked(fs.mkdir).mock.calls.length, 0);
        assert.equal(vi.mocked(fs.readFile).mock.calls.length, 0);
        assert.equal(vi.mocked(fs.writeFile).mock.calls.length, 0);
        assert.equal(vi.mocked(fs.rm).mock.calls.length, 0);
        assert.equal(vi.mocked(childProcess.spawn).mock.calls.length, 0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "configures Windows supervisor generation, private bootstrap and plaintext credential policy",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafe-windows-supervisor-config-",
        });
        const config = yield* makeServerConfig(baseDir);
        const profile = {
          dataProfile: "production" as const,
          dataProfileId: dataProfileIdentity("production", baseDir),
        };
        const health = {
          ...profile,
          ok: true,
          mode: "provider-supervisor",
          pid: 27,
          ppid: 1,
          version: "0.0.0-test",
          protocolVersion: 1,
          startedAt: "2026-09-27T00:00:00.000Z",
          activeSessionCount: 0,
          configuredInstanceCount: 0,
          eventCursor: 0,
          windowsOwnershipId: TEST_WINDOWS_OWNERSHIP_ID,
          windowsProcessIdentity: { pid: 27, creationTime100ns: "134348901321234567" },
        } as const;
        const endpoint = {
          httpBaseUrl: "http://provider-supervisor.local",
          transport: "ipc",
          socketPath: "\\\\.\\pipe\\synthetic",
          token: TEST_TOKEN,
          leaseId: "synthetic-lease-00000000",
        } as const;
        const result = {
          endpoint,
          rootEndpoint: endpoint,
          health,
          adopted: true,
          ownershipId: TEST_WINDOWS_OWNERSHIP_ID,
          marker: {
            ...profile,
            version: 2,
            mode: "provider-supervisor",
            pid: 27,
            httpBaseUrl: endpoint.httpBaseUrl,
            credentialPath: path.join(
              config.secretsDir,
              `provider-supervisor-token.${TEST_WINDOWS_OWNERSHIP_ID}`,
            ),
            createdAt: health.startedAt,
            updatedAt: health.startedAt,
            appVersion: "0.0.0-test",
            windowsOwnershipId: TEST_WINDOWS_OWNERSHIP_ID,
            windowsProcessIdentity: health.windowsProcessIdentity,
            windowsOwnershipState: "committed",
          },
        } satisfies WindowsProviderRuntimeResult;
        let configured: WindowsProviderRuntimeOptions | undefined;
        let spawnCalls = 0;
        const supervisor = yield* ensureProviderSupervisorProcess(
          { config, version: "0.0.0-test", runtimeBuildId: TEST_RUNTIME_BUILD_ID },
          {
            platform: "win32",
            createWindowsRuntime: (options) => {
              configured = options;
              return fakeWindowsRuntime(async () => result);
            },
            spawnWindowsChild: async (options) => {
              spawnCalls += 1;
              assert.equal(options.bootstrap.mode, "provider-supervisor");
              assert.equal(options.bootstrap.dataProfile, profile.dataProfile);
              assert.equal(options.bootstrap.configuredCafeCodeHome, config.configuredBaseDir);
              assert.equal(options.bootstrap.cafeCodeHome, config.baseDir);
              assert.equal(options.bootstrap.windowsOwnershipId, TEST_WINDOWS_OWNERSHIP_ID);
              assert.equal(options.bootstrap.token, TEST_TOKEN);
              assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
              assert.equal(options.env.CAFE_CODE_MODE, undefined);
              assert.equal(options.cwd, config.cwd);
              return { pid: 27, hasExited: () => false };
            },
          },
        );
        assert.equal(supervisor.snapshot.pid, 27);
        assert.equal(supervisor.snapshot.adoptedExistingProcess, true);
        assert.deepEqual(supervisor.snapshot.windowsProcessIdentity, health.windowsProcessIdentity);
        assert.equal(supervisor.snapshot.windowsOwnershipId, TEST_WINDOWS_OWNERSHIP_ID);
        assert.equal(supervisor.snapshot.credentialPath, result.marker.credentialPath);
        assert.equal(supervisor.endpoint, endpoint);
        assert.equal(spawnCalls, 0);
        assert.ok(configured);
        assert.equal(configured.role, "provider-supervisor");
        assert.equal(configured.dataProfile, profile.dataProfile);
        assert.equal(configured.dataProfileId, profile.dataProfileId);
        assert.equal(configured.bootstrap.dataProfile, profile.dataProfile);
        assert.equal(configured.bootstrap.configuredCafeCodeHome, config.configuredBaseDir);
        assert.equal(configured.bootstrap.cafeCodeHome, config.baseDir);
        // Windows must retain shared absolute deadlines/byte limits instead of
        // overriding them with the legacy POSIX idle-timeout HTTP helpers.
        assert.isUndefined(configured.fetchHealth);
        assert.isUndefined(configured.issueLease);
        assert.equal(configured.markerPath, path.join(config.stateDir, "provider-supervisor.json"));
        assert.equal(
          configured.legacyCredentialPath,
          path.join(config.secretsDir, "provider-supervisor-token"),
        );
        assert.isTrue(
          configured.socketPath.startsWith("\\\\.\\pipe\\cafecode-provider-supervisor-"),
        );
        const encoded = yield* Effect.promise(() => configured!.encodeCredential(TEST_TOKEN));
        assert.equal(encoded.encrypted, false);
        assert.equal(
          yield* Effect.promise(() => configured!.decodeCredential(encoded.base64, false)),
          TEST_TOKEN,
        );
        const invalidCredential = yield* Effect.tryPromise(() =>
          configured!.decodeCredential(encoded.base64, true),
        ).pipe(Effect.result);
        assert.equal(invalidCredential._tag, "Failure");
        yield* Effect.promise(() =>
          configured!.spawn({
            ...configured!.bootstrap,
            mode: "provider-supervisor",
            transport: "ipc",
            socketPath: configured!.socketPath,
            token: TEST_TOKEN,
            windowsOwnershipId: TEST_WINDOWS_OWNERSHIP_ID,
          }),
        );
        assert.equal(spawnCalls, 1);
        // Even an injected adapter result must retain both exact receipts;
        // neither saved marker metadata nor native health backfills the other.
        for (const phase of ["marker", "health"] as const) {
          const changed = {
            ...result,
            [phase]: {
              ...result[phase],
              dataProfileId: dataProfileIdentity("production", path.join(baseDir, "foreign")),
            },
          };
          const refused = yield* ensureProviderSupervisorProcess(
            { config, version: "0.0.0-test" },
            {
              platform: "win32",
              createWindowsRuntime: () => fakeWindowsRuntime(async () => changed),
            },
          ).pipe(Effect.result);
          assert.equal(refused._tag, "Failure");
          if (refused._tag === "Failure")
            assert.include(refused.failure.message, "profile-mismatch");
        }
        assert.equal(spawnCalls, 1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
