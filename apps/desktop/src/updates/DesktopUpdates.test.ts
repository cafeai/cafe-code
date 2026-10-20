import * as NodePath from "@effect/platform-node/NodePath";
import type { DesktopUpdateState } from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopProviderDaemonManager from "../backend/DesktopProviderDaemonManager.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

interface InstallBehavior {
  readonly check?: Effect.Effect<void>;
  readonly download?: Effect.Effect<void>;
  readonly confirmation?: Effect.Effect<number>;
  readonly preparation?: Effect.Effect<void> | "missing";
  readonly backendStop?: Effect.Effect<void>;
  readonly daemonStop?: Effect.Effect<void>;
  readonly quitAndInstall?: Effect.Effect<void, ElectronUpdater.ElectronUpdaterQuitAndInstallError>;
  readonly observeDialog?: (
    options: Parameters<ElectronDialog.ElectronDialogShape["showMessageBox"]>[0],
  ) => void;
}

const PRIVATE_EVENT_SENTINEL = "PRIVATE_UPDATER_EVENT_SECRET";
const encodeObservation = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

/** Received native errors are intentionally not trusted tagged wrapper errors. */
function receivedEventError(
  kind: "native-error" | "hostile-error" | "hostile-object",
  reads: { getters: number; toString: number; primitive: number },
): unknown {
  if (kind === "native-error") return new Error(`${PRIVATE_EVENT_SENTINEL} /private/profile/token`);
  const value: unknown = Object.create(kind === "hostile-error" ? Error.prototype : null, {
    message: {
      get: () => {
        reads.getters += 1;
        return PRIVATE_EVENT_SENTINEL;
      },
    },
    name: {
      get: () => {
        reads.getters += 1;
        return PRIVATE_EVENT_SENTINEL;
      },
    },
    stack: {
      get: () => {
        reads.getters += 1;
        return PRIVATE_EVENT_SENTINEL;
      },
    },
    toString: {
      value: () => {
        reads.toString += 1;
        return PRIVATE_EVENT_SENTINEL;
      },
    },
    [Symbol.toPrimitive]: {
      value: () => {
        reads.primitive += 1;
        return PRIVATE_EVENT_SENTINEL;
      },
    },
  });
  return value;
}

