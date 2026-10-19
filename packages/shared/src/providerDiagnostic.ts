import {
  PROVIDER_DIAGNOSTIC_CATEGORIES,
  type ProviderDiagnostic,
  type ProviderDiagnosticCategory,
  type ProviderDiagnosticSubject,
  type ProviderDiagnosticSummary,
} from "@cafecode/contracts";

export const PROVIDER_DIAGNOSTIC_MAX_JSON_BYTES = 32_768;
const MAX_STRING = 4_096;
const MAX_NODES = 128;
const MAX_DEPTH = 8;
const MAX_KEYS = 32;
const REDACTED = "[Redacted: credential material]";
const OMITTED = "[Omitted: unrelated or unsupported data]";
const TRUNCATED = "[Truncated: diagnostic capture limit]";
const encoder = new TextEncoder();

/** Read own inert data only. Neither accessors nor custom toJSON are invoked. */
function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    const result = Object.create(null) as Record<string, unknown>;
    const keys = Reflect.ownKeys(value);
    if (keys.length > 8) return undefined;
    for (const key of keys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
    }
    return result;
  } catch {
    // Exotic objects/proxy failures are not native JSON evidence. Their error
    // text must not itself become a new diagnostic leak.
    return undefined;
  }
}

function credentialKey(key: string): boolean {
  return /(?:^auth$|authorization|authentication|password|passwd|passphrase|secret|credential|cookie|apikey|accesskey|privatekey|sessionkey|bearer|token)/u.test(
    key.toLowerCase().replace(/[^a-z0-9]/gu, ""),
  );
}

function unrelatedKey(key: string): boolean {
  return /^(?:items|turns|messages|history|prompt|prompts|input|output|arguments|environment|env|authjson|toolcalls|tools|conversation)$/u.test(
    key.toLowerCase().replace(/[^a-z0-9]/gu, ""),
  );
}

/**
 * Credential keys are removed structurally. This additional text pass covers
 * common credential spellings accidentally embedded in provider error prose.
 * It never reads credentials/profile state or guesses missing secret values.
 */
export function redactProviderDiagnosticText(value: string): string {
  return (
    value
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
        REDACTED,
      )
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, REDACTED)
      .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}/gu, REDACTED)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED)
      // Header/assignment values may contain whitespace or several Cookie
      // pairs. Redact the remainder of that line, not just the first token.
      .replace(
        /\b(?:api[_-]?key|access[_-]?(?:token|key)|refresh[_-]?token|id[_-]?token|session[_-]?(?:token|key)|client[_-]?secret|private[_-]?key|token|auth|authentication|password|passwd|passphrase|secret|credentials?|cookie|authorization)\b[\s"'\\]*(?:[:=]|%3[dD])[^\r\n]*/giu,
        REDACTED,
      )
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[Redacted]@")
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/gu, REDACTED)
  );
}

function identity(value: unknown, max = 512): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  if (/[\p{Cc}\p{Bidi_Control}]/u.test(value) || redactProviderDiagnosticText(value) !== value)
    return undefined;
  return value;
}

