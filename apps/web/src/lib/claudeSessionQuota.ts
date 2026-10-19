import { uiFormatDateTime, uiFormatNumber, uiText } from "@cafecode/shared/i18n";
import {
  ProviderDriverKind,
  type OrchestrationSessionStatus,
  type ProviderInstanceId,
  type ProviderSessionQuotaInput,
  type ProviderSessionQuotaReport,
  type ThreadId,
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

/** Account allowances exist before a chat's first native query. A matching
 * query may also supply its passive fallback; without one, accept only the
 * selected account's control-only report, including from older remote owners
 * that might otherwise return another chat's passive report. */
export function claudeChatQuotaScope(input: {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId | null;
  readonly session?:
    | {
        readonly provider: ProviderDriverKind;
        readonly providerInstanceId?: ProviderInstanceId | undefined;
        readonly subagentRuntimeId?: string | null | undefined;
        readonly orchestrationStatus: OrchestrationSessionStatus;
      }
    | null
    | undefined;
}): { readonly input: ProviderSessionQuotaInput; readonly nativeOnly: boolean } {
  const session = input.session;
  if (
    input.threadId &&
    session?.provider === "claudeAgent" &&
    session.providerInstanceId === input.instanceId &&
    session.orchestrationStatus !== "stopped" &&
    session.orchestrationStatus !== "error" &&
    session.subagentRuntimeId
  ) {
    return {
      input: {
        instanceId: input.instanceId,
        session: { threadId: input.threadId, runtimeId: session.subagentRuntimeId },
      },
      nativeOnly: false,
    };
  }
  return { input: { instanceId: input.instanceId }, nativeOnly: true };
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
  readonly extraUsageSummary: string | null;
}

interface FormatOptions {
  readonly now?: number;
  readonly locale?: string;
  readonly timeZone?: string;
  readonly selectedModel?: string | null | undefined;
}

function localTime(instant: string, options: FormatOptions): string | null {
  const value = Date.parse(instant);
  if (!Number.isFinite(value)) return null;
  try {
    return uiFormatDateTime(
      new Date(value),
      {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
        ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      },
      options.locale,
    );
  } catch {
    return null;
  }
}

function percent(value: number, locale?: string): string {
  // Do not round the provider's meaningful precision to a whole percentage.
  return uiFormatNumber(value, { maximumFractionDigits: 12 }, locale);
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
    return uiText(
      "{amount} minor units ({currencyKnown, select, yes {currency: {currency}; conversion unavailable} other {currency unavailable}})",
      {
        amount: uiFormatNumber(amount, undefined, locale),
        currencyKnown: currency ? "yes" : "no",
        currency: currency ?? "",
      },
    );
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
  const fableSelected = /^(?:claude-)?fable(?:$|-|\[|:)/i.test(options.selectedModel?.trim() ?? "");
  const stale =
    !Number.isFinite(received) || now < received || now - received >= CLAUDE_QUOTA_STALE_AFTER_MS;
  return {
    observed: uiText("Received: {time}", {
      time: localTime(report.observedAt, options) ?? uiText("time unavailable"),
    }),
    stale,
    meters:
      report.meters?.flatMap((meter, index) => {
        // This is the selected model's allowance view, not evidence of which
        // models have been used. Never substitute the general weekly bucket
        // for a missing Fable allowance or show Fable beside another model.
        if (meter.kind === "weekly_all" && fableSelected) return [];
        if (
          meter.kind === "weekly_scoped" &&
          !(fableSelected && /^fable(?:$|\s|-|:)/i.test(meter.modelLabel?.trim() ?? ""))
        )
          return [];
        const expired = meter.resetsAt !== null && Date.parse(meter.resetsAt) <= now;
        const rowStale = stale || expired;
        const remaining = 100 - meter.usedPercent;
        return {
          id: `meter-${index}`,
          group:
            meter.group === "session"
              ? uiText("Session")
              : meter.group === "weekly"
                ? uiText("Weekly")
                : meter.group,
          label: [
            meter.kind === "session"
              ? uiText("Session window")
              : meter.kind === "weekly_all"
                ? uiText("Weekly")
                : meter.kind === "weekly_scoped"
                  ? uiText("Weekly")
                  : meter.kind,
            meter.modelLabel,
            meter.surfaceLabel,
          ]
            .filter(Boolean)
            .join(" · "),
          value: uiText("{stale, select, yes {Last reported: } other {}}{percent}% left", {
            stale: rowStale ? "yes" : "no",
            percent: percent(remaining, options.locale),
          }),
          remainingPercent: remaining,
          reset: meter.resetsAt
            ? uiText("{expired, select, yes {Reset passed} other {Resets}}: {time}", {
                expired: expired ? "yes" : "no",
                time: localTime(meter.resetsAt, options) ?? uiText("time unavailable"),
              })
            : null,
          stale: rowStale,
          severity: meter.severity,
          isActive: meter.isActive,
        };
      }) ?? null,
    extraUsageSummary:
      report.extraUsage?.enabled && report.extraUsage.usedPercent !== null
        ? uiText("{percent}% of extra usage used", {
            percent: percent(report.extraUsage.usedPercent, options.locale),
          })
        : null,
    extraUsage:
      report.extraUsage === undefined
        ? [uiText("Extra usage not reported.")]
        : report.extraUsage === null
          ? [uiText("Extra usage unavailable.")]
          : [
              uiText("Extra usage: {enabled, select, yes {Enabled} other {Disabled}}", {
                enabled: report.extraUsage.enabled ? "yes" : "no",
              }),
              report.extraUsage.usedPercent !== null
                ? uiText("{percent}% of extra-usage limit used", {
                    percent: percent(report.extraUsage.usedPercent, options.locale),
                  })
                : uiText("Extra-usage utilization: Unavailable"),
              report.extraUsage.usedCredits !== null
                ? uiText("Used: {amount}", {
                    amount: minorAmount(
                      report.extraUsage.usedCredits,
                      report.extraUsage.currency,
                      options.locale,
                    ),
                  })
                : uiText("Used: Unavailable"),
              report.extraUsage.monthlyLimit !== null
                ? uiText("Monthly limit: {amount}", {
                    amount: minorAmount(
                      report.extraUsage.monthlyLimit,
                      report.extraUsage.currency,
                      options.locale,
                    ),
                  })
                : uiText("Monthly limit: Unavailable"),
            ],
  };
}
