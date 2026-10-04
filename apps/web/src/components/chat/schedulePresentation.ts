import type { ModelSelection, ServerProvider } from "@cafecode/contracts";

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
      id === "reasoningEffort" || id === "effort" ? "Effort" : id === "fastMode" ? "Fast" : id;
    return `${label}: ${typeof value === "boolean" ? (value ? "on" : "off") : value}`;
  });
  return [selection.model, ...options].join(" · ");
}

export function formatScheduleTime(instant: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(instant));
  } catch {
    // Persisted records should already be validated. Never turn one unknown
    // timezone or corrupt legacy timestamp into a broken Tasks surface.
    return "Time unavailable";
  }
}

/** Inputs use UTC explicitly for absolute stop/one-shot instants. Calendar
 * recurrence has its own IANA timezone and never uses the browser's local zone
 * to reinterpret an existing schedule. */
export function scheduleUtcInput(instant: string | null): string {
  return instant ? instant.slice(0, 16) : "";
}

export function parseScheduleUtcInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === value
    ? date.toISOString()
    : null;
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
    throw new Error(`Use comma-separated numbers from ${minimum} to ${maximum}.`);
  }
  const values = parts.map(Number);
  if (values.some((item) => item < minimum || item > maximum)) {
    throw new Error(`Use numbers from ${minimum} to ${maximum}.`);
  }
  return [...new Set(values)].toSorted((left, right) => left - right);
}

export function browserScheduleTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}
