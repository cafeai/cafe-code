import {
  DICTATION_OPENAI_REQUEST_ID_MAX_CHARS,
  DICTATION_PROVIDER_ERROR_CODES,
  DICTATION_PROVIDER_ERROR_TYPES,
  DICTATION_SESSION_PROFILE,
  DICTATION_TRANSCRIPTION_MODELS,
  type DictationProviderErrorCode,
  type DictationProviderErrorType,
  type DictationTranscriptionModel,
} from "@cafecode/contracts";

import type { RealtimeTranscriptionErrorCode } from "./realtimeTranscription";

const OPENAI_REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]+$/u;
const SHA256_PATTERN = /^[A-Fa-f0-9]{64}$/u;
const MAX_DIAGNOSTIC_ATTEMPTS = 8;
const MAX_TIMELINE_ENTRIES = 32;
const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_BYTE_COUNT = 100 * 1024 * 1024;
const MAX_SDP_LINE_COUNT = 16_384;
const MAX_SDP_MEDIA_SECTION_COUNT = 128;
const MAX_SDP_CANDIDATE_COUNT = 4_096;
const MAX_AUDIO_TRACK_COUNT = 32;
const MAX_AUDIO_SAMPLE_RATE = 768_000;
const MAX_AUDIO_CHANNEL_COUNT = 32;
const MAX_AUDIO_SAMPLE_SIZE = 64;
const MAX_DATE_MS = 8_640_000_000_000_000;
const DICTATION_TRANSCRIPTION_MODEL_CATEGORIES: ReadonlySet<string> = new Set(
  DICTATION_TRANSCRIPTION_MODELS,
);

export type DictationDiagnosticStage =
  | "client_secret"
  | "microphone"
  | "sdp_exchange"
  | "peer_connect"
  | "active"
  | "finalizing"
  | "closed";

export type DictationDiagnosticOutcome =
  | "starting"
  | "retrying"
  | "connected"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * Only retain the broad media type. The complete Content-Type header can
 * contain arbitrary server-controlled parameters and therefore must never be
 * copied into renderer or desktop diagnostics.
 */
export type DictationDiagnosticContentTypeCategory =
  | "missing"
  | "sdp"
  | "json"
  | "html"
  | "text"
  | "other";

export type DictationDiagnosticPeerConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type DictationDiagnosticIceConnectionState =
  | "new"
  | "checking"
  | "connected"
  | "completed"
  | "failed"
  | "disconnected"
  | "closed";

export type DictationDiagnosticIceGatheringState = "new" | "gathering" | "complete";

export type DictationDiagnosticSignalingState =
  | "stable"
  | "have-local-offer"
  | "have-remote-offer"
  | "have-local-pranswer"
  | "have-remote-pranswer"
  | "closed";

export type DictationDiagnosticDataChannelState = "connecting" | "open" | "closing" | "closed";

export type DictationDiagnosticAudioTrackState = "live" | "ended";

export type DictationDiagnosticClientSecretEffectiveProfile =
  | "matches"
  | "not_reported"
  | "model_mismatch"
  | "format_mismatch"
  | "turn_detection_mismatch"
  | "malformed";

/**
 * Safe response-header observations used by both the client-secret mint and
 * the direct WebRTC exchange. This is intentionally not a generic header map:
 * credentials and arbitrary provider headers cannot fit in this type.
 */
export interface DictationSafeResponseHeaderDiagnostics {
  readonly requestId: string | null;
  readonly openAiProcessingMs: number | null;
  readonly retryAfterMs: number | null;
  readonly contentTypeCategory: DictationDiagnosticContentTypeCategory;
  readonly contentLengthBytes: number | null;
}

/**
 * One immutable, content-free lifecycle observation. Entries contain only
 * bounded numbers, booleans, enums, `req_`-prefixed request IDs, finite provider
 * error categories, and a SHA-256 fingerprint. They can never retain a
 * key/token, header map, SDP, audio, transcript, provider message/body, raw
 * Error, URL, or local path.
 */
