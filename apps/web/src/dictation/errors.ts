import type { DictationErrorCode } from "@cafecode/contracts";

/**
 * Fixed renderer-owned copy for every public dictation RPC failure. The RPC
 * transport may reject with a structurally similar object from another Cafe
 * server version, so callers must select by this allowlist and must never
 * display the received `message`, `cause`, or provider response body.
 */
export const DICTATION_RPC_ERROR_MESSAGES: Readonly<Record<DictationErrorCode, string>> = {
  insecure_transport: "Dictation requires HTTPS or a same-machine Cafe connection.",
  not_authorized: "This Cafe connection is not allowed to start dictation.",
  not_configured: "Dictation is not configured on this Cafe server.",
  rate_limited: "Dictation was started too frequently. Please wait a moment and try again.",
  secret_store_failed: "Cafe could not access the saved dictation credential.",
  upstream_auth_failed:
    "OpenAI rejected the saved dictation credential or its Realtime transcription access.",
  upstream_invalid_response: "OpenAI returned an invalid dictation session response.",
  upstream_rate_limited:
    "OpenAI has no Realtime transcription capacity or quota available for this API project.",
  upstream_unavailable: "Cafe could not reach OpenAI to start dictation.",
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
    case "rate_limited":
    case "secret_store_failed":
    case "upstream_auth_failed":
    case "upstream_rate_limited":
    case "upstream_unavailable":
    case "upstream_invalid_response":
      return error.code;
    default:
      return null;
  }
}

export function formatDictationRpcError(error: unknown): string | null {
  const code = readDictationRpcErrorCode(error);
  return code === null ? null : DICTATION_RPC_ERROR_MESSAGES[code];
}
