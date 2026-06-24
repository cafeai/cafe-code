import type {
  ServerProviderAccountRateLimitSnapshot,
  ServerProviderAccountRateLimitWindow,
  ServerProviderAccountRateLimits,
} from "@cafecode/contracts";

export interface CodexRateLimitSummaryLine {
  readonly label: string;
  readonly value: string;
  readonly text: string;
}

export interface CodexRateLimitSummary {
  readonly primary: CodexRateLimitSummaryLine | null;
  readonly secondary: CodexRateLimitSummaryLine | null;
  readonly primaryReset: string | null;
  readonly weeklyReset: string | null;
}

interface FormatOptions {
  readonly locale?: string;
  readonly timeZone?: string;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatPercentage(value: number): string {
  const rounded = Math.round(clampPercentage(value) * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function formatHours(minutes: number | null | undefined): string | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  const value = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
  return `${value} ${rounded === 1 ? "hour" : "hours"}`;
}

function formatDays(minutes: number | null | undefined): string | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  const days = minutes / 1_440;
  const rounded = Math.round(days * 10) / 10;
  const value = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
  return `${value} ${rounded === 1 ? "day" : "days"}`;
}

function formatShortDuration(minutes: number | null | undefined): string | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  if (minutes < 1_440) {
    return `${Math.round(minutes / 60)}h`;
  }
  return `${Math.round(minutes / 1_440)}d`;
}

function formatResetTime(epochSeconds: number, options: FormatOptions): string | null {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  try {
    return new Intl.DateTimeFormat(options.locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }).format(new Date(epochSeconds * 1_000));
  } catch {
    return null;
  }
}

function formatWindowLine(input: {
  readonly label: "Primary window" | "Secondary window";
  readonly durationLabel: string | null;
  readonly window: ServerProviderAccountRateLimitWindow | null | undefined;
}): CodexRateLimitSummaryLine | null {
  // Only render a usage line when we actually have a usage figure. A window with just a
  // reset time (Claude omits utilization unless you're near the limit) is surfaced through
  // its reset line (primaryReset / weeklyReset) instead — no usage line. An absent window
  // is omitted entirely.
  const usedPercent = input.window?.usedPercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return null;
  }
  const label = input.durationLabel ? `${input.label} (${input.durationLabel})` : input.label;
  const value = `${formatPercentage(100 - usedPercent)} left`;
  return {
    label,
    value,
    text: `${label}: ${value}`,
  };
}

export function selectCodexRateLimitSnapshot(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
): ServerProviderAccountRateLimitSnapshot | null {
  if (!rateLimits) return null;
  return rateLimits.rateLimitsByLimitId?.codex ?? rateLimits.rateLimits ?? null;
}

export function formatCodexRateLimitSummary(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
  options: FormatOptions = {},
): CodexRateLimitSummary | null {
  const snapshot = selectCodexRateLimitSnapshot(rateLimits);
  if (!snapshot) return null;

  const primary = formatWindowLine({
    label: "Primary window",
    durationLabel: formatHours(snapshot.primary?.windowDurationMins),
    window: snapshot.primary,
  });
  const secondary = formatWindowLine({
    label: "Secondary window",
    durationLabel: formatDays(snapshot.secondary?.windowDurationMins),
    window: snapshot.secondary,
  });
  const primaryResetAt = snapshot.primary?.resetsAt ?? null;
  const primaryResetTime = primaryResetAt ? formatResetTime(primaryResetAt, options) : null;
  const primaryResetLabel = formatShortDuration(snapshot.primary?.windowDurationMins) ?? "Primary";
  const primaryReset = primaryResetTime ? `${primaryResetLabel} reset: ${primaryResetTime}` : null;

  const weeklyResetAt = snapshot.secondary?.resetsAt ?? null;
  const weeklyReset = weeklyResetAt ? formatResetTime(weeklyResetAt, options) : null;

  if (!primary && !secondary && !primaryReset && !weeklyReset) {
    return null;
  }

  return {
    primary,
    secondary,
    primaryReset,
    weeklyReset: weeklyReset ? `Weekly reset: ${weeklyReset}` : null,
  };
}

export function formatCodexRateLimitInlineText(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
  options: FormatOptions = {},
): string | null {
  const summary = formatCodexRateLimitSummary(rateLimits, options);
  if (!summary) return null;
  const parts = [
    summary.primary?.text,
    summary.secondary?.text,
    summary.primaryReset,
    summary.weeklyReset,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}
