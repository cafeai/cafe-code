import type {
  ServerProvider,
  ServerProviderAccountRateLimitSnapshot,
  ServerProviderAccountRateLimitWindow,
  ServerProviderAccountRateLimits,
} from "@cafecode/contracts";

export function shouldSurfaceProviderAccountRateLimits(
  provider: Pick<ServerProvider, "auth" | "driver"> | null | undefined,
): boolean {
  return (
    provider?.auth.status === "authenticated" &&
    (provider.driver === "codex" || provider.driver === "claudeAgent" || provider.driver === "grok")
  );
}

export interface CodexRateLimitSummaryLine {
  readonly label: string;
  readonly value: string;
  readonly text: string;
}

export interface CodexRateLimitWindowSummary extends CodexRateLimitSummaryLine {
  readonly remainingPercent: number;
}

export interface CodexRateLimitSummary {
  readonly primary: CodexRateLimitWindowSummary | null;
  readonly secondary: CodexRateLimitWindowSummary | null;
  readonly primaryReset: string | null;
  readonly secondaryReset: string | null;
  readonly details: readonly CodexRateLimitSummaryLine[];
}

export interface CodexRateLimitBucket {
  readonly id: string;
  readonly label: string;
  readonly snapshot: ServerProviderAccountRateLimitSnapshot;
}

export interface CodexRateLimitBucketSummary extends CodexRateLimitSummary {
  readonly id: string;
  readonly label: string;
}

export interface CodexRateLimitPresentation {
  readonly buckets: readonly CodexRateLimitBucketSummary[];
  readonly resetAvailability: string | null;
}

interface FormatOptions {
  readonly locale?: string;
  readonly timeZone?: string;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatPercentage(value: number): string {
  const rounded = Math.round(clampPercentage(value) * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function formatWindowDuration(minutes: number | null | undefined): string | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }

  let remainingMinutes = Math.round(minutes);
  if (remainingMinutes <= 0) {
    return null;
  }

  const parts: Array<string> = [];
  const appendPart = (value: number, unit: "day" | "hour" | "minute") => {
    if (value > 0) {
      parts.push(`${value} ${unit}${value === 1 ? "" : "s"}`);
    }
  };

  const days = Math.floor(remainingMinutes / 1_440);
  remainingMinutes %= 1_440;
  const hours = Math.floor(remainingMinutes / 60);
  const remaining = remainingMinutes % 60;

  appendPart(days, "day");
  appendPart(hours, "hour");
  appendPart(remaining, "minute");

  return parts.join(", ");
}

function formatShortDuration(minutes: number | null | undefined): string | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  const rounded = Math.round(minutes);
  if (rounded <= 0) return null;
  const days = Math.floor(rounded / 1_440);
  const hours = Math.floor((rounded % 1_440) / 60);
  const remainder = rounded % 60;
  return [days ? `${days}d` : null, hours ? `${hours}h` : null, remainder ? `${remainder}m` : null]
    .filter(Boolean)
    .join(" ");
}

function formatResetTime(epochSeconds: number, options: FormatOptions): string | null {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  try {
    return new Intl.DateTimeFormat(options.locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }).format(new Date(epochSeconds * 1_000));
  } catch {
    return null;
  }
}

function formatWindowLine(input: {
  readonly label: "Primary window" | "Secondary window";
  readonly durationLabel: string | null;
  readonly window: ServerProviderAccountRateLimitWindow | null | undefined;
}): CodexRateLimitWindowSummary | null {
  // Only render a usage line when we actually have a usage figure. A window with just a
  // reset time (Claude omits utilization unless you're near the limit) is surfaced through
  // its reset line (primaryReset / secondaryReset) instead — no usage line. An absent window
  // is omitted entirely.
  const usedPercent = input.window?.usedPercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return null;
  }
  const label = input.durationLabel ? `${input.label} (${input.durationLabel})` : input.label;
  const remainingPercent = clampPercentage(100 - usedPercent);
  const value = `${formatPercentage(remainingPercent)} left`;
  return {
    label,
    value,
    text: `${label}: ${value}`,
    remainingPercent,
  };
}

/** The app-server contract defines the map as the multi-bucket view and the
 * legacy snapshot as a backward-compatible single-bucket view:
 * https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt
 * Match bucket identities, never balances or model names: distinct quotas can
 * report identical usage. The map is authoritative for a represented bucket. */