export interface DictationDiagnosticTimelineEntry {
  readonly capturedAt: string;
  readonly operationElapsedMs: number;
  readonly stageElapsedMs: number;
  readonly attemptElapsedMs: number | null;
  readonly stage: DictationDiagnosticStage | null;
  readonly outcome: DictationDiagnosticOutcome | null;
  readonly attempt: number | null;
  readonly maxAttempts: number | null;
  readonly requestDurationMs: number | null;
  readonly httpStatus: number | null;
  readonly requestId: string | null;
  readonly openAiProcessingMs: number | null;
  readonly retryAfterMs: number | null;
  readonly responseContentTypeCategory: DictationDiagnosticContentTypeCategory | null;
  readonly responseContentLengthBytes: number | null;
  readonly providerErrorType: DictationProviderErrorType | null;
  readonly providerErrorCode: DictationProviderErrorCode | null;
  readonly responseBodyBytes: number | null;
  readonly responseBodySha256: string | null;
  readonly responseBodyTruncated: boolean | null;
  readonly sessionProfile: typeof DICTATION_SESSION_PROFILE | null;
  readonly clientSecretModel: DictationTranscriptionModel | null;
  readonly clientSecretLifetimeMs: number | null;
  readonly clientSecretRequestId: string | null;
  readonly clientSecretRequestDurationMs: number | null;
  readonly clientSecretOpenAiProcessingMs: number | null;
  readonly clientSecretEffectiveProfile: DictationDiagnosticClientSecretEffectiveProfile | null;
  readonly offerSdpBytes: number | null;
  readonly offerSdpLineCount: number | null;
  readonly offerMediaSectionCount: number | null;
  readonly offerAudioSectionCount: number | null;
  readonly offerApplicationSectionCount: number | null;
  readonly offerCandidateCount: number | null;
  readonly offerHasOpus: boolean | null;
  readonly offerHasIceCandidate: boolean | null;
  readonly answerSdpBytes: number | null;
  readonly answerSdpLineCount: number | null;
  readonly answerMediaSectionCount: number | null;
  readonly answerAudioSectionCount: number | null;
  readonly answerApplicationSectionCount: number | null;
  readonly answerCandidateCount: number | null;
  readonly answerHasOpus: boolean | null;
  readonly answerHasIceCandidate: boolean | null;
  readonly peerConnectionState: DictationDiagnosticPeerConnectionState | null;
  readonly iceConnectionState: DictationDiagnosticIceConnectionState | null;
  readonly iceGatheringState: DictationDiagnosticIceGatheringState | null;
  readonly signalingState: DictationDiagnosticSignalingState | null;
  readonly dataChannelState: DictationDiagnosticDataChannelState | null;
  readonly audioTrackCount: number | null;
  readonly audioTrackState: DictationDiagnosticAudioTrackState | null;
  readonly audioTrackEnabled: boolean | null;
  readonly audioTrackMuted: boolean | null;
  readonly audioSampleRate: number | null;
  readonly audioChannelCount: number | null;
  readonly audioSampleSize: number | null;
  readonly audioEchoCancellation: boolean | null;
  readonly audioNoiseSuppression: boolean | null;
  readonly audioAutoGainControl: boolean | null;
  readonly errorCode: RealtimeTranscriptionErrorCode | null;
}

/**
 * This is the complete allowlist for dictation data that may enter Cafe's
 * renderer debug snapshot. The top-level fields mirror the latest timeline
 * entry for compatibility and fast inspection; `timeline` preserves the
 * bounded retry/stage history needed to diagnose an intermittent handshake.
 */
export interface DictationDiagnosticSnapshot extends DictationDiagnosticTimelineEntry {
  readonly timeline: readonly DictationDiagnosticTimelineEntry[];
  readonly omittedTimelineEntryCount: number;
}

