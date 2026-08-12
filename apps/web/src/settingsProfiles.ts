import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type ClientSettingsPatch,
  type UnifiedSettings,
} from "@cafecode/contracts/settings";
import * as Schema from "effect/Schema";
import { useEffect, useSyncExternalStore } from "react";

export const SETTINGS_PROFILES_STORAGE_KEY = "cafe-code:settings-profiles:v1";
export const SETTINGS_PROFILES_MAX_COUNT = 16;
export const SETTINGS_PROFILE_NAME_MAX_LENGTH = 64;
export const SETTINGS_PROFILES_MAX_BYTES = 256 * 1024;
export const SETTINGS_PROFILES_LOCK_NAME = "cafe-code:settings-profiles:v1:mutation";
export const MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_KEY =
  "cafe-code:settings-profiles:mobile-bootstrap:v1";
export const MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_VALUE = "considered";
const SETTINGS_PROFILES_VERSION = 2;
const LEGACY_SETTINGS_PROFILES_VERSIONS = new Set<unknown>([1]);
const SETTINGS_PROFILES_MAX_CANDIDATES = SETTINGS_PROFILES_MAX_COUNT * 4;

type ProfileFieldPolicy =
  | "include"
  | "bookkeeping"
  | "external-operation"
  | "external-media-activation"
  | "asset-or-path"
  | "provider-or-model"
  | "native-control"
  | "project-specific";

/**
 * Exhaustive fail-closed policy for local client fields. Server settings are
 * never accepted. Unknown persisted fields (including future provider,
 * network/security, Auto Nudge/minute, pacing, or telemetry fields) are ignored
 * because capture and decode copy only keys marked `include` here. Profiles can
 * store bounded media configuration, but they never store media activation.
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
  ambianceEnabled: "include",
  ambianceEffect: "include",
  ambianceIntensity: "include",
  ambianceReactMode: "include",
  ambianceSurfaceSidebar: "include",
  ambianceSurfaceThread: "include",
  ambianceSurfaceComposer: "include",
  ambianceColor: "include",
  ambientVideoEnabled: "external-media-activation",
  ambientVideoSource: "include",
  ambientVideoLayoutMode: "include",
  ambientVideoPresetPlacement: "include",
  ambientVideoPresetSize: "include",
  ambientVideoPresentationMode: "include",
  ambientVideoGlowEnabled: "include",
  ambientVideoGlowMode: "include",
  ambientVideoGlowColor: "include",
  ambientVideoGlowOpacity: "include",
  ambientImageEnabled: "external-media-activation",
  ambientImageAsset: "include",
  ambientImageCycleAssets: "include",
  ambientImageCycleEnabled: "external-media-activation",
  ambientImageCycleSeconds: "include",
  ambientImagePresentationMode: "include",
  ambientImageLayoutMode: "include",
  ambientImagePresetPlacement: "include",
  ambientImagePresetSize: "include",
  ambientImageGlowEnabled: "include",
  ambientImageGlowColor: "include",
  ambientImageGlowOpacity: "include",
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

export type MobileSettingsProfileBootstrapResult = "created" | "skipped";

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
// Exact allowlist from the version-1 document contract. Do not derive this as
// the complement of newer fields: doing that would let a future `include`
// policy change silently grant old documents authority over a new setting.
const versionOneIncludedKeys = Object.freeze([
  "autoOpenPlanSidebar",
  "confirmThreadArchive",
  "confirmThreadDelete",
  "diffIgnoreWhitespace",
  "diffWordWrap",
  "continueBackgroundAnimations",
  "showSidebarSearch",
  "showSidebarMascot",
  "showSidebarAttribution",
  "brandWordmarkPrefix",
  "sidebarStarSpeed",
  "themeAccentColor",
  "appAccentColor",
  "sidebarProjectGroupingMode",
  "sidebarProjectSortOrder",
  "sidebarThreadSortOrder",
  "sidebarThreadPreviewCount",
  "timestampFormat",
  "chatCopyFormat",
] as const satisfies readonly IncludedKey[]);
// Exact allowlist written by version 2. Decoding must never consult the live
// policy because a forged future-looking property in an old document could
// otherwise gain authority after a later field becomes `include`. To change
// persisted profile fields, bump SETTINGS_PROFILES_VERSION and add a new exact
// version allowlist instead of modifying this tuple.
const versionTwoIncludedKeys = Object.freeze([
  "autoOpenPlanSidebar",
  "confirmThreadArchive",
  "confirmThreadDelete",
  "diffIgnoreWhitespace",
  "diffWordWrap",
  "continueBackgroundAnimations",
  "showSidebarSearch",
  "showSidebarMascot",
  "showSidebarAttribution",
  "brandWordmarkPrefix",
  "sidebarStarSpeed",
  "ambianceEnabled",
  "ambianceEffect",
  "ambianceIntensity",
  "ambianceReactMode",
  "ambianceSurfaceSidebar",
  "ambianceSurfaceThread",
  "ambianceSurfaceComposer",
  "ambianceColor",
  "ambientVideoSource",
  "ambientVideoLayoutMode",
  "ambientVideoPresetPlacement",
  "ambientVideoPresetSize",
  "ambientVideoPresentationMode",
  "ambientVideoGlowEnabled",
  "ambientVideoGlowMode",
  "ambientVideoGlowColor",
  "ambientVideoGlowOpacity",
  "ambientImageAsset",
  "ambientImageCycleAssets",
  "ambientImageCycleSeconds",
  "ambientImagePresentationMode",
  "ambientImageLayoutMode",
  "ambientImagePresetPlacement",
  "ambientImagePresetSize",
  "ambientImageGlowEnabled",
  "ambientImageGlowColor",
  "ambientImageGlowOpacity",
  "themeAccentColor",
  "appAccentColor",
  "sidebarProjectGroupingMode",
  "sidebarProjectSortOrder",
  "sidebarThreadSortOrder",
  "sidebarThreadPreviewCount",
  "timestampFormat",
  "chatCopyFormat",
] as const satisfies readonly IncludedKey[]);
const nestedProfileKeys = new Set<IncludedKey>([
  "ambientVideoSource",
  "ambientImageAsset",
  "ambientImageCycleAssets",
]);
const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const emptySnapshot = (): SettingsProfilesSnapshot =>
  Object.freeze({ profiles: Object.freeze([]) });
const ownValue = (input: object, key: PropertyKey): unknown => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};
const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};
const isTheme = (value: unknown): value is SettingsProfileTheme =>
  value === "light" || value === "dark" || value === "system";
const isCanonicalTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length === 24 &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const INVALID_PROFILE_VALUE = Symbol("invalid-profile-value");
const SETTINGS_PROFILE_MAX_NESTED_DEPTH = 6;
const SETTINGS_PROFILE_MAX_NESTED_NODES = 256;
const SETTINGS_PROFILE_MAX_NESTED_KEYS = 64;

/**
 * Copy a bounded JSON-like value without reading inherited properties or
 * accessors. Only the three media-reference fields use this path.
 */
