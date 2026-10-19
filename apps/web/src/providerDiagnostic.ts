import type {
  EventId,
  OrchestrationThreadActivity,
  ProviderDiagnosticCategory,
  ProviderDiagnosticSnapshot,
  ProviderDiagnosticSummary,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import {
  readProviderDiagnosticCategory,
  readProviderDiagnosticSummary,
} from "@cafecode/shared/providerDiagnostic";
import { PROVIDER_DIAGNOSTIC_MAX_JSON_BYTES } from "@cafecode/shared/providerDiagnostic";
export { readProviderDiagnosticSummary } from "@cafecode/shared/providerDiagnostic";

export interface ProviderDiagnosticWorkLogRecord {
  readonly summary: ProviderDiagnosticSummary;
  /** False for legacy observations whose original diagnostic was not saved. */
  readonly recorded: boolean;
  /** Closed server-derived category; absent on older rows and unknown codes. */
  readonly category?: ProviderDiagnosticCategory;
  /**
   * Reconnect observations folded into this error row. A lower bound when
   * `countLimited`; never an upstream attempt total or retry deadline.
   */
  readonly retriesBefore?: { readonly count: number; readonly countLimited: boolean };
  /**
   * Daybreak state recorded in the same turn's accepted settings, when known.
   * Presentation only; never read from today's composer selection.
   */
  readonly turnDaybreak?: boolean;
}

/**
 * Content-free witness that two error rows describe the same occurrence: the
 * server publishes a SHA-256 of the exact error text plus an owner hash of the
 * Cafe thread/turn/instance/runtime generation. Used only to fold duplicate
 * terminal echoes persisted by older builds; never rendered.
 */
export function providerDiagnosticEchoKey(activity: OrchestrationThreadActivity): string | null {
  if (activity.kind !== "runtime.error") return null;
  const payload = record(activity.payload);
  const errorHash = payload?.providerErrorHash;
  const ownerHash = payload?.providerErrorOwnerHash;
  return typeof errorHash === "string" &&
    /^[0-9a-f]{64}$/u.test(errorHash) &&
    typeof ownerHash === "string" &&
    /^[0-9a-f]{64}$/u.test(ownerHash)
    ? `${ownerHash}:${errorHash}`
    : null;
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
  if (summary) {
    const category = readProviderDiagnosticCategory(payload?.providerDiagnosticCategory);
    return { summary, recorded: true, ...(category !== undefined ? { category } : {}) };
  }
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

/**
 * Collapsed row label. Error rows name the server-derived category when one
 * exists; retry rows read as reconnect observations. Neither ever contains
 * provider prose, so the collapsed DOM stays free of private diagnostic text.
 */
export function providerDiagnosticWorkLogLabel(
  diagnostic: Pick<ProviderDiagnosticWorkLogRecord, "summary" | "category" | "retriesBefore">,
  locale?: UiLocale,
): string {
  const { summary } = diagnostic;
  if (summary.status === "error") {
    const label = diagnostic.category
      ? providerDiagnosticCategoryPresentation(diagnostic.category, locale).title
      : uiText("Provider error", undefined, undefined, locale);
    const retries = diagnostic.retriesBefore;
    if (!retries) return label;
    return retries.countLimited
      ? uiText(
          "{label} · after {count}+ reconnects",
          { label, count: retries.count },
          undefined,
          locale,
        )
      : uiText(
          "{label} · after {count, plural, one {# reconnect} other {# reconnects}}",
          { label, count: retries.count },
          undefined,
          locale,
        );
  }
  return summary.observedRetryCount
    ? uiText(
        "Reconnecting · {count}{suffix}",
        {
          count: summary.observedRetryCount,
          suffix: summary.countLimited ? "+" : "",
        },
        undefined,
        locale,
      )
    : uiText("Reconnecting", undefined, undefined, locale);
}

/** Navigation shortcuts only: they open existing controls, never retry/send. */
export type ProviderDiagnosticAction = "model-picker" | "model-options" | "provider-settings";

export interface ProviderDiagnosticCategoryPresentation {
  readonly title: string;
  readonly guidance: string;
  readonly action?: ProviderDiagnosticAction;
}

/**
 * Fixed Cafe-authored copy for each closed category. Guidance describes what
 * the category means and what the person can do in Cafe; the received
 * provider message is shown separately and verbatim.
 */
export function providerDiagnosticCategoryPresentation(
  category: ProviderDiagnosticCategory,
  locale?: UiLocale,
): ProviderDiagnosticCategoryPresentation {
  switch (category) {
    case "cyber-policy":
      return {
        title: uiText("Blocked by cybersecurity policy", undefined, undefined, locale),
        guidance: uiText(
          "OpenAI flagged this request as a possible cybersecurity risk. For legitimate security work, turn on Daybreak in model options if this account offers it. Otherwise, try rephrasing; some requests stay limited even with Daybreak on.",
          undefined,
          undefined,
          locale,
        ),
        action: "model-options",
      };
    case "usage-policy":
      return {
        title: uiText("Blocked by usage policy", undefined, undefined, locale),
        guidance: uiText(
          "The provider declined this request under its usage policy. Try rephrasing it.",
          undefined,
          undefined,
          locale,
        ),
      };
    case "model-at-capacity":
      return {
        title: uiText("Model at capacity", undefined, undefined, locale),
        guidance: uiText(
          "The model is busy right now. Try again shortly, or choose another model.",
          undefined,
          undefined,
          locale,
        ),
        action: "model-picker",
      };
    case "usage-limit":
      return {
        title: uiText("Usage limit reached", undefined, undefined, locale),
        guidance: uiText(
          "This account reached its plan's usage limit. Provider settings show limits and reset times.",
          undefined,
          undefined,
          locale,
        ),
        action: "provider-settings",
      };
    case "rate-limit":
      return {
        title: uiText("Rate limited", undefined, undefined, locale),
        guidance: uiText(
          "Too many requests in a short time. Wait a moment, then send again.",
          undefined,
          undefined,
          locale,
        ),
      };
    case "billing":
      return {
        title: uiText("Billing or spend limit", undefined, undefined, locale),
        guidance: uiText(
          "The provider reported a billing or spend limit for this account. Check the account's usage and billing.",
          undefined,
          undefined,
          locale,
        ),
        action: "provider-settings",
      };
    case "account-on-hold":
      return {
        title: uiText("Account on hold", undefined, undefined, locale),
        guidance: uiText(
          "The provider has put this account on hold. Resolve it with the provider.",
          undefined,
          undefined,
          locale,
        ),
        action: "provider-settings",
      };
    case "context-window":
      return {
        title: uiText("Context window full", undefined, undefined, locale),
        guidance: uiText(
          "This chat no longer fits in the model's context window. Run /compact, or start a new chat.",
          undefined,
          undefined,
          locale,
        ),
      };
    case "session-budget":
      return {
        title: uiText("Session budget reached", undefined, undefined, locale),
        guidance: uiText("This session used its token budget.", undefined, undefined, locale),
      };
    case "sign-in-required":
      return {
        title: uiText("Sign-in required", undefined, undefined, locale),
        guidance: uiText(
          "This account's sign-in expired or was rejected. Sign in again from provider settings, then send your message again.",
          undefined,
          undefined,
          locale,
        ),
        action: "provider-settings",
      };
    case "verification-required":
      return {
        title: uiText("Verification required", undefined, undefined, locale),
        guidance: uiText(
          "The provider needs you to verify this account before continuing.",
          undefined,
          undefined,
          locale,
        ),
        action: "provider-settings",
      };
    case "model-unavailable":
      return {
        title: uiText("Model unavailable", undefined, undefined, locale),
        guidance: uiText(
          "The selected model isn't available for this account. Choose another model.",
          undefined,
          undefined,
          locale,
        ),
        action: "model-picker",
      };
    case "speed-tier-unavailable":
      return {
        title: uiText("Speed tier unavailable", undefined, undefined, locale),
        guidance: uiText(
          "The selected speed tier isn't available right now. Choose another setting in model options.",
          undefined,
          undefined,
          locale,
        ),
        action: "model-options",
      };
    case "connection":
      return {
        title: uiText("Connection lost", undefined, undefined, locale),
        guidance: uiText(
          "The connection to the provider dropped. Reconnects usually recover on their own.",
          undefined,
          undefined,
          locale,
        ),
      };
    case "server-error":
      return {
        title: uiText("Provider server error", undefined, undefined, locale),
        guidance: uiText(
          "The provider had a server error. Try again in a moment.",
          undefined,
          undefined,
          locale,
        ),
      };
    case "request-rejected":
      return {
        title: uiText("Request rejected", undefined, undefined, locale),
        guidance: uiText("The provider rejected this request.", undefined, undefined, locale),
      };
    case "sandbox":
      return {
        title: uiText("Sandbox error", undefined, undefined, locale),
        guidance: uiText("The provider's command sandbox failed.", undefined, undefined, locale),
      };
    case "too-many-denials":
      return {
        title: uiText("Stopped after repeated denials", undefined, undefined, locale),
        guidance: uiText(
          "The agent stopped after several of its requests were denied.",
          undefined,
          undefined,
          locale,
        ),
      };
    case "process-exit":
      return {
        title: uiText("Provider process stopped", undefined, undefined, locale),
        guidance: uiText(
          "The provider's local process stopped unexpectedly. Your next message starts it again and resumes this chat.",
          undefined,
          undefined,
          locale,
        ),
      };
    case "response-limit":
      return {
        title: uiText("Response limit reached", undefined, undefined, locale),
        guidance: uiText(
          "The response hit the provider's output or context limit. Ask for a shorter answer or split the work.",
          undefined,
          undefined,
          locale,
        ),
      };
  }
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
