import * as Effect from "effect/Effect";

import * as DesktopIpc from "./DesktopIpc.ts";
import { getClientSettings, setClientSettings } from "./methods/clientSettings.ts";
import {
  getSavedEnvironmentRegistry,
  getSavedEnvironmentSecret,
  removeSavedEnvironmentSecret,
  setSavedEnvironmentRegistry,
  setSavedEnvironmentSecret,
} from "./methods/savedEnvironments.ts";
import {
  getAdvertisedEndpoints,
  getServerExposureState,
  setServerExposureMode,
  setServerHttpsEnabled,
} from "./methods/serverExposure.ts";
import {
  checkForUpdate,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  setUpdateChannel,
} from "./methods/updates.ts";
import { checkSourceUpdate, getSourceUpdateState } from "./methods/sourceUpdates.ts";
import {
  getMacKeepAwakeState,
  setMacKeepAwakeIntent,
  setPowerSaveBlockerState,
} from "./methods/powerSaveBlocker.ts";
import {
  inspectRemoteCertificate,
  prepareRemoteCertificate,
} from "./methods/remoteCertificates.ts";
import { getDebugEndpointState, publishDebugSnapshot } from "./methods/debug.ts";
import { getAppIconState, setAppIcon } from "./methods/appIcon.ts";
import { copyPng, savePng } from "./methods/imageExport.ts";
import { installDesktopNotificationHandlers } from "./methods/notifications.ts";
import {
  copyText,
  confirm,
  getAppBranding,
  getWindowFullScreen,
  getLocalEnvironmentBootstrap,
  openExternal,
  openPath,
  pickFolder,
  revealPath,
  setTheme,
  showContextMenu,
} from "./methods/window.ts";

export const installDesktopIpcHandlers = Effect.gen(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;

  yield* ipc.handleSync(getAppBranding);
  yield* ipc.handleSync(getWindowFullScreen);
  yield* ipc.handleSync(getLocalEnvironmentBootstrap);

  yield* ipc.handle(getDebugEndpointState);
  yield* ipc.handle(publishDebugSnapshot);

  yield* ipc.handle(getClientSettings);
  yield* ipc.handle(setClientSettings);
  yield* ipc.handle(setPowerSaveBlockerState);
  yield* ipc.handle(getMacKeepAwakeState);
  yield* ipc.handle(setMacKeepAwakeIntent);
  yield* ipc.handle(getSavedEnvironmentRegistry);
  yield* ipc.handle(setSavedEnvironmentRegistry);
  yield* ipc.handle(getSavedEnvironmentSecret);
  yield* ipc.handle(setSavedEnvironmentSecret);
  yield* ipc.handle(removeSavedEnvironmentSecret);
  yield* ipc.handle(prepareRemoteCertificate);
  yield* ipc.handle(inspectRemoteCertificate);

  yield* ipc.handle(getServerExposureState);
  yield* ipc.handle(setServerExposureMode);
  yield* ipc.handle(setServerHttpsEnabled);
  yield* ipc.handle(getAdvertisedEndpoints);

  yield* ipc.handle(pickFolder);
  yield* ipc.handle(confirm);
  yield* ipc.handle(setTheme);
  yield* ipc.handle(showContextMenu);
  yield* ipc.handle(openExternal);
  yield* ipc.handle(openPath);
  yield* ipc.handle(revealPath);
  yield* ipc.handle(copyText);
  yield* ipc.handle(copyPng);
  yield* ipc.handle(savePng);
  yield* ipc.handle(getAppIconState);
  yield* ipc.handle(setAppIcon);
  yield* installDesktopNotificationHandlers;

  yield* ipc.handle(getUpdateState);
  yield* ipc.handle(setUpdateChannel);
  yield* ipc.handle(downloadUpdate);
  yield* ipc.handle(installUpdate);
  yield* ipc.handle(checkForUpdate);
  yield* ipc.handle(getSourceUpdateState);
  yield* ipc.handle(checkSourceUpdate);
}).pipe(Effect.withSpan("desktop.ipc.installHandlers"));
