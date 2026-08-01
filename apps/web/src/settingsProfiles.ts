import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type UnifiedSettings,
} from "@cafecode/contracts/settings";
import * as Schema from "effect/Schema";
import { useEffect, useSyncExternalStore } from "react";

export const SETTINGS_PROFILES_STORAGE_KEY = "cafe-code:settings-profiles:v1";
export const SETTINGS_PROFILES_MAX_COUNT = 16;
export const SETTINGS_PROFILE_NAME_MAX_LENGTH = 64;
export const SETTINGS_PROFILES_MAX_BYTES = 256 * 1024;
export const SETTINGS_PROFILES_LOCK_NAME = "cafe-code:settings-profiles:v1:mutation";
const SETTINGS_PROFILES_VERSION = 1;
const SETTINGS_PROFILES_MAX_CANDIDATES = SETTINGS_PROFILES_MAX_COUNT * 4;

type ProfileFieldPolicy =
  | "include"
  | "bookkeeping"
  | "external-operation"
  | "asset-or-path"
  | "provider-or-model"
  | "native-control"
  | "project-specific";

/**
 * Exhaustive fail-closed policy for local client fields. Server settings are
 * never accepted. Unknown persisted fields (including future provider,
 * network/security, Auto Nudge/minute, media, pacing, or telemetry fields) are
 * ignored because capture and decode copy only keys marked `include` here.
 */
export const SETTINGS_PROFILE_FIELD_POLICY = {
  autoOpenPlanSidebar: "include",
  onboardingCompleted: "bookkeeping",
  dismissedFirstRunHints: "bookkeeping",
  notificationsEnabled: "external-operation",
  confirmThreadArchive: "include",
  confirmThreadDelete: "include",
  dismissedProviderUpdateNotificationKeys: "bookkeeping",
  diffIgnoreWhitespace: "include",
  diffWordWrap: "include",
  continueBackgroundAnimations: "include",
  showSidebarSearch: "include",
  showSidebarMascot: "include",
  showSidebarAttribution: "include",
  brandWordmarkPrefix: "include",
  sidebarBrandImage: "asset-or-path",
  sidebarBrandImageDataUrl: "asset-or-path",
  sidebarStarSpeed: "include",
  themeAccentColor: "include",
  appAccentColor: "include",
  defaultEditor: "native-control",
  favorites: "provider-or-model",
  providerModelPreferences: "provider-or-model",
  powerSaveBlockerMode: "native-control",
  sidebarProjectGroupingMode: "include",
  sidebarProjectGroupingOverrides: "project-specific",
  sidebarProjectSortOrder: "include",
  sidebarThreadSortOrder: "include",
  sidebarThreadPreviewCount: "include",
  timestampFormat: "include",
  chatCopyFormat: "include",
} as const satisfies Record<keyof ClientSettings, ProfileFieldPolicy>;

type IncludedKey = {
  [Key in keyof typeof SETTINGS_PROFILE_FIELD_POLICY]: (typeof SETTINGS_PROFILE_FIELD_POLICY)[Key] extends "include"
    ? Key
    : never;
}[keyof typeof SETTINGS_PROFILE_FIELD_POLICY];
export type SettingsProfileClientSettings = Partial<Pick<ClientSettings, IncludedKey>>;
export type SettingsProfileTheme = "light" | "dark" | "system";
export interface SettingsProfilePayload {
  readonly theme: SettingsProfileTheme;
  readonly clientSettings: SettingsProfileClientSettings;
}
export interface SettingsProfile extends SettingsProfilePayload {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}
export interface SettingsProfilesSnapshot {
  readonly profiles: readonly SettingsProfile[];
}
export interface SettingsProfilesStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export class SettingsProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsProfileError";
  }
}

const includedKeys = Object.freeze(
  (Object.keys(SETTINGS_PROFILE_FIELD_POLICY) as Array<keyof ClientSettings>).filter(
    (key): key is IncludedKey => SETTINGS_PROFILE_FIELD_POLICY[key] === "include",
  ),
);
const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const emptySnapshot = (): SettingsProfilesSnapshot =>
  Object.freeze({ profiles: Object.freeze([]) });
