import * as NodePath from "@effect/platform-node/NodePath";
import type { DesktopUpdateState } from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

function withUpdates<A, E, R>(
  packageJson: string | undefined,
  task: (fixture: {
    readonly calls: string[];
    readonly reads: string[];
    readonly available: Deferred.Deferred<DesktopUpdateState>;
    readonly downloaded: Deferred.Deferred<DesktopUpdateState>;
    readonly announce: Effect.Effect<void>;
  }) => Effect.Effect<A, E, R | DesktopUpdates.DesktopUpdates>,
  isPackaged = true,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const calls: string[] = [];
      const reads: string[] = [];
      const available = yield* Deferred.make<DesktopUpdateState>();
      const downloaded = yield* Deferred.make<DesktopUpdateState>();
      const listeners = new Map<string, (...args: readonly unknown[]) => void>();
      const record = (call: string) =>
        Effect.sync(() => {
          calls.push(call);
        });
      const emit = (event: string) =>
        Effect.sync(() => {
          const listener = listeners.get(event);
          assert.isDefined(listener);
          listener!({ version: "1.1.0" });
        });
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
        checkForUpdates: record("check"),
        downloadUpdate: record("download").pipe(Effect.andThen(emit("update-downloaded"))),
        quitAndInstall: (options) =>
          Effect.sync(() => {
            assert.deepEqual(options, { isSilent: true, isForceRunAfter: true });
            calls.push("install");
          }),
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
          if (state.status === "available")
            return Deferred.succeed(available, state).pipe(Effect.asVoid);
          if (state.status === "downloaded")
            return Deferred.succeed(downloaded, state).pipe(Effect.asVoid);
          return Effect.void;
        },
        destroyAll: record("destroy-windows"),
        syncAllAppearance: () => Effect.void,
      });
      const backend = Layer.succeed(DesktopBackendManager.DesktopBackendManager, {
        start: Effect.die("unexpected backend start"),
        stop: () => record("stop-backend"),
        currentConfig: Effect.succeed(Option.none()),
        snapshot: Effect.die("unexpected backend snapshot"),
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
        DesktopState.layer,
      );
      const layer = DesktopUpdates.layer.pipe(
        Layer.provideMerge(DesktopAppSettings.layer.pipe(Layer.provideMerge(dependencies))),
      );
      return yield* task({
        calls,
        reads,
        available,
        downloaded,
        announce: emit("update-available"),
      }).pipe(Effect.provide(layer));
    }),
  );
}

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
            assert.deepEqual(calls.slice(-4), [
              "download",
              "stop-backend",
              "destroy-windows",
              "install",
            ]);
          }),
      ),
  );

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
