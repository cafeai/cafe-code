const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u;

const SIDEBAR_ACCENT_VARIABLE = "--cafe-sidebar-accent";

export function normalizeThemeAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function applyThemeAccentColor(value: string | undefined): void {
  if (typeof document === "undefined") {
    return;
  }

  const accentColor = normalizeThemeAccentColor(value);
  if (!accentColor) {
    document.documentElement.style.removeProperty(SIDEBAR_ACCENT_VARIABLE);
    return;
  }

  document.documentElement.style.setProperty(SIDEBAR_ACCENT_VARIABLE, accentColor);
}
