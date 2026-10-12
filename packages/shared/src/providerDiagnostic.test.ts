import { describe, expect, it } from "vitest";
import {
  makeProviderDiagnostic,
  PROVIDER_DIAGNOSTIC_MAX_JSON_BYTES,
  readProviderDiagnosticSummary,
  redactProviderDiagnosticText,
} from "./providerDiagnostic.ts";

const capture = (payload: unknown) =>
  makeProviderDiagnostic({
    observedAt: "2026-10-12T00:00:00.000Z",
    source: "codex.app-server.notification",
    method: "error",
    status: "retry",
    subject: { kind: "root" },
    payload,
  });

describe("private provider diagnostic capture", () => {
  it("preserves error-only JSON structure and request/correlation data without mutating originals", () => {
    const payload = {
      error: {
        message: "Network interrupted; request ID request-123",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
        additionalDetails: "Wait for provider reconnect",
      },
      willRetry: true,
      turnId: "native-turn",
    };
    const result = capture(payload);
    expect(JSON.parse(result.snapshot.json)).toEqual(payload);
    expect(result.snapshot.redacted).toBe(false);
    expect(result.snapshot.truncated).toBe(false);
    expect(result.summary).toEqual({ version: 1, status: "retry", subject: { kind: "root" } });
    expect(payload.error.additionalDetails).toBe("Wait for provider reconnect");
  });

  it("redacts secret keys and credential prose while retaining public errors", () => {
    const result = capture({
      error: {
        message: "Authorization: Bearer secret-token\nrequest ID safe-request",
        auth: { session: "private" },
        access_token: "private",
        apiKey: "private",
        cookie: "first=private; second=private",
        password: "private",
        nested: { additionalDetails: 'token="secret with spaces"; another=private' },
      },
    });
    expect(result.snapshot.redacted).toBe(true);
    expect(result.snapshot.json).not.toContain("secret-token");
    expect(result.snapshot.json).not.toContain("private");
    expect(result.snapshot.json).not.toContain("secret with spaces");
    expect(result.snapshot.json).toContain("safe-request");
    expect(result.snapshot.json).toContain("Redacted");
  });

  it.each([
    "Cookie: first=secret; second=also-secret",
    'auth = "secret with spaces"; tail=also-secret',
    '{"token":"secret with spaces","extra":"also-secret"}',
    "api_key=secret%20with%20spaces",
    "client_secret = secret",
    "refreshToken: secret",
    'passphrase="secret with spaces"',
    "credential=secret",
    "privateKey: secret",
    "session_key=secret",
    "https://name:secret@example.test/path",
    "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    "Bearer secret",
  ])("redacts complete credential spans in %s", (value) => {
    expect(redactProviderDiagnosticText(value)).not.toContain("secret");
  });

  it("omits unrelated conversation/tool content even inside error extensions", () => {
    const result = capture({
      error: {
        message: "Failure",
        prompt: "private prompt",
        items: [{ output: "private output" }],
        environment: { HOME: "private profile" },
        extra: "debug marker",
      },
    });
    expect(result.snapshot.omittedFields).toBe(true);
    expect(result.snapshot.json).not.toContain("private");
    expect(result.snapshot.json).toContain("debug marker");
  });

  it("never invokes payload getters, toJSON, identity coercion or native correlation accessors", () => {
    let calls = 0;
    const payload = {
      error: Object.defineProperty({}, "message", {
        enumerable: true,
        get: () => {
          calls++;
          return "private";
        },
      }),
      toJSON: () => {
        calls++;
        return "private";
      },
    };
    const native = Object.defineProperty({}, "threadId", {
      enumerable: true,
      get: () => {
        calls++;
        return "private";
      },
    });
    const result = makeProviderDiagnostic({
      observedAt: "2026-10-12T00:00:00Z",
      source: "provider.error",
      status: "error",
      subject: { kind: "unknown" },
      payload,
      native,
    });
    expect(result.snapshot.omittedFields).toBe(true);
    expect(result.snapshot.json).not.toContain("private");
    expect(result.snapshot.native).toEqual({});
    expect(
      readProviderDiagnosticSummary({
        version: 1,
        status: "error",
        subject: {
          kind: {
            toString: () => {
              calls++;
              return "root";
            },
          },
        },
      }),
    ).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("handles cycles, hostile prototypes and unsupported scalars without exceptions", () => {
    const cycle: Record<string, unknown> = {
      number: Number.NaN,
      bigint: 1n,
      error: new Error("private"),
    };
    cycle.self = cycle;
    const result = capture(cycle);
    expect(result.snapshot.omittedFields).toBe(true);
    expect(result.snapshot.json).not.toContain("private");
    expect(() => JSON.parse(result.snapshot.json)).not.toThrow();
  });

  it("bounds strings, depth, node count, object width, arrays and encoded JSON bytes", () => {
    let deep: unknown = "last";
    for (let index = 0; index < 20; index++) deep = { next: deep };
    for (const payload of [
      { error: { message: "a".repeat(70_000) } },
      deep,
      Array.from({ length: 200 }, () => ({ values: [1, 2, 3, 4] })),
      Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`field-${index}`, "\u0000".repeat(4_096)]),
      ),
      { message: "😀".repeat(32_000) },
    ]) {
      const result = capture(payload);
      expect(result.snapshot.truncated).toBe(true);
      expect(new TextEncoder().encode(result.snapshot.json).byteLength).toBeLessThanOrEqual(
        PROVIDER_DIAGNOSTIC_MAX_JSON_BYTES,
      );
      expect(() => JSON.parse(result.snapshot.json)).not.toThrow();
    }
  });

  it("retains bounded child identity and observed lower-bound count without private details", () => {
    const result = makeProviderDiagnostic({
      observedAt: "2026-10-12T00:00:00Z",
      source: "provider.error",
      status: "retry",
      subject: { kind: "subagent", id: "child-id", label: "Reviewer" },
      observedRetryCount: 1_024,
      countLimited: true,
      message: "Bearer private-token",
      native: { eventId: "event-id", threadId: "native-child", turnId: "native-turn" },
      payload: { message: "Bearer private-token" },
    });
    expect(result.summary).toEqual({
      version: 1,
      status: "retry",
      subject: { kind: "subagent", id: "child-id", label: "Reviewer" },
      observedRetryCount: 1_024,
      countLimited: true,
    });
    expect(JSON.stringify(result.summary)).not.toContain("native-turn");
    expect(result.snapshot.message).not.toContain("private-token");
    expect(result.snapshot.native.turnId).toBe("native-turn");
  });

  it("strictly rejects forged, future, impossible and accessor-bearing summary contracts", () => {
    const base = { version: 1, status: "retry", subject: { kind: "root" } };
    for (const value of [
      { ...base, version: 2 },
      { ...base, raw: "private" },
      { ...base, subject: { kind: "root", label: "forged" } },
      { ...base, subject: { kind: "subagent" } },
      { ...base, observedRetryCount: 0 },
      { ...base, observedRetryCount: 1_025 },
      { ...base, countLimited: true },
      { ...base, status: "error", observedRetryCount: 1 },
      Object.defineProperty({ ...base }, "extra", {
        enumerable: true,
        get: () => {
          throw new Error("Never invoke");
        },
      }),
      Object.defineProperty({ ...base }, "hidden", { value: "private" }),
      { ...base, [Symbol("foreign")]: "private" },
    ])
      expect(readProviderDiagnosticSummary(value)).toBeUndefined();
  });

  it("retains a native count lower bound when global tracking saturates before the target cap", () => {
    const summary = {
      version: 1,
      status: "retry",
      subject: { kind: "root" },
      observedRetryCount: 1_008,
      countLimited: true,
    };
    expect(readProviderDiagnosticSummary(summary)).toEqual(summary);
  });
});
