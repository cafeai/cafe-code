import * as Effect from "effect/Effect";

import * as DesktopIpc from "./DesktopIpc.ts";
import { getClientSettings, setClientSettings } from "./methods/clientSettings.ts";
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
import { setPowerSaveBlockerState } from "./methods/powerSaveBlocker.ts";
import { getDebugEndpointState, publishDebugSnapshot } from "./methods/debug.ts";
import {
  confirm,
  getAppBranding,
  getLocalEnvironmentBootstrap,
  openExternal,
  openPath,
  pickFolder,
  setTheme,
  showContextMenu,
} from "./methods/window.ts";

export const installDesktopIpcHandlers = Effect.gen(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;

  yield* ipc.handleSync(getAppBranding);
  yield* ipc.handleSync(getLocalEnvironmentBootstrap);

  yield* ipc.handle(getDebugEndpointState);
  yield* ipc.handle(publishDebugSnapshot);

  yield* ipc.handle(getClientSettings);
  yield* ipc.handle(setClientSettings);
  yield* ipc.handle(setPowerSaveBlockerState);

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

  yield* ipc.handle(getUpdateState);
  yield* ipc.handle(setUpdateChannel);
  yield* ipc.handle(downloadUpdate);
  yield* ipc.handle(installUpdate);
  yield* ipc.handle(checkForUpdate);
  yield* ipc.handle(getSourceUpdateState);
  yield* ipc.handle(checkSourceUpdate);
}).pipe(Effect.withSpan("desktop.ipc.installHandlers"));
