import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@cafecode/contracts/settings";
import { resolveUiLocale, setUiLocale, subscribeUiLocale } from "@cafecode/shared/i18n";
import { readBrowserClientSettings } from "./clientPersistenceStorage";
import {
  replaceClientSettingsSnapshot,
  setClientSettingsHydrated,
} from "./hooks/clientSettingsState";
import { initializeUiLocale } from "./i18n";

/** Read only the existing public client preference. The restricted recording
 * renderer must never import the app graph or call the ordinary settings IPC;
 * its exact main-owned preload supplies only validated locale metadata/events.
 * Hydration precedes route imports so module-level fallback/error copy does
 * not briefly select another language or overwrite explicit English. */
export async function initializeApplicationLanguage(
  document: Document,
  restrictedRecordingOverlay = false,
): Promise<() => void> {
  const bridge = window.desktopBridge;
  const systemLanguages = bridge?.systemUiLocale
    ? [bridge.systemUiLocale]
    : navigator.languages?.length
      ? navigator.languages
      : [navigator.language];
  setUiLocale(resolveUiLocale(bridge?.initialUiLocale ?? "system", systemLanguages));
  initializeUiLocale(document);
  const unsubscribeLocale = subscribeUiLocale(() => initializeUiLocale(document));
  const unsubscribeNative = bridge?.onUiLocaleChanged?.((locale) => {
    // Main validates the finite enum before IPC; resolve again at the display
    // boundary so malformed mock/legacy preload data cannot load a catalog.
    setUiLocale(resolveUiLocale(locale, []));
  });
  const dispose = () => {
    unsubscribeLocale();
    unsubscribeNative?.();
  };
  if (restrictedRecordingOverlay) return dispose;

  // Main already resolved its existing saved preference before constructing
  // the window. Do not add an IPC/file-read wait to desktop first paint; the
  // ordinary existing settings hydration/authoritative stream still follows.
  if (bridge?.initialUiLocale) return dispose;

  let persisted: ClientSettings | null = null;
  try {
    persisted = bridge ? await bridge.getClientSettings() : readBrowserClientSettings();
  } catch {
    // Preference availability is not provider/session authority. Keep the
    // trusted main-selected/default language and expose no stored contents.
  }
  if (persisted) {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, ...persisted };
    replaceClientSettingsSnapshot(settings);
    setUiLocale(resolveUiLocale(settings.languagePreference, systemLanguages));
  }
  setClientSettingsHydrated(true);
  initializeUiLocale(document);
  return dispose;
}
