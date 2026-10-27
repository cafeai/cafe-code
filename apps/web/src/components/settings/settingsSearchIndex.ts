import { uiText, type UiLocale } from "@cafecode/shared/i18n";

import type { SettingsSearchEntry } from "./settingsSearchMatching";

/**
 * Finite index for the Settings sidebar search.
 *
 * Each `id` matches a `searchId` on the row, section or card that renders the
 * setting, so opening a result can scroll to it. Titles and section names
 * reuse the exact copy shown on the page. Keywords are short comma-separated
 * synonyms in the `settings search keywords` context; translators may use
 * either "," or "、" between them.
 *
 * When you add a Settings row worth finding, add an entry here and pass the
 * same id as its `searchId`. A missing anchor still navigates to the page.
 */

export interface SettingsSearchAvailability {
  /** Electron preload with the power-save blocker API (Keep awake). */
  readonly keepAwake: boolean;
  /** Any desktop bridge (HTTPS listener controls). */
  readonly desktop: boolean;
  /** Mac desktop app (global dictation). */
  readonly macDesktop: boolean;
}

interface IndexedEntry extends SettingsSearchEntry {
  readonly available?: (availability: SettingsSearchAvailability) => boolean;
}

const section = {
  languageTime: (locale: UiLocale) => uiText("Language & time", undefined, undefined, locale),
  projects: (locale: UiLocale) => uiText("Projects & workspaces", undefined, undefined, locale),
  dataProfile: (locale: UiLocale) => uiText("Data profile", undefined, undefined, locale),
  files: (locale: UiLocale) => uiText("Files", undefined, undefined, locale),
  desktop: (locale: UiLocale) => uiText("Desktop", undefined, undefined, locale),
  about: (locale: UiLocale) => uiText("About", undefined, undefined, locale),
  interface: (locale: UiLocale) => uiText("Interface", undefined, undefined, locale),
  sidebar: (locale: UiLocale) => uiText("Sidebar", undefined, undefined, locale),
  motion: (locale: UiLocale) => uiText("Motion", undefined, undefined, locale),
  weather: (locale: UiLocale) => uiText("Weather effects", undefined, undefined, locale),
  atrium: (locale: UiLocale) => uiText("Task Atrium", undefined, undefined, locale),
  navigation: (locale: UiLocale) => uiText("Navigation", undefined, undefined, locale),
  replies: (locale: UiLocale) => uiText("Replies", undefined, undefined, locale),
  confirmations: (locale: UiLocale) => uiText("Confirmations", undefined, undefined, locale),
  aiDefaults: (locale: UiLocale) => uiText("AI defaults", undefined, undefined, locale),
  cafeManagement: (locale: UiLocale) => uiText("Cafe management", undefined, undefined, locale),
  globalDictation: (locale: UiLocale) => uiText("Global dictation", undefined, undefined, locale),
  localServer: (locale: UiLocale) => uiText("Local server", undefined, undefined, locale),
  dataCollection: (locale: UiLocale) => uiText("Data collection", undefined, undefined, locale),
  history: (locale: UiLocale) => uiText("History", undefined, undefined, locale),
} as const;

