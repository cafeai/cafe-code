import type { CodexTransientFailureCategory } from "@cafecode/contracts";

/**
 * Codex exposes structured error variants. Recovery must be an allowlist:
 * authentication, exhausted subscription/budget, approval, policy, sandbox and
 * history failures are never converted to transient errors by matching prose.
 * Returned categories contain no request IDs or provider-authored text.
 */
const transportVariants = new Set([
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);
const temporaryHttpStatuses = new Set([408, 429, 500, 502, 503, 504]);
const nativePublicErrorVariants = new Set([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "rateLimitExceeded",
  "flexUnavailable",
  "serverOverloaded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "tooManyDenials",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "other",
]);

// This is the exact provider-owned processing error reported at the terminal
// boundary. Do not accept a substring, a vaguely similar assistant sentence,
// or an arbitrary suffix containing a request UUID. The UUID is deliberately
// consumed only by the match and is never returned or retained by this module.
// Codex rust-v0.162.1 uses one exact compaction-task prefix while retaining the
// underlying Stream error's `other` variant. Admit only that prefix followed by
// the native Stream prefix and this same fixed processing error, never a general
// error-wrapper parser. Nested wrappers, content-filter/auth failures and unknown
// prose remain non-retryable. The underlying typed permanent error still wins.
// https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/compact_remote_v2.rs#L206
// https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/error.rs#L514
const genericProcessingError =
  /^(?:(?:Error running remote compact task: )?stream disconnected before completion: )?An error occurred while processing your request\. You can retry your request, or contact us through our help center at help\.openai\.com if the error persists\. Please include the request ID [a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12} in your message\.$/u;

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    // Native JSON is inert data. A synthetic/local caller may not smuggle an
    // accessor into this authority calculation, including on an unrelated key.
    if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) return undefined;
    // A normal object copy would reintroduce inherited authority (including
    // polluted Object.prototype getters) after this own-descriptor check.
    return Object.defineProperties(Object.create(null), descriptors) as Record<string, unknown>;
  } catch {
    // Proxy traps are not native JSON evidence either. Never surface their
    // arbitrary exception text through this content-free classification.
    return undefined;
  }
}

function hasOnlyQualifiedDiagnosticErrorFields(value: unknown): boolean {
  const error = ownRecord(value);
  if (!error || typeof error.message !== "string" || error.message.length > 4_096) return false;
  if (
    Object.keys(error).some(
      (key) => !["message", "codexErrorInfo", "additionalDetails", "misalignment"].includes(key),
    )
  )
    return false;
  if (
    error.additionalDetails !== undefined &&
    error.additionalDetails !== null &&
    (typeof error.additionalDetails !== "string" || error.additionalDetails.length > 4_096)
  )
    return false;
  // Non-null misalignment metadata has its own public presentation contract;
  // it is not needed for raw failure diagnostics and may contain opaque data.
  if (error.misalignment !== undefined && error.misalignment !== null) return false;
  const info = error.codexErrorInfo;
  if (info === undefined || info === null) return true;
  if (typeof info === "string") return nativePublicErrorVariants.has(info);
  const structured = ownRecord(info);
  if (!structured) return false;
  const keys = Object.keys(structured);
  if (keys.length !== 1) return false;
  const variant = ownRecord(structured[keys[0]!]);
  if (!variant) return false;
  if (keys[0] === "activeTurnNotSteerable")
    return (
      Object.keys(variant).length === 1 &&
      (variant.turnKind === "review" || variant.turnKind === "compact")
    );
  if (
    !transportVariants.has(keys[0]!) ||
    Object.keys(variant).some((key) => key !== "httpStatusCode")
  )
    return false;
  const status = variant.httpStatusCode;
  return (
    status === undefined ||
    status === null ||
    (typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 65_535)
  );
}

/**
 * A diagnostic copy, never a classifier input. Keep the complete native error
 * in memory for owner/failure decisions; newly open error records may carry
 * arbitrary private extension values that must not reach durable raw/detail,
 * native logs or debug bridges. Do not "clean" an ambiguous transport variant:
 * the finite marker cannot regain recovery authority on diagnostic replay.
 * Known exact bounded error shapes preserve their previous diagnostic copy.
 */