export function selectCodexRateLimitBuckets(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
): readonly CodexRateLimitBucket[] {
  if (!rateLimits) return [];
  const buckets = Object.entries(rateLimits.rateLimitsByLimitId ?? {}).map(([id, snapshot]) => ({
    id,
    label: snapshot.limitName ?? snapshot.limitId ?? id,
    snapshot,
  }));
  const legacy = rateLimits.rateLimits;
  const legacyId = legacy.limitId ?? "codex";
  if (!buckets.some((bucket) => bucket.id === legacyId || bucket.snapshot.limitId === legacyId)) {
    buckets.unshift({
      id: legacyId,
      label: legacy.limitName ?? legacy.limitId ?? "Account usage",
      snapshot: legacy,
    });
  }
  // Keep the familiar default quota first without assigning named buckets to
  // particular models or combining them into an invented account-wide limit.
  return buckets.toSorted((left, right) =>
    left.id === "codex" ? (right.id === "codex" ? 0 : -1) : right.id === "codex" ? 1 : 0,
  );
}

export function selectCodexRateLimitSnapshot(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
): ServerProviderAccountRateLimitSnapshot | null {
  return selectCodexRateLimitBuckets(rateLimits)[0]?.snapshot ?? null;
}

export function formatCodexRateLimitResetAvailability(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
): string | null {
  const availableCount = selectCodexAvailableResetCount(rateLimits);
  return availableCount === null ? null : `Usage limit resets available: ${availableCount}`;
}

export function selectCodexAvailableResetCount(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
): number | null {
  const availableCount = rateLimits?.rateLimitResetCredits?.availableCount;
  if (
    typeof availableCount !== "number" ||
    !Number.isSafeInteger(availableCount) ||
    availableCount < 0
  ) {
    return null;
  }

  // Upstream reports an authoritative aggregate because the optional credit list can be
  // absent or redacted. Never infer availability by counting those detail rows.
  return availableCount;
}

/** Round display-only decimal metadata without converting it to a Number.
 * Arbitrarily large integers and tiny fractions must retain their exact value
 * until rounding to hundredths. Increment the unsigned magnitude at a half,
 * then restore a negative sign only for nonzero output (half away from zero).
 * A nondecimal provider string remains opaque metadata, not a numeric amount. */
function formatCreditBalance(balance: string): string | null {
  const decimal = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/u.exec(balance);
  if (!decimal) return null;
  const integer = (decimal[2] ?? "0").replace(/^0+(?=\d)/u, "");
  const fraction = decimal[3] ?? decimal[4] ?? "";
  const hundredths = [...`${integer}${fraction.slice(0, 2).padEnd(2, "0")}`];
  if (fraction.length > 2 && fraction[2]! >= "5") {
    let index = hundredths.length - 1;
    while (index >= 0 && hundredths[index] === "9") {
      hundredths[index] = "0";
      index -= 1;
    }
    if (index < 0) hundredths.unshift("1");
    else hundredths[index] = String.fromCharCode(hundredths[index]!.charCodeAt(0) + 1);
  }
  const digits = hundredths.join("");
  const whole = digits.slice(0, -2);
  const remainder = digits.slice(-2).replace(/0+$/u, "");
  const sign = decimal[1] === "-" && (whole !== "0" || remainder !== "") ? "-" : "";
  // Group only the rounded integer, without floating-point conversion. Chunk
  // once in linear time even for unusually long provider-supplied decimals.
  const groups: string[] = [];
  for (let end = whole.length; end > 0; end -= 3) {
    groups.push(whole.slice(Math.max(0, end - 3), end));
  }
  return `${sign}${groups.toReversed().join(",")}${remainder ? `.${remainder}` : ""}`;
}

function formatCreditValue(
  credits: NonNullable<ServerProviderAccountRateLimitSnapshot["credits"]>,
): string {
  const balance = credits.balance?.trim();
  const rounded = balance ? formatCreditBalance(balance) : null;
  const displayBalance = rounded ?? balance;
  if (credits.unlimited)
    return displayBalance ? `Unlimited (balance: ${displayBalance})` : "Unlimited";
  if (!balance) return credits.hasCredits ? "Available (balance not reported)" : "None available";

  // Amounts are provider decimal strings, not floating-point numbers or
  // currency. Availability uses the original unrounded value, never its
  // display projection: a tiny nonzero amount that rounds to zero must not
  // override hasCredits=false. A genuinely reported decimal zero is safe to
  // describe as zero available; all other amounts require the provider flag.
  const zero = /^[+-]?(?:0+(?:\.0*)?|\.0+)$/u.test(balance);
  if ((credits.hasCredits && rounded !== null) || zero) return `${displayBalance} available`;
  return `${credits.hasCredits ? "Available" : "None available"} (balance: ${displayBalance})`;
}

