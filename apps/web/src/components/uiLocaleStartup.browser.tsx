import type { DesktopBridge } from "@cafecode/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@cafecode/contracts/settings";
import { getUiLocale, setUiLocale, type UiLocale } from "@cafecode/shared/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_SETTINGS_STORAGE_KEY,
  LEGACY_CLIENT_SETTINGS_STORAGE_KEY,
  readBrowserClientSettings,
  writeBrowserClientSettings,
} from "../clientPersistenceStorage";
import {
  __resetClientSettingsPersistenceForTests,
  getClientSettingsHydratedSnapshot,
  getClientSettingsSnapshot,
} from "../hooks/clientSettingsState";
import { initializeApplicationLanguage } from "../uiLocaleStartup";
import { initializeUiLocale } from "../i18n";

// Every storage/bridge/system observation below is confined to the isolated
// browser fixture. No native preload, profile, provider or application route
// is loaded. Restore exact pre-test keys rather than clearing unrelated data.
const originalBridgeDescriptor = Object.getOwnPropertyDescriptor(window, "desktopBridge");
const originalLocale = getUiLocale();
const originalLang = document.documentElement.lang;
const originalDirection = document.documentElement.dir;
const storageKeys = [CLIENT_SETTINGS_STORAGE_KEY, LEGACY_CLIENT_SETTINGS_STORAGE_KEY] as const;
const originalSettings = new Map(storageKeys.map((key) => [key, localStorage.getItem(key)]));
const disposers = new Set<() => void>();

function setBridge(bridge?: Partial<DesktopBridge>) {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    writable: true,
    value: bridge,
  });
}

function setSystemLanguages(languages: readonly string[]) {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
  vi.spyOn(navigator, "language", "get").mockReturnValue(languages[0] ?? "en");
}

function syntheticDocument() {
  const isolated = document.implementation.createHTMLDocument("Synthetic language startup");
  isolated.documentElement.lang = "ar";
  isolated.documentElement.dir = "rtl";
  return isolated;
}

function syntheticBootstrapDocument(manifestHref?: string) {
  const isolated = syntheticDocument();
  const root = isolated.createElement("div");
  root.id = "root";
  const shell = isolated.createElement("div");
  shell.id = "boot-shell";
  const card = isolated.createElement("div");
  card.id = "boot-shell-card";
  card.setAttribute("aria-label", "Original source-owned label");
  card.setAttribute("data-owned-fixture", "unchanged");
  const draft = isolated.createElement("textarea");
  draft.value = "Opaque draft: 日本語 / 한국어 / <script>inert</script>";
  card.append(draft);
  shell.append(card);
  root.append(shell);
  isolated.body.append(root);
  const unrelated = isolated.createElement("div");
  // A boot-looking ID outside the exact source-owned hierarchy must remain
  // inert. No broad text observer, replacement or received-content walk exists.
  unrelated.id = "boot-shell-card";
  unrelated.setAttribute("aria-label", "Unrelated opaque label");
  unrelated.textContent = "Received-looking prose: Cafe Code splash screen";
  isolated.body.append(unrelated);
  const manifest = manifestHref === undefined ? undefined : isolated.createElement("link");
  if (manifest) {
    manifest.rel = "manifest";
    manifest.setAttribute("href", manifestHref!);
    manifest.setAttribute("crossorigin", "use-credentials");
    manifest.setAttribute("data-owned-fixture", "unchanged");
    isolated.head.append(manifest);
  }
  return { isolated, card, draft, unrelated, manifest };
}

async function initialize(isolated: Document, restricted = false) {
  const dispose = await initializeApplicationLanguage(isolated, restricted);
  disposers.add(dispose);
  return () => {
    disposers.delete(dispose);
    dispose();
  };
}

beforeEach(() => {
  setBridge();
  for (const key of storageKeys) localStorage.removeItem(key);
  __resetClientSettingsPersistenceForTests();
  setUiLocale("en");
});

afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers.clear();
  __resetClientSettingsPersistenceForTests();
  vi.restoreAllMocks();
  if (originalBridgeDescriptor)
    Object.defineProperty(window, "desktopBridge", originalBridgeDescriptor);
  else Reflect.deleteProperty(window, "desktopBridge");
  for (const key of storageKeys) {
    const value = originalSettings.get(key);
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
  setUiLocale(originalLocale);
  document.documentElement.lang = originalLang;
  document.documentElement.dir = originalDirection;
});

