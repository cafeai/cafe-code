import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

import * as NetService from "@cafecode/shared/Net";
import { resolveUiLocale, uiText } from "@cafecode/shared/i18n";
import { startStartupCpuProfiler } from "@cafecode/shared/startupProfiler";
import { assertSourceDebugDesktopBuilds } from "@cafecode/shared/sourceDebugBuild";

import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronDialog from "./electron/ElectronDialog.ts";
import * as ElectronMenu from "./electron/ElectronMenu.ts";
import * as ElectronProtocol from "./electron/ElectronProtocol.ts";
import * as DesktopSecretStorage from "./electron/ElectronSafeStorage.ts";
import * as ElectronShell from "./electron/ElectronShell.ts";
import * as ElectronPowerSaveBlocker from "./electron/ElectronPowerSaveBlocker.ts";
import * as ElectronTheme from "./electron/ElectronTheme.ts";
import * as ElectronUpdater from "./electron/ElectronUpdater.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import * as DesktopApp from "./app/DesktopApp.ts";
import * as DesktopAppIdentity from "./app/DesktopAppIdentity.ts";
import * as DesktopApplicationMenu from "./window/DesktopApplicationMenu.ts";
import * as DesktopAssets from "./app/DesktopAssets.ts";
import * as DesktopBackendConfiguration from "./backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "./backend/DesktopBackendManager.ts";
import * as DesktopProviderDaemonManager from "./backend/DesktopProviderDaemonManager.ts";
import * as DesktopEnvironment from "./app/DesktopEnvironment.ts";
import {
  DesktopDataProfileStartup,
  initializeDesktopDataProfile,
} from "./app/DesktopDataProfile.ts";
import * as DesktopLifecycle from "./app/DesktopLifecycle.ts";
import * as DesktopObservability from "./app/DesktopObservability.ts";
import * as DesktopPowerSaveBlocker from "./app/DesktopPowerSaveBlocker.ts";
import * as DesktopServerExposure from "./backend/DesktopServerExposure.ts";
import * as DesktopClientSettings from "./settings/DesktopClientSettings.ts";
import * as DesktopUiLocale from "./settings/DesktopUiLocale.ts";
import * as DesktopSavedEnvironments from "./settings/DesktopSavedEnvironments.ts";
import * as DesktopRemoteCertificates from "./settings/DesktopRemoteCertificates.ts";
import * as DesktopAppSettings from "./settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "./shell/DesktopShellEnvironment.ts";
import * as DesktopState from "./app/DesktopState.ts";
import * as DesktopUpdates from "./updates/DesktopUpdates.ts";
import * as DesktopSourceUpdates from "./updates/DesktopSourceUpdates.ts";
import * as DesktopWindow from "./window/DesktopWindow.ts";
import * as DesktopStartupWindow from "./window/DesktopStartupWindow.ts";
import { resolveLinuxSafeStoragePasswordStore } from "./app/LinuxSafeStorageCommandLine.ts";
import {
  isDesktopRuntimeSelfTestEnabled,
  runDesktopRuntimeSelfTestAndExit,
} from "./app/DesktopRuntimeSelfTest.ts";
import {
  isDesktopUpdateDetectionProbeEnabled,
  runDesktopUpdateDetectionProbeAndExit,
} from "./app/DesktopUpdateDetectionProbe.ts";

startStartupCpuProfiler({ role: "desktop-main" });

if (process.platform === "linux") {
  const passwordStore = resolveLinuxSafeStoragePasswordStore(process.env);
  const hasPasswordStoreArg = process.argv.some((argument) =>
    argument.startsWith("--password-store="),
  );
  if (passwordStore !== undefined && !hasPasswordStoreArg) {
    // Direct Electron/AppImage launches can bypass the wrapper scripts that
    // normally pass --password-store. Set the same backend at module load,
    // before app readiness, so safeStorage can encrypt provider-daemon tokens.
    Electron.app.commandLine.appendSwitch("password-store", passwordStore);
  }
}

const desktopEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const metadata = yield* Effect.service(ElectronApp.ElectronApp).pipe(
      Effect.flatMap((app) => app.metadata),
    );
    const environment = yield* Effect.service(DesktopEnvironment.DesktopEnvironment).pipe(
      Effect.provide(
        DesktopEnvironment.layer({
          dirname: __dirname,
          homeDirectory: NodeOS.homedir(),
          platform: process.platform,
          processArch: process.arch,
          ...metadata,
        }),
      ),
    );
    // Publishing this context admits every settings/secret/logging foundation
    // consumer. Validate Debug storage and select Electron's native data/lock
    // identity first; a secondary or refused startup never builds those layers.
    const admitted = yield* Effect.promise(() =>
      initializeDesktopDataProfile(
        {
          environment,
          argv: process.argv,
          ...(!environment.isPackaged
            ? {
                verifySourceBuilds: () =>
                  assertSourceDebugDesktopBuilds(
                    environment.path.join(environment.appRoot, "apps", "desktop"),
                  ),
              }
            : {}),
          native: {
            setName: (name) => Electron.app.setName(name),
            setPath: (name, value) => Electron.app.setPath(name, value),
            requestSingleInstanceLock: (request) => Electron.app.requestSingleInstanceLock(request),
            onSecondInstance: (receive) => {
              const listener = (
                _event: Electron.Event,
                _argv: string[],
                _cwd: string,
                additionalData: unknown,
              ) => receive(additionalData);
              Electron.app.on("second-instance", listener);
              return () => {
                Electron.app.removeListener("second-instance", listener);
              };
            },
            showFailure: (reason) => {
              // The refused namespace cannot supply a saved locale safely. Use only
              // the native primary system language for this pre-foundation notice.
              let languages: readonly string[] = [];
              try {
                languages = Electron.app.getPreferredSystemLanguages();
              } catch {
                /* safe English fallback */
              }
              const locale = resolveUiLocale("system", languages);
              Electron.dialog.showErrorBox(
                uiText("Cafe Code failed to start", undefined, undefined, locale),
                reason === "build"
                  ? uiText(
                      "Source Debug build is missing, outdated or inconsistent. Rebuild using yarn build:desktop before starting Cafe Code. No application or provider was started.",
                      undefined,
                      undefined,
                      locale,
                    )
                  : uiText(
                      "The application data profile could not be initialized safely. Check its permissions and free space. No other data profile was selected.",
                      undefined,
                      undefined,
                      locale,
                    ),
              );
            },
            quit: () => Electron.app.quit(),
          },
        },
        (startup) =>
          Layer.mergeAll(
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
            Layer.succeed(DesktopDataProfileStartup, startup),
          ),
      ),
    );
    // app.quit() owns the secondary/refusal exit. Do not let pending async
    // foundation construction continue while Electron is draining that exit.
    return admitted ?? (yield* Effect.never);
  }),
);

const electronLayer = Layer.mergeAll(
  ElectronApp.layer,
  ElectronDialog.layer,
  ElectronMenu.layer,
  ElectronProtocol.layer,
  DesktopSecretStorage.layer,
  ElectronShell.layer.pipe(Layer.provide(NodeServices.layer)),
  ElectronPowerSaveBlocker.layer,
  ElectronTheme.layer,
  ElectronUpdater.layer,
  ElectronWindow.layer,
  Layer.succeed(DesktopIpc.DesktopIpc, DesktopIpc.make(Electron.ipcMain)),
);

const desktopFoundationLayer = Layer.mergeAll(
  DesktopState.layer,
  DesktopLifecycle.layerShutdown,
  DesktopAppSettings.layer,
  DesktopClientSettings.layer,
  DesktopSavedEnvironments.layer,
  DesktopRemoteCertificates.layer,
  DesktopAssets.layer,
  DesktopObservability.layer,
  DesktopPowerSaveBlocker.layer,
).pipe(Layer.provideMerge(desktopEnvironmentLayer));

const desktopLocalizedFoundationLayer = DesktopUiLocale.layer.pipe(
  Layer.provideMerge(desktopFoundationLayer),
);

const desktopServerExposureLayer = DesktopServerExposure.layer.pipe(
  Layer.provideMerge(DesktopServerExposure.networkInterfacesLayer),
  Layer.provideMerge(desktopLocalizedFoundationLayer),
);

const desktopStartupWindowLayer = DesktopStartupWindow.layer.pipe(
  Layer.provideMerge(desktopServerExposureLayer),
);
const desktopWindowLayer = DesktopWindow.layer.pipe(Layer.provideMerge(desktopStartupWindowLayer));

const desktopProviderDaemonLayer = DesktopProviderDaemonManager.layer.pipe(
  Layer.provideMerge(desktopLocalizedFoundationLayer),
);

const desktopBackendLayer = DesktopBackendManager.layer.pipe(
  Layer.provideMerge(DesktopAppIdentity.layer),
  Layer.provideMerge(desktopProviderDaemonLayer),
  Layer.provideMerge(DesktopBackendConfiguration.layer),
  Layer.provideMerge(desktopWindowLayer),
);

const desktopApplicationLayer = Layer.mergeAll(
  DesktopLifecycle.layer,
  DesktopApplicationMenu.layer,
  DesktopShellEnvironment.layer,
).pipe(
  Layer.provideMerge(DesktopUpdates.layer),
  Layer.provideMerge(DesktopSourceUpdates.layer),
  Layer.provideMerge(desktopBackendLayer),
  Layer.provideMerge(desktopProviderDaemonLayer),
);

const desktopRuntimeLayer = ElectronProtocol.layerSchemePrivileges.pipe(
  Layer.flatMap(() =>
    desktopApplicationLayer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(NodeHttpClient.layerUndici),
      Layer.provideMerge(NetService.layer),
      Layer.provideMerge(electronLayer),
    ),
  ),
);

if (isDesktopUpdateDetectionProbeEnabled()) {
  void runDesktopUpdateDetectionProbeAndExit();
} else if (isDesktopRuntimeSelfTestEnabled()) {
  void runDesktopRuntimeSelfTestAndExit();
} else {
  DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
}
