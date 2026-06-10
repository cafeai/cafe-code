/**
 * Unified settings hook.
 *
 * Abstracts the split between server-authoritative settings (persisted in
 * `settings.json` on the server, fetched via `server.getConfig`) and
 * client-only settings (persisted in localStorage).
 *
 * Consumers use `useSettings(selector)` to read, and `useUpdateSettings()` to
 * write. The hook transparently routes reads/writes to the correct backing
 * store.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { ServerSettings, type ServerSettingsPatch } from "@cafecode/contracts";
import {
  type ClientSettingsPatch,
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  UnifiedSettings,
} from "@cafecode/contracts/settings";
import { ensureLocalApi } from "~/localApi";
import * as Struct from "effect/Struct";
import * as Equal from "effect/Equal";
import { applyClientSettingsPatch } from "@cafecode/shared/clientSettings";
import { applyServerSettingsPatch } from "@cafecode/shared/serverSettings";
import {
  applyClientSettingsUpdated,
  applySettingsUpdated,
  getServerConfig,
  useServerConfig,
  useServerSettings,
} from "~/rpc/serverState";
import {
  __resetClientSettingsPersistenceForTests as resetClientSettingsPersistenceStateForTests,
  clearClientSettingsHydrationPromise,
  getClientSettingsHydratedSnapshot,
  getClientSettingsSnapshot,
  readClientSettingsHydrationPromise,
  replaceClientSettingsSnapshot,
  setClientSettingsHydrated,
  subscribeClientSettingsHydrationSnapshot,
  subscribeClientSettingsSnapshot,
  writeClientSettingsHydrationPromise,
} from "./clientSettingsState";

const CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE = "[CLIENT_SETTINGS]";
let clientSettingsImportAttempted = false;

function subscribeClientSettings(listener: () => void): () => void {
  const unsubscribe = subscribeClientSettingsSnapshot(listener);
  void hydrateClientSettings();
  return unsubscribe;
}

function subscribeClientSettingsHydration(listener: () => void): () => void {
  const unsubscribe = subscribeClientSettingsHydrationSnapshot(listener);
  void hydrateClientSettings();
  return unsubscribe;
}

async function hydrateClientSettings(): Promise<void> {
  if (getClientSettingsHydratedSnapshot()) {
    return;
  }
  const existingHydrationPromise = readClientSettingsHydrationPromise();
  if (existingHydrationPromise) {
    return existingHydrationPromise;
  }

  const nextHydration = (async () => {
    try {
      const persistedSettings = await ensureLocalApi().persistence.getClientSettings();
      if (persistedSettings) {
        replaceClientSettingsSnapshot({ ...DEFAULT_CLIENT_SETTINGS, ...persistedSettings });
      }
    } catch (error) {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} hydrate failed`, error);
    } finally {
      setClientSettingsHydrated(true);
    }
  })();

  const hydrationPromise = nextHydration.finally(() => {
    clearClientSettingsHydrationPromise(hydrationPromise);
  });
  writeClientSettingsHydrationPromise(hydrationPromise);

  return hydrationPromise;
}

async function maybeImportLocalClientSettingsToServer(): Promise<void> {
  if (clientSettingsImportAttempted) {
    return;
  }
  const currentServerConfig = getServerConfig();
  if (!currentServerConfig) {
    return;
  }
  clientSettingsImportAttempted = true;

  await hydrateClientSettings();
  const localSettings = getClientSettingsSnapshot();
  if (
    Equal.equals(currentServerConfig.clientSettings, DEFAULT_CLIENT_SETTINGS) &&
    !Equal.equals(localSettings, DEFAULT_CLIENT_SETTINGS)
  ) {
    applyClientSettingsUpdated(localSettings);
    await ensureLocalApi().server.updateClientSettings(localSettings);
  }
}

function persistClientSettings(settings: ClientSettings): void {
  replaceClientSettingsSnapshot(settings);
  void ensureLocalApi()
    .persistence.setClientSettings(settings)
    .catch((error) => {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} persist failed`, error);
    });
}

function reportSettingsWriteFailure(scope: "server" | "client", error: unknown): void {
  console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} ${scope} update failed`, error);
}

// ── Key sets for routing patches ─────────────────────────────────────

const SERVER_SETTINGS_KEYS = new Set<string>(Struct.keys(ServerSettings.fields));

function splitPatch(patch: Partial<UnifiedSettings>): {
  serverPatch: ServerSettingsPatch;
  clientPatch: ClientSettingsPatch;
} {
  const serverPatch: Record<string, unknown> = {};
  const clientPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SERVER_SETTINGS_KEYS.has(key)) {
      serverPatch[key] = value;
    } else {
      clientPatch[key] = value;
    }
  }
  return {
    serverPatch: serverPatch as ServerSettingsPatch,
    clientPatch: clientPatch as ClientSettingsPatch,
  };
}

// ── Hooks ────────────────────────────────────────────────────────────

/**
 * Read merged settings. Selector narrows the subscription so components
 * only re-render when the slice they care about changes.
 */

