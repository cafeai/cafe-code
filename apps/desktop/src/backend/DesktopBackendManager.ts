import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@cafecode/contracts";
import { CAFE_CODE_ENVIRONMENT_ENDPOINT_PATH } from "@cafecode/shared/environmentEndpoint";

import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  matchesDesktopBackendProcess,
  reapMatchingUnixProcesses,
  type DesktopProcessSnapshot,
} from "./DesktopProcessReaper.ts";

const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
const DEFAULT_BACKEND_READINESS_TIMEOUT = Duration.minutes(1);
const DEFAULT_BACKEND_READINESS_INTERVAL = Duration.millis(100);
const DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT = Duration.seconds(1);
// The post-readiness watchdog is deliberately more patient than bootstrap readiness. On large
// long-running workspaces, legitimate SQLite/projection requests can briefly occupy the backend
// event loop for more than one second; treating those short stalls as process death causes the
// renderer to enter an avoidable reconnect loop and interrupts provider handoff work.
const DEFAULT_BACKEND_HEALTH_REQUEST_TIMEOUT = Duration.seconds(5);
const DEFAULT_BACKEND_TERMINATE_GRACE = Duration.seconds(2);
const DEFAULT_BACKEND_HEALTH_CHECK_INTERVAL = Duration.seconds(15);
const DEFAULT_BACKEND_HEALTH_FAILURE_THRESHOLD = 6;
const BACKEND_READINESS_PATH = CAFE_CODE_ENVIRONMENT_ENDPOINT_PATH;

type BackendProcessLayerServices = ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient;

type BackendProcessRunRequirements = BackendProcessLayerServices | Scope.Scope;

export type BackendProcessOutputStream = "stdout" | "stderr";

export interface DesktopBackendStartConfig {
  readonly executablePath: string;
  readonly entryPath: string;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly bootstrap: DesktopBackendBootstrapValue;
  readonly httpBaseUrl: URL;
  readonly captureOutput: boolean;
  readonly readinessTimeout?: Duration.Duration;
  readonly healthCheckInterval?: Duration.Duration;
  readonly healthCheckRequestTimeout?: Duration.Duration;
  readonly healthFailureThreshold?: number;
}

interface BackendProcessExit {
  readonly code: Option.Option<number>;
  readonly reason: string;
}

export class BackendTimeoutError extends Data.TaggedError("BackendTimeoutError")<{
  readonly url: URL;
}> {
  override get message() {
    return `Timed out waiting for backend readiness at ${this.url.href}.`;
  }
}

class BackendProcessBootstrapEncodeError extends Data.TaggedError(
  "BackendProcessBootstrapEncodeError",
)<{
  readonly cause: Schema.SchemaError;
}> {
  override get message() {
    return `Failed to encode desktop backend bootstrap payload: ${this.cause.message}`;
  }
}

class BackendProcessSpawnError extends Data.TaggedError("BackendProcessSpawnError")<{
  readonly cause: PlatformError.PlatformError;
}> {
  override get message() {
    return `Failed to spawn desktop backend process: ${this.cause.message}`;
  }
}

class BackendHealthCheckFailedError extends Data.TaggedError("BackendHealthCheckFailedError")<{
  readonly url: URL;
  readonly consecutiveFailures: number;
}> {
  override get message() {
    return `Backend health check failed ${this.consecutiveFailures} consecutive times at ${this.url.href}.`;
  }
}

type BackendProcessError = BackendProcessBootstrapEncodeError | BackendProcessSpawnError;

interface RunBackendProcessOptions extends DesktopBackendStartConfig {
  readonly onStarted?: (pid: number, terminate: Effect.Effect<void>) => Effect.Effect<void>;
  readonly onReady?: () => Effect.Effect<void>;
  readonly onReadinessFailure?: (error: BackendTimeoutError) => Effect.Effect<void>;
  readonly onHealthFailure?: (error: BackendHealthCheckFailedError) => Effect.Effect<void>;
  readonly onOutput?: (
    streamName: BackendProcessOutputStream,
    chunk: Uint8Array,
  ) => Effect.Effect<void>;
}