/** Strict summary parser for renderer/legacy data; ignores no unknown fields. */
export function readProviderDiagnosticSummary(
  value: unknown,
): ProviderDiagnosticSummary | undefined {
  const input = record(value);
  if (!input || input.version !== 1 || (input.status !== "retry" && input.status !== "error"))
    return undefined;
  if (
    Object.keys(input).some(
      (key) =>
        !["version", "status", "subject", "observedRetryCount", "countLimited"].includes(key),
    )
  )
    return undefined;
  const subject = record(input.subject);
  if (
    !subject ||
    typeof subject.kind !== "string" ||
    !["root", "subagent", "unknown"].includes(subject.kind)
  )
    return undefined;
  if (Object.keys(subject).some((key) => !["kind", "id", "label"].includes(key))) return undefined;
  if (subject.id !== undefined && identity(subject.id) === undefined) return undefined;
  if (subject.label !== undefined && identity(subject.label, 160) === undefined) return undefined;
  if (subject.kind !== "subagent" && (subject.id !== undefined || subject.label !== undefined))
    return undefined;
  if (subject.kind === "subagent" && subject.id === undefined) return undefined;
  if (
    input.observedRetryCount !== undefined &&
    (typeof input.observedRetryCount !== "number" ||
      !Number.isInteger(input.observedRetryCount) ||
      input.observedRetryCount < 1 ||
      input.observedRetryCount > 1_024)
  )
    return undefined;
  if (input.countLimited !== undefined && input.countLimited !== true) return undefined;
  // The native tracker may exhaust its global fingerprint budget before a
  // particular target reaches its per-target count cap. Keep that lower bound
  // valid instead of turning a native reconnect into an ordinary warning.
  if (input.countLimited === true && input.observedRetryCount === undefined) return undefined;
  if (
    input.status === "error" &&
    (input.observedRetryCount !== undefined || input.countLimited !== undefined)
  )
    return undefined;
  return {
    version: 1,
    status: input.status,
    subject: {
      kind: subject.kind as ProviderDiagnosticSubject["kind"],
      ...(typeof subject.id === "string" ? { id: subject.id } : {}),
      ...(typeof subject.label === "string" ? { label: subject.label } : {}),
    },
    ...(typeof input.observedRetryCount === "number"
      ? { observedRetryCount: input.observedRetryCount }
      : {}),
    ...(input.countLimited === true ? { countLimited: true } : {}),
  };
}

export interface ProviderDiagnosticCaptureInput {
  readonly observedAt: string;
  readonly source: string;
  readonly method?: string | undefined;
  readonly status: "retry" | "error";
  readonly subject: ProviderDiagnosticSubject;
  readonly native?: {
    readonly eventId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly turnId?: string | undefined;
    readonly subagentRuntimeId?: string | undefined;
    readonly requestId?: string | undefined;
  };
  /** Caller selects the exact error-only envelope, never a full turn or item. */
  readonly payload: unknown;
  readonly message?: string;
  readonly observedRetryCount?: number;
  readonly countLimited?: true;
  readonly omittedFields?: boolean;
}

/**
 * Capture is total/fail-closed and has independent node/depth/string/UTF-8
 * limits. Originals are never mutated. Only copied native JSON values reach
 * JSON.stringify, so neither provider getters nor toJSON can run there.
 */