function cloneNestedProfileValue(
  value: unknown,
  budget: { nodes: number },
  depth = 0,
): unknown | typeof INVALID_PROFILE_VALUE {
  budget.nodes += 1;
  if (
    budget.nodes > SETTINGS_PROFILE_MAX_NESTED_NODES ||
    depth > SETTINGS_PROFILE_MAX_NESTED_DEPTH
  ) {
    return INVALID_PROFILE_VALUE;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID_PROFILE_VALUE;
  if (typeof value === "string") return value.length <= 4_096 ? value : INVALID_PROFILE_VALUE;
  if (typeof value !== "object") return INVALID_PROFILE_VALUE;

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return INVALID_PROFILE_VALUE;
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > SETTINGS_PROFILE_MAX_NESTED_KEYS
      ) {
        return INVALID_PROFILE_VALUE;
      }
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) return INVALID_PROFILE_VALUE;
        const entry = cloneNestedProfileValue(descriptor.value, budget, depth + 1);
        if (entry === INVALID_PROFILE_VALUE) return INVALID_PROFILE_VALUE;
        result.push(entry);
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return INVALID_PROFILE_VALUE;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > SETTINGS_PROFILE_MAX_NESTED_KEYS ||
      keys.some((key) => typeof key !== "string")
    ) {
      return INVALID_PROFILE_VALUE;
    }
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return INVALID_PROFILE_VALUE;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return INVALID_PROFILE_VALUE;
      const entry = cloneNestedProfileValue(descriptor.value, budget, depth + 1);
      if (entry === INVALID_PROFILE_VALUE) return INVALID_PROFILE_VALUE;
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: entry,
        writable: true,
      });
    }
    return result;
  } catch {
    return INVALID_PROFILE_VALUE;
  }
}

function cloneAndFreezeProfileValue<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreezeProfileValue(entry))) as Value;
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, cloneAndFreezeProfileValue(entry)]),
      ),
    ) as Value;
  }
  return value;
}

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

