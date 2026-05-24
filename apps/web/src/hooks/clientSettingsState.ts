import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@cafecode/contracts/settings";

const clientSettingsListeners = new Set<() => void>();
const clientSettingsHydrationListeners = new Set<() => void>();

let clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
let clientSettingsHydrated = false;
let clientSettingsHydrationPromise: Promise<void> | null = null;

function emitClientSettingsChange() {
  for (const listener of clientSettingsListeners) {
    listener();
  }
}

function emitClientSettingsHydrationChange() {
  for (const listener of clientSettingsHydrationListeners) {
    listener();
  }
}

export function getClientSettingsSnapshot(): ClientSettings {
  return clientSettingsSnapshot;
}

export function replaceClientSettingsSnapshot(settings: ClientSettings): void {
  clientSettingsSnapshot = settings;
  emitClientSettingsChange();
}

export function getClientSettingsHydratedSnapshot(): boolean {
  return clientSettingsHydrated;
}

export function setClientSettingsHydrated(nextHydrated: boolean): void {
  if (clientSettingsHydrated === nextHydrated) {
    return;
  }
  clientSettingsHydrated = nextHydrated;
  emitClientSettingsHydrationChange();
}

export function readClientSettingsHydrationPromise(): Promise<void> | null {
  return clientSettingsHydrationPromise;
}

export function writeClientSettingsHydrationPromise(promise: Promise<void>): void {
  clientSettingsHydrationPromise = promise;
}

export function clearClientSettingsHydrationPromise(promise: Promise<void>): void {
  if (clientSettingsHydrationPromise === promise) {
    clientSettingsHydrationPromise = null;
  }
}

export function subscribeClientSettingsSnapshot(listener: () => void): () => void {
  clientSettingsListeners.add(listener);
  return () => {
    clientSettingsListeners.delete(listener);
  };
}

export function subscribeClientSettingsHydrationSnapshot(listener: () => void): () => void {
  clientSettingsHydrationListeners.add(listener);
  return () => {
    clientSettingsHydrationListeners.delete(listener);
  };
}

export function __resetClientSettingsPersistenceForTests(): void {
  clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
  clientSettingsHydrated = false;
  clientSettingsHydrationPromise = null;
  clientSettingsListeners.clear();
  clientSettingsHydrationListeners.clear();
}
