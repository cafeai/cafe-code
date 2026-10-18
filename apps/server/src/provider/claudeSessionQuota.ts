import {
  ProviderSessionQuotaReport,
  ProviderSessionQuotaTimestamp,
  type ProviderSessionQuotaExtraUsage,
  type ProviderSessionQuotaMeter,
  PROVIDER_SESSION_QUOTA_MAX_METERS,
  PROVIDER_SESSION_QUOTA_MAX_CLASSIFICATION_CHARS,
  PROVIDER_SESSION_QUOTA_MAX_LABEL_CHARS,
  PROVIDER_SESSION_QUOTA_MAX_CURRENCY_CHARS,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";

const isReport = Schema.is(ProviderSessionQuotaReport);
const decodeReceipt = Schema.decodeUnknownSync(ProviderSessionQuotaTimestamp);

function invalid(): never {
  // Never include native values in an error, log, or canonical event. A failed
  // experimental shape becomes an unavailable level, not retained balances.
  throw new Error("Invalid native session quota metadata.");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

/** Read only own data properties. Inherited keys/accessors are not metadata
 * authority, even in an adversarial synthetic SDK fixture. */
function own(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function text(value: unknown, maximum: number): string {
  // Bound before any Unicode regex or trimming: even rejected metadata must
  // not make validation scan an arbitrarily large native string.
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : invalid();
}

function percent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : invalid();
}

function nullableAmount(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}

/** The provider documents ISO 8601 and commonly uses fractional seconds and
 * explicit offsets. Admit only a complete instant, validate its calendar before
 * Date.parse can repair it, then publish a canonical UTC timestamp. */
function reset(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 40) return invalid();
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!parts) return invalid();
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  // setUTCFullYear avoids Date.UTC's special interpretation of years 0..99.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59 ||
    Number(parts[8] ?? 0) > 23 ||
    Number(parts[9] ?? 0) > 59
  )
    return invalid();
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : invalid();
}

function meter(value: unknown): ProviderSessionQuotaMeter {
  const row = record(value);
  const isActive = own(row, "is_active");
  if (typeof isActive !== "boolean") return invalid();
  const scopeValue = own(row, "scope");
  const scope = scopeValue === undefined || scopeValue === null ? undefined : record(scopeValue);
  const label = (key: string): string | undefined => {
    const value = scope ? own(scope, key) : undefined;
    return value === undefined || value === null
      ? undefined
      : text(own(record(value), "display_name"), PROVIDER_SESSION_QUOTA_MAX_LABEL_CHARS);
  };
  const modelLabel = label("model");
  const surfaceLabel = label("surface");
  return {
    kind: text(own(row, "kind"), PROVIDER_SESSION_QUOTA_MAX_CLASSIFICATION_CHARS),
    group: text(own(row, "group"), PROVIDER_SESSION_QUOTA_MAX_CLASSIFICATION_CHARS),
    // Structured report percent is already 0..100. Never reuse the sparse
    // rate_limit_event mapper, whose utilization is a 0..1 fraction.
    usedPercent: percent(own(row, "percent")),
    resetsAt: reset(own(row, "resets_at")),
    ...(modelLabel === undefined ? {} : { modelLabel }),
    ...(surfaceLabel === undefined ? {} : { surfaceLabel }),
    severity: text(own(row, "severity"), PROVIDER_SESSION_QUOTA_MAX_CLASSIFICATION_CHARS),
    isActive,
  };
}

/** Arrays obey the same own-data admission as row objects. Array.map would
 * evaluate indexed getters, consume inherited entries, and read a caller's
 * map/constructor/species. Inspect only the bounded own length and every own
 * index instead. Holes/accessors reject the entire level, not a subset whose
 * valid siblings could otherwise masquerade as a current complete reading. */
function meters(value: unknown): ProviderSessionQuotaMeter[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return invalid();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length =
    lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > PROVIDER_SESSION_QUOTA_MAX_METERS
  )
    return invalid();
  const result: ProviderSessionQuotaMeter[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return invalid();
    result.push(meter(descriptor.value));
  }
  return result;
}

function extraUsage(value: unknown): ProviderSessionQuotaExtraUsage | null {
  if (value === null) return null;
  const raw = record(value);
  const enabled = own(raw, "is_enabled");
  if (typeof enabled !== "boolean") return invalid();
  const utilization = own(raw, "utilization");
  const currency = own(raw, "currency");
  return {
    enabled,
    monthlyLimit: nullableAmount(own(raw, "monthly_limit")),
    usedCredits: nullableAmount(own(raw, "used_credits")),
    usedPercent: utilization === null ? null : percent(utilization),
    ...(currency === undefined
      ? {}
      : {
          currency:
            currency === null ? null : text(currency, PROVIDER_SESSION_QUOTA_MAX_CURRENCY_CHARS),
        }),
  };
}

