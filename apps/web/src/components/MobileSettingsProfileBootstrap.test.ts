import { DEFAULT_UNIFIED_SETTINGS } from "@cafecode/contracts/settings";
import { describe, expect, it, vi } from "vitest";

import {
  captureSettingsProfile,
  createSettingsProfilesStore,
  MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_KEY,
  MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_VALUE,
  SETTINGS_PROFILES_STORAGE_KEY,
  type SettingsProfilesStorage,
} from "../settingsProfiles";
import {
  attemptMobileSettingsProfileBootstrap,
  shouldAttemptMobileSettingsProfileBootstrap,
} from "./MobileSettingsProfileBootstrap";

function createStorage(): SettingsProfilesStorage & { read: (key: string) => string | null } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    read: (key) => values.get(key) ?? null,
  };
}

const payload = captureSettingsProfile(DEFAULT_UNIFIED_SETTINGS, "dark");

describe("mobile settings profile bootstrap", () => {
  it("attempts only after settings hydrate in a narrow layout", async () => {
    const runMutation = vi.fn(async (mutation: () => "created" | "skipped") => mutation());
    const store = { seedMobileProfileOnce: vi.fn(() => "created" as const) };

    expect(
      shouldAttemptMobileSettingsProfileBootstrap({
        isNarrowLayout: true,
        settingsHydrated: true,
      }),
    ).toBe(true);
    expect(
      await attemptMobileSettingsProfileBootstrap({
        isNarrowLayout: false,
        settingsHydrated: true,
        payload,
        runMutation,
        store,
      }),
    ).toBe("skipped");
    expect(
      await attemptMobileSettingsProfileBootstrap({
        isNarrowLayout: true,
        settingsHydrated: false,
        payload,
        runMutation,
        store,
      }),
    ).toBe("skipped");
    expect(runMutation).not.toHaveBeenCalled();
    expect(store.seedMobileProfileOnce).not.toHaveBeenCalled();
  });

  it("rechecks storage inside the mutation and preserves a concurrent winner", async () => {
    const storage = createStorage();
    const store = createSettingsProfilesStore(storage, () => new Date("2026-08-01T12:00:00Z"));
    const competingStore = createSettingsProfilesStore(
      storage,
      () => new Date("2026-08-01T12:00:00Z"),
    );
    const result = await attemptMobileSettingsProfileBootstrap({
      isNarrowLayout: true,
      settingsHydrated: true,
      payload,
      store,
      runMutation: async (mutation) => {
        competingStore.create("Desktop", payload);
        return mutation();
      },
    });

    expect(result).toBe("skipped");
    expect(store.getSnapshot().profiles.map(({ name }) => name)).toEqual(["Desktop"]);
    expect(storage.read(MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_KEY)).toBe(
      MOBILE_SETTINGS_PROFILE_BOOTSTRAP_MARKER_VALUE,
    );

    storage.setItem(SETTINGS_PROFILES_STORAGE_KEY, JSON.stringify({ version: 2, profiles: [] }));
    const reloaded = createSettingsProfilesStore(storage, () => new Date("2026-08-01T12:01:00Z"));
    expect(reloaded.seedMobileProfileOnce("Mobile Profile", payload)).toBe("skipped");
    expect(JSON.parse(storage.read(SETTINGS_PROFILES_STORAGE_KEY) ?? "null").profiles).toEqual([]);
  });

  it("contains storage failures without applying or retrying settings", async () => {
    const error = new Error("quota");
    const reportError = vi.fn();
    const seedMobileProfileOnce = vi.fn(() => {
      throw error;
    });

    await expect(
      attemptMobileSettingsProfileBootstrap({
        isNarrowLayout: true,
        settingsHydrated: true,
        payload,
        store: { seedMobileProfileOnce },
        runMutation: async (mutation) => mutation(),
        reportError,
      }),
    ).resolves.toBe("failed");
    expect(seedMobileProfileOnce).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith("[SETTINGS_PROFILES] mobile bootstrap failed", error);
  });

  it("captures a passive profile without activating media", async () => {
    const storage = createStorage();
    const store = createSettingsProfilesStore(storage, () => new Date("2026-08-01T12:00:00Z"));
    const activeSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      ambientVideoEnabled: true,
      ambientImageEnabled: true,
      ambientImageCycleEnabled: true,
    };

    expect(
      await attemptMobileSettingsProfileBootstrap({
        isNarrowLayout: true,
        settingsHydrated: true,
        payload: captureSettingsProfile(activeSettings, "system"),
        store,
        runMutation: async (mutation) => mutation(),
      }),
    ).toBe("created");

    const document = JSON.parse(storage.read(SETTINGS_PROFILES_STORAGE_KEY) ?? "null") as {
      profiles: Array<{ clientSettings: Record<string, unknown> }>;
    };
    expect(document.profiles).toHaveLength(1);
    expect(document.profiles[0]?.clientSettings).not.toHaveProperty("ambientVideoEnabled");
    expect(document.profiles[0]?.clientSettings).not.toHaveProperty("ambientImageEnabled");
    expect(document.profiles[0]?.clientSettings).not.toHaveProperty("ambientImageCycleEnabled");
  });
});