export interface DesktopBackendSnapshot {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly activePid: Option.Option<number>;
  readonly restartAttempt: number;
  readonly restartScheduled: boolean;
}

export interface DesktopBackendManagerShape {
  readonly start: Effect.Effect<void>;
  readonly stop: (options?: { readonly timeout?: Duration.Duration }) => Effect.Effect<void>;
  readonly currentConfig: Effect.Effect<Option.Option<DesktopBackendStartConfig>>;
  readonly snapshot: Effect.Effect<DesktopBackendSnapshot>;
}

export class DesktopBackendManager extends Context.Service<
  DesktopBackendManager,
  DesktopBackendManagerShape
>()("cafecode/desktop/BackendManager") {}

const { logWarning: logBackendManagerWarning, logError: logBackendManagerError } =
  DesktopObservability.makeComponentLogger("desktop-backend-manager");

const reapStaleDesktopBackendProcesses = (
  entryPath: string,
  keepPids: ReadonlyArray<number | undefined>,
): Effect.Effect<void> => {
  const keepPidSet = new Set(keepPids.filter((pid): pid is number => pid !== undefined && pid > 0));
  return reapMatchingUnixProcesses({
    keepPids: keepPidSet,
    matches: (processSnapshot: DesktopProcessSnapshot) =>
      matchesDesktopBackendProcess(processSnapshot, entryPath),
  }).pipe(
    Effect.flatMap((results) =>
      Effect.forEach(
        results,
        (result) =>
          logBackendManagerWarning("reaped stale desktop backend process", {
            pid: result.pid,
            ppid: result.ppid,
            signalSent: result.signalSent,
            escalated: result.escalated,
            stillAlive: result.stillAlive,
            ...(result.error !== null ? { error: result.error } : {}),
          }),
        { concurrency: 1 },
      ),
    ),
    Effect.asVoid,
  );
};

interface ActiveBackendRun {
  readonly id: number;
  readonly closeScope: Effect.Effect<void>;
  readonly fiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly pid: Option.Option<number>;
  readonly terminate: Option.Option<Effect.Effect<void>>;
  readonly exited: Deferred.Deferred<void>;
}

interface BackendManagerState {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly config: Option.Option<DesktopBackendStartConfig>;
  readonly active: Option.Option<ActiveBackendRun>;
  readonly restartAttempt: number;
  readonly restartFiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly nextRunId: number;
}

const initialState: BackendManagerState = {
  desiredRunning: false,
  ready: false,
  config: Option.none(),
  active: Option.none(),
  restartAttempt: 0,
  restartFiber: Option.none(),
  nextRunId: 1,
};

const activePid = (active: Option.Option<ActiveBackendRun>): Option.Option<number> =>
  Option.flatMap(active, (run) => run.pid);

const withActiveRun =
  (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
  (state: BackendManagerState): BackendManagerState => ({
    ...state,
    active: Option.map(state.active, (run) => (run.id === runId ? f(run) : run)),
  });

const calculateRestartDelay = (attempt: number): Duration.Duration =>
  Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);

const signalBackendPid = (run: ActiveBackendRun, signal: NodeJS.Signals): Effect.Effect<void> =>
  Option.match(run.pid, {
    onNone: () => Effect.void,
    onSome: (pid) =>
      Effect.sync(() => {
        try {
          process.kill(pid, signal);
        } catch {
          // Ignore races with backend processes that already exited.
        }
      }),
  });

