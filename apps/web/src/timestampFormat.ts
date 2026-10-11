import { type TimestampFormat } from "@cafecode/contracts/settings";
import { uiFormatDateTime, uiText } from "@cafecode/shared/i18n";

export function getTimestampFormatOptions(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormatOptions {
  const baseOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  };

  if (timestampFormat === "locale") {
    return baseOptions;
  }

  return {
    ...baseOptions,
    hour12: timestampFormat === "12-hour",
  };
}

export function formatTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  // The English UI locale must not replace the viewer's native hour cycle or
  // timezone. Explicit 12/24-hour preferences remain authoritative.
  return uiFormatDateTime(new Date(isoDate), getTimestampFormatOptions(timestampFormat, true));
}

export function formatShortTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  return uiFormatDateTime(new Date(isoDate), getTimestampFormatOptions(timestampFormat, false));
}

/** Compact display units are catalog messages, never persisted duration ids. */
function compactTime(value: number, unit: "second" | "minute" | "hour" | "day"): string {
  return uiText("{value}{unit, select, second {s} minute {m} hour {h} other {d}}", { value, unit });
}

/**
 * Format a relative time string from an ISO date.
 * Returns `{ value: "20s", suffix: "ago" }` or `{ value: "just now", suffix: null }`
 * so callers can style the numeric portion independently.
 */
export function formatRelativeTime(isoDate: string): { value: string; suffix: string | null } {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  if (diffMs < 0) return { value: uiText("just now"), suffix: null };
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return { value: uiText("just now"), suffix: null };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: compactTime(minutes, "minute"), suffix: uiText("ago") };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: compactTime(hours, "hour"), suffix: uiText("ago") };
  const days = Math.floor(hours / 24);
  return { value: compactTime(days, "day"), suffix: uiText("ago") };
}

export function formatRelativeTimeLabel(isoDate: string) {
  const relative = formatRelativeTime(isoDate);
  return relative.suffix ? uiText("{duration} ago", { duration: relative.value }) : relative.value;
}

/**
 * Relative elapsed duration since an ISO instant, without an "ago" suffix.
 * Useful for labels like "Connected for 3m".
 */
export function formatElapsedDurationLabel(isoDate: string, nowMs: number = Date.now()): string {
  const diffMs = nowMs - new Date(isoDate).getTime();
  if (diffMs <= 0) return uiText("just now");

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return uiText("just now");
  if (seconds < 60) return compactTime(seconds, "second");

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return compactTime(minutes, "minute");

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return compactTime(hours, "hour");

  const days = Math.floor(hours / 24);
  return compactTime(days, "day");
}

/**
 * Relative time until an ISO instant (e.g. expiry). Mirrors {@link formatRelativeTime} but for future times.
 */
export function formatRelativeTimeUntil(isoDate: string): { value: string; suffix: string | null } {
  const diffMs = new Date(isoDate).getTime() - Date.now();
  if (diffMs <= 0) return { value: uiText("Expired"), suffix: null };
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return { value: uiText("Soon"), suffix: null };
  if (seconds < 60) return { value: compactTime(seconds, "second"), suffix: uiText("left") };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: compactTime(minutes, "minute"), suffix: uiText("left") };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: compactTime(hours, "hour"), suffix: uiText("left") };
  const days = Math.floor(hours / 24);
  return { value: compactTime(days, "day"), suffix: uiText("left") };
}

export function formatRelativeTimeUntilLabel(isoDate: string): string {
  const relative = formatRelativeTimeUntil(isoDate);
  return relative.suffix ? uiText("{duration} left", { duration: relative.value }) : relative.value;
}

/**
 * Countdown for a future instant (e.g. link expiry): "Expires in 4m 12s", with second precision under one hour.
 * Pass `nowMs` when a parent tick drives re-renders so the diff matches that snapshot.
 */
export function formatExpiresInLabel(isoDate: string, nowMs: number = Date.now()): string {
  const diffMs = new Date(isoDate).getTime() - nowMs;
  if (diffMs <= 0) return uiText("Expired");

  const totalSeconds = Math.floor(diffMs / 1000);
  if (totalSeconds < 5) return uiText("Expires in a moment");
  if (totalSeconds < 60) return uiText("Expires in {seconds}s", { seconds: totalSeconds });

  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return uiText("Expires in {minutes}m{seconds, plural, =0 {} other { {seconds}s}}", {
      minutes,
      seconds,
    });
  }

  if (totalSeconds < 86_400) {
    const hours = Math.floor(totalSeconds / 3600);
    const rem = totalSeconds % 3600;
    const minutes = Math.floor(rem / 60);
    const seconds = rem % 60;
    return uiText(
      "Expires in {hours}h{minutes, plural, =0 {} other { {minutes}m}}{seconds, plural, =0 {} other { {seconds}s}}",
      { hours, minutes, seconds },
    );
  }

  const days = Math.floor(totalSeconds / 86_400);
  const remAfterDays = totalSeconds % 86_400;
  if (remAfterDays === 0) return uiText("Expires in {days}d", { days });
  const hours = Math.floor(remAfterDays / 3600);
  const rem = remAfterDays % 3600;
  const minutes = Math.floor(rem / 60);
  const seconds = rem % 60;
  return uiText(
    "Expires in {days}d{hours, plural, =0 {} other { {hours}h}}{minutes, plural, =0 {} other { {minutes}m}}{seconds, plural, =0 {} other { {seconds}s}}",
    { days, hours, minutes, seconds },
  );
}
