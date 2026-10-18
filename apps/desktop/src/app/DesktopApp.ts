import { uiText } from "@cafecode/shared/i18n";
import { preferredDataProfileHttpPort, type DataProfile } from "@cafecode/shared/dataProfile";
import {
  assertSourceDebugDesktopBuilds,
  SourceDebugBuildError,
} from "@cafecode/shared/sourceDebugBuild";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ProviderDaemonClientConfig } from "@cafecode/contracts";
import * as NetService from "@cafecode/shared/Net";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import { installGlobalDictationCoordinator } from "../dictation/GlobalDictationCoordinator.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import { isDesktopHttpsSupported } from "../backend/DesktopHttpsPrerequisites.ts";
import * as DesktopProviderDaemonManager from "../backend/DesktopProviderDaemonManager.ts";
import { isPidAlive } from "../backend/DesktopProcessReaper.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUiLocale from "../settings/DesktopUiLocale.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopSourceUpdates from "../updates/DesktopSourceUpdates.ts";
import * as DesktopDebugServer from "../debug/DesktopDebugServer.ts";
import * as DesktopStartupWindow from "../window/DesktopStartupWindow.ts";

const MAX_TCP_PORT = 65_535;
const DESKTOP_BACKEND_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;
const DESKTOP_SHUTDOWN_BACKEND_STOP_TIMEOUT = Duration.seconds(5);
const PROVIDER_DAEMON_HEALTH_CHECK_INTERVAL = Duration.seconds(5);
const PROVIDER_DAEMON_LIVENESS_WARNING_THRESHOLD = 3;
const PROVIDER_DAEMON_RECOVERY_BACKEND_STOP_TIMEOUT = Duration.seconds(10);

const makeDesktopRunId = Random.nextUUIDv4.pipe(
  Effect.map((value) => value.replaceAll("-", "").slice(0, 12)),
);

class DesktopBackendPortUnavailableError extends Data.TaggedError(
  "DesktopBackendPortUnavailableError",
)<{
  readonly startPort: number;
  readonly maxPort: number;
  readonly hosts: readonly string[];
}> {
  override get message() {
    return `No desktop backend port is available on hosts ${this.hosts.join(", ")} between ${this.startPort} and ${this.maxPort}.`;
  }
}

class DesktopDevelopmentBackendPortRequiredError extends Data.TaggedError(
  "DesktopDevelopmentBackendPortRequiredError",
)<{}> {
  override get message() {
    return "CAFE_CODE_PORT is required in desktop development.";
  }
}

const { logInfo: logBootstrapInfo, logWarning: logBootstrapWarning } =
  DesktopObservability.makeComponentLogger("desktop-bootstrap");

const { logInfo: logDaemonWatchdogInfo, logWarning: logDaemonWatchdogWarning } =
  DesktopObservability.makeComponentLogger("desktop-provider-daemon-watchdog");

/** A source watcher may replace bundles after the early native admission.
 * Recheck before daemon/backend startup through the actual typed Effect path;
 * raw filesystem/bundler exceptions must not disclose local paths in startup
 * diagnostics. Packaged Production never consumes source-build receipts. */
export function verifyDesktopSourceBuilds(
  environment: Pick<
    DesktopEnvironment.DesktopEnvironmentShape,
    "dataProfile" | "isPackaged" | "appRoot"
  > & {
    readonly path: Pick<DesktopEnvironment.DesktopEnvironmentShape["path"], "join">;
  },
  verify: (desktopDirectory: string) => void = assertSourceDebugDesktopBuilds,
): Effect.Effect<void, SourceDebugBuildError> {
  if (environment.dataProfile !== "debug" || environment.isPackaged) return Effect.void;
  return Effect.try({
    try: () => verify(environment.path.join(environment.appRoot, "apps", "desktop")),
    catch: () => new SourceDebugBuildError(),
  });
}

const {
  logInfo: logStartupInfo,
  logWarning: logStartupWarning,
  logError: logStartupError,
} = DesktopObservability.makeComponentLogger("desktop-startup");

