import {
  DICTATION_OPENAI_REQUEST_ID_MAX_CHARS,
  DICTATION_SESSION_PROFILE,
  DICTATION_TRANSCRIPTION_MODEL,
  DictationApiKey,
  type DictationEffectiveSessionProfile,
  DictationError,
  type DictationRealtimeClientSecret,
  type DictationTranscriptionModel,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import {
  OpenAiRealtimeDictation,
  type OpenAiRealtimeDictationShape,
} from "../Services/OpenAiRealtimeDictation.ts";

const OPENAI_API_KEY_SECRET_NAME = "openai-realtime-api-key";
const OPENAI_CLIENT_SECRET_URL = "https://api.openai.com/v1/realtime/client_secrets";
const CLIENT_SECRET_TTL_SECONDS = 60;
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024;
const ISSUANCE_WINDOW_MS = 60_000;
// One user-visible start can mint up to three independent call attempts. Keep
// enough headroom for a few deliberate retries while still bounding a buggy or
// adversarial renderer to a small number of short-lived credentials per minute.
const MAX_ISSUANCES_PER_WINDOW = 12;
const MAX_TRACKED_IDENTIFIERS = 1_024;
const MAX_SAFE_DIAGNOSTIC_DURATION_MS = 600_000;
const OPENAI_REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]+$/u;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const OpenAiClientSecretResponse = Schema.Struct({
  value: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(4_096)),
  expires_at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  session: Schema.Struct({
    type: Schema.Literal("transcription"),
    audio: Schema.optional(Schema.Unknown),
  }),
});
const decodeDictationApiKey = Schema.decodeUnknownEffect(DictationApiKey);
const decodeOpenAiClientSecretResponse = Schema.decodeUnknownEffect(OpenAiClientSecretResponse);

const sanitizedError = (code: DictationError["code"], message: string): DictationError =>
  new DictationError({ code, message });

function normalizeOpenAiRequestId(value: string | undefined): string | null {
  return value !== undefined &&
    value.length > 0 &&
    value.length <= DICTATION_OPENAI_REQUEST_ID_MAX_CHARS &&
    OPENAI_REQUEST_ID_PATTERN.test(value)
    ? value
    : null;
}

function normalizeDurationMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_SAFE_DIAGNOSTIC_DURATION_MS, Math.round(value));
}

