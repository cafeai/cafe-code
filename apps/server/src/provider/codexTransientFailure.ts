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

// This is the exact provider-owned processing error reported at the terminal
// boundary. Do not accept a substring, a vaguely similar assistant sentence,
// or an arbitrary suffix containing a request UUID. The UUID is deliberately
// consumed only by the match and is never returned or retained by this module.
const genericProcessingError =
  /^(?:stream disconnected before completion: )?An error occurred while processing your request\. You can retry your request, or contact us through our help center at help\.openai\.com if the error persists\. Please include the request ID [a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12} in your message\.$/u;

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
