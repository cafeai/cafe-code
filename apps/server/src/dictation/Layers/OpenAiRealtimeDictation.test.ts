import { assert, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../../auth/Services/ServerSecretStore.ts";
import { OpenAiRealtimeDictation } from "../Services/OpenAiRealtimeDictation.ts";
import { OpenAiRealtimeDictationLive } from "./OpenAiRealtimeDictation.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makeTestLayer(
  response: (request: HttpClientRequest.HttpClientRequest) => Response = () =>
    Response.json(
      {
        value: "ek_test_ephemeral_credential",
        expires_at: Math.floor(Date.now() / 1_000) + 60,
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription: { model: "gpt-live-transcribe" },
              turn_detection: null,
            },
          },
        },
      },
      {
        status: 201,
        headers: {
          "openai-processing-ms": "12.4",
          "x-request-id": "req_mint-safe_123",
        },
      },
    ),
) {
  const secrets = new Map<string, Uint8Array>();
  const secretStore = {
    get: (name) =>
      Effect.sync(() => {
        const value = secrets.get(name);
        return value === undefined ? null : value.slice();
      }),
    set: (name, value) =>
      Effect.sync(() => {
        // Copy exactly as the production filesystem store does. The service
        // deliberately zeroes its temporary write buffer after this boundary.
        secrets.set(name, value.slice());
      }),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = secrets.get(name);
        if (existing !== undefined) return existing.slice();
        const created = new Uint8Array(bytes).fill(7);
        secrets.set(name, created.slice());
        return created;
      }),
    remove: (name) =>
      Effect.sync(() => {
        secrets.delete(name);
      }),
  } satisfies ServerSecretStoreShape;

  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, response(request))),
  );
  const layer = OpenAiRealtimeDictationLive.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(Layer.succeed(ServerSecretStore, secretStore)),
  );
  return { execute, layer, secrets };
}

