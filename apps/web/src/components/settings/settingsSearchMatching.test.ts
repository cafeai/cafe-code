import { describe, expect, it } from "vitest";

import {
  foldSettingsSearchText,
  searchSettings,
  SETTINGS_SEARCH_RESULT_LIMIT,
  tokenizeSettingsSearchQuery,
  type SettingsSearchEntry,
  type SettingsSearchNavItem,
} from "./settingsSearchMatching";
import {
  settingsSearchProviderEntries,
  settingsSearchStaticEntries,
  type SettingsSearchAvailability,
} from "./settingsSearchIndex";

const NAV_ITEMS: readonly SettingsSearchNavItem[] = [
  { to: "/settings/general", activePaths: ["/settings/files", "/settings/system"] },
  { to: "/settings/appearance", activePaths: ["/settings/ambiance"] },
  { to: "/settings/chat-threads" },
  { to: "/settings/notifications" },
  { to: "/settings/keybindings" },
  { to: "/settings/providers" },
  { to: "/settings/mcp" },
  { to: "/settings/dictation" },
  { to: "/settings/source-control" },
  { to: "/settings/connections" },
  { to: "/settings/stats" },
  { to: "/settings/archived", activePaths: ["/settings/recently-deleted"] },
  { to: "/settings/diagnostics" },
];

const ALL_AVAILABLE: SettingsSearchAvailability = {
  keepAwake: true,
  desktop: true,
  macDesktop: true,
};

const ENTRIES = [
  ...settingsSearchStaticEntries(ALL_AVAILABLE),
  ...settingsSearchProviderEntries([
    { instanceId: "codex", name: "Codex", driverLabel: "Codex" },
    { instanceId: "codex_astrea", name: "Astrea", driverLabel: "Codex" },
    { instanceId: "claudeAgent", name: "Claude", driverLabel: "Claude" },
  ]),
];

function search(query: string, locale: "en" | "ja" | "ko" = "en", entries = ENTRIES) {
  return searchSettings({ entries, query, locale, navItems: NAV_ITEMS });
}

function ids(query: string, locale: "en" | "ja" | "ko" = "en") {
  return search(query, locale).flatMap((group) => group.results.map((result) => result.entry.id));
}

describe("settings search text folding", () => {
  it("ignores case, full width and Latin accents", () => {
    expect(foldSettingsSearchText("Ｃｏｌｏｒ").text).toBe("color");
    expect(foldSettingsSearchText("Café THEME").text).toBe("cafe theme");
    expect(tokenizeSettingsSearchQuery("  Dark   MODE dark ")).toEqual(["dark", "mode"]);
  });

  it("keeps Japanese voiced marks distinct", () => {
    expect(foldSettingsSearchText("ガ").text).not.toBe(foldSettingsSearchText("カ").text);
  });
});

describe("settings search ranking", () => {
  it("returns nothing for an empty or blank query", () => {
    expect(search("")).toEqual([]);
    expect(search("   ")).toEqual([]);
  });

  it("groups title matches under the page that owns them", () => {
    const groups = search("color");
    expect(groups.map((group) => group.navPath)).toEqual(["/settings/appearance"]);
    expect(groups[0]?.results.map((result) => result.entry.id)).toEqual([
      "appearance.accentColor",
      "appearance.sidebarEffectsColor",
      "appearance.weatherColor",
      "appearance.atriumColor",
      // "color scheme" is a Theme synonym; synonyms rank below titles.
      "appearance.theme",
    ]);
    const accent = groups[0]?.results[0];
    expect(accent?.title.slice(accent.titleRanges[0]?.start, accent.titleRanges[0]?.end)).toBe(
      "color",
    );
  });

  it("finds a setting by a synonym and shows the synonym that matched", () => {
    const [result] = search("zoom")[0]?.results ?? [];
    expect(result?.entry.id).toBe("appearance.interfaceSize");
    expect(result?.titleRanges).toEqual([]);
    expect(result?.alternate).toBe("zoom");
    expect(ids("2fa")).toEqual(["connections.twoFactor"]);
  });

  it("bolds a section name only when it explains the match", () => {
    const results = search("sidebar").flatMap((group) => group.results);
    const titleMatch = results.find((result) => result.entry.id === "appearance.sidebarSearch");
    const sectionOnly = results.find((result) => result.entry.id === "appearance.brandingPrefix");
    expect(titleMatch?.titleRanges.length).toBeGreaterThan(0);
    expect(titleMatch?.sectionRanges).toEqual([]);
    expect(sectionOnly?.titleRanges).toEqual([]);
    expect(sectionOnly?.sectionRanges).toEqual([{ start: 0, end: 7 }]);
  });

  it("ranks a title match above a synonym match", () => {
    const results = ids("dark");
    expect(results[0]).toBe("appearance.theme");
    expect(ids("sidebar image").slice(0, 2)).toEqual([
      "appearance.sidebarImage",
      "appearance.sidebarImageEnabled",
    ]);
  });

  it("requires every word to match", () => {
    expect(ids("sidebar image")).not.toContain("appearance.sidebarSearch");
    expect(ids("sidebar nonexistentword")).toEqual([]);
  });

  it("puts an exact page name first", () => {
    expect(ids("providers")[0]).toBe("page:providers");
    expect(ids("diagnostics")[0]).toBe("page:diagnostics");
  });

  it("finds provider accounts by name and by driver", () => {
    expect(ids("astrea")).toEqual(["provider:codex_astrea"]);
    expect(ids("codex")).toEqual(
      expect.arrayContaining(["provider:codex", "provider:codex_astrea"]),
    );
  });

  it("searches the English names in a Japanese or Korean interface", () => {
    const [japanese] = search("theme", "ja")[0]?.results ?? [];
    expect(japanese?.entry.id).toBe("appearance.theme");
    expect(japanese?.title).not.toBe("Theme");
    expect(japanese?.alternate).toBe("Theme");
    expect(ids("theme", "ko")[0]).toBe("appearance.theme");
  });

  it("matches the localized title in a Japanese interface", () => {
    const [result] = search("テーマ", "ja")[0]?.results ?? [];
    expect(result?.entry.id).toBe("appearance.theme");
    expect(result?.titleRanges.length).toBeGreaterThan(0);
    expect(ids("ダークモード", "ja")[0]).toBe("appearance.theme");
  });

  it("bounds the number of results", () => {
    const many: SettingsSearchEntry[] = Array.from({ length: 100 }, (_, index) => ({
      id: `synthetic.${index}`,
      path: "/settings/general",
      kind: "setting",
      title: () => `Setting ${index}`,
    }));
    const results = search("setting", "en", many).flatMap((group) => group.results);
    expect(results).toHaveLength(SETTINGS_SEARCH_RESULT_LIMIT);
  });

  it("omits entries that are unavailable on this platform", () => {
    const web = settingsSearchStaticEntries({
      keepAwake: false,
      desktop: false,
      macDesktop: false,
    });
    const webIds = web.map((entry) => entry.id);
    expect(webIds).not.toContain("general.keepAwake");
    expect(webIds).not.toContain("connections.https");
    expect(webIds).not.toContain("dictation.global");
    expect(webIds).toContain("appearance.theme");
  });
});
