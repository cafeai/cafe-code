import type { DesktopBridge, GlobalDictationEvent } from "@cafecode/contracts";
import { contextBridge, ipcRenderer } from "electron";

import * as IpcChannels from "./ipc/channels.ts";
import {
  DESKTOP_UI_LOCALE_CHANGED_CHANNEL,
  isDesktopUiLocale,
  readDesktopUiLocaleArguments,
} from "./settings/DesktopUiLocaleBridge.ts";

/**
 * The floating dictation renderer is not a full Cafe app window. Never give
 * it the ordinary preload's settings, filesystem, shell, debug, or provider
 * management capabilities. Its sole server bootstrap read is the local
 * endpoint needed to request short-lived Realtime transcription credentials.
 * Privileged text actions are still checked against this exact window in
 * desktop main before execution.
 */
const panelBridge: Pick<
  DesktopBridge,
  | "getLocalEnvironmentBootstrap"
  | "onGlobalDictationEvent"
  | "globalDictationAction"
  | "systemUiLocale"
  | "initialUiLocale"
  | "onUiLocaleChanged"
> = {
  ...readDesktopUiLocaleArguments(process.argv),
  onUiLocaleChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isDesktopUiLocale(value)) listener(value);
    };
    ipcRenderer.on(DESKTOP_UI_LOCALE_CHANGED_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_UI_LOCALE_CHANGED_CHANNEL, wrapped);
  },
  getLocalEnvironmentBootstrap: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL);
    if (typeof result !== "object" || result === null) return null;
    return result as ReturnType<DesktopBridge["getLocalEnvironmentBootstrap"]>;
  },
  onGlobalDictationEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
      const event = raw as Partial<GlobalDictationEvent>;
      if (
        typeof event.sessionId !== "string" ||
        !/^[a-f0-9-]{36}$/iu.test(event.sessionId) ||
        (event.type !== "start" &&
          event.type !== "stop" &&
          event.type !== "review" &&
          event.type !== "cancel") ||
        (event.insertionMethod !== undefined &&
          event.insertionMethod !== "accessibility" &&
          event.insertionMethod !== "paste") ||
        (event.guidance !== undefined &&
          event.guidance !== "accessibility_permission_required" &&
          event.guidance !== "target_unavailable")
      ) {
        return;
      }
      listener(event as GlobalDictationEvent);
    };
    ipcRenderer.on(IpcChannels.GLOBAL_DICTATION_EVENT_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(IpcChannels.GLOBAL_DICTATION_EVENT_CHANNEL, wrapped);
  },
  globalDictationAction: (action) =>
    ipcRenderer.invoke(IpcChannels.GLOBAL_DICTATION_ACTION_CHANNEL, action),
};

contextBridge.exposeInMainWorld("desktopBridge", panelBridge);
