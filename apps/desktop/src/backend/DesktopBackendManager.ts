import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
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
import { resolveBootstrappedDataProfile } from "@cafecode/shared/dataProfile";
import { BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE } from "@cafecode/shared/backendStartupFailure";
import { uiText } from "@cafecode/shared/i18n";
// Native path boundary: preserve host drive, namespace and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import {
  BACKEND_READINESS_CHALLENGE_HEADER,
  BACKEND_READINESS_PROOF_HEADER,
  mintBackendReadinessChallenge,
  mintBackendReadinessToken,
  verifyBackendReadinessProof,
} from "@cafecode/shared/backendReadiness";
import {
  BACKEND_STARTUP_PROGRESS_FD,
  makeBackendMigrationProgressDecoder,
  makeBackendStartupDeadline,
} from "@cafecode/shared/backendStartupProgress";

import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";

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
)<{}> {
  override get message() {
    // The payload contains private one-run credentials. A schema exception may
    // quote received values, so retain neither it nor its message as a cause.
    return "Failed to encode desktop backend bootstrap payload.";
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
  readonly onStarted?: (
    pid: number,
    terminate: (grace?: Duration.Duration) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
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
  readonly stop: (options?: {
    readonly timeout?: Duration.Duration;
    /** Update installation may proceed only after this exact run actually closes. */
    readonly requireConfirmedExit?: boolean;
  }) => Effect.Effect<void>;
  readonly currentConfig: Effect.Effect<Option.Option<DesktopBackendStartConfig>>;
  readonly snapshot: Effect.Effect<DesktopBackendSnapshot>;
}

export class DesktopBackendManager extends Context.Service<
  DesktopBackendManager,
  DesktopBackendManagerShape
>()("cafecode/desktop/BackendManager") {}

/** A stop deadline is not evidence that the old backend released its data profile. */
export class BackendTerminationUnconfirmedError extends Data.TaggedError(
  "BackendTerminationUnconfirmedError",
)<{}> {
  override get message() {
    return "Backend native exit could not be confirmed; the current owner was preserved and update installation was refused.";
  }
}

const { logWarning: logBackendManagerWarning, logError: logBackendManagerError } =
  DesktopObservability.makeComponentLogger("desktop-backend-manager");

interface ActiveBackendRun {
  readonly id: number;
  readonly authenticatedReady: boolean;
  readonly closeScope: Effect.Effect<void>;
  readonly fiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly pid: Option.Option<number>;
  readonly terminate: Option.Option<(grace?: Duration.Duration) => Effect.Effect<void>>;
  readonly exited: Deferred.Deferred<void>;
}

/** Native-exit classification only. A retired run cannot affect a newer owner,
 * and a numeric exit from legacy/unprofiled or previously-ready code is not a
 * new startup-refusal capability. This policy performs no profile IO. */
export function classifyDesktopBackendExit(input: {
  readonly exitingRunId: number;
  readonly currentRun: { readonly id: number; readonly authenticatedReady: boolean } | undefined;
  readonly exitCode: number | undefined;
  readonly bootstrap: DesktopBackendBootstrapValue;
}): "stale" | "ordinary" | "profile-startup-refused" {
  if (input.currentRun === undefined || input.currentRun.id !== input.exitingRunId) return "stale";
  if (
    input.exitCode !== BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE ||
    input.currentRun.authenticatedReady ||
    input.bootstrap.mode !== "desktop" ||
    input.bootstrap.dataProfile === undefined
  )
    return "ordinary";
  try {
    resolveBootstrappedDataProfile(input.bootstrap, NodePath);
    return "profile-startup-refused";
  } catch {
    return "ordinary";
  }
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

const closeRun = (
  run: ActiveBackendRun,
  options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<"closed" | "timed-out"> => {
  const terminate = Option.match(run.terminate, {
    onNone: () => Effect.void,
    onSome: (kill) =>
      kill(options?.timeout ? Duration.min(options.timeout, Duration.seconds(1)) : undefined),
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
    yield* terminate.pipe(Effect.ignore, Effect.forkDetach);
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
  readinessToken: string,
  requestTimeout: Duration.Duration = DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT,
): Effect.fn.Return<boolean, never, HttpClient.HttpClient> {
  const readinessUrl = readinessUrlFor(baseUrl);
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.transformResponse(Effect.timeout(requestTimeout)),
    HttpClient.withScope,
  );

  const challenge = mintBackendReadinessChallenge();
  return yield* client
    .get(readinessUrl, {
      headers: { [BACKEND_READINESS_CHALLENGE_HEADER]: challenge },
    })
    .pipe(
      Effect.timeout(requestTimeout),
      // A public environment endpoint's status alone is never ownership proof:
      // a listener winning the bind race must not open another profile's UI.
      Effect.map((response) =>
        verifyBackendReadinessProof(
          readinessToken,
          challenge,
          response.headers[BACKEND_READINESS_PROOF_HEADER],
        ),
      ),
      Effect.catch(() => Effect.succeed(false)),
      // Header-only ownership probes do not consume the public JSON body. Bind
      // each exact request to this finite scope so success, refusal and timeout
      // abort any held response stream immediately instead of relying on GC.
      Effect.scoped,
    );
});

const waitForHttpReady = Effect.fn("desktop.backendManager.waitForHttpReady")(function* (
  baseUrl: URL,
  readinessToken: string,
  deadline: ReturnType<typeof makeBackendStartupDeadline>,
  elapsedMs: Effect.Effect<number>,
): Effect.fn.Return<void, BackendTimeoutError, HttpClient.HttpClient> {
  const readinessUrl = readinessUrlFor(baseUrl);
  while (true) {
    const beforeProbeMs = yield* elapsedMs;
    const remainingMs = Math.max(0, deadline.deadlineMs - beforeProbeMs);
    const healthy = yield* checkHttpReadyOnce(
      baseUrl,
      readinessToken,
      Duration.min(DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT, Duration.millis(remainingMs)),
    );
    const afterProbeMs = yield* elapsedMs;
    if (afterProbeMs >= deadline.deadlineMs) {
      return yield* new BackendTimeoutError({ url: readinessUrl });
    }
    if (healthy) {
      deadline.finish();
      return;
    }
    yield* Effect.sleep(
      Duration.min(
        DEFAULT_BACKEND_READINESS_INTERVAL,
        Duration.millis(deadline.deadlineMs - afterProbeMs),
      ),
    );
  }
});

const monitorHttpHealth = Effect.fn("desktop.backendManager.monitorHttpHealth")(function* (
  baseUrl: URL,
  readinessToken: string,
  interval: Duration.Duration,
  requestTimeout: Duration.Duration,
  failureThreshold: number,
  onFailure: (error: BackendHealthCheckFailedError) => Effect.Effect<void>,
): Effect.fn.Return<void, never, HttpClient.HttpClient> {
  const readinessUrl = readinessUrlFor(baseUrl);
  let consecutiveFailures = 0;

  while (true) {
    yield* Effect.sleep(interval);
    const healthy = yield* checkHttpReadyOnce(baseUrl, readinessToken, requestTimeout);
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
  // Mint for the actual spawn, never for saved manager configuration. Retries
  // using the same bootstrap intent must not accept a previous child's proof.
  const readinessToken = mintBackendReadinessToken();
  const bootstrapJson = yield* encodeBootstrapJson({
    ...options.bootstrap,
    desktopReadinessToken: readinessToken,
    startupProgressFd: BACKEND_STARTUP_PROGRESS_FD,
  }).pipe(Effect.mapError(() => new BackendProcessBootstrapEncodeError()));
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
        // This private child-output pipe is always consumed, even when normal
        // log capture is disabled. Provider stdout/stderr never grants a longer
        // startup window, and unrelated/adopted processes cannot write here.
        fd4: { type: "output" },
      },
    },
  );

  const spawnedAtNanos = yield* Clock.currentTimeNanos;
  const deadline = makeBackendStartupDeadline(
    Duration.toMillis(options.readinessTimeout ?? DEFAULT_BACKEND_READINESS_TIMEOUT),
  );
  const elapsedMs = Clock.currentTimeNanos.pipe(
    Effect.map((now) => Number(now - spawnedAtNanos) / 1_000_000),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => deadline.finish()));
  const handle = yield* spawner
    .spawn(command)
    .pipe(Effect.mapError((cause) => new BackendProcessSpawnError({ cause })));

  // The qualified Node spawner completes its private exit signal only from
  // ChildProcess's native `exit` event. Its exitCode failure denotes a signal
  // exit after that event, not an inconclusive observer. Preserve that actual
  // exit evidence for strict update shutdown, including SIGTERM/SIGKILL exits.
  const nativeExit = Effect.result(handle.exitCode).pipe(Effect.asVoid);
  const terminationStarted = yield* Ref.make(false);
  const terminate = (grace: Duration.Duration = DEFAULT_BACKEND_TERMINATE_GRACE) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        if (!(yield* Ref.getAndSet(terminationStarted, true))) {
          // Signal only this retained native child handle. Neither a process
          // catalogue entry nor a recycled bare PID can grant cleanup authority.
          const signalOwnedChild = (killSignal: NodeJS.Signals) =>
            handle.isRunning.pipe(
              // Uncertain native-handle observation cannot authorize signaling.
              Effect.orElseSucceed(() => false),
              Effect.flatMap((running) =>
                running ? handle.kill({ killSignal }).pipe(Effect.ignore) : Effect.void,
              ),
            );
          // Stop may run after runScope begins closing. This one-shot native
          // control must survive that scope's cancellation; otherwise the close
          // would cancel its own signal before the exact exit can be observed.
          // The reservation remains active until nativeExit, so this independent
          // request cannot authorize or accumulate replacement writers.
          yield* signalOwnedChild("SIGTERM").pipe(Effect.interruptible, Effect.forkDetach);
          yield* Effect.race(
            nativeExit,
            Effect.sleep(grace).pipe(Effect.andThen(signalOwnedChild("SIGKILL")), Effect.ignore),
          ).pipe(Effect.interruptible, Effect.forkDetach);
        }
        // Reservation plus starting its exact-child control fibers is atomic;
        // cancellation may not leave a claimed but never-signaled owner behind.
        // Only this synchronous handoff is fenced, never the native exit wait.
      }).pipe(Effect.uninterruptible);
      // A completed signal request is not proof that the native child exited.
      // Retain ownership until its actual exit receipt, including on failure.
      yield* nativeExit;
    });
  const progressDecoder = makeBackendMigrationProgressDecoder();
  yield* handle.getOutputFd(BACKEND_STARTUP_PROGRESS_FD).pipe(
    Stream.runForEach((bytes) =>
      Effect.gen(function* () {
        const decoded = progressDecoder.push(bytes);
        if (decoded.invalid) {
          deadline.invalidate();
          return;
        }
        const observedAtMs = yield* elapsedMs;
        for (const record of decoded.records) deadline.observe(record, observedAtMs);
      }),
    ),
    Effect.catchCause(() => Effect.sync(() => deadline.invalidate())),
    Effect.ensuring(
      Effect.sync(() => {
        if (progressDecoder.end()) deadline.invalidate();
      }),
    ),
    Effect.forkIn(processScope),
  );
  const terminateFailedRun = Effect.fn("desktop.backendManager.terminateFailedRun")(function* (
    _reason: string,
  ) {
    // Failure immediately retires readiness, but cannot release writer
    // ownership. Start bounded native-handle termination without blocking the
    // health observer; replacement still waits for the exact exit below.
    yield* terminate().pipe(Effect.forkIn(processScope));
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
  yield* waitForHttpReady(options.httpBaseUrl, readinessToken, deadline, elapsedMs).pipe(
    Effect.tap(() => options.onReady?.() ?? Effect.void),
    Effect.tap(() =>
      monitorHttpHealth(
        options.httpBaseUrl,
        readinessToken,
        healthCheckInterval,
        healthCheckRequestTimeout,
        healthFailureThreshold,
        (error) =>
          Effect.gen(function* () {
            yield* (options.onHealthFailure?.(error) ?? Effect.void).pipe(Effect.ignore);
            // A backend can lose its HTTP listener while process-level liveness remains true. In
            // that split-brain state the renderer cannot reconnect, and waiting only for exitCode can
            // wedge the desktop manager forever if the child ignores SIGTERM or has lingering fibers.
            // Retire readiness and request termination while retaining this
            // active writer until its exact native exit receipt arrives.
            yield* terminateFailedRun(error.message);
          }),
      ).pipe(Effect.forkIn(processScope)),
    ),
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* (options.onReadinessFailure?.(error) ?? Effect.void).pipe(Effect.ignore);
        // A readiness timeout retires availability, not native ownership.
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

  return yield* Effect.result(handle.exitCode).pipe(Effect.map(describeProcessExit));
});

const makeDesktopBackendManager = Effect.fn("makeDesktopBackendManager")(function* () {
  const parentScope = yield* Scope.Scope;
  const fileSystem = yield* FileSystem.FileSystem;
  const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
  const backendOutputLog = yield* DesktopObservability.DesktopBackendOutputLog;
  const desktopState = yield* DesktopState.DesktopState;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const state = yield* Ref.make(initialState);
  const mutex = yield* Semaphore.make(1);

  const updateActiveRun = (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
    Ref.update(state, withActiveRun(runId, f));

  const snapshot = Ref.get(state).pipe(
    Effect.map((current): DesktopBackendSnapshot => ({
      desiredRunning: current.desiredRunning,
      ready: current.ready,
      activePid: activePid(current.active),
      restartAttempt: current.restartAttempt,
      restartScheduled: Option.isSome(current.restartFiber),
    })),
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

        // An executable path is shared by Debug and Production. No ambient
        // process scan may turn that path into authority to terminate a child.

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
              authenticatedReady: false,
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
          exitCode: number | undefined = undefined,
        ) {
          yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              const { isCurrentRun, nextState, pid, notifyProfileRefusal } = yield* Ref.modify(
                state,
                (
                  latest,
                ): readonly [
                  {
                    readonly isCurrentRun: boolean;
                    readonly nextState: BackendManagerState;
                    readonly pid: Option.Option<number>;
                    readonly notifyProfileRefusal: boolean;
                  },
                  BackendManagerState,
                ] => {
                  const currentRun = Option.getOrUndefined(latest.active);
                  const disposition = classifyDesktopBackendExit({
                    exitingRunId: runId,
                    currentRun,
                    exitCode,
                    bootstrap: config.bootstrap,
                  });
                  if (disposition === "stale" || currentRun === undefined) {
                    return [
                      {
                        isCurrentRun: false,
                        nextState: latest,
                        pid: Option.none<number>(),
                        notifyProfileRefusal: false,
                      },
                      latest,
                    ] as const;
                  }

                  const next = {
                    ...latest,
                    desiredRunning:
                      disposition === "profile-startup-refused" ? false : latest.desiredRunning,
                    active: Option.none<ActiveBackendRun>(),
                    ready: false,
                  };
                  return [
                    {
                      isCurrentRun: true,
                      nextState: next,
                      pid: currentRun.pid,
                      notifyProfileRefusal:
                        disposition === "profile-startup-refused" && latest.desiredRunning,
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

              // The mutex still fences this exact exited owner while notifying.
              // A concurrent manual start cannot supersede it between admission
              // and the fixed local error. Explicit stop/quit never pops a new UI.
              if (notifyProfileRefusal && !(yield* Ref.get(desktopState.quitting))) {
                yield* electronDialog
                  .showErrorBox(
                    uiText("Cafe Code data profile could not start"),
                    uiText(
                      "This data profile is already in use, unavailable or unsafe. No other profile was selected and automatic restart has stopped. Close the other Cafe Code instance using this profile, or check permissions, free space and startup recovery files. After resolving the problem, quit and reopen this Cafe Code instance. Do not delete ownership files to bypass this refusal.",
                    ),
                  )
                  .pipe(
                    Effect.catchCause(() =>
                      logBackendManagerError("failed to show data profile startup refusal"),
                    ),
                  );
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
                  active: Option.some({ ...activeRun, authenticatedReady: true }),
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
            Effect.gen(function* () {
              const currentOwner = yield* Ref.modify(state, (latest) =>
                Option.getOrUndefined(latest.active)?.id === runId
                  ? ([true, { ...latest, ready: false }] as const)
                  : ([false, latest] as const),
              );
              if (!currentOwner) return;
              yield* Ref.set(desktopState.backendReady, false);
              yield* logBackendManagerWarning("backend health check failed; terminating backend", {
                error: error.message,
              });
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
              Deferred.succeed(exited, undefined).pipe(
                Effect.andThen(finalizeRun(exit.reason, Option.getOrUndefined(exit.code))),
              ),
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
    readonly requireConfirmedExit?: boolean;
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
            // Retain the exact owner while closing. In particular, a timeout
            // must not authorize a manual start to create a second DB writer.
            active: latest.active,
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
          if (result === "closed") {
            // A completed close joins the run's native-exit path (or cancels a
            // preparation which never published a child). Clear only this
            // retained generation; a timed-out close deliberately keeps it.
            yield* mutex.withPermits(1)(
              Ref.update(state, (latest) =>
                Option.getOrUndefined(latest.active)?.id === run.id
                  ? { ...latest, active: Option.none<ActiveBackendRun>() }
                  : latest,
              ),
            );
          }
          if (result !== "timed-out" || !options?.timeout) {
            return;
          }

          yield* logBackendManagerWarning("backend close timed out during stop", {
            runId: run.id,
            timeoutMs: Duration.toMillis(options.timeout),
            ...(Option.isSome(run.pid) ? { pid: run.pid.value } : {}),
          });
          if (options.requireConfirmedExit) {
            // Keep the retained generation and the existing five-second update
            // budget. The installer must not interpret this void Stop API's
            // historical best-effort timeout as release of the old DB writer.
            return yield* Effect.die(new BackendTerminationUnconfirmedError());
          }
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