function formatSnapshot(
  snapshot: ServerProviderAccountRateLimitSnapshot,
  options: FormatOptions,
): CodexRateLimitSummary | null {
  const primary = formatWindowLine({
    label: "Primary window",
    durationLabel: formatWindowDuration(snapshot.primary?.windowDurationMins),
    window: snapshot.primary,
  });
  const secondary = formatWindowLine({
    label: "Secondary window",
    durationLabel: formatWindowDuration(snapshot.secondary?.windowDurationMins),
    window: snapshot.secondary,
  });
  const primaryResetAt = snapshot.primary?.resetsAt ?? null;
  const primaryResetTime = primaryResetAt ? formatResetTime(primaryResetAt, options) : null;
  const primaryResetLabel = formatShortDuration(snapshot.primary?.windowDurationMins) ?? "Primary";
  const primaryReset = primaryResetTime ? `${primaryResetLabel} reset: ${primaryResetTime}` : null;

  const secondaryResetAt = snapshot.secondary?.resetsAt ?? null;
  const secondaryResetTime = secondaryResetAt ? formatResetTime(secondaryResetAt, options) : null;
  const secondaryResetLabel =
    formatShortDuration(snapshot.secondary?.windowDurationMins) ?? "Secondary";
  const secondaryReset = secondaryResetTime
    ? `${secondaryResetLabel} reset: ${secondaryResetTime}`
    : null;
  const details: CodexRateLimitSummaryLine[] = [];
  const append = (label: string, value: string) =>
    details.push({ label, value, text: `${label}: ${value}` });
  const credits = snapshot.credits;
  if (credits) {
    append("Credits", formatCreditValue(credits));
  }
  const individual = snapshot.individualLimit;
  if (individual) {
    // One row for one limit: amount, remaining share and reset together.
    const remaining = Number.isFinite(individual.remainingPercent)
      ? ` (${formatPercentage(individual.remainingPercent)} left)`
      : "";
    const reset = formatResetTime(individual.resetsAt, options);
    append(
      "Individual spend limit",
      `${individual.used} used of ${individual.limit}${remaining}${reset ? `, resets ${reset}` : ""}`,
    );
  }
  // Only a reached spend control is worth a row; "not reached" is the normal
  // state and restates nothing the usage windows don't already show.
  if (snapshot.spendControlReached === true) {
    append("Spend control", "Limit reached");
  }
  const reason = snapshot.rateLimitReachedType?.trim();
  if (reason) {
    // These values come from Codex's generated RateLimitReachedType. Preserve
    // future identifiers as inert text instead of guessing their billing cause.
    const reasons = new Map([
      ["rate_limit_reached", "Usage limit reached"],
      ["workspace_owner_credits_depleted", "Workspace owner credits depleted"],
      ["workspace_member_credits_depleted", "Workspace member credits depleted"],
      ["workspace_owner_usage_limit_reached", "Workspace owner usage limit reached"],
      ["workspace_member_usage_limit_reached", "Workspace member usage limit reached"],
    ]);
    append("Limit reached", reasons.get(reason) ?? reason);
  }

  if (!primary && !secondary && !primaryReset && !secondaryReset && details.length === 0) {
    return null;
  }

  return {
    primary,
    secondary,
    primaryReset,
    secondaryReset,
    details,
  };
}

export function formatCodexRateLimitBuckets(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
  options: FormatOptions = {},
): readonly CodexRateLimitBucketSummary[] {
  return selectCodexRateLimitBuckets(rateLimits).flatMap(({ id, label, snapshot }) => {
    const summary = formatSnapshot(snapshot, options);
    return summary ? [{ id, label, ...summary }] : [];
  });
}

export function formatCodexRateLimitSummary(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
  options: FormatOptions = {},
): CodexRateLimitSummary | null {
  return formatCodexRateLimitBuckets(rateLimits, options)[0] ?? null;
}

export function formatCodexRateLimitPresentation(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
  options: FormatOptions = {},
): CodexRateLimitPresentation | null {
  const buckets = formatCodexRateLimitBuckets(rateLimits, options);
  const resetAvailability = formatCodexRateLimitResetAvailability(rateLimits);
  return buckets.length || resetAvailability ? { buckets, resetAvailability } : null;
}

export function formatCodexRateLimitInlineText(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
  options: FormatOptions = {},
): string | null {
  const buckets = formatCodexRateLimitBuckets(rateLimits, options);
  const parts = buckets.map((summary) => {
    const text = [
      summary.primary?.text,
      summary.secondary?.text,
      summary.primaryReset,
      summary.secondaryReset,
      ...summary.details.map((line) => line.text),
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    return buckets.length > 1 || summary.id !== "codex" ? `${summary.label}: ${text}` : text;
  });
  return parts.length > 0 ? parts.join(" · ") : null;
}
