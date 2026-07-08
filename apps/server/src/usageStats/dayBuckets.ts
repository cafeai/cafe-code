// @effect-diagnostics globalDate:off
/**
 * Local-day bucketing for usage stats.
 *
 * Day keys are `YYYY-MM-DD` in the server's local timezone. Spans that cross
 * local midnight are split so each day is credited with its own share, which
 * keeps the activity heatmap honest for turns that run across a boundary.
 *
 * `Date` is used deliberately: the host's local-timezone calendar arithmetic
 * (including DST) is exactly the behavior wanted here, and every timestamp
 * comes in as epoch milliseconds from `Clock`.
 */

/** Format a timestamp as its server-local `YYYY-MM-DD` day key. */
export function localDayKey(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface DaySpan {
  readonly day: string;
  readonly ms: number;
}

/**
 * Split `[fromMs, toMs)` into per-local-day durations. Constructing each next
 * boundary via the Date components (rather than adding 24h) keeps the split
 * correct across DST transitions. Returns an empty array for empty or
 * inverted spans.
 */
export function splitSpanIntoDays(fromMs: number, toMs: number): ReadonlyArray<DaySpan> {
  if (!(toMs > fromMs)) {
    return [];
  }

  const spans: Array<DaySpan> = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const cursorDate = new Date(cursor);
    const nextMidnight = new Date(
      cursorDate.getFullYear(),
      cursorDate.getMonth(),
      cursorDate.getDate() + 1,
      0,
      0,
      0,
      0,
    ).getTime();
    const end = Math.min(nextMidnight, toMs);
    spans.push({ day: localDayKey(cursor), ms: end - cursor });
    cursor = end;
  }
  return spans;
}