const acquireSingleInstanceLock = Effect.fn("desktop.startup.acquireSingleInstanceLock")(
  function* (): Effect.fn.Return<"primary" | "secondary", never, ElectronApp.ElectronApp> {
    const electronApp = yield* ElectronApp.ElectronApp;
    const acquired = yield* electronApp.requestSingleInstanceLock;
    if (acquired) {
      yield* logStartupInfo("single instance lock acquired");
      return "primary";
    }

    yield* logStartupWarning("single instance lock rejected; another instance is active");
    yield* electronApp.exit(0);
    return "secondary";
  },
);

export const resolveDesktopBackendPort = Effect.fn("resolveDesktopBackendPort")(function* (
  configuredPort: Option.Option<number>,
  dataProfile: DataProfile,
) {
  const net = yield* NetService.NetService;
  if (Option.isSome(configuredPort)) {
    // A configured endpoint is not permission to adopt a listener already on
    // that port. Refuse before provider/backend startup instead of letting a
    // failed child bind be confused with another profile's readiness response.
    // This preflight does not claim to reserve the port against later races.
    for (const host of DESKTOP_BACKEND_PORT_PROBE_HOSTS) {
      if (!(yield* net.canListenOnHost(configuredPort.value, host))) {
        return yield* new DesktopBackendPortUnavailableError({
          startPort: configuredPort.value,
          maxPort: configuredPort.value,
          hosts: DESKTOP_BACKEND_PORT_PROBE_HOSTS,
        });
      }
    }
    return {
      port: configuredPort.value,
      selectedByScan: false,
    } as const;
  }

  // Debug never takes the installed app's preferred port merely because it
  // launched first. These are listener preferences, not new exposure or owner
  // authority: every candidate still passes the same existing host probes.
  const startPort = preferredDataProfileHttpPort(dataProfile);
  for (let port = startPort; port <= MAX_TCP_PORT; port += 1) {
    let availableOnEveryHost = true;

    for (const host of DESKTOP_BACKEND_PORT_PROBE_HOSTS) {
      if (!(yield* net.canListenOnHost(port, host))) {
        availableOnEveryHost = false;
        break;
      }
    }

    if (availableOnEveryHost) {
      return {
        port,
        selectedByScan: true,
      } as const;
    }
  }

  return yield* new DesktopBackendPortUnavailableError({
    startPort,
    maxPort: MAX_TCP_PORT,
    hosts: DESKTOP_BACKEND_PORT_PROBE_HOSTS,
  });
});

export const resolveDesktopBackendHttpsPort = Effect.fn("resolveDesktopBackendHttpsPort")(
  function* (backendPort: number, dataProfile: DataProfile) {
    const net = yield* NetService.NetService;
    const startPort =
      backendPort + 2 <= MAX_TCP_PORT
        ? backendPort + 2
        : preferredDataProfileHttpPort(dataProfile) + 2;

    for (let port = startPort; port <= MAX_TCP_PORT; port += 1) {
      if (port === backendPort) {
        continue;
      }

      let availableOnEveryHost = true;
      for (const host of DESKTOP_BACKEND_PORT_PROBE_HOSTS) {
        if (!(yield* net.canListenOnHost(port, host))) {
          availableOnEveryHost = false;
          break;
        }
      }

      if (availableOnEveryHost) {
        return port;
      }
    }

    return yield* new DesktopBackendPortUnavailableError({
      startPort,
      maxPort: MAX_TCP_PORT,
      hosts: DESKTOP_BACKEND_PORT_PROBE_HOSTS,
    });
  },
);

