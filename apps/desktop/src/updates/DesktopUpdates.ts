import type {
  DesktopRuntimeInfo,
  DesktopUpdateActionResult,
  DesktopUpdateChannel,
  DesktopUpdateCheckResult,
  DesktopUpdateInstallMode,
  DesktopUpdateState,
} from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopProviderDaemonManager from "../backend/DesktopProviderDaemonManager.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";
import {
  getAutoUpdateDisabledReason,
  resolveDesktopUpdateInstallMode,
} from "./updateEligibility.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "4 minutes";

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const UpdateInfo = Schema.Struct({
  version: Schema.String,
});

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});
const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);
const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class DesktopUpdateActionInProgressError extends Data.TaggedError(
  "DesktopUpdateActionInProgressError",
)<{
  readonly action: "check" | "download" | "install";
}> {
  override get message() {
    return `Cannot change update tracks while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdatePersistenceError extends Data.TaggedError(
  "DesktopUpdatePersistenceError",
)<{
  readonly cause: DesktopAppSettings.DesktopSettingsWriteError;
}> {
  override get message() {
    return "Failed to persist desktop update settings.";
  }
}

export type DesktopUpdateConfigureError = never;

export type DesktopUpdateSetChannelError =
  | DesktopUpdateActionInProgressError
  | DesktopUpdatePersistenceError;

export interface DesktopUpdatesShape {
  readonly getState: Effect.Effect<DesktopUpdateState>;
  readonly emitState: Effect.Effect<void>;
  readonly disabledReason: Effect.Effect<Option.Option<string>>;
  readonly configure: Effect.Effect<void, DesktopUpdateConfigureError, Scope.Scope>;
  readonly setChannel: (
    channel: DesktopUpdateChannel,
  ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
  readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
  readonly download: Effect.Effect<DesktopUpdateActionResult>;
  readonly install: Effect.Effect<DesktopUpdateActionResult>;
}

export class DesktopUpdates extends Context.Service<DesktopUpdates, DesktopUpdatesShape>()(
  "cafecode/desktop/Updates",
) {}

const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.catch(() => Effect.succeed(Option.none<AppUpdateYmlConfig>())),
  );
}

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  enabled: boolean,
  environment: DesktopEnvironment.DesktopEnvironmentShape,
  installMode: DesktopUpdateInstallMode,
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      channel,
      installMode,
    ),
    // Packaging identity is supplied by the trusted main process. Feed absence,
    // disabled updates and manual installation do not imply a source checkout.
    runtimeKind: environment.isPackaged ? "packaged" : "source",
    enabled,
    status: enabled ? "idle" : "disabled",
  };
}

function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading") {
    return true;
  }

  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
  const providerDaemon = yield* DesktopProviderDaemonManager.DesktopProviderDaemonManager;
  const desktopState = yield* DesktopState.DesktopState;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;

  const packageJson =
    environment.isPackaged && environment.platform === "darwin"
      ? yield* fileSystem
          .readFileString(environment.path.join(environment.appRoot, "package.json"), "utf-8")
          .pipe(Effect.option, Effect.map(Option.getOrUndefined))
      : undefined;
  const installMode = resolveDesktopUpdateInstallMode(environment.platform, packageJson);

  const appUpdateYmlConfigRef = yield* Ref.make<Option.Option<AppUpdateYmlConfig>>(Option.none());
  const updateCheckInFlightRef = yield* Ref.make(false);
  const updateDownloadInFlightRef = yield* Ref.make(false);
  const updateInstallInFlightRef = yield* Ref.make(false);
  // Native updater events may invalidate an attempt, but cannot release its
  // shutdown reservation while its exact controller is still awaiting IO.
  const installAttemptRef = yield* Ref.make<{
    invalidated: boolean;
    installerInvoked: boolean;
  } | null>(null);
  const updaterConfiguredRef = yield* Ref.make(false);
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);
  const updateStateRef = yield* Ref.make<DesktopUpdateState>({
    ...createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
      installMode,
    ),
    runtimeKind: environment.isPackaged ? "packaged" : "source",
  });

  const emitState = Ref.get(updateStateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );

  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    Ref.set(updateStateRef, state).pipe(Effect.andThen(emitState));

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => {
        const nextState = f(state);
        return setState(nextState).pipe(Effect.as(nextState));
      }),
    );

  const readAppUpdateYml = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
        onSome: parseAppUpdateYml,
      }),
    ),
  );

  const hasUpdateFeedConfig = Ref.get(appUpdateYmlConfigRef).pipe(
    Effect.map((appUpdateYmlConfig) => Option.isSome(appUpdateYmlConfig) || config.mockUpdates),
  );

  const resolveDisabledReason = Effect.gen(function* () {
    const hasFeedConfig = yield* hasUpdateFeedConfig;
    return Option.fromNullishOr(
      getAutoUpdateDisabledReason({
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        appImage: Option.getOrUndefined(config.appImagePath),
        disabledByEnv: config.disableAutoUpdate,
        hasUpdateFeedConfig: hasFeedConfig,
      }),
    );
  });

  const resolveUpdaterErrorContext = Effect.gen(function* () {
    if (yield* Ref.get(updateInstallInFlightRef)) return "install" as const;
    if (yield* Ref.get(updateDownloadInFlightRef)) return "download" as const;
    if (yield* Ref.get(updateCheckInFlightRef)) return "check" as const;
    return (yield* Ref.get(updateStateRef)).errorContext;
  });

  const activeUpdateAction = Effect.gen(function* () {
    if (yield* Ref.get(updateInstallInFlightRef)) return Option.some("install" as const);
    if (yield* Ref.get(updateDownloadInFlightRef)) return Option.some("download" as const);
    if (yield* Ref.get(updateCheckInFlightRef)) return Option.some("check" as const);
    return Option.none<"check" | "download" | "install">();
  });

  const applyAutoUpdaterChannel = Effect.fn("desktop.updates.applyAutoUpdaterChannel")(function* (
    channel: DesktopUpdateChannel,
  ) {
    yield* Effect.annotateCurrentSpan({ channel });
    const allowsPrerelease = channel === "nightly";
    yield* electronUpdater.setChannel(channel);
    yield* electronUpdater.setAllowPrerelease(allowsPrerelease);
    yield* electronUpdater.setAllowDowngrade(allowsPrerelease);
    yield* logUpdaterInfo("using update channel", {
      channel,
      allowPrerelease: allowsPrerelease,
      allowDowngrade: allowsPrerelease,
    });
  });

  const shouldEnableAutoUpdates = resolveDisabledReason.pipe(Effect.map(Option.isNone));

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")(function* (reason: string) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;
    if (yield* Ref.get(updateCheckInFlightRef)) return false;

    const state = yield* Ref.get(updateStateRef);
    if (state.status === "downloading" || state.status === "downloaded") {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    yield* Ref.set(updateCheckInFlightRef, true);
    const checkedAt = yield* currentIsoTimestamp;
    yield* setState(reduceDesktopUpdateStateOnCheckStart(state, checkedAt));
    yield* logUpdaterInfo("checking for updates", { reason });

    return yield* electronUpdater.checkForUpdates.pipe(
      Effect.as(true),
      Effect.catch(
        Effect.fn("desktop.updates.handleCheckForUpdatesFailure")(function* (error) {
          const failedAt = yield* currentIsoTimestamp;
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnCheckFailure(current, error.message, failedAt),
          );
          yield* logUpdaterError("failed to check for updates", { message: error.message });
          return true;
        }),
      ),
      Effect.ensuring(Ref.set(updateCheckInFlightRef, false)),
    );
  });

  const downloadAvailableUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (
      !(yield* Ref.get(updaterConfiguredRef)) ||
      (yield* Ref.get(updateDownloadInFlightRef)) ||
      state.installMode !== "in-app" ||
      state.status !== "available"
    ) {
      return { accepted: false, completed: false };
    }

    yield* Ref.set(updateDownloadInFlightRef, true);
    return yield* Effect.gen(function* () {
      yield* setState(reduceDesktopUpdateStateOnDownloadStart(state));
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );
      yield* logUpdaterInfo("downloading update");
      yield* electronUpdater.downloadUpdate;
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catch(
        Effect.fn("desktop.updates.handleDownloadFailure")(function* (error) {
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
          );
          yield* logUpdaterError("failed to download update", { message: error.message });
          return { accepted: true, completed: false };
        }),
      ),
      Effect.ensuring(Ref.set(updateDownloadInFlightRef, false)),
    );
  }).pipe(Effect.withSpan("desktop.updates.downloadAvailableUpdate"));

  const installDownloadedUpdate = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(updateStateRef);
      if (
        (yield* Ref.get(desktopState.quitting)) ||
        !(yield* Ref.get(updaterConfiguredRef)) ||
        state.installMode !== "in-app" ||
        state.status !== "downloaded" ||
        state.downloadedVersion === null
      )
        return { accepted: false, completed: false };

      const downloadedVersion = state.downloadedVersion;
      const attempt = { invalidated: false, installerInvoked: false };
      const admitted = yield* Ref.modify(installAttemptRef, (current) =>
        current === null ? ([true, attempt] as const) : ([false, current] as const),
      );
      if (!admitted) return { accepted: false, completed: false };
      let ownsQuitting = false;
      const isCurrent = Effect.gen(function* () {
        const currentAttempt = yield* Ref.get(installAttemptRef);
        const currentState = yield* Ref.get(updateStateRef);
        // Consent belongs to this exact downloaded target, not whichever feed
        // event happens to arrive while the native dialog/retirement is pending.
        return (
          currentAttempt === attempt &&
          !attempt.invalidated &&
          currentState.status === "downloaded" &&
          currentState.downloadedVersion === downloadedVersion &&
          currentState.channel === state.channel &&
          currentState.installMode === "in-app"
        );
      });
      const installFailure = (message: string) =>
        Effect.gen(function* () {
          yield* updateState((current) => ({
            ...reduceDesktopUpdateStateOnInstallFailure(current, message),
            // A thrown updater call is not evidence that native handoff did not
            // occur. Feedback may change, but an indeterminate install cannot retry.
            canRetry: !attempt.installerInvoked,
          }));
          yield* logUpdaterError("failed to install update", { message });
          return { accepted: true, completed: false };
        });
      const ownershipFailure = (cause: Cause.Cause<unknown>) =>
        (attempt.invalidated
          ? Effect.succeed({ accepted: true, completed: false })
          : installFailure(
              uiText(
                "The update was not installed because Cafe Code could not safely prepare and stop its provider runtime. The downloaded update is still available. Stop the runtime explicitly before retrying.",
              ),
            )
        ).pipe(
          // Publish only fixed feedback, then preserve exact caller interruption.
          // The controller finalizer, not a received event, retires admission.
          Effect.flatMap((result) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(
                  Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
                )
              : Effect.succeed(result),
          ),
        );

      return yield* Effect.gen(function* () {
        // Reserve before the native dialog can yield. Do not clear another
        // lifecycle owner's already-established quit reservation in finalization.
        if (yield* Ref.getAndSet(desktopState.quitting, true))
          return { accepted: false, completed: false };
        ownsQuitting = true;
        yield* Ref.set(updateInstallInFlightRef, true);
        const retirement = yield* restore(
          Effect.gen(function* () {
            const confirmation = yield* electronDialog.showMessageBox({
              type: "warning",
              title: uiText("Stop sessions and update"),
              message: uiText("Stop all provider sessions and install Cafe Code {version}?", {
                version: downloadedVersion,
              }),
              detail: uiText(
                "Updating will stop all Codex, Claude, and other provider work, including work that starts while this dialog is open. Stop sessions and install the downloaded update?",
              ),
              buttons: [uiText("Cancel"), uiText("Stop Sessions and Update")],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            });
            if (!(yield* isCurrent)) return "invalidated" as const;
            if (confirmation.response !== 1) return "cancelled" as const;
            // Missing qualification is never permission to stop or install.
            if (!providerDaemon.prepareForUpdate) return "unavailable" as const;
            yield* providerDaemon.prepareForUpdate;
            if (!(yield* isCurrent)) return "invalidated" as const;
            yield* backendManager.stop({
              timeout: Duration.seconds(5),
              requireConfirmedExit: true,
            });
            if (!(yield* isCurrent)) return "invalidated" as const;
            // Final Stop independently rechecks its native owner and confirms exit.
            yield* providerDaemon.stop;
            if (!(yield* isCurrent)) return "invalidated" as const;
            return "retired" as const;
          }),
        ).pipe(
          Effect.catchCause((cause) => ownershipFailure(cause).pipe(Effect.as("failed" as const))),
        );
        if (retirement === "cancelled") return { accepted: false, completed: false };
        if (retirement === "unavailable")
          return yield* ownershipFailure(
            Cause.die("Provider daemon update preparation unavailable"),
          );
        if (retirement !== "retired") return { accepted: true, completed: false };

        const destroyed = yield* restore(electronWindow.destroyAll).pipe(
          Effect.as(true),
          Effect.catchCause((cause) => ownershipFailure(cause).pipe(Effect.as(false))),
        );
        if (!destroyed || !(yield* isCurrent)) return { accepted: true, completed: false };

        // Native handoff has no positive installation ACK. Keep quit reserved
        // after success or an unknown defect/interrupt; never authorize replay.
        attempt.installerInvoked = true;
        return yield* restore(
          electronUpdater.quitAndInstall({
            isSilent: true,
            isForceRunAfter: true,
          }),
        ).pipe(
          Effect.as({ accepted: true, completed: false }),
          Effect.catch(
            Effect.fn("desktop.updates.handleInstallFailure")(function* (error) {
              return yield* installFailure(error.message);
            }),
          ),
        );
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (!attempt.installerInvoked) {
              if (ownsQuitting) {
                yield* Ref.set(updateInstallInFlightRef, false);
                yield* Ref.set(desktopState.quitting, false);
              }
              yield* Ref.update(installAttemptRef, (current) =>
                current === attempt ? null : current,
              );
            }
            // Once the native installer has been invoked, retain this exact attempt
            // through app teardown. A later error event must not mint replay authority.
          }),
        ),
      );
    }),
  ).pipe(Effect.withSpan("desktop.updates.installDownloadedUpdate"));

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates("startup")),
      Effect.catchCause((cause) =>
        logUpdaterError("startup update check failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkForUpdates("poll")),
      Effect.forever,
      Effect.catchCause((cause) =>
        logUpdaterError("poll update check failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.updates.startPollers"));

  const handleUpdateAvailable = Effect.fn("desktop.updates.handleUpdateAvailable")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateAvailable")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          if (resolveDefaultDesktopUpdateChannel(info.version) !== state.channel) {
            yield* logUpdaterInfo("ignoring update that does not match selected channel", {
              version: info.version,
              channel: state.channel,
            });
            const checkedAt = yield* currentIsoTimestamp;
            yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
            yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
            return;
          }

          const checkedAt = yield* currentIsoTimestamp;
          yield* setState(
            reduceDesktopUpdateStateOnUpdateAvailable(state, info.version, checkedAt),
          );
          yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
          yield* logUpdaterInfo("update available", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) =>
        logUpdaterWarning("ignored malformed update-available event", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const handleUpdateNotAvailable = Effect.gen(function* () {
    const checkedAt = yield* currentIsoTimestamp;
    const state = yield* Ref.get(updateStateRef);
    yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
    yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
    yield* logUpdaterInfo("no updates available");
  }).pipe(Effect.withSpan("desktop.updates.handleUpdateNotAvailable"));

  const handleUpdaterError = Effect.fn("desktop.updates.handleUpdaterError")(function* (
    _error: unknown,
  ) {
    // Electron forwards arbitrary native event values, not the typed wrapper's
    // fixed errors. Never inspect a received message/name/stack, enumerate it or
    // invoke toString; even diagnostics must contain only this finite context.
    const attempt = yield* Ref.get(installAttemptRef);
    const context = attempt !== null ? "install" : ((yield* resolveUpdaterErrorContext) ?? "check");
    const message =
      context === "install"
        ? uiText("Cafe Code could not confirm update installation.")
        : context === "download"
          ? uiText("Cafe Code could not download the update.")
          : uiText("Cafe Code could not check for updates.");
    if (attempt !== null) {
      // A native error can veto this exact controller, but cannot let another
      // install/watchdog/poller race its still-pending ownership operations.
      attempt.invalidated = true;
      yield* updateState((current) => ({
        ...reduceDesktopUpdateStateOnInstallFailure(current, message),
        canRetry: !attempt.installerInvoked,
      }));
      yield* logUpdaterError("updater error", { message, context });
      return;
    }
    if (yield* Ref.get(updateInstallInFlightRef)) {
      yield* Ref.set(updateInstallInFlightRef, false);
      yield* Ref.set(desktopState.quitting, false);
      yield* updateState((current) => reduceDesktopUpdateStateOnInstallFailure(current, message));
      yield* logUpdaterError("updater error", { message, context });
      return;
    }

    if (context === "download") {
      yield* updateState((current) => reduceDesktopUpdateStateOnDownloadFailure(current, message));
    } else if (context === "install") {
      yield* updateState((current) => reduceDesktopUpdateStateOnInstallFailure(current, message));
    } else {
      const checkedAt = yield* currentIsoTimestamp;
      yield* updateState((current) =>
        reduceDesktopUpdateStateOnCheckFailure(current, message, checkedAt),
      );
    }

    yield* logUpdaterError("updater error", { message, context });
  });

  const handleDownloadProgress = Effect.fn("desktop.updates.handleDownloadProgress")(function* (
    raw: unknown,
  ) {
    yield* decodeDownloadProgressInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyDownloadProgress")(function* (progress) {
          const state = yield* Ref.get(updateStateRef);
          const percent = Math.floor(progress.percent);
          if (shouldBroadcastDownloadProgress(state, progress.percent) || state.message !== null) {
            yield* setState(reduceDesktopUpdateStateOnDownloadProgress(state, progress.percent));
          }
          const milestone = percent - (percent % 10);
          const lastLoggedMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
          if (milestone > lastLoggedMilestone) {
            yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
            yield* logUpdaterInfo("download progress", { percent });
          }
        }),
      ),
      Effect.catchCause((cause) =>
        logUpdaterWarning("ignored malformed download-progress event", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const handleUpdateDownloaded = Effect.fn("desktop.updates.handleUpdateDownloaded")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateDownloaded")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          yield* setState(reduceDesktopUpdateStateOnDownloadComplete(state, info.version));
          yield* logUpdaterInfo("update downloaded", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) =>
        logUpdaterWarning("ignored malformed update-downloaded event", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  return DesktopUpdates.of({
    getState: Ref.get(updateStateRef),
    emitState,
    disabledReason: resolveDisabledReason,
    configure: Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runEffect = (effect: Effect.Effect<void>) => {
        void Effect.runPromiseWith(context)(effect);
      };

      const appUpdateYmlConfig = yield* readAppUpdateYml;
      yield* Ref.set(appUpdateYmlConfigRef, appUpdateYmlConfig);

      const settings = yield* desktopSettings.get;
      const enabled = yield* shouldEnableAutoUpdates;
      yield* setState(
        createBaseUpdateState(settings.updateChannel, enabled, environment, installMode),
      );
      if (!enabled) {
        return;
      }

      if (config.mockUpdates) {
        yield* electronUpdater.setFeedURL({
          provider: "generic",
          url: `http://localhost:${config.mockUpdateServerPort}`,
        } as ElectronUpdater.ElectronUpdaterFeedUrl);
      }

      yield* Ref.set(updaterConfiguredRef, true);

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);
      yield* applyAutoUpdaterChannel(settings.updateChannel);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );

      if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
        yield* logUpdaterInfo(
          "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
        );
      }

      yield* electronUpdater.on("checking-for-update", () => {
        runEffect(
          logUpdaterInfo("looking for updates").pipe(
            Effect.withSpan("desktop.updates.handleCheckingForUpdate"),
          ),
        );
      });
      yield* electronUpdater.on("update-available", (info: unknown) => {
        runEffect(handleUpdateAvailable(info));
      });
      yield* electronUpdater.on("update-not-available", () => {
        runEffect(handleUpdateNotAvailable);
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runEffect(handleUpdaterError(error));
      });
      yield* electronUpdater.on("download-progress", (progress: unknown) => {
        runEffect(handleDownloadProgress(progress));
      });
      yield* electronUpdater.on("update-downloaded", (info: unknown) => {
        runEffect(handleUpdateDownloaded(info));
      });

      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      const activeAction = yield* activeUpdateAction;
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({ action: activeAction.value });
      }

      const state = yield* Ref.get(updateStateRef);
      if (nextChannel === state.channel) {
        return state;
      }

      yield* desktopSettings
        .setUpdateChannel(nextChannel)
        .pipe(Effect.mapError((cause) => new DesktopUpdatePersistenceError({ cause })));

      const enabled = yield* shouldEnableAutoUpdates;
      yield* setState(createBaseUpdateState(nextChannel, enabled, environment, installMode));

      if (!enabled || !(yield* Ref.get(updaterConfiguredRef))) {
        return yield* Ref.get(updateStateRef);
      }

      yield* applyAutoUpdaterChannel(nextChannel);
      const allowDowngrade = yield* electronUpdater.allowDowngrade;
      yield* electronUpdater.setAllowDowngrade(true);
      yield* checkForUpdates("channel-change").pipe(
        Effect.ensuring(electronUpdater.setAllowDowngrade(allowDowngrade).pipe(Effect.ignore)),
      );
      return yield* Ref.get(updateStateRef);
    }),
    check: Effect.fn("desktop.updates.check")(function* (reason: string) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (!(yield* Ref.get(updaterConfiguredRef))) {
        return {
          checked: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const checked = yield* checkForUpdates(reason);
      return {
        checked,
        state: yield* Ref.get(updateStateRef),
      };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: Effect.gen(function* () {
      if (yield* Ref.get(desktopState.quitting)) {
        return {
          accepted: false,
          completed: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const result = yield* installDownloadedUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.install")),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);
