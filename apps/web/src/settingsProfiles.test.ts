import { DEFAULT_UNIFIED_SETTINGS } from "@cafecode/contracts/settings";
import { describe, expect, it, vi } from "vitest";

import {
  buildSettingsProfileApplyPatch,
  buildSettingsProfileRollbackPatch,
  captureSettingsProfile,
  createSettingsProfilesStore,
  MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_KEY,
  MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_VALUE,
  getSettingsProfileDifferenceKeys,
  SETTINGS_PROFILE_FIELD_POLICY,
  SETTINGS_PROFILES_MAX_BYTES,
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

function createKeyedStorage(
  entries: Readonly<Record<string, string>> = {},
): SettingsProfilesStorage & {
  read: (key: string) => string | null;
  remove: (key: string) => void;
} {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    read: (key) => values.get(key) ?? null,
    remove: (key) => values.delete(key),
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

    const applyPatch = buildSettingsProfileApplyPatch(profile.clientSettings);
    expect(applyPatch).toMatchObject({
      ambientVideoSource: { kind: "video", id: "dQw4w9WgXcQ" },
      ambientVideoGlowEnabled: true,
      ambientVideoEnabled: false,
      ambientImageEnabled: false,
      ambientImageCycleEnabled: false,
    });
    expect(Object.isFrozen(applyPatch)).toBe(true);
  });

  it("previews only saved fields that would change", () => {
    const store = createSettingsProfilesStore(createStorage(), now);
    const saved = store.create("Preview", payload());
    const current = {
      ...DEFAULT_UNIFIED_SETTINGS,
      showSidebarMascot: !DEFAULT_UNIFIED_SETTINGS.showSidebarMascot,
      ambientVideoEnabled: true,
    };

    const differences = getSettingsProfileDifferenceKeys(saved, current, "light");

    expect(differences).toEqual(["theme", "showSidebarMascot", "ambientVideoEnabled"]);
    expect(Object.isFrozen(differences)).toBe(true);
    expect(differences).not.toContain("notificationsEnabled");
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

  it("does not invoke accessors while it captures or prepares compensation", () => {
    const captureGetter = vi.fn(() => false);
    const captureSource = { ...DEFAULT_UNIFIED_SETTINGS } as Record<string, unknown>;
    Object.defineProperty(captureSource, "showSidebarMascot", { get: captureGetter });

    expect(() => captureSettingsProfile(captureSource as never, "dark")).toThrow(
      SettingsProfileError,
    );
    expect(captureGetter).not.toHaveBeenCalled();

    const rollbackGetter = vi.fn(() => true);
    const rollbackSource = { ...DEFAULT_UNIFIED_SETTINGS } as Record<string, unknown>;
    Object.defineProperty(rollbackSource, "ambientVideoEnabled", { get: rollbackGetter });
    expect(() =>
      buildSettingsProfileRollbackPatch(
        rollbackSource as never,
        buildSettingsProfileApplyPatch(payload().clientSettings),
      ),
    ).toThrow(SettingsProfileError);
    expect(rollbackGetter).not.toHaveBeenCalled();

    const previewProfile = createSettingsProfilesStore(createStorage(), now).create(
      "Preview accessor",
      payload(),
    );
    const previewGetter = vi.fn(() => previewProfile.clientSettings);
    const unsafePreview = { ...previewProfile } as Record<string, unknown>;
    Object.defineProperty(unsafePreview, "clientSettings", { get: previewGetter });
    expect(() =>
      getSettingsProfileDifferenceKeys(unsafePreview as never, DEFAULT_UNIFIED_SETTINGS, "dark"),
    ).toThrow(SettingsProfileError);
    expect(previewGetter).not.toHaveBeenCalled();
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
    expect(JSON.parse(storage.read() ?? "null")).toEqual({
      version: 3,
      activeProfileId: null,
      profiles: [created],
    });
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

  it("migrates an exact version-two library when active state is first written", () => {
    const sourceStorage = createStorage();
    const source = createSettingsProfilesStore(sourceStorage, now);
    const saved = source.create("Legacy", payload());
    const versionTwo = JSON.stringify({ version: 2, profiles: [saved] });
    const storage = createStorage(versionTwo);
    const migrated = createSettingsProfilesStore(storage, now);

    expect(migrated.getSnapshot()).toMatchObject({ activeProfileId: null, profiles: [saved] });
    expect(migrated.activate(saved)).toBe("activated");
    expect(JSON.parse(storage.read() ?? "null")).toMatchObject({
      version: 3,
      activeProfileId: saved.id,
    });
  });

  it("fails closed for malformed or future-shaped version-three libraries", () => {
    const validStorage = createStorage();
    const validStore = createSettingsProfilesStore(validStorage, now);
    const saved = validStore.create("Strict", payload());
    const valid = JSON.parse(validStorage.read() ?? "null") as Record<string, unknown>;
    const cases = [
      { ...valid, activeProfileId: "profile:missing" },
      { version: 3, activeProfileId: "profile:missing", profiles: [] },
      { ...valid, futureProfileMetadata: true },
      { ...valid, profiles: [{ ...saved, futureProfileMetadata: true }] },
      {
        ...valid,
        profiles: [
          { ...saved, clientSettings: { ...saved.clientSettings, futurePresentationMode: true } },
        ],
      },
      { ...valid, profiles: [null] },
      { ...valid, version: 4 },
    ];

    for (const document of cases) {
      const raw = JSON.stringify(document);
      const storage = createStorage(raw);
      const store = createSettingsProfilesStore(storage);
      expect(store.getSnapshot()).toEqual({
        activeProfileId: null,
        profiles: [],
      });
      expect(() => store.create("Replacement", payload())).toThrow(
        "The saved profile library uses an unsupported or invalid format.",
      );
      expect(storage.read()).toBe(raw);
    }
  });

  it("renames and updates the active profile without losing active identity", () => {
    const storage = createStorage();
    const store = createSettingsProfilesStore(storage, now);
    const saved = store.create("Desk", payload());
    expect(store.activate(saved)).toBe("activated");

    const renamed = store.rename(saved, "Desktop");
    expect(typeof renamed).not.toBe("string");
    if (typeof renamed === "string") throw new Error("Expected a renamed profile.");
    expect(store.getSnapshot().activeProfileId).toBe(renamed.id);

    const nextPayload = captureSettingsProfile(
      { ...DEFAULT_UNIFIED_SETTINGS, showSidebarMascot: false },
      "light",
    );
    const updated = store.updateActive(renamed, nextPayload);
    expect(typeof updated).not.toBe("string");
    if (typeof updated === "string") throw new Error("Expected an updated profile.");
    expect(updated).toMatchObject({ theme: "light", clientSettings: { showSidebarMascot: false } });
    expect(store.getSnapshot().activeProfileId).toBe(updated.id);
  });

  it("rejects stale rename and update operations from another window", () => {
    const storage = createStorage();
    const first = createSettingsProfilesStore(storage, now);
    const stale = first.create("Shared", payload());
    expect(first.activate(stale)).toBe("activated");
    const second = createSettingsProfilesStore(storage, now);
    const changed = second.updateActive(
      stale,
      captureSettingsProfile({ ...DEFAULT_UNIFIED_SETTINGS, showSidebarMascot: false }, "light"),
    );
    expect(typeof changed).not.toBe("string");

    expect(first.rename(stale, "Renamed")).toBe("changed");
    expect(first.updateActive(stale, payload())).toBe("changed");
  });

  it("does not invoke hostile expected-profile accessors during mutations", () => {
    const storage = createStorage();
    const store = createSettingsProfilesStore(storage, now);
    const saved = store.create("Safe", payload());
    const idGetter = vi.fn(() => saved.id);
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, "id", { get: idGetter });

    expect(store.remove(hostile as never)).toBe("changed");
    expect(store.activate(hostile as never)).toBe("changed");
    expect(store.rename(hostile as never, "Renamed")).toBe("changed");
    expect(store.updateActive(hostile as never, payload())).toBe("changed");
    expect(idGetter).not.toHaveBeenCalled();

    const nameGetter = vi.fn(() => saved.name);
    const hostileComparable = { ...saved } as Record<string, unknown>;
    Object.defineProperty(hostileComparable, "name", { get: nameGetter });
    expect(store.remove(hostileComparable as never)).toBe("changed");
    expect(nameGetter).not.toHaveBeenCalled();
    expect(store.resolve(saved.id)).toEqual(saved);
  });

  it("clears active identity when the active profile is deleted", () => {
    const storage = createStorage();
    const store = createSettingsProfilesStore(storage, now);
    const saved = store.create("Active", payload());
    expect(store.activate(saved)).toBe("activated");
    expect(store.remove(saved)).toBe("removed");
    expect(store.getSnapshot()).toEqual({ activeProfileId: null, profiles: [] });
  });

  it("does not delete a same-name profile that another window replaced", () => {
    const storage = createStorage();
    const first = createSettingsProfilesStore(storage, now);
    const stale = first.create("Shared", payload());
    const second = createSettingsProfilesStore(storage, () => new Date("2026-08-02T12:00:00.000Z"));

    expect(second.remove(stale)).toBe("removed");
    const replacement = second.create("Shared", payload());
    first.refresh();

    expect(first.remove(stale)).toBe("changed");
    expect(first.resolve(replacement.id)).toEqual(replacement);
  });

  it("does not publish a deletion when local storage rejects the write", () => {
    const backing = createStorage();
    const store = createSettingsProfilesStore(backing, now);
    const saved = store.create("Keep", payload());
    const failingStorage: SettingsProfilesStorage = {
      getItem: backing.getItem,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const failingStore = createSettingsProfilesStore(failingStorage, now);

    expect(() => failingStore.remove(saved)).toThrow(
      "The profile could not be deleted from local storage.",
    );
    expect(failingStore.resolve(saved.id)).toEqual(saved);
    expect(createSettingsProfilesStore(backing).resolve(saved.id)).toEqual(saved);
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

  it.each([
    ["malformed", "{"],
    ["legacy empty", JSON.stringify({ version: 1, profiles: [] })],
    ["unsupported empty", JSON.stringify({ version: 99, profiles: [] })],
    [
      "future-shaped empty",
      JSON.stringify({ version: 2, profiles: [], futureProfileMetadata: true }),
    ],
    ["invalid records", JSON.stringify({ version: 2, profiles: [null] })],
    [
      "partly corrupt records",
      JSON.stringify({
        version: 2,
        profiles: [
          {
            id: "profile:valid",
            name: "Valid",
            theme: "dark",
            clientSettings: {},
            createdAt: "2026-08-01T12:00:00.000Z",
          },
          null,
        ],
      }),
    ],
    ["missing profiles", JSON.stringify({ version: 2 })],
    ["oversized", "x".repeat(SETTINGS_PROFILES_MAX_BYTES + 1)],
  ])("does not replace a %s profile document during mobile bootstrap", (_label, raw) => {
    const storage = createKeyedStorage({ [SETTINGS_PROFILES_STORAGE_KEY]: raw });
    const store = createSettingsProfilesStore(storage, now);

    expect(store.seedMobileProfileOnce("Mobile Profile", payload())).toBe("skipped");
    expect(storage.read(SETTINGS_PROFILES_STORAGE_KEY)).toBe(raw);
    expect(storage.read(MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_KEY)).toBeNull();
  });

  it("does not treat a profile read failure as an absent library", () => {
    const setItem = vi.fn();
    const storage: SettingsProfilesStorage = {
      getItem: (key) => {
        if (key === SETTINGS_PROFILES_STORAGE_KEY) throw new Error("blocked");
        return null;
      },
      setItem,
    };

    expect(
      createSettingsProfilesStore(storage, now).seedMobileProfileOnce("Mobile", payload()),
    ).toBe("skipped");
    expect(setItem).not.toHaveBeenCalled();
  });

  it.each([null, JSON.stringify({ version: 2, profiles: [] })])(
    "creates once from an absent or valid empty version-two library",
    (initial) => {
      const storage = createKeyedStorage(
        initial === null ? {} : { [SETTINGS_PROFILES_STORAGE_KEY]: initial },
      );
      const first = createSettingsProfilesStore(storage, now);
      const second = createSettingsProfilesStore(storage, now);

      expect(first.seedMobileProfileOnce("Mobile Profile", payload())).toBe("created");
      expect(second.seedMobileProfileOnce("Mobile Profile", payload())).toBe("skipped");
      expect(storage.read(MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_KEY)).toBe(
        MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_VALUE,
      );
      expect(
        JSON.parse(storage.read(SETTINGS_PROFILES_STORAGE_KEY) ?? "null").profiles,
      ).toHaveLength(1);
    },
  );

  it("does not recreate a mobile profile after an authoritative deletion", () => {
    const storage = createKeyedStorage();
    const store = createSettingsProfilesStore(storage, now);
    expect(store.seedMobileProfileOnce("Mobile Profile", payload())).toBe("created");

    storage.setItem(SETTINGS_PROFILES_STORAGE_KEY, JSON.stringify({ version: 2, profiles: [] }));
    store.refresh();

    expect(store.seedMobileProfileOnce("Mobile Profile", payload())).toBe("skipped");
    expect(JSON.parse(storage.read(SETTINGS_PROFILES_STORAGE_KEY) ?? "null").profiles).toEqual([]);
  });

  it("preserves bootstrap deletion authority after the seeded profile was active", () => {
    const storage = createKeyedStorage();
    const store = createSettingsProfilesStore(storage, now);
    expect(store.seedMobileProfileOnce("Mobile Profile", payload())).toBe("created");
    const mobile = store.resolve("profile:mobile%20profile");
    expect(mobile).not.toBeNull();
    expect(store.activate(mobile!)).toBe("activated");
    expect(store.remove(mobile!)).toBe("removed");

    const reloaded = createSettingsProfilesStore(storage, now);
    expect(reloaded.getSnapshot()).toEqual({ activeProfileId: null, profiles: [] });
    expect(reloaded.seedMobileProfileOnce("Mobile Profile", payload())).toBe("skipped");
    expect(reloaded.getSnapshot()).toEqual({ activeProfileId: null, profiles: [] });
  });

  it("records a populated version-two library as considered without changing it", () => {
    const storage = createKeyedStorage();
    const writer = createSettingsProfilesStore(storage, now);
    writer.create("Desktop", payload());
    const before = storage.read(SETTINGS_PROFILES_STORAGE_KEY);

    const bootstrap = createSettingsProfilesStore(storage, now);
    expect(bootstrap.seedMobileProfileOnce("Mobile Profile", payload())).toBe("skipped");
    expect(storage.read(SETTINGS_PROFILES_STORAGE_KEY)).toBe(before);
    expect(storage.read(MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_KEY)).toBe(
      MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_VALUE,
    );

    storage.setItem(SETTINGS_PROFILES_STORAGE_KEY, JSON.stringify({ version: 2, profiles: [] }));
    const reloaded = createSettingsProfilesStore(storage, now);
    expect(reloaded.seedMobileProfileOnce("Mobile Profile", payload())).toBe("skipped");
    expect(JSON.parse(storage.read(SETTINGS_PROFILES_STORAGE_KEY) ?? "null").profiles).toEqual([]);
  });

  it("fails closed when either bootstrap storage write fails", () => {
    const markerFailureStorage: SettingsProfilesStorage = {
      getItem: () => null,
      setItem: (key) => {
        if (key === MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_KEY) throw new Error("quota");
      },
    };
    expect(() =>
      createSettingsProfilesStore(markerFailureStorage, now).seedMobileProfileOnce(
        "Mobile Profile",
        payload(),
      ),
    ).toThrow("The mobile profile bootstrap could not be saved to local storage.");

    const storage = createKeyedStorage();
    const failingLibraryStorage: SettingsProfilesStorage = {
      getItem: storage.getItem,
      setItem: (key, value) => {
        if (key === SETTINGS_PROFILES_STORAGE_KEY) throw new Error("quota");
        storage.setItem(key, value);
      },
    };
    const store = createSettingsProfilesStore(failingLibraryStorage, now);
    expect(() => store.seedMobileProfileOnce("Mobile Profile", payload())).toThrow(
      "The profile could not be saved to local storage.",
    );
    expect(storage.read(MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_KEY)).toBe(
      MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_VALUE,
    );
    expect(store.seedMobileProfileOnce("Mobile Profile", payload())).toBe("skipped");

    const populatedStorage = createKeyedStorage();
    createSettingsProfilesStore(populatedStorage, now).create("Desktop", payload());
    const populatedDocument = populatedStorage.read(SETTINGS_PROFILES_STORAGE_KEY);
    const populatedMarkerFailure: SettingsProfilesStorage = {
      getItem: populatedStorage.getItem,
      setItem: (key, value) => {
        if (key === MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_KEY) throw new Error("quota");
        populatedStorage.setItem(key, value);
      },
    };
    expect(() =>
      createSettingsProfilesStore(populatedMarkerFailure, now).seedMobileProfileOnce(
        "Mobile Profile",
        payload(),
      ),
    ).toThrow("The mobile profile bootstrap could not be saved to local storage.");
    expect(populatedStorage.read(SETTINGS_PROFILES_STORAGE_KEY)).toBe(populatedDocument);
    expect(populatedStorage.read(MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_KEY)).toBeNull();
  });
});
