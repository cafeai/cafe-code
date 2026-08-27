import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DICTATION_API_KEY_MAX_CHARS,
  DICTATION_SESSION_PROFILE,
  DictationApiKey,
  DictationCreateClientSecretInput,
  DictationProviderErrorCode,
  DictationProviderErrorType,
  DictationRealtimeClientSecret,
} from "./dictation.ts";

const decodeDictationApiKey = Schema.decodeUnknownEffect(DictationApiKey);
const decodeDictationCreateClientSecretInput = Schema.decodeUnknownEffect(
  DictationCreateClientSecretInput,
);
const decodeDictationRealtimeClientSecret = Schema.decodeUnknownEffect(
  DictationRealtimeClientSecret,
);
const decodeDictationProviderErrorType = Schema.decodeUnknownEffect(DictationProviderErrorType);
const decodeDictationProviderErrorCode = Schema.decodeUnknownEffect(DictationProviderErrorCode);

describe("dictation contracts", () => {
  it.effect("trims valid API keys and rejects control characters", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* decodeDictationApiKey("  sk-test  "), "sk-test");
      assert.isTrue(
        yield* decodeDictationApiKey("sk-test\nInjected: header").pipe(
          Effect.match({ onFailure: () => true, onSuccess: () => false }),
        ),
      );
      assert.isTrue(
        yield* decodeDictationApiKey("x".repeat(DICTATION_API_KEY_MAX_CHARS + 1)).pipe(
          Effect.match({ onFailure: () => true, onSuccess: () => false }),
        ),
      );
    }),
  );

  it.effect("accepts only bounded transcription-scoped ephemeral credentials", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeDictationRealtimeClientSecret({
        clientSecret: "ek-short-lived",
        expiresAt: 42,
        model: "gpt-live-transcribe",
        sessionProfile: DICTATION_SESSION_PROFILE,
        clientSecretRequestId: "req_safe-123",
        clientSecretRequestDurationMs: 72,
        clientSecretOpenAiProcessingMs: 41,
        clientSecretEffectiveProfile: "matches",
      });
      assert.strictEqual(decoded.model, "gpt-live-transcribe");
      assert.strictEqual(decoded.sessionProfile, "transcription_pcm24k_minimal_v1");

      const fallback = yield* decodeDictationRealtimeClientSecret({
        clientSecret: "ek-short-lived-fallback",
        expiresAt: 42,
        model: "gpt-realtime-whisper",
        sessionProfile: DICTATION_SESSION_PROFILE,
      });
      assert.strictEqual(fallback.model, "gpt-realtime-whisper");

      const legacyServerResponse = yield* decodeDictationRealtimeClientSecret({
        clientSecret: "ek-short-lived",
        expiresAt: 42,
        model: "gpt-live-transcribe",
      });
      assert.isUndefined(legacyServerResponse.sessionProfile);

      assert.isTrue(
        yield* decodeDictationRealtimeClientSecret({
          clientSecret: "ek-short-lived",
          expiresAt: 42,
          model: "whisper-1",
          sessionProfile: DICTATION_SESSION_PROFILE,
          clientSecretRequestId: null,
          clientSecretRequestDurationMs: 72,
          clientSecretOpenAiProcessingMs: null,
          clientSecretEffectiveProfile: "not_reported",
        }).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false })),
      );

      assert.isTrue(
        yield* decodeDictationRealtimeClientSecret({
          clientSecret: "ek-short-lived",
          expiresAt: 42,
          model: "gpt-live-transcribe",
          sessionProfile: DICTATION_SESSION_PROFILE,
          clientSecretRequestId: "unsafe request id\nAuthorization",
          clientSecretRequestDurationMs: 72,
          clientSecretOpenAiProcessingMs: null,
          clientSecretEffectiveProfile: "malformed",
        }).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false })),
      );

      assert.isTrue(
        yield* decodeDictationRealtimeClientSecret({
          clientSecret: "ek-short-lived",
          expiresAt: 42,
          model: "gpt-live-transcribe",
          sessionProfile: DICTATION_SESSION_PROFILE,
          clientSecretRequestId: "syntactically_safe_but_not_an_openai_request_id",
        }).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false })),
      );
    }),
  );

  it.effect("keeps provider error diagnostics in a finite semantic vocabulary", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* decodeDictationProviderErrorType("server_error"), "server_error");
      assert.strictEqual(yield* decodeDictationProviderErrorType("other"), "other");
      assert.strictEqual(
        yield* decodeDictationProviderErrorCode("internal_error"),
        "internal_error",
      );
      assert.strictEqual(yield* decodeDictationProviderErrorCode("other"), "other");

      assert.isTrue(
        yield* decodeDictationProviderErrorType("sk_provider_secret").pipe(
          Effect.match({ onFailure: () => true, onSuccess: () => false }),
        ),
      );
      assert.isTrue(
        yield* decodeDictationProviderErrorCode("Bearer_provider_secret").pipe(
          Effect.match({ onFailure: () => true, onSuccess: () => false }),
        ),
      );
    }),
  );

  it.effect("allows only Cafe-audited streaming models for client-secret minting", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* decodeDictationCreateClientSecretInput({}), {});
      assert.deepStrictEqual(
        yield* decodeDictationCreateClientSecretInput({ model: "gpt-realtime-whisper" }),
        { model: "gpt-realtime-whisper" },
      );
      assert.isTrue(
        yield* decodeDictationCreateClientSecretInput({ model: "arbitrary-expensive-model" }).pipe(
          Effect.match({ onFailure: () => true, onSuccess: () => false }),
        ),
      );
    }),
  );
});
