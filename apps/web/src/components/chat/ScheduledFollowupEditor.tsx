import {
  ScheduledFollowupDraft,
  ScheduledFollowupRecurrence,
  SCHEDULED_FOLLOWUP_MAX_NAME_CHARS,
  SCHEDULED_FOLLOWUP_MAX_PROMPT_CHARS,
  SCHEDULED_FOLLOWUP_MAX_RUNS,
  SCHEDULED_FOLLOWUP_MIN_INTERVAL_MINUTES,
  type ModelSelection,
  type ScheduledFollowupRecord,
} from "@cafecode/contracts";
import { nextScheduleOccurrences } from "@cafecode/shared/scheduledFollowups";
import * as Schema from "effect/Schema";
import { ArrowLeftIcon } from "lucide-react";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import type { ScheduledFollowupsContext } from "./ScheduledFollowups";
import {
  browserScheduleTimeZone,
  formatScheduleTime,
  parseScheduleNumbers,
  parseScheduleUtcInput,
  scheduleAccountLabel,
  scheduleModelLabel,
  scheduleUtcInput,
} from "./schedulePresentation";

type RepeatPreset = "once" | "interval" | "daily" | "weekdays" | "weekly" | "custom";
const decodeDraft = Schema.decodeUnknownSync(ScheduledFollowupDraft);
const decodeRecurrence = Schema.decodeUnknownSync(ScheduledFollowupRecurrence);
const selectClass =
  "min-h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 py-1 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function recurrencePreset(recurrence: ScheduledFollowupRecurrence | undefined): RepeatPreset {
  if (!recurrence || recurrence.kind === "interval") return "interval";
  if (recurrence.kind === "once") return "once";
  if (recurrence.months || recurrence.monthDays) return "custom";
  if (!recurrence.weekdays) return "daily";
  if (recurrence.weekdays.length === 1) return "weekly";
  return recurrence.weekdays.toSorted().join(",") === "1,2,3,4,5" ? "weekdays" : "custom";
}

function Field(props: { label: string; children: (id: string) => ReactNode; help?: string }) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium">
        {props.label}
      </label>
      {props.children(id)}
      {props.help ? (
        <p className="text-[11px] leading-4 text-muted-foreground">{props.help}</p>
      ) : null}
    </div>
  );
}

/** All controls edit a local draft. Polling cannot overwrite in-progress input,
 * and a save carries the revision that was actually reviewed by this user. */
