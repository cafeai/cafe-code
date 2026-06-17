import { ClientSettingsSchema, type ClientSettings } from "@cafecode/contracts";

import {
  getLocalStorageItemWithLegacy,
  setLocalStorageItemWithLegacy,
} from "./hooks/useLocalStorage";

export const CLIENT_SETTINGS_STORAGE_KEY = "cafe-code:client-settings:v1";
export const LEGACY_CLIENT_SETTINGS_STORAGE_KEY = "cafecode:client-settings:v1";
export const SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY = "cafe-code:saved-environment-registry:v1";
export const LEGACY_SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY =
  "cafecode:saved-environment-registry:v1";
export const SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY =
  "cafe-code:saved-environment-session-secrets:v1";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function clearBrowserSavedEnvironmentPersistence(): void {
  if (!hasWindow()) {
    return;
  }

  try {
    window.localStorage.removeItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in locked-down browser contexts.
  }

  try {
    window.sessionStorage.removeItem(SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in locked-down browser contexts.
  }
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  clearBrowserSavedEnvironmentPersistence();

  try {
    return getLocalStorageItemWithLegacy(
      CLIENT_SETTINGS_STORAGE_KEY,
      [LEGACY_CLIENT_SETTINGS_STORAGE_KEY],
      ClientSettingsSchema,
    );
  } catch {
    return null;
  }
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  clearBrowserSavedEnvironmentPersistence();

  setLocalStorageItemWithLegacy(
    CLIENT_SETTINGS_STORAGE_KEY,
    [LEGACY_CLIENT_SETTINGS_STORAGE_KEY],
    settings,
    ClientSettingsSchema,
  );
}
