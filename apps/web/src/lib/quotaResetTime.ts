import { uiFormatDateTime } from "@cafecode/shared/i18n";

export interface QuotaResetTimeOptions {
  readonly locale?: string;
  /** Test/viewer override; normally the computer's own zone. */
  readonly timeZone?: string;
  readonly now?: number;
}

function calendarYear(epochMs: number, timeZone: string | undefined): string {
  // Comparison only (never displayed), so a fixed numeric locale is fine.
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(epochMs);
}

/**
 * When a usage limit resets, as the viewer's own local date and time
 * (for example "Nov 6, 1:50 AM"). Quota resets are always shown in local time,
 * so the zone name is left out, and the year appears only when it differs
 * from the current one.
 */
export function formatQuotaResetTime(
  epochMs: number,
  options: QuotaResetTimeOptions,
): string | null {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
  try {
    const sameYear =
      calendarYear(epochMs, options.timeZone) ===
      calendarYear(options.now ?? Date.now(), options.timeZone);
    return uiFormatDateTime(
      new Date(epochMs),
      {
        ...(sameYear ? {} : { year: "numeric" as const }),
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      },
      options.locale,
    );
  } catch {
    return null;
  }
}