export interface DictationDiagnosticUpdate {
  readonly nowMs: number;
  readonly stage: DictationDiagnosticStage;
  readonly outcome: DictationDiagnosticOutcome;
  readonly attempt?: number | null;
  readonly maxAttempts?: number | null;
  readonly requestDurationMs?: number | null;
  readonly httpStatus?: number | null;
  readonly requestId?: string | null;
  readonly openAiProcessingMs?: number | null;
  readonly retryAfterMs?: number | null;
  readonly responseContentTypeCategory?: DictationDiagnosticContentTypeCategory | null;
  readonly responseContentLengthBytes?: number | null;
  readonly providerErrorType?: string | null;
  readonly providerErrorCode?: string | null;
  readonly responseBodyBytes?: number | null;
  readonly responseBodySha256?: string | null;
  readonly responseBodyTruncated?: boolean | null;
  readonly sessionProfile?: string | null;
  readonly clientSecretModel?: string | null;
  readonly clientSecretLifetimeMs?: number | null;
  readonly clientSecretRequestId?: string | null;
  readonly clientSecretRequestDurationMs?: number | null;
  readonly clientSecretOpenAiProcessingMs?: number | null;
  readonly clientSecretEffectiveProfile?: DictationDiagnosticClientSecretEffectiveProfile | null;
  readonly offerSdpBytes?: number | null;
  readonly offerSdpLineCount?: number | null;
  readonly offerMediaSectionCount?: number | null;
  readonly offerAudioSectionCount?: number | null;
  readonly offerApplicationSectionCount?: number | null;
  readonly offerCandidateCount?: number | null;
  readonly offerHasOpus?: boolean | null;
  readonly offerHasIceCandidate?: boolean | null;
  readonly answerSdpBytes?: number | null;
  readonly answerSdpLineCount?: number | null;
  readonly answerMediaSectionCount?: number | null;
  readonly answerAudioSectionCount?: number | null;
  readonly answerApplicationSectionCount?: number | null;
  readonly answerCandidateCount?: number | null;
  readonly answerHasOpus?: boolean | null;
  readonly answerHasIceCandidate?: boolean | null;
  readonly peerConnectionState?: DictationDiagnosticPeerConnectionState | null;
  readonly iceConnectionState?: DictationDiagnosticIceConnectionState | null;
  readonly iceGatheringState?: DictationDiagnosticIceGatheringState | null;
  readonly signalingState?: DictationDiagnosticSignalingState | null;
  readonly dataChannelState?: DictationDiagnosticDataChannelState | null;
  readonly audioTrackCount?: number | null;
  readonly audioTrackState?: DictationDiagnosticAudioTrackState | null;
  readonly audioTrackEnabled?: boolean | null;
  readonly audioTrackMuted?: boolean | null;
  readonly audioSampleRate?: number | null;
  readonly audioChannelCount?: number | null;
  readonly audioSampleSize?: number | null;
  readonly audioEchoCancellation?: boolean | null;
  readonly audioNoiseSuppression?: boolean | null;
  readonly audioAutoGainControl?: boolean | null;
  readonly errorCode?: RealtimeTranscriptionErrorCode | null;
}

interface DictationDiagnosticOperationState {
  operationStartedAtMs: number | null;
  stageStartedAtMs: number | null;
  attemptStartedAtMs: number | null;
  currentStage: DictationDiagnosticStage | null;
  currentAttempt: number | null;
  timeline: DictationDiagnosticTimelineEntry[];
  omittedTimelineEntryCount: number;
}