const SETTINGS_SEARCH_INDEX: readonly IndexedEntry[] = [
  // General
  {
    id: "page:general",
    path: "/settings/general",
    kind: "page",
    title: (locale) => uiText("General", undefined, undefined, locale),
  },
  {
    id: "general.language",
    path: "/settings/general",
    kind: "setting",
    title: (locale) => uiText("Language", undefined, undefined, locale),
    section: section.languageTime,
    keywords: (locale) =>
      uiText(
        "interface language, translation, Japanese, Korean, English",
        undefined,
        "settings search keywords",
        locale,
      ),
  },
  {
    id: "general.timeFormat",
    path: "/settings/general",
    kind: "setting",
    title: (locale) => uiText("Time format", undefined, undefined, locale),
    section: section.languageTime,
    keywords: (locale) =>
      uiText("clock, timestamp, 12-hour, 24-hour", undefined, "settings search keywords", locale),
  },
  {
    id: "general.defaultProjectFolder",
    path: "/settings/general",
    kind: "setting",
    title: (locale) => uiText("Default project folder", undefined, undefined, locale),
    section: section.projects,
    keywords: (locale) =>
      uiText("directory, path, workspace", undefined, "settings search keywords", locale),
  },
  {
    id: "general.newChats",
    path: "/settings/general",
    kind: "setting",
    title: (locale) => uiText("New chats", undefined, undefined, locale),
    section: section.projects,
    keywords: (locale) =>
      uiText("worktree, local, default workspace", undefined, "settings search keywords", locale),
  },
  {
    id: "general.activeEnvironment",
    path: "/settings/general",
    kind: "setting",
    title: (locale) => uiText("Active environment", undefined, undefined, locale),
    section: section.dataProfile,
    keywords: (locale) =>
      uiText("debug, production, profile", undefined, "settings search keywords", locale),
  },
  {
    id: "general.dataDirectory",
    path: "/settings/general",
    kind: "setting",
    title: (locale) => uiText("Data directory", undefined, undefined, locale),
    section: section.dataProfile,
    keywords: (locale) =>
      uiText("database, storage, folder, path", undefined, "settings search keywords", locale),
  },
  {
    id: "general.defaultEditor",
    path: "/settings/general",
    kind: "setting",
    title: (locale) => uiText("Default editor", undefined, undefined, locale),
    section: section.files,
    keywords: (locale) =>
      uiText("VS Code, IDE, open files, file links", undefined, "settings search keywords", locale),
  },
  {
    id: "general.keepAwake",
    path: "/settings/general",
    kind: "setting",
    title: (locale) => uiText("Keep awake", undefined, undefined, locale),
    section: section.desktop,
    keywords: (locale) =>
      uiText("sleep, power, screen, caffeinate", undefined, "settings search keywords", locale),
    available: (availability) => availability.keepAwake,
  },
  {
    id: "general.version",
    path: "/settings/general",
    kind: "setting",
    title: (locale) => uiText("Version", undefined, undefined, locale),
    section: section.about,
    keywords: (locale) =>
      uiText("update, about, release, build", undefined, "settings search keywords", locale),
  },

  // Appearance (including the former Ambiance page)
  {
    id: "page:appearance",
    path: "/settings/appearance",
    kind: "page",
    title: (locale) => uiText("Appearance", undefined, undefined, locale),
  },
  {
    id: "appearance.theme",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Theme", undefined, undefined, locale),
    section: section.interface,
    keywords: (locale) =>
      uiText(
        "dark mode, light mode, color scheme, night",
        undefined,
        "settings search keywords",
        locale,
      ),
  },
  {
    id: "appearance.interfaceSize",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Interface size", undefined, undefined, locale),
    section: section.interface,
    keywords: (locale) =>
      uiText("zoom, font size, text size, scale", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.accentColor",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Accent color", undefined, undefined, locale),
    section: section.interface,
    keywords: (locale) =>
      uiText("colour, highlight, tint", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.brandingPrefix",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Branding prefix", undefined, undefined, locale),
    section: section.sidebar,
    keywords: (locale) =>
      uiText("name, wordmark, logo", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.sidebarEffectsColor",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Sidebar effects color", undefined, undefined, locale),
    section: section.sidebar,
    keywords: (locale) =>
      uiText("colour, stars, glow", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.sidebarSearch",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Sidebar search", undefined, undefined, locale),
    section: section.sidebar,
    keywords: (locale) =>
      uiText("command palette, search button", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.sidebarImageEnabled",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Enable sidebar image", undefined, undefined, locale),
    section: section.sidebar,
    keywords: (locale) =>
      uiText("background, wallpaper, picture", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.sidebarImage",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Sidebar image", undefined, undefined, locale),
    section: section.sidebar,
    keywords: (locale) =>
      uiText("background, wallpaper, picture", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.sidebarAttribution",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Sidebar attribution", undefined, undefined, locale),
    section: section.sidebar,
    keywords: (locale) => uiText("credit, artist", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.animateWhileUnfocused",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Animate while unfocused", undefined, undefined, locale),
    section: section.motion,
    keywords: (locale) =>
      uiText("background animation, pause, battery", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.sidebarStarSpeed",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Sidebar star speed", undefined, undefined, locale),
    section: section.motion,
    keywords: (locale) =>
      uiText("stars, animation speed", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.weatherLayer",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Weather layer", undefined, undefined, locale),
    section: section.weather,
    keywords: (locale) =>
      uiText("ambiance, rain, snow, effects", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.weatherEffect",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Effect", undefined, undefined, locale),
    section: section.weather,
    keywords: (locale) =>
      uiText("ambiance, rain, snow, aurora", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.weatherIntensity",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Intensity", undefined, undefined, locale),
    section: section.weather,
    keywords: (locale) => uiText("ambiance, amount", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.weatherOpacity",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Opacity", undefined, undefined, locale),
    section: section.weather,
    keywords: (locale) =>
      uiText("ambiance, transparency", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.weatherReact",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("React to chat", undefined, undefined, locale),
    section: section.weather,
    keywords: (locale) =>
      uiText("ambiance, activity", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.weatherSurfaces",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Surfaces", undefined, undefined, locale),
    section: section.weather,
    keywords: (locale) =>
      uiText("ambiance, sidebar, composer", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.weatherColor",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Weather color", undefined, undefined, locale),
    section: section.weather,
    keywords: (locale) => uiText("ambiance, colour", undefined, "settings search keywords", locale),
  },
  {
    id: "appearance.atriumColor",
    path: "/settings/appearance",
    kind: "setting",
    title: (locale) => uiText("Atrium color", undefined, undefined, locale),
    section: section.atrium,
    keywords: (locale) => uiText("colour, tasks", undefined, "settings search keywords", locale),
  },

  // Chats
  {
    id: "page:chats",
    path: "/settings/chat-threads",
    kind: "page",
    title: (locale) => uiText("Chats", undefined, undefined, locale),
  },
  {
    id: "chats.taskAtrium",
    path: "/settings/chat-threads",
    kind: "setting",
    title: (locale) => uiText("Task Atrium", undefined, undefined, locale),
    section: section.navigation,
    keywords: (locale) =>
      uiText("tasks, agents, overview", undefined, "settings search keywords", locale),
  },
  {
    id: "chats.clickBehavior",
    path: "/settings/chat-threads",
    kind: "setting",
    title: (locale) => uiText("Clicking a chat", undefined, undefined, locale),
    section: section.navigation,
    keywords: (locale) =>
      uiText(
        "preview, open, single click, double click",
        undefined,
        "settings search keywords",
        locale,
      ),
  },
  {
    id: "chats.tabs",
    path: "/settings/chat-threads",
    kind: "setting",
    title: (locale) => uiText("Chat tabs", undefined, undefined, locale),
    section: section.navigation,
    keywords: (locale) =>
      uiText("tabs, tab bar, desk", undefined, "settings search keywords", locale),
  },
  {
    id: "chats.assistantOutput",
    path: "/settings/chat-threads",
    kind: "setting",
    title: (locale) => uiText("Assistant output", undefined, undefined, locale),
    section: section.replies,
    keywords: (locale) =>
      uiText("streaming, live replies", undefined, "settings search keywords", locale),
  },
  {
    id: "chats.autoOpenPlan",
    path: "/settings/chat-threads",
    kind: "setting",
    title: (locale) => uiText("Auto-open plan panel", undefined, undefined, locale),
    section: section.replies,
    keywords: (locale) => uiText("plan, side panel", undefined, "settings search keywords", locale),
  },
  {
    id: "chats.selectionCopy",
    path: "/settings/chat-threads",
    kind: "setting",
    title: (locale) => uiText("Chat selection copy", undefined, undefined, locale),
    section: section.replies,
    keywords: (locale) =>
      uiText(
        "copy, Markdown, plain text, clipboard",
        undefined,
        "settings search keywords",
        locale,
      ),
  },
  {
    id: "chats.customInstructions",
    path: "/settings/chat-threads",
    kind: "setting",
    title: (locale) => uiText("Custom instructions", undefined, undefined, locale),
    section: section.replies,
    keywords: (locale) =>
      uiText("system prompt, instructions, prompt", undefined, "settings search keywords", locale),
  },
  {
    id: "chats.archiveConfirmation",
    path: "/settings/chat-threads",
    kind: "setting",
    title: (locale) => uiText("Archive confirmation", undefined, undefined, locale),
    section: section.confirmations,
    keywords: (locale) => uiText("confirm, dialog", undefined, "settings search keywords", locale),
  },
  {
    id: "chats.deleteConfirmation",
    path: "/settings/chat-threads",
    kind: "setting",
    title: (locale) => uiText("Delete confirmation", undefined, undefined, locale),
    section: section.confirmations,
    keywords: (locale) => uiText("confirm, dialog", undefined, "settings search keywords", locale),
  },

  // Notifications and keybindings
  {
    id: "page:notifications",
    path: "/settings/notifications",
    kind: "page",
    title: (locale) => uiText("Notifications", undefined, undefined, locale),
  },
  {
    id: "notifications.chatCompletion",
    path: "/settings/notifications",
    kind: "setting",
    title: (locale) => uiText("Chat completion notifications", undefined, undefined, locale),
    keywords: (locale) =>
      uiText(
        "alert, desktop notification, push, done",
        undefined,
        "settings search keywords",
        locale,
      ),
  },
  {
    id: "notifications.userInput",
    path: "/settings/notifications",
    kind: "setting",
    title: (locale) => uiText("User input notifications", undefined, undefined, locale),
    keywords: (locale) =>
      uiText(
        "alert, desktop notification, push, question, response",
        undefined,
        "settings search keywords",
        locale,
      ),
  },
  {
    id: "page:keybindings",
    path: "/settings/keybindings",
    kind: "page",
    title: (locale) => uiText("Keybindings", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("shortcuts, hotkeys, keyboard", undefined, "settings search keywords", locale),
  },

  // Providers (accounts are added from the live provider list)
  {
    id: "page:providers",
    path: "/settings/providers",
    kind: "page",
    title: (locale) => uiText("Providers", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("accounts, models, AI", undefined, "settings search keywords", locale),
  },
  {
    id: "providers.namingModel",
    path: "/settings/providers",
    kind: "setting",
    title: (locale) => uiText("Automatic naming model", undefined, undefined, locale),
    section: section.aiDefaults,
    keywords: (locale) =>
      uiText(
        "chat title, branch name, text generation",
        undefined,
        "settings search keywords",
        locale,
      ),
  },
  {
    id: "providers.accounts",
    path: "/settings/providers",
    kind: "setting",
    title: (locale) => uiText("Add provider instance", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("new account, add account", undefined, "settings search keywords", locale),
  },

  // Cafe tools
  {
    id: "page:mcp",
    path: "/settings/mcp",
    kind: "page",
    title: (locale) => uiText("Cafe tools", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("MCP, management tools", undefined, "settings search keywords", locale),
  },
  {
    id: "mcp.managementTools",
    path: "/settings/mcp",
    kind: "setting",
    title: (locale) => uiText("Enable Cafe management tools", undefined, undefined, locale),
    section: section.cafeManagement,
    keywords: (locale) => uiText("MCP, automation", undefined, "settings search keywords", locale),
  },

  // Dictation
  {
    id: "page:dictation",
    path: "/settings/dictation",
    kind: "page",
    title: (locale) => uiText("Dictation", undefined, undefined, locale),
    keywords: (locale) =>
      uiText(
        "voice, speech, transcription, microphone",
        undefined,
        "settings search keywords",
        locale,
      ),
  },
  {
    id: "dictation.apiKey",
    path: "/settings/dictation",
    kind: "setting",
    title: (locale) => uiText("OpenAI API key", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("realtime, transcription", undefined, "settings search keywords", locale),
  },
  {
    id: "dictation.global",
    path: "/settings/dictation",
    kind: "setting",
    title: (locale) => uiText("Global dictation", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("any app, system-wide, voice", undefined, "settings search keywords", locale),
    available: (availability) => availability.macDesktop,
  },
  {
    id: "dictation.shortcut",
    path: "/settings/dictation",
    kind: "setting",
    title: (locale) => uiText("Shortcut", undefined, undefined, locale),
    section: section.globalDictation,
    keywords: (locale) => uiText("hotkey, keyboard", undefined, "settings search keywords", locale),
    available: (availability) => availability.macDesktop,
  },

  // Source control
  {
    id: "page:sourceControl",
    path: "/settings/source-control",
    kind: "page",
    title: (locale) => uiText("Source control", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("git, GitHub, GitLab", undefined, "settings search keywords", locale),
  },
  {
    id: "sourceControl.versionControl",
    path: "/settings/source-control",
    kind: "setting",
    title: (locale) => uiText("Version control", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("git, fetch interval", undefined, "settings search keywords", locale),
  },
  {
    id: "sourceControl.providers",
    path: "/settings/source-control",
    kind: "setting",
    title: (locale) => uiText("Source control providers", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("GitHub, GitLab, Bitbucket, CLI", undefined, "settings search keywords", locale),
  },

  // Connections & remote access
  {
    id: "page:connections",
    path: "/settings/connections",
    kind: "page",
    title: (locale) => uiText("Connections & remote access", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("remote, server, pairing", undefined, "settings search keywords", locale),
  },
  {
    id: "connections.savedEnvironments",
    path: "/settings/connections",
    kind: "setting",
    title: (locale) => uiText("Saved environments", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("remote server, connect, pairing code", undefined, "settings search keywords", locale),
  },
  {
    id: "connections.networkAccess",
    path: "/settings/connections",
    kind: "setting",
    title: (locale) => uiText("Network access", undefined, undefined, locale),
    section: section.localServer,
    keywords: (locale) =>
      uiText("LAN, remote access, port", undefined, "settings search keywords", locale),
  },
  {
    id: "connections.https",
    path: "/settings/connections",
    kind: "setting",
    title: (locale) => uiText("HTTPS", undefined, undefined, locale),
    section: section.localServer,
    keywords: (locale) =>
      uiText("TLS, SSL, certificate", undefined, "settings search keywords", locale),
    available: (availability) => availability.desktop,
  },
  {
    id: "connections.adminPassword",
    path: "/settings/connections",
    kind: "setting",
    title: (locale) => uiText("Admin password", undefined, undefined, locale),
    section: section.localServer,
    keywords: (locale) =>
      uiText("password, sign in", undefined, "settings search keywords", locale),
  },
  {
    id: "connections.twoFactor",
    path: "/settings/connections",
    kind: "setting",
    title: (locale) => uiText("Two-factor authentication", undefined, undefined, locale),
    section: section.localServer,
    keywords: (locale) =>
      uiText("2FA, TOTP, authenticator, MFA", undefined, "settings search keywords", locale),
  },
  {
    id: "connections.pairedDevices",
    path: "/settings/connections",
    kind: "setting",
    title: (locale) => uiText("Paired devices", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("pairing, devices, sessions", undefined, "settings search keywords", locale),
  },

  // Usage
  {
    id: "page:usage",
    path: "/settings/stats",
    kind: "page",
    title: (locale) => uiText("Usage", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("tokens, cost, statistics, spend", undefined, "settings search keywords", locale),
  },
  {
    id: "usage.cost",
    path: "/settings/stats",
    kind: "setting",
    title: (locale) => uiText("Cost (USD)", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("price, spend, money", undefined, "settings search keywords", locale),
  },
  {
    id: "usage.activity",
    path: "/settings/stats",
    kind: "setting",
    title: (locale) => uiText("Activity", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("history, calendar", undefined, "settings search keywords", locale),
  },
  {
    id: "usage.collect",
    path: "/settings/stats",
    kind: "setting",
    title: (locale) => uiText("Collect usage statistics", undefined, undefined, locale),
    section: section.dataCollection,
    keywords: (locale) =>
      uiText("privacy, tracking", undefined, "settings search keywords", locale),
  },

  // History
  {
    id: "page:archived",
    path: "/settings/archived",
    kind: "page",
    title: (locale) => uiText("Archive", undefined, undefined, locale),
    section: section.history,
    keywords: (locale) =>
      uiText("archived chats, unarchive", undefined, "settings search keywords", locale),
  },
  {
    id: "page:recentlyDeleted",
    path: "/settings/recently-deleted",
    kind: "page",
    title: (locale) => uiText("Recently deleted", undefined, undefined, locale),
    section: section.history,
    keywords: (locale) =>
      uiText("trash, recycle bin, restore", undefined, "settings search keywords", locale),
  },

  // Diagnostics
  {
    id: "page:diagnostics",
    path: "/settings/diagnostics",
    kind: "page",
    title: (locale) => uiText("Diagnostics", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("logs, debug, processes, health", undefined, "settings search keywords", locale),
  },
  {
    id: "diagnostics.runtimeOverview",
    path: "/settings/diagnostics",
    kind: "setting",
    title: (locale) => uiText("Runtime overview", undefined, undefined, locale),
    keywords: (locale) => uiText("status, health", undefined, "settings search keywords", locale),
  },
  {
    id: "diagnostics.providerDaemon",
    path: "/settings/diagnostics",
    kind: "setting",
    title: (locale) => uiText("Provider daemon", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("sessions, runtime", undefined, "settings search keywords", locale),
  },
  {
    id: "diagnostics.liveProcesses",
    path: "/settings/diagnostics",
    kind: "setting",
    title: (locale) => uiText("Live processes", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("CPU, memory, kill", undefined, "settings search keywords", locale),
  },
  {
    id: "diagnostics.resourceHistory",
    path: "/settings/diagnostics",
    kind: "setting",
    title: (locale) => uiText("Resource history", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("CPU, memory, chart", undefined, "settings search keywords", locale),
  },
  {
    id: "diagnostics.traces",
    path: "/settings/diagnostics",
    kind: "setting",
    title: (locale) => uiText("Traces", undefined, undefined, locale),
    keywords: (locale) =>
      uiText("tracing, spans, OpenTelemetry", undefined, "settings search keywords", locale),
  },
  {
    id: "diagnostics.latestFailures",
    path: "/settings/diagnostics",
    kind: "setting",
    title: (locale) => uiText("Latest failures", undefined, undefined, locale),
    keywords: (locale) => uiText("errors, crashes", undefined, "settings search keywords", locale),
  },
];

export function settingsSearchStaticEntries(
  availability: SettingsSearchAvailability,
): readonly SettingsSearchEntry[] {
  return SETTINGS_SEARCH_INDEX.filter((entry) => entry.available?.(availability) ?? true);
}

export interface SettingsSearchProviderAccount {
  readonly instanceId: string;
  /** User-chosen account name, or the driver label for an unnamed account. */
  readonly name: string;
  /** Product name of the provider driver, e.g. Codex. Not translated. */
  readonly driverLabel: string;
}

/** Provider accounts are searchable by their (untranslated) name and driver. */
export function settingsSearchProviderEntries(
  accounts: readonly SettingsSearchProviderAccount[],
): readonly SettingsSearchEntry[] {
  return accounts.map((account) => ({
    id: settingsSearchProviderAnchorId(account.instanceId),
    path: "/settings/providers",
    kind: "setting",
    title: () => account.name,
    section:
      account.name === account.driverLabel
        ? (locale: UiLocale) => uiText("Account", undefined, undefined, locale)
        : () => account.driverLabel,
    keywords: () => account.driverLabel,
  }));
}

export function settingsSearchProviderAnchorId(instanceId: string): string {
  return `provider:${instanceId}`;
}