/**
 * Non-hook accessor for the current merged client settings snapshot.
 * Used by non-React code paths (e.g. runtime services) that need the latest
 * settings without subscribing.
 */
export function getClientSettings(): ClientSettings {
  return getServerConfig()?.clientSettings ?? getClientSettingsSnapshot();
}

export function useClientSettingsHydrated(): boolean {
  const serverConfig = useServerConfig();
  const localHydrated = useSyncExternalStore(
    subscribeClientSettingsHydration,
    getClientSettingsHydratedSnapshot,
    () => false,
  );
  return serverConfig !== null || localHydrated;
}

function useLocalClientSettings(): ClientSettings {
  return useSyncExternalStore(
    subscribeClientSettings,
    getClientSettingsSnapshot,
    () => DEFAULT_CLIENT_SETTINGS,
  );
}

export function useSettings<T = UnifiedSettings>(selector?: (s: UnifiedSettings) => T): T {
  const serverConfig = useServerConfig();
  const serverSettings = useServerSettings();
  const localClientSettings = useLocalClientSettings();

  useEffect(() => {
    if (serverConfig === null) {
      return;
    }
    void maybeImportLocalClientSettingsToServer().catch((error) => {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} import failed`, error);
    });
  }, [serverConfig]);

  const merged = useMemo<UnifiedSettings>(
    () => ({
      ...serverSettings,
      ...(serverConfig?.clientSettings ?? localClientSettings),
    }),
    [localClientSettings, serverConfig?.clientSettings, serverSettings],
  );

  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

/**
 * Returns an updater that routes each key to the correct backing store.
 *
 * Server keys are optimistically patched in atom-backed server state, then
 * persisted via RPC. Client keys go through client persistence.
 */
export function useUpdateSettings() {
  const updateSettings = useCallback((patch: Partial<UnifiedSettings>) => {
    const { serverPatch, clientPatch } = splitPatch(patch);

    if (Object.keys(serverPatch).length > 0) {
      const currentServerConfig = getServerConfig();
      if (currentServerConfig) {
        applySettingsUpdated(applyServerSettingsPatch(currentServerConfig.settings, serverPatch));
      }
      // Fire-and-forget RPC — push will reconcile on success
      try {
        void ensureLocalApi()
          .server.updateSettings(serverPatch)
          .catch((error) => {
            reportSettingsWriteFailure("server", error);
          });
      } catch (error) {
        reportSettingsWriteFailure("server", error);
      }
    }

    if (Object.keys(clientPatch).length > 0) {
      const currentServerConfig = getServerConfig();
      if (currentServerConfig) {
        const nextClientSettings = applyClientSettingsPatch(
          currentServerConfig.clientSettings,
          clientPatch,
        );
        applyClientSettingsUpdated(nextClientSettings);
        try {
          void ensureLocalApi()
            .server.updateClientSettings(clientPatch)
            .catch((error) => {
              reportSettingsWriteFailure("client", error);
            });
        } catch (error) {
          reportSettingsWriteFailure("client", error);
        }
      } else {
        persistClientSettings(applyClientSettingsPatch(getClientSettingsSnapshot(), clientPatch));
      }
    }
  }, []);

  const resetSettings = useCallback(() => {
    updateSettings(DEFAULT_UNIFIED_SETTINGS);
  }, [updateSettings]);

  return {
    updateSettings,
    resetSettings,
  };
}

export function __resetClientSettingsPersistenceForTests(): void {
  clientSettingsImportAttempted = false;
  resetClientSettingsPersistenceStateForTests();
}