function readOpenAiProcessingMs(value: string | undefined): number | null {
  if (value === undefined || !/^\d+(?:\.\d+)?$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_SAFE_DIAGNOSTIC_DURATION_MS
    ? Math.round(parsed)
    : null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate only fixed, non-sensitive facts from OpenAI's effective session.
 * The endpoint has historically omitted parts of this object, so absence is a
 * diagnostic result rather than a hard failure. Never retain the raw session.
 */
function inspectEffectiveSessionProfile(
  audio: unknown,
  requestedModel: DictationTranscriptionModel,
): DictationEffectiveSessionProfile {
  if (audio === undefined) return "not_reported";
  if (!isUnknownRecord(audio) || !isUnknownRecord(audio.input)) return "malformed";

  const input = audio.input;
  if (!isUnknownRecord(input.transcription)) return "malformed";
  if (input.transcription.model !== requestedModel) return "model_mismatch";

  if (!isUnknownRecord(input.format)) return "malformed";
  if (input.format.type !== "audio/pcm" || input.format.rate !== 24_000) {
    return "format_mismatch";
  }

  if (!("turn_detection" in input)) return "malformed";
  if (input.turn_detection !== null) return "turn_detection_mismatch";
  return "matches";
}

const secretStoreFailure = (): DictationError =>
  sanitizedError("secret_store_failed", "Cafe could not access the saved dictation credential.");

/**
 * Decode the stored bytes every time instead of trusting prior writes. Secret
 * files can be restored, corrupted, or modified while Cafe is stopped. A
 * malformed value therefore fails closed and is never sent upstream.
 */
const decodeStoredApiKey = (
  bytes: Uint8Array | null,
): Effect.Effect<string | null, DictationError> => {
  if (bytes === null) return Effect.succeed(null);
  return Effect.try({
    try: () => textDecoder.decode(bytes),
    catch: () => secretStoreFailure(),
  }).pipe(
    Effect.flatMap((value) =>
      decodeDictationApiKey(value).pipe(Effect.mapError(() => secretStoreFailure())),
    ),
  );
};

export const makeOpenAiRealtimeDictation = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;

  // The rate limiter is deliberately process-local. It bounds accidental or
  // adversarial minting without persisting any client identity or credential.
  const issuanceWindows = new Map<string, ReadonlyArray<number>>();

  const readApiKey = secretStore
    .get(OPENAI_API_KEY_SECRET_NAME)
    .pipe(Effect.mapError(secretStoreFailure), Effect.flatMap(decodeStoredApiKey));

  const getStatus: OpenAiRealtimeDictationShape["getStatus"] = readApiKey.pipe(
    Effect.map((apiKey) => ({ configured: apiKey !== null })),
  );

  const setApiKey: OpenAiRealtimeDictationShape["setApiKey"] = (apiKey) =>
    decodeDictationApiKey(apiKey).pipe(
      Effect.mapError(() =>
        sanitizedError("secret_store_failed", "The OpenAI API key is not valid."),
      ),
      Effect.flatMap((validated) => {
        const bytes = textEncoder.encode(validated);
        return secretStore
          .set(OPENAI_API_KEY_SECRET_NAME, bytes)
          .pipe(
            Effect.mapError(secretStoreFailure),
            Effect.ensuring(Effect.sync(() => bytes.fill(0))),
          );
      }),
    );

  const clearApiKey: OpenAiRealtimeDictationShape["clearApiKey"] = secretStore
    .remove(OPENAI_API_KEY_SECRET_NAME)
    .pipe(Effect.mapError(secretStoreFailure));

  const admitIssuance = (safetyIdentifier: string): Effect.Effect<void, DictationError> =>
    Effect.sync(() => {
      const now = Date.now();
      const active = (issuanceWindows.get(safetyIdentifier) ?? []).filter(
        (issuedAt) => now - issuedAt < ISSUANCE_WINDOW_MS,
      );
      if (active.length >= MAX_ISSUANCES_PER_WINDOW) return false;

      issuanceWindows.set(safetyIdentifier, [...active, now]);
      if (issuanceWindows.size > MAX_TRACKED_IDENTIFIERS) {
        const oldestIdentifier = issuanceWindows.keys().next().value;
        if (typeof oldestIdentifier === "string" && oldestIdentifier !== safetyIdentifier) {
          issuanceWindows.delete(oldestIdentifier);
        }
      }
      return true;
    }).pipe(
      Effect.flatMap((admitted) =>
        admitted
          ? Effect.void
          : Effect.fail(
              sanitizedError(
                "rate_limited",
                "Dictation was started too frequently. Please wait a moment and try again.",
              ),
            ),
      ),
    );

  const decodeSuccessfulResponse = (
    body: string,
    requestedModel: DictationTranscriptionModel,
    diagnostics: {
      readonly requestId: string | null;
      readonly requestDurationMs: number;
      readonly openAiProcessingMs: number | null;
    },
  ): Effect.Effect<DictationRealtimeClientSecret, DictationError> => {
    if (body.length > MAX_UPSTREAM_RESPONSE_BYTES) {
      return Effect.fail(
        sanitizedError(
          "upstream_invalid_response",
          "OpenAI returned an invalid dictation session response.",
        ),
      );
    }
    return Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: () =>
        sanitizedError(
          "upstream_invalid_response",
          "OpenAI returned an invalid dictation session response.",
        ),
    }).pipe(
      Effect.flatMap((json) =>
        decodeOpenAiClientSecretResponse(json).pipe(
          Effect.mapError(() =>
            sanitizedError(
              "upstream_invalid_response",
              "OpenAI returned an invalid dictation session response.",
            ),
          ),
        ),
      ),
      Effect.flatMap((decoded) =>
        decoded.expires_at > Math.floor(Date.now() / 1_000)
          ? Effect.succeed({
              clientSecret: decoded.value,
              expiresAt: decoded.expires_at,
              model: requestedModel,
              sessionProfile: DICTATION_SESSION_PROFILE,
              clientSecretRequestId: diagnostics.requestId,
              clientSecretRequestDurationMs: diagnostics.requestDurationMs,
              clientSecretOpenAiProcessingMs: diagnostics.openAiProcessingMs,
              clientSecretEffectiveProfile: inspectEffectiveSessionProfile(
                decoded.session.audio,
                requestedModel,
              ),
            } satisfies DictationRealtimeClientSecret)
          : Effect.fail(
              sanitizedError(
                "upstream_invalid_response",
                "OpenAI returned an expired dictation session.",
              ),
            ),
      ),
    );
  };

  /**
   * Fetch's convenience `text()` buffers without a limit. Read the body stream
   * ourselves so a compromised or malfunctioning upstream cannot force Cafe
   * to allocate an unbounded response before schema validation runs.
   */
  const readBoundedResponseText = (
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<string, DictationError> =>
    Stream.runFoldEffect(
      response.stream,
      () => ({ chunks: [] as Array<Uint8Array>, byteLength: 0 }),
      (state, chunk) => {
        const byteLength = state.byteLength + chunk.byteLength;
        return byteLength > MAX_UPSTREAM_RESPONSE_BYTES
          ? Effect.fail(
              sanitizedError(
                "upstream_invalid_response",
                "OpenAI returned an invalid dictation session response.",
              ),
            )
          : Effect.sync(() => {
              state.chunks.push(chunk);
              return { chunks: state.chunks, byteLength };
            });
      },
    ).pipe(
      Effect.mapError(() =>
        sanitizedError(
          "upstream_invalid_response",
          "OpenAI returned an invalid dictation session response.",
        ),
      ),
      Effect.flatMap(({ chunks, byteLength }) =>
        Effect.try({
          try: () => {
            const bytes = new Uint8Array(byteLength);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return textDecoder.decode(bytes);
          },
          catch: () =>
            sanitizedError(
              "upstream_invalid_response",
              "OpenAI returned an invalid dictation session response.",
            ),
        }),
      ),
    );

  const createClientSecret: OpenAiRealtimeDictationShape["createClientSecret"] = (input) =>
    Effect.gen(function* () {
      const requestedModel = input.model ?? DICTATION_TRANSCRIPTION_MODEL;
      const apiKey = yield* readApiKey;
      if (apiKey === null) {
        return yield* sanitizedError(
          "not_configured",
          "Dictation is not configured on this Cafe server.",
        );
      }
      yield* admitIssuance(input.safetyIdentifier);

      const request = HttpClientRequest.post(OPENAI_CLIENT_SECRET_URL).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(apiKey),
        HttpClientRequest.setHeader("OpenAI-Safety-Identifier", input.safetyIdentifier),
        HttpClientRequest.bodyJsonUnsafe({
          expires_after: {
            anchor: "created_at",
            seconds: CLIENT_SECRET_TTL_SECONDS,
          },
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24_000 },
                // Keep the token-bound profile at OpenAI's documented minimal
                // transcription shape. Optional noise-reduction and delay
                // controls are valid in isolation, but omitting them removes
                // request variables while investigating opaque HTTP 500s from
                // /v1/realtime/calls. Streaming delta events remain part of
                // both Cafe-audited streaming transcription models without
                // those optional controls.
                // https://developers.openai.com/api/docs/guides/realtime-transcription
                transcription: {
                  model: requestedModel,
                },
                turn_detection: null,
              },
            },
          },
        }),
      );

      // `redirect: manual` prevents a credential-bearing request from ever
      // following an upstream redirect. Tracing is disabled because transport
      // errors may retain the request object (and therefore Authorization).
      const requestStartedAt = Date.now();
      const responseOption = yield* httpClient.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(References.TracerEnabled, false),
        Effect.timeoutOption(UPSTREAM_TIMEOUT_MS),
        Effect.mapError(() =>
          sanitizedError("upstream_unavailable", "Cafe could not reach OpenAI to start dictation."),
        ),
      );
      if (Option.isNone(responseOption)) {
        return yield* sanitizedError(
          "upstream_unavailable",
          "OpenAI did not respond while starting dictation.",
        );
      }

      const response = responseOption.value;
      const requestDurationMs = normalizeDurationMs(Date.now() - requestStartedAt);
      if (response.status === 401 || response.status === 403) {
        return yield* sanitizedError(
          "upstream_auth_failed",
          "OpenAI rejected the saved dictation credential.",
        );
      }
      if (response.status === 429) {
        return yield* sanitizedError(
          "upstream_rate_limited",
          "OpenAI is rate limiting dictation. Please try again shortly.",
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* sanitizedError(
          "upstream_unavailable",
          "OpenAI could not start a dictation session.",
        );
      }

      const declaredLength = Number.parseInt(response.headers["content-length"] ?? "", 10);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_RESPONSE_BYTES) {
        return yield* sanitizedError(
          "upstream_invalid_response",
          "OpenAI returned an invalid dictation session response.",
        );
      }
      const body = yield* readBoundedResponseText(response);
      return yield* decodeSuccessfulResponse(body, requestedModel, {
        requestId: normalizeOpenAiRequestId(response.headers["x-request-id"]),
        requestDurationMs,
        openAiProcessingMs: readOpenAiProcessingMs(response.headers["openai-processing-ms"]),
      });
    });

  return {
    getStatus,
    setApiKey,
    clearApiKey,
    createClientSecret,
  } satisfies OpenAiRealtimeDictationShape;
});

export const OpenAiRealtimeDictationLive = Layer.effect(
  OpenAiRealtimeDictation,
  makeOpenAiRealtimeDictation,
);