const ownValue = (input: object, key: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};
const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isTheme = (value: unknown): value is SettingsProfileTheme =>
  value === "light" || value === "dark" || value === "system";
const isCanonicalTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length === 24 &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function normalizeName(input: string): string {
  if (typeof input !== "string" || input.length > SETTINGS_PROFILE_NAME_MAX_LENGTH * 4) {
    throw new SettingsProfileError("Choose a profile name with 1 to 64 printable characters.");
  }
  const canonical = input.normalize("NFKC");
  const invalid = Array.from(canonical).some((character) => {
    const point = character.codePointAt(0)!;
    return (
      point <= 31 ||
      point === 127 ||
      (point >= 0xd800 && point <= 0xdfff) ||
      /\p{Cf}|\p{Zl}|\p{Zp}/u.test(character) ||
      character === "/" ||
      character === "\\"
    );
  });
  const name = canonical.trim().replace(/\s+/gu, " ");
  if (invalid || name.length === 0 || Array.from(name).length > SETTINGS_PROFILE_NAME_MAX_LENGTH) {
    throw new SettingsProfileError("Choose a profile name with 1 to 64 printable characters.");
  }
  return name;
}

function idForName(name: string): string {
  return `profile:${encodeURIComponent(normalizeName(name).toLocaleLowerCase("en-US"))}`;
}

function sanitizeClientSettings(value: unknown): SettingsProfileClientSettings {
  if (!isRecord(value)) throw new SettingsProfileError("The profile settings are invalid.");
  const candidate: Record<string, unknown> = { ...DEFAULT_CLIENT_SETTINGS };
  for (const key of includedKeys) {
    const field = ownValue(value, key);
    if (field !== undefined) candidate[key] = field;
  }
  let decoded: ClientSettings;
  try {
    decoded = decodeClientSettings(candidate, { onExcessProperty: "error" });
  } catch {
    throw new SettingsProfileError("The profile settings are invalid.");
  }
  const result: Partial<Record<IncludedKey, unknown>> = {};
  for (const key of includedKeys) {
    if (ownValue(value, key) !== undefined) result[key] = decoded[key];
  }
  return Object.freeze(result) as SettingsProfileClientSettings;
}

export function captureSettingsProfile(
  settings: UnifiedSettings,
  theme: SettingsProfileTheme,
): SettingsProfilePayload {
  if (!isTheme(theme)) throw new SettingsProfileError("Choose a valid theme.");
  const selected: Partial<Record<IncludedKey, unknown>> = {};
  for (const key of includedKeys) selected[key] = settings[key];
  return Object.freeze({ theme, clientSettings: sanitizeClientSettings(selected) });
}

function freezeProfile(profile: SettingsProfile): SettingsProfile {
  return Object.freeze({
    ...profile,
    clientSettings: Object.freeze({ ...profile.clientSettings }),
  });
}

function parseSnapshot(raw: string | null): SettingsProfilesSnapshot {
  if (raw === null || new TextEncoder().encode(raw).byteLength > SETTINGS_PROFILES_MAX_BYTES) {
    return emptySnapshot();
  }
  try {
    const document = JSON.parse(raw) as unknown;
    if (!isRecord(document) || ownValue(document, "version") !== SETTINGS_PROFILES_VERSION) {
      return emptySnapshot();
    }
    const candidates = ownValue(document, "profiles");
    if (!Array.isArray(candidates)) return emptySnapshot();
    const profiles: SettingsProfile[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const candidate of candidates.slice(0, SETTINGS_PROFILES_MAX_CANDIDATES)) {
      if (profiles.length >= SETTINGS_PROFILES_MAX_COUNT) break;
      if (!isRecord(candidate)) continue;
      const persistedId = ownValue(candidate, "id");
      const persistedName = ownValue(candidate, "name");
      const theme = ownValue(candidate, "theme");
      const createdAt = ownValue(candidate, "createdAt");
      if (typeof persistedName !== "string" || !isTheme(theme) || !isCanonicalTimestamp(createdAt))
        continue;
      let name: string;
      try {
        name = normalizeName(persistedName);
        const id = idForName(name);
        const nameKey = name.toLocaleLowerCase("en-US");
        if (persistedId !== id || ids.has(id) || names.has(nameKey)) continue;
        const clientSettings = sanitizeClientSettings(ownValue(candidate, "clientSettings"));
        ids.add(id);
        names.add(nameKey);
        profiles.push(freezeProfile({ id, name, theme, clientSettings, createdAt }));
      } catch {
        continue;
      }
    }
    return Object.freeze({ profiles: Object.freeze(profiles) });
  } catch {
    return emptySnapshot();
  }
}

