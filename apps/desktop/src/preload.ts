import type { DesktopBridge } from "@cafecode/contracts";
import { contextBridge, ipcRenderer } from "electron";

import * as IpcChannels from "./ipc/channels.ts";

// Untrusted rendering helpers (including the opaque-origin Mermaid iframe)
// must never receive native capabilities. The BrowserWindow disables subframe
// Node integration and desktop main independently rejects subframe IPC; retain
// this fail-closed gate in the preload as well so a future preference change
// cannot accidentally publish the bridge into an embedded document.
if (process.isMainFrame === true) {
  contextBridge.exposeInMainWorld("desktopBridge", {
    getAppBranding: () => {
      const result = ipcRenderer.sendSync(IpcChannels.GET_APP_BRANDING_CHANNEL);
      if (typeof result !== "object" || result === null) {
        return null;
      }
      return result as ReturnType<DesktopBridge["getAppBranding"]>;
    },
    getLocalEnvironmentBootstrap: () => {
      const result = ipcRenderer.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL);
      if (typeof result !== "object" || result === null) {
        return null;
      }
      return result as ReturnType<DesktopBridge["getLocalEnvironmentBootstrap"]>;
    },
    getDebugEndpointState: () => ipcRenderer.invoke(IpcChannels.GET_DEBUG_ENDPOINT_STATE_CHANNEL),
    publishDebugSnapshot: (snapshot) =>
      ipcRenderer.invoke(IpcChannels.PUBLISH_DEBUG_SNAPSHOT_CHANNEL, snapshot),
    getClientSettings: () => ipcRenderer.invoke(IpcChannels.GET_CLIENT_SETTINGS_CHANNEL),
    setClientSettings: (settings) =>
      ipcRenderer.invoke(IpcChannels.SET_CLIENT_SETTINGS_CHANNEL, settings),
    setPowerSaveBlockerState: (state) =>
      ipcRenderer.invoke(IpcChannels.SET_POWER_SAVE_BLOCKER_STATE_CHANNEL, state),
    getSavedEnvironmentRegistry: () =>
      ipcRenderer.invoke(IpcChannels.GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL),
    setSavedEnvironmentRegistry: (records) =>
      ipcRenderer.invoke(IpcChannels.SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL, records),
    getSavedEnvironmentSecret: (environmentId) =>
      ipcRenderer.invoke(IpcChannels.GET_SAVED_ENVIRONMENT_SECRET_CHANNEL, environmentId),
    setSavedEnvironmentSecret: (environmentId, secret) =>
      ipcRenderer.invoke(IpcChannels.SET_SAVED_ENVIRONMENT_SECRET_CHANNEL, {
        environmentId,
        secret,
      }),
    removeSavedEnvironmentSecret: (environmentId) =>
      ipcRenderer.invoke(IpcChannels.REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL, environmentId),
    prepareRemoteCertificate: (httpBaseUrl) =>
      ipcRenderer.invoke(IpcChannels.PREPARE_REMOTE_CERTIFICATE_CHANNEL, httpBaseUrl),
    getServerExposureState: () => ipcRenderer.invoke(IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL),
    setServerExposureMode: (mode) =>
      ipcRenderer.invoke(IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL, mode),
    setServerHttpsEnabled: (enabled) =>
      ipcRenderer.invoke(IpcChannels.SET_SERVER_HTTPS_ENABLED_CHANNEL, enabled),
    getGlobalDictationSettings: () =>
      ipcRenderer.invoke(IpcChannels.GET_GLOBAL_DICTATION_SETTINGS_CHANNEL),
    setGlobalDictationEnabled: (enabled) =>
      ipcRenderer.invoke(IpcChannels.SET_GLOBAL_DICTATION_ENABLED_CHANNEL, enabled),
    setGlobalDictationShortcut: (shortcut) =>
      ipcRenderer.invoke(IpcChannels.SET_GLOBAL_DICTATION_SHORTCUT_CHANNEL, shortcut),
    onGlobalDictationEvent: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (typeof payload !== "object" || payload === null) return;
        listener(payload as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(IpcChannels.GLOBAL_DICTATION_EVENT_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.GLOBAL_DICTATION_EVENT_CHANNEL, wrappedListener);
    },
    globalDictationAction: (input) =>
      ipcRenderer.invoke(IpcChannels.GLOBAL_DICTATION_ACTION_CHANNEL, input),
    claimComposerDictationCapture: () =>
      ipcRenderer.invoke(IpcChannels.CLAIM_COMPOSER_DICTATION_CAPTURE_CHANNEL),
    releaseComposerDictationCapture: (leaseId) =>
      ipcRenderer.invoke(IpcChannels.RELEASE_COMPOSER_DICTATION_CAPTURE_CHANNEL, leaseId),
    getAdvertisedEndpoints: () => ipcRenderer.invoke(IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL),
    pickFolder: (options) => ipcRenderer.invoke(IpcChannels.PICK_FOLDER_CHANNEL, options),
    confirm: (message) => ipcRenderer.invoke(IpcChannels.CONFIRM_CHANNEL, message),
    setTheme: (theme) => ipcRenderer.invoke(IpcChannels.SET_THEME_CHANNEL, theme),
    showContextMenu: (items, position) =>
      ipcRenderer.invoke(IpcChannels.CONTEXT_MENU_CHANNEL, {
        items,
        ...(position === undefined ? {} : { position }),
      }),
    openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.OPEN_EXTERNAL_CHANNEL, url),
    openPath: (path: string) => ipcRenderer.invoke(IpcChannels.OPEN_PATH_CHANNEL, path),
    revealPath: (path: string) => ipcRenderer.invoke(IpcChannels.REVEAL_PATH_CHANNEL, path),
    openVirtualDesktop: (input) =>
      ipcRenderer.invoke(IpcChannels.OPEN_VIRTUAL_DESKTOP_CHANNEL, input),
    copyText: (text: string) => ipcRenderer.invoke(IpcChannels.COPY_TEXT_CHANNEL, text),
    onMenuAction: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
        if (typeof action !== "string") return;
        listener(action);
      };

      ipcRenderer.on(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
      };
    },
    getUpdateState: () => ipcRenderer.invoke(IpcChannels.UPDATE_GET_STATE_CHANNEL),
    setUpdateChannel: (channel) =>
      ipcRenderer.invoke(IpcChannels.UPDATE_SET_CHANNEL_CHANNEL, channel),
    checkForUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_CHECK_CHANNEL),
    downloadUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_DOWNLOAD_CHANNEL),
    installUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_INSTALL_CHANNEL),
    onUpdateState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
      };
    },
    getSourceUpdateState: () => ipcRenderer.invoke(IpcChannels.SOURCE_UPDATE_GET_STATE_CHANNEL),
    checkSourceUpdate: () => ipcRenderer.invoke(IpcChannels.SOURCE_UPDATE_CHECK_CHANNEL),
    onSourceUpdateState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(IpcChannels.SOURCE_UPDATE_STATE_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IpcChannels.SOURCE_UPDATE_STATE_CHANNEL, wrappedListener);
      };
    },
  } satisfies DesktopBridge);
}
