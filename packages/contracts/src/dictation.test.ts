import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DICTATION_API_KEY_MAX_CHARS,
  DictationApiKey,
  DictationRealtimeClientSecret,
} from "./dictation.ts";

const decodeDictationApiKey = Schema.decodeUnknownEffect(DictationApiKey);
const decodeDictationRealtimeClientSecret = Schema.decodeUnknownEffect(
  DictationRealtimeClientSecret,
);

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
      });
      assert.strictEqual(decoded.model, "gpt-live-transcribe");

      assert.isTrue(
        yield* decodeDictationRealtimeClientSecret({
          clientSecret: "ek-short-lived",
          expiresAt: 42,
          model: "whisper-1",
        }).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false })),
      );
    }),
  );
});
