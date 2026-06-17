import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

import * as NetService from "@cafecode/shared/Net";
import { startStartupCpuProfiler } from "@cafecode/shared/startupProfiler";

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
import * as DesktopLifecycle from "./app/DesktopLifecycle.ts";
import * as DesktopObservability from "./app/DesktopObservability.ts";
import * as DesktopPowerSaveBlocker from "./app/DesktopPowerSaveBlocker.ts";
import * as DesktopServerExposure from "./backend/DesktopServerExposure.ts";
import * as DesktopClientSettings from "./settings/DesktopClientSettings.ts";
import * as DesktopLegacySavedEnvironmentCleanup from "./settings/DesktopLegacySavedEnvironmentCleanup.ts";
import * as DesktopAppSettings from "./settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "./shell/DesktopShellEnvironment.ts";
import * as DesktopState from "./app/DesktopState.ts";
import * as DesktopUpdates from "./updates/DesktopUpdates.ts";
import * as DesktopSourceUpdates from "./updates/DesktopSourceUpdates.ts";
import * as DesktopWindow from "./window/DesktopWindow.ts";
import { resolveLinuxSafeStoragePasswordStore } from "./app/LinuxSafeStorageCommandLine.ts";

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
    return DesktopEnvironment.layer({
      dirname: __dirname,
      homeDirectory: NodeOS.homedir(),
      platform: process.platform,
      processArch: process.arch,
      ...metadata,
    });
  }),
);

const electronLayer = Layer.mergeAll(
  ElectronApp.layer,
  ElectronDialog.layer,
  ElectronMenu.layer,
  ElectronProtocol.layer,
  DesktopSecretStorage.layer,
  ElectronShell.layer,
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
  DesktopLegacySavedEnvironmentCleanup.layer,
  DesktopAssets.layer,
  DesktopObservability.layer,
  DesktopPowerSaveBlocker.layer,
).pipe(Layer.provideMerge(desktopEnvironmentLayer));

const desktopServerExposureLayer = DesktopServerExposure.layer.pipe(
  Layer.provideMerge(DesktopServerExposure.networkInterfacesLayer),
  Layer.provideMerge(desktopFoundationLayer),
);

const desktopWindowLayer = DesktopWindow.layer.pipe(Layer.provideMerge(desktopServerExposureLayer));

const desktopProviderDaemonLayer = DesktopProviderDaemonManager.layer.pipe(
  Layer.provideMerge(desktopFoundationLayer),
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

DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
