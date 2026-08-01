import { DEFAULT_UNIFIED_SETTINGS } from "@cafecode/contracts/settings";
import { describe, expect, it, vi } from "vitest";

import {
  captureSettingsProfile,
  createSettingsProfilesStore,
  SETTINGS_PROFILE_FIELD_POLICY,
  SETTINGS_PROFILES_MAX_COUNT,
  SETTINGS_PROFILES_STORAGE_KEY,
  SettingsProfileError,
  type SettingsProfilesStorage,
} from "./settingsProfiles";

function createStorage(initial: string | null = null): SettingsProfilesStorage & {
  read: () => string | null;
} {
  let value = initial;
  return {
    getItem: (key) => (key === SETTINGS_PROFILES_STORAGE_KEY ? value : null),
    setItem: (key, next) => {
      if (key === SETTINGS_PROFILES_STORAGE_KEY) value = next;
    },
    read: () => value,
  };
}

const now = () => new Date("2026-08-01T12:00:00.000Z");
const payload = () => captureSettingsProfile(DEFAULT_UNIFIED_SETTINGS, "dark");

describe("settings profiles", () => {
  it("captures only explicitly allowed presentation fields", () => {
    const source = {
      ...DEFAULT_UNIFIED_SETTINGS,
      themeAccentColor: "#123456",
      providerApiToken: "secret",
      providerBaseUrl: "https://private.invalid",
      autoNudgeMode: "hardcore",
      autoNudgeMaxMinutes: 5,
      mediaPlaylistPath: "C:/private/music",
      telemetryEnabled: true,
    } as typeof DEFAULT_UNIFIED_SETTINGS;

    const result = captureSettingsProfile(source, "system");
    const included = Object.entries(SETTINGS_PROFILE_FIELD_POLICY)
      .filter(([, policy]) => policy === "include")
      .map(([key]) => key)
      .toSorted();

    expect(Object.keys(result.clientSettings).toSorted()).toEqual(included);
    expect(result.clientSettings.themeAccentColor).toBe("#123456");
    expect(result.clientSettings).not.toHaveProperty("providerApiToken");
    expect(result.clientSettings).not.toHaveProperty("providerBaseUrl");
    expect(result.clientSettings).not.toHaveProperty("autoNudgeMode");
    expect(result.clientSettings).not.toHaveProperty("autoNudgeMaxMinutes");
    expect(result.clientSettings).not.toHaveProperty("mediaPlaylistPath");
    expect(result.clientSettings).not.toHaveProperty("telemetryEnabled");
    expect(result.clientSettings).not.toHaveProperty("sidebarBrandImageDataUrl");
    expect(result.clientSettings).not.toHaveProperty("defaultEditor");
  });

  it("saves, reloads, and applies deterministic IDs without storing unknown fields", () => {
    const storage = createStorage();
    const store = createSettingsProfilesStore(storage, now);
    const created = store.create("  Mobile   view  ", payload());

    expect(created).toMatchObject({
      id: "profile:mobile%20view",
      name: "Mobile view",
      theme: "dark",
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    expect(createSettingsProfilesStore(storage).getSnapshot().profiles).toEqual([created]);
    expect(JSON.parse(storage.read() ?? "null")).toEqual({ version: 1, profiles: [created] });
  });

  it("treats Unicode-equivalent names as duplicates and rejects unsafe names", () => {
    const store = createSettingsProfilesStore(createStorage(), now);
    store.create("Mobile", payload());

    expect(() => store.create("Ｍｏｂｉｌｅ", payload())).toThrow(SettingsProfileError);
    expect(() => store.create("bad/name", payload())).toThrow(SettingsProfileError);
    expect(() => store.create("bad\ud800name", payload())).toThrow(SettingsProfileError);
    expect(store.getSnapshot().profiles).toHaveLength(1);
  });

  it("skips malformed, duplicate, and mismatched persisted records", () => {
    const valid = {
      id: "profile:valid",
      name: "Valid",
      theme: "light",
      clientSettings: { showSidebarMascot: false },
      createdAt: "2026-08-01T12:00:00.000Z",
    };
    const raw = JSON.stringify({
      version: 1,
      profiles: [
        null,
        { ...valid, id: "forged" },
        { ...valid, createdAt: "tomorrow" },
        valid,
        { ...valid, name: "Ｖａｌｉｄ", id: "profile:valid" },
      ],
    });

    expect(createSettingsProfilesStore(createStorage(raw)).getSnapshot().profiles).toEqual([valid]);
  });

  it("never invokes accessors or accepts prototype-bearing settings", () => {
    const storage = createStorage();
    const store = createSettingsProfilesStore(storage, now);
    const getter = vi.fn(() => payload().clientSettings);
    const unsafePayload = { theme: "dark" } as Record<string, unknown>;
    Object.defineProperty(unsafePayload, "clientSettings", { get: getter });

    expect(() => store.create("Accessor", unsafePayload as never)).toThrow(SettingsProfileError);
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      store.create("Prototype", {
        theme: "dark",
        clientSettings: Object.create({ showSidebarMascot: false }),
      }),
    ).toThrow(SettingsProfileError);
    expect(storage.read()).toBeNull();
  });

  it("does not publish a profile when persistence or timestamp validation fails", () => {
    const writeError = new Error("quota");
    const storage: SettingsProfilesStorage = {
      getItem: () => null,
      setItem: () => {
        throw writeError;
      },
    };
    const store = createSettingsProfilesStore(storage, now);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(() => store.create("Quota", payload())).toThrow(
      "The profile could not be saved to local storage.",
    );
    expect(store.getSnapshot().profiles).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);

    const invalidTimeStore = createSettingsProfilesStore(createStorage(), () => new Date(NaN));
    expect(() => invalidTimeStore.create("Time", payload())).toThrow(
      "The profile timestamp is invalid.",
    );
    expect(invalidTimeStore.getSnapshot().profiles).toEqual([]);
  });

  it("refreshes before each write so sequential windows do not overwrite one another", () => {
    const storage = createStorage();
    const first = createSettingsProfilesStore(storage, now);
    const second = createSettingsProfilesStore(storage, now);

    first.create("First", payload());
    second.create("Second", payload());

    expect(second.getSnapshot().profiles.map(({ name }) => name)).toEqual(["First", "Second"]);
    first.refresh();
    expect(first.getSnapshot().profiles.map(({ name }) => name)).toEqual(["First", "Second"]);
  });

  it("enforces the local profile count before writing", () => {
    const storage = createStorage();
    const store = createSettingsProfilesStore(storage, now);
    for (let index = 0; index < SETTINGS_PROFILES_MAX_COUNT; index += 1) {
      store.create(`Profile ${index}`, payload());
    }
    const before = storage.read();

    expect(() => store.create("One too many", payload())).toThrow(
      `You can save up to ${SETTINGS_PROFILES_MAX_COUNT} profiles.`,
    );
    expect(storage.read()).toBe(before);
  });
});