export function makeProviderDiagnostic(input: ProviderDiagnosticCaptureInput): ProviderDiagnostic {
  let nodes = 0;
  let redacted = false;
  let truncated = false;
  let omittedFields = input.omittedFields === true;
  let remainingChars = 12_000;
  const seen = new WeakSet<object>();
  const text = (value: string): string => {
    // Redact before shortening so a truncated credential header cannot escape
    // detection. Do not scan an unbounded native string: overlarge values are
    // omitted entirely instead of retaining an unsafe partial prefix.
    if (value.length > 65_536) {
      truncated = true;
      return TRUNCATED;
    }
    const safe = redactProviderDiagnosticText(value);
    redacted ||= safe !== value;
    const allowance = Math.max(0, Math.min(MAX_STRING, remainingChars));
    remainingChars -= Math.min(safe.length, allowance);
    if (safe.length > allowance) {
      truncated = true;
      return `${safe.slice(0, allowance)}${TRUNCATED}`;
    }
    return safe;
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      truncated = true;
      return TRUNCATED;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") return text(value);
    if (typeof value !== "object" || value === null || seen.has(value)) {
      omittedFields = true;
      return OMITTED;
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
          omittedFields = true;
          return OMITTED;
        }
        const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
        if (!Number.isSafeInteger(length) || length < 0) {
          omittedFields = true;
          return OMITTED;
        }
        const result: unknown[] = [];
        for (let index = 0; index < Math.min(length, MAX_KEYS); index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !("value" in descriptor)) {
            omittedFields = true;
            result.push(OMITTED);
          } else result.push(visit(descriptor.value, depth + 1));
        }
        if (length > MAX_KEYS) {
          truncated = true;
          result.push(TRUNCATED);
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== null && prototype !== Object.prototype) {
        omittedFields = true;
        return OMITTED;
      }
      const result = Object.create(null) as Record<string, unknown>;
      const keys = Object.keys(value);
      for (const key of keys.slice(0, MAX_KEYS)) {
        // Keys are provider data too: bounded keys cannot create prototype
        // properties or smuggle credentials into displayed field names.
        const safeKey = key.length <= 160 ? text(key) : `[Omitted key ${nodes}]`;
        if (key.length > 160) omittedFields = true;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        let copied: unknown;
        if (key.length > 160) {
          omittedFields = true;
          copied = OMITTED;
        } else if (credentialKey(key)) {
          redacted = true;
          copied = REDACTED;
        } else if (unrelatedKey(key)) {
          omittedFields = true;
          copied = OMITTED;
        } else if (!descriptor || !("value" in descriptor)) {
          omittedFields = true;
          copied = OMITTED;
        } else copied = visit(descriptor.value, depth + 1);
        Object.defineProperty(result, safeKey, { value: copied, enumerable: true });
      }
      if (keys.length > MAX_KEYS) {
        truncated = true;
        result["$captureLimit"] = TRUNCATED;
      }
      return result;
    } catch {
      omittedFields = true;
      return OMITTED;
    }
  };
  let json = JSON.stringify(visit(input.payload, 0), null, 2);
  if (encoder.encode(json).byteLength > PROVIDER_DIAGNOSTIC_MAX_JSON_BYTES) {
    truncated = true;
    json = JSON.stringify({ diagnostic: TRUNCATED, reason: "encoded-json-byte-limit" }, null, 2);
  }
  const native = Object.fromEntries(
    Object.entries(record(input.native) ?? {}).filter(
      ([key, value]) =>
        ["eventId", "threadId", "turnId", "subagentRuntimeId", "requestId"].includes(key) &&
        identity(value) !== undefined,
    ),
  );
  const summary = readProviderDiagnosticSummary({
    version: 1,
    status: input.status,
    subject: input.subject,
    ...(input.observedRetryCount !== undefined
      ? { observedRetryCount: input.observedRetryCount }
      : {}),
    ...(input.countLimited ? { countLimited: true } : {}),
  }) ?? { version: 1, status: input.status, subject: { kind: "unknown" } };
  const message = input.message !== undefined ? text(input.message) : undefined;
  return {
    summary,
    snapshot: {
      version: 1,
      observedAt: input.observedAt,
      source: identity(input.source) ?? "provider.error",
      ...(identity(input.method) ? { method: input.method } : {}),
      native,
      ...(message !== undefined ? { message: message.slice(0, MAX_STRING) } : {}),
      json,
      redacted,
      truncated,
      omittedFields,
    },
  };
}

/** Own enumerable data only; the copied JSON is inert, but stay defensive. */
function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function ownJsonValue(value: Record<string, unknown> | undefined, key: string): unknown {
  return value !== undefined && Object.hasOwn(value, key) ? value[key] : undefined;
}

/**
 * Locate the copied native error object inside our own bounded diagnostic
 * JSON. Codex notifications copy `{ error }`, terminal turns `{ turn: { error } }`;
 * Claude/fallback captures use `{ error }`. Parse failures are not evidence.
 */
