import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSessionQuotaReport,
} from "@cafecode/contracts";

/** Resolve only the selected instance's driver. A retained session/status from
 * another account must not turn the newly selected Codex/Grok account into a
 * Claude quota consumer while its catalog is still hydrating. */
export function selectedQuotaDriver(input: {
  readonly instanceId: ProviderInstanceId;
  readonly configuredDriver?: ProviderDriverKind | undefined;
  readonly snapshot?: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
  } | null;
  readonly session?: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider: ProviderDriverKind;
  } | null;
}): ProviderDriverKind | undefined {
  if (input.configuredDriver) return input.configuredDriver;
  if (input.snapshot?.instanceId === input.instanceId) return input.snapshot.driver;
  if (
    input.instanceId === "codex" ||
    input.instanceId === "claudeAgent" ||
    input.instanceId === "grok"
  )
    return ProviderDriverKind.make(input.instanceId);
  return input.session?.providerInstanceId === input.instanceId
    ? input.session.provider
    : undefined;
}

/** A receipt age is presentation metadata, not a proof of endpoint freshness.
 * Older readings remain inspectable, but must never look like live allowance. */
export const CLAUDE_QUOTA_STALE_AFTER_MS = 5 * 60_000;

export interface ClaudeSessionQuotaPresentation {
  readonly observed: string;
  readonly stale: boolean;
  readonly meters:
    | readonly {
        readonly id: string;
        readonly group: string;
        readonly label: string;
        readonly value: string;
        readonly remainingPercent: number;
        readonly reset: string | null;
        readonly stale: boolean;
        readonly severity: string;
        readonly isActive: boolean;
      }[]
    | null;
  readonly extraUsage: readonly string[];
}

interface FormatOptions {
  readonly now?: number;
  readonly locale?: string;
  readonly timeZone?: string;
}

function localTime(instant: string, options: FormatOptions): string | null {
  const value = Date.parse(instant);
  if (!Number.isFinite(value)) return null;
  try {
    return new Intl.DateTimeFormat(options.locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }).format(new Date(value));
  } catch {
    return null;
  }
}

function percent(value: number, locale?: string): string {
  // Do not round the provider's meaningful precision to a whole percentage.
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 12 }).format(value);
}

/** Currency metadata is not permission to assume dollars. Construct the amount
 * from integer minor units, preserving cents even at the safe-integer bound. */
function minorAmount(amount: number, currency: string | null | undefined, locale?: string): string {
  const code = currency?.toUpperCase();
  const supported =
    typeof code === "string" &&
    /^[A-Z]{3}$/u.test(code) &&
    Intl.supportedValuesOf("currency").includes(code);
  if (!supported)
    return `${new Intl.NumberFormat(locale).format(amount)} minor units (${currency ? `currency: ${currency}; conversion unavailable` : "currency unavailable"})`;
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
    currencyDisplay: "code",
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const divisor = 10n ** BigInt(digits);
  const units = BigInt(amount);
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).formatToParts(
    units / divisor,
  );
  const fraction = (units % divisor).toString().padStart(digits, "0");
  return formatter
    .formatToParts(0)
    .flatMap((part) =>
      part.type === "integer"
        ? whole
        : [{ ...part, value: part.type === "fraction" ? fraction : part.value }],
    )
    .map((part) => part.value)
    .join("");
}

/** Preserve native row order and scope. Names are inert display labels, never
 * identities: two identically labelled meters remain separate snapshot rows. */
export function formatClaudeSessionQuota(
  report: ProviderSessionQuotaReport,
  options: FormatOptions = {},
): ClaudeSessionQuotaPresentation {
  const now = options.now ?? Date.now();
  const received = Date.parse(report.observedAt);
  const stale =
    !Number.isFinite(received) || now < received || now - received >= CLAUDE_QUOTA_STALE_AFTER_MS;
  return {
    observed: `Received: ${localTime(report.observedAt, options) ?? "time unavailable"}`,
    stale,
    meters:
      report.meters?.map((meter, index) => {
        const expired = meter.resetsAt !== null && Date.parse(meter.resetsAt) <= now;
        const rowStale = stale || expired;
        const remaining = 100 - meter.usedPercent;
        return {
          id: `meter-${index}`,
          group:
            meter.group === "session"
              ? "Session"
              : meter.group === "weekly"
                ? "Weekly"
                : meter.group,
          label: [
            meter.kind === "session"
              ? "Session window"
              : meter.kind === "weekly_all"
                ? "Weekly (all models)"
                : meter.kind === "weekly_scoped"
                  ? "Weekly"
                  : meter.kind,
            meter.modelLabel,
            meter.surfaceLabel,
          ]
            .filter(Boolean)
            .join(" · "),
          value: `${rowStale ? "Last reported: " : ""}${percent(remaining, options.locale)}% left`,
          remainingPercent: remaining,
          reset: meter.resetsAt
            ? `${expired ? "Reset passed" : "Resets"}: ${localTime(meter.resetsAt, options) ?? "time unavailable"}`
            : null,
          stale: rowStale,
          severity: meter.severity,
          isActive: meter.isActive,
        };
      }) ?? null,
    extraUsage:
      report.extraUsage === undefined
        ? ["Extra usage not reported."]
        : report.extraUsage === null
          ? ["Extra usage unavailable."]
          : [
              `Extra usage: ${report.extraUsage.enabled ? "Enabled" : "Disabled"}`,
              report.extraUsage.usedPercent !== null
                ? `${percent(report.extraUsage.usedPercent, options.locale)}% of extra-usage limit used`
                : "Extra-usage utilization: Unavailable",
              report.extraUsage.usedCredits !== null
                ? `Used: ${minorAmount(report.extraUsage.usedCredits, report.extraUsage.currency, options.locale)}`
                : "Used: Unavailable",
              report.extraUsage.monthlyLimit !== null
                ? `Monthly limit: ${minorAmount(report.extraUsage.monthlyLimit, report.extraUsage.currency, options.locale)}`
                : "Monthly limit: Unavailable",
            ],
  };
}
