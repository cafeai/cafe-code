import { afterEach, describe, expect, it } from "vitest";

import {
  __dictationDiagnosticsTestApi,
  beginDictationDiagnosticOperation,
  getDictationDiagnosticSnapshot,
  readSafeOpenAiRequestId,
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

    expect(getDictationDiagnosticSnapshot()).toEqual({
      capturedAt: "2026-08-27T10:00:00.000Z",
      stage: "sdp_exchange",
      outcome: "failed",
      attempt: 3,
      maxAttempts: 3,
      httpStatus: 503,
      requestId: "req_safe-123",
      errorCode: "upstream_unavailable",
    });
  });

  it.each([
    ["req_abc-123", "req_abc-123"],
    ["", null],
    ["req unsafe", null],
    ["req_unsafe\nAuthorization", null],
    ["x".repeat(129), null],
  ])("bounds and validates an OpenAI request id", (value, expected) => {
    expect(readSafeOpenAiRequestId({ get: () => value })).toBe(expected);
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