function withUpdates<A, E, R>(
  packageJson: string | undefined,
  task: (fixture: {
    readonly calls: string[];
    readonly reads: string[];
    readonly logs: ReadonlyArray<ReturnType<typeof Logger.formatStructured.log>>;
    readonly available: Deferred.Deferred<DesktopUpdateState>;
    readonly downloaded: Deferred.Deferred<DesktopUpdateState>;
    readonly replacementDownloaded: Deferred.Deferred<DesktopUpdateState>;
    readonly announce: Effect.Effect<void>;
    readonly announceDownloaded: (version: string) => Effect.Effect<void>;
    readonly announceError: (error: unknown) => Effect.Effect<DesktopUpdateState>;
  }) => Effect.Effect<A, E, R | DesktopUpdates.DesktopUpdates>,
  isPackaged = true,
  installBehavior: InstallBehavior = {},
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const calls: string[] = [];
      const reads: string[] = [];
      const available = yield* Deferred.make<DesktopUpdateState>();
      const downloaded = yield* Deferred.make<DesktopUpdateState>();
      const replacementDownloaded = yield* Deferred.make<DesktopUpdateState>();
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      let pendingErrorLog: Deferred.Deferred<void> | null = null;
      let publishedState: DesktopUpdateState | undefined;
      const logger = Logger.make((options) => {
        const record = Logger.formatStructured.log(options);
        logs.push(record);
        if (record.message === "updater error" && pendingErrorLog !== null) {
          Effect.runSync(Deferred.succeed(pendingErrorLog, undefined));
        }
      });
      const listeners = new Map<string, (...args: readonly unknown[]) => void>();
      const record = (call: string) =>
        Effect.sync(() => {
          calls.push(call);
        });
      const emitValue = (event: string, value: unknown) =>
        Effect.sync(() => {
          const listener = listeners.get(event);
          assert.isDefined(listener);
          listener!(value);
        });
      const emit = (event: string) => emitValue(event, { version: "1.1.0" });
      const root = path.resolve("desktop-update-fixture");
      const appRoot = path.join(root, "app");
      const resourcesPath = path.join(root, "resources");
      const missingFiles = FileSystem.makeNoop({});
      const fileSystem = FileSystem.layerNoop({
        readFileString: (filePath) => {
          reads.push(filePath);
          if (filePath === path.join(appRoot, "package.json") && packageJson !== undefined) {
            return Effect.succeed(packageJson);
          }
          if (filePath === path.join(resourcesPath, "app-update.yml")) {
            return Effect.succeed("provider: github\nowner: cafeai\nrepo: cafe-code\n");
          }
          return missingFiles.readFileString(filePath);
        },
        makeDirectory: () => Effect.void,
        writeFileString: () => Effect.void,
        rename: () => Effect.void,
      });
      const updater = Layer.succeed(ElectronUpdater.ElectronUpdater, {
        setFeedURL: () => Effect.die("unexpected feed override"),
        setAutoDownload: (value) => record(`autoDownload:${value}`),
        setAutoInstallOnAppQuit: (value) => record(`autoInstallOnAppQuit:${value}`),
        setChannel: (channel) => record(`channel:${channel}`),
        setAllowPrerelease: () => Effect.void,
        allowDowngrade: Effect.succeed(false),
        setAllowDowngrade: () => Effect.void,
        setDisableDifferentialDownload: () => Effect.void,
        checkForUpdates: record("check").pipe(Effect.andThen(installBehavior.check ?? Effect.void)),
        downloadUpdate: record("download").pipe(
          Effect.andThen(installBehavior.download ?? Effect.void),
          Effect.andThen(emit("update-downloaded")),
        ),
        quitAndInstall: (options) =>
          Effect.sync(() => {
            assert.deepEqual(options, { isSilent: true, isForceRunAfter: true });
            calls.push("install");
          }).pipe(Effect.andThen(installBehavior.quitAndInstall ?? Effect.void)),
        on: (event, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              listeners.set(event, listener as (...args: readonly unknown[]) => void);
            }),
            () =>
              Effect.sync(() => {
                listeners.delete(event);
              }),
          ).pipe(Effect.asVoid),
      });
      const windows = Layer.succeed(ElectronWindow.ElectronWindow, {
        create: () => Effect.die("unexpected window creation"),
        main: Effect.succeed(Option.none()),
        currentMainOrFirst: Effect.succeed(Option.none()),
        focusedMainOrFirst: Effect.succeed(Option.none()),
        setMain: () => Effect.void,
        clearMain: () => Effect.void,
        reveal: () => Effect.void,
        sendAll: (_channel, ...args) => {
          const state = args[0] as DesktopUpdateState;
          publishedState = state;
          if (state.status === "available")
            return Deferred.succeed(available, state).pipe(Effect.asVoid);
          if (state.status === "downloaded" && state.downloadedVersion === "1.2.0")
            return Deferred.succeed(replacementDownloaded, state).pipe(Effect.asVoid);
          if (state.status === "downloaded")
            return Deferred.succeed(downloaded, state).pipe(Effect.asVoid);
          return Effect.void;
        },
        destroyAll: record("destroy-windows"),
        syncAllAppearance: () => Effect.void,
      });
      const backend = Layer.succeed(DesktopBackendManager.DesktopBackendManager, {
        start: Effect.die("unexpected backend start"),
        stop: (options) => {
          assert.equal(Duration.toMillis(options?.timeout ?? Duration.zero), 5_000);
          assert.isTrue(options?.requireConfirmedExit);
          return record("stop-backend").pipe(
            Effect.andThen(installBehavior.backendStop ?? Effect.void),
          );
        },
        currentConfig: Effect.succeed(Option.none()),
        snapshot: Effect.die("unexpected backend snapshot"),
      });
      const daemon = Layer.succeed(DesktopProviderDaemonManager.DesktopProviderDaemonManager, {
        ...(installBehavior.preparation === "missing"
          ? {}
          : {
              prepareForUpdate: record("prepare-daemon").pipe(
                Effect.andThen(installBehavior.preparation ?? Effect.void),
              ),
            }),
        ensureRunning: Effect.die("unexpected daemon opening"),
        recover: () => Effect.die("unexpected daemon recovery"),
        currentConfig: Effect.succeed(Option.none()),
        probeLiveness: Effect.die("unexpected daemon liveness observation"),
        refreshHealth: Effect.die("cached session counts cannot replace update consent"),
        snapshot: Effect.die("cached daemon state cannot replace update preparation"),
        stop: record("stop-daemon").pipe(Effect.andThen(installBehavior.daemonStop ?? Effect.void)),
      });
      const dialog = Layer.succeed(ElectronDialog.ElectronDialog, {
        pickFolder: () => Effect.die("unexpected folder picker"),
        confirm: () => Effect.die("update consent requires the explicit native warning"),
        showErrorBox: () => Effect.die("unexpected unowned error dialog"),
        showMessageBox: (options) =>
          record("confirm-update").pipe(
            Effect.andThen(
              Effect.sync(() => {
                assert.equal(options.type, "warning");
                assert.equal(options.defaultId, 0);
                assert.equal(options.cancelId, 0);
                assert.isTrue(options.noLink);
                assert.deepEqual(options.buttons, ["Cancel", "Stop Sessions and Update"]);
                assert.include(options.message, "Stop all provider sessions");
                assert.include(options.message, "1.1.0");
                assert.include(options.detail ?? "", "all Codex, Claude, and other provider work");
                installBehavior.observeDialog?.(options);
              }),
            ),
            Effect.andThen(installBehavior.confirmation ?? Effect.succeed(1)),
            Effect.map((response) => ({ response, checkboxChecked: false })),
          ),
      });
      const environment = DesktopEnvironment.layer({
        dirname: path.join(root, "apps", "desktop", "dist-electron"),
        homeDirectory: path.join(root, "home"),
        platform: "darwin",
        processArch: "arm64",
        appVersion: "1.0.0",
        appPath: appRoot,
        isPackaged,
        resourcesPath,
        runningUnderArm64Translation: false,
      }).pipe(Layer.provideMerge(Layer.mergeAll(NodePath.layer, DesktopConfig.layerTest({}))));
      const dependencies = Layer.mergeAll(
        environment,
        fileSystem,
        updater,
        windows,
        backend,
        daemon,
        dialog,
        DesktopState.layer,
      );
      const layer = DesktopUpdates.layer.pipe(
        Layer.provideMerge(DesktopAppSettings.layer.pipe(Layer.provideMerge(dependencies))),
      );
      return yield* task({
        calls,
        reads,
        logs,
        available,
        downloaded,
        replacementDownloaded,
        announce: emit("update-available"),
        announceDownloaded: (version) => emitValue("update-downloaded", { version }),
        announceError: (error) =>
          Effect.gen(function* () {
            const receipt = yield* Deferred.make<void>();
            if (pendingErrorLog !== null)
              return yield* Effect.die("Unexpected overlapping fixture error");
            pendingErrorLog = receipt;
            return yield* Effect.gen(function* () {
              yield* emitValue("error", error);
              // Arm before the actual event. Each call waits for this handler's
              // final fixed log, never an earlier state/error publication.
              yield* Deferred.await(receipt);
              assert.isDefined(publishedState);
              return publishedState!;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (pendingErrorLog === receipt) pendingErrorLog = null;
                }),
              ),
            );
          }),
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(Logger.layer([logger])))));
    }),
  );
}

