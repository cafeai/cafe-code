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
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "../ui/button";
import { InfoTip } from "../ui/info-tip";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import type { ScheduledFollowupsContext } from "./ScheduledFollowups";
import {
  browserScheduleTimeZone,
  formatScheduleTime,
  parseScheduleNumbers,
  parseScheduleZonedInput,
  scheduleAccountLabel,
  scheduleModelLabel,
  scheduleTimeZoneOptions,
  scheduleZonedInput,
} from "./schedulePresentation";

type RepeatPreset = "once" | "interval" | "daily" | "weekdays" | "weekly" | "custom";
const decodeDraft = Schema.decodeUnknownSync(ScheduledFollowupDraft);
const decodeRecurrence = Schema.decodeUnknownSync(ScheduledFollowupRecurrence);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const REPEAT_OPTIONS: ReadonlyArray<{ value: RepeatPreset; label: string }> = [
  { value: "once", label: "Once" },
  { value: "interval", label: "Interval" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom calendar" },
];
const NOTIFICATION_OPTIONS: ReadonlyArray<{
  value: ScheduledFollowupDraft["notificationPolicy"];
  label: string;
}> = [
  { value: "changes-and-errors", label: "Changes and errors" },
  { value: "all-runs", label: "Every run" },
  { value: "errors-only", label: "Errors only" },
];

/** A labelled dropdown for the editor's fixed choices. The trigger takes the
 * Field's id so its visible label stays the accessible name. */
function EditorSelect<Value extends string>(props: {
  id: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string; disabled?: boolean }>;
  onChange: (value: Value) => void;
}) {
  const selected = props.options.find((option) => option.value === props.value);
  return (
    <Select
      value={props.value}
      onValueChange={(next) => {
        const match = props.options.find((option) => option.value === next);
        if (match && !match.disabled) props.onChange(match.value);
      }}
    >
      <SelectTrigger id={props.id} size="sm" className="w-full min-w-0">
        <SelectValue>{selected?.label ?? props.value}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {props.options.map((option) => (
          <SelectItem
            hideIndicator
            key={option.value}
            value={option.value}
            disabled={option.disabled ?? false}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

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
      {props.help ? <p className="text-2xs text-muted-foreground">{props.help}</p> : null}
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
  const localTimeZone = browserScheduleTimeZone();
  const timeZoneOptions = useMemo(
    () => scheduleTimeZoneOptions(timeZone, localTimeZone),
    [timeZone, localTimeZone],
  );
  const [minutes, setMinutes] = useState(
    String(recurrence?.kind === "interval" ? recurrence.everyMinutes : 5),
  );
  const [at, setAt] = useState(() =>
    scheduleZonedInput(
      recurrence?.kind === "once"
        ? recurrence.at
        : new Date(Date.parse(openedAt) + 3_600_000).toISOString(),
      timeZone,
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
  const [endAt, setEndAt] = useState(() => scheduleZonedInput(record?.endAt ?? null, timeZone));
  const [endAtReviewed, setEndAtReviewed] = useState(false);
  const [maxRuns, setMaxRuns] = useState(record?.maxRuns?.toString() ?? "");
  const [allowAutoFinish, setAllowAutoFinish] = useState(record?.allowAutoFinish ?? false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const originalEndAt = record?.endAt ?? null;
  // An existing UTC limit can be valid while its civil year is outside the
  // native four-digit input range (or its saved zone is unavailable). An empty
  // control in that case is not human intent to remove a paid-execution limit.
  // Require an explicit replacement/clear instead of silently saving null.
  const endAtNeedsReview =
    originalEndAt !== null &&
    !endAtReviewed &&
    scheduleZonedInput(originalEndAt, recurrence?.timeZone ?? timeZone) === "";

  const calendar = useMemo(() => {
    if (endAtNeedsReview) {
      return {
        value: null,
        occurrences: [],
        error:
          "Review the saved end date in Model and run settings: enter a new date or explicitly clear it.",
      };
    }
    try {
      let value: ScheduledFollowupRecurrence;
      if (repeat === "once") {
        // Native minute-resolution controls must not silently truncate an
        // existing second/millisecond instant when only instructions change.
        const parsed =
          recurrence?.kind === "once" &&
          timeZone === recurrence.timeZone &&
          at === scheduleZonedInput(recurrence.at, recurrence.timeZone)
            ? recurrence.at
            : parseScheduleZonedInput(at, timeZone);
        if (!parsed) throw new Error("Choose a valid date and time in the selected timezone.");
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
        ? originalEndAt &&
          timeZone === recurrence?.timeZone &&
          endAt === scheduleZonedInput(originalEndAt, recurrence.timeZone)
          ? originalEndAt
          : parseScheduleZonedInput(endAt, timeZone)
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
    endAtNeedsReview,
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
          ? originalEndAt &&
            timeZone === recurrence?.timeZone &&
            endAt === scheduleZonedInput(originalEndAt, recurrence.timeZone)
            ? originalEndAt
            : parseScheduleZonedInput(endAt, timeZone)
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
        // React bubbles portalled dropdown keystrokes through this form; Escape
        // inside an open Select closes only that dropdown, not the editor.
        if (
          event.target instanceof Element &&
          event.target.closest('[data-slot="select-popup"]') !== null
        ) {
          return;
        }
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
          <EditorSelect id={id} value={repeat} options={REPEAT_OPTIONS} onChange={setRepeat} />
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
        <Field label="Run at" help={`Time in ${timeZone}. The preview below uses your local time.`}>
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
            <EditorSelect
              id={id}
              value={weekday}
              options={WEEKDAYS.map((label, index) => ({ value: String(index), label }))}
              onChange={setWeekday}
            />
          )}
        </Field>
      ) : null}
      <Field
        label="Timezone"
        help={`Scheduling uses this timezone. Your computer's local timezone is ${localTimeZone}.`}
      >
        {(id) => (
          <EditorSelect
            id={id}
            value={timeZone}
            options={[
              ...(!timeZoneOptions.includes(timeZone)
                ? [{ value: timeZone, label: "Unavailable timezone", disabled: true }]
                : []),
              ...timeZoneOptions.map((zone) => ({
                value: zone,
                label: zone === localTimeZone ? `${zone} (computer local time)` : zone,
              })),
            ]}
            onChange={setTimeZone}
          />
        )}
      </Field>
      {repeat === "custom" ? (
        <div className="animate-enter-rise space-y-3 rounded-lg border border-border-subtle p-3">
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
      <div className="rounded-lg bg-muted p-3 text-xs" aria-label="Upcoming runs">
        <p className="mb-1 font-medium">Next runs · local time · {localTimeZone}</p>
        {calendar.error ? (
          <p className="text-muted-foreground">{calendar.error}</p>
        ) : (
          <ol className="space-y-1 text-muted-foreground tabular-nums">
            {calendar.occurrences.map((instant) => (
              <li key={instant}>{formatScheduleTime(instant)}</li>
            ))}
          </ol>
        )}
      </div>
      <details className="group/run-settings rounded-lg border border-border-subtle p-3">
        <summary className="focus-ring flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-xs font-medium [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-fast) ease-out group-open/run-settings:rotate-90"
          />
          Model and run settings
        </summary>
        <div className="mt-3 min-w-0 animate-enter-rise space-y-3">
          {/* Billing disclosure stays visible; scope details live in the tip. */}
          <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
            <span>
              Account: {scheduleAccountLabel(context.modelSelection, context.provider)}. This
              account will execute and pay for these follow-ups.
            </span>{" "}
            <InfoTip label="About the follow-up account">
              Scheduling never changes accounts or expands permissions; an account change requires
              reviewing and enabling the schedule again.
            </InfoTip>
          </p>
          <Field label="Model settings">
            {(id) => (
              <EditorSelect
                id={id}
                value={override ? "override" : "inherit"}
                options={[
                  { value: "inherit", label: "Use this chat’s settings" },
                  { value: "override", label: "Choose settings for follow-ups" },
                ]}
                onChange={(next) => setOverride(next === "override")}
              />
            )}
          </Field>
          {override ? (
            <>
              <Field label="Model">
                {(id) => (
                  <EditorSelect
                    id={id}
                    value={selection.model}
                    options={[
                      ...(!context.provider?.models.some((entry) => entry.slug === selection.model)
                        ? [{ value: selection.model, label: selection.model }]
                        : []),
                      ...(context.provider?.models.map((entry) => ({
                        value: entry.slug,
                        label: entry.name,
                      })) ?? []),
                    ]}
                    onChange={(model) =>
                      setSelection({
                        instanceId: context.modelSelection.instanceId,
                        model,
                      })
                    }
                  />
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
                      <EditorSelect
                        id={id}
                        value={String(
                          selection.options?.find((item) => item.id === descriptor.id)?.value ??
                            descriptor.currentValue ??
                            descriptor.options.find((item) => item.isDefault)?.id ??
                            "",
                        )}
                        options={[
                          { value: "", label: "Provider default", disabled: true },
                          ...descriptor.options.map((option) => ({
                            value: option.id,
                            label: option.label,
                          })),
                        ]}
                        onChange={(next) => setOption(descriptor.id, next)}
                      />
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
              <EditorSelect
                id={id}
                value={notificationPolicy}
                options={NOTIFICATION_OPTIONS}
                onChange={setNotificationPolicy}
              />
            )}
          </Field>
          <Field
            label="End at"
            help={`Optional. Time in ${timeZone}; leave blank for no end date.`}
          >
            {(id) => (
              <Input
                id={id}
                nativeInput
                type="datetime-local"
                value={endAt}
                onChange={(event) => {
                  setEndAtReviewed(true);
                  setEndAt(event.target.value);
                }}
              />
            )}
          </Field>
          {endAtNeedsReview ? (
            <div className="space-y-2 text-xs">
              <p className="text-muted-foreground">
                The saved end limit cannot be shown in its scheduling timezone. Saved limit:{" "}
                {formatScheduleTime(originalEndAt!)}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setEndAtReviewed(true);
                  setEndAt("");
                }}
              >
                Clear saved end date
              </Button>
            </div>
          ) : null}
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
      <p className="flex items-center gap-1 text-2xs text-muted-foreground">
        Runs in this chat while its Cafe server is online.
        <InfoTip label="About follow-up runs">
          Runs only while the server is awake. Busy chats wait; missed checks are combined, not
          replayed in a flood. Existing approval requirements remain in effect.
        </InfoTip>
      </p>
      {validationError || props.error ? (
        <p role="alert" className="break-words text-xs text-destructive-foreground">
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
