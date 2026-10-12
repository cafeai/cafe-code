import { describe, expect, it } from "vitest";
import { CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE } from "@cafecode/shared/codexHistorySafety";
import { CLAUDE_RESPONSE_LIMIT_MESSAGE } from "@cafecode/shared/claudeResponseLimits";
import { shouldShowThreadErrorBanner } from "./providerErrorPresentation";

const error = "stream disconnected before completion: synthetic request ID private-receipt";
const ordinary = { error, isClaudeResponseLimitFailure: false };

describe("thread error presentation boundary", () => {
  it("hides provider and unknown origins without needing runtime, turn or activity evidence", () => {
    expect(shouldShowThreadErrorBanner(ordinary)).toBe(false);
    expect(shouldShowThreadErrorBanner({ ...ordinary, errorOrigin: "provider" })).toBe(false);
    expect(shouldShowThreadErrorBanner({ ...ordinary, providerError: error })).toBe(false);
    expect(shouldShowThreadErrorBanner({ ...ordinary, providerError: "older failure" })).toBe(
      false,
    );
  });

  it("keeps explicit local feedback but refuses a duplicate canonical provider failure", () => {
    const local = { ...ordinary, errorOrigin: "local" as const };
    expect(shouldShowThreadErrorBanner(local)).toBe(true);
    expect(shouldShowThreadErrorBanner({ ...local, providerError: error })).toBe(false);
    expect(shouldShowThreadErrorBanner({ ...local, error: null })).toBe(false);
    expect(shouldShowThreadErrorBanner({ ...local, error: "" })).toBe(false);
  });

  it("retains exact dedicated recovery controls without admitting prose lookalikes", () => {
    expect(
      shouldShowThreadErrorBanner({
        error: CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE,
        isClaudeResponseLimitFailure: false,
      }),
    ).toBe(true);
    expect(
      shouldShowThreadErrorBanner({
        error: `${CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE} extra private prose`,
        isClaudeResponseLimitFailure: false,
      }),
    ).toBe(false);
    expect(shouldShowThreadErrorBanner({ ...ordinary, isClaudeResponseLimitFailure: true })).toBe(
      false,
    );
    expect(
      shouldShowThreadErrorBanner({
        error: CLAUDE_RESPONSE_LIMIT_MESSAGE,
        isClaudeResponseLimitFailure: true,
      }),
    ).toBe(true);
  });

  it("does not acknowledge or mutate failure evidence", () => {
    const before = structuredClone(ordinary);
    shouldShowThreadErrorBanner(ordinary);
    expect(ordinary).toEqual(before);
  });
});
