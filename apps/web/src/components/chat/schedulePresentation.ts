import {
  ScheduledFollowupTimeZone,
  ScheduledFollowupTimestamp,
  type ModelSelection,
  type ScheduledFollowupRecord,
  type ScheduledFollowupRun,
  type ServerProvider,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { uiFormatDateTime, uiText } from "@cafecode/shared/i18n";

const isScheduleTimeZone = Schema.is(ScheduledFollowupTimeZone);
const isScheduleTimestamp = Schema.is(ScheduledFollowupTimestamp);

export interface ScheduleRunIssuePresentation {
  readonly reason: string;
  readonly action: string;
}

/** Describe the saved occurrence, not the provider's current health. Codes are
 * public classifications but remain untrusted/forward-compatible strings at
 * this boundary: only exact known values select Cafe-authored copy. Never echo
 * an unknown code, provider message, exception, account secret or native path.
 * A switch also prevents inherited object properties from becoming messages.
 */
export function scheduleRunIssuePresentation(
  run: Pick<ScheduledFollowupRun, "state" | "errorCode"> | null,
): ScheduleRunIssuePresentation | null {
  if (run === null || !["failed", "interrupted", "unknown", "skipped"].includes(run.state)) {
    // Waiting remains an idle-admission barrier, never a failed provider run.
    // Completed/live runs must not inherit obsolete error classifications.
    return null;
  }
  const action = uiText(
    "Check this chat and run history, then review and enable the schedule when ready.",
  );
  const fallback = {
    reason:
      run.state === "interrupted"
        ? uiText("This run was interrupted.")
        : run.state === "skipped"
          ? uiText("This run was skipped.")
          : uiText("This run failed."),
    action,
  };
  if (run.state === "unknown") {
    return {
      reason: uiText("Cafe could not confirm whether the provider accepted this run."),
      action: uiText(
        "Wait for Cafe to reconcile this run. Check this chat for existing work; do not repeat an unconfirmed run.",
      ),
    };
  }
  switch (run.errorCode) {
    case "provider-unavailable":
      // A mismatched legacy/future state must not gain an unsent guarantee
      // merely by carrying the spelling of a pre-admission failure code.
      if (run.state !== "failed") return fallback;
      return {
        // This exact code is minted before admission or the immutable attempt
        // fence. Unlike a failed/unknown native turn, it proves no submission.
        reason: uiText(
          "The saved provider account or selected model was unavailable. This run was not submitted.",
        ),
        action: uiText(
          "Check the saved account and model in Settings, then review the schedule before enabling it again.",
        ),
      };
    case "chat-unavailable":
      return { reason: uiText("This chat was unavailable when the run was due."), action };
    case "settings-changed":
      return {
        reason: uiText(
          "The chat's account or permission settings changed and need renewed review.",
        ),
        action,
      };
    case "admission-rejected":
      return { reason: uiText("This run could not be admitted to the chat."), action };
    case "preparation-failed":
      return { reason: uiText("This run could not prepare its saved input or provider."), action };
    case "turn-failed":
      return { reason: uiText("The provider reported that this run failed."), action };
    case "turn-interrupted":
      return { reason: uiText("The provider reported that this run was interrupted."), action };
    case "limit-reached":
      return {
        reason: uiText("This run was skipped because the schedule reached its end or run limit."),
        action,
      };
    case "schedule-changed":
      return {
        reason: uiText("This run was skipped because the schedule changed before it started."),
        action,
      };
    case "user-control":
    case "admission-revoked":
      return { reason: uiText("This run was cancelled before starting."), action };
    case "runtime-busy":
      return {
        reason: uiText("This run was skipped because the chat was already working."),
        action,
      };
    default:
      // A future backend or corrupt legacy row cannot disclose arbitrary text
      // or make a more specific delivery claim through the generic fallback.
      return fallback;
  }
}

/** The transcript and Tasks must describe the same saved recurrence. Labels
 * are presentation only; the backend's named-zone recurrence owns execution. */
export function scheduleRecurrenceLabel(record: ScheduledFollowupRecord): string {
  const recurrence = record.recurrence;
  if (recurrence.kind === "once") return uiText("One-time follow-up");
  if (recurrence.kind === "interval")
    return uiText("Every {minutes, plural, one {# minute} other {# minutes}}", {
      minutes: recurrence.everyMinutes,
    });
  // Calendar clock fields belong to the schedule's selected timezone. Display
  // actual occurrence instants separately in computer-local time with a zone
  // label, rather than putting an unqualified nonlocal clock into this summary.
  if (recurrence.monthDays || recurrence.months) return uiText("Custom calendar");
  if (!recurrence.weekdays) return uiText("Daily");
  if (recurrence.weekdays.toSorted().join(",") === "1,2,3,4,5") return uiText("Weekdays");
  return recurrence.weekdays
    .map(
      (day) =>
        [
          uiText("Sun"),
          uiText("Mon"),
          uiText("Tue"),
          uiText("Wed"),
          uiText("Thu"),
          uiText("Fri"),
          uiText("Sat"),
        ][day],
    )
    .join(", ");
}

/** Render only the provider's public account label, never authentication metadata. */
export function scheduleAccountLabel(
  modelSelection: ModelSelection,
  provider: ServerProvider | null,
): string {
  return provider?.instanceId === modelSelection.instanceId
    ? (provider.displayName ?? provider.instanceId)
    : modelSelection.instanceId;
}

/** Shared by cards and the editor so the saved override is not mistaken for a
 * provider-observed runtime setting. Actual accepted-turn configuration remains
 * authoritative once the scheduled run starts. */
export function scheduleModelLabel(selection: ModelSelection): string {
  const options = (selection.options ?? []).map(({ id, value }) => {
    const label =
      id === "reasoningEffort" || id === "effort"
        ? uiText("Effort")
        : id === "fastMode"
          ? uiText("Fast")
          : id;
    return uiText("{label}: {value}", {
      label,
      value: typeof value === "boolean" ? (value ? uiText("on") : uiText("off")) : value,
    });
  });
  return [selection.model, ...options].join(" · ");
}

/** Every occurrence display uses the computer's local timezone, independently
 * of the zone which owns recurrence/input interpretation. Include its actual
 * short label (or native GMT offset) so DST changes remain visible. */
export function formatScheduleTime(instant: string): string {
  try {
    if (!isScheduleTimestamp(instant)) return uiText("Time unavailable");
    const formatted = uiFormatDateTime(new Date(instant), {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: browserScheduleTimeZone(),
    });
    return formatted === "—" ? uiText("Time unavailable") : formatted;
  } catch {
    // Persisted records should already be validated. Never turn one unknown
    // timezone or corrupt legacy timestamp into a broken Tasks surface.
    return uiText("Time unavailable");
  }
}

/** A datetime-local field has no timezone of its own. Render the saved instant
 * as civil minutes in the editor's explicitly selected zone. The editor keeps
 * the original instant when this minute-precision field is untouched, thereby
 * preserving saved seconds/milliseconds and the second side of a DST overlap. */
export function scheduleZonedInput(instant: string | null, timeZone: string): string {
  try {
    if (instant === null || !isScheduleTimestamp(instant) || !isScheduleTimeZone(timeZone)) {
      return "";
    }
    const zoned = DateTime.makeZonedUnsafe(instant, {
      timeZone: DateTime.zoneMakeNamedUnsafe(timeZone),
    });
    const civil = DateTime.toDate(zoned).toISOString();
    // A valid instant at an extreme supported year can cross into a civil year
    // outside the four-digit datetime-local/contract range in the selected zone.
    return /^\d{4}-/.test(civil) ? civil.slice(0, 16) : "";
  } catch {
    return "";
  }
}

/** Interpret civil minutes only in the selected named zone, using the same
 * `earlier` disambiguation and exact round-trip as backend calendar recurrence.
 * Strict UTC civil validation rejects normalized invalid dates before zone
 * conversion; the second round-trip rejects DST gaps instead of moving a run.
 * Overlaps deterministically select their first occurrence, including zones
 * with non-hour transitions. No host-local Date parsing is involved. */
export function parseScheduleZonedInput(value: string, timeZone: string): string | null {
  try {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !isScheduleTimeZone(timeZone)) {
      return null;
    }
    const civil = `${value}:00.000Z`;
    if (!isScheduleTimestamp(civil)) return null;
    const zoned = DateTime.makeZonedUnsafe(new Date(civil), {
      timeZone: DateTime.zoneMakeNamedUnsafe(timeZone),
      adjustForTimeZone: true,
      disambiguation: "earlier",
    });
    if (DateTime.toDate(zoned).toISOString() !== civil) return null;
    const instant = DateTime.toDateUtc(zoned).toISOString();
    return isScheduleTimestamp(instant) ? instant : null;
  } catch {
    return null;
  }
}

