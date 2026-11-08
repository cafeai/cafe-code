import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { ServerProviderUpdateDiagnostics, ServerProviderUpdateState } from "./server.ts";

const valid = {
  phase: "command",
  category: "command_failed",
  exitCode: 1,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  outputTruncated: false,
} as const;
const decode = Schema.decodeUnknownSync(ServerProviderUpdateDiagnostics);
const decodeState = Schema.decodeUnknownSync(ServerProviderUpdateState);
describe("provider update diagnostic boundary", () => {
  it("retains legacy update state without inventing diagnostics", () => {
    const legacy = {
      status: "failed",
      startedAt: null,
      finishedAt: null,
      message: "Update command failed.",
      output: null,
    };
    expect(decodeState(legacy)).toEqual(legacy);
  });
  it.each([-2147483648, 0, 1, 4294967295, null])("admits exact native exit code %s", (exitCode) => {
    expect(decode({ ...valid, exitCode }).exitCode).toBe(exitCode);
  });
  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0.5,
    -2147483649,
    4294967296,
  ])("refuses nonfinite, fractional or oversized exit code %s", (exitCode) => {
    expect(() => decode({ ...valid, exitCode })).toThrow();
  });
  it("rejects arbitrary phases/categories and strips content-bearing unknown fields", () => {
    expect(() => decode({ ...valid, phase: "raw /private/path" })).toThrow();
    expect(() => decode({ ...valid, category: "provider said secret" })).toThrow();
    expect(
      decode({
        ...valid,
        output: "PRIVATE_OUTPUT",
        command: "/private/command",
        environment: { TOKEN: "SECRET" },
      }),
    ).toEqual(valid);
  });
});