export function redactCodexFailureDiagnosticPayload(method: string, payload: unknown): unknown {
  if (
    method !== "error" &&
    method !== "codex.subagent/error" &&
    method !== "turn/completed" &&
    method !== "turn/started" &&
    method !== "thread/started"
  )
    return payload;
  const redacted = { redacted: true, reason: "codex-unqualified-error-metadata" };
  const root = ownRecord(payload);
  if (!root) return redacted;
  if (method === "thread/started") {
    const thread = ownRecord(root.thread);
    if (!thread) return redacted;
    // Thread startup can include prior failed turns. Bound this diagnostic-only
    // scan and inspect own inert array entries, never map/species or inherited
    // accessors. No native turn/error identity or classification is changed.
    const turns = thread.turns;
    if (!Array.isArray(turns)) return redacted;
    try {
      if (Object.getPrototypeOf(turns) !== Array.prototype) return redacted;
      const length = Object.getOwnPropertyDescriptor(turns, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 1_000) return redacted;
      const descriptors = Object.getOwnPropertyDescriptors(turns) as Record<
        string,
        PropertyDescriptor
      >;
      if (Object.values(descriptors).some((descriptor) => !("value" in descriptor)))
        return redacted;
      if (
        Object.keys(descriptors).some(
          (key) => key !== "length" && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length),
        )
      )
        return redacted;
      for (let index = 0; index < length; index++) {
        const entry = descriptors[String(index)];
        const priorTurn = entry && "value" in entry ? ownRecord(entry.value) : undefined;
        if (!priorTurn) return redacted;
        if (
          priorTurn.error !== undefined &&
          priorTurn.error !== null &&
          !hasOnlyQualifiedDiagnosticErrorFields(priorTurn.error)
        )
          return redacted;
      }
      return payload;
    } catch {
      return redacted;
    }
  }
  const turn =
    method === "turn/completed" || method === "turn/started" ? ownRecord(root.turn) : undefined;
  if ((method === "turn/completed" || method === "turn/started") && !turn) return redacted;
  const error = turn ? turn.error : root.error;
  if (turn && (error === undefined || error === null)) return payload;
  return hasOnlyQualifiedDiagnosticErrorFields(error) ? payload : redacted;
}

export function classifyCodexTransientFailure(
  value: unknown,
): CodexTransientFailureCategory | undefined {
  const error = ownRecord(value);
  if (!error || typeof error.message !== "string" || error.message.length > 4_096) return undefined;
  if (
    Object.keys(error).some(
      (key) => !["message", "codexErrorInfo", "additionalDetails", "misalignment"].includes(key),
    ) ||
    (error.misalignment !== undefined && error.misalignment !== null)
  )
    return undefined;
  const info = error.codexErrorInfo;
  if (info === "serverOverloaded" || info === "internalServerError") return "server";
  if (info === "rateLimitExceeded") return "rate-limit";
  if (info === "other") {
    // A contradictory additional diagnostic must not turn a permanent error
    // into an unattended retry merely because its public message looks fixed.
    const details = error.additionalDetails;
    if (
      details !== undefined &&
      details !== null &&
      (typeof details !== "string" ||
        details.length > 4_096 ||
        (details !== "" && !genericProcessingError.test(details)))
    )
      return undefined;
    return genericProcessingError.test(error.message) ? "server" : undefined;
  }
  const structured = ownRecord(info);
  if (!structured) return undefined;
  const keys = Object.keys(structured);
  if (keys.length !== 1 || !transportVariants.has(keys[0]!)) return undefined;
  const variant = ownRecord(structured[keys[0]!]);
  if (!variant || Object.keys(variant).some((key) => key !== "httpStatusCode")) return undefined;
  const status = variant.httpStatusCode;
  if (status === undefined || status === null) {
    // Retry exhaustion alone does not identify its cause. A positively typed
    // transport interruption does; an absent HTTP code stays unknown, not 0.
    return keys[0] === "responseTooManyFailedAttempts" ? undefined : "transport";
  }
  if (typeof status !== "number" || !Number.isInteger(status) || !temporaryHttpStatuses.has(status))
    return undefined;
  return status === 429 ? "rate-limit" : status >= 500 ? "server" : "transport";
}