function sanitizeClientSettings(
  value: unknown,
  keys: readonly IncludedKey[] = includedKeys,
): SettingsProfileClientSettings {
  if (!isRecord(value)) throw new SettingsProfileError("The profile settings are invalid.");
  const candidate: Record<string, unknown> = { ...DEFAULT_CLIENT_SETTINGS };
  for (const key of keys) {
    const field = ownValue(value, key);
    if (field === undefined) continue;
    if (nestedProfileKeys.has(key)) {
      const safeField = cloneNestedProfileValue(field, { nodes: 0 });
      if (safeField === INVALID_PROFILE_VALUE) {
        throw new SettingsProfileError("The profile settings are invalid.");
      }
      candidate[key] = safeField;
    } else {
      candidate[key] = field;
    }
  }
  let decoded: ClientSettings;
  try {
    decoded = decodeClientSettings(candidate, { onExcessProperty: "error" });
  } catch {
    throw new SettingsProfileError("The profile settings are invalid.");
  }
  const result: Partial<Record<IncludedKey, unknown>> = {};
  for (const key of keys) {
    if (ownValue(value, key) !== undefined) {
      result[key] = cloneAndFreezeProfileValue(decoded[key]);
    }
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

/**
 * Apply saved media configuration without starting external playback or an
 * image cycle. Explicit false values also stop media that is already active.
 */
export function buildSettingsProfileApplyPatch(
  clientSettings: SettingsProfileClientSettings,
): ClientSettingsPatch {
  const safeClientSettings = sanitizeClientSettings(clientSettings);
  return {
    ...safeClientSettings,
    ambientVideoEnabled: false,
    ambientImageEnabled: false,
    ambientImageCycleEnabled: false,
  };
}

function freezeProfile(profile: SettingsProfile): SettingsProfile {
  return Object.freeze({
    ...profile,
    clientSettings: cloneAndFreezeProfileValue(profile.clientSettings),
  });
}

function parseSnapshot(raw: string | null): SettingsProfilesSnapshot {
  if (raw === null || new TextEncoder().encode(raw).byteLength > SETTINGS_PROFILES_MAX_BYTES) {
    return emptySnapshot();
  }
  try {
    const document = JSON.parse(raw) as unknown;
    if (!isRecord(document)) {
      return emptySnapshot();
    }
    const version = ownValue(document, "version");
    if (version !== SETTINGS_PROFILES_VERSION && !LEGACY_SETTINGS_PROFILES_VERSIONS.has(version)) {
      return emptySnapshot();
    }
    const clientKeys = version === 1 ? versionOneIncludedKeys : versionTwoIncludedKeys;
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
        const clientSettings = sanitizeClientSettings(
          ownValue(candidate, "clientSettings"),
          clientKeys,
        );
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

type StorageReadResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false };

function readStorageEntry(storage: SettingsProfilesStorage | null, key: string): StorageReadResult {
  if (storage === null) return { ok: false };
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch {
    return { ok: false };
  }
}

/**
 * Bootstrap authority is deliberately narrower than normal profile decoding.
 * An empty decoded snapshot can also mean corrupt, oversized, legacy, or
 * unsupported storage. None of those states grants permission to overwrite the
 * document.
 */
type MobileBootstrapLibraryState = "absent" | "empty" | "populated" | "unsafe";

function inspectMobileBootstrapLibrary(raw: string | null): MobileBootstrapLibraryState {
  if (raw === null) return "absent";
  if (new TextEncoder().encode(raw).byteLength > SETTINGS_PROFILES_MAX_BYTES) return "unsafe";
  try {
    const document = JSON.parse(raw) as unknown;
    if (!isRecord(document) || ownValue(document, "version") !== SETTINGS_PROFILES_VERSION) {
      return "unsafe";
    }
    const documentKeys = Reflect.ownKeys(document);
    if (
      documentKeys.length !== 2 ||
      documentKeys.some((key) => key !== "version" && key !== "profiles")
    ) {
      return "unsafe";
    }
    const candidates = ownValue(document, "profiles");
    if (!Array.isArray(candidates) || candidates.length > SETTINGS_PROFILES_MAX_COUNT) {
      return "unsafe";
    }
    if (candidates.length === 0) return "empty";

    // A populated current-version document is authoritative only when every
    // record survives the normal decoder. A partly corrupt document must not
    // gain a bootstrap marker merely because one other record is readable.
    return parseSnapshot(raw).profiles.length === candidates.length ? "populated" : "unsafe";
  } catch {
    return "unsafe";
  }
}

function writeMobileBootstrapConsideredMarker(storage: SettingsProfilesStorage): void {
  try {
    storage.setItem(
      MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_KEY,
      MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_VALUE,
    );
  } catch {
    throw new SettingsProfileError(
      "The mobile profile bootstrap could not be saved to local storage.",
    );
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
    seedMobileProfileOnce(
      nameInput: string,
      payloadInput: SettingsProfilePayload,
    ): MobileSettingsProfileBootstrapResult {
      const marker = readStorageEntry(storage, MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_KEY);
      const library = readStorageEntry(storage, SETTINGS_PROFILES_STORAGE_KEY);
      if (!marker.ok || marker.value !== null || !library.ok) {
        return "skipped";
      }
      const libraryState = inspectMobileBootstrapLibrary(library.value);
      if (libraryState === "unsafe") return "skipped";

      // Claim the decision before creating the profile. A failed library write
      // must not cause a new attempt on every mount. A valid populated library
      // is also a completed decision; marking it considered preserves a later
      // operator deletion across reloads without changing the library itself.
      writeMobileBootstrapConsideredMarker(storage!);
      if (libraryState === "populated") {
        refresh();
        return "skipped";
      }

      // Re-read after claiming the one-time marker. Cooperative browser
      // windows run this method inside SETTINGS_PROFILES_LOCK_NAME, while this
      // second check also avoids overwriting a non-cooperative concurrent win.
      const latestLibrary = readStorageEntry(storage, SETTINGS_PROFILES_STORAGE_KEY);
      const latestLibraryState = latestLibrary.ok
        ? inspectMobileBootstrapLibrary(latestLibrary.value)
        : "unsafe";
      if (latestLibraryState !== "absent" && latestLibraryState !== "empty") {
        refresh();
        return "skipped";
      }

      return this.create(nameInput, payloadInput) ? "created" : "skipped";
    },
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
