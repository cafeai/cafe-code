import { DEFAULT_CLIENT_SETTINGS } from "@cafecode/contracts/settings";
import { afterEach, describe, expect, it, vi } from "vitest";

function createStorageStub(): Storage {
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

async function loadStorageModule() {
  const localStorage = createStorageStub();
  const sessionStorage = createStorageStub();
  vi.stubGlobal("window", {
    localStorage,
    sessionStorage,
  });
  vi.resetModules();
  const storage = await import("./clientPersistenceStorage");
  return { storage, localStorage, sessionStorage };
}

describe("clientPersistenceStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("removes saved environment registry and secret keys idempotently", async () => {
    const { storage, localStorage, sessionStorage } = await loadStorageModule();
    localStorage.setItem(
      storage.SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      [
        "{",
        '  "version": 1,',
        '  "records": [{ "environmentId": "environment-1", "bearerToken": "legacy-token" }]',
        "}",
      ].join("\n"),
    );
    localStorage.setItem(storage.LEGACY_SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY, "{malformed-json");
    sessionStorage.setItem(
      storage.SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY,
      '{ "version": 1, "secrets": { "environment-1": "bearer-token" } }',
    );

    storage.clearBrowserSavedEnvironmentPersistence();
    storage.clearBrowserSavedEnvironmentPersistence();

    expect(localStorage.getItem(storage.SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(storage.LEGACY_SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)).toBeNull();
    expect(
      sessionStorage.getItem(storage.SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY),
    ).toBeNull();
  });

  it("cleans legacy saved environments during client settings reads and writes", async () => {
    const { storage, localStorage, sessionStorage } = await loadStorageModule();
    localStorage.setItem(
      storage.SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      '{ "records": [{ "bearerToken": "legacy-token" }] }',
    );
    sessionStorage.setItem(
      storage.SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY,
      '{ "secrets": { "environment-1": "bearer-token" } }',
    );

    expect(storage.readBrowserClientSettings()).toBeNull();
    expect(localStorage.getItem(storage.SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)).toBeNull();
    expect(
      sessionStorage.getItem(storage.SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY),
    ).toBeNull();

    localStorage.setItem(storage.SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY, "{malformed-json");
    sessionStorage.setItem(
      storage.SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY,
      "{malformed-json",
    );

    storage.writeBrowserClientSettings(DEFAULT_CLIENT_SETTINGS);

    expect(localStorage.getItem(storage.CLIENT_SETTINGS_STORAGE_KEY)).not.toBeNull();
    expect(localStorage.getItem(storage.SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)).toBeNull();
    expect(
      sessionStorage.getItem(storage.SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY),
    ).toBeNull();
  });
});
