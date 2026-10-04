import * as Schema from "effect/Schema";

import { CommandId, MessageId, ThreadId, TurnId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** These are resource bounds, not promises about provider or account capacity. */
export const SCHEDULED_FOLLOWUP_MAX_PROMPT_CHARS = 16_000;
export const SCHEDULED_FOLLOWUP_MAX_NAME_CHARS = 120;
export const SCHEDULED_FOLLOWUP_MAX_RUNS = 10_000;
export const SCHEDULED_FOLLOWUP_MIN_INTERVAL_MINUTES = 5;
export const SCHEDULED_FOLLOWUP_MAX_INTERVAL_MINUTES = 525_600;
export const SCHEDULED_FOLLOWUP_MAX_SCHEDULES_PER_THREAD = 100;

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const safeNonNegativeInt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const revision = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

export const ScheduledFollowupId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("ScheduledFollowupId"),
);
export type ScheduledFollowupId = typeof ScheduledFollowupId.Type;
export const ScheduledFollowupRunId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("ScheduledFollowupRunId"),
);
export type ScheduledFollowupRunId = typeof ScheduledFollowupRunId.Type;

/**
 * Unlike the legacy general-purpose timestamp schema, scheduling accepts only
 * an unambiguous canonical UTC instant. Round-tripping rejects invalid dates
 * which Date.parse would silently carry into the following month.
 */
export const ScheduledFollowupTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.makeFilter((value) => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  }),
);
export type ScheduledFollowupTimestamp = typeof ScheduledFollowupTimestamp.Type;

/** Named zones remain explicit even for UTC/interval schedules and previews. */
export const ScheduledFollowupTimeZone = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_+\-/]*$/),
  Schema.makeFilter((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions();
      return true;
    } catch {
      return false;
    }
  }),
);
export type ScheduledFollowupTimeZone = typeof ScheduledFollowupTimeZone.Type;

const uniqueCalendarNumbers = (minimum: number, maximum: number) =>
  Schema.Array(Schema.Int.check(Schema.isBetween({ minimum, maximum }))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximum - minimum + 1),
    Schema.makeFilter((values) => new Set(values).size === values.length),
  );

/**
 * Calendar constraints intersect. Omitted arrays mean every applicable day or
 * month; empty arrays are invalid, not a second spelling of "every". Sunday is
 * zero. A calendar has one wall-clock time per matching day, allowing a clear
 * first-occurrence-only policy when the clock repeats during DST fall-back.
 * Daily, weekdays and weekly are UI presets of this same canonical shape.
 */
export const ScheduledFollowupRecurrence = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("once"),
    at: ScheduledFollowupTimestamp,
    timeZone: ScheduledFollowupTimeZone,
  }).annotate(strict),
  Schema.Struct({
    kind: Schema.Literal("interval"),
    anchorAt: ScheduledFollowupTimestamp,
    everyMinutes: Schema.Int.check(
      Schema.isBetween({
        minimum: SCHEDULED_FOLLOWUP_MIN_INTERVAL_MINUTES,
        maximum: SCHEDULED_FOLLOWUP_MAX_INTERVAL_MINUTES,
      }),
    ),
    timeZone: ScheduledFollowupTimeZone,
  }).annotate(strict),
  Schema.Struct({
    kind: Schema.Literal("calendar"),
    timeZone: ScheduledFollowupTimeZone,
    hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
    minute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 })),
    weekdays: Schema.optionalKey(uniqueCalendarNumbers(0, 6)),
    monthDays: Schema.optionalKey(uniqueCalendarNumbers(1, 31)),
    months: Schema.optionalKey(uniqueCalendarNumbers(1, 12)),
  }).annotate(strict),
]);
export type ScheduledFollowupRecurrence = typeof ScheduledFollowupRecurrence.Type;

/**
 * A bounded canonical ModelSelection shape, without the legacy decoder's open
 * input fields. The server additionally binds instanceId to the schedule's
 * owner-confirmed account; a client model override never authorizes rerouting.
 */
export const ScheduledFollowupModelSelection = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  options: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
        value: Schema.Union([TrimmedNonEmptyString.check(Schema.isMaxLength(200)), Schema.Boolean]),
      }).annotate(strict),
    ).check(
      Schema.isMaxLength(32),
      Schema.makeFilter(
        (options) => new Set(options.map((option) => option.id)).size === options.length,
      ),
    ),
  ),
}).annotate(strict);
export type ScheduledFollowupModelSelection = typeof ScheduledFollowupModelSelection.Type;

export const ScheduledFollowupNotificationPolicy = Schema.Literals([
  "changes-and-errors",
  "all-runs",
  "errors-only",
]);
export type ScheduledFollowupNotificationPolicy = typeof ScheduledFollowupNotificationPolicy.Type;

const draftFields = {
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(SCHEDULED_FOLLOWUP_MAX_NAME_CHARS)),
  // Preserve the original instruction bytes, including surrounding whitespace;
  // only an all-whitespace prompt is invalid. Never treat this as a command.
  prompt: Schema.String.check(
    Schema.isPattern(/\S/),
    Schema.isMaxLength(SCHEDULED_FOLLOWUP_MAX_PROMPT_CHARS),
  ),
  recurrence: ScheduledFollowupRecurrence,
  modelSelection: Schema.NullOr(ScheduledFollowupModelSelection),
  notificationPolicy: ScheduledFollowupNotificationPolicy,
  endAt: Schema.NullOr(ScheduledFollowupTimestamp),
  maxRuns: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SCHEDULED_FOLLOWUP_MAX_RUNS })),
  ),
  allowAutoFinish: Schema.Boolean,
};
export const ScheduledFollowupDraft = Schema.Struct(draftFields).annotate(strict);
export type ScheduledFollowupDraft = typeof ScheduledFollowupDraft.Type;

