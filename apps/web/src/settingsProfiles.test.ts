import { DEFAULT_UNIFIED_SETTINGS } from "@cafecode/contracts/settings";
import { describe, expect, it, vi } from "vitest";

import {
  buildSettingsProfileApplyPatch,
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
    expect(result.clientSettings).not.toHaveProperty("ambientVideoEnabled");
    expect(result.clientSettings).not.toHaveProperty("ambientImageEnabled");
    expect(result.clientSettings).not.toHaveProperty("ambientImageCycleEnabled");
  });

  it("keeps bounded media configuration but forces every activation off", () => {
    const source = {
      ...DEFAULT_UNIFIED_SETTINGS,
      ambientVideoEnabled: true,
      ambientVideoSource: { kind: "video" as const, id: "dQw4w9WgXcQ" },
      ambientVideoGlowEnabled: true,
      ambientImageEnabled: true,
      ambientImageCycleEnabled: true,
    };

    const profile = captureSettingsProfile(source, "dark");
    expect(profile.clientSettings).toMatchObject({
      ambientVideoSource: { kind: "video", id: "dQw4w9WgXcQ" },
      ambientVideoGlowEnabled: true,
    });
    expect(profile.clientSettings).not.toHaveProperty("ambientVideoEnabled");
    expect(profile.clientSettings).not.toHaveProperty("ambientImageEnabled");
    expect(profile.clientSettings).not.toHaveProperty("ambientImageCycleEnabled");

    expect(buildSettingsProfileApplyPatch(profile.clientSettings)).toMatchObject({
      ambientVideoSource: { kind: "video", id: "dQw4w9WgXcQ" },
      ambientVideoGlowEnabled: true,
      ambientVideoEnabled: false,
      ambientImageEnabled: false,
      ambientImageCycleEnabled: false,
    });
  });

  it("does not invoke activation accessors while it builds an apply patch", () => {
    const getter = vi.fn(() => true);
    const clientSettings: Record<string, unknown> = {
      showSidebarMascot: false,
      ambientVideoSource: { kind: "video", id: "dQw4w9WgXcQ" },
    };
    Object.defineProperty(clientSettings, "ambientVideoEnabled", { get: getter });
    Object.defineProperty(clientSettings, "ambientImageEnabled", { get: getter });
    Object.defineProperty(clientSettings, "ambientImageCycleEnabled", { get: getter });

    expect(buildSettingsProfileApplyPatch(clientSettings as never)).toMatchObject({
      showSidebarMascot: false,
      ambientVideoEnabled: false,
      ambientImageEnabled: false,
      ambientImageCycleEnabled: false,
    });
    expect(getter).not.toHaveBeenCalled();
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
    expect(JSON.parse(storage.read() ?? "null")).toEqual({ version: 2, profiles: [created] });
  });

  it("does not give legacy documents new media behavior", () => {
    const raw = JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "profile:legacy",
          name: "Legacy",
          theme: "dark",
          clientSettings: {
            showSidebarMascot: false,
            ambientVideoSource: { kind: "video", id: "dQw4w9WgXcQ" },
            ambientVideoGlowEnabled: true,
          },
          createdAt: "2026-08-01T12:00:00.000Z",
        },
      ],
    });

    const [profile] = createSettingsProfilesStore(createStorage(raw)).getSnapshot().profiles;
    expect(profile?.clientSettings).toEqual({ showSidebarMascot: false });
  });

  it("keeps the version-one migration on its exact historical allowlist", () => {
    const raw = JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "profile:legacy",
          name: "Legacy",
          theme: "dark",
          clientSettings: {
            autoOpenPlanSidebar: false,
            ambianceEnabled: true,
            ambianceEffect: "snow",
            ambianceColor: "#123456",
            ambientImageGlowEnabled: true,
          },
          createdAt: "2026-08-01T12:00:00.000Z",
        },
      ],
    });

    const [profile] = createSettingsProfilesStore(createStorage(raw)).getSnapshot().profiles;
    expect(profile?.clientSettings).toEqual({ autoOpenPlanSidebar: false });
  });

  it("does not give a version-two document authority over a future-looking field", () => {
    const raw = JSON.stringify({
      version: 2,
      profiles: [
        {
          id: "profile:future",
          name: "Future",
          theme: "dark",
          clientSettings: {
            ambianceEnabled: true,
            futurePresentationMode: "external-operation",
          },
          createdAt: "2026-08-01T12:00:00.000Z",
        },
      ],
    });

    const [profile] = createSettingsProfilesStore(createStorage(raw)).getSnapshot().profiles;
    expect(profile?.clientSettings).toEqual({ ambianceEnabled: true });
    expect(profile?.clientSettings).not.toHaveProperty("futurePresentationMode");
  });

  it("rejects malformed nested media configuration without publishing it", () => {
    const storage = createStorage();
    const store = createSettingsProfilesStore(storage, now);
    const profile = payload();
    const sourceGetter = vi.fn(() => "video");
    const ambientVideoSource: Record<string, unknown> = { id: "dQw4w9WgXcQ" };
    Object.defineProperty(ambientVideoSource, "kind", { get: sourceGetter });

    expect(() =>
      store.create("Unsafe media", {
        ...profile,
        clientSettings: { ...profile.clientSettings, ambientVideoSource },
      } as never),
    ).toThrow(SettingsProfileError);
    expect(sourceGetter).not.toHaveBeenCalled();
    expect(storage.read()).toBeNull();
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
