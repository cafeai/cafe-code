import { ScheduledFollowupRecurrence, ScheduledFollowupTimestamp } from "@cafecode/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_CALENDAR_CANDIDATES = 4_096;
const MAX_CALENDAR_SEARCH_YEARS = 400;
const decodeRecurrence = Schema.decodeUnknownSync(ScheduledFollowupRecurrence);
const decodeTimestamp = Schema.decodeUnknownSync(ScheduledFollowupTimestamp);
type CalendarRecurrence = Extract<ScheduledFollowupRecurrence, { readonly kind: "calendar" }>;

/** Fixed diagnostics: never concatenate user-authored schedules or native errors. */
export class ScheduledFollowupRecurrenceError extends Error {
  constructor() {
    super("The schedule has no supported occurrence. Check its dates, time and timezone.");
    this.name = "ScheduledFollowupRecurrenceError";
  }
}

function instant(value: string | Date): number {
  try {
    return Date.parse(decodeTimestamp(typeof value === "string" ? value : value.toISOString()));
  } catch {
    throw new ScheduledFollowupRecurrenceError();
  }
}

function validateRecurrence(recurrence: ScheduledFollowupRecurrence): ScheduledFollowupRecurrence {
  try {
    return decodeRecurrence(recurrence);
  } catch {
    throw new ScheduledFollowupRecurrenceError();
  }
}

function iso(milliseconds: number): string {
  try {
    return decodeTimestamp(new Date(milliseconds).toISOString());
  } catch {
    throw new ScheduledFollowupRecurrenceError();
  }
}

/**
 * Effect Cron remains our bounded calendar search engine, but searches *civil*
 * dates in UTC. Direct zoned Cron.next currently shifts nonexistent local times
 * forward and can return a past instant during fall-back. Convert each civil
 * candidate explicitly with `earlier`, then require an exact local round-trip:
 * gaps are skipped, and overlaps always select the first occurrence only.
 * This also handles non-hour transitions without assuming any fixed DST offset.
 */
function calendarOccurrence(
  recurrence: CalendarRecurrence,
  boundary: number,
  direction: "next" | "previous",
  rangeBoundary: number | null,
): number | null {
  // A February 30-style expression is impossible even in a leap year. Reject
  // it before Cron spends its own search budget cycling nonexistent dates.
  const daysInLeapMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    recurrence.monthDays !== undefined &&
    !(recurrence.months ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).some((month) =>
      recurrence.monthDays!.some((day) => day <= daysInLeapMonth[month - 1]!),
    )
  ) {
    throw new ScheduledFollowupRecurrenceError();
  }
  const zone = DateTime.zoneMakeNamedUnsafe(recurrence.timeZone);
  const localBoundary = DateTime.toParts(DateTime.makeZonedUnsafe(boundary, { timeZone: zone }));
  const civilBoundary = new Date(0);
  civilBoundary.setUTCFullYear(localBoundary.year, localBoundary.month - 1, localBoundary.day);
  civilBoundary.setUTCHours(0, 0, 0, 0);
  let cursor =
    direction === "next" ? civilBoundary.getTime() - 1_000 : civilBoundary.getTime() + DAY_MS;
  const cron = Cron.make({
    seconds: [0],
    minutes: [recurrence.minute],
    hours: [recurrence.hour],
    days: recurrence.monthDays ?? [],
    months: recurrence.months ?? [],
    // Cron combines day-of-month and weekday with OR. Our structured contract
    // uses intersection, so let the day constraint drive candidate generation
    // when both are present, then independently verify weekday below.
    weekdays: recurrence.monthDays === undefined ? (recurrence.weekdays ?? []) : [],
    tz: DateTime.zoneMakeNamedUnsafe("UTC"),
  });
  for (let attempt = 0; attempt < MAX_CALENDAR_CANDIDATES; attempt += 1) {
    const candidate = direction === "next" ? Cron.next(cron, cursor) : Cron.prev(cron, cursor);
    cursor = candidate.getTime();
    const year = candidate.getUTCFullYear();
    if (year < 0 || year > 9999) return null;
    if (Math.abs(year - localBoundary.year) > MAX_CALENDAR_SEARCH_YEARS) {
      throw new ScheduledFollowupRecurrenceError();
    }
    const zoned = DateTime.makeZonedUnsafe(candidate, {
      timeZone: zone,
      adjustForTimeZone: true,
      disambiguation: "earlier",
    });
    const observed = DateTime.toParts(zoned);
    const candidateInstant = DateTime.toDateUtc(zoned).getTime();
    if (
      rangeBoundary !== null &&
      (direction === "next" ? candidateInstant > rangeBoundary : candidateInstant < rangeBoundary)
    ) {
      return null;
    }
    if (
      observed.year !== year ||
      observed.month !== candidate.getUTCMonth() + 1 ||
      observed.day !== candidate.getUTCDate() ||
      observed.hour !== recurrence.hour ||
      observed.minute !== recurrence.minute ||
      observed.second !== 0 ||
      (recurrence.weekdays !== undefined && !recurrence.weekdays.includes(observed.weekDay))
    ) {
      continue;
    }
    if (direction === "next" ? candidateInstant > boundary : candidateInstant <= boundary) {
      return candidateInstant;
    }
  }
  // Search work is bounded independently of outage length or history size.
  // A contrived calendar whose only dates are DST gaps must not freeze the UI
  // preview or backend scheduler while looking for a nonexistent occurrence.
  throw new ScheduledFollowupRecurrenceError();
}