export function readProviderDiagnosticErrorBody(json: string): Record<string, unknown> | undefined {
  if (json.length === 0 || json.length > PROVIDER_DIAGNOSTIC_MAX_JSON_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const root = jsonRecord(parsed);
  return (
    jsonRecord(ownJsonValue(root, "error")) ??
    jsonRecord(ownJsonValue(jsonRecord(ownJsonValue(root, "turn")), "error"))
  );
}

/**
 * True when Cafe's capture changed this text (secret redaction, unrelated or
 * unsupported omission, or a size cut). Such a copy cannot prove that two
 * observations carried the same complete error body.
 */
export function providerDiagnosticTextHasCaptureMarker(text: string): boolean {
  return (
    text.includes(REDACTED) ||
    text.includes(OMITTED) ||
    text.includes(TRUNCATED) ||
    text.includes("[Redacted]@") ||
    text.includes("[Omitted key ")
  );
}

export function readProviderDiagnosticCategory(
  value: unknown,
): ProviderDiagnosticCategory | undefined {
  return typeof value === "string" &&
    (PROVIDER_DIAGNOSTIC_CATEGORIES as ReadonlyArray<string>).includes(value)
    ? (value as ProviderDiagnosticCategory)
    : undefined;
}

// Codex app-server `codexErrorInfo` (generated protocol, rust-v0.162.1). The
// unit variants are exact protocol codes; unknown/future codes stay
// uncategorized rather than being guessed from accompanying prose.
const CODEX_ERROR_CATEGORIES: Readonly<Record<string, ProviderDiagnosticCategory>> = {
  contextWindowExceeded: "context-window",
  sessionBudgetExceeded: "session-budget",
  usageLimitExceeded: "usage-limit",
  rateLimitExceeded: "rate-limit",
  flexUnavailable: "speed-tier-unavailable",
  serverOverloaded: "model-at-capacity",
  cyberPolicy: "cyber-policy",
  misalignmentPolicyViolation: "usage-policy",
  tooManyDenials: "too-many-denials",
  internalServerError: "server-error",
  unauthorized: "sign-in-required",
  badRequest: "request-rejected",
  sandboxError: "sandbox",
  httpConnectionFailed: "connection",
  responseStreamConnectionFailed: "connection",
  responseStreamDisconnected: "connection",
  responseTooManyFailedAttempts: "connection",
};

// Claude Agent SDK `SDKAssistantMessageError` (0.3.295 typed codes).
const CLAUDE_ERROR_CATEGORIES: Readonly<Record<string, ProviderDiagnosticCategory>> = {
  authentication_failed: "sign-in-required",
  oauth_org_not_allowed: "sign-in-required",
  cloud_credential_error: "sign-in-required",
  account_on_hold: "account-on-hold",
  verification_required: "verification-required",
  billing_error: "billing",
  rate_limit: "rate-limit",
  overloaded: "model-at-capacity",
  invalid_request: "request-rejected",
  model_not_found: "model-unavailable",
  server_error: "server-error",
  max_output_tokens: "response-limit",
};

/** Cafe-authored process-exit methods; their fixed copy is Cafe-owned. */
export const PROVIDER_DIAGNOSTIC_PROCESS_EXIT_METHODS = [
  "process/exitedUnexpectedly",
  "claude/stream/failed",
] as const;

function httpStatusCategory(value: unknown): ProviderDiagnosticCategory | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value === 401 || value === 403) return "sign-in-required";
  if (value === 429) return "rate-limit";
  if (value === 529) return "model-at-capacity";
  return undefined;
}

/**
 * Derive the closed presentation category from structured fields of the
 * bounded private copy. Never reads `message`, `additionalDetails` or other
 * prose: a word such as "unauthorized" inside provider text is not evidence.
 * Shared by server publication and renderer expansion of older rows.
 */
export function deriveProviderDiagnosticCategory(snapshot: {
  readonly method?: string | undefined;
  readonly json: string;
}): ProviderDiagnosticCategory | undefined {
  if (
    snapshot.method !== undefined &&
    (PROVIDER_DIAGNOSTIC_PROCESS_EXIT_METHODS as ReadonlyArray<string>).includes(snapshot.method)
  )
    return "process-exit";
  const error = readProviderDiagnosticErrorBody(snapshot.json);
  if (!error) return undefined;
  const codexInfo = ownJsonValue(error, "codexErrorInfo");
  if (typeof codexInfo === "string") {
    return Object.hasOwn(CODEX_ERROR_CATEGORIES, codexInfo)
      ? CODEX_ERROR_CATEGORIES[codexInfo]
      : undefined;
  }
  const codexVariant = jsonRecord(codexInfo);
  if (codexVariant) {
    const keys = Object.keys(codexVariant);
    const variant = keys.length === 1 ? keys[0] : undefined;
    if (variant === undefined || !Object.hasOwn(CODEX_ERROR_CATEGORIES, variant)) return undefined;
    const status = httpStatusCategory(
      ownJsonValue(jsonRecord(codexVariant[variant]), "httpStatusCode"),
    );
    return status ?? CODEX_ERROR_CATEGORIES[variant];
  }
  const claudeType = ownJsonValue(error, "errorType");
  if (typeof claudeType === "string" && Object.hasOwn(CLAUDE_ERROR_CATEGORIES, claudeType)) {
    return CLAUDE_ERROR_CATEGORIES[claudeType];
  }
  return httpStatusCategory(ownJsonValue(error, "apiErrorStatus"));
}