/** A bounded, non-evaluating parser for the advanced calendar controls. Empty
 * fields mean unrestricted; duplicates are normalized, never executable RRULE
 * fragments or arbitrary expressions. The server validates this again. */
export function parseScheduleNumbers(
  value: string,
  minimum: number,
  maximum: number,
): number[] | undefined {
  if (!value.trim()) return undefined;
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length > maximum - minimum + 1 || parts.some((part) => !/^\d{1,2}$/.test(part))) {
    throw new Error(
      uiText("Use comma-separated numbers from {minimum} to {maximum}.", { minimum, maximum }),
    );
  }
  const values = parts.map(Number);
  if (values.some((item) => item < minimum || item > maximum)) {
    throw new Error(uiText("Use numbers from {minimum} to {maximum}.", { minimum, maximum }));
  }
  return [...new Set(values)].toSorted((left, right) => left - right);
}

export function browserScheduleTimeZone(): string {
  try {
    const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isScheduleTimeZone(timeZone) ? timeZone : "UTC";
  } catch {
    // An absent/invalid browser zone must never make a new schedule ambiguous.
    // UTC is an explicit valid selection rather than an implicit host fallback.
    return "UTC";
  }
}

/** Use the runtime's complete timezone catalog, never a curated subset. UTC
 * and accepted local/current aliases may be absent from supportedValuesOf's
 * canonical list, so retain their exact spelling as additional selections. */
export function scheduleTimeZoneOptions(
  currentTimeZone?: string,
  localTimeZone: string = browserScheduleTimeZone(),
): readonly string[] {
  const options = new Set<string>(["UTC"]);
  try {
    // Modern supported browsers and the pinned Electron runtime expose this
    // API. If an older/limited host omits it or fails, still retain UTC and the
    // valid local/saved choices instead of silently replacing a saved zone.
    if (typeof Intl.supportedValuesOf === "function") {
      for (const timeZone of Intl.supportedValuesOf("timeZone")) options.add(timeZone);
    }
  } catch {
    // There is no dependency-free authoritative catalog on such a host; the
    // validated explicit selections below remain available and usable.
  }
  for (const timeZone of ["UTC", localTimeZone, currentTimeZone]) {
    if (isScheduleTimeZone(timeZone)) options.add(timeZone);
  }
  return [...options].toSorted();
}
