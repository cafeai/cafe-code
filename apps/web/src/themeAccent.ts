import {
  DEFAULT_SIDEBAR_STAR_SPEED,
  MAX_SIDEBAR_STAR_SPEED,
  MIN_SIDEBAR_STAR_SPEED,
} from "@cafecode/contracts/settings";

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u;

const APP_ACCENT_VARIABLES = ["--primary", "--ring"] as const;
const SIDEBAR_ACCENT_VARIABLE = "--cafe-sidebar-accent";
const SIDEBAR_STAR_DRIFT_DURATION_VARIABLE = "--cafe-sidebar-star-drift-duration";
export const DEFAULT_SIDEBAR_STAR_DRIFT_DURATION_SECONDS = 60;

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

export function normalizeSidebarStarSpeed(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < MIN_SIDEBAR_STAR_SPEED || value > MAX_SIDEBAR_STAR_SPEED) {
    return undefined;
  }
  return value;
}

export function sidebarStarDriftDurationSeconds(value: number | undefined): number | undefined {
  const speed = normalizeSidebarStarSpeed(value);
  if (speed === undefined) {
    return undefined;
  }
  return DEFAULT_SIDEBAR_STAR_DRIFT_DURATION_SECONDS / speed;
}

export function applySidebarStarSpeed(value: number | undefined): void {
  if (typeof document === "undefined") {
    return;
  }

  const durationSeconds = sidebarStarDriftDurationSeconds(value);
  if (durationSeconds === undefined || value === DEFAULT_SIDEBAR_STAR_SPEED) {
    document.documentElement.style.removeProperty(SIDEBAR_STAR_DRIFT_DURATION_VARIABLE);
    return;
  }

  document.documentElement.style.setProperty(
    SIDEBAR_STAR_DRIFT_DURATION_VARIABLE,
    `${durationSeconds}s`,
  );
}