/** Project only the structured sibling of a user's native /usage reply. Do not
 * read session totals, behaviors, identities, or future fields. All rows form
 * one ordered level; duplicate labels/kinds remain independent. A malformed
 * row rejects the whole level instead of hiding some meters or reviving an old
 * reading. Receipt time belongs to Cafe, not the upstream quota endpoint. */
export function mapClaudeSessionQuotaReport(
  raw: unknown,
  observedAt: string,
): ProviderSessionQuotaReport {
  const unavailable: ProviderSessionQuotaReport = {
    source: "claude-session",
    observedAt: decodeReceipt(observedAt),
    meters: null,
  };
  try {
    const limitsValue = own(record(raw), "rate_limits");
    if (limitsValue === null) return unavailable;
    const limits = record(limitsValue);
    const rows = meters(own(limits, "limits"));
    const extra = own(limits, "extra_usage");
    const report = {
      ...unavailable,
      meters: rows,
      ...(extra === undefined ? {} : { extraUsage: extraUsage(extra) }),
    };
    return isReport(report) ? report : unavailable;
  } catch {
    return unavailable;
  }
}

/** get_usage in CLI 2.1.301 returns the endpoint's ordered limits as well as
 * legacy five_hour/seven_day windows. Prefer the complete native rows. Older
 * replies may carry only named windows; null utilization is unknown, not zero.
 * SDK 0.3.295 documents this control separately from the /usage sibling. */
export function mapClaudeAccountQuotaReport(
  raw: unknown,
  observedAt: string,
): ProviderSessionQuotaReport | null {
  try {
    const response = record(raw);
    if (own(response, "rate_limits_available") !== true) return null;
    const limits = record(own(response, "rate_limits"));
    const nativeRows = own(limits, "limits");
    let projected: unknown = { rate_limits: limits };
    if (nativeRows === undefined || nativeRows === null) {
      const rows: object[] = [];
      for (const [key, kind, group, modelLabel, surfaceLabel] of [
        ["five_hour", "session", "session"],
        ["seven_day", "weekly_all", "weekly"],
        ["seven_day_oauth_apps", "weekly_scoped", "weekly", undefined, "OAuth apps"],
        ["seven_day_opus", "weekly_scoped", "weekly", "Opus"],
        ["seven_day_sonnet", "weekly_scoped", "weekly", "Sonnet"],
      ] as const) {
        const window = own(limits, key);
        if (window === undefined || window === null) continue;
        const data = record(window);
        const utilization = own(data, "utilization");
        if (utilization === null) continue;
        rows.push({
          kind,
          group,
          percent: percent(utilization),
          resets_at: own(data, "resets_at"),
          severity: "unknown",
          is_active: false,
          scope: {
            ...(modelLabel ? { model: { display_name: modelLabel } } : {}),
            ...(surfaceLabel ? { surface: { display_name: surfaceLabel } } : {}),
          },
        });
      }
      // Do not label an absent legacy level as an explicitly empty complete list.
      if (rows.length === 0) return null;
      const extra = own(limits, "extra_usage");
      projected = {
        rate_limits: {
          limits: rows,
          ...(extra === undefined ? {} : { extra_usage: extra }),
        },
      };
    }
    const report = mapClaudeSessionQuotaReport(projected, observedAt);
    return report.meters === null ? null : { ...report, source: "claude-cli" };
  } catch {
    return null;
  }
}

/** Remove the structured sibling at SDK ingress, before native logging,
 * accounting, transcript snapshots, raw events, or canonical projection. The
 * ordinary /usage assistant text remains unchanged. Data is captured without
 * evaluating a getter; malformed/accessor reports are safely unavailable. The
 * sanitised copy does not inherit a prototype-supplied usage_report either. */
export function stripClaudeUsageReport<T extends object>(
  message: T,
): {
  readonly message: T;
  readonly hasReport: boolean;
  readonly report: unknown;
} {
  // Most frames are token deltas, not quota metadata. Inspect only the one
  // own descriptor first so this hot path neither clones every field nor
  // evaluates an accessor/prototype value. Only report-bearing messages need
  // the sanitised descriptor copy below.
  const descriptor = Object.getOwnPropertyDescriptor(message, "usage_report");
  if (!descriptor) return { message, hasReport: false, report: undefined };
  const descriptors = Object.getOwnPropertyDescriptors(message);
  delete descriptors.usage_report;
  return {
    message: Object.defineProperties({}, descriptors) as T,
    hasReport: true,
    report: "value" in descriptor ? descriptor.value : undefined,
  };
}
