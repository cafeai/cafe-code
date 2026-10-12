import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import * as CodexSchema from "effect-codex-app-server/schema";
import {
  classifyCodexTransientFailure,
  redactCodexFailureDiagnosticPayload,
} from "./codexTransientFailure.ts";

const decodeCodexNotification = Schema.decodeUnknownSync(CodexSchema.ServerNotification);
const processingError =
  "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID eb45b1d3-36e9-4f02-a321-8ea87f01185c in your message.";
const disconnectedProcessingError = `stream disconnected before completion: ${processingError}`;
const remoteCompactionProcessingError = `Error running remote compact task: ${disconnectedProcessingError}`;

describe("Codex terminal transient failure evidence", () => {
  it("redacts newly open nested errors in typed startup notifications without changing native evidence", () => {
    const error = {
      message: "Public error",
      codexErrorInfo: {
        responseStreamDisconnected: {
          httpStatusCode: 503,
          hidden: "private-nested-error-sentinel",
        },
      },
      futurePolicy: "private-nested-error-sentinel",
    };
    const turn = { id: "turn-1", items: [], status: "failed", error };
    for (const envelope of [
      { method: "turn/started", params: { threadId: "thread-1", turn } },
      {
        method: "thread/started",
        params: {
          thread: {
            id: "thread-1",
            cliVersion: "0.162.1",
            createdAt: 0,
            updatedAt: 0,
            cwd: "/fixture",
            ephemeral: true,
            modelProvider: "openai",
            preview: "",
            projectId: null,
            sessionId: "session-1",
            source: "appServer",
            status: { type: "idle" },
            turns: [turn],
          },
        },
      },
    ]) {
      const decoded = decodeCodexNotification(envelope);
      const original = JSON.stringify(decoded);
      const projected = redactCodexFailureDiagnosticPayload(decoded.method, decoded.params);
      expect(projected).toEqual({ redacted: true, reason: "codex-unqualified-error-metadata" });
      expect(JSON.stringify(projected)).not.toContain("private-nested-error-sentinel");
      expect(classifyCodexTransientFailure(projected)).toBeUndefined();
      expect(JSON.stringify(decoded)).toBe(original);
    }
  });
  it("keeps qualified startup errors and scans only bounded own inert prior turns", () => {
    const turn = {
      id: "turn-1",
      items: [],
      status: "failed",
      error: { message: "Public error", codexErrorInfo: "serverOverloaded" },
    };
    for (const payload of [{ thread: { turns: [turn] } }, { thread: { turns: [] } }])
      expect(redactCodexFailureDiagnosticPayload("thread/started", payload)).toBe(payload);
    let accessorReads = 0;
    const accessorTurns: unknown[] = [];
    Object.defineProperty(accessorTurns, "0", {
      get() {
        accessorReads++;
        return turn;
      },
      enumerable: true,
    });
    const customPrototypeTurns: unknown[] = [];
    Object.setPrototypeOf(customPrototypeTurns, {
      toJSON() {
        accessorReads++;
        return "private-custom-array-sentinel";
      },
    });
    const ownSerializerTurns: unknown[] = [];
    Object.defineProperty(ownSerializerTurns, "toJSON", {
      value() {
        accessorReads++;
        return "private-own-array-sentinel";
      },
    });
    let enumerationCount = 0;
    const oversizedTurns = new Proxy(new Array(1_001), {
      ownKeys(target) {
        enumerationCount++;
        return Reflect.ownKeys(target);
      },
    });
    for (const turns of [
      Array.from({ length: 1_001 }, () => turn),
      new Array(1),
      accessorTurns,
      customPrototypeTurns,
      ownSerializerTurns,
      oversizedTurns,
    ]) {
      expect(redactCodexFailureDiagnosticPayload("thread/started", { thread: { turns } })).toEqual({
        redacted: true,
        reason: "codex-unqualified-error-metadata",
      });
    }
    expect(accessorReads).toBe(0);
    expect(enumerationCount).toBe(0);
  });
  it("redacts only diagnostic copies without mutating classification evidence or minting replay authority", () => {
    const knownError = {
      message: "Public native failure",
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
      additionalDetails: null,
    };
    const known = { threadId: "thread-1", turnId: "turn-1", willRetry: false, error: knownError };
    expect(redactCodexFailureDiagnosticPayload("error", known)).toBe(known);
    expect(classifyCodexTransientFailure(knownError)).toBe("server");
    for (const error of [
      { ...knownError, futurePolicy: { value: "private-diagnostic-outer-value" } },
      {
        ...knownError,
        codexErrorInfo: {
          responseStreamDisconnected: {
            httpStatusCode: 503,
            hidden: "private-diagnostic-inner-value",
          },
        },
      },
      { ...knownError, codexErrorInfo: "private-diagnostic-future-category" },
      {
        ...knownError,
        codexErrorInfo: {
          responseStreamDisconnected: { httpStatusCode: 503 },
          cyberPolicy: { value: "private-diagnostic-policy-value" },
        },
      },
    ]) {
      const original = JSON.stringify(error);
      expect(classifyCodexTransientFailure(error)).toBeUndefined();
      for (const [method, payload] of [
        ["error", { ...known, error }],
        [
          "turn/completed",
          { threadId: "thread-1", turn: { id: "turn-1", items: [], status: "failed", error } },
        ],
      ] as const) {
        const projected = redactCodexFailureDiagnosticPayload(method, payload);
        expect(projected).toEqual({ redacted: true, reason: "codex-unqualified-error-metadata" });
        expect(JSON.stringify(projected)).not.toContain("private-diagnostic");
        expect(classifyCodexTransientFailure(projected)).toBeUndefined();
      }
      expect(JSON.stringify(error)).toBe(original);
      expect(classifyCodexTransientFailure(error)).toBeUndefined();
    }
  });
  it("does not manufacture recovery authority by stripping the native error envelope's extra fields", () => {
    const error = {
      message: processingError,
      codexErrorInfo: "serverOverloaded",
      futurePolicy: "permanent",
    };
    expect(classifyCodexTransientFailure(error)).toBeUndefined();
    for (const envelope of [
      {
        method: "error",
        params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", items: [], status: "failed", error },
        },
      },
    ]) {
      const decoded = decodeCodexNotification(envelope);
      const decodedError =
        decoded.method === "error"
          ? decoded.params.error
          : decoded.method === "turn/completed"
            ? decoded.params.turn.error
            : undefined;
      expect(decodedError).toEqual(error);
      expect(classifyCodexTransientFailure(decodedError)).toBeUndefined();
    }
  });
  it.each([
    { responseStreamDisconnected: { httpStatusCode: 503 }, cyberPolicy: { blocked: true } },
    { responseStreamDisconnected: { httpStatusCode: 503 }, futureFailure: { opaque: true } },
    {
      responseStreamDisconnected: { httpStatusCode: 503 },
      httpConnectionFailed: { httpStatusCode: 503 },
    },
    { responseStreamDisconnected: { httpStatusCode: 503, permanent: true } },
    { responseStreamDisconnected: { httpStatusCode: 503, cyberPolicy: { blocked: true } } },
  ])(
    "does not manufacture recovery authority by stripping open native error metadata %#",
    (codexErrorInfo) => {
      const error = {
        message: processingError,
        codexErrorInfo,
        additionalDetails: null,
        misalignment: null,
      };
      // The real client decodes the whole envelope before canonical mapping.
      // Both edges must retain contradictory/extra evidence; checking only a
      // raw classifier would miss permission manufactured by schema stripping.
      const envelopes = [
        {
          method: "error",
          params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error },
        },
        {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", items: [], status: "failed", error },
          },
        },
      ];
      expect(classifyCodexTransientFailure(error)).toBeUndefined();
      for (const envelope of envelopes) {
        const decoded = decodeCodexNotification(envelope);
        const decodedError =
          decoded.method === "error"
            ? decoded.params.error
            : decoded.method === "turn/completed"
              ? decoded.params.turn.error
              : undefined;
        expect(decodedError).toEqual(error);
        expect(classifyCodexTransientFailure(decodedError)).toBeUndefined();
      }
    },
  );
  it.each([
    ["serverOverloaded", "server"],
    ["internalServerError", "server"],
    ["rateLimitExceeded", "rate-limit"],
  ])("allows only structured temporary category %s", (codexErrorInfo, category) => {
    expect(classifyCodexTransientFailure({ message: "Native failure", codexErrorInfo })).toBe(
      category,
    );
  });

  it.each([
    "contextWindowExceeded",
    "sessionBudgetExceeded",
    "usageLimitExceeded",
    "unauthorized",
    "badRequest",
    "flexUnavailable",
    "cyberPolicy",
    "misalignmentPolicyViolation",
    "tooManyDenials",
    "threadRollbackFailed",
    "sandboxError",
    "unrecognized",
  ])("never retries permanent or unknown variant %s from its prose", (codexErrorInfo) => {
    expect(
      classifyCodexTransientFailure({ message: processingError, codexErrorInfo }),
    ).toBeUndefined();
  });

  it.each(["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected"])(
    "retains unknown HTTP evidence for positively typed %s",
    (variant) => {
      for (const payload of [{}, { httpStatusCode: null }])
        expect(
          classifyCodexTransientFailure({
            message: "Disconnected",
            codexErrorInfo: { [variant]: payload },
          }),
        ).toBe("transport");
    },
  );

  it.each([
    [408, "transport"],
    [429, "rate-limit"],
    [500, "server"],
    [502, "server"],
    [503, "server"],
    [504, "server"],
  ])("accepts temporary HTTP %s without retaining private details", (httpStatusCode, category) => {
    expect(
      classifyCodexTransientFailure({
        message: "Disconnected",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode } },
      }),
    ).toBe(category);
  });

  it.each([0, 200, 400, 401, 402, 403, 404, 409, 422, 501, 505, 507, 500.1, "503"])(
    "refuses permanent or malformed HTTP evidence %s",
    (httpStatusCode) => {
      expect(
        classifyCodexTransientFailure({
          message: processingError,
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode } },
        }),
      ).toBeUndefined();
    },
  );

  it("requires a temporary HTTP cause for bare retry exhaustion", () => {
    expect(
      classifyCodexTransientFailure({
        message: "Attempts exhausted",
        codexErrorInfo: { responseTooManyFailedAttempts: {} },
      }),
    ).toBeUndefined();
    expect(
      classifyCodexTransientFailure({
        message: "Attempts exhausted",
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 503 } },
      }),
    ).toBe("server");
  });

  it("accepts only the exact anchored native processing message for other", () => {
    for (const message of [
      processingError,
      `stream disconnected before completion: ${processingError}`,
    ])
      expect(
        classifyCodexTransientFailure({
          message,
          codexErrorInfo: "other",
          additionalDetails: processingError,
        }),
      ).toBe("server");
    for (const message of [
      `Assistant said: ${processingError}`,
      `${processingError}\n`,
      `${processingError} Unauthorized`,
      processingError.replace("eb45b1d3-36e9-4f02-a321-8ea87f01185c", "request-id"),
      processingError.replace("help.openai.com", "help.example.com"),
    ])
      expect(classifyCodexTransientFailure({ message, codexErrorInfo: "other" })).toBeUndefined();
    expect(
      classifyCodexTransientFailure({
        message: processingError,
        codexErrorInfo: "other",
        additionalDetails: "Unauthorized",
      }),
    ).toBeUndefined();
    expect(classifyCodexTransientFailure({ message: processingError })).toBeUndefined();
  });

  it.each([undefined, null, "", processingError, disconnectedProcessingError])(
    "recognizes the single native remote-compaction wrapper with compatible details %s",
    (additionalDetails) => {
      // Codex 0.162.1 preserves the underlying Stream error's `other` variant
      // and adds this exact prefix when remote compaction exhausts its retries.
      expect(
        classifyCodexTransientFailure({
          message: remoteCompactionProcessingError,
          codexErrorInfo: "other",
          additionalDetails,
        }),
      ).toBe("server");
    },
  );

  it("never grants remote-compaction retry authority from arbitrary wrapped prose", () => {
    for (const message of [
      `Error running remote compact task: ${processingError}`,
      `Error running remote compact task: ${remoteCompactionProcessingError}`,
      `Assistant said: ${remoteCompactionProcessingError}`,
      remoteCompactionProcessingError.replace("compact task", "compaction task"),
      `${remoteCompactionProcessingError}\n`,
      `${remoteCompactionProcessingError} Unauthorized`,
      "Error running remote compact task: stream disconnected before completion: Unauthorized",
      "Error running remote compact task: stream disconnected before completion: Incomplete response returned, reason: content_filter",
    ])
      expect(classifyCodexTransientFailure({ message, codexErrorInfo: "other" })).toBeUndefined();

    for (const codexErrorInfo of [
      undefined,
      "unauthorized",
      "usageLimitExceeded",
      "contextWindowExceeded",
      "tooManyDenials",
      "misalignmentPolicyViolation",
    ])
      expect(
        classifyCodexTransientFailure({ message: remoteCompactionProcessingError, codexErrorInfo }),
      ).toBeUndefined();

    for (const additionalDetails of ["Unauthorized", { transient: true }, "x".repeat(4_097)])
      expect(
        classifyCodexTransientFailure({
          message: remoteCompactionProcessingError,
          codexErrorInfo: "other",
          additionalDetails,
        }),
      ).toBeUndefined();

    expect(
      classifyCodexTransientFailure({
        message: remoteCompactionProcessingError,
        codexErrorInfo: "other",
        misalignment: { denied: true },
      }),
    ).toBeUndefined();
  });

  it("refuses ambiguous variants, inherited evidence and accessors without invoking them", () => {
    let accessed = 0;
    const getter = {
      message: "Native failure",
      get codexErrorInfo() {
        accessed += 1;
        return "serverOverloaded";
      },
    };
    expect(classifyCodexTransientFailure(getter)).toBeUndefined();
    expect(accessed).toBe(0);
    expect(
      classifyCodexTransientFailure(
        Object.create({ message: processingError, codexErrorInfo: "other" }),
      ),
    ).toBeUndefined();
    expect(
      classifyCodexTransientFailure({
        message: "Native failure",
        codexErrorInfo: { responseStreamDisconnected: {}, httpConnectionFailed: {} },
      }),
    ).toBeUndefined();
    expect(
      classifyCodexTransientFailure({
        message: "Native failure",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503, permanent: true } },
      }),
    ).toBeUndefined();
  });

  it("never reads polluted Object.prototype evidence after the own-data copy", () => {
    let reads = 0;
    const names = ["message", "codexErrorInfo", "httpStatusCode", "misalignment"] as const;
    const previous = names.map((name) => Object.getOwnPropertyDescriptor(Object.prototype, name));
    let results: unknown[] = [];
    try {
      for (const name of names)
        Object.defineProperty(Object.prototype, name, {
          configurable: true,
          get() {
            reads += 1;
            return name === "message"
              ? processingError
              : name === "codexErrorInfo"
                ? "serverOverloaded"
                : name === "httpStatusCode"
                  ? 503
                  : { denied: true };
          },
        });
      // Chai itself writes ordinary object.message fields. Capture only the
      // actual classifier while pollution is installed, then restore before
      // asserting; the fixture must not change framework behavior.
      results = [
        classifyCodexTransientFailure({ codexErrorInfo: "serverOverloaded" }),
        classifyCodexTransientFailure({ message: processingError }),
        classifyCodexTransientFailure({
          message: "Native failure",
          codexErrorInfo: "serverOverloaded",
        }),
        classifyCodexTransientFailure({
          message: "Disconnected",
          codexErrorInfo: { responseTooManyFailedAttempts: {} },
        }),
        classifyCodexTransientFailure({
          message: "Disconnected",
          codexErrorInfo: { responseStreamDisconnected: {} },
        }),
      ];
    } finally {
      names.forEach((name, index) => {
        const descriptor = previous[index];
        if (descriptor) Object.defineProperty(Object.prototype, name, descriptor);
        else Reflect.deleteProperty(Object.prototype, name);
      });
    }
    expect(results).toEqual([undefined, undefined, "server", undefined, "transport"]);
    expect(reads).toBe(0);
  });
});