function browserStorage(): SettingsProfilesStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStorage(storage: SettingsProfilesStorage | null): string | null {
  if (storage === null) return null;
  try {
    return storage.getItem(SETTINGS_PROFILES_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function createSettingsProfilesStore(
  storage: SettingsProfilesStorage | null = browserStorage(),
  now: () => Date = () => new Date(),
) {
  let snapshot = parseSnapshot(readStorage(storage));
  const listeners = new Set<() => void>();
  const refresh = () => {
    const next = parseSnapshot(readStorage(storage));
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    resolve: (id: string) => snapshot.profiles.find((profile) => profile.id === id) ?? null,
    create: (nameInput: string, payloadInput: SettingsProfilePayload) => {
      if (storage === null) throw new SettingsProfileError("Local profile storage is unavailable.");
      refresh();
      const name = normalizeName(nameInput);
      const id = idForName(name);
      if (snapshot.profiles.some((profile) => profile.id === id)) {
        throw new SettingsProfileError(`A profile named “${name}” already exists.`);
      }
      if (snapshot.profiles.length >= SETTINGS_PROFILES_MAX_COUNT) {
        throw new SettingsProfileError(
          `You can save up to ${SETTINGS_PROFILES_MAX_COUNT} profiles.`,
        );
      }
      if (!isRecord(payloadInput) || !isTheme(ownValue(payloadInput, "theme"))) {
        throw new SettingsProfileError("The profile settings are invalid.");
      }
      let createdAt: string;
      try {
        createdAt = now().toISOString();
      } catch {
        throw new SettingsProfileError("The profile timestamp is invalid.");
      }
      if (!isCanonicalTimestamp(createdAt)) {
        throw new SettingsProfileError("The profile timestamp is invalid.");
      }
      const profile = freezeProfile({
        id,
        name,
        theme: ownValue(payloadInput, "theme") as SettingsProfileTheme,
        clientSettings: sanitizeClientSettings(ownValue(payloadInput, "clientSettings")),
        createdAt,
      });
      const next = Object.freeze({ profiles: Object.freeze([...snapshot.profiles, profile]) });
      const encoded = JSON.stringify({
        version: SETTINGS_PROFILES_VERSION,
        profiles: next.profiles,
      });
      if (new TextEncoder().encode(encoded).byteLength > SETTINGS_PROFILES_MAX_BYTES) {
        throw new SettingsProfileError("The local profile library is full.");
      }
      try {
        storage.setItem(SETTINGS_PROFILES_STORAGE_KEY, encoded);
      } catch {
        throw new SettingsProfileError("The profile could not be saved to local storage.");
      }
      snapshot = next;
      for (const listener of listeners) listener();
      return profile;
    },
  };
}

export const settingsProfilesStore = createSettingsProfilesStore();

export async function mutateSettingsProfiles<Value>(mutation: () => Value): Promise<Value> {
  const applyLatest = () => {
    settingsProfilesStore.refresh();
    return mutation();
  };
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks && typeof locks.request === "function"
    ? locks.request(SETTINGS_PROFILES_LOCK_NAME, applyLatest)
    : applyLatest();
}

export function useSettingsProfiles(): SettingsProfilesSnapshot {
  const snapshot = useSyncExternalStore(
    settingsProfilesStore.subscribe,
    settingsProfilesStore.getSnapshot,
    settingsProfilesStore.getSnapshot,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === SETTINGS_PROFILES_STORAGE_KEY || event.key === null)
        settingsProfilesStore.refresh();
    };
    window.addEventListener("storage", onStorage);
    settingsProfilesStore.refresh();
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return snapshot;
}
