import { isCodexHistoryRecoveryRequiredError } from "@cafecode/shared/codexHistorySafety";
import { isClaudeResponseLimitError } from "@cafecode/shared/claudeResponseLimits";

/**
 * Ordinary native error prose belongs only in the explicitly inspected Work
 * Log. Do not wait for diagnostic persistence, activity hydration, a matching
 * runtime or recovery acknowledgment before enforcing that privacy boundary.
 * This selector never clears canonical error state or acknowledges a failure.
 */
export function shouldShowThreadErrorBanner(input: {
  error: string | null;
  errorOrigin?: "local" | "provider" | undefined;
  providerError?: string | undefined;
  /** Already admitted by the component's exact Claude/session/terminal-owner checks. */
  isClaudeResponseLimitFailure: boolean;
}): boolean {
  if (!input.error) return false;
  // Dedicated controls use exact Cafe-authored classification messages, not an
  // arbitrary provider-text pattern. Their lifecycle/action gates remain
  // independent of diagnostic presence and the local presentation bit.
  if (
    isCodexHistoryRecoveryRequiredError(input.error) ||
    (input.isClaudeResponseLimitFailure && isClaudeResponseLimitError(input.error))
  )
    return true;
  // Unknown legacy origin is not evidence of local validation. Also refuse a
  // duplicate canonical native error that a local dispatch catch has echoed.
  return input.errorOrigin === "local" && input.error !== input.providerError;
}
