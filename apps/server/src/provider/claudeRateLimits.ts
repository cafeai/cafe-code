/**
 * Maps Claude Code's `rate_limit_event` (surfaced as the `account.rate-limits.updated`
 * runtime event) into a single rate-limit window for the `ServerProviderAccountRateLimits`
 * snapshot.
 *
 * The Claude Agent SDK emits one window per event — `rate_limit_info.rateLimitType`
 * names the currently-binding window (the server's "representative claim"), so we map
 * each event to one slot and let the registry accumulate the latest per slot:
 *   - `five_hour`                                             → primary   (5h window)
 *   - `seven_day` / model variants / overage-included weekly   → secondary (weekly window)
 *   - `overage` / anything else                               → skipped (null)
 *
 * `utilization` is frequently absent (it's only populated near a threshold). When it's
 * missing we emit a window with only `resetsAt`; the UI then shows the reset and reports
 * usage as "unknown" rather than fabricating a percentage.
 *
 * @module claudeRateLimits
 */
import type { ServerProviderAccountRateLimitWindow } from "@cafecode/contracts";

const FIVE_HOUR_WINDOW_MINS = 300;
const SEVEN_DAY_WINDOW_MINS = 10_080;

export type ClaudeRateLimitSlot = "primary" | "secondary";

export interface ClaudeRateLimitWindowUpdate {
  readonly slot: ClaudeRateLimitSlot;
  readonly window: ServerProviderAccountRateLimitWindow;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const numeric = readFiniteNumber(value);
  return numeric !== undefined && Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Pull the `rate_limit_info` object out of the raw runtime payload. Accepts either the
 * full SDK event (`{ type: "rate_limit_event", rate_limit_info: {...} }`) or an already
 * unwrapped info object (`{ rateLimitType, ... }`).
 */
function extractRateLimitInfo(raw: unknown): Record<string, unknown> | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const nested = asRecord(record.rate_limit_info);
  if (nested) return nested;
  return "rateLimitType" in record ? record : undefined;
}

function slotForRateLimitType(rateLimitType: unknown): ClaudeRateLimitSlot | undefined {
  if (rateLimitType === "five_hour") return "primary";
  if (
    rateLimitType === "seven_day" ||
    rateLimitType === "seven_day_opus" ||
    rateLimitType === "seven_day_sonnet" ||
    rateLimitType === "seven_day_overage_included"
  ) {
    return "secondary";
  }
  return undefined;
}

/**
 * Parse a Claude `account.rate-limits.updated` payload (`event.payload.rateLimits`) into
 * a single window update, or `null` when the event carries no window we surface
 * (e.g. `overage`, or an unrecognized shape).
 */
export function parseClaudeRateLimitUpdate(raw: unknown): ClaudeRateLimitWindowUpdate | null {
  const info = extractRateLimitInfo(raw);
  if (!info) return null;

  const slot = slotForRateLimitType(info.rateLimitType);
  if (!slot) return null;

  // `utilization` is a 0-1 fraction (confirmed from live `rate_limit_info`: values top
  // out at 1.0, alongside a `surpassedThreshold` of 0.9). Scale to a 0-100 percentage for
  // `usedPercent`; the formatter clamps and rounds for display.
  const utilization = readFiniteNumber(info.utilization);
  const usedPercent = utilization !== undefined ? utilization * 100 : undefined;
  const resetsAt = readPositiveInteger(info.resetsAt);

  const window: ServerProviderAccountRateLimitWindow = {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    windowDurationMins: slot === "primary" ? FIVE_HOUR_WINDOW_MINS : SEVEN_DAY_WINDOW_MINS,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };

  return { slot, window };
}
