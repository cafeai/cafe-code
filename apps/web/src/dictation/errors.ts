import { getUiLocale, uiText, type UiLocale } from "@cafecode/shared/i18n";
import type { DictationErrorCode } from "@cafecode/contracts";

/**
 * Fixed renderer-owned copy for every public dictation RPC failure. The RPC
 * transport may reject with a structurally similar object from another Cafe
 * server version, so callers must select by this allowlist and must never
 * display the received `message`, `cause`, or provider response body.
 */
export function formatDictationRpcErrorCode(
  code: DictationErrorCode,
  locale: UiLocale = getUiLocale(),
): string {
  switch (code) {
    case "insecure_transport":
      return uiText(
        "Dictation requires HTTPS or a same-machine Cafe connection.",
        undefined,
        undefined,
        locale,
      );
    case "invalid_input":
      return uiText(
        "The draft is empty or too long to rewrite. Edit it and try again.",
        undefined,
        undefined,
        locale,
      );
    case "not_authorized":
      return uiText(
        "This Cafe connection is not allowed to start dictation.",
        undefined,
        undefined,
        locale,
      );
    case "not_configured":
      return uiText(
        "Dictation is not configured on this Cafe server.",
        undefined,
        undefined,
        locale,
      );
    case "rate_limited":
      return uiText(
        "Dictation was started too frequently. Please wait a moment and try again.",
        undefined,
        undefined,
        locale,
      );
    case "secret_store_failed":
      return uiText(
        "Cafe could not access the saved dictation credential.",
        undefined,
        undefined,
        locale,
      );
    case "upstream_auth_failed":
      return uiText(
        "OpenAI rejected the saved dictation credential or its Realtime transcription access.",
        undefined,
        undefined,
        locale,
      );
    case "upstream_quota_exhausted":
      return uiText(
        "This OpenAI API project has insufficient credits or quota for dictation. Add API credits or check its billing and usage limits, then try again.",
        undefined,
        undefined,
        locale,
      );
    case "upstream_invalid_response":
      return uiText(
        "OpenAI returned an invalid dictation session response.",
        undefined,
        undefined,
        locale,
      );
    case "upstream_rate_limited":
      return uiText(
        "OpenAI is rate limiting Realtime transcription. Please wait a moment and try again.",
        undefined,
        undefined,
        locale,
      );
    case "upstream_unavailable":
      return uiText(
        "Cafe could not reach OpenAI to start dictation.",
        undefined,
        undefined,
        locale,
      );
  }
}

// Keep the existing lazy lookup API, with one definition of every sentence.
// Retained feedback instead stores its allowlisted code and uses the explicit
// formatter above; it never infers provenance by reverse-matching a message.
export const DICTATION_RPC_ERROR_MESSAGES: Readonly<Record<DictationErrorCode, string>> = {
  get insecure_transport() {
    return formatDictationRpcErrorCode("insecure_transport");
  },
  get invalid_input() {
    return formatDictationRpcErrorCode("invalid_input");
  },
  get not_authorized() {
    return formatDictationRpcErrorCode("not_authorized");
  },
  get not_configured() {
    return formatDictationRpcErrorCode("not_configured");
  },
  get rate_limited() {
    return formatDictationRpcErrorCode("rate_limited");
  },
  get secret_store_failed() {
    return formatDictationRpcErrorCode("secret_store_failed");
  },
  get upstream_auth_failed() {
    return formatDictationRpcErrorCode("upstream_auth_failed");
  },
  get upstream_quota_exhausted() {
    return formatDictationRpcErrorCode("upstream_quota_exhausted");
  },
  get upstream_invalid_response() {
    return formatDictationRpcErrorCode("upstream_invalid_response");
  },
  get upstream_rate_limited() {
    return formatDictationRpcErrorCode("upstream_rate_limited");
  },
  get upstream_unavailable() {
    return formatDictationRpcErrorCode("upstream_unavailable");
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode only the public error discriminator; all other fields are untrusted. */
export function readDictationRpcErrorCode(error: unknown): DictationErrorCode | null {
  if (!isRecord(error)) return null;

  switch (error.code) {
    case "not_configured":
    case "not_authorized":
    case "insecure_transport":
    case "invalid_input":
    case "rate_limited":
    case "secret_store_failed":
    case "upstream_auth_failed":
    case "upstream_quota_exhausted":
    case "upstream_rate_limited":
    case "upstream_unavailable":
    case "upstream_invalid_response":
      return error.code;
    default:
      return null;
  }
}

export function formatDictationRpcError(
  error: unknown,
  locale: UiLocale = getUiLocale(),
): string | null {
  const code = readDictationRpcErrorCode(error);
  return code === null ? null : formatDictationRpcErrorCode(code, locale);
}