function nextOccurrence(
  recurrence: ScheduledFollowupRecurrence,
  after: number,
  endAt: number | null,
): number | null {
  if (endAt !== null && after >= endAt) return null;
  if (recurrence.kind === "calendar") return calendarOccurrence(recurrence, after, "next", endAt);
  const candidate =
    recurrence.kind === "once"
      ? instant(recurrence.at)
      : instant(recurrence.anchorAt) +
        Math.max(
          0,
          Math.floor(
            (after - instant(recurrence.anchorAt)) / (recurrence.everyMinutes * MINUTE_MS),
          ) + 1,
        ) *
          recurrence.everyMinutes *
          MINUTE_MS;
  return candidate > after && (endAt === null || candidate <= endAt) ? candidate : null;
}

/**
 * Preview the next one to three strictly later occurrences. Intervals are
 * elapsed-time schedules anchored to their original instant; timezone changes
 * do not shorten/extend them. Calendar times follow their explicit IANA zone.
 * An end time is inclusive. No current clock or process-local zone is consulted.
 */
export function nextScheduleOccurrences(
  recurrence: ScheduledFollowupRecurrence,
  after: string | Date,
  limit = 3,
  endAt: string | null = null,
): readonly string[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) {
    throw new ScheduledFollowupRecurrenceError();
  }
  try {
    const validated = validateRecurrence(recurrence);
    const end = endAt === null ? null : instant(endAt);
    let cursor = instant(after);
    const results: string[] = [];
    for (let index = 0; index < limit; index += 1) {
      const next = nextOccurrence(validated, cursor, end);
      if (next === null) break;
      results.push(iso(next));
      cursor = next;
    }
    return results;
  } catch {
    throw new ScheduledFollowupRecurrenceError();
  }
}

/**
 * Collapse a missed window to at most its latest eligible occurrence, plus a
 * future cursor. Never enumerate/replay every missed interval. The durable
 * scheduler still owns revision checks, one-in-flight admission and run limits;
 * this pure calculation does not itself authorize dispatch.
 */
export function coalesceScheduledFollowupDue(
  recurrence: ScheduledFollowupRecurrence,
  nextRunAt: string | null,
  now: string | Date,
  endAt: string | null = null,
): { readonly dueAt: string | null; readonly nextRunAt: string | null } {
  try {
    const validated = validateRecurrence(recurrence);
    const current = instant(now);
    const end = endAt === null ? null : instant(endAt);
    if (nextRunAt === null) return { dueAt: null, nextRunAt: null };
    const pending = instant(nextRunAt);
    if (end !== null && pending > end) return { dueAt: null, nextRunAt: null };
    if (pending > current) return { dueAt: null, nextRunAt: iso(pending) };
    const upper = end === null ? current : Math.min(current, end);
    let due: number | null;
    if (validated.kind === "once") {
      const at = instant(validated.at);
      due = at >= pending && at <= upper ? at : null;
    } else if (validated.kind === "interval") {
      const anchor = instant(validated.anchorAt);
      const interval = validated.everyMinutes * MINUTE_MS;
      const last = anchor + Math.floor((upper - anchor) / interval) * interval;
      due = last >= anchor && last >= pending ? last : null;
    } else {
      due = calendarOccurrence(validated, upper, "previous", pending);
    }
    const next = nextOccurrence(validated, current, end);
    return { dueAt: due === null ? null : iso(due), nextRunAt: next === null ? null : iso(next) };
  } catch {
    throw new ScheduledFollowupRecurrenceError();
  }
}
