import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@cafecode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const testEnvironmentId = EnvironmentId.make("environment-1");

const savedRegistryRecord: PersistedSavedEnvironmentRecord = {
  environmentId: testEnvironmentId,
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.com/",
  wsBaseUrl: "wss://remote.example.com/",
  createdAt: "2026-04-09T00:00:00.000Z",
  lastConnectedAt: null,
};

const legacySavedRegistryRecord = {
  ...savedRegistryRecord,
  bearerToken: "legacy-bearer-token",
  desktopSsh: {
    alias: "devbox",
    hostname: "devbox.example.com",
    username: "julius",
    port: 22,
  },
};

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function getTestWindow(): Window & typeof globalThis {
  const localStorage = createLocalStorageStub();
  const sessionStorage = createLocalStorageStub();
  const testWindow = {
    localStorage,
    sessionStorage,
  } as Window & typeof globalThis;
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("sessionStorage", sessionStorage);
  return testWindow;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clientPersistenceStorage", () => {
  it("migrates legacy browser client settings into the Cafe Code key", async () => {
    const testWindow = getTestWindow();
    const { DEFAULT_CLIENT_SETTINGS } = await import("@cafecode/contracts/settings");
    const {
      CLIENT_SETTINGS_STORAGE_KEY,
      LEGACY_CLIENT_SETTINGS_STORAGE_KEY,
      readBrowserClientSettings,
    } = await import("./clientPersistenceStorage");
    testWindow.localStorage.setItem(
      LEGACY_CLIENT_SETTINGS_STORAGE_KEY,
      JSON.stringify(DEFAULT_CLIENT_SETTINGS),
    );

    expect(readBrowserClientSettings()).toEqual(DEFAULT_CLIENT_SETTINGS);
    expect(testWindow.localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY)).not.toBeNull();
    expect(testWindow.localStorage.getItem(LEGACY_CLIENT_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("migrates legacy saved environments into the Cafe Code key", async () => {
    const testWindow = getTestWindow();
    const {
      LEGACY_SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      readBrowserSavedEnvironmentRegistry,
    } = await import("./clientPersistenceStorage");
    testWindow.localStorage.setItem(
      LEGACY_SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      JSON.stringify({ version: 1, records: [legacySavedRegistryRecord] }),
    );

    expect(readBrowserSavedEnvironmentRegistry()).toEqual([savedRegistryRecord]);
    expect(testWindow.localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)).not.toBeNull();
    expect(testWindow.localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)).not.toContain(
      "legacy-bearer-token",
    );
    expect(testWindow.localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)).not.toContain(
      "desktopSsh",
    );
    expect(
      testWindow.localStorage.getItem(LEGACY_SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY),
    ).toBeNull();
  });

  it("stores browser secrets in sessionStorage without writing bearer material to localStorage", async () => {
    const testWindow = getTestWindow();
    const {
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY,
      readBrowserSavedEnvironmentRegistry,
      readBrowserSavedEnvironmentSecret,
      writeBrowserSavedEnvironmentRegistry,
      writeBrowserSavedEnvironmentSecret,
    } = await import("./clientPersistenceStorage");

    writeBrowserSavedEnvironmentRegistry([savedRegistryRecord]);
    expect(writeBrowserSavedEnvironmentSecret(testEnvironmentId, "bearer-token")).toBe(true);
    writeBrowserSavedEnvironmentRegistry([savedRegistryRecord]);

    expect(readBrowserSavedEnvironmentRegistry()).toEqual([savedRegistryRecord]);
    expect(readBrowserSavedEnvironmentSecret(testEnvironmentId)).toBe("bearer-token");
    expect(
      JSON.parse(testWindow.localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)!),
    ).toEqual({
      version: 1,
      records: [savedRegistryRecord],
    });
    expect(
      JSON.parse(testWindow.sessionStorage.getItem(SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY)!),
    ).toEqual({
      version: 1,
      secrets: {
        [testEnvironmentId]: "bearer-token",
      },
    });
  });
});
