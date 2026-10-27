import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Claude sometimes reports an ordinary Stop as error_during_execution with
 * only its internal terminal-state summary (upstream SDK issues #366/#405):
 * https://github.com/anthropics/claude-agent-sdk-typescript/issues/405
 *
 * The summary alone proves neither interruption nor recovery. Require the
 * adapter's accepted interrupt for this exact response, and refuse any real
 * error alongside it. This does not retry input or retire the query.
 */
export function isClaudeStoppedExecutionResult(
  result: SDKResultMessage,
  acceptedInterrupt: boolean,
  hasPrimaryError: boolean,
): boolean {
  if (
    !acceptedInterrupt ||
    hasPrimaryError ||
    result.subtype !== "error_during_execution" ||
    result.is_error !== true ||
    (result.stop_reason !== null && result.stop_reason !== "tool_use") ||
    // api_error_status is an open-set native result extension. Any reported
    // status, including an unknown value, keeps the original failure path.
    Object.hasOwn(result, "api_error_status") ||
    (result.terminal_reason !== undefined &&
      result.terminal_reason !== "aborted_streaming" &&
      result.terminal_reason !== "aborted_tools")
  )
    return false;

  const expected = `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=${result.stop_reason}`;
  return result.errors.length === 1 && result.errors[0] === expected;
}