export const ScheduledFollowupState = Schema.Literals([
  "pending_confirmation",
  "active",
  "paused",
  "completed",
  "needs_attention",
  "deleted",
]);
export type ScheduledFollowupState = typeof ScheduledFollowupState.Type;
export const ScheduledFollowupRunState = Schema.Literals([
  "waiting",
  "dispatching",
  "running",
  "completed",
  "failed",
  "interrupted",
  "unknown",
  "skipped",
]);
export type ScheduledFollowupRunState = typeof ScheduledFollowupRunState.Type;

export const ScheduledFollowupRun = Schema.Struct({
  id: ScheduledFollowupRunId,
  scheduleId: ScheduledFollowupId,
  revision,
  dueAt: ScheduledFollowupTimestamp,
  state: ScheduledFollowupRunState,
  commandId: CommandId.check(Schema.isMaxLength(200)),
  messageId: MessageId.check(Schema.isMaxLength(200)),
  intentSequence: Schema.NullOr(safeNonNegativeInt),
  turnId: Schema.NullOr(TurnId.check(Schema.isMaxLength(200))),
  modelSelection: Schema.NullOr(ScheduledFollowupModelSelection),
  createdAt: ScheduledFollowupTimestamp,
  startedAt: Schema.NullOr(ScheduledFollowupTimestamp),
  completedAt: Schema.NullOr(ScheduledFollowupTimestamp),
  result: Schema.NullOr(Schema.Literals(["no-change", "changed"])),
  summary: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
  // Codes are bounded public classifications, never raw provider errors.
  errorCode: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_.-]{0,63}$/))),
}).annotate(strict);
export type ScheduledFollowupRun = typeof ScheduledFollowupRun.Type;

export const ScheduledFollowupRecord = Schema.Struct({
  id: ScheduledFollowupId,
  threadId: ThreadId.check(Schema.isMaxLength(200)),
  revision,
  state: ScheduledFollowupState,
  ...draftFields,
  authorizedInstanceId: ProviderInstanceId,
  permissionCeiling: RuntimeMode,
  createdAt: ScheduledFollowupTimestamp,
  updatedAt: ScheduledFollowupTimestamp,
  nextRunAt: Schema.NullOr(ScheduledFollowupTimestamp),
  runCount: safeNonNegativeInt,
  lastRun: Schema.NullOr(ScheduledFollowupRun),
}).annotate(strict);
export type ScheduledFollowupRecord = typeof ScheduledFollowupRecord.Type;

const threadField = { threadId: ThreadId.check(Schema.isMaxLength(200)) };
const identityFields = { ...threadField, id: ScheduledFollowupId };
const mutationFields = { ...identityFields, expectedRevision: revision };

export const ScheduledFollowupListInput = Schema.Struct(threadField).annotate(strict);
export type ScheduledFollowupListInput = typeof ScheduledFollowupListInput.Type;
export const ScheduledFollowupListResult = Schema.Struct({
  schedules: Schema.Array(ScheduledFollowupRecord).check(
    Schema.isMaxLength(SCHEDULED_FOLLOWUP_MAX_SCHEDULES_PER_THREAD),
  ),
  backendOnline: Schema.Literal(true),
}).annotate(strict);
export type ScheduledFollowupListResult = typeof ScheduledFollowupListResult.Type;

export const ScheduledFollowupSaveInput = Schema.Struct({
  ...threadField,
  id: Schema.optionalKey(ScheduledFollowupId),
  expectedRevision: Schema.optionalKey(revision),
  ...draftFields,
})
  .check(
    Schema.makeFilter(
      (value) => (value.id === undefined) === (value.expectedRevision === undefined),
    ),
  )
  .annotate(strict);
export type ScheduledFollowupSaveInput = typeof ScheduledFollowupSaveInput.Type;

export const ScheduledFollowupSetStatusInput = Schema.Struct({
  ...mutationFields,
  state: Schema.Literals(["active", "paused", "deleted"]),
}).annotate(strict);
export type ScheduledFollowupSetStatusInput = typeof ScheduledFollowupSetStatusInput.Type;
export const ScheduledFollowupRunNowInput = Schema.Struct(mutationFields).annotate(strict);
export type ScheduledFollowupRunNowInput = typeof ScheduledFollowupRunNowInput.Type;

const historyCursor = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
export const ScheduledFollowupHistoryInput = Schema.Struct({
  ...identityFields,
  before: Schema.optionalKey(historyCursor),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
}).annotate(strict);
export type ScheduledFollowupHistoryInput = typeof ScheduledFollowupHistoryInput.Type;
export const ScheduledFollowupHistoryResult = Schema.Struct({
  runs: Schema.Array(ScheduledFollowupRun).check(Schema.isMaxLength(50)),
  nextCursor: Schema.NullOr(historyCursor),
}).annotate(strict);
export type ScheduledFollowupHistoryResult = typeof ScheduledFollowupHistoryResult.Type;

/** Services construct only fixed, sanitized messages at this public boundary. */
export class ScheduledFollowupError extends Schema.TaggedErrorClass<ScheduledFollowupError>()(
  "ScheduledFollowupError",
  { message: Schema.String.check(Schema.isMaxLength(512)) },
) {}