/** Complete the real controller's requested download before testing installation. */
const downloadForInstall = (fixture: {
  readonly available: Deferred.Deferred<DesktopUpdateState>;
  readonly downloaded: Deferred.Deferred<DesktopUpdateState>;
  readonly announce: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    yield* updates.configure;
    yield* fixture.announce;
    assert.equal((yield* Deferred.await(fixture.available)).availableVersion, "1.1.0");
    const download = yield* updates.download;
    assert.isTrue(download.accepted);
    assert.isTrue(download.completed);
    assert.equal((yield* Deferred.await(fixture.downloaded)).downloadedVersion, "1.1.0");
    return updates;
  });

describe("macOS packaged update policy", () => {
  it.effect(
    "executes the delayed startup and recurring release checks without automatic installation",
    () =>
      withUpdates('{"cafeCodeMacInAppUpdates":true}', ({ calls, available, announce }) =>
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          const state = yield* DesktopState.DesktopState;
          const checks = () => calls.filter((call) => call === "check").length;
          yield* updates.configure;
          // TestClock drains the actual scoped sleep fibers. These counts are
          // recorded inside the original fake updater Effect, not mock invocation.
          yield* TestClock.adjust("14 seconds");
          assert.equal(checks(), 0);
          yield* TestClock.adjust("1 second");
          assert.equal(checks(), 1);
          yield* announce;
          assert.equal((yield* Deferred.await(available)).availableVersion, "1.1.0");
          assert.isFalse(calls.includes("download"));
          assert.isFalse(calls.includes("install"));

          // Polling starts from configuration, not from the startup check.
          yield* TestClock.adjust("224 seconds");
          assert.equal(checks(), 1);
          yield* TestClock.adjust("1 second");
          assert.equal(checks(), 2);
          yield* TestClock.adjust("4 minutes");
          assert.equal(checks(), 3);

          // A later timer tick during quit cannot check, download, stop the
          // backend, destroy windows or install the already announced release.
          yield* Ref.set(state.quitting, true);
          yield* TestClock.adjust("4 minutes");
          assert.deepEqual(calls, [
            "autoDownload:false",
            "autoInstallOnAppQuit:false",
            "channel:latest",
            "check",
            "check",
            "check",
          ]);
        }),
      ),
  );

  it.effect(
    "preserves the signed package mode across tracks and admits only requested download/install",
    () =>
      withUpdates(
        '{"cafeCodeMacInAppUpdates":true}',
        ({ calls, available, downloaded, announce }) =>
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            assert.equal((yield* updates.getState).runtimeKind, "packaged");
            assert.equal((yield* updates.getState).installMode, "in-app");
            yield* updates.configure;
            assert.equal((yield* updates.getState).runtimeKind, "packaged");
            assert.deepEqual(calls, [
              "autoDownload:false",
              "autoInstallOnAppQuit:false",
              "channel:latest",
            ]);
            assert.equal((yield* updates.setChannel("nightly")).installMode, "in-app");
            assert.equal((yield* updates.getState).runtimeKind, "packaged");
            assert.equal((yield* updates.setChannel("latest")).installMode, "in-app");
            assert.equal((yield* updates.getState).runtimeKind, "packaged");
            assert.deepEqual(calls.slice(3), [
              "channel:nightly",
              "check",
              "channel:latest",
              "check",
            ]);
            assert.isFalse((yield* updates.download).accepted);
            assert.isFalse((yield* updates.install).accepted);
            yield* announce;
            assert.equal((yield* Deferred.await(available)).installMode, "in-app");
            assert.isFalse(calls.includes("download"));
            assert.isFalse(calls.includes("install"));
            const result = yield* updates.download;
            assert.equal(result.state.runtimeKind, "packaged");
            assert.isTrue(result.accepted);
            assert.isTrue(result.completed);
            assert.equal((yield* Deferred.await(downloaded)).downloadedVersion, "1.1.0");
            assert.isFalse(calls.includes("install"));
            assert.isTrue((yield* updates.install).accepted);
            assert.deepEqual(calls.slice(-7), [
              "download",
              "confirm-update",
              "prepare-daemon",
              "stop-backend",
              "stop-daemon",
              "destroy-windows",
              "install",
            ]);
          }),
      ),
  );

  it.effect(
    "leaves every runtime and window untouched on native cancellation and permits a later explicit retry",
    () =>
      Effect.gen(function* () {
        let response = 0;
        yield* withUpdates(
          '{"cafeCodeMacInAppUpdates":true}',
          (fixture) =>
            Effect.gen(function* () {
              const updates = yield* downloadForInstall(fixture);
              const desktopState = yield* DesktopState.DesktopState;
              const before = yield* updates.getState;
              const offset = fixture.calls.length;
              const cancelled = yield* updates.install;
              assert.isFalse(cancelled.accepted);
              assert.deepEqual(cancelled.state, before);
              assert.deepEqual(fixture.calls.slice(offset), ["confirm-update"]);
              assert.isFalse(yield* Ref.get(desktopState.quitting));
              response = 1;
              assert.isTrue((yield* updates.install).accepted);
              assert.deepEqual(fixture.calls.slice(offset), [
                "confirm-update",
                "confirm-update",
                "prepare-daemon",
                "stop-backend",
                "stop-daemon",
                "destroy-windows",
                "install",
              ]);
              assert.isTrue(yield* Ref.get(desktopState.quitting));
            }),
          true,
          { confirmation: Effect.sync(() => response) },
        );
      }),
  );

  it.effect(
    "refuses a legacy service without preparation before stopping the backend or destroying windows",
    () =>
      withUpdates(
        '{"cafeCodeMacInAppUpdates":true}',
        (fixture) =>
          Effect.gen(function* () {
            const updates = yield* downloadForInstall(fixture);
            const desktopState = yield* DesktopState.DesktopState;
            const offset = fixture.calls.length;
            const result = yield* updates.install;
            assert.isTrue(result.accepted);
            assert.isFalse(result.completed);
            assert.equal(result.state.status, "downloaded");
            assert.equal(result.state.downloadedVersion, "1.1.0");
            assert.equal(result.state.errorContext, "install");
            assert.isTrue(result.state.canRetry);
            assert.include(result.state.message ?? "", "could not safely prepare and stop");
            assert.deepEqual(fixture.calls.slice(offset), ["confirm-update"]);
            assert.isFalse(yield* Ref.get(desktopState.quitting));
            // A missing capability must not strand the updater's action lock.
            assert.equal((yield* updates.setChannel("latest")).channel, "latest");
          }),
        true,
        { preparation: "missing" },
      ),
  );

  for (const phase of [
    "dialog",
    "preparation",
    "backend",
    "unconfirmed-exit",
    "daemon-defect",
  ] as const) {
    it.effect(`preserves the downloaded update and windows after ${phase} failure`, () => {
      const defect = Effect.die("PRIVATE provider path/token sentinel");
      const behavior: InstallBehavior =
        phase === "dialog"
          ? { confirmation: defect }
          : phase === "preparation"
            ? { preparation: defect }
            : phase === "backend"
              ? { backendStop: defect }
              : phase === "unconfirmed-exit"
                ? {
                    daemonStop: Effect.die(
                      new DesktopProviderDaemonManager.ProviderDaemonTerminationUnconfirmedError(),
                    ),
                  }
                : { daemonStop: defect };
      const expected =
        phase === "dialog"
          ? ["confirm-update"]
          : phase === "preparation"
            ? ["confirm-update", "prepare-daemon"]
            : phase === "backend"
              ? ["confirm-update", "prepare-daemon", "stop-backend"]
              : ["confirm-update", "prepare-daemon", "stop-backend", "stop-daemon"];
      return withUpdates(
        '{"cafeCodeMacInAppUpdates":true}',
        (fixture) =>
          Effect.gen(function* () {
            const updates = yield* downloadForInstall(fixture);
            const desktopState = yield* DesktopState.DesktopState;
            const offset = fixture.calls.length;
            const result = yield* updates.install;
            assert.isTrue(result.accepted);
            assert.isFalse(result.completed);
            assert.equal(result.state.status, "downloaded");
            assert.equal(result.state.downloadedVersion, "1.1.0");
            assert.equal(result.state.errorContext, "install");
            assert.isTrue(result.state.canRetry);
            assert.include(result.state.message ?? "", "could not safely prepare and stop");
            assert.isFalse((result.state.message ?? "").includes("PRIVATE"));
            assert.isFalse((result.state.message ?? "").includes("sentinel"));
            assert.deepEqual(fixture.calls.slice(offset), expected);
            assert.isFalse(yield* Ref.get(desktopState.quitting));
            assert.equal((yield* updates.setChannel("latest")).channel, "latest");
          }),
        true,
        behavior,
      );
    });
  }

  for (const phase of ["confirmation", "preparation", "backend-stop", "daemon-stop"] as const) {
    it.effect(`retires an interrupted ${phase} without installing or leaving quit reserved`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        const held = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const behavior: InstallBehavior =
          phase === "confirmation"
            ? { confirmation: held.pipe(Effect.as(1)) }
            : phase === "preparation"
              ? { preparation: held }
              : phase === "backend-stop"
                ? { backendStop: held }
                : { daemonStop: held };
        yield* withUpdates(
          '{"cafeCodeMacInAppUpdates":true}',
          (fixture) =>
            Effect.gen(function* () {
              const updates = yield* downloadForInstall(fixture);
              const desktopState = yield* DesktopState.DesktopState;
              const offset = fixture.calls.length;
              const attempt = yield* updates.install.pipe(Effect.forkScoped);
              yield* Deferred.await(entered);
              assert.isTrue(yield* Ref.get(desktopState.quitting));
              yield* Fiber.interrupt(attempt);
              const result = yield* Fiber.await(attempt);
              assert.isTrue(Exit.isFailure(result));
              if (Exit.isFailure(result)) assert.isTrue(Cause.hasInterruptsOnly(result.cause));
              assert.isFalse(yield* Ref.get(desktopState.quitting));
              const state = yield* updates.getState;
              assert.equal(state.status, "downloaded");
              assert.equal(state.downloadedVersion, "1.1.0");
              assert.equal(state.errorContext, "install");
              assert.isTrue(state.canRetry);
              assert.include(state.message ?? "", "could not safely prepare and stop");
              assert.deepEqual(
                fixture.calls.slice(offset),
                phase === "confirmation"
                  ? ["confirm-update"]
                  : phase === "preparation"
                    ? ["confirm-update", "prepare-daemon"]
                    : phase === "backend-stop"
                      ? ["confirm-update", "prepare-daemon", "stop-backend"]
                      : ["confirm-update", "prepare-daemon", "stop-backend", "stop-daemon"],
              );
              yield* Deferred.succeed(release, undefined);
              assert.isFalse(fixture.calls.includes("destroy-windows"));
              assert.isFalse(fixture.calls.includes("install"));
            }),
          true,
          behavior,
        );
      }),
    );
  }

  for (const phase of ["confirmation", "preparation"] as const) {
    it.effect(`reserves one install and suppresses checks while ${phase} is pending`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        const held = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        yield* withUpdates(
          '{"cafeCodeMacInAppUpdates":true}',
          (fixture) =>
            Effect.gen(function* () {
              const updates = yield* downloadForInstall(fixture);
              const offset = fixture.calls.length;
              const attempt = yield* updates.install.pipe(Effect.forkScoped);
              yield* Deferred.await(entered);
              assert.isFalse((yield* updates.install).accepted);
              assert.isFalse((yield* updates.check("held-install")).checked);
              yield* Deferred.succeed(release, undefined);
              assert.isTrue((yield* Fiber.join(attempt)).accepted);
              assert.isFalse((yield* updates.install).accepted);
              assert.deepEqual(fixture.calls.slice(offset), [
                "confirm-update",
                "prepare-daemon",
                "stop-backend",
                "stop-daemon",
                "destroy-windows",
                "install",
              ]);
            }),
          true,
          phase === "confirmation"
            ? { confirmation: held.pipe(Effect.as(1)) }
            : { preparation: held },
        );
      }),
    );
  }

  it.effect(
    "preserves interruption from a mixed preparation cause without exposing its defect",
    () => {
      const interrupted = Cause.interrupt(123);
      return withUpdates(
        '{"cafeCodeMacInAppUpdates":true}',
        (fixture) =>
          Effect.gen(function* () {
            const updates = yield* downloadForInstall(fixture);
            const desktopState = yield* DesktopState.DesktopState;
            const offset = fixture.calls.length;
            const attempt = yield* updates.install.pipe(Effect.forkScoped);
            const result = yield* Fiber.await(attempt);
            assert.isTrue(Exit.isFailure(result));
            if (Exit.isFailure(result)) {
              assert.deepEqual(
                result.cause.reasons
                  .filter(Cause.isInterruptReason)
                  .map((reason) => reason.fiberId),
                interrupted.reasons.filter(Cause.isInterruptReason).map((reason) => reason.fiberId),
              );
              assert.isTrue(Cause.hasInterruptsOnly(result.cause));
            }
            assert.isFalse(yield* Ref.get(desktopState.quitting));
            const state = yield* updates.getState;
            assert.equal(state.status, "downloaded");
            assert.equal(state.errorContext, "install");
            assert.isFalse((state.message ?? "").includes("PRIVATE"));
            assert.deepEqual(fixture.calls.slice(offset), ["confirm-update", "prepare-daemon"]);
          }),
        true,
        {
          preparation: Effect.failCause(
            Cause.combine(Cause.die("PRIVATE preparation defect"), interrupted),
          ),
        },
      );
    },
  );

  for (const phase of ["confirmation", "preparation", "backend-stop", "daemon-stop"] as const) {
    it.effect(
      `a native error during ${phase} invalidates only the admitted install before its next mutation`,
      () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const held = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          );
          const behavior: InstallBehavior =
            phase === "confirmation"
              ? { confirmation: held.pipe(Effect.as(1)) }
              : phase === "preparation"
                ? { preparation: held }
                : phase === "backend-stop"
                  ? { backendStop: held }
                  : { daemonStop: held };
          yield* withUpdates(
            '{"cafeCodeMacInAppUpdates":true}',
            (fixture) =>
              Effect.gen(function* () {
                const updates = yield* downloadForInstall(fixture);
                const desktopState = yield* DesktopState.DesktopState;
                const offset = fixture.calls.length;
                const attempt = yield* updates.install.pipe(Effect.forkScoped);
                yield* Deferred.await(entered);
                const error = new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
                  cause: "PRIVATE native event sentinel",
                });
                const failed = yield* fixture.announceError(error);
                assert.equal(failed.message, "Cafe Code could not confirm update installation.");
                // The received event cannot release the controller's reservation
                // while its exact native operation is still pending.
                assert.isTrue(yield* Ref.get(desktopState.quitting));
                assert.isFalse((yield* updates.install).accepted);
                assert.isFalse((yield* updates.check("invalidated-install")).checked);
                assert.isTrue(
                  Exit.isFailure(yield* updates.setChannel("nightly").pipe(Effect.exit)),
                );
                yield* Deferred.succeed(release, undefined);
                assert.isTrue((yield* Fiber.join(attempt)).accepted);
                const state = yield* updates.getState;
                assert.equal(state.message, "Cafe Code could not confirm update installation.");
                assert.equal(state.downloadedVersion, "1.1.0");
                assert.isFalse(yield* Ref.get(desktopState.quitting));
                assert.deepEqual(
                  fixture.calls.slice(offset),
                  phase === "confirmation"
                    ? ["confirm-update"]
                    : phase === "preparation"
                      ? ["confirm-update", "prepare-daemon"]
                      : phase === "backend-stop"
                        ? ["confirm-update", "prepare-daemon", "stop-backend"]
                        : ["confirm-update", "prepare-daemon", "stop-backend", "stop-daemon"],
                );
              }),
            true,
            behavior,
          );
        }),
    );
  }

  for (const phase of ["confirmation", "preparation"] as const) {
    it.effect(`does not apply ${phase} consent to a replaced downloaded version`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        const held = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        yield* withUpdates(
          '{"cafeCodeMacInAppUpdates":true}',
          (fixture) =>
            Effect.gen(function* () {
              const updates = yield* downloadForInstall(fixture);
              const desktopState = yield* DesktopState.DesktopState;
              const offset = fixture.calls.length;
              const attempt = yield* updates.install.pipe(Effect.forkScoped);
              yield* Deferred.await(entered);
              yield* fixture.announceDownloaded("1.2.0");
              assert.equal(
                (yield* Deferred.await(fixture.replacementDownloaded)).downloadedVersion,
                "1.2.0",
              );
              yield* Deferred.succeed(release, undefined);
              const result = yield* Fiber.join(attempt);
              assert.isFalse(result.completed);
              assert.equal(result.state.downloadedVersion, "1.2.0");
              assert.equal(result.state.status, "downloaded");
              assert.isFalse(yield* Ref.get(desktopState.quitting));
              assert.deepEqual(
                fixture.calls.slice(offset),
                phase === "confirmation"
                  ? ["confirm-update"]
                  : ["confirm-update", "prepare-daemon"],
              );
            }),
          true,
          phase === "confirmation"
            ? { confirmation: held.pipe(Effect.as(1)) }
            : { preparation: held },
        );
      }),
    );
  }

  it.effect("does not authorize replay after an unknown native installer handoff", () =>
    withUpdates(
      '{"cafeCodeMacInAppUpdates":true}',
      (fixture) =>
        Effect.gen(function* () {
          const updates = yield* downloadForInstall(fixture);
          const desktopState = yield* DesktopState.DesktopState;
          const offset = fixture.calls.length;
          const result = yield* updates.install.pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(result));
          assert.isTrue(yield* Ref.get(desktopState.quitting));
          const later = yield* fixture.announceError(
            new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
              cause: "PRIVATE later error after unknown handoff",
            }),
          );
          assert.isFalse(later.canRetry);
          assert.isTrue(yield* Ref.get(desktopState.quitting));
          assert.isFalse((yield* updates.install).accepted);
          assert.isFalse((yield* updates.check("unknown-handoff")).checked);
          assert.isTrue(Exit.isFailure(yield* updates.setChannel("nightly").pipe(Effect.exit)));
          assert.deepEqual(fixture.calls.slice(offset), [
            "confirm-update",
            "prepare-daemon",
            "stop-backend",
            "stop-daemon",
            "destroy-windows",
            "install",
          ]);
        }),
      true,
      { quitAndInstall: Effect.die("Unknown native installer handoff") },
    ),
  );

  it.effect(
    "retains sanitized installer failure without treating a synchronous throw as no-submit proof",
    () =>
      withUpdates(
        '{"cafeCodeMacInAppUpdates":true}',
        (fixture) =>
          Effect.gen(function* () {
            const updates = yield* downloadForInstall(fixture);
            const desktopState = yield* DesktopState.DesktopState;
            const offset = fixture.calls.length;
            const result = yield* updates.install;
            assert.equal(
              result.state.message,
              "Electron updater failed to quit and install the update.",
            );
            assert.equal(result.state.status, "downloaded");
            assert.isFalse(result.state.canRetry);
            assert.isTrue(yield* Ref.get(desktopState.quitting));
            const later = yield* fixture.announceError(
              new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
                cause: "PRIVATE later error after synchronous installer throw",
              }),
            );
            assert.equal(later.message, "Cafe Code could not confirm update installation.");
            assert.isFalse(later.canRetry);
            assert.isTrue(yield* Ref.get(desktopState.quitting));
            assert.isFalse((yield* updates.install).accepted);
            assert.isFalse((yield* updates.check("thrown-handoff")).checked);
            assert.isTrue(Exit.isFailure(yield* updates.setChannel("nightly").pipe(Effect.exit)));
            assert.deepEqual(fixture.calls.slice(offset), [
              "confirm-update",
              "prepare-daemon",
              "stop-backend",
              "stop-daemon",
              "destroy-windows",
              "install",
            ]);
          }),
        true,
        {
          quitAndInstall: Effect.fail(
            new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
              cause: "PRIVATE install sentinel",
            }),
          ),
        },
      ),
  );

  it.effect(
    "keeps exact install admission after native handoff returns and a later updater error arrives",
    () =>
      withUpdates('{"cafeCodeMacInAppUpdates":true}', (fixture) =>
        Effect.gen(function* () {
          const updates = yield* downloadForInstall(fixture);
          const desktopState = yield* DesktopState.DesktopState;
          const offset = fixture.calls.length;
          const result = yield* updates.install;
          assert.isTrue(result.accepted);
          // Returning from quitAndInstall is not confirmation of installation.
          assert.isFalse(result.completed);
          const later = yield* fixture.announceError(
            new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
              cause: "PRIVATE later error after returned handoff",
            }),
          );
          assert.isFalse(later.canRetry);
          assert.isTrue(yield* Ref.get(desktopState.quitting));
          assert.isFalse((yield* updates.install).accepted);
          assert.isFalse((yield* updates.check("returned-handoff")).checked);
          assert.isTrue(Exit.isFailure(yield* updates.setChannel("nightly").pipe(Effect.exit)));
          assert.deepEqual(fixture.calls.slice(offset), [
            "confirm-update",
            "prepare-daemon",
            "stop-backend",
            "stop-daemon",
            "destroy-windows",
            "install",
          ]);
        }),
      ),
  );

  for (const context of ["install", "download", "check"] as const) {
    for (const payload of ["native-error", "hostile-error", "hostile-object"] as const) {
      it.effect(`keeps a received ${payload} opaque during an active ${context}`, () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const held = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          );
          const reads = { getters: 0, toString: 0, primitive: 0 };
          const error = receivedEventError(payload, reads);
          const expectedMessage =
            context === "install"
              ? "Cafe Code could not confirm update installation."
              : context === "download"
                ? "Cafe Code could not download the update."
                : "Cafe Code could not check for updates.";
          yield* withUpdates(
            '{"cafeCodeMacInAppUpdates":true}',
            (fixture) =>
              Effect.gen(function* () {
                const updates =
                  context === "install"
                    ? yield* downloadForInstall(fixture)
                    : yield* DesktopUpdates.DesktopUpdates;
                const desktopState = yield* DesktopState.DesktopState;
                if (context !== "install") {
                  yield* updates.configure;
                  if (context === "download") {
                    yield* fixture.announce;
                    yield* Deferred.await(fixture.available);
                  }
                }
                const offset = fixture.calls.length;
                const operation =
                  context === "install"
                    ? updates.install
                    : context === "download"
                      ? updates.download
                      : updates.check("native-event-privacy");
                const attempt = yield* operation.pipe(Effect.forkScoped);
                yield* Deferred.await(entered);
                const observed = yield* fixture.announceError(error);
                assert.equal(observed.message, expectedMessage);
                assert.equal(observed.errorContext, context);
                assert.deepEqual(reads, { getters: 0, toString: 0, primitive: 0 });
                const eventLogs = fixture.logs.filter(
                  (record) => record.message === "updater error",
                );
                assert.equal(eventLogs.length, 1);
                assert.equal(eventLogs[0]?.annotations.message, expectedMessage);
                assert.equal(eventLogs[0]?.annotations.context, context);
                assert.isUndefined(eventLogs[0]?.cause);
                assert.notInclude(
                  encodeObservation({ state: observed, logs: fixture.logs }),
                  PRIVATE_EVENT_SENTINEL,
                );
                if (context === "install") {
                  assert.isTrue(yield* Ref.get(desktopState.quitting));
                  assert.isFalse((yield* updates.install).accepted);
                } else if (context === "download") {
                  assert.isFalse((yield* updates.download).accepted);
                } else {
                  assert.isFalse((yield* updates.check("pending-native-event")).checked);
                }
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(attempt);
                assert.isFalse(yield* Ref.get(desktopState.quitting));
                assert.deepEqual(
                  fixture.calls.slice(offset),
                  context === "install"
                    ? ["confirm-update", "prepare-daemon"]
                    : context === "download"
                      ? ["download"]
                      : ["check"],
                );
                assert.notInclude(
                  encodeObservation({ state: yield* updates.getState, logs: fixture.logs }),
                  PRIVATE_EVENT_SENTINEL,
                );
                assert.deepEqual(reads, { getters: 0, toString: 0, primitive: 0 });
                assert.isFalse(fixture.calls.includes("install"));
              }),
            true,
            context === "install"
              ? { preparation: held }
              : context === "download"
                ? { download: held }
                : { check: held },
          );
        }),
      );
    }
  }

  it.effect("keeps unsigned, legacy and unreadable packages on the manual path", () =>
    Effect.forEach([undefined, "{}", '{"cafeCodeMacInAppUpdates":false}'], (packageJson) =>
      withUpdates(packageJson, ({ calls, available, announce }) =>
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          assert.equal((yield* updates.getState).runtimeKind, "packaged");
          assert.isTrue((yield* updates.getState).enabled);
          assert.equal((yield* updates.setChannel("nightly")).installMode, "manual");
          assert.equal((yield* updates.setChannel("latest")).installMode, "manual");
          yield* announce;
          assert.equal((yield* Deferred.await(available)).installMode, "manual");
          assert.isFalse((yield* updates.download).accepted);
          assert.isFalse((yield* updates.install).accepted);
          assert.isFalse(calls.includes("download"));
          assert.isFalse(calls.includes("stop-backend"));
          assert.isFalse(calls.includes("destroy-windows"));
          assert.isFalse(calls.includes("install"));
        }),
      ),
    ),
  );

  it.effect("does not enable packaged updates or read the opt-in for a source checkout", () =>
    withUpdates(
      '{"cafeCodeMacInAppUpdates":true}',
      ({ calls, reads }) =>
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          assert.equal((yield* updates.getState).runtimeKind, "source");
          yield* updates.configure;
          assert.equal((yield* updates.getState).runtimeKind, "source");
          assert.equal((yield* updates.getState).status, "disabled");
          assert.equal((yield* updates.getState).installMode, "manual");
          assert.isFalse((yield* updates.download).accepted);
          assert.isFalse((yield* updates.install).accepted);
          assert.equal((yield* updates.setChannel("nightly")).runtimeKind, "source");
          const check = yield* updates.check("synthetic-source");
          assert.isFalse(check.checked);
          assert.equal(check.state.runtimeKind, "source");
          yield* TestClock.adjust("5 minutes");
          assert.deepEqual(calls, []);
          assert.isFalse(reads.some((filePath) => filePath.endsWith(`${path.sep}package.json`)));
        }),
      false,
    ),
  );
});
