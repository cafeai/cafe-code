import { expect, it } from "vitest";
import { BootstrapHttpError, isServerSecondFactorChallenge } from "./auth";

it.each([
  [401, "two-factor-required", true],
  [401, "two-factor-invalid", true],
  [429, "two-factor-locked", true],
  [403, "two-factor-required", false],
  [500, "two-factor-required", false],
  [401, undefined, false],
] as const)(
  "qualifies only an explicit second-factor response (%s, %s)",
  (status, reason, expected) => {
    expect(
      isServerSecondFactorChallenge(
        new BootstrapHttpError({ status, reason, message: "synthetic" }),
      ),
    ).toBe(expected);
  },
);

it("does not infer a challenge from error prose or an unowned object", () => {
  expect(
    isServerSecondFactorChallenge(new Error("Enter an authenticator code or recovery code.")),
  ).toBe(false);
  expect(
    isServerSecondFactorChallenge({
      _tag: "BootstrapHttpError",
      status: 401,
      reason: "two-factor-required",
    }),
  ).toBe(false);
});