export function ScheduledFollowupEditor(props: {
  context: ScheduledFollowupsContext;
  record: ScheduledFollowupRecord | null;
  saving: boolean;
  error: string | null;
  onSave: (draft: ScheduledFollowupDraft) => void;
  onCancel: () => void;
}) {
  const { context, record } = props;
  const [openedAt] = useState(() => new Date().toISOString());
  const [name, setName] = useState(record?.name ?? "");
  const [prompt, setPrompt] = useState(record?.prompt ?? "");
  const recurrence = record?.recurrence;
  const [repeat, setRepeat] = useState<RepeatPreset>(() => recurrencePreset(recurrence));
  const [timeZone, setTimeZone] = useState(recurrence?.timeZone ?? browserScheduleTimeZone());
  const [minutes, setMinutes] = useState(
    String(recurrence?.kind === "interval" ? recurrence.everyMinutes : 5),
  );
  const [at, setAt] = useState(() =>
    scheduleUtcInput(
      recurrence?.kind === "once"
        ? recurrence.at
        : new Date(Date.parse(openedAt) + 3_600_000).toISOString(),
    ),
  );
  const [time, setTime] = useState(
    recurrence?.kind === "calendar"
      ? `${String(recurrence.hour).padStart(2, "0")}:${String(recurrence.minute).padStart(2, "0")}`
      : "09:00",
  );
  const [weekday, setWeekday] = useState(
    String(recurrence?.kind === "calendar" ? (recurrence.weekdays?.[0] ?? 1) : 1),
  );
  const [weekdays, setWeekdays] = useState(
    recurrence?.kind === "calendar" ? (recurrence.weekdays?.join(",") ?? "") : "",
  );
  const [monthDays, setMonthDays] = useState(
    recurrence?.kind === "calendar" ? (recurrence.monthDays?.join(",") ?? "") : "",
  );
  const [months, setMonths] = useState(
    recurrence?.kind === "calendar" ? (recurrence.months?.join(",") ?? "") : "",
  );
  const [override, setOverride] = useState(
    record?.modelSelection !== null && record?.modelSelection !== undefined,
  );
  const [selection, setSelection] = useState<ModelSelection>(
    record?.modelSelection ?? context.modelSelection,
  );
  const [notificationPolicy, setNotificationPolicy] = useState<
    ScheduledFollowupDraft["notificationPolicy"]
  >(record?.notificationPolicy ?? "changes-and-errors");
  const [endAt, setEndAt] = useState(scheduleUtcInput(record?.endAt ?? null));
  const [maxRuns, setMaxRuns] = useState(record?.maxRuns?.toString() ?? "");
  const [allowAutoFinish, setAllowAutoFinish] = useState(record?.allowAutoFinish ?? false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const originalEndAt = record?.endAt ?? null;

  const calendar = useMemo(() => {
    try {
      let value: ScheduledFollowupRecurrence;
      if (repeat === "once") {
        // Native minute-resolution controls must not silently truncate an
        // existing second/millisecond instant when only instructions change.
        const parsed =
          recurrence?.kind === "once" && at === scheduleUtcInput(recurrence.at)
            ? recurrence.at
            : parseScheduleUtcInput(at);
        if (!parsed) throw new Error("Choose a valid UTC date and time.");
        value = { kind: "once", at: parsed, timeZone };
      } else if (repeat === "interval") {
        value = {
          kind: "interval",
          everyMinutes: Number(minutes),
          timeZone,
          anchorAt: recurrence?.kind === "interval" ? recurrence.anchorAt : openedAt,
        };
      } else {
        if (!/^\d{2}:\d{2}$/.test(time)) throw new Error("Choose a valid time.");
        const [hour, minute] = time.split(":").map(Number);
        const selectedWeekdays =
          repeat === "weekdays"
            ? [1, 2, 3, 4, 5]
            : repeat === "weekly"
              ? [Number(weekday)]
              : repeat === "custom"
                ? parseScheduleNumbers(weekdays, 0, 6)
                : undefined;
        const selectedDays =
          repeat === "custom" ? parseScheduleNumbers(monthDays, 1, 31) : undefined;
        const selectedMonths =
          repeat === "custom" ? parseScheduleNumbers(months, 1, 12) : undefined;
        value = {
          kind: "calendar",
          hour: hour!,
          minute: minute!,
          timeZone,
          ...(selectedWeekdays ? { weekdays: selectedWeekdays } : {}),
          ...(selectedDays ? { monthDays: selectedDays } : {}),
          ...(selectedMonths ? { months: selectedMonths } : {}),
        };
      }
      const validated = decodeRecurrence(value);
      const end = endAt
        ? originalEndAt && endAt === scheduleUtcInput(originalEndAt)
          ? originalEndAt
          : parseScheduleUtcInput(endAt)
        : null;
      if (endAt && !end) throw new Error("Choose a valid end date.");
      const occurrences = nextScheduleOccurrences(validated, new Date(), 3, end);
      return {
        value: validated,
        occurrences,
        error: occurrences.length
          ? null
          : "There are no future runs. Check the date and calendar settings.",
      };
    } catch {
      return {
        value: null,
        occurrences: [],
        error:
          "Check the time, timezone, and recurrence fields. Intervals must be at least 5 minutes.",
      };
    }
  }, [
    repeat,
    at,
    timeZone,
    minutes,
    recurrence,
    openedAt,
    time,
    weekday,
    weekdays,
    monthDays,
    months,
    endAt,
    originalEndAt,
  ]);

  const model = context.provider?.models.find((entry) => entry.slug === selection.model);
  const descriptors = model?.capabilities?.optionDescriptors ?? [];
  const setOption = (id: string, value: string | boolean) =>
    setSelection((prior) => ({
      ...prior,
      options: [...(prior.options ?? []).filter((option) => option.id !== id), { id, value }],
    }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (props.saving) return;
    try {
      if (!calendar.value || calendar.error) throw new Error("Invalid calendar");
      const draft = decodeDraft({
        name: name.trim(),
        prompt,
        recurrence: calendar.value,
        modelSelection: override
          ? { ...selection, instanceId: context.modelSelection.instanceId }
          : null,
        notificationPolicy,
        endAt: endAt
          ? originalEndAt && endAt === scheduleUtcInput(originalEndAt)
            ? originalEndAt
            : parseScheduleUtcInput(endAt)
          : null,
        maxRuns: maxRuns.trim() ? Number(maxRuns) : null,
        allowAutoFinish,
      });
      setValidationError(null);
      props.onSave(draft);
    } catch {
      setValidationError(
        "Enter a name, instructions, valid schedule, and valid run limits before saving.",
      );
    }
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Scheduled follow-up editor"
      className="min-w-0 space-y-3"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !props.saving) {
          event.preventDefault();
          event.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={props.onCancel}
          disabled={props.saving}
          aria-label="Back to schedules"
        >
          <ArrowLeftIcon />
        </Button>
        <h3 className="text-sm font-medium">{record ? "Edit follow-up" : "New follow-up"}</h3>
      </div>
      <Field label="Name">
        {(id) => (
          <Input
            id={id}
            value={name}
            maxLength={SCHEDULED_FOLLOWUP_MAX_NAME_CHARS}
            required
            onChange={(event) => setName(event.target.value)}
            placeholder="Check build results"
          />
        )}
      </Field>
      <Field
        label="Instructions"
        help="Describe what to check, what should change, and when the task is finished."
      >
        {(id) => (
          <Textarea
            id={id}
            value={prompt}
            maxLength={SCHEDULED_FOLLOWUP_MAX_PROMPT_CHARS}
            required
            onChange={(event) => setPrompt(event.target.value)}
            className="max-h-60 overflow-y-auto"
          />
        )}
      </Field>
      <Field label="Repeat">
        {(id) => (
          <select
            id={id}
            className={selectClass}
            value={repeat}
            onChange={(event) => setRepeat(event.target.value as RepeatPreset)}
          >
            {(
              [
                ["once", "Once"],
                ["interval", "Interval"],
                ["daily", "Daily"],
                ["weekdays", "Weekdays"],
                ["weekly", "Weekly"],
                ["custom", "Custom calendar"],
              ] as const
            ).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {repeat === "interval" ? (
        <Field label="Every (minutes)">
          {(id) => (
            <Input
              id={id}
              nativeInput
              type="number"
              min={SCHEDULED_FOLLOWUP_MIN_INTERVAL_MINUTES}
              max={525600}
              step={1}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              required
            />
          )}
        </Field>
      ) : repeat === "once" ? (
        <Field label="Run at (UTC)">
          {(id) => (
            <Input
              id={id}
              nativeInput
              type="datetime-local"
              value={at}
              onChange={(event) => setAt(event.target.value)}
              required
            />
          )}
        </Field>
      ) : (
        <Field label="Time in selected timezone">
          {(id) => (
            <Input
              id={id}
              nativeInput
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              required
            />
          )}
        </Field>
      )}
      {repeat === "weekly" ? (
        <Field label="Day">
          {(id) => (
            <select
              id={id}
              className={selectClass}
              value={weekday}
              onChange={(event) => setWeekday(event.target.value)}
            >
              {WEEKDAYS.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      <Field label="Timezone" help="An IANA name such as Asia/Tokyo, America/New_York, or UTC.">
        {(id) => (
          <Input
            id={id}
            value={timeZone}
            maxLength={100}
            required
            onChange={(event) => setTimeZone(event.target.value)}
          />
        )}
      </Field>
      {repeat === "custom" ? (
        <div className="space-y-3 rounded-lg border border-border/60 p-3">
          <Field label="Weekdays (0–6)" help="Sunday is 0. Comma-separated; blank means every day.">
            {(id) => (
              <Input
                id={id}
                value={weekdays}
                onChange={(event) => setWeekdays(event.target.value)}
                placeholder="1,3,5"
              />
            )}
          </Field>
          <Field label="Days of month (1–31)">
            {(id) => (
              <Input
                id={id}
                value={monthDays}
                onChange={(event) => setMonthDays(event.target.value)}
                placeholder="Any day"
              />
            )}
          </Field>
          <Field
            label="Months (1–12)"
            help="Selected calendar conditions must all match. Invalid dates are skipped."
          >
            {(id) => (
              <Input
                id={id}
                value={months}
                onChange={(event) => setMonths(event.target.value)}
                placeholder="Any month"
              />
            )}
          </Field>
        </div>
      ) : null}
      <div className="rounded-lg bg-muted/35 p-3 text-xs" aria-label="Upcoming runs">
        <p className="mb-1 font-medium">Next runs · {timeZone}</p>
        {calendar.error ? (
          <p className="text-muted-foreground">{calendar.error}</p>
        ) : (
          <ol className="space-y-1 text-muted-foreground">
            {calendar.occurrences.map((instant) => (
              <li key={instant}>{formatScheduleTime(instant, timeZone)}</li>
            ))}
          </ol>
        )}
      </div>
      <details className="rounded-lg border border-border/60 p-3">
        <summary className="cursor-pointer text-xs font-medium">Model and run settings</summary>
        <div className="mt-3 min-w-0 space-y-3">
          <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
            Account: {scheduleAccountLabel(context.modelSelection, context.provider)}. This account
            will execute and pay for these follow-ups. Scheduling never changes accounts or expands
            permissions; an account change requires reviewing and enabling the schedule again.
          </p>
          <Field label="Model settings">
            {(id) => (
              <select
                id={id}
                className={selectClass}
                value={override ? "override" : "inherit"}
                onChange={(event) => setOverride(event.target.value === "override")}
              >
                <option value="inherit">Use this chat’s settings</option>
                <option value="override">Choose settings for follow-ups</option>
              </select>
            )}
          </Field>
          {override ? (
            <>
              <Field label="Model">
                {(id) => (
                  <select
                    id={id}
                    value={selection.model}
                    className={selectClass}
                    onChange={(event) =>
                      setSelection({
                        instanceId: context.modelSelection.instanceId,
                        model: event.target.value,
                      })
                    }
                  >
                    {!context.provider?.models.some((entry) => entry.slug === selection.model) ? (
                      <option value={selection.model}>{selection.model}</option>
                    ) : null}
                    {context.provider?.models.map((entry) => (
                      <option key={entry.slug} value={entry.slug}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {descriptors.map((descriptor) => (
                <Field key={descriptor.id} label={descriptor.label}>
                  {(id) =>
                    descriptor.type === "boolean" ? (
                      <input
                        id={id}
                        type="checkbox"
                        className="accent-primary"
                        checked={
                          (selection.options?.find((item) => item.id === descriptor.id)?.value ??
                            descriptor.currentValue ??
                            false) === true
                        }
                        onChange={(event) => setOption(descriptor.id, event.target.checked)}
                      />
                    ) : (
                      <select
                        id={id}
                        className={selectClass}
                        value={String(
                          selection.options?.find((item) => item.id === descriptor.id)?.value ??
                            descriptor.currentValue ??
                            descriptor.options.find((item) => item.isDefault)?.id ??
                            "",
                        )}
                        onChange={(event) => setOption(descriptor.id, event.target.value)}
                      >
                        <option value="" disabled>
                          Provider default
                        </option>
                        {descriptor.options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    )
                  }
                </Field>
              ))}
            </>
          ) : (
            <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
              Currently {scheduleModelLabel(context.modelSelection)}
            </p>
          )}
          <Field label="Notifications">
            {(id) => (
              <select
                id={id}
                className={selectClass}
                value={notificationPolicy}
                onChange={(event) =>
                  setNotificationPolicy(
                    event.target.value as ScheduledFollowupDraft["notificationPolicy"],
                  )
                }
              >
                <option value="changes-and-errors">Changes and errors</option>
                <option value="all-runs">Every run</option>
                <option value="errors-only">Errors only</option>
              </select>
            )}
          </Field>
          <Field label="End at (UTC)" help="Optional. Leave blank for no end date.">
            {(id) => (
              <Input
                id={id}
                nativeInput
                type="datetime-local"
                value={endAt}
                onChange={(event) => setEndAt(event.target.value)}
              />
            )}
          </Field>
          <Field label="Maximum runs" help="Optional. Each started run may use paid tokens.">
            {(id) => (
              <Input
                id={id}
                nativeInput
                type="number"
                min={1}
                max={SCHEDULED_FOLLOWUP_MAX_RUNS}
                step={1}
                value={maxRuns}
                onChange={(event) => setMaxRuns(event.target.value)}
                placeholder="No limit"
              />
            )}
          </Field>
          <label className="flex items-start gap-2 text-xs">
            <input
              className="mt-0.5 accent-primary"
              type="checkbox"
              checked={allowAutoFinish}
              onChange={(event) => setAllowAutoFinish(event.target.checked)}
            />
            <span>
              Allow the agent to finish this schedule when the instructions are satisfied.
            </span>
          </label>
        </div>
      </details>
      <p className="text-[11px] leading-4 text-muted-foreground">
        Runs in this chat while its Cafe backend is online and awake. Busy chats wait; missed checks
        are combined, not replayed in a flood. Existing approval requirements remain in effect.
      </p>
      {validationError || props.error ? (
        <p role="alert" className="break-words text-xs text-destructive">
          {validationError ?? props.error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={props.saving}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={props.saving || Boolean(calendar.error) || context.unavailable}
        >
          {props.saving
            ? "Saving…"
            : record?.state === "pending_confirmation"
              ? "Approve & enable"
              : record
                ? "Save changes"
                : "Create follow-up"}
        </Button>
      </div>
    </form>
  );
}