const closeRun = (
  run: ActiveBackendRun,
  options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<"closed" | "timed-out"> => {
  const terminate = Option.match(run.terminate, {
    onNone: () => Effect.void,
    onSome: (kill) => kill,
  });
  const waitForFiber = Option.match(run.fiber, {
    onNone: () => Effect.void,
    onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
  });

  const timeout = options?.timeout;
  if (!timeout) {
    const close = Effect.gen(function* () {
      if (Option.isNone(run.terminate)) {
        yield* run.closeScope;
      } else {
        yield* terminate;
      }
      yield* waitForFiber;
    });
    return close.pipe(Effect.as("closed" as const));
  }

  const close = Effect.gen(function* () {
    if (Option.isNone(run.terminate)) {
      yield* run.closeScope.pipe(Effect.ignore, Effect.forkDetach);
    }
    yield* signalBackendPid(run, "SIGTERM");
    yield* terminate.pipe(Effect.ignore, Effect.forkDetach);
    yield* Effect.sleep(Duration.min(timeout, Duration.seconds(1))).pipe(
      Effect.andThen(signalBackendPid(run, "SIGKILL")),
      Effect.forkDetach,
    );
    yield* Deferred.await(run.exited);
  });

  return Effect.gen(function* () {
    const closeFiber = yield* Effect.forkDetach(close);
    return yield* Effect.race(
      Fiber.await(closeFiber).pipe(Effect.as("closed" as const)),
      Effect.sleep(timeout).pipe(Effect.as("timed-out" as const)),
    );
  });
};

const readinessUrlFor = (baseUrl: URL): URL => new URL(BACKEND_READINESS_PATH, baseUrl);

const checkHttpReadyOnce = Effect.fn("desktop.backendManager.checkHttpReadyOnce")(function* (
  baseUrl: URL,
  requestTimeout: Duration.Duration = DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT,
): Effect.fn.Return<boolean, never, HttpClient.HttpClient> {
  const readinessUrl = readinessUrlFor(baseUrl);
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.transformResponse(Effect.timeout(requestTimeout)),
  );

  return yield* client.get(readinessUrl).pipe(
    Effect.timeout(requestTimeout),
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
});

const waitForHttpReady = Effect.fn("desktop.backendManager.waitForHttpReady")(function* (
  baseUrl: URL,
  timeout: Duration.Duration,
): Effect.fn.Return<void, BackendTimeoutError, HttpClient.HttpClient> {
  const readinessUrl = readinessUrlFor(baseUrl);
  yield* Effect.gen(function* () {
    while (true) {
      if (yield* checkHttpReadyOnce(baseUrl)) {
        return;
      }
      yield* Effect.sleep(DEFAULT_BACKEND_READINESS_INTERVAL);
    }
  }).pipe(
    Effect.timeout(timeout),
    Effect.mapError(() => new BackendTimeoutError({ url: readinessUrl })),
  );
});

const monitorHttpHealth = Effect.fn("desktop.backendManager.monitorHttpHealth")(function* (
  baseUrl: URL,
  interval: Duration.Duration,
  requestTimeout: Duration.Duration,
  failureThreshold: number,
  onFailure: (error: BackendHealthCheckFailedError) => Effect.Effect<void>,
): Effect.fn.Return<void, never, HttpClient.HttpClient> {
  const readinessUrl = readinessUrlFor(baseUrl);
  let consecutiveFailures = 0;

  while (true) {
    yield* Effect.sleep(interval);
    const healthy = yield* checkHttpReadyOnce(baseUrl, requestTimeout);
    if (healthy) {
      if (consecutiveFailures > 0) {
        yield* Effect.logInfo("desktop.backend.health-check.recovered", {
          url: readinessUrl.href,
          recoveredAfterFailures: consecutiveFailures,
        });
      }
      consecutiveFailures = 0;
      continue;
    }

    consecutiveFailures += 1;
    yield* Effect.logWarning("desktop.backend.health-check.failed", {
      url: readinessUrl.href,
      consecutiveFailures,
      failureThreshold,
    });
    if (consecutiveFailures >= failureThreshold) {
      yield* onFailure(
        new BackendHealthCheckFailedError({
          url: readinessUrl,
          consecutiveFailures,
        }),
      ).pipe(Effect.ignore);
      return;
    }
  }
});

function describeProcessExit(
  result: Result.Result<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
): BackendProcessExit {
  if (Result.isSuccess(result)) {
    return {
      code: Option.some(result.success),
      reason: `code=${result.success}`,
    };
  }

  return {
    code: Option.none(),
    reason: result.failure.message,
  };
}

function describeSyntheticProcessExit(reason: string): BackendProcessExit {
  return {
    code: Option.none(),
    reason,
  };
}

function drainBackendOutput(
  streamName: BackendProcessOutputStream,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  onOutput: (streamName: BackendProcessOutputStream, chunk: Uint8Array) => Effect.Effect<void>,
): Effect.Effect<void> {
  return stream.pipe(
    Stream.runForEach((chunk) => onOutput(streamName, chunk)),
    Effect.ignore,
  );
}

const encodeBootstrapJson = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

const runBackendProcess = Effect.fn("runBackendProcess")(function* (
  options: RunBackendProcessOptions,
): Effect.fn.Return<BackendProcessExit, BackendProcessError, BackendProcessRunRequirements> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const processScope = yield* Scope.Scope;
  const bootstrapJson = yield* encodeBootstrapJson(options.bootstrap).pipe(
    Effect.mapError((cause) => new BackendProcessBootstrapEncodeError({ cause })),
  );
  const onOutput = options.onOutput ?? (() => Effect.void);
  const command = ChildProcess.make(
    options.executablePath,
    [options.entryPath, "--bootstrap-fd", "3"],
    {
      cwd: options.cwd,
      env: options.env,
      extendEnv: true,
      // In Electron main, process.execPath points to the Electron binary.
      // Run the child in Node mode so this backend process does not become a GUI app instance.
      stdin: "ignore",
      stdout: options.captureOutput ? "pipe" : "inherit",
      stderr: options.captureOutput ? "pipe" : "inherit",
      killSignal: "SIGTERM",
      forceKillAfter: DEFAULT_BACKEND_TERMINATE_GRACE,
      additionalFds: {
        fd3: {
          type: "input",
          stream: Stream.encodeText(Stream.make(`${bootstrapJson}\n`)),
        },
      },
    },
  );

  const handle = yield* spawner
    .spawn(command)
    .pipe(Effect.mapError((cause) => new BackendProcessSpawnError({ cause })));

  const terminate = handle.kill().pipe(Effect.ignore);
  const terminalFailureExit = yield* Deferred.make<BackendProcessExit>();
  const terminateFailedRun = Effect.fn("desktop.backendManager.terminateFailedRun")(function* (
    reason: string,
  ) {
    // ChildProcessHandle.kill normally waits for process termination. A wedged Node child can
    // acknowledge SIGTERM while keeping inherited handles alive indefinitely, so waiting for that
    // effect before publishing terminal state would reproduce the same manager deadlock this path
    // exists to recover from. Start termination independently, then let the manager finalize this
    // run immediately. Before the replacement binds, start() performs a narrowly scoped backend
    // process reap that excludes provider daemons and supervisors.
    yield* handle.kill().pipe(Effect.ignore, Effect.forkDetach);
    yield* Deferred.succeed(terminalFailureExit, describeSyntheticProcessExit(reason)).pipe(
      Effect.ignore,
    );
  });
  yield* options.onStarted?.(handle.pid, terminate) ?? Effect.void;
  if (options.captureOutput) {
    yield* drainBackendOutput("stdout", handle.stdout, onOutput).pipe(Effect.forkScoped);
    yield* drainBackendOutput("stderr", handle.stderr, onOutput).pipe(Effect.forkScoped);
  }
  const healthFailureThreshold = Math.max(
    1,
    Math.trunc(options.healthFailureThreshold ?? DEFAULT_BACKEND_HEALTH_FAILURE_THRESHOLD),
  );
  const healthCheckInterval = options.healthCheckInterval ?? DEFAULT_BACKEND_HEALTH_CHECK_INTERVAL;
  const healthCheckRequestTimeout =
    options.healthCheckRequestTimeout ?? DEFAULT_BACKEND_HEALTH_REQUEST_TIMEOUT;
  yield* waitForHttpReady(
    options.httpBaseUrl,
    options.readinessTimeout ?? DEFAULT_BACKEND_READINESS_TIMEOUT,
  ).pipe(
    Effect.tap(() => options.onReady?.() ?? Effect.void),
    Effect.tap(() =>
      monitorHttpHealth(
        options.httpBaseUrl,
        healthCheckInterval,
        healthCheckRequestTimeout,
        healthFailureThreshold,
        (error) =>
          Effect.gen(function* () {
            yield* (options.onHealthFailure?.(error) ?? Effect.void).pipe(Effect.ignore);
            // A backend can lose its HTTP listener while process-level liveness remains true. In
            // that split-brain state the renderer cannot reconnect, and waiting only for exitCode can
            // wedge the desktop manager forever if the child ignores SIGTERM or has lingering fibers.
            // Treat the health failure itself as a terminal run signal so the manager clears active
            // state and starts a fresh backend; the next spawn reaps the stale child before binding.
            yield* terminateFailedRun(error.message);
          }),
      ).pipe(Effect.forkIn(processScope)),
    ),
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* (options.onReadinessFailure?.(error) ?? Effect.void).pipe(Effect.ignore);
        // Readiness timeout is terminal for this run even when the spawned child remains alive.
        // Otherwise the outer race waits forever on exitCode and the scheduled restart never runs.
        yield* terminateFailedRun(error.message);
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const reason = Cause.pretty(cause);
        yield* Effect.logWarning("desktop.backend.readiness-monitor.failed", {
          cause: reason,
        });
        yield* terminateFailedRun(reason);
      }),
    ),
    Effect.forkIn(processScope),
  );

  return yield* Effect.race(
    Effect.result(handle.exitCode).pipe(Effect.map(describeProcessExit)),
    Deferred.await(terminalFailureExit),
  );
});