describe("OpenAiRealtimeDictationLive", () => {
  it.effect("keeps the permanent key in the secret store and supports explicit removal", () => {
    const { execute, layer, secrets } = makeTestLayer();
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;

      assert.deepStrictEqual(yield* dictation.getStatus, { configured: false });
      const missing = yield* Effect.flip(
        dictation.createClientSecret({ safetyIdentifier: "session-digest" }),
      );
      assert.strictEqual(missing.code, "not_configured");
      assert.strictEqual(execute.mock.calls.length, 0);

      yield* dictation.setApiKey("  sk-test-permanent  ");
      assert.deepStrictEqual(yield* dictation.getStatus, { configured: true });
      assert.strictEqual(
        decoder.decode(secrets.get("openai-realtime-api-key")),
        "sk-test-permanent",
      );

      yield* dictation.clearApiKey;
      assert.deepStrictEqual(yield* dictation.getStatus, { configured: false });
    }).pipe(Effect.provide(layer));
  });

  it.effect("mints a transcription-only credential with fixed safe request metadata", () => {
    const { execute, layer } = makeTestLayer();
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-test-permanent");
      const result = yield* dictation.createClientSecret({
        safetyIdentifier: "sha256-session-digest",
      });

      assert.strictEqual(result.clientSecret, "ek_test_ephemeral_credential");
      assert.strictEqual(result.model, "gpt-live-transcribe");
      assert.strictEqual(result.sessionProfile, "transcription_pcm24k_minimal_v1");
      assert.strictEqual(result.clientSecretRequestId, "req_mint-safe_123");
      assert.isDefined(result.clientSecretRequestDurationMs);
      assert.isAtLeast(result.clientSecretRequestDurationMs ?? -1, 0);
      assert.strictEqual(result.clientSecretOpenAiProcessingMs, 12);
      assert.strictEqual(result.clientSecretEffectiveProfile, "matches");
      assert.isAbove(result.expiresAt, Math.floor(Date.now() / 1_000));

      const request = execute.mock.calls[0]?.[0];
      assert.isDefined(request);
      assert.strictEqual(request.url, "https://api.openai.com/v1/realtime/client_secrets");
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.headers.authorization, "Bearer sk-test-permanent");
      assert.strictEqual(request.headers["openai-safety-identifier"], "sha256-session-digest");
      const rawBody = (request.body as { readonly body?: Uint8Array }).body;
      assert.isDefined(rawBody);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepStrictEqual(JSON.parse(decoder.decode(rawBody)), {
        expires_after: { anchor: "created_at", seconds: 60 },
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription: { model: "gpt-live-transcribe" },
              turn_detection: null,
            },
          },
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("binds the audited fallback model into the short-lived session", () => {
    const { execute, layer } = makeTestLayer(() =>
      Response.json({
        value: "ek_test_fallback_credential",
        expires_at: Math.floor(Date.now() / 1_000) + 60,
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription: { model: "gpt-realtime-whisper" },
              turn_detection: null,
            },
          },
        },
      }),
    );
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-test-permanent");
      const result = yield* dictation.createClientSecret({
        safetyIdentifier: "sha256-session-digest",
        model: "gpt-realtime-whisper",
      });

      assert.strictEqual(result.model, "gpt-realtime-whisper");
      assert.strictEqual(result.clientSecretEffectiveProfile, "matches");
      const request = execute.mock.calls[0]?.[0];
      assert.isDefined(request);
      const rawBody = (request.body as { readonly body?: Uint8Array }).body;
      assert.isDefined(rawBody);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const body = JSON.parse(decoder.decode(rawBody)) as {
        readonly session: {
          readonly audio: {
            readonly input: { readonly transcription: { readonly model: string } };
          };
        };
      };
      assert.strictEqual(body.session.audio.input.transcription.model, "gpt-realtime-whisper");
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps exhausted API credits separately from transient 429 responses", () => {
    let requestCount = 0;
    const { layer } = makeTestLayer(() => {
      requestCount += 1;
      return requestCount === 1
        ? new Response(
            JSON.stringify({
              error: {
                type: "insufficient_quota",
                code: "insufficient_quota",
                message: "provider account details must never surface",
              },
            }),
            { status: 429 },
          )
        : new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
            status: 429,
          });
    });
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-quota-secret");
      const quotaError = yield* Effect.flip(
        dictation.createClientSecret({ safetyIdentifier: "quota-session" }),
      );
      assert.strictEqual(quotaError.code, "upstream_quota_exhausted");
      assert.notInclude(JSON.stringify(quotaError), "provider account details");
      assert.notInclude(JSON.stringify(quotaError), "sk-quota-secret");

      const transientError = yield* Effect.flip(
        dictation.createClientSecret({ safetyIdentifier: "rate-session" }),
      );
      assert.strictEqual(transientError.code, "upstream_rate_limited");
    }).pipe(Effect.provide(layer));
  });

  it.effect("preserves a known quota status without waiting for its stalled body", () => {
    let closeBody: (() => void) | undefined;
    const stalled = makeTestLayer(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('{"error":{"type":"billing"'));
              closeBody = () => controller.close();
            },
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        ),
    );
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-stalled-secret");
      const fiber = yield* Effect.flip(
        dictation.createClientSecret({ safetyIdentifier: "stalled-session" }),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      assert.isDefined(fiber.pollUnsafe());
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error.code, "upstream_quota_exhausted");
      assert.notInclude(JSON.stringify(error), "sk-stalled-secret");
      yield* Effect.sync(() => closeBody?.());
    }).pipe(Effect.provide(stalled.layer), Effect.provide(TestClock.layer()));
  });

  it.effect("keeps stalled, failed, and oversized 429 bodies rate limited", () => {
    let requestCount = 0;
    let stalledBodyCancelled = false;
    const leakedDetail = "provider-429-stream-failure-must-not-surface";
    const responses = makeTestLayer(() => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('{"error":{"type":"insufficient_quota"'));
            },
            cancel() {
              stalledBodyCancelled = true;
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      if (requestCount === 2) {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error(leakedDetail));
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("x".repeat(65 * 1_024), { status: 429 });
    });
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-429-secret");

      const stalledFiber = yield* Effect.flip(
        dictation.createClientSecret({ safetyIdentifier: "stalled-429-session" }),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      assert.isUndefined(stalledFiber.pollUnsafe());
      yield* TestClock.adjust("250 millis");
      const stalledError = yield* Fiber.join(stalledFiber);
      assert.strictEqual(stalledError.code, "upstream_rate_limited");
      assert.isTrue(stalledBodyCancelled);

      const failedError = yield* Effect.flip(
        dictation.createClientSecret({ safetyIdentifier: "failed-429-session" }),
      );
      assert.strictEqual(failedError.code, "upstream_rate_limited");
      assert.notInclude(JSON.stringify(failedError), leakedDetail);

      const oversizedError = yield* Effect.flip(
        dictation.createClientSecret({ safetyIdentifier: "oversized-429-session" }),
      );
      assert.strictEqual(oversizedError.code, "upstream_rate_limited");
      assert.notInclude(JSON.stringify(oversizedError), "sk-429-secret");
    }).pipe(Effect.provide(responses.layer), Effect.provide(TestClock.layer()));
  });

  it.effect("maps body-stream transport failures to availability errors", () => {
    const leakedDetail = "provider-stream-failure-must-not-surface";
    const failed = makeTestLayer(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error(leakedDetail));
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-stream-secret");
      const error = yield* Effect.flip(
        dictation.createClientSecret({ safetyIdentifier: "stream-failure-session" }),
      );
      assert.strictEqual(error.code, "upstream_unavailable");
      assert.notInclude(JSON.stringify(error), leakedDetail);
      assert.notInclude(JSON.stringify(error), "sk-stream-secret");
    }).pipe(Effect.provide(failed.layer));
  });

  it.effect("maps upstream failures to bounded public errors without response details", () => {
    const leakedDetail = "provider-debug-secret-that-must-not-surface";
    const { layer } = makeTestLayer(
      () => new Response(leakedDetail, { status: 401, statusText: leakedDetail }),
    );
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-secret-that-must-not-surface");
      const error = yield* Effect.flip(
        dictation.createClientSecret({ safetyIdentifier: "session-digest" }),
      );

      assert.strictEqual(error.code, "upstream_auth_failed");
      assert.notInclude(error.message, leakedDetail);
      assert.notInclude(error.message, "sk-secret-that-must-not-surface");
      assert.deepStrictEqual(Object.keys(error).toSorted(), ["_tag", "code"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps client-secret 5xx responses without exposing provider details", () => {
    const leakedDetail = "provider-500-body-must-not-surface";
    const { layer } = makeTestLayer(
      () => new Response(leakedDetail, { status: 500, statusText: leakedDetail }),
    );
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-500-secret-must-not-surface");
      const error = yield* Effect.flip(
        dictation.createClientSecret({ safetyIdentifier: "server-error-session" }),
      );
      assert.strictEqual(error.code, "upstream_unavailable");
      assert.notInclude(JSON.stringify(error), leakedDetail);
      assert.notInclude(JSON.stringify(error), "sk-500-secret-must-not-surface");
    }).pipe(Effect.provide(layer));
  });

  it.effect("classifies deterministic client rejections as non-transient", () => {
    const statuses = [400, 404, 405, 409, 413, 415, 422, 402, 408, 500] as const;
    let responseIndex = 0;
    const leakedDetail = "provider-classification-body-must-not-surface";
    const { layer } = makeTestLayer(() => {
      const status = statuses[responseIndex] ?? 500;
      responseIndex += 1;
      return new Response(leakedDetail, { status });
    });
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-classification-secret");

      for (const [index, status] of statuses.entries()) {
        const error = yield* Effect.flip(
          dictation.createClientSecret({
            safetyIdentifier: `classification-session-${index}`,
          }),
        );
        const expectedCode =
          status === 402
            ? "upstream_quota_exhausted"
            : status >= 400 && status < 500 && status !== 408
              ? "upstream_invalid_response"
              : "upstream_unavailable";
        assert.strictEqual(error.code, expectedCode);
        if (expectedCode === "upstream_invalid_response") {
          assert.strictEqual(error.message, "OpenAI rejected Cafe's dictation configuration.");
        }
        assert.notInclude(JSON.stringify(error), leakedDetail);
        assert.notInclude(JSON.stringify(error), "sk-classification-secret");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects malformed or expired successful responses", () => {
    const malformed = makeTestLayer(() =>
      Response.json({
        value: "ek_test_ephemeral_credential",
        expires_at: Math.floor(Date.now() / 1_000) - 1,
        session: { type: "transcription" },
      }),
    );
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-test-permanent");
      const error = yield* Effect.flip(
        dictation.createClientSecret({ safetyIdentifier: "session-digest" }),
      );
      assert.strictEqual(error.code, "upstream_invalid_response");
    }).pipe(Effect.provide(malformed.layer));
  });

  it.effect("reports an effective-profile mismatch without retaining provider payloads", () => {
    const mismatched = makeTestLayer(() =>
      Response.json({
        value: "ek_test_ephemeral_credential",
        expires_at: Math.floor(Date.now() / 1_000) + 60,
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription: { model: "unexpected-provider-model" },
              turn_detection: null,
            },
          },
        },
      }),
    );
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-test-permanent");
      const result = yield* dictation.createClientSecret({
        safetyIdentifier: "session-digest",
      });
      assert.strictEqual(result.clientSecretEffectiveProfile, "model_mismatch");
      assert.notInclude(JSON.stringify(result), "unexpected-provider-model");
    }).pipe(Effect.provide(mismatched.layer));
  });

  it.effect("drops an upstream identifier that is not an OpenAI request id", () => {
    const invalidRequestId = makeTestLayer(() =>
      Response.json(
        {
          value: "ek_test_ephemeral_credential",
          expires_at: Math.floor(Date.now() / 1_000) + 60,
          session: { type: "transcription" },
        },
        { headers: { "x-request-id": "syntactically_safe_but_not_openai" } },
      ),
    );
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-test-permanent");
      const result = yield* dictation.createClientSecret({
        safetyIdentifier: "session-digest",
      });
      assert.strictEqual(result.clientSecretRequestId, null);
    }).pipe(Effect.provide(invalidRequestId.layer));
  });

  it.effect("stops reading oversized successful responses", () => {
    const oversized = makeTestLayer(() => new Response("x".repeat(65 * 1_024), { status: 200 }));
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-test-permanent");
      const error = yield* Effect.flip(
        dictation.createClientSecret({ safetyIdentifier: "session-digest" }),
      );
      assert.strictEqual(error.code, "upstream_invalid_response");
    }).pipe(Effect.provide(oversized.layer));
  });

  it.effect("bounds ephemeral credential minting per authenticated session", () => {
    const { execute, layer } = makeTestLayer();
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      yield* dictation.setApiKey("sk-test-permanent");
      for (let index = 0; index < 12; index += 1) {
        yield* dictation.createClientSecret({ safetyIdentifier: "same-session-digest" });
      }
      const error = yield* Effect.flip(
        dictation.createClientSecret({ safetyIdentifier: "same-session-digest" }),
      );
      assert.strictEqual(error.code, "rate_limited");
      assert.strictEqual(execute.mock.calls.length, 12);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails closed when the stored secret is corrupted", () => {
    const { layer, secrets } = makeTestLayer();
    secrets.set("openai-realtime-api-key", encoder.encode("bad\nheader"));
    return Effect.gen(function* () {
      const dictation = yield* OpenAiRealtimeDictation;
      const error = yield* Effect.flip(dictation.getStatus);
      assert.strictEqual(error.code, "secret_store_failed");
    }).pipe(Effect.provide(layer));
  });
});
