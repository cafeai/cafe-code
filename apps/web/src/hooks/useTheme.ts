import { useCallback, useEffect, useSyncExternalStore } from "react";

type Theme = "light" | "dark" | "system";
type ThemeSnapshot = {
  theme: Theme;
  systemDark: boolean;
};

const STORAGE_KEY = "cafe-code:theme";
const LEGACY_STORAGE_KEY = "cafecode:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: "dark",
  systemDark: false,
};
const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: Theme | null = null;

function emitChange() {
  for (const listener of listeners) listener();
}

function hasThemeStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function getSystemDark() {
  return typeof window !== "undefined" && window.matchMedia(MEDIA_QUERY).matches;
}

function getStored(): Theme {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT.theme;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacyRaw === "light" || legacyRaw === "dark" || legacyRaw === "system") {
    localStorage.setItem(STORAGE_KEY, legacyRaw);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return legacyRaw;
  }
  return DEFAULT_THEME_SNAPSHOT.theme;
}

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) {
    return element;
  }

  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);
  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }

  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

export function syncBrowserChromeTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = surfaceColor ?? fallbackColor;
  if (!backgroundColor) return;

  document.documentElement.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;
  ensureThemeColorMetaTag().setAttribute("content", backgroundColor);
}

const THEME_TRANSITION_CLASS = "theme-transition";
const THEME_TRANSITION_MS = 260;
let themeTransitionTimer: ReturnType<typeof setTimeout> | null = null;

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function applyThemeClass(theme: Theme) {
  const isDark = theme === "dark" || (theme === "system" && getSystemDark());
  document.documentElement.classList.toggle("dark", isDark);
  syncBrowserChromeTheme();
  syncDesktopTheme(theme);
}

function applyTheme(theme: Theme, animate = false) {
  if (typeof document === "undefined" || typeof window === "undefined") return;

  const root = document.documentElement;

  if (!animate || prefersReducedMotion()) {
    applyThemeClass(theme);
    return;
  }

  // Enable a brief, global color transition so light/dark swaps fade rather
  // than snap. The `.theme-transition` class (see index.css) transitions
  // color-bearing properties; we remove it once the fade settles so it never
  // affects normal interactions.
  if (themeTransitionTimer !== null) {
    clearTimeout(themeTransitionTimer);
  }
  root.classList.add(THEME_TRANSITION_CLASS);
  // Force a style flush so the transition is part of the before-change style;
  // without it the class add and color change coalesce and the fade is skipped.
  // oxlint-disable-next-line no-unused-expressions
  root.offsetWidth;
  applyThemeClass(theme);
  themeTransitionTimer = setTimeout(() => {
    root.classList.remove(THEME_TRANSITION_CLASS);
    themeTransitionTimer = null;
  }, THEME_TRANSITION_MS);
}

function syncDesktopTheme(theme: Theme) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge || lastDesktopTheme === theme) {
    return;
  }

  lastDesktopTheme = theme;
  void bridge.setTheme(theme).catch(() => {
    if (lastDesktopTheme === theme) {
      lastDesktopTheme = null;
    }
  });
}

// Apply immediately on module load to prevent flash
if (typeof document !== "undefined" && hasThemeStorage()) {
  applyTheme(getStored());
}

function getSnapshot(): ThemeSnapshot {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT;
  const theme = getStored();
  const systemDark = theme === "system" ? getSystemDark() : false;

  if (lastSnapshot && lastSnapshot.theme === theme && lastSnapshot.systemDark === systemDark) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, systemDark };
  return lastSnapshot;
}

function getServerSnapshot() {
  return DEFAULT_THEME_SNAPSHOT;
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);

  // Listen for system preference changes
  const mq = window.matchMedia(MEDIA_QUERY);
  const handleChange = () => {
    if (getStored() === "system") applyTheme("system", true);
    emitChange();
  };
  mq.addEventListener("change", handleChange);

  // Listen for storage changes from other tabs
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === LEGACY_STORAGE_KEY) {
      applyTheme(getStored(), true);
      emitChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    mq.removeEventListener("change", handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const theme = snapshot.theme;

  const resolvedTheme: "light" | "dark" =
    theme === "system" ? (snapshot.systemDark ? "dark" : "light") : theme;

  const setTheme = useCallback((next: Theme) => {
    if (!hasThemeStorage()) return;
    localStorage.setItem(STORAGE_KEY, next);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    applyTheme(next, true);
    emitChange();
  }, []);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return { theme, setTheme, resolvedTheme } as const;
}
