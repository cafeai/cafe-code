import { usageDayToUtcDayIndex } from "./usageRange";
const WEEKS = 26;
export function buildActivityCalendar({
  byDay,
  bounded,
  startDayKey,
  endDayKey,
  todayDayKey,
  browserDay,
}: {
  byDay: ReadonlyMap<string, number>;
  bounded: boolean;
  startDayKey?: string | undefined;
  endDayKey?: string | undefined;
  todayDayKey?: string | undefined;
  browserDay: string;
}) {
  const endDay = usageDayToUtcDayIndex(bounded ? (endDayKey ?? "") : browserDay);
  const explicitStartDay = bounded ? usageDayToUtcDayIndex(startDayKey ?? "") : undefined;
  // Invalid explicit bounds fail closed. In particular they must not silently
  // replace the server's day anchor with the browser's unrelated current date.
  if (
    endDay === undefined ||
    (bounded && (explicitStartDay === undefined || explicitStartDay > endDay))
  ) {
    return {
      rangeStart: 0,
      start: 0,
      endDay: -1,
      weekCount: 0,
      historicalMaxMs: 0,
      calendarKey: "",
    };
  }
  // The Unix epoch was a Thursday. Integer day arithmetic aligns Sunday
  // columns without local Date setters, whose offsets can change at DST.
  const weekdayOf = (dayIndex: number) => (((dayIndex + 4) % 7) + 7) % 7;
  const rangeStart = explicitStartDay ?? endDay - weekdayOf(endDay) - (WEEKS - 1) * 7;
  const start = rangeStart - weekdayOf(rangeStart);
  const weekCount = Math.floor((endDay - start) / 7) + 1;
  let max = 0;
  // Scale only recorded in-range activity. Walking every empty calendar date
  // here would defeat virtualization for sparse or exceptionally old history.
  for (const [dayKey, generatingMs] of byDay) {
    // Today's live value replaces its fetched row, including when it falls
    // below that row. Exclude it from the historical peak so current updates
    // can change the peak in O(1), without rescanning lifetime history.
    if (dayKey === todayDayKey) continue;
    const dayIndex = usageDayToUtcDayIndex(dayKey);
    if (dayIndex !== undefined && dayIndex >= rangeStart && dayIndex <= endDay) {
      max = Math.max(max, generatingMs);
    }
  }
  return {
    rangeStart,
    start,
    endDay,
    weekCount,
    historicalMaxMs: max,
    calendarKey: `${bounded}:${rangeStart}:${endDay}`,
  };
}
