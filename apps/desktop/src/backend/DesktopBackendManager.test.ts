import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import { BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE } from "@cafecode/shared/backendStartupFailure";
import { uiText } from "@cafecode/shared/i18n";
import { encodeBackendMigrationProgress } from "@cafecode/shared/backendStartupProgress";
import {
  BACKEND_READINESS_CHALLENGE_HEADER,
  BACKEND_READINESS_PROOF_HEADER,
  createBackendReadinessProof,
  isBackendReadinessValue,
} from "@cafecode/shared/backendReadiness";

const decodeDesktopBackendBootstrap = Schema.decodeEffect(
  Schema.fromJsonString(DesktopBackendBootstrap),
);
// Observation-only JSON snapshots retain native JSON field/value semantics.
const encodeDiagnosticJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const baseConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    cafeCodeHome: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

const configWithObservability: DesktopBackendBootstrapValue = {
  ...baseConfig.bootstrap,
  otlpTracesUrl: "http://127.0.0.1:4318/v1/traces",
};

function makeProcess(options?: {
  readonly stdout?: Stream.Stream<Uint8Array>;
  readonly stderr?: Stream.Stream<Uint8Array>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
  readonly isRunning?: Effect.Effect<boolean>;
  readonly progress?: Stream.Stream<Uint8Array>;
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: options?.stdout ?? Stream.empty,
    stderr: options?.stderr ?? Stream.empty,
    all: Stream.merge(options?.stdout ?? Stream.empty, options?.stderr ?? Stream.empty),
    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: options?.isRunning ?? Effect.succeed(true),
    kill: options?.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: (fd) => (fd === 4 ? (options?.progress ?? Stream.empty) : Stream.empty),
    unref: Effect.succeed(Effect.void),
  });
}

function responseForRequest(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(request, new Response(null, { status }));
}

function httpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
    signal: AbortSignal,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, _url, signal) => handler(request, signal)),
  );
}

const healthyHttpClientLayer = httpClientLayer((request) =>
  Effect.succeed(responseForRequest(request, 200)),
);

function decodeBootstrap(raw: string) {
  return decodeDesktopBackendBootstrap(raw);
}

function makeManagerLayer(input: {
  readonly spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly backendOutputLog?: Partial<DesktopObservability.DesktopBackendOutputLogShape>;
  readonly desktopState?: DesktopState.DesktopStateShape;
  readonly desktopWindow?: Partial<DesktopWindow.DesktopWindowShape>;
  readonly electronDialog?: Partial<ElectronDialog.ElectronDialogShape>;
  readonly config?: DesktopBackendManager.DesktopBackendStartConfig;
  readonly readinessProof?: (token: string, challenge: string) => string | undefined;
  readonly onBootstrap?: (bootstrap: DesktopBackendBootstrapValue) => void;
}) {
  // Each layer owns the exact private fd3 opening token of its synthetic child.
  // No module-global secret or mock-only manager input can qualify readiness.
  // Capture before returning the real fixture's handle so its first HTTP probe
  // cannot outrun successful fake-child opening.
  return Layer.unwrap(
    Effect.sync(() => {
      let currentToken: string | undefined;
      const observedSpawner = Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          return ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              assert.equal(command._tag, "StandardCommand");
              if (command._tag !== "StandardCommand")
                throw new Error("Expected a standard command.");
              const fd3 = command.options.additionalFds?.fd3;
              assert.equal(fd3?.type, "input");
              if (fd3?.type !== "input" || !fd3.stream)
                throw new Error("Expected private fd3 input.");
              const bootstrap = yield* decodeBootstrap(
                yield* fd3.stream.pipe(Stream.decodeText(), Stream.mkString),
              ).pipe(Effect.orDie);
              assert.isTrue(isBackendReadinessValue(bootstrap.desktopReadinessToken));
              currentToken = bootstrap.desktopReadinessToken;
              input.onBootstrap?.(bootstrap);
              return yield* spawner.spawn(command);
            }),
          );
        }),
      ).pipe(Layer.provide(input.spawnerLayer));
      const observedHttp = Layer.effect(
        HttpClient.HttpClient,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          // Transform the existing transport rather than nesting another make:
          // trace propagation may clone a request, so a second transport would
          // create a distinct controller instead of observing the probe's scope.
          return HttpClient.transform(client, (effect, request) =>
            Effect.suspend(() => {
              const token = currentToken;
              const challenge = request.headers[BACKEND_READINESS_CHALLENGE_HEADER];
              assert.isTrue(isBackendReadinessValue(token));
              assert.isTrue(isBackendReadinessValue(challenge));
              return effect.pipe(
                Effect.map((response) => {
                  const proof = (input.readinessProof ?? createBackendReadinessProof)(
                    token!,
                    challenge!,
                  );
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response(null, {
                      status: response.status,
                      headers: {
                        ...response.headers,
                        ...(proof === undefined ? {} : { [BACKEND_READINESS_PROOF_HEADER]: proof }),
                      },
                    }),
                  );
                }),
              );
            }),
          );
        }),
      ).pipe(Layer.provide(input.httpClientLayer ?? healthyHttpClientLayer));
      return DesktopBackendManager.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            FileSystem.layerNoop({
              exists: () => Effect.succeed(true),
            }),
            Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
              resolve: Effect.succeed(input.config ?? baseConfig),
            }),
            observedSpawner,
            observedHttp,
            Layer.succeed(ElectronDialog.ElectronDialog, {
              pickFolder: () => Effect.die("unexpected profile-refusal folder picker"),
              confirm: () => Effect.die("unexpected profile-refusal confirmation"),
              showMessageBox: () => Effect.die("unexpected profile-refusal message box"),
              showErrorBox: () => Effect.void,
              ...input.electronDialog,
            }),
            input.desktopState
              ? Layer.succeed(DesktopState.DesktopState, input.desktopState)
              : DesktopState.layer,
            Layer.succeed(DesktopObservability.DesktopBackendOutputLog, {
              writeSessionBoundary: () => Effect.void,
              writeOutputChunk: () => Effect.void,
              ...input.backendOutputLog,
            } satisfies DesktopObservability.DesktopBackendOutputLogShape),
            Layer.succeed(DesktopWindow.DesktopWindow, {
              createMain: Effect.die("unexpected createMain"),
              ensureMain: Effect.die("unexpected ensureMain"),
              revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
              activate: Effect.void,
              createMainIfBackendReady: Effect.void,
              handleBackendReady: Effect.void,
              dispatchMenuAction: () => Effect.void,
              syncAppearance: Effect.void,
              ...input.desktopWindow,
            } satisfies DesktopWindow.DesktopWindowShape),
          ),
        ),
      );
    }),
  );
}