const DICTATION_STAGES: ReadonlySet<string> = new Set([
  "client_secret",
  "microphone",
  "sdp_exchange",
  "peer_connect",
  "active",
  "finalizing",
  "closed",
]);
const DICTATION_OUTCOMES: ReadonlySet<string> = new Set([
  "starting",
  "retrying",
  "connected",
  "completed",
  "cancelled",
  "failed",
]);
const DICTATION_ERROR_CODES: ReadonlySet<string> = new Set([
  "not_configured",
  "not_authorized",
  "insecure_transport",
  "rate_limited",
  "secret_store_failed",
  "upstream_auth_failed",
  "upstream_rate_limited",
  "upstream_unavailable",
  "upstream_invalid_response",
  "cancelled",
  "connection_failed",
  "finalization_timeout",
  "microphone_denied",
  "microphone_unavailable",
  "protocol_error",
  "session_rejected",
  "session_expired",
  "session_setup_failed",
  "transcript_conflict",
  "unsupported",
]);
const CONTENT_TYPE_CATEGORIES: ReadonlySet<string> = new Set([
  "missing",
  "sdp",
  "json",
  "html",
  "text",
  "other",
]);
const PEER_CONNECTION_STATES: ReadonlySet<string> = new Set([
  "new",
  "connecting",
  "connected",
  "disconnected",
  "failed",
  "closed",
]);
const ICE_CONNECTION_STATES: ReadonlySet<string> = new Set([
  "new",
  "checking",
  "connected",
  "completed",
  "failed",
  "disconnected",
  "closed",
]);
const ICE_GATHERING_STATES: ReadonlySet<string> = new Set(["new", "gathering", "complete"]);
const SIGNALING_STATES: ReadonlySet<string> = new Set([
  "stable",
  "have-local-offer",
  "have-remote-offer",
  "have-local-pranswer",
  "have-remote-pranswer",
  "closed",
]);
const DATA_CHANNEL_STATES: ReadonlySet<string> = new Set([
  "connecting",
  "open",
  "closing",
  "closed",
]);
const AUDIO_TRACK_STATES: ReadonlySet<string> = new Set(["live", "ended"]);
const CLIENT_SECRET_EFFECTIVE_PROFILES: ReadonlySet<string> = new Set([
  "matches",
  "not_reported",
  "model_mismatch",
  "format_mismatch",
  "turn_detection_mismatch",
  "malformed",
]);
const PROVIDER_ERROR_TYPES: ReadonlySet<string> = new Set(DICTATION_PROVIDER_ERROR_TYPES);
const PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set(DICTATION_PROVIDER_ERROR_CODES);

let latestSnapshot: DictationDiagnosticSnapshot | null = null;
let currentOperationGeneration = 0;

function normalizeAllowlistedString<T extends string>(
  value: unknown,
  allowlist: ReadonlySet<string>,
): T | null {
  return typeof value === "string" && allowlist.has(value) ? (value as T) : null;
}

/** Accept only OpenAI's documented opaque request-id token shape. */
function normalizeOpenAiRequestId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= DICTATION_OPENAI_REQUEST_ID_MAX_CHARS &&
    OPENAI_REQUEST_ID_PATTERN.test(value)
    ? value
    : null;
}

export function readSafeOpenAiRequestId(headers: Pick<Headers, "get">): string | null {
  return normalizeOpenAiRequestId(headers.get("x-request-id"));
}

function normalizeProviderErrorCategory<T extends string>(
  value: unknown,
  allowlist: ReadonlySet<string>,
  fallback: T,
): T | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && allowlist.has(value) ? (value as T) : fallback;
}

function normalizeExactLiteral<const T extends string>(value: unknown, expected: T): T | null {
  return value === expected ? expected : null;
}

function normalizeSha256(value: unknown): string | null {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value.toLowerCase() : null;
}

function normalizeAttempt(value: unknown): number | null {
  return Number.isSafeInteger(value) &&
    typeof value === "number" &&
    value > 0 &&
    value <= MAX_DIAGNOSTIC_ATTEMPTS
    ? value
    : null;
}

function normalizeHttpStatus(value: unknown): number | null {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 100 && value <= 599
    ? value
    : null;
}

function normalizeBoundedInteger(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0 && value <= maximum
    ? value
    : null;
}

function normalizePositiveBoundedInteger(value: unknown, maximum: number): number | null {
  const normalized = normalizeBoundedInteger(value, maximum);
  return normalized !== null && normalized > 0 ? normalized : null;
}

function normalizeDurationMs(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_DURATION_MS
    ? Math.round(value * 100) / 100
    : null;
}

function elapsedMs(nowMs: number, startedAtMs: number): number {
  return Math.round(Math.min(MAX_DURATION_MS, Math.max(0, nowMs - startedAtMs)) * 100) / 100;
}

function normalizeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeNowMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_DATE_MS
    ? value
    : 0;
}