describe("isolated application language startup", () => {
  it("amends only the exact inert bootstrap aria target across locale changes", () => {
    const { isolated, card, draft, unrelated } = syntheticBootstrapDocument();
    const originalDraft = draft.value;
    const originalProse = unrelated.textContent;
    for (const [locale, label] of [
      ["en", "Cafe Code splash screen"],
      ["ja", "Cafe Codeのスプラッシュ画面"],
      ["ko", "Cafe Code 시작 화면"],
      ["en", "Cafe Code splash screen"],
    ] as const) {
      setUiLocale(locale);
      initializeUiLocale(isolated);
      expect(isolated.documentElement.lang).toBe(locale);
      expect(isolated.documentElement.dir).toBe("ltr");
      expect(card.getAttribute("aria-label")).toBe(label);
      expect(card.getAttribute("data-owned-fixture")).toBe("unchanged");
      expect(card.firstChild).toBe(draft);
      expect(draft.value).toBe(originalDraft);
      expect(unrelated.getAttribute("aria-label")).toBe("Unrelated opaque label");
      expect(unrelated.textContent).toBe(originalProse);
      expect(isolated.querySelector("script")).toBeNull();
      expect(isolated.querySelector('link[rel="manifest"]')).toBeNull();
    }
  });

  it.each(["/manifest.webmanifest", "/manifest.ja.webmanifest", "/manifest.ko.webmanifest"])(
    "selects finite local manifests from admitted original %s without changing identity attributes",
    (originalHref) => {
      const { isolated, manifest } = syntheticBootstrapDocument(originalHref);
      expect(manifest).toBeDefined();
      for (const [locale, href] of [
        ["ja", "/manifest.ja.webmanifest"],
        ["ko", "/manifest.ko.webmanifest"],
        ["en", "/manifest.webmanifest"],
      ] as const) {
        setUiLocale(locale);
        initializeUiLocale(isolated);
        expect(isolated.querySelector('link[rel="manifest"]')).toBe(manifest);
        expect(manifest?.getAttribute("href")).toBe(href);
        expect(manifest?.getAttribute("crossorigin")).toBe("use-credentials");
        expect(manifest?.getAttribute("data-owned-fixture")).toBe("unchanged");
      }
    },
  );

  it.each([
    "https://example.invalid/manifest.webmanifest",
    "//example.invalid/manifest.webmanifest",
    "manifest.webmanifest",
    "/manifest.fr.webmanifest",
    "/manifest.webmanifest?opaque=1",
    "/manifest.webmanifest#opaque",
  ])("does not rewrite external or unrecognized manifest spelling %s", (originalHref) => {
    const { isolated, manifest } = syntheticBootstrapDocument(originalHref);
    for (const locale of ["ja", "ko", "en"] as const) {
      setUiLocale(locale);
      initializeUiLocale(isolated);
      expect(manifest?.getAttribute("href")).toBe(originalHref);
      expect(manifest?.getAttribute("crossorigin")).toBe("use-credentials");
      expect(manifest?.getAttribute("data-owned-fixture")).toBe("unchanged");
      expect(isolated.querySelectorAll('link[rel="manifest"]')).toHaveLength(1);
    }
  });

  it.each([
    { languages: ["ja-JP", "en-US"], expected: "ja" },
    { languages: ["ko-KR", "ja-JP"], expected: "ko" },
    { languages: ["en-US", "ja-JP", "ko-KR"], expected: "en" },
    { languages: ["fr-FR", "ko-KR"], expected: "en" },
    { languages: ["ar", "ja"], expected: "en" },
    { languages: ["not_a_locale", "ko"], expected: "en" },
    { languages: [], expected: "en" },
  ] as const)("uses only primary system language $languages", async ({ languages, expected }) => {
    setSystemLanguages(languages);
    writeBrowserClientSettings({ ...DEFAULT_CLIENT_SETTINGS, languagePreference: "system" });
    const isolated = syntheticDocument();
    await initialize(isolated);
    expect(getUiLocale()).toBe(expected);
    expect(isolated.documentElement.lang).toBe(expected);
    expect(isolated.documentElement.dir).toBe("ltr");
    expect(getClientSettingsSnapshot().languagePreference).toBe("system");
    expect(getClientSettingsHydratedSnapshot()).toBe(true);
  });

  it.each(["ja-JP", "ko-KR"])(
    "keeps explicit English persisted after restart on %s",
    async (systemLanguage) => {
      setSystemLanguages([systemLanguage]);
      writeBrowserClientSettings({ ...DEFAULT_CLIENT_SETTINGS, languagePreference: "en" });
      const savedBytes = localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
      for (let restart = 0; restart < 2; restart++) {
        __resetClientSettingsPersistenceForTests();
        setUiLocale(systemLanguage === "ja-JP" ? "ja" : "ko");
        const isolated = syntheticDocument();
        const dispose = await initialize(isolated);
        expect(getUiLocale()).toBe("en");
        expect(isolated.documentElement.lang).toBe("en");
        expect(isolated.documentElement.dir).toBe("ltr");
        expect(getClientSettingsSnapshot().languagePreference).toBe("en");
        expect(readBrowserClientSettings()?.languagePreference).toBe("en");
        expect(localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY)).toBe(savedBytes);
        dispose();
      }
    },
  );

  it.each([
    { preference: "ja", system: "ko-KR" },
    { preference: "ko", system: "en-US" },
  ] as const)(
    "gives explicit $preference precedence over $system",
    async ({ preference, system }) => {
      setSystemLanguages([system]);
      writeBrowserClientSettings({ ...DEFAULT_CLIENT_SETTINGS, languagePreference: preference });
      const isolated = syntheticDocument();
      await initialize(isolated);
      expect(isolated.documentElement.lang).toBe(preference);
      expect(isolated.documentElement.dir).toBe("ltr");
      expect(getClientSettingsSnapshot().languagePreference).toBe(preference);
    },
  );

  it.each(["en", "ja", "ko"] as const)(
    "uses main-owned initial %s without a settings IPC/read wait",
    async (initialUiLocale) => {
      setSystemLanguages(["fr-FR"]);
      const getClientSettings = vi.fn(async () => {
        throw new Error("Must not read ordinary settings");
      });
      const storageRead = vi.spyOn(Storage.prototype, "getItem");
      setBridge({ initialUiLocale, systemUiLocale: "ja", getClientSettings });
      const isolated = syntheticDocument();
      await initialize(isolated);
      expect(getUiLocale()).toBe(initialUiLocale);
      expect(isolated.documentElement.lang).toBe(initialUiLocale);
      expect(isolated.documentElement.dir).toBe("ltr");
      expect(getClientSettings).not.toHaveBeenCalled();
      expect(storageRead).not.toHaveBeenCalled();
      // Fast first paint must not falsely claim ordinary settings hydration.
      expect(getClientSettingsHydratedSnapshot()).toBe(false);
    },
  );

  it("keeps the restricted recording renderer off ordinary settings and storage", async () => {
    setSystemLanguages(["en-US"]);
    const getClientSettings = vi.fn(async () => {
      throw new Error("Ordinary bridge is prohibited");
    });
    const storageRead = vi.spyOn(Storage.prototype, "getItem");
    setBridge({ systemUiLocale: "ko", getClientSettings });
    const isolated = syntheticDocument();
    await initialize(isolated, true);
    expect(getUiLocale()).toBe("ko");
    expect(isolated.documentElement.lang).toBe("ko");
    expect(isolated.documentElement.dir).toBe("ltr");
    expect(getClientSettings).not.toHaveBeenCalled();
    expect(storageRead).not.toHaveBeenCalled();
    expect(getClientSettingsHydratedSnapshot()).toBe(false);
  });

  it("updates document metadata from the finite native event and removes both observers on disposal", async () => {
    let listener: ((locale: UiLocale) => void) | undefined;
    const unsubscribe = vi.fn(() => {
      listener = undefined;
    });
    setBridge({
      initialUiLocale: "ja",
      onUiLocaleChanged: (next) => {
        listener = next;
        return unsubscribe;
      },
    });
    const isolated = syntheticDocument();
    const dispose = await initialize(isolated);
    expect(isolated.documentElement.lang).toBe("ja");
    listener?.("ko");
    expect(getUiLocale()).toBe("ko");
    expect(isolated.documentElement.lang).toBe("ko");
    expect(isolated.documentElement.dir).toBe("ltr");
    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(listener).toBeUndefined();
    setUiLocale("en");
    expect(isolated.documentElement.lang).toBe("ko");
  });

  it.each(["__proto__", "constructor", "ar", "<script>inert</script>"])(
    "refuses malformed initial/native metadata %s",
    async (malformed) => {
      let listener: ((locale: UiLocale) => void) | undefined;
      const getClientSettings = vi.fn(async () => DEFAULT_CLIENT_SETTINGS);
      setBridge({
        initialUiLocale: malformed as UiLocale,
        systemUiLocale: "ja",
        getClientSettings,
        onUiLocaleChanged: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      });
      const isolated = syntheticDocument();
      await initialize(isolated);
      // Invalid preference metadata cannot select a catalog; the separately
      // finite trusted system language remains the initial fallback. Native
      // event metadata has no system context and falls back to English below.
      expect(getUiLocale()).toBe("ja");
      expect(isolated.documentElement.lang).toBe("ja");
      setUiLocale("ko");
      listener?.(malformed as UiLocale);
      expect(getUiLocale()).toBe("en");
      expect(isolated.documentElement.lang).toBe("en");
      expect(isolated.documentElement.dir).toBe("ltr");
      expect(isolated.querySelector("script")).toBeNull();
      expect(getClientSettings).not.toHaveBeenCalled();
    },
  );

  it("retains the safe system language and cleanup when legacy settings IPC rejects", async () => {
    const getClientSettings = vi.fn(async () => {
      throw new Error("Synthetic private storage failure");
    });
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    setBridge({ systemUiLocale: "ja", getClientSettings });
    const isolated = syntheticDocument();
    const dispose = await initialize(isolated);
    expect(getClientSettings).toHaveBeenCalledTimes(1);
    expect(getUiLocale()).toBe("ja");
    expect(isolated.documentElement.lang).toBe("ja");
    expect(isolated.documentElement.dir).toBe("ltr");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(dispose).toBeTypeOf("function");
  });

  it("refuses malformed stored language without selecting an unsupported catalog", async () => {
    setSystemLanguages(["ko-KR", "ja-JP"]);
    localStorage.setItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_CLIENT_SETTINGS, languagePreference: "__proto__" }),
    );
    const isolated = syntheticDocument();
    await initialize(isolated);
    expect(getUiLocale()).toBe("ko");
    expect(isolated.documentElement.lang).toBe("ko");
    expect(isolated.documentElement.dir).toBe("ltr");
    expect(getClientSettingsSnapshot().languagePreference).toBe("system");
  });
});
