import { afterEach, describe, expect, it } from "vitest";

import {
  __dictationDiagnosticsTestApi,
  beginDictationDiagnosticOperation,
  categorizeDictationResponseContentType,
  getDictationDiagnosticSnapshot,
  readSafeOpenAiRequestId,
  readSafeOpenAiResponseHeaders,
} from "./diagnostics";

afterEach(() => {
  __dictationDiagnosticsTestApi.reset();
});

describe("dictation diagnostics", () => {
  it("retains only the bounded operational allowlist", () => {
    const recordDiagnostic = beginDictationDiagnosticOperation();
    recordDiagnostic({
      nowMs: Date.parse("2026-08-27T10:00:00.000Z"),
      stage: "sdp_exchange",
      outcome: "failed",
      attempt: 3,
      maxAttempts: 3,
      httpStatus: 503,
      requestId: "req_safe-123",
      errorCode: "upstream_unavailable",
    });

    expect(getDictationDiagnosticSnapshot()).toMatchObject({
      capturedAt: "2026-08-27T10:00:00.000Z",
      operationElapsedMs: 0,
      stageElapsedMs: 0,
      attemptElapsedMs: 0,
      stage: "sdp_exchange",
      outcome: "failed",
      attempt: 3,
      maxAttempts: 3,
      httpStatus: 503,
      requestId: "req_safe-123",
      errorCode: "upstream_unavailable",
      omittedTimelineEntryCount: 0,
    });
    expect(getDictationDiagnosticSnapshot()?.timeline).toHaveLength(1);
  });

  it.each([
    ["req_abc-123", "req_abc-123"],
    [`req_${"x".repeat(124)}`, `req_${"x".repeat(124)}`],
    ["", null],
    ["req_", null],
    ["safe_token_without_req_prefix", null],
    ["req unsafe", null],
    ["req_unsafe\nAuthorization", null],
    [`req_${"x".repeat(125)}`, null],
  ])("bounds and validates an OpenAI request id", (value, expected) => {
    expect(readSafeOpenAiRequestId({ get: () => value })).toBe(expected);
  });

  it.each([
    [null, "missing"],
    ["application/sdp", "sdp"],
    ["Application/Problem+JSON; charset=utf-8", "json"],
    ["text/html; charset=utf-8", "html"],
    ["text/plain", "text"],
    ["application/octet-stream", "other"],
  ] as const)("categorizes a response media type without retaining it", (value, expected) => {
    expect(categorizeDictationResponseContentType(value)).toBe(expected);
  });

  it("extracts only bounded response-header metadata", () => {
    const headers = new Headers({
      "content-length": "321",
      "content-type": "application/problem+json; private=provider-body-secret",
      "openai-processing-ms": "12.345",
      "retry-after": "1.5",
      "set-cookie": "credential=provider-cookie-secret",
      "x-request-id": "req_header-123",
    });

    const metadata = readSafeOpenAiResponseHeaders(headers, Date.parse("2026-08-27T10:00:00Z"));

    expect(metadata).toEqual({
      requestId: "req_header-123",
      openAiProcessingMs: 12.35,
      retryAfterMs: 1_500,
      contentTypeCategory: "json",
      contentLengthBytes: 321,
    });
    expect(JSON.stringify(metadata)).not.toContain("provider-body-secret");
    expect(JSON.stringify(metadata)).not.toContain("provider-cookie-secret");
  });

  it("normalizes an HTTP-date Retry-After value and rejects malformed headers", () => {
    const nowMs = Date.parse("2026-08-27T10:00:00Z");
    expect(
      readSafeOpenAiResponseHeaders(
        new Headers({ "retry-after": "Thu, 27 Aug 2026 10:00:02 GMT" }),
        nowMs,
      ).retryAfterMs,
    ).toBe(2_000);

    expect(
      readSafeOpenAiResponseHeaders(
        new Headers({
          "content-length": "999999999999999",
          "openai-processing-ms": "server-secret",
          "retry-after": "provider-secret",
          "x-request-id": "req unsafe",
        }),
        nowMs,
      ),
    ).toEqual({
      requestId: null,
      openAiProcessingMs: null,
      retryAfterMs: null,
      contentTypeCategory: "missing",
      contentLengthBytes: null,
    });
  });

  it("normalizes invalid numeric metadata and direct request-id writes", () => {
    const recordDiagnostic = beginDictationDiagnosticOperation();
    recordDiagnostic({
      nowMs: Number.NaN,
      stage: "sdp_exchange",
      outcome: "failed",
      attempt: 99,
      maxAttempts: -1,
      httpStatus: 700,
      requestId: "unsafe request id",
      errorCode: "connection_failed",
    });

    expect(getDictationDiagnosticSnapshot()).toMatchObject({
      capturedAt: "1970-01-01T00:00:00.000Z",
      attempt: null,
      maxAttempts: null,
      httpStatus: null,
      requestId: null,
    });
  });

  it("retains a bounded per-attempt timeline with safe handshake and peer metadata", () => {
    const recordDiagnostic = beginDictationDiagnosticOperation();
    const digest = "A".repeat(64);

    recordDiagnostic({
      nowMs: 1_000,
      stage: "client_secret",
      outcome: "starting",
      sessionProfile: "transcription_pcm24k_minimal_v1",
      clientSecretModel: "gpt-live-transcribe",
      clientSecretLifetimeMs: 60_000,
      clientSecretRequestId: "req_mint-1",
      clientSecretRequestDurationMs: 42.125,
      clientSecretOpenAiProcessingMs: 21.5,
      clientSecretEffectiveProfile: "matches",
    });
    recordDiagnostic({
      nowMs: 1_100,
      stage: "sdp_exchange",
      outcome: "starting",
      attempt: 1,
      maxAttempts: 3,
      offerSdpBytes: 1_024,
      offerSdpLineCount: 24,
      offerMediaSectionCount: 2,
      offerAudioSectionCount: 1,
      offerApplicationSectionCount: 1,
      offerCandidateCount: 3,
      offerHasOpus: true,
      offerHasIceCandidate: true,
    });
    recordDiagnostic({
      nowMs: 1_175,
      stage: "sdp_exchange",
      outcome: "retrying",
      attempt: 1,
      maxAttempts: 3,
      requestDurationMs: 75,
      httpStatus: 500,
      requestId: "req_attempt-1",
      openAiProcessingMs: 63.25,
      retryAfterMs: 1_000,
      responseContentTypeCategory: "json",
      responseContentLengthBytes: 98,
      providerErrorType: "server_error",
      providerErrorCode: "internal_error",
      responseBodyBytes: 98,
      responseBodySha256: digest,
      responseBodyTruncated: true,
      errorCode: "upstream_unavailable",
    });
    recordDiagnostic({
      nowMs: 1_300,
      stage: "sdp_exchange",
      outcome: "starting",
      attempt: 2,
      maxAttempts: 3,
      clientSecretModel: "gpt-realtime-whisper",
    });
    recordDiagnostic({
      nowMs: 1_350,
      stage: "peer_connect",
      outcome: "starting",
      attempt: 2,
      maxAttempts: 3,
      clientSecretModel: "gpt-realtime-whisper",
      requestDurationMs: 50,
      httpStatus: 200,
      requestId: "req_attempt-2",
      responseContentTypeCategory: "sdp",
      responseBodyBytes: 864,
      responseBodySha256: "b".repeat(64),
      answerSdpBytes: 864,
      answerSdpLineCount: 20,
      answerMediaSectionCount: 2,
      answerAudioSectionCount: 1,
      answerApplicationSectionCount: 1,
      answerCandidateCount: 2,
      answerHasOpus: true,
      answerHasIceCandidate: true,
      peerConnectionState: "connecting",
      iceConnectionState: "checking",
      iceGatheringState: "complete",
      signalingState: "stable",
      dataChannelState: "connecting",
      audioTrackCount: 1,
      audioTrackState: "live",
      audioTrackEnabled: true,
      audioTrackMuted: false,
      audioSampleRate: 48_000,
      audioChannelCount: 1,
      audioSampleSize: 16,
      audioEchoCancellation: true,
      audioNoiseSuppression: true,
      audioAutoGainControl: true,
    });

    const snapshot = getDictationDiagnosticSnapshot();
    expect(snapshot).toMatchObject({
      capturedAt: "1970-01-01T00:00:01.350Z",
      operationElapsedMs: 350,
      stageElapsedMs: 0,
      attemptElapsedMs: 50,
      attempt: 2,
      requestDurationMs: 50,
      httpStatus: 200,
      answerSdpBytes: 864,
      answerCandidateCount: 2,
      answerHasOpus: true,
      peerConnectionState: "connecting",
      audioTrackEnabled: true,
      audioSampleRate: 48_000,
      clientSecretModel: "gpt-realtime-whisper",
      omittedTimelineEntryCount: 0,
    });
    expect(snapshot?.timeline).toHaveLength(5);
    expect(snapshot?.timeline[0]).toMatchObject({
      sessionProfile: "transcription_pcm24k_minimal_v1",
      clientSecretRequestId: "req_mint-1",
      clientSecretRequestDurationMs: 42.13,
      clientSecretEffectiveProfile: "matches",
    });
    expect(snapshot?.timeline[2]).toMatchObject({
      operationElapsedMs: 175,
      stageElapsedMs: 75,
      attemptElapsedMs: 75,
      httpStatus: 500,
      providerErrorType: "server_error",
      providerErrorCode: "internal_error",
      responseBodySha256: digest.toLowerCase(),
      responseBodyTruncated: true,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.timeline)).toBe(true);
    expect(Object.isFrozen(snapshot?.timeline[0])).toBe(true);
  });

  it("bounds timeline retention and counts omitted observations", () => {
    const recordDiagnostic = beginDictationDiagnosticOperation();
    for (let index = 0; index < 40; index += 1) {
      recordDiagnostic({
        nowMs: index,
        stage: "active",
        outcome: "connected",
      });
    }

    const snapshot = getDictationDiagnosticSnapshot();
    expect(snapshot?.timeline).toHaveLength(32);
    expect(snapshot?.omittedTimelineEntryCount).toBe(8);
    expect(snapshot?.timeline[0]?.capturedAt).toBe("1970-01-01T00:00:00.008Z");
    expect(snapshot?.operationElapsedMs).toBe(39);
  });

  it("categorizes provider identifiers and drops all other arbitrary strings", () => {
    const providerSecret = "Bearer-provider-secret";
    const recordDiagnostic = beginDictationDiagnosticOperation();
    recordDiagnostic({
      nowMs: 10,
      stage: "sdp_exchange",
      outcome: "failed",
      requestDurationMs: Number.POSITIVE_INFINITY,
      responseContentTypeCategory: "json",
      responseContentLengthBytes: 200_000_000,
      requestId: "sk_provider_request_secret",
      providerErrorType: "sk_provider_type_secret",
      providerErrorCode: "Bearer_provider_code_secret",
      responseBodyBytes: -1,
      responseBodySha256: providerSecret,
      responseBodyTruncated: "provider-truncation-secret" as never,
      sessionProfile: "transcription_pcm24k_minimal_v1_debug",
      clientSecretModel: "gpt-live-transcribe-preview",
      clientSecretLifetimeMs: 100_000_000,
      clientSecretRequestId: "ek_provider_mint_secret",
      clientSecretEffectiveProfile: "provider-profile-secret" as never,
      offerSdpLineCount: 20_000,
      offerAudioSectionCount: 200,
      offerHasOpus: "provider-opus-secret" as never,
      answerCandidateCount: 5_000,
      answerApplicationSectionCount: 200,
      answerHasIceCandidate: "provider-ice-secret" as never,
      peerConnectionState: "failed",
      audioTrackCount: 100,
      audioSampleRate: 1_000_000,
      audioChannelCount: 0,
      audioSampleSize: 128,
      audioEchoCancellation: "provider-echo-secret" as never,
      errorCode: "connection_failed",
    });

    const snapshot = getDictationDiagnosticSnapshot();
    expect(snapshot).toMatchObject({
      requestDurationMs: null,
      responseContentLengthBytes: null,
      requestId: null,
      providerErrorType: "other",
      providerErrorCode: "other",
      responseBodyBytes: null,
      responseBodySha256: null,
      responseBodyTruncated: null,
      sessionProfile: null,
      clientSecretModel: null,
      clientSecretLifetimeMs: null,
      clientSecretRequestId: null,
      clientSecretEffectiveProfile: null,
      offerSdpLineCount: null,
      offerAudioSectionCount: null,
      offerHasOpus: null,
      answerCandidateCount: null,
      answerApplicationSectionCount: null,
      answerHasIceCandidate: null,
      peerConnectionState: "failed",
      audioTrackCount: null,
      audioSampleRate: null,
      audioChannelCount: null,
      audioSampleSize: null,
      audioEchoCancellation: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain(providerSecret);
    expect(JSON.stringify(snapshot)).not.toContain("provider-opus-secret");
    expect(JSON.stringify(snapshot)).not.toContain("provider-echo-secret");
    expect(JSON.stringify(snapshot)).not.toContain("provider-profile-secret");
  });

  it("ignores a late update from an older dictation operation", () => {
    const recordOlderDiagnostic = beginDictationDiagnosticOperation();
    recordOlderDiagnostic({
      nowMs: 1,
      stage: "sdp_exchange",
      outcome: "retrying",
      attempt: 1,
      maxAttempts: 3,
      httpStatus: 503,
      requestId: "req_old",
      errorCode: "upstream_unavailable",
    });

    const recordCurrentDiagnostic = beginDictationDiagnosticOperation();
    recordCurrentDiagnostic({
      nowMs: 2,
      stage: "active",
      outcome: "connected",
      attempt: 1,
      maxAttempts: 3,
      httpStatus: 200,
      requestId: "req_current",
      errorCode: null,
    });
    recordOlderDiagnostic({
      nowMs: 3,
      stage: "sdp_exchange",
      outcome: "failed",
      attempt: 1,
      maxAttempts: 3,
      httpStatus: 503,
      requestId: "req_old",
      errorCode: "upstream_unavailable",
    });

    expect(getDictationDiagnosticSnapshot()).toMatchObject({
      capturedAt: "1970-01-01T00:00:00.002Z",
      stage: "active",
      outcome: "connected",
      requestId: "req_current",
    });
  });
});