const makeDesktopBackendManager = Effect.fn("makeDesktopBackendManager")(function* () {
  const parentScope = yield* Scope.Scope;
  const fileSystem = yield* FileSystem.FileSystem;
  const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
  const backendOutputLog = yield* DesktopObservability.DesktopBackendOutputLog;
  const desktopState = yield* DesktopState.DesktopState;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const state = yield* Ref.make(initialState);
  const mutex = yield* Semaphore.make(1);

  const updateActiveRun = (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
    Ref.update(state, withActiveRun(runId, f));

  const snapshot = Ref.get(state).pipe(
    Effect.map(
      (current): DesktopBackendSnapshot => ({
        desiredRunning: current.desiredRunning,
        ready: current.ready,
        activePid: activePid(current.active),
        restartAttempt: current.restartAttempt,
        restartScheduled: Option.isSome(current.restartFiber),
      }),
    ),
  );
  const currentConfig = Ref.get(state).pipe(Effect.map((current) => current.config));

  const cancelRestart = Effect.gen(function* () {
    const restartFiber = yield* Ref.modify(state, (current) => [
      current.restartFiber,
      {
        ...current,
        restartFiber: Option.none(),
      },
    ]);

    yield* Option.match(restartFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
  });

  const start: Effect.Effect<void> = Effect.suspend(() =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (Option.isSome(current.active)) {
          return;
        }

        yield* Ref.set(desktopState.backendReady, false);
        const config = yield* configuration.resolve;
        const entryExists = yield* fileSystem
          .exists(config.entryPath)
          .pipe(Effect.orElseSucceed(() => false));

        yield* cancelRestart;
        yield* Ref.update(state, (latest) => ({
          ...latest,
          desiredRunning: true,
          ready: false,
          config: Option.some(config),
        }));

        if (!entryExists) {
          yield* scheduleRestart(`missing server entry at ${config.entryPath}`);
          return;
        }

        // If the previous backend lost its HTTP listener but kept the process alive, it may still
        // hold SQLite files, inherited pipes, or the intended port. Clear stale backend children
        // before spawning the replacement. Provider daemon/supervisor processes are excluded by the
        // matcher, so long-running provider sessions are left alone.
        yield* reapStaleDesktopBackendProcesses(config.entryPath, []).pipe(
          Effect.catchCause((cause) =>
            logBackendManagerWarning("failed to reap stale desktop backend processes", {
              cause: Cause.pretty(cause),
            }),
          ),
        );

        const runScope = yield* Scope.make("sequential");
        const runScopeClosed = yield* Ref.make(false);
        const closeRunScope = Ref.getAndSet(runScopeClosed, true).pipe(
          Effect.flatMap((wasClosed) =>
            wasClosed ? Effect.void : Scope.close(runScope, Exit.void).pipe(Effect.asVoid),
          ),
        );
        const exited = yield* Deferred.make<void>();
        const runId = yield* Ref.modify(state, (latest) => [
          latest.nextRunId,
          {
            ...latest,
            active: Option.some({
              id: latest.nextRunId,
              closeScope: closeRunScope,
              fiber: Option.none(),
              pid: Option.none(),
              terminate: Option.none(),
              exited,
            } satisfies ActiveBackendRun),
            nextRunId: latest.nextRunId + 1,
          },
        ]);

        const finalizeRun = Effect.fn("desktop.backendManager.finalizeRun")(function* (
          reason: string,
        ) {
          yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              const { isCurrentRun, nextState, pid } = yield* Ref.modify(
                state,
                (
                  latest,
                ): readonly [
                  {
                    readonly isCurrentRun: boolean;
                    readonly nextState: BackendManagerState;
                    readonly pid: Option.Option<number>;
                  },
                  BackendManagerState,
                ] => {
                  const currentRun = Option.getOrUndefined(latest.active);
                  if (currentRun?.id !== runId) {
                    return [
                      {
                        isCurrentRun: false,
                        nextState: latest,
                        pid: Option.none<number>(),
                      },
                      latest,
                    ] as const;
                  }

                  const next = {
                    ...latest,
                    active: Option.none<ActiveBackendRun>(),
                    ready: false,
                  };
                  return [
                    {
                      isCurrentRun: true,
                      nextState: next,
                      pid: currentRun.pid,
                    },
                    next,
                  ] as const;
                },
              );

              if (isCurrentRun) {
                if (Option.isSome(pid)) {
                  yield* backendOutputLog.writeSessionBoundary({
                    phase: "END",
                    details: `pid=${pid.value} ${reason}`,
                  });
                }
                yield* Ref.set(desktopState.backendReady, false);
              }

              if (isCurrentRun && nextState.desiredRunning) {
                yield* scheduleRestart(reason);
              }
            }),
          );
        });

        const program = runBackendProcess({
          ...config,
          onStarted: Effect.fn("desktop.backendManager.onStarted")(function* (pid, terminate) {
            yield* updateActiveRun(runId, (run) => ({
              ...run,
              pid: Option.some(pid),
              terminate: Option.some(terminate),
            }));
            yield* backendOutputLog.writeSessionBoundary({
              phase: "START",
              details: `pid=${pid} port=${config.bootstrap.port} cwd=${config.cwd}`,
            });
            yield* reapStaleDesktopBackendProcesses(config.entryPath, [pid]).pipe(
              Effect.catchCause((cause) =>
                logBackendManagerWarning("failed to reap stale desktop backend processes", {
                  cause: Cause.pretty(cause),
                }),
              ),
              Effect.forkIn(parentScope),
              Effect.asVoid,
            );
          }),
          onReady: Effect.fn("desktop.backendManager.onReady")(function* () {
            const isCurrentRun = yield* Ref.modify(state, (latest) => {
              const activeRun = Option.getOrUndefined(latest.active);
              if (activeRun?.id !== runId) {
                return [false, latest] as const;
              }

              return [
                true,
                {
                  ...latest,
                  restartAttempt: 0,
                  ready: true,
                },
              ] as const;
            });
            if (!isCurrentRun) {
              return;
            }

            yield* Ref.set(desktopState.backendReady, true);
            yield* desktopWindow.handleBackendReady.pipe(
              Effect.catch((error) =>
                logBackendManagerError("failed to open main window after backend readiness", {
                  message: error.message,
                }),
              ),
            );
          }),
          onReadinessFailure: (error) =>
            logBackendManagerWarning("backend readiness check failed during bootstrap", {
              error: error.message,
            }),
          onHealthFailure: (error) =>
            logBackendManagerWarning("backend health check failed; terminating backend", {
              error: error.message,
            }),
          onOutput: (streamName, chunk) => backendOutputLog.writeOutputChunk(streamName, chunk),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Scope.provide(runScope),
          Effect.matchEffect({
            onFailure: (error) =>
              Deferred.succeed(exited, undefined).pipe(Effect.andThen(finalizeRun(error.message))),
            onSuccess: (exit) =>
              Deferred.succeed(exited, undefined).pipe(Effect.andThen(finalizeRun(exit.reason))),
          }),
          Effect.ensuring(closeRunScope.pipe(Effect.ignore)),
        );

        const fiber = yield* Effect.forkIn(program, parentScope);
        yield* updateActiveRun(runId, (run) => ({
          ...run,
          fiber: Option.some(fiber),
        }));
      }),
    ),
  ).pipe(Effect.withSpan("desktop.backendManager.start"));

  const scheduleRestart = Effect.fn("desktop.backendManager.scheduleRestart")(function* (
    reason: string,
  ) {
    const scheduled = yield* Ref.modify(state, (latest) => {
      if (!latest.desiredRunning || Option.isSome(latest.restartFiber)) {
        return [Option.none<Duration.Duration>(), latest] as const;
      }

      const delay = calculateRestartDelay(latest.restartAttempt);
      return [
        Option.some(delay),
        {
          ...latest,
          restartAttempt: latest.restartAttempt + 1,
        },
      ] as const;
    });

    yield* Option.match(scheduled, {
      onNone: () => Effect.void,
      onSome: Effect.fn("desktop.backendManager.scheduleRestartFiber")(function* (delay) {
        yield* logBackendManagerError("backend exited unexpectedly; restart scheduled", {
          reason,
          delayMs: Duration.toMillis(delay),
        });
        const restartFiber = yield* Effect.forkIn(
          Effect.sleep(delay).pipe(
            Effect.andThen(
              Ref.modify(state, (latest) => {
                const shouldRestart = latest.desiredRunning;
                return [
                  shouldRestart,
                  {
                    ...latest,
                    restartFiber: Option.none(),
                  },
                ] as const;
              }),
            ),
            Effect.flatMap((shouldRestart) => (shouldRestart ? start : Effect.void)),
            Effect.catchCause((cause) =>
              logBackendManagerError("desktop backend restart fiber failed", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
          parentScope,
        );
        yield* Ref.update(state, (latest) =>
          Option.isNone(latest.restartFiber)
            ? {
                ...latest,
                restartFiber: Option.some(restartFiber),
              }
            : latest,
        );
      }),
    });
  });

  const stop = Effect.fn("desktop.backendManager.stop")(function* (options?: {
    readonly timeout?: Duration.Duration;
  }) {
    const { active, restartFiber } = yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const result = yield* Ref.modify(state, (latest) => [
          {
            active: latest.active,
            restartFiber: latest.restartFiber,
          },
          {
            ...latest,
            desiredRunning: false,
            ready: false,
            active: Option.none<ActiveBackendRun>(),
            restartFiber: Option.none<Fiber.Fiber<void, never>>(),
          },
        ]);
        yield* Ref.set(desktopState.backendReady, false);
        return result;
      }),
    );

    yield* Option.match(restartFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
    yield* Option.match(active, {
      onNone: () => Effect.void,
      onSome: (run) =>
        Effect.gen(function* () {
          const result = yield* closeRun(run, options);
          if (result !== "timed-out" || !options?.timeout) {
            return;
          }

          yield* logBackendManagerWarning("backend close timed out during stop", {
            runId: run.id,
            timeoutMs: Duration.toMillis(options.timeout),
            ...(Option.isSome(run.pid) ? { pid: run.pid.value } : {}),
          });
        }),
    });
  });

  yield* Effect.addFinalizer(() => stop());

  return DesktopBackendManager.of({
    start,
    stop,
    currentConfig,
    snapshot,
  });
});

export const layer = Layer.effect(DesktopBackendManager, makeDesktopBackendManager());
