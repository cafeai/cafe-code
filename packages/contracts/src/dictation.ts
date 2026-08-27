import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The permanent API key crosses exactly one authenticated mutation boundary
 * before it is written to Cafe's server-side secret store. Keep the transport
 * payload deliberately small and reject control characters so a credential
 * cannot smuggle additional headers into a future HTTP implementation.
 */
export const DICTATION_API_KEY_MAX_CHARS = 512;
export const DictationApiKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(DICTATION_API_KEY_MAX_CHARS),
  Schema.isPattern(/^[^\p{Cc}]+$/u),
);
export type DictationApiKey = typeof DictationApiKey.Type;

export const DictationCredentialStatus = Schema.Struct({
  configured: Schema.Boolean,
  /** Only owner sessions may replace or clear the permanent credential. */
  canManage: Schema.Boolean,
});
export type DictationCredentialStatus = typeof DictationCredentialStatus.Type;

export const DictationSetApiKeyInput = Schema.Struct({
  apiKey: DictationApiKey,
});
export type DictationSetApiKeyInput = typeof DictationSetApiKeyInput.Type;

export const DICTATION_TRANSCRIPTION_MODEL = "gpt-live-transcribe" as const;
export const DictationTranscriptionModel = Schema.Literal(DICTATION_TRANSCRIPTION_MODEL);

/**
 * This value is an OpenAI client secret, not Cafe's permanent API key. It is
 * still treated as sensitive and must remain memory-only in the renderer.
 */
export const DictationRealtimeClientSecret = Schema.Struct({
  clientSecret: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  expiresAt: NonNegativeInt,
  model: DictationTranscriptionModel,
});
export type DictationRealtimeClientSecret = typeof DictationRealtimeClientSecret.Type;

export const DictationErrorCode = Schema.Literals([
  "not_configured",
  "not_authorized",
  "insecure_transport",
  "rate_limited",
  "secret_store_failed",
  "upstream_auth_failed",
  "upstream_rate_limited",
  "upstream_unavailable",
  "upstream_invalid_response",
]);
export type DictationErrorCode = typeof DictationErrorCode.Type;

/**
 * Public errors are intentionally code-only plus a fixed, sanitized message.
 * Raw provider response bodies, request objects, and credentials must never be
 * attached as a serializable cause at this RPC boundary.
 */
export class DictationError extends Schema.TaggedErrorClass<DictationError>()("DictationError", {
  code: DictationErrorCode,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
}) {}
