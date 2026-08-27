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
export const DICTATION_FALLBACK_TRANSCRIPTION_MODEL = "gpt-realtime-whisper" as const;
export const DICTATION_TRANSCRIPTION_MODELS = [
  DICTATION_TRANSCRIPTION_MODEL,
  DICTATION_FALLBACK_TRANSCRIPTION_MODEL,
] as const;
export const DictationTranscriptionModel = Schema.Literals(DICTATION_TRANSCRIPTION_MODELS);
export type DictationTranscriptionModel = typeof DictationTranscriptionModel.Type;

/**
 * The renderer may request only one of Cafe's audited streaming transcription
 * models. Keeping this allowlist in the shared RPC schema prevents a modified
 * client from turning the server-side API key into an unrestricted model
 * credential minting proxy.
 */
export const DictationCreateClientSecretInput = Schema.Struct({
  model: Schema.optional(DictationTranscriptionModel),
});
export type DictationCreateClientSecretInput = typeof DictationCreateClientSecretInput.Type;

/**
 * Upstream error identifiers are provider-controlled strings. Diagnostics may
 * preserve only this small semantic vocabulary; every other reported value is
 * collapsed to `other` by each consumer before it reaches a debug surface.
 * Keep the fallback in the schema so downstream snapshots remain finite even
 * when OpenAI introduces a new identifier or returns attacker-influenced text.
 */
export const DICTATION_PROVIDER_ERROR_TYPES = [
  "invalid_request_error",
  "server_error",
  "transcription_error",
  "insufficient_quota",
  "other",
] as const;
export const DictationProviderErrorType = Schema.Literals(DICTATION_PROVIDER_ERROR_TYPES);
export type DictationProviderErrorType = typeof DictationProviderErrorType.Type;

export const DICTATION_PROVIDER_ERROR_CODES = [
  "invalid_event",
  "internal_error",
  "audio_unintelligible",
  "allocation_failed",
  "insufficient_quota",
  "other",
] as const;
export const DictationProviderErrorCode = Schema.Literals(DICTATION_PROVIDER_ERROR_CODES);
export type DictationProviderErrorCode = typeof DictationProviderErrorCode.Type;

/**
 * Version the exact token-bound Realtime session profile separately from the
 * model name. This makes a failed WebRTC exchange diagnosable without exposing
 * the client secret or the session payload through Cafe's debug surface.
 */
export const DICTATION_SESSION_PROFILE = "transcription_pcm24k_minimal_v1" as const;
export const DictationSessionProfile = Schema.Literal(DICTATION_SESSION_PROFILE);
export const DictationEffectiveSessionProfile = Schema.Literals([
  "matches",
  "not_reported",
  "model_mismatch",
  "format_mismatch",
  "turn_detection_mismatch",
  "malformed",
]);
export type DictationEffectiveSessionProfile = typeof DictationEffectiveSessionProfile.Type;

export const DICTATION_OPENAI_REQUEST_ID_PREFIX = "req_" as const;
export const DICTATION_OPENAI_REQUEST_ID_MAX_CHARS = 128;
export const DictationOpenAiRequestId = Schema.NullOr(
  Schema.String.check(
    Schema.isMinLength(DICTATION_OPENAI_REQUEST_ID_PREFIX.length + 1),
    Schema.isMaxLength(DICTATION_OPENAI_REQUEST_ID_MAX_CHARS),
    Schema.isPattern(/^req_[A-Za-z0-9_-]+$/u),
  ),
);
export type DictationOpenAiRequestId = typeof DictationOpenAiRequestId.Type;
const DictationDiagnosticDurationMs = NonNegativeInt.check(Schema.isLessThanOrEqualTo(600_000));

/**
 * This value is an OpenAI client secret, not Cafe's permanent API key. It is
 * still treated as sensitive and must remain memory-only in the renderer.
 */
export const DictationRealtimeClientSecret = Schema.Struct({
  clientSecret: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  expiresAt: NonNegativeInt,
  model: DictationTranscriptionModel,
  // Optional on the wire so a newer renderer can still use dictation against
  // an older saved remote Cafe environment. Current servers always emit them.
  sessionProfile: Schema.optional(DictationSessionProfile),
  /** Safe OpenAI mint telemetry; none of these fields contains credentials. */
  clientSecretRequestId: Schema.optional(DictationOpenAiRequestId),
  clientSecretRequestDurationMs: Schema.optional(DictationDiagnosticDurationMs),
  clientSecretOpenAiProcessingMs: Schema.optional(Schema.NullOr(DictationDiagnosticDurationMs)),
  clientSecretEffectiveProfile: Schema.optional(DictationEffectiveSessionProfile),
});
export type DictationRealtimeClientSecret = typeof DictationRealtimeClientSecret.Type;

export const DictationErrorCode = Schema.Literals([
  "not_configured",
  "not_authorized",
  "insecure_transport",
  "rate_limited",
  "secret_store_failed",
  "upstream_auth_failed",
  "upstream_quota_exhausted",
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
