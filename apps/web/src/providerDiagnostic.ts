import type {
  EventId,
  OrchestrationThreadActivity,
  ProviderDiagnosticSnapshot,
  ProviderDiagnosticSummary,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import { readProviderDiagnosticSummary } from "@cafecode/shared/providerDiagnostic";
import { PROVIDER_DIAGNOSTIC_MAX_JSON_BYTES } from "@cafecode/shared/providerDiagnostic";
export { readProviderDiagnosticSummary } from "@cafecode/shared/providerDiagnostic";

export interface ProviderDiagnosticWorkLogRecord {
  readonly summary: ProviderDiagnosticSummary;
  /** False for legacy observations whose original diagnostic was not saved. */
  readonly recorded: boolean;
}

/** Own data properties only: presentation must never invoke received accessors. */
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return null;
    const keys = Object.keys(value);
    if (keys.length > 16) return null;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return null;
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
    }
    return result;
  } catch {
    return null;
  }
}

function finiteText(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function deriveProviderDiagnosticWorkLogRecord(
  activity: OrchestrationThreadActivity,
): ProviderDiagnosticWorkLogRecord | null {
  if (activity.kind !== "runtime.warning" && activity.kind !== "runtime.error") return null;
  const payload = record(activity.payload);
  const summary = readProviderDiagnosticSummary(payload?.providerDiagnostic);
  if (summary) return { summary, recorded: true };
  if (activity.kind === "runtime.error") {
    return {
      summary: { version: 1, status: "error", subject: { kind: "unknown" } },
      recorded: false,
    };
  }
  if (payload?.retrying !== true) return null;
  const nativeRetry = record(payload.nativeRetry);
  const count = nativeRetry?.observedCount;
  const validCount =
    typeof count === "number" &&
    Number.isInteger(count) &&
    count >= 1 &&
    count <= 1024 &&
    nativeRetry?.timing === "unknown" &&
    (!Object.hasOwn(nativeRetry, "countLimited") || nativeRetry.countLimited === true);
  return {
    recorded: false,
    summary: {
      version: 1,
      status: "retry",
      subject: { kind: "unknown" },
      ...(validCount
        ? {
            observedRetryCount: count,
            ...(nativeRetry?.countLimited === true ? { countLimited: true as const } : {}),
          }
        : {}),
    },
  };
}

export function providerDiagnosticSubjectLabel(
  summary: ProviderDiagnosticSummary,
  locale?: UiLocale,
): string {
  return summary.subject.kind === "root"
    ? uiText("Root", undefined, undefined, locale)
    : summary.subject.kind === "subagent"
      ? (summary.subject.label ?? uiText("Subagent", undefined, undefined, locale))
      : uiText("Agent not recorded", undefined, undefined, locale);
}

export function providerDiagnosticWorkLogLabel(
  summary: ProviderDiagnosticSummary,
  locale?: UiLocale,
): string {
  if (summary.status === "error") return uiText("Provider error", undefined, undefined, locale);
  return summary.observedRetryCount
    ? uiText(
        "Provider retry · {count}{suffix}",
        {
          count: summary.observedRetryCount,
          suffix: summary.countLimited ? "+" : "",
        },
        undefined,
        locale,
      )
    : uiText("Provider retry", undefined, undefined, locale);
}

export interface ProviderDiagnosticReadIdentity {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly activityId: EventId;
}

/**
 * A response is only displayable for the exact requested canonical occurrence.
 * Client transport already schema-decodes wire JSON; this inert second fence
 * also protects tests/adapters and prevents oversized or foreign data from
 * entering a private DOM/copy surface after an asynchronous navigation.
 */
export function readMatchingProviderDiagnosticResponse(
  value: unknown,
  identity: ProviderDiagnosticReadIdentity,
): { readonly diagnostic: ProviderDiagnosticSnapshot | null } | null {
  const response = record(value);
  if (
    !response ||
    response.threadId !== identity.threadId ||
    response.turnId !== identity.turnId ||
    response.activityId !== identity.activityId
  )
    return null;
  if (response.diagnostic === null) return { diagnostic: null };
  const diagnostic = record(response.diagnostic);
  const native = record(diagnostic?.native);
  if (
    !diagnostic ||
    !native ||
    diagnostic.version !== 1 ||
    !onlyKeys(diagnostic, [
      "version",
      "observedAt",
      "source",
      "method",
      "native",
      "message",
      "json",
      "redacted",
      "truncated",
      "omittedFields",
    ]) ||
    !finiteText(diagnostic.observedAt, 64) ||
    !Number.isFinite(Date.parse(diagnostic.observedAt)) ||
    !finiteText(diagnostic.source) ||
    ("method" in diagnostic && !finiteText(diagnostic.method)) ||
    ("message" in diagnostic &&
      (typeof diagnostic.message !== "string" || diagnostic.message.length > 4096)) ||
    typeof diagnostic.json !== "string" ||
    diagnostic.json.length === 0 ||
    diagnostic.json.length > 32768 ||
    new TextEncoder().encode(diagnostic.json).byteLength > PROVIDER_DIAGNOSTIC_MAX_JSON_BYTES ||
    typeof diagnostic.redacted !== "boolean" ||
    typeof diagnostic.truncated !== "boolean" ||
    typeof diagnostic.omittedFields !== "boolean" ||
    !onlyKeys(native, ["eventId", "threadId", "turnId", "subagentRuntimeId", "requestId"]) ||
    Object.values(native).some((item) => !finiteText(item))
  )
    return null;
  return { diagnostic: diagnostic as unknown as ProviderDiagnosticSnapshot };
}

/** Explicit user copy only. This string is never a collapsed row preview. */
export function providerDiagnosticCopyDetails(
  snapshot: ProviderDiagnosticSnapshot,
  locale?: UiLocale,
): string {
  return [
    uiText("Provider diagnostic", undefined, undefined, locale),
    `${uiText("Observed at", undefined, undefined, locale)}: ${snapshot.observedAt}`,
    `${uiText("Source", undefined, undefined, locale)}: ${snapshot.source}`,
    ...(snapshot.method
      ? [`${uiText("Method", undefined, undefined, locale)}: ${snapshot.method}`]
      : []),
    ...(snapshot.message
      ? [`${uiText("Provider message", undefined, undefined, locale)}: ${snapshot.message}`]
      : []),
    ...Object.entries(snapshot.native).map(([key, value]) => `${key}: ${value}`),
    `${uiText("Secrets redacted", undefined, undefined, locale)}: ${snapshot.redacted}`,
    `${uiText("Truncated", undefined, undefined, locale)}: ${snapshot.truncated}`,
    `${uiText("Fields omitted", undefined, undefined, locale)}: ${snapshot.omittedFields}`,
    uiText("Diagnostic JSON — secrets redacted", undefined, undefined, locale),
    snapshot.json,
  ].join("\n");
}
