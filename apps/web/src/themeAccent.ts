const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u;

const APP_ACCENT_VARIABLES = ["--primary", "--ring"] as const;
const SIDEBAR_ACCENT_VARIABLE = "--cafe-sidebar-accent";

export function normalizeAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function applyAppAccentColor(value: string | undefined): void {
  if (typeof document === "undefined") {
    return;
  }

  const accentColor = normalizeAccentColor(value);
  for (const variable of APP_ACCENT_VARIABLES) {
    if (accentColor) {
      document.documentElement.style.setProperty(variable, accentColor);
    } else {
      document.documentElement.style.removeProperty(variable);
    }
  }
}

export function applySidebarAccentColor(value: string | undefined): void {
  if (typeof document === "undefined") {
    return;
  }

  const accentColor = normalizeAccentColor(value);
  if (!accentColor) {
    document.documentElement.style.removeProperty(SIDEBAR_ACCENT_VARIABLE);
    return;
  }

  document.documentElement.style.setProperty(SIDEBAR_ACCENT_VARIABLE, accentColor);
}