describe("DesktopBackendManager", () => {
  const profiledConfig = (
    profile: "production" | "debug",
  ): DesktopBackendManager.DesktopBackendStartConfig => {
    const configuredRoot = NodePath.resolve("backend-startup-refusal-fixture");
    return {
      ...baseConfig,
      bootstrap: {
        ...baseConfig.bootstrap,
        dataProfile: profile,
        configuredCafeCodeHome: configuredRoot,
        cafeCodeHome:
          profile === "debug" ? NodePath.join(configuredRoot, ".debug") : configuredRoot,
      },
    };
  };

  it("keeps stale exits and incomplete profile proof inert in the actual exit policy", () => {
    const bootstrap = profiledConfig("debug").bootstrap;
    const currentRun = { id: 2, authenticatedReady: false };
    assert.equal(
      DesktopBackendManager.classifyDesktopBackendExit({
        exitingRunId: 1,
        currentRun,
        exitCode: BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE,
        bootstrap,
      }),
      "stale",
    );
    assert.deepEqual(currentRun, { id: 2, authenticatedReady: false });
    assert.equal(
      DesktopBackendManager.classifyDesktopBackendExit({
        exitingRunId: 1,
        currentRun: undefined,
        exitCode: BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE,
        bootstrap,
      }),
      "stale",
    );
    for (const [opening, ready, code] of [
      [baseConfig.bootstrap, false, BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE],
      [
        { ...bootstrap, configuredCafeCodeHome: undefined },
        false,
        BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE,
      ],
      [bootstrap, true, BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE],
      [bootstrap, false, 1],
    ] as const) {
      assert.equal(
        DesktopBackendManager.classifyDesktopBackendExit({
          exitingRunId: 2,
          currentRun: { id: 2, authenticatedReady: ready },
          exitCode: code,
          bootstrap: opening,
        }),
        "ordinary",
      );
    }
  });

  for (const profile of ["production", "debug"] as const) {
    it.effect(
      `stops automatic retries and shows one safe error only after the exact ${profile} child refuses startup`,
      () =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const nativeExited = yield* Deferred.make<void>();
          const notified = yield* Deferred.make<void>();
          const dialogs: Array<{ title: string; content: string }> = [];
          let spawns = 0;
          let readyCount = 0;
          const managerLayer = makeManagerLayer({
            config: profiledConfig(profile),
            spawnerLayer: Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.sync(() => {
                  spawns += 1;
                  return makeProcess({
                    exitCode: Deferred.await(nativeExited).pipe(
                      Effect.as(
                        ChildProcessSpawner.ExitCode(BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE),
                      ),
                    ),
                    kill: () => Deferred.succeed(nativeExited, undefined).pipe(Effect.asVoid),
                  });
                }),
              ),
            ),
            httpClientLayer: httpClientLayer(() => Effect.never),
            // onStarted installs the exact PID and termination handle before
            // emitting START. A spawner invocation alone precedes ownership.
            backendOutputLog: {
              writeSessionBoundary: ({ phase }) =>
                phase === "START"
                  ? Deferred.succeed(started, undefined).pipe(Effect.asVoid)
                  : Effect.void,
            },
            desktopWindow: {
              handleBackendReady: Effect.sync(() => {
                readyCount += 1;
              }),
            },
            electronDialog: {
              showErrorBox: (title, content) =>
                Effect.sync(() => {
                  dialogs.push({ title, content });
                }).pipe(Effect.andThen(Deferred.succeed(notified, undefined))),
            },
          });
          yield* Effect.gen(function* () {
            const manager = yield* DesktopBackendManager.DesktopBackendManager;
            yield* manager.start;
            yield* Deferred.await(started);
            assert.equal(dialogs.length, 0);
            assert.deepEqual((yield* manager.snapshot).activePid, Option.some(123));
            yield* manager.start;
            assert.equal(spawns, 1, "a held child cannot be replaced before native exit");
            yield* Deferred.succeed(nativeExited, undefined);
            yield* Deferred.await(notified);
            const refused = yield* manager.snapshot;
            assert.equal(refused.desiredRunning, false);
            assert.equal(refused.ready, false);
            assert.equal(refused.restartScheduled, false);
            assert.isTrue(Option.isNone(refused.activePid));
            assert.equal(readyCount, 0);
            assert.equal(dialogs.length, 1);
            const rendered = encodeDiagnosticJson(dialogs);
            assert.equal(dialogs[0]?.title, uiText("Cafe Code data profile could not start"));
            assert.isTrue((dialogs[0]?.content.length ?? 0) > 0);
            assert.notInclude(rendered, profiledConfig(profile).bootstrap.cafeCodeHome);
            assert.notInclude(rendered, "desktopReadinessToken");
            yield* TestClock.adjust(Duration.seconds(30));
            assert.equal(spawns, 1);
            assert.equal(dialogs.length, 1);
            yield* manager.stop();
          }).pipe(
            Effect.ensuring(Deferred.succeed(nativeExited, undefined)),
            Effect.provide(Layer.merge(TestClock.layer(), managerLayer)),
          );
        }),
    );
  }

  for (const stopped of ["explicit-stop", "quitting"] as const) {
    it.effect(`does not surface a startup refusal after ${stopped}`, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const nativeExited = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const backendReady = yield* Ref.make(false);
        const quitting = yield* Ref.make(false);
        let dialogs = 0;
        const managerLayer = makeManagerLayer({
          config: profiledConfig("debug"),
          desktopState: { backendReady, quitting },
          spawnerLayer: Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.sync(() => {
                return makeProcess({
                  exitCode: Deferred.await(nativeExited).pipe(
                    Effect.as(
                      ChildProcessSpawner.ExitCode(BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE),
                    ),
                  ),
                  kill: () => Deferred.succeed(nativeExited, undefined).pipe(Effect.asVoid),
                });
              }),
            ),
          ),
          httpClientLayer: httpClientLayer(() => Effect.never),
          backendOutputLog: {
            writeSessionBoundary: ({ phase }) =>
              phase === "START"
                ? Deferred.succeed(started, undefined).pipe(Effect.asVoid)
                : phase === "END"
                  ? Deferred.succeed(finished, undefined).pipe(Effect.asVoid)
                  : Effect.void,
          },
          electronDialog: {
            showErrorBox: () =>
              Effect.sync(() => {
                dialogs += 1;
              }),
          },
        });
        yield* Effect.gen(function* () {
          const manager = yield* DesktopBackendManager.DesktopBackendManager;
          yield* manager.start;
          yield* Deferred.await(started);
          if (stopped === "explicit-stop") yield* manager.stop();
          else {
            yield* Ref.set(quitting, true);
            yield* Deferred.succeed(nativeExited, undefined);
          }
          yield* Deferred.await(finished);
          yield* TestClock.adjust(Duration.seconds(30));
          assert.equal(dialogs, 0);
          assert.equal((yield* manager.snapshot).restartScheduled, false);
          yield* manager.stop();
        }).pipe(
          Effect.ensuring(Deferred.succeed(nativeExited, undefined)),
          Effect.provide(Layer.merge(TestClock.layer(), managerLayer)),
        );
      }),
    );
  }

  for (const firstProbe of ["missing-proof", "http-error", "timeout"] as const) {
    it.effect(
      `retires a held ${firstProbe} response before retry and closes the positive probe before Ready`,
      () =>
        Effect.gen(function* () {
          const firstRequested = yield* Deferred.make<void>();
          const ready = yield* Deferred.make<void>();
          const nativeExited = yield* Deferred.make<void>();
          const signals: AbortSignal[] = [];
          let requestCount = 0;
          let bodyReads = 0;
          let readyCount = 0;
          const managerLayer = makeManagerLayer({
            spawnerLayer: Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.succeed(
                  makeProcess({
                    exitCode: Deferred.await(nativeExited).pipe(
                      Effect.as(ChildProcessSpawner.ExitCode(0)),
                    ),
                    kill: () => Deferred.succeed(nativeExited, undefined).pipe(Effect.asVoid),
                  }),
                ),
              ),
            ),
            // This is the pinned HttpClient.make's real transport AbortSignal,
            // not a test-created controller or a mocked cancellation receipt.
            httpClientLayer: httpClientLayer((request, signal) =>
              Effect.gen(function* () {
                if (signals.length > 0) assert.equal(signals.at(-1)?.aborted, true);
                signals.push(signal);
                requestCount += 1;
                yield* Deferred.succeed(firstRequested, undefined);
                if (requestCount === 1 && firstProbe === "timeout") return yield* Effect.never;
                const heldBody = new ReadableStream<Uint8Array>(
                  {
                    pull: () => {
                      bodyReads += 1;
                      throw new Error("Readiness must not consume the held public response body.");
                    },
                  },
                  { highWaterMark: 0 },
                );
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(heldBody, {
                    status: requestCount === 1 && firstProbe === "http-error" ? 503 : 200,
                  }),
                );
              }),
            ),
            readinessProof: (token, challenge) =>
              requestCount === 1 && firstProbe === "missing-proof"
                ? undefined
                : createBackendReadinessProof(token, challenge),
            desktopWindow: {
              handleBackendReady: Effect.sync(() => {
                assert.equal(
                  signals.every((signal) => signal.aborted),
                  true,
                );
                assert.equal(
                  bodyReads,
                  0,
                  "a readiness proof must not drain public response bodies",
                );
                readyCount += 1;
              }).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
            },
          });
          yield* Effect.gen(function* () {
            const manager = yield* DesktopBackendManager.DesktopBackendManager;
            yield* manager.start;
            yield* Deferred.await(firstRequested);
            yield* TestClock.adjust(Duration.millis(firstProbe === "timeout" ? 1_100 : 100));
            yield* Deferred.await(ready);
            assert.equal(requestCount, 2);
            assert.equal(readyCount, 1);
            assert.equal(
              signals.every((signal) => signal.aborted),
              true,
            );
            yield* manager.stop();
          }).pipe(
            Effect.ensuring(Deferred.succeed(nativeExited, undefined)),
            Effect.provide(Layer.merge(TestClock.layer(), managerLayer)),
          );
        }),
    );
  }

  it.effect("sanitizes invalid private bootstrap before spawn or rendered diagnostics", () =>
    Effect.gen(function* () {
      const failureLogged = yield* Deferred.make<void>();
      const diagnostics: string[] = [];
      const browserSecret = "private-browser-bootstrap-fixture-sentinel";
      const staleReadinessSecret = "e".repeat(64);
      let spawns = 0;
      let readyCount = 0;
      const logger = Logger.map(Logger.formatStructured, (record) => {
        diagnostics.push(JSON.stringify(record));
        if (record.annotations.reason === "Failed to encode desktop backend bootstrap payload.") {
          Effect.runSync(Deferred.succeed(failureLogged, undefined));
        }
      });
      const managerLayer = makeManagerLayer({
        config: {
          ...baseConfig,
          bootstrap: {
            ...baseConfig.bootstrap,
            port: -1,
            desktopBootstrapToken: browserSecret,
            desktopReadinessToken: staleReadinessSecret,
          },
        },
        spawnerLayer: Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.sync(() => {
              spawns += 1;
              return makeProcess();
            }),
          ),
        ),
        desktopWindow: {
          handleBackendReady: Effect.sync(() => {
            readyCount += 1;
          }),
        },
      });
      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        yield* Deferred.await(failureLogged);
        const rendered = diagnostics.join("\n");
        assert.include(rendered, "Failed to encode desktop backend bootstrap payload.");
        for (const privateValue of [
          browserSecret,
          staleReadinessSecret,
          "desktopBootstrapToken",
          "desktopReadinessToken",
        ])
          assert.notInclude(rendered, privateValue);
        assert.equal(spawns, 0);
        assert.equal(readyCount, 0);
        assert.equal((yield* manager.snapshot).ready, false);
        yield* manager.stop();
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            TestClock.layer(),
            managerLayer,
            Logger.layer([logger], { mergeWithExisting: false }),
          ),
        ),
      );
    }),
  );

  for (const invalidPeer of ["missing", "wrong-owner", "malformed"] as const) {
    it.effect(
      `does not admit a 200 listener with ${invalidPeer} proof or release its live writer`,
      () =>
        Effect.gen(function* () {
          const nativeExited = yield* Deferred.make<void>();
          const probed = yield* Deferred.make<void>();
          const killed = yield* Deferred.make<void>();
          let readyCount = 0;
          let spawns = 0;
          const managerLayer = makeManagerLayer({
            config: { ...baseConfig, readinessTimeout: Duration.seconds(1) },
            spawnerLayer: Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.sync(() => {
                  spawns += 1;
                  return makeProcess({
                    exitCode: Deferred.await(nativeExited).pipe(
                      Effect.as(ChildProcessSpawner.ExitCode(0)),
                    ),
                    kill: () => Deferred.succeed(killed, undefined).pipe(Effect.asVoid),
                  });
                }),
              ),
            ),
            httpClientLayer: httpClientLayer((request) =>
              Deferred.succeed(probed, undefined).pipe(Effect.as(responseForRequest(request, 200))),
            ),
            readinessProof: (_token, challenge) => {
              if (invalidPeer === "missing") return undefined;
              if (invalidPeer === "malformed") return "not a finite proof";
              return createBackendReadinessProof("0".repeat(64), challenge);
            },
            desktopWindow: {
              handleBackendReady: Effect.sync(() => {
                readyCount += 1;
              }),
            },
          });
          yield* Effect.gen(function* () {
            const manager = yield* DesktopBackendManager.DesktopBackendManager;
            yield* manager.start;
            yield* Deferred.await(probed);
            yield* TestClock.adjust(Duration.seconds(1));
            yield* Deferred.await(killed);
            assert.equal(readyCount, 0);
            assert.equal((yield* manager.snapshot).ready, false);
            assert.deepEqual((yield* manager.snapshot).activePid, Option.some(123));
            yield* manager.start;
            assert.equal(spawns, 1, "a failed listener proof cannot release an unexited child");
            yield* Deferred.succeed(nativeExited, undefined);
            yield* manager.stop();
          }).pipe(
            Effect.ensuring(Deferred.succeed(nativeExited, undefined)),
            Effect.provide(Layer.merge(TestClock.layer(), managerLayer)),
          );
        }),
    );
  }

  it.effect(
    "rejects replay of an earlier probe's valid proof before accepting a fresh challenge",
    () =>
      Effect.gen(function* () {
        const probes = yield* Queue.unbounded<number>();
        const ready = yield* Deferred.make<void>();
        const nativeExited = yield* Deferred.make<void>();
        const challenges: string[] = [];
        const proofs: string[] = [];
        let readyCount = 0;
        let requestCount = 0;
        const managerLayer = makeManagerLayer({
          spawnerLayer: Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.succeed(
                makeProcess({
                  exitCode: Deferred.await(nativeExited).pipe(
                    Effect.as(ChildProcessSpawner.ExitCode(0)),
                  ),
                  kill: () => Deferred.succeed(nativeExited, undefined).pipe(Effect.asVoid),
                }),
              ),
            ),
          ),
          httpClientLayer: httpClientLayer((request) =>
            Effect.gen(function* () {
              requestCount += 1;
              yield* Queue.offer(probes, requestCount);
              return responseForRequest(request, requestCount === 1 ? 503 : 200);
            }),
          ),
          readinessProof: (token, challenge) => {
            challenges.push(challenge);
            const proof = createBackendReadinessProof(token, challenge);
            proofs.push(proof);
            return proofs.length === 2 ? proofs[0] : proof;
          },
          desktopWindow: {
            handleBackendReady: Effect.sync(() => {
              readyCount += 1;
            }).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
          },
        });
        yield* Effect.gen(function* () {
          const manager = yield* DesktopBackendManager.DesktopBackendManager;
          yield* manager.start;
          assert.equal(yield* Queue.take(probes), 1);
          yield* TestClock.adjust(Duration.millis(100));
          assert.equal(yield* Queue.take(probes), 2);
          assert.equal(readyCount, 0, "an old valid HMAC does not qualify a new probe");
          assert.equal((yield* manager.snapshot).ready, false);
          yield* TestClock.adjust(Duration.millis(100));
          assert.equal(yield* Queue.take(probes), 3);
          yield* Deferred.await(ready);
          assert.equal(readyCount, 1);
          assert.equal(new Set(challenges).size, 3);
          assert.equal((yield* manager.snapshot).ready, true);
          yield* manager.stop();
        }).pipe(
          Effect.ensuring(Deferred.succeed(nativeExited, undefined)),
          Effect.provide(Layer.merge(TestClock.layer(), managerLayer)),
        );
      }),
  );

  it.effect(
    "mints a new key per actual spawn and refuses a prior run despite identical saved bootstrap",
    () =>
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const probes = yield* Queue.unbounded<number>();
        const ready = yield* Queue.unbounded<number>();
        const firstExited = yield* Deferred.make<void>();
        const secondExited = yield* Deferred.make<void>();
        const tokens: string[] = [];
        const challenges: string[] = [];
        const staleSuppliedToken = "f".repeat(64);
        let spawns = 0;
        let readyCount = 0;
        let secondOwnerMatches = false;
        const managerLayer = makeManagerLayer({
          config: {
            ...baseConfig,
            bootstrap: { ...baseConfig.bootstrap, desktopReadinessToken: staleSuppliedToken },
          },
          onBootstrap: (bootstrap) => tokens.push(bootstrap.desktopReadinessToken!),
          spawnerLayer: Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.gen(function* () {
                spawns += 1;
                const exited = spawns === 1 ? firstExited : secondExited;
                yield* Queue.offer(starts, spawns);
                return makeProcess({
                  exitCode: Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(1))),
                  kill: () => Deferred.succeed(exited, undefined).pipe(Effect.asVoid),
                });
              }),
            ),
          ),
          httpClientLayer: httpClientLayer((request) =>
            Effect.gen(function* () {
              const challenge = request.headers[BACKEND_READINESS_CHALLENGE_HEADER];
              assert.isDefined(challenge);
              challenges.push(challenge);
              // Only a public nonce enters HTTP. Neither the actual child key nor
              // the stale supplied key may appear in URL, headers or other fields.
              const outgoing = encodeDiagnosticJson({ url: request.url, headers: request.headers });
              for (const token of [...tokens, staleSuppliedToken])
                assert.notInclude(outgoing, token);
              yield* Queue.offer(probes, spawns);
              return responseForRequest(request, 200);
            }),
          ),
          readinessProof: (token, challenge) =>
            createBackendReadinessProof(
              tokens.length === 2 && !secondOwnerMatches ? tokens[0]! : token,
              challenge,
            ),
          desktopWindow: {
            handleBackendReady: Effect.suspend(() => {
              readyCount += 1;
              return Queue.offer(ready, readyCount).pipe(Effect.asVoid);
            }),
          },
        });
        yield* Effect.gen(function* () {
          const manager = yield* DesktopBackendManager.DesktopBackendManager;
          yield* manager.start;
          assert.equal(yield* Queue.take(starts), 1);
          assert.equal(yield* Queue.take(probes), 1);
          assert.equal(yield* Queue.take(ready), 1);
          yield* Deferred.succeed(firstExited, undefined);
          yield* TestClock.adjust(Duration.millis(500));
          assert.equal(yield* Queue.take(starts), 2);
          assert.equal(yield* Queue.take(probes), 2);
          yield* TestClock.adjust(Duration.millis(100));
          assert.equal(yield* Queue.take(probes), 2);
          assert.equal(readyCount, 1);
          assert.equal((yield* manager.snapshot).ready, false);
          assert.equal(tokens.length, 2);
          assert.equal(new Set([...tokens, staleSuppliedToken]).size, 3);
          secondOwnerMatches = true;
          yield* TestClock.adjust(Duration.millis(100));
          assert.equal(yield* Queue.take(ready), 2);
          assert.equal((yield* manager.snapshot).ready, true);
          assert.equal(new Set(challenges).size, challenges.length);
          yield* manager.stop();
        }).pipe(
          Effect.ensuring(
            Effect.all([
              Deferred.succeed(firstExited, undefined),
              Deferred.succeed(secondExited, undefined),
            ]),
          ),
          Effect.provide(Layer.merge(TestClock.layer(), managerLayer)),
        );
      }),
  );

  it.effect(
    "retires watchdog readiness for an unrelated 200 responder without releasing its native child",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const killed = yield* Deferred.make<void>();
        const nativeExited = yield* Deferred.make<void>();
        const challenges: string[] = [];
        let authenticated = true;
        let spawns = 0;
        let readyCount = 0;
        const managerLayer = makeManagerLayer({
          config: {
            ...baseConfig,
            healthCheckInterval: Duration.seconds(1),
            healthFailureThreshold: 3,
          },
          spawnerLayer: Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.sync(() => {
                spawns += 1;
                return makeProcess({
                  exitCode: Deferred.await(nativeExited).pipe(
                    Effect.as(ChildProcessSpawner.ExitCode(0)),
                  ),
                  kill: () => Deferred.succeed(killed, undefined).pipe(Effect.asVoid),
                });
              }),
            ),
          ),
          readinessProof: (token, challenge) => {
            challenges.push(challenge);
            return authenticated ? createBackendReadinessProof(token, challenge) : undefined;
          },
          desktopWindow: {
            handleBackendReady: Effect.sync(() => {
              readyCount += 1;
            }).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
          },
        });
        yield* Effect.gen(function* () {
          const manager = yield* DesktopBackendManager.DesktopBackendManager;
          yield* manager.start;
          yield* Deferred.await(ready);
          assert.equal((yield* manager.snapshot).ready, true);
          authenticated = false;
          yield* TestClock.adjust(Duration.seconds(3));
          yield* Deferred.await(killed);
          assert.equal(readyCount, 1);
          assert.equal(challenges.length, 4);
          assert.equal(new Set(challenges).size, challenges.length);
          const retained = yield* manager.snapshot;
          assert.equal(retained.ready, false);
          assert.equal(retained.restartScheduled, false);
          assert.deepEqual(retained.activePid, Option.some(123));
          yield* manager.start;
          assert.equal(spawns, 1);
          yield* Deferred.succeed(nativeExited, undefined);
          yield* manager.stop();
        }).pipe(
          Effect.ensuring(Deferred.succeed(nativeExited, undefined)),
          Effect.provide(Layer.merge(TestClock.layer(), managerLayer)),
        );
      }),
  );

  it.effect("spawns the backend with fd3 bootstrap JSON and reports HTTP readiness", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.Command | undefined;
      let bootstrapJson = "";
      let readyCount = 0;
      const ready = yield* Deferred.make<void>();
      const exited = yield* Queue.unbounded<void>();

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            spawnedCommand = command;
            if (command._tag === "StandardCommand") {
              const fd3 = command.options.additionalFds?.fd3;
              if (fd3?.type === "input" && fd3.stream) {
                bootstrapJson = yield* fd3.stream.pipe(Stream.decodeText(), Stream.mkString);
              }
            }

            return makeProcess({
              exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        config: {
          ...baseConfig,
          bootstrap: configWithObservability,
        },
        spawnerLayer,
        desktopWindow: {
          handleBackendReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0))),
        },
        backendOutputLog: {
          writeSessionBoundary: ({ phase }) =>
            phase === "END" ? Queue.offer(exited, void 0).pipe(Effect.asVoid) : Effect.void,
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.isDefined(spawnedCommand);
        if (spawnedCommand._tag !== "StandardCommand") {
          throw new Error("Expected backend to spawn a standard command.");
        }

        assert.equal(spawnedCommand.command, "/electron");
        assert.deepEqual(spawnedCommand.args, ["/server/bin.mjs", "--bootstrap-fd", "3"]);
        assert.equal(spawnedCommand.options.cwd, "/server");
        assert.equal(spawnedCommand.options.extendEnv, true);
        assert.equal(spawnedCommand.options.stdout, "pipe");
        assert.equal(spawnedCommand.options.stderr, "pipe");
        assert.equal(spawnedCommand.options.killSignal, "SIGTERM");
        assert.isDefined(spawnedCommand.options.forceKillAfter);
        assert.equal(
          Duration.toMillis(Duration.fromInputUnsafe(spawnedCommand.options.forceKillAfter)),
          2_000,
        );

        const receivedBootstrap = yield* decodeBootstrap(bootstrapJson);
        assert.isTrue(isBackendReadinessValue(receivedBootstrap.desktopReadinessToken));
        assert.deepEqual(receivedBootstrap, {
          ...configWithObservability,
          desktopReadinessToken: receivedBootstrap.desktopReadinessToken,
          startupProgressFd: 4,
        });
        assert.deepEqual(spawnedCommand.options.additionalFds?.fd4, { type: "output" });
      }).pipe(Effect.provide(managerLayer));
    }),
  );

  it.effect("retries HTTP readiness before reporting the backend ready", () =>
    Effect.gen(function* () {
      const requestUrls: Array<string> = [];
      const statuses = [503, 200];
      let readyCount = 0;
      const firstRequest = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const exited = yield* Queue.unbounded<void>();

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            }),
          ),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer((request) =>
          Effect.gen(function* () {
            const status = statuses.shift();
            assert.isDefined(status);
            requestUrls.push(request.url);
            yield* Deferred.succeed(firstRequest, void 0);
            return responseForRequest(request, status);
          }),
        ),
        desktopWindow: {
          handleBackendReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0))),
        },
        backendOutputLog: {
          writeSessionBoundary: ({ phase }) =>
            phase === "END" ? Queue.offer(exited, void 0).pipe(Effect.asVoid) : Effect.void,
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        yield* Deferred.await(firstRequest);

        assert.equal(readyCount, 0);
        assert.deepEqual(requestUrls, ["http://127.0.0.1:3773/.well-known/cafe-code/environment"]);

        yield* TestClock.adjust(Duration.millis(100));
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.deepEqual(requestUrls, [
          "http://127.0.0.1:3773/.well-known/cafe-code/environment",
          "http://127.0.0.1:3773/.well-known/cafe-code/environment",
        ]);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("starts the configured backend and closes the scoped process on stop", () =>
    Effect.gen(function* () {
      let startCount = 0;
      let closedCount = 0;
      const closed = yield* Deferred.make<void>();
      const startedPids = yield* Queue.unbounded<number>();
      const ready = yield* Deferred.make<void>();
      const backendReady = yield* Ref.make(false);
      const quitting = yield* Ref.make(false);

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            startCount += 1;
            yield* Queue.offer(startedPids, 123);
            const close = Effect.sync(() => {
              closedCount += 1;
            }).pipe(Effect.andThen(Deferred.succeed(closed, void 0)), Effect.asVoid);

            yield* Scope.addFinalizer(scope, close);

            return makeProcess({
              exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              kill: () => close,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        desktopState: {
          backendReady,
          quitting,
        },
        desktopWindow: {
          handleBackendReady: Deferred.succeed(ready, void 0).pipe(Effect.asVoid),
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        assert.isTrue(Option.isNone(yield* manager.currentConfig));

        yield* manager.start;
        assert.equal(yield* Queue.take(startedPids), 123);
        yield* Deferred.await(ready);
        assert.isTrue(yield* Ref.get(backendReady));
        assert.deepEqual(yield* manager.currentConfig, Option.some(baseConfig));

        const runningSnapshot = yield* manager.snapshot;
        assert.equal(runningSnapshot.ready, true);
        assert.deepEqual(runningSnapshot.activePid, Option.some(123));

        yield* manager.stop();
        assert.equal(startCount, 1);
        assert.isTrue(closedCount >= 1);

        const stoppedSnapshot = yield* manager.snapshot;
        assert.isFalse(yield* Ref.get(backendReady));
        assert.equal(stoppedSnapshot.desiredRunning, false);
        assert.equal(stoppedSnapshot.ready, false);
        assert.equal(Option.isNone(stoppedSnapshot.activePid), true);
      }).pipe(Effect.provide(managerLayer));
    }),
  );

  it.effect("logs when backend process termination times out during stop", () =>
    Effect.gen(function* () {
      const messages: string[] = [];
      const logger = Logger.make(({ message }) => {
        messages.push(String(message));
      });
      const started = yield* Deferred.make<void>();
      const nativeExited = yield* Deferred.make<void>();
      let startCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            startCount += 1;
            yield* Deferred.succeed(started, void 0);
            return makeProcess({
              exitCode: Deferred.await(nativeExited).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
              kill: () => Effect.never,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({ spawnerLayer });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        yield* Deferred.await(started);

        const stopFiber = yield* Effect.forkDetach(manager.stop({ timeout: Duration.seconds(1) }));
        yield* Effect.yieldNow;

        const stoppingSnapshot = yield* manager.snapshot;
        assert.equal(stoppingSnapshot.desiredRunning, false);
        assert.equal(stoppingSnapshot.ready, false);
        assert.deepEqual(stoppingSnapshot.activePid, Option.some(123));

        yield* TestClock.adjust(Duration.seconds(1));
        yield* Fiber.join(stopFiber);

        assert.isTrue(
          messages.some((message) => message.includes("backend close timed out during stop")),
        );
        yield* manager.start;
        assert.equal(startCount, 1);
        assert.deepEqual((yield* manager.snapshot).activePid, Option.some(123));
        yield* Deferred.succeed(nativeExited, undefined);
        yield* TestClock.adjust(Duration.seconds(5));
      }).pipe(
        Effect.ensuring(Deferred.succeed(nativeExited, undefined)),
        Effect.provide(
          Layer.mergeAll(
            TestClock.layer(),
            managerLayer,
            Logger.layer([logger], { mergeWithExisting: false }),
          ),
        ),
      );
    }),
  );

  it.effect("restarts an unexpectedly exited backend with the Effect clock", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      let startCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            startCount += 1;
            return makeProcess({
              exitCode: Queue.offer(starts, startCount).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(1)),
              ),
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer(() => Effect.never),
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;

        assert.equal(yield* Queue.take(starts), 1);

        yield* TestClock.adjust(Duration.millis(499));
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(starts), 2);

        yield* TestClock.adjust(Duration.millis(999));
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(starts), 3);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("does not replace a readiness-failed owner until its exact native exit", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const nativeExited = yield* Deferred.make<void>();
      let startCount = 0;
      let killCount = 0;
      let readinessRequests = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            startCount += 1;
            yield* Queue.offer(starts, startCount);
            return makeProcess({
              exitCode: Deferred.await(nativeExited).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
              kill: () =>
                Effect.sync(() => {
                  killCount += 1;
                }).pipe(Effect.asVoid),
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer(() =>
          Effect.sync(() => {
            readinessRequests += 1;
          }).pipe(Effect.andThen(Effect.never)),
        ),
        config: {
          ...baseConfig,
          readinessTimeout: Duration.zero,
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 1);

        for (let attempts = 0; attempts < 100; attempts += 1) {
          if (readinessRequests > 0) {
            break;
          }
          yield* Effect.yieldNow;
        }
        assert.equal(readinessRequests > 0, true);

        for (let elapsedSeconds = 0; elapsedSeconds < 65; elapsedSeconds += 1) {
          if (killCount > 0) {
            break;
          }
          yield* TestClock.adjust(Duration.seconds(1));
          yield* Effect.yieldNow;
        }
        assert.equal(killCount > 0, true);

        for (let elapsedMs = 0; elapsedMs < 2_000; elapsedMs += 100) {
          if ((yield* Queue.size(starts)) > 0) {
            break;
          }
          yield* TestClock.adjust(Duration.millis(100));
          yield* Effect.yieldNow;
        }
        assert.equal(yield* Queue.size(starts), 0);
        assert.equal(startCount, 1);
        assert.deepEqual((yield* manager.snapshot).activePid, Option.some(123));
        assert.equal((yield* manager.snapshot).restartScheduled, false);
        yield* manager.start;
        assert.equal(startCount, 1);
        yield* Deferred.succeed(nativeExited, undefined);
        yield* TestClock.adjust(Duration.millis(500));
        assert.equal(yield* Queue.take(starts), 2);
      }).pipe(
        Effect.ensuring(Deferred.succeed(nativeExited, undefined)),
        Effect.provide(Layer.merge(TestClock.layer(), managerLayer)),
      );
    }),
  );

  it.effect(
    "allows an owned migration with log capture disabled and closes its reader on stop",
    () =>
      Effect.gen(function* () {
        const progress = yield* Queue.unbounded<Uint8Array>();
        const ready = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<void>();
        let healthy = false;
        let killed = false;
        let readerClosed = false;
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                exitCode: Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                kill: () =>
                  Effect.sync(() => {
                    killed = true;
                  }).pipe(Effect.andThen(Deferred.succeed(exited, undefined)), Effect.asVoid),
                progress: Stream.fromQueue(progress).pipe(
                  Stream.ensuring(
                    Effect.sync(() => {
                      readerClosed = true;
                    }),
                  ),
                ),
              }),
            ),
          ),
        );
        const managerLayer = makeManagerLayer({
          spawnerLayer,
          config: { ...baseConfig, captureOutput: false, readinessTimeout: Duration.seconds(2) },
          httpClientLayer: httpClientLayer((request) =>
            healthy ? Effect.succeed(responseForRequest(request, 200)) : Effect.never,
          ),
          desktopWindow: {
            handleBackendReady: Deferred.succeed(ready, void 0).pipe(Effect.asVoid),
          },
        });
        yield* Effect.gen(function* () {
          const manager = yield* DesktopBackendManager.DesktopBackendManager;
          yield* manager.start;
          yield* Queue.offer(
            progress,
            new TextEncoder().encode(
              encodeBackendMigrationProgress({ phase: "start", migrationId: 92 }),
            ),
          );
          yield* TestClock.adjust(Duration.seconds(10));
          assert.equal(killed, false);
          assert.equal((yield* manager.snapshot).ready, false);
          healthy = true;
          yield* Queue.offer(
            progress,
            new TextEncoder().encode(
              encodeBackendMigrationProgress({ phase: "complete", migrationId: 92 }),
            ),
          );
          yield* TestClock.adjust(Duration.millis(1_500));
          yield* Deferred.await(ready);
          assert.equal((yield* manager.snapshot).ready, true);
          assert.equal(killed, false);
          yield* manager.stop();
          yield* Effect.yieldNow;
          assert.equal(readerClosed, true);
        }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
      }),
  );

  it.effect(
    "terminates a stalled migration at the absolute cap despite repeated progress starts",
    () =>
      Effect.gen(function* () {
        const progress = yield* Queue.unbounded<Uint8Array>();
        const nativeExited = yield* Deferred.make<void>();
        let killCount = 0;
        const managerLayer = makeManagerLayer({
          spawnerLayer: Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.succeed(
                makeProcess({
                  exitCode: Deferred.await(nativeExited).pipe(
                    Effect.as(ChildProcessSpawner.ExitCode(0)),
                  ),
                  kill: () =>
                    Effect.sync(() => {
                      killCount += 1;
                    }).pipe(
                      Effect.andThen(Deferred.succeed(nativeExited, undefined)),
                      Effect.asVoid,
                    ),
                  progress: Stream.fromQueue(progress),
                }),
              ),
            ),
          ),
          config: { ...baseConfig, readinessTimeout: Duration.seconds(2) },
          httpClientLayer: httpClientLayer(() => Effect.never),
        });
        yield* Effect.gen(function* () {
          const manager = yield* DesktopBackendManager.DesktopBackendManager;
          yield* manager.start;
          const frame = new TextEncoder().encode(
            encodeBackendMigrationProgress({ phase: "start", migrationId: 92 }),
          );
          yield* Queue.offer(progress, frame);
          yield* TestClock.adjust(Duration.seconds(599));
          assert.equal(killCount, 0);
          yield* Queue.offer(progress, frame);
          yield* TestClock.adjust(Duration.seconds(1));
          yield* Effect.yieldNow;
          assert.equal(killCount > 0, true);
        }).pipe(
          Effect.ensuring(Deferred.succeed(nativeExited, undefined)),
          Effect.provide(Layer.merge(TestClock.layer(), managerLayer)),
        );
      }),
  );

  it.effect("does not grant migration time to stdout or malformed private frames", () =>
    Effect.gen(function* () {
      let killCount = 0;
      const nativeExited = yield* Deferred.make<void>();
      const frame = new TextEncoder().encode(
        encodeBackendMigrationProgress({ phase: "start", migrationId: 92 }),
      );
      const managerLayer = makeManagerLayer({
        spawnerLayer: Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                exitCode: Deferred.await(nativeExited).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
                kill: () =>
                  Effect.sync(() => {
                    killCount += 1;
                  }).pipe(Effect.andThen(Deferred.succeed(nativeExited, undefined)), Effect.asVoid),
                stdout: Stream.make(frame),
                progress: Stream.make(new TextEncoder().encode("x".repeat(97))),
              }),
            ),
          ),
        ),
        config: { ...baseConfig, readinessTimeout: Duration.seconds(2) },
        httpClientLayer: httpClientLayer(() => Effect.never),
      });
      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        yield* TestClock.adjust(Duration.seconds(2));
        yield* Effect.yieldNow;
        assert.equal(killCount > 0, true);
      }).pipe(
        Effect.ensuring(Deferred.succeed(nativeExited, undefined)),
        Effect.provide(Layer.merge(TestClock.layer(), managerLayer)),
      );
    }),
  );

  it.effect("restarts a ready backend after repeated health check failures", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const firstReady = yield* Deferred.make<void>();
      let startCount = 0;
      let killCount = 0;
      let healthy = true;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            startCount += 1;
            yield* Queue.offer(starts, startCount);
            const killed = yield* Deferred.make<void>();
            const kill = Effect.sync(() => {
              killCount += 1;
            }).pipe(Effect.andThen(Deferred.succeed(killed, void 0)), Effect.asVoid);
            return makeProcess({
              exitCode: Deferred.await(killed).pipe(Effect.as(ChildProcessSpawner.ExitCode(1))),
              kill: () => kill,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer((request) =>
          Effect.succeed(responseForRequest(request, healthy ? 200 : 503)),
        ),
        config: {
          ...baseConfig,
          healthFailureThreshold: 3,
        },
        desktopWindow: {
          handleBackendReady: Deferred.succeed(firstReady, void 0).pipe(Effect.asVoid),
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 1);
        yield* Deferred.await(firstReady);

        healthy = false;
        yield* TestClock.adjust(Duration.seconds(45));
        yield* Effect.yieldNow;
        assert.equal(killCount > 0, true);

        yield* TestClock.adjust(Duration.millis(500));
        assert.equal(yield* Queue.take(starts), 2);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("keeps a ready backend alive across transient health check stalls", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const firstReady = yield* Deferred.make<void>();
      let startCount = 0;
      let killCount = 0;
      let healthy = true;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            startCount += 1;
            yield* Queue.offer(starts, startCount);
            const killed = yield* Deferred.make<void>();
            const kill = Effect.sync(() => {
              killCount += 1;
            }).pipe(Effect.andThen(Deferred.succeed(killed, void 0)), Effect.asVoid);
            return makeProcess({
              exitCode: Deferred.await(killed).pipe(Effect.as(ChildProcessSpawner.ExitCode(1))),
              kill: () => kill,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer((request) =>
          Effect.succeed(responseForRequest(request, healthy ? 200 : 503)),
        ),
        config: {
          ...baseConfig,
          healthCheckInterval: Duration.seconds(1),
        },
        desktopWindow: {
          handleBackendReady: Deferred.succeed(firstReady, void 0).pipe(Effect.asVoid),
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 1);
        yield* Deferred.await(firstReady);

        healthy = false;
        yield* TestClock.adjust(Duration.seconds(5));
        yield* Effect.yieldNow;
        assert.equal(killCount, 0);
        assert.equal(yield* Queue.size(starts), 0);

        healthy = true;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.yieldNow;
        assert.equal(killCount, 0);
        assert.equal(yield* Queue.size(starts), 0);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("retires health readiness without replacing an owner that has not exited", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const firstReady = yield* Deferred.make<void>();
      const nativeExited = yield* Deferred.make<void>();
      let startCount = 0;
      let killCount = 0;
      let healthy = true;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            startCount += 1;
            yield* Queue.offer(starts, startCount);
            return makeProcess({
              exitCode: Deferred.await(nativeExited).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
              kill: () =>
                Effect.sync(() => {
                  killCount += 1;
                }).pipe(Effect.asVoid),
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer((request) =>
          Effect.succeed(responseForRequest(request, healthy ? 200 : 503)),
        ),
        config: {
          ...baseConfig,
          healthFailureThreshold: 3,
        },
        desktopWindow: {
          handleBackendReady: Deferred.succeed(firstReady, void 0).pipe(Effect.asVoid),
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 1);
        yield* Deferred.await(firstReady);

        healthy = false;
        yield* TestClock.adjust(Duration.seconds(45));
        yield* Effect.yieldNow;
        assert.equal(killCount > 0, true);

        yield* TestClock.adjust(Duration.millis(500));
        assert.equal(yield* Queue.size(starts), 0);
        assert.equal(startCount, 1);
        const retained = yield* manager.snapshot;
        assert.equal(retained.ready, false);
        assert.equal(retained.restartScheduled, false);
        assert.deepEqual(retained.activePid, Option.some(123));
        yield* manager.start;
        assert.equal(startCount, 1);
        yield* Deferred.succeed(nativeExited, undefined);
      }).pipe(
        Effect.ensuring(Deferred.succeed(nativeExited, undefined)),
        Effect.provide(Layer.merge(TestClock.layer(), managerLayer)),
      );
    }),
  );

  it.effect("cancels a scheduled restart when start is requested manually", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const secondClosed = yield* Deferred.make<void>();
      let startCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            startCount += 1;
            yield* Queue.offer(starts, startCount);

            if (startCount === 1) {
              return makeProcess({
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              });
            }

            const scope = yield* Scope.Scope;
            const close = Deferred.succeed(secondClosed, void 0).pipe(Effect.asVoid);
            yield* Scope.addFinalizer(scope, close);
            return makeProcess({
              exitCode: Deferred.await(secondClosed).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
              kill: () => close,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer(() => Effect.never),
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;

        assert.equal(yield* Queue.take(starts), 1);

        let restartScheduled = false;
        while (!restartScheduled) {
          restartScheduled = (yield* manager.snapshot).restartScheduled;
          if (!restartScheduled) {
            yield* Effect.yieldNow;
          }
        }

        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 2);

        yield* manager.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("does not restart after stop cancels a scheduled restart", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      let startCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            startCount += 1;
            return makeProcess({
              exitCode: Queue.offer(starts, startCount).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(1)),
              ),
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer(() => Effect.never),
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 1);

        let restartScheduled = false;
        while (!restartScheduled) {
          restartScheduled = (yield* manager.snapshot).restartScheduled;
          if (!restartScheduled) {
            yield* Effect.yieldNow;
          }
        }

        yield* manager.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
        assert.equal((yield* manager.snapshot).desiredRunning, false);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );
});
