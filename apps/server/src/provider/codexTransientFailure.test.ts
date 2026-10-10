import { describe, expect, it } from "vitest";
import { classifyCodexTransientFailure } from "./codexTransientFailure.ts";

const processingError =
  "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID eb45b1d3-36e9-4f02-a321-8ea87f01185c in your message.";

describe("Codex terminal transient failure evidence", () => {
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