function parseBoundedDecimal(value: string | null, maximum: number): number | null {
  if (
    value === null ||
    value.length === 0 ||
    value.length > 24 ||
    !/^\d+(?:\.\d+)?$/u.test(value)
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum
    ? Math.round(parsed * 100) / 100
    : null;
}

function parseBoundedIntegerHeader(value: string | null, maximum: number): number | null {
  if (value === null || value.length === 0 || value.length > 16 || !/^\d+$/u.test(value)) {
    return null;
  }
  return normalizeBoundedInteger(Number(value), maximum);
}

/** Convert a raw media type to a fixed category without retaining parameters. */
export function categorizeDictationResponseContentType(
  value: string | null | undefined,
): DictationDiagnosticContentTypeCategory {
  if (value === null || value === undefined || value.length === 0) return "missing";
  if (value.length > 256) return "other";
  if (value.trim().length === 0) return "missing";
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/sdp") return "sdp";
  if (mediaType === "application/json" || mediaType?.endsWith("+json") === true) return "json";
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return "html";
  if (mediaType?.startsWith("text/") === true) return "text";
  return "other";
}

/**
 * Read the small subset of OpenAI response headers useful for troubleshooting.
 * Retry-After accepts either delta-seconds or an HTTP date, but the source
 * string is discarded immediately so it cannot become a covert debug payload.
 */
export function readSafeOpenAiResponseHeaders(
  headers: Pick<Headers, "get">,
  nowMs: number,
): DictationSafeResponseHeaderDiagnostics {
  const retryAfter = headers.get("retry-after");
  let retryAfterMs = parseBoundedDecimal(retryAfter, MAX_DURATION_MS / 1_000);
  if (retryAfterMs !== null) {
    retryAfterMs = normalizeDurationMs(retryAfterMs * 1_000);
  } else if (retryAfter !== null && retryAfter.length <= 64) {
    const retryAtMs = Date.parse(retryAfter);
    const normalizedNowMs = normalizeNowMs(nowMs);
    retryAfterMs = Number.isFinite(retryAtMs)
      ? normalizeDurationMs(Math.max(0, retryAtMs - normalizedNowMs))
      : null;
  }

  return Object.freeze({
    requestId: readSafeOpenAiRequestId(headers),
    openAiProcessingMs: parseBoundedDecimal(headers.get("openai-processing-ms"), MAX_DURATION_MS),
    retryAfterMs,
    contentTypeCategory: categorizeDictationResponseContentType(headers.get("content-type")),
    contentLengthBytes: parseBoundedIntegerHeader(headers.get("content-length"), MAX_BYTE_COUNT),
  });
}

function buildTimelineEntry(
  input: DictationDiagnosticUpdate,
  state: DictationDiagnosticOperationState,
): DictationDiagnosticTimelineEntry {
  const requestedNowMs = normalizeNowMs(input.nowMs);
  const nowMs = Math.max(state.operationStartedAtMs ?? requestedNowMs, requestedNowMs);
  const stage = normalizeAllowlistedString<DictationDiagnosticStage>(input.stage, DICTATION_STAGES);
  const outcome = normalizeAllowlistedString<DictationDiagnosticOutcome>(
    input.outcome,
    DICTATION_OUTCOMES,
  );
  const attempt = normalizeAttempt(input.attempt);

  if (state.operationStartedAtMs === null) state.operationStartedAtMs = nowMs;
  if (state.stageStartedAtMs === null || stage !== state.currentStage) {
    state.stageStartedAtMs = nowMs;
    state.currentStage = stage;
  }
  if (attempt === null) {
    state.attemptStartedAtMs = null;
    state.currentAttempt = null;
  } else if (state.attemptStartedAtMs === null || attempt !== state.currentAttempt) {
    state.attemptStartedAtMs = nowMs;
    state.currentAttempt = attempt;
  }

  return Object.freeze({
    capturedAt: new Date(nowMs).toISOString(),
    operationElapsedMs: elapsedMs(nowMs, state.operationStartedAtMs),
    stageElapsedMs: elapsedMs(nowMs, state.stageStartedAtMs),
    attemptElapsedMs:
      state.attemptStartedAtMs === null ? null : elapsedMs(nowMs, state.attemptStartedAtMs),
    stage,
    outcome,
    attempt,
    maxAttempts: normalizeAttempt(input.maxAttempts),
    requestDurationMs: normalizeDurationMs(input.requestDurationMs),
    httpStatus: normalizeHttpStatus(input.httpStatus),
    requestId: normalizeOpenAiRequestId(input.requestId),
    openAiProcessingMs: normalizeDurationMs(input.openAiProcessingMs),
    retryAfterMs: normalizeDurationMs(input.retryAfterMs),
    responseContentTypeCategory:
      input.responseContentTypeCategory === null || input.responseContentTypeCategory === undefined
        ? null
        : normalizeAllowlistedString<DictationDiagnosticContentTypeCategory>(
            input.responseContentTypeCategory,
            CONTENT_TYPE_CATEGORIES,
          ),
    responseContentLengthBytes: normalizeBoundedInteger(
      input.responseContentLengthBytes,
      MAX_BYTE_COUNT,
    ),
    providerErrorType: normalizeProviderErrorCategory<DictationProviderErrorType>(
      input.providerErrorType,
      PROVIDER_ERROR_TYPES,
      "other",
    ),
    providerErrorCode: normalizeProviderErrorCategory<DictationProviderErrorCode>(
      input.providerErrorCode,
      PROVIDER_ERROR_CODES,
      "other",
    ),
    responseBodyBytes: normalizeBoundedInteger(input.responseBodyBytes, MAX_BYTE_COUNT),
    responseBodySha256: normalizeSha256(input.responseBodySha256),
    responseBodyTruncated: normalizeBoolean(input.responseBodyTruncated),
    sessionProfile: normalizeExactLiteral(input.sessionProfile, DICTATION_SESSION_PROFILE),
    clientSecretModel: normalizeAllowlistedString<DictationTranscriptionModel>(
      input.clientSecretModel,
      DICTATION_TRANSCRIPTION_MODEL_CATEGORIES,
    ),
    clientSecretLifetimeMs: normalizeDurationMs(input.clientSecretLifetimeMs),
    clientSecretRequestId: normalizeOpenAiRequestId(input.clientSecretRequestId),
    clientSecretRequestDurationMs: normalizeDurationMs(input.clientSecretRequestDurationMs),
    clientSecretOpenAiProcessingMs: normalizeDurationMs(input.clientSecretOpenAiProcessingMs),
    clientSecretEffectiveProfile:
      normalizeAllowlistedString<DictationDiagnosticClientSecretEffectiveProfile>(
        input.clientSecretEffectiveProfile,
        CLIENT_SECRET_EFFECTIVE_PROFILES,
      ),
    offerSdpBytes: normalizeBoundedInteger(input.offerSdpBytes, MAX_BYTE_COUNT),
    offerSdpLineCount: normalizeBoundedInteger(input.offerSdpLineCount, MAX_SDP_LINE_COUNT),
    offerMediaSectionCount: normalizeBoundedInteger(
      input.offerMediaSectionCount,
      MAX_SDP_MEDIA_SECTION_COUNT,
    ),
    offerAudioSectionCount: normalizeBoundedInteger(
      input.offerAudioSectionCount,
      MAX_SDP_MEDIA_SECTION_COUNT,
    ),
    offerApplicationSectionCount: normalizeBoundedInteger(
      input.offerApplicationSectionCount,
      MAX_SDP_MEDIA_SECTION_COUNT,
    ),
    offerCandidateCount: normalizeBoundedInteger(
      input.offerCandidateCount,
      MAX_SDP_CANDIDATE_COUNT,
    ),
    offerHasOpus: normalizeBoolean(input.offerHasOpus),
    offerHasIceCandidate: normalizeBoolean(input.offerHasIceCandidate),
    answerSdpBytes: normalizeBoundedInteger(input.answerSdpBytes, MAX_BYTE_COUNT),
    answerSdpLineCount: normalizeBoundedInteger(input.answerSdpLineCount, MAX_SDP_LINE_COUNT),
    answerMediaSectionCount: normalizeBoundedInteger(
      input.answerMediaSectionCount,
      MAX_SDP_MEDIA_SECTION_COUNT,
    ),
    answerAudioSectionCount: normalizeBoundedInteger(
      input.answerAudioSectionCount,
      MAX_SDP_MEDIA_SECTION_COUNT,
    ),
    answerApplicationSectionCount: normalizeBoundedInteger(
      input.answerApplicationSectionCount,
      MAX_SDP_MEDIA_SECTION_COUNT,
    ),
    answerCandidateCount: normalizeBoundedInteger(
      input.answerCandidateCount,
      MAX_SDP_CANDIDATE_COUNT,
    ),
    answerHasOpus: normalizeBoolean(input.answerHasOpus),
    answerHasIceCandidate: normalizeBoolean(input.answerHasIceCandidate),
    peerConnectionState: normalizeAllowlistedString<DictationDiagnosticPeerConnectionState>(
      input.peerConnectionState,
      PEER_CONNECTION_STATES,
    ),
    iceConnectionState: normalizeAllowlistedString<DictationDiagnosticIceConnectionState>(
      input.iceConnectionState,
      ICE_CONNECTION_STATES,
    ),
    iceGatheringState: normalizeAllowlistedString<DictationDiagnosticIceGatheringState>(
      input.iceGatheringState,
      ICE_GATHERING_STATES,
    ),
    signalingState: normalizeAllowlistedString<DictationDiagnosticSignalingState>(
      input.signalingState,
      SIGNALING_STATES,
    ),
    dataChannelState: normalizeAllowlistedString<DictationDiagnosticDataChannelState>(
      input.dataChannelState,
      DATA_CHANNEL_STATES,
    ),
    audioTrackCount: normalizeBoundedInteger(input.audioTrackCount, MAX_AUDIO_TRACK_COUNT),
    audioTrackState: normalizeAllowlistedString<DictationDiagnosticAudioTrackState>(
      input.audioTrackState,
      AUDIO_TRACK_STATES,
    ),
    audioTrackEnabled: normalizeBoolean(input.audioTrackEnabled),
    audioTrackMuted: normalizeBoolean(input.audioTrackMuted),
    audioSampleRate: normalizePositiveBoundedInteger(input.audioSampleRate, MAX_AUDIO_SAMPLE_RATE),
    audioChannelCount: normalizePositiveBoundedInteger(
      input.audioChannelCount,
      MAX_AUDIO_CHANNEL_COUNT,
    ),
    audioSampleSize: normalizePositiveBoundedInteger(input.audioSampleSize, MAX_AUDIO_SAMPLE_SIZE),
    audioEchoCancellation: normalizeBoolean(input.audioEchoCancellation),
    audioNoiseSuppression: normalizeBoolean(input.audioNoiseSuppression),
    audioAutoGainControl: normalizeBoolean(input.audioAutoGainControl),
    errorCode: normalizeAllowlistedString<RealtimeTranscriptionErrorCode>(
      input.errorCode,
      DICTATION_ERROR_CODES,
    ),
  });
}

function recordDictationDiagnostic(
  input: DictationDiagnosticUpdate,
  state: DictationDiagnosticOperationState,
): void {
  const entry = buildTimelineEntry(input, state);
  if (state.timeline.length === MAX_TIMELINE_ENTRIES) {
    state.timeline.shift();
    state.omittedTimelineEntryCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      state.omittedTimelineEntryCount + 1,
    );
  }
  state.timeline.push(entry);
  latestSnapshot = Object.freeze({
    ...entry,
    timeline: Object.freeze([...state.timeline]),
    omittedTimelineEntryCount: state.omittedTimelineEntryCount,
  });
}

/**
 * Give each capture attempt an in-memory generation fence. A canceled older
 * WebRTC operation may settle after a replacement is already active; its late
 * promise handlers must not overwrite the current operation's debug state.
 * The generation is intentionally never exposed through the debug endpoint.
 */
export function beginDictationDiagnosticOperation(): (input: DictationDiagnosticUpdate) => void {
  currentOperationGeneration += 1;
  const operationGeneration = currentOperationGeneration;
  const operationState: DictationDiagnosticOperationState = {
    operationStartedAtMs: null,
    stageStartedAtMs: null,
    attemptStartedAtMs: null,
    currentStage: null,
    currentAttempt: null,
    timeline: [],
    omittedTimelineEntryCount: 0,
  };
  return (input) => {
    if (operationGeneration !== currentOperationGeneration) return;
    recordDictationDiagnostic(input, operationState);
  };
}

/** Return an immutable, content-free diagnostic suitable for `/debug`. */
export function getDictationDiagnosticSnapshot(): DictationDiagnosticSnapshot | null {
  return latestSnapshot;
}

export const __dictationDiagnosticsTestApi = {
  reset(): void {
    latestSnapshot = null;
    currentOperationGeneration = 0;
  },
};
