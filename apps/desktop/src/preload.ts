import type { DesktopBridge } from "@cafecode/contracts";
import type { VisualizationHostCapacity } from "@cafecode/contracts/visualizationHost";
import { contextBridge, ipcRenderer } from "electron";

import * as IpcChannels from "./ipc/channels.ts";
import {
  DESKTOP_UI_LOCALE_CHANGED_CHANNEL,
  isDesktopUiLocale,
  readDesktopUiLocaleArguments,
} from "./settings/DesktopUiLocaleBridge.ts";

/** Sandboxed preloads cannot import Node crypto. Browser WebCrypto is
 * available in the isolated world, including getRandomValues on non-secure
 * origins where randomUUID may be absent. Retain an RFC4122v4 identifier with
 * 122 random bits; an unavailable source refuses observation without a weak
 * fallback, retained listener, fabricated capacity or leaked exception. */
const createCapacityObserverId = (): string | undefined => {
  try {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return undefined;
  }
};

// Untrusted rendering helpers (including the opaque-origin Mermaid iframe)
// must never receive native capabilities. The BrowserWindow disables subframe
// Node integration and desktop main independently rejects subframe IPC; retain
// this fail-closed gate in the preload as well so a future preference change
// cannot accidentally publish the bridge into an embedded document.
if (process.isMainFrame === true) {
  const capacityListeners = new Set<(value: VisualizationHostCapacity) => void>();
  let capacityEpoch = 0;
  let capacitySequence = -1;
  let capacityObserver: { observerId: string; sequence: number } | undefined;
  const capacityChanged = (_event: Electron.IpcRendererEvent | undefined, raw: unknown) => {
    if (typeof raw !== "object" || raw === null || !capacityListeners.size) return;
    const value = raw as Record<string, unknown>;
    const keys = [
      "poolVersion",
      "sequence",
      "available",
      "viewerCount",
      "freeViewers",
      "preparedCount",
      "freePreparations",
      "mcpAppAvailable",
      "previewBusy",
    ];
    if (
      Object.keys(value).length !== keys.length ||
      Object.keys(value).some((key) => !keys.includes(key)) ||
      value.poolVersion !== 1 ||
      !Number.isSafeInteger(value.sequence) ||
      (value.sequence as number) < 0 ||
      (value.sequence as number) < capacitySequence ||
      typeof value.available !== "boolean" ||
      typeof value.mcpAppAvailable !== "boolean" ||
      typeof value.previewBusy !== "boolean" ||
      ["viewerCount", "freeViewers", "preparedCount", "freePreparations"].some(
        (key) =>
          !Number.isSafeInteger(value[key]) ||
          (value[key] as number) < 0 ||
          (value[key] as number) > 4,
      )
    )
      return;
    capacitySequence = value.sequence as number;
    const capacity: VisualizationHostCapacity = {
      poolVersion: 1,
      sequence: capacitySequence,
      available: value.available,
      viewerCount: value.viewerCount as number,
      freeViewers: value.freeViewers as number,
      preparedCount: value.preparedCount as number,
      freePreparations: value.freePreparations as number,
      mcpAppAvailable: value.mcpAppAvailable,
      previewBusy: value.previewBusy,
    };
    for (const listener of capacityListeners) {
      try {
        listener(capacity);
      } catch {
        /* UI listeners cannot disrupt native observation. */
      }
    }
  };
  contextBridge.exposeInMainWorld("desktopBridge", {
    ...readDesktopUiLocaleArguments(process.argv),
    onUiLocaleChanged: (listener: (locale: "en" | "ja" | "ko") => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => {
        if (isDesktopUiLocale(value)) listener(value);
      };
      ipcRenderer.on(DESKTOP_UI_LOCALE_CHANGED_CHANNEL, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_UI_LOCALE_CHANGED_CHANNEL, wrapped);
    },
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
    getVisualizationHostCapabilities: () =>
      ipcRenderer.invoke(IpcChannels.VISUALIZATION_CAPABILITIES_CHANNEL),
    getVisualizationHostCapacity: () =>
      ipcRenderer.invoke(IpcChannels.VISUALIZATION_CAPACITY_CHANNEL),
    onVisualizationCapacityChanged: (listener) => {
      if (capacityListeners.size >= 32) return () => {};
      // Mint before retaining the first registration so missing WebCrypto
      // cannot leave an unreachable listener or a half-admitted observer.
      const observerId = capacityListeners.size === 0 ? createCapacityObserverId() : undefined;
      if (capacityListeners.size === 0 && observerId === undefined) return () => {};
      // Each registration retains independent cleanup even for one caller function.
      const registered = (value: VisualizationHostCapacity) => listener(value);
      capacityListeners.add(registered);
      if (capacityListeners.size === 1) {
        const epoch = ++capacityEpoch;
        capacityObserver = { observerId: observerId!, sequence: epoch };
        capacitySequence = -1;
        ipcRenderer.on(IpcChannels.VISUALIZATION_CAPACITY_CHANGED_CHANNEL, capacityChanged);
        void ipcRenderer
          .invoke(IpcChannels.VISUALIZATION_CAPACITY_OBSERVE_CHANNEL, {
            observing: true,
            ...capacityObserver,
          })
          .then((value) => {
            if (capacityEpoch === epoch) capacityChanged(undefined, value);
          })
          .catch(() => {
            /* Unknown observation never fabricates available capacity. */
          });
      }
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        capacityListeners.delete(registered);
        if (!capacityListeners.size) {
          capacityEpoch += 1;
          const observer = capacityObserver;
          capacityObserver = undefined;
          ipcRenderer.removeListener(
            IpcChannels.VISUALIZATION_CAPACITY_CHANGED_CHANNEL,
            capacityChanged,
          );
          void ipcRenderer
            .invoke(IpcChannels.VISUALIZATION_CAPACITY_OBSERVE_CHANNEL, {
              observing: false,
              ...observer,
            })
            .catch(() => {
              /* Native document lifecycle also retires this observation. */
            });
        }
      };
    },
    openVisualization: (input) => ipcRenderer.invoke(IpcChannels.VISUALIZATION_OPEN_CHANNEL, input),
    focusVisualization: (input) =>
      ipcRenderer.invoke(IpcChannels.VISUALIZATION_FOCUS_CHANNEL, input),
    updateVisualization: (input) =>
      ipcRenderer.invoke(IpcChannels.VISUALIZATION_UPDATE_CHANNEL, input),
    retireVisualization: (input) =>
      ipcRenderer.invoke(IpcChannels.VISUALIZATION_RETIRE_CHANNEL, input),
    yieldVisualization: (input) =>
      ipcRenderer.invoke(IpcChannels.VISUALIZATION_YIELD_CHANNEL, input),
    beginVisualizationTransition: (input) =>
      ipcRenderer.invoke(IpcChannels.VISUALIZATION_TRANSITION_CHANNEL, input),
    captureVisualization: (input) =>
      ipcRenderer.invoke(IpcChannels.VISUALIZATION_CAPTURE_CHANNEL, input),
    sendVisualizationMessage: (input) =>
      ipcRenderer.invoke(IpcChannels.VISUALIZATION_MESSAGE_CHANNEL, input),
    suspendVisualization: (input) =>
      ipcRenderer.invoke(IpcChannels.VISUALIZATION_SUSPEND_CHANNEL, input),
    onVisualizationHostEvent: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, raw: unknown) => {
        if (typeof raw !== "object" || raw === null) return;
        const value = raw as {
          leaseId?: unknown;
          openingTicket?: unknown;
          state?: unknown;
          json?: unknown;
          reason?: unknown;
          wheel?: unknown;
        };
        if (
          Object.keys(value).some(
            (key) =>
              !["leaseId", "openingTicket", "state", "json", "reason", "wheel"].includes(key),
          )
        )
          return;
        if (
          typeof value.leaseId !== "string" ||
          !/^[a-f0-9-]{36}$/.test(value.leaseId) ||
          (value.openingTicket !== undefined &&
            (typeof value.openingTicket !== "string" ||
              !/^[a-f0-9]{64}$/.test(value.openingTicket))) ||
          !["active", "retired", "quarantined", "message", "wheel"].includes(String(value.state)) ||
          (value.json !== undefined &&
            (value.state !== "message" ||
              typeof value.json !== "string" ||
              value.json.length > 128 * 1024 ||
              new TextEncoder().encode(value.json).byteLength > 128 * 1024)) ||
          (value.reason !== undefined &&
            ![
              "busy",
              "invalid",
              "expired",
              "unavailable",
              "timeout",
              "resource-denied",
              "capture-failed",
              "retirement-uncertain",
              "owner-revoked",
            ].includes(String(value.reason)))
        )
          return;
        let wheel: { deltaX: number; deltaY: number } | undefined;
        if (value.state === "wheel") {
          if (typeof value.wheel !== "object" || value.wheel === null || value.json !== undefined)
            return;
          const raw = value.wheel as Record<string, unknown>;
          if (
            Object.keys(raw).length !== 2 ||
            typeof raw.deltaX !== "number" ||
            typeof raw.deltaY !== "number" ||
            !Number.isFinite(raw.deltaX) ||
            !Number.isFinite(raw.deltaY) ||
            Math.abs(raw.deltaX) > 2048 ||
            Math.abs(raw.deltaY) > 2048
          )
            return;
          wheel = { deltaX: raw.deltaX, deltaY: raw.deltaY };
        } else if (value.wheel !== undefined) return;
        listener({
          leaseId: value.leaseId,
          ...(value.openingTicket ? { openingTicket: value.openingTicket as string } : {}),
          state: value.state as Parameters<typeof listener>[0]["state"],
          ...(value.json !== undefined ? { json: value.json as string } : {}),
          ...(value.reason !== undefined
            ? { reason: value.reason as NonNullable<Parameters<typeof listener>[0]["reason"]> }
            : {}),
          ...(wheel ? { wheel } : {}),
        });
      };
      ipcRenderer.on(IpcChannels.VISUALIZATION_EVENT_CHANNEL, wrapped);
      return () => ipcRenderer.removeListener(IpcChannels.VISUALIZATION_EVENT_CHANNEL, wrapped);
    },
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
        const guidance = (payload as { readonly guidance?: unknown }).guidance;
        if (
          guidance !== undefined &&
          guidance !== "accessibility_permission_required" &&
          guidance !== "target_unavailable"
        )
          return;
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
    copyText: (text: string) => ipcRenderer.invoke(IpcChannels.COPY_TEXT_CHANNEL, text),
    copyPng: (png) => ipcRenderer.invoke(IpcChannels.COPY_PNG_CHANNEL, png),
    savePng: (input) => ipcRenderer.invoke(IpcChannels.SAVE_PNG_CHANNEL, input),
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