const handleFatalStartupError = Effect.fn("desktop.startup.handleFatalStartupError")(function* (
  stage: string,
  error: unknown,
): Effect.fn.Return<
  void,
  never,
  | DesktopLifecycle.DesktopShutdown
  | DesktopState.DesktopState
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
> {
  const shutdown = yield* DesktopLifecycle.DesktopShutdown;
  const state = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const startupWindow = yield* Effect.serviceOption(DesktopStartupWindow.DesktopStartupWindow);
  if (Option.isSome(startupWindow)) yield* startupWindow.value.close;
  const message = error instanceof Error ? error.message : String(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  yield* logStartupError("fatal startup error", {
    stage,
    message,
    ...(detail.length > 0 ? { detail } : {}),
  });
  const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
  if (!wasQuitting) {
    yield* electronDialog.showErrorBox(
      uiText("Cafe Code failed to start"),
      `${uiText("Stage: {stage}", { stage })}\n${message}${detail}`,
    );
  }
  yield* shutdown.request;
  yield* electronApp.quit;
}, Effect.uninterruptible);

/**
 * Only the bounded fatal UI-to-Quit handoff is uninterruptible. Its shutdown
 * request wakes the competing startup cancellation branch, which must not
 * cancel this very handler before it delivers Electron's ordinary Quit.
 * Daemon readiness remains interruptible, and user cancellation is not fatal.
 */
export const fatalStartupCause = <E>(stage: string, cause: Cause.Cause<E>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.failCause(cause)
    : handleFatalStartupError(stage, Cause.pretty(cause)).pipe(
        Effect.andThen(Effect.failCause(cause)),
      );

/**
 * A user quit must cancel pending readiness, rather than waiting for startup
 * before the shutdown request can be observed. This changes only the desktop
 * bootstrap fiber's lifetime: it neither signals an adopted provider nor
 * substitutes a provisional endpoint for the final authenticated lease.
 */
export const runDesktopStartupUntilShutdown = <A, E, R>(input: {
  readonly startup: Effect.Effect<A, E, R>;
  readonly awaitShutdown: Effect.Effect<void>;
}) => Effect.raceFirst(input.startup, input.awaitShutdown.pipe(Effect.as("shutdown" as const)));

/**
 * Bootstrap credentials belong to the daemon attempt that actually became
 * ready. `currentConfig` can expose an earlier starting attempt's root token;
 * a readiness/lease failure replaces that attempt on the same IPC socket with
 * a different token. Starting the backend before `ensureRunning` finishes
 * strands its immutable bootstrap credential, even though the replacement
 * daemon and its desktop watchdog are healthy.
 *
 * Daemon health and lease issuance do not require the main backend listener.
 * Only harmless desktop setup may overlap this wait. A failed final attempt
 * must propagate to normal startup error handling without starting a backend,
 * refreshing credentials from files, or replaying user prompts.
 */
export const startBackendAfterProviderDaemonReady = Effect.fn(
  "desktop.bootstrap.startBackendAfterProviderDaemonReady",
)(function* (input: {
  readonly providerDaemonReady: Effect.Effect<ProviderDaemonClientConfig>;
  readonly startBackend: Effect.Effect<void>;
  readonly quitting: Ref.Ref<boolean>;
}) {
  const endpoint = yield* input.providerDaemonReady;
  if (!(yield* Ref.get(input.quitting))) {
    yield* input.startBackend;
  }
  return endpoint;
});

/**
 * Keep the provider runtime and backend lease in one coherent generation.
 *
 * The provider daemon is intentionally detached so long turns can survive a
 * renderer/backend restart. If that daemon itself dies, however, a replacement
 * has a new root credential and issues a new lease capability. The backend must
 * therefore restart after the daemon replacement; mutating its bootstrap token
 * in place would weaken the capability boundary and leave event ingestion on a
 * stale socket.
 */
export const runProviderDaemonHealthWatchdog = Effect.fn("desktop.providerDaemonHealthWatchdog")(
  function* (input: {
    readonly backendManager: DesktopBackendManager.DesktopBackendManagerShape;
    readonly providerDaemonManager: DesktopProviderDaemonManager.DesktopProviderDaemonManagerShape;
    readonly quitting: Ref.Ref<boolean>;
    readonly checkInterval?: Duration.Duration;
    readonly warningThreshold?: number;
    readonly isDaemonProcessAlive?: (pid: number) => boolean;
  }) {
    const checkInterval = input.checkInterval ?? PROVIDER_DAEMON_HEALTH_CHECK_INTERVAL;
    const warningThreshold = Math.max(
      1,
      Math.trunc(input.warningThreshold ?? PROVIDER_DAEMON_LIVENESS_WARNING_THRESHOLD),
    );
    const isDaemonProcessAlive = input.isDaemonProcessAlive ?? isPidAlive;
    let consecutiveFailures = 0;
    let windowsRecoveryPending = false;
    let windowsRecoveryFailures = 0;
    let windowsRecoveryCooldown = 0;

    while (!(yield* Ref.get(input.quitting))) {
      yield* Effect.sleep(checkInterval);
      if (yield* Ref.get(input.quitting)) {
        return;
      }

      if (windowsRecoveryPending) {
        // A previous fenced recovery may have retired the dead owner before
        // losing a readiness/mutation reply. There is then no admitted PID for
        // the usual watchdog to observe. Retain this explicit recovery intent
        // until the backend has its new lease; re-observe durable ownership via
        // ensureRunning, never repeat termination using the old observation.
        // Backoff is bounded in watchdog ticks (at most 30s at its default).
        if (windowsRecoveryCooldown > 0) {
          windowsRecoveryCooldown -= 1;
          continue;
        }
        const resumed = yield* Effect.gen(function* () {
          yield* input.providerDaemonManager.ensureRunning;
          if (yield* Ref.get(input.quitting)) return false;
          yield* input.backendManager.start;
          return true;
        }).pipe(Effect.catchCause(() => Effect.succeed(false)));
        if (resumed) {
          windowsRecoveryPending = false;
          windowsRecoveryFailures = 0;
          consecutiveFailures = 0;
          yield* logDaemonWatchdogInfo("provider daemon pending ownership recovery completed");
        } else {
          windowsRecoveryFailures += 1;
          windowsRecoveryCooldown = Math.min(6, 2 ** Math.min(windowsRecoveryFailures - 1, 3));
          if (windowsRecoveryFailures === 1) {
            yield* logDaemonWatchdogWarning(
              "provider daemon ownership recovery pending; preserving uncertain runtime",
            );
          }
        }
        continue;
      }

      const liveness = yield* input.providerDaemonManager.probeLiveness.pipe(
        Effect.catchCause((cause) =>
          logDaemonWatchdogWarning("provider daemon liveness probe crashed", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(Option.none())),
        ),
      );
      if (Option.isSome(liveness)) {
        consecutiveFailures = 0;
        continue;
      }

      consecutiveFailures += 1;
      const daemonSnapshot = yield* input.providerDaemonManager.snapshot;
      const daemonPid = Option.getOrUndefined(daemonSnapshot.pid);
      // Windows must distinguish a recycled PID from the original owner and
      // access denial from a confirmed exit. Only that manager exposes this
      // capability; existing POSIX boolean probing is deliberately unchanged.
      const ownership = input.providerDaemonManager.observeProcessOwnership
        ? yield* input.providerDaemonManager.observeProcessOwnership.pipe(
            Effect.catchCause(() =>
              Effect.succeed({ status: "unknown" as const, ownershipId: undefined }),
            ),
          )
        : undefined;
      const processIsKnownDead = ownership
        ? (ownership.status === "exited" || ownership.status === "different-process") &&
          ownership.ownershipId !== undefined
        : daemonPid !== undefined && !isDaemonProcessAlive(daemonPid);
      if (!processIsKnownDead) {
        // The liveness route is deliberately database-free, but it still runs
        // on the provider daemon's Node.js event loop. Synchronous SQLite lock,
        // commit, checkpoint, or filesystem waits can therefore delay this
        // response even while the daemon and every provider child remain alive.
        // Replacing that live process would destroy active turns, so probe
        // failures are advisory until the OS confirms that the daemon PID died.
        if (consecutiveFailures === warningThreshold) {
          yield* logDaemonWatchdogWarning(
            "provider daemon liveness unavailable; preserving unconfirmed process",
            {
              consecutiveFailures,
              daemonPid: daemonPid ?? null,
              processExitConfirmed: false,
              lastError: Option.getOrNull(daemonSnapshot.lastError),
            },
          );
        }
        continue;
      }

      const reason = ownership
        ? "provider daemon ownership no longer matches"
        : `provider daemon process ${daemonPid} exited`;
      yield* logDaemonWatchdogWarning("provider daemon recovery starting", {
        reason,
        consecutiveFailures,
        daemonPid: daemonPid ?? null,
        lastError: Option.getOrNull(daemonSnapshot.lastError),
      });

      const recovered = yield* Effect.gen(function* () {
        // Stop first so no in-flight backend RPC can race credential/socket
        // replacement. `start` resolves configuration again and receives the new
        // daemon lease through the inherited bootstrap descriptor.
        yield* input.backendManager.stop({
          timeout: PROVIDER_DAEMON_RECOVERY_BACKEND_STOP_TIMEOUT,
        });
        // Only the Windows ownership controller implements prepared attempts.
        // Keep the existing POSIX recovery behavior unchanged.
        windowsRecoveryPending = input.providerDaemonManager.observeProcessOwnership !== undefined;
        if (yield* Ref.get(input.quitting)) {
          return false;
        }
        // A newer owner may have been adopted while the backend stopped. The
        // Windows controller rechecks this exact generation under its native
        // guard before retirement; a stale observation cannot authorize it.
        const endpoint = yield* input.providerDaemonManager.recover(reason, ownership?.ownershipId);
        if (yield* Ref.get(input.quitting)) {
          return false;
        }
        yield* input.backendManager.start;
        windowsRecoveryPending = false;
        windowsRecoveryFailures = 0;
        yield* logDaemonWatchdogInfo("provider daemon recovery completed", {
          endpoint: endpoint.httpBaseUrl,
          transport: endpoint.transport ?? "tcp",
        });
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          logDaemonWatchdogWarning("provider daemon recovery failed; retry remains scheduled", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      consecutiveFailures = recovered ? 0 : consecutiveFailures;
    }
  },
);

const bootstrap = Effect.gen(function* () {
  const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
  const providerDaemonManager = yield* DesktopProviderDaemonManager.DesktopProviderDaemonManager;
  const state = yield* DesktopState.DesktopState;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  yield* verifyDesktopSourceBuilds(environment);
  const startupWindow = yield* Effect.serviceOption(DesktopStartupWindow.DesktopStartupWindow);
  if (Option.isSome(startupWindow) && providerDaemonManager.startupProgress) {
    yield* Stream.runForEach(
      providerDaemonManager.startupProgress,
      startupWindow.value.update,
    ).pipe(Effect.forkScoped);
  }
  yield* logBootstrapInfo("bootstrap start");
  yield* DesktopDebugServer.start;

  if (environment.isDevelopment && Option.isNone(environment.configuredBackendPort)) {
    return yield* new DesktopDevelopmentBackendPortRequiredError();
  }

  const backendPortSelection = yield* resolveDesktopBackendPort(
    environment.configuredBackendPort,
    environment.dataProfile,
  );
  const backendPort = backendPortSelection.port;
  const settings = yield* desktopSettings.get;
  const desktopHttpsSupported = isDesktopHttpsSupported();
  const backendHttpsPort =
    settings.serverHttpsEnabled && desktopHttpsSupported
      ? yield* resolveDesktopBackendHttpsPort(backendPort, environment.dataProfile)
      : undefined;
  yield* logBootstrapInfo(
    backendPortSelection.selectedByScan
      ? "selected backend port via sequential scan"
      : "using configured backend port",
    {
      port: backendPort,
      ...(backendPortSelection.selectedByScan
        ? { startPort: preferredDataProfileHttpPort(environment.dataProfile) }
        : {}),
    },
  );
  if (backendHttpsPort !== undefined) {
    yield* logBootstrapInfo("selected backend HTTPS port via sequential scan", {
      port: backendHttpsPort,
    });
  } else if (settings.serverHttpsEnabled && !desktopHttpsSupported) {
    yield* logBootstrapWarning(
      "backend HTTPS endpoint disabled because OpenSSL is unavailable on Windows",
    );
  } else {
    yield* logBootstrapInfo("backend HTTPS endpoint disabled by desktop settings");
  }

  if (settings.serverExposureMode !== environment.defaultDesktopSettings.serverExposureMode) {
    yield* logBootstrapInfo("bootstrap restoring persisted server exposure mode", {
      mode: settings.serverExposureMode,
    });
  }
  const serverExposureState = yield* serverExposure.configureFromSettings({
    port: backendPort,
    ...(backendHttpsPort === undefined ? {} : { httpsPort: backendHttpsPort }),
  });
  const backendConfig = yield* serverExposure.backendConfig;
  yield* logBootstrapInfo("bootstrap resolved backend endpoint", {
    baseUrl: backendConfig.httpBaseUrl.href,
  });
  if (providerDaemonManager.configureCafeMcpPort) {
    yield* providerDaemonManager.configureCafeMcpPort(backendConfig.port);
  }
  const providerDaemonReadyFiber = yield* Effect.forkScoped(providerDaemonManager.ensureRunning);
  if (serverExposureState.endpointUrl) {
    yield* logBootstrapInfo("bootstrap enabled network access", {
      endpointUrl: serverExposureState.endpointUrl,
    });
  } else if (settings.serverExposureMode === "network-accessible") {
    yield* logBootstrapWarning(
      "bootstrap fell back to local-only because no advertised network host was available",
    );
  }

  yield* installDesktopIpcHandlers;
  yield* logBootstrapInfo("bootstrap ipc handlers registered");

  yield* startBackendAfterProviderDaemonReady({
    providerDaemonReady: Fiber.join(providerDaemonReadyFiber).pipe(
      Effect.tap((endpoint) =>
        logBootstrapInfo("bootstrap provider daemon ready", { endpoint: endpoint.httpBaseUrl }),
      ),
    ),
    startBackend: backendManager.start.pipe(
      Effect.andThen(logBootstrapInfo("bootstrap backend start requested")),
    ),
    quitting: state.quitting,
  });
  // Register the optional Mac hotkey only after Electron and the local
  // backend are ready. The coordinator's scoped finalizer unregisters it on
  // Quit; closing the ordinary main window does not end dictation on macOS.
  yield* installGlobalDictationCoordinator;
  yield* runProviderDaemonHealthWatchdog({
    backendManager,
    providerDaemonManager,
    quitting: state.quitting,
  }).pipe(Effect.forkScoped);
}).pipe(Effect.withSpan("desktop.bootstrap"));

const startup = Effect.gen(function* () {
  const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
  const applicationMenu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const sourceUpdates = yield* DesktopSourceUpdates.DesktopSourceUpdates;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;

  yield* shellEnvironment.installIntoProcess;
  const userDataPath = yield* appIdentity.resolveUserDataPath;
  yield* electronApp.setPath("userData", userDataPath);
  yield* logStartupInfo("runtime logging configured", { logDir: environment.logDir });
  const startupRole = yield* acquireSingleInstanceLock();
  if (startupRole === "secondary") {
    return startupRole;
  }
  yield* desktopSettings.load;
  const locale = yield* Effect.serviceOption(DesktopUiLocale.DesktopUiLocale);
  if (Option.isSome(locale)) yield* locale.value.initialize;

  if (environment.platform === "linux") {
    yield* electronApp.appendCommandLineSwitch("class", environment.linuxWmClass);
  }

  yield* appIdentity.configure;
  yield* lifecycle.register;

  yield* electronApp.whenReady.pipe(
    Effect.withSpan("desktop.electron.whenReady"),
    Effect.catchCause((cause) => fatalStartupCause("whenReady", cause)),
  );
  yield* logStartupInfo("app ready");
  const startupWindow = yield* Effect.serviceOption(DesktopStartupWindow.DesktopStartupWindow);
  if (Option.isSome(startupWindow)) yield* startupWindow.value.begin;
  yield* appIdentity.configure;
  yield* applicationMenu.configure;
  yield* electronProtocol.registerDesktopFileProtocol;
  yield* updates.configure;
  yield* sourceUpdates.configure;
  yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
  return startupRole;
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
  Effect.gen(function* () {
    const runId = yield* makeDesktopRunId;
    yield* Effect.annotateLogsScoped({ scope: "desktop", runId });
    yield* Effect.annotateCurrentSpan({ scope: "desktop", runId });

    const shutdown = yield* DesktopLifecycle.DesktopShutdown;
    const backendManager = yield* DesktopBackendManager.DesktopBackendManager;

    yield* Effect.addFinalizer(() =>
      backendManager
        .stop({ timeout: DESKTOP_SHUTDOWN_BACKEND_STOP_TIMEOUT })
        .pipe(Effect.ensuring(shutdown.markComplete)),
    );

    const startupRole = yield* runDesktopStartupUntilShutdown({
      startup,
      awaitShutdown: shutdown.awaitRequest,
    });
    if (startupRole === "secondary") {
      return;
    }
    yield* shutdown.awaitRequest;
  }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
