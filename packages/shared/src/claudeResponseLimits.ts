/**
 * Fixed Cafe-authored failure copy shared with the explicit composer action.
 * Claude's public `max_output_tokens` category can represent either an output
 * budget or a context-window limit. Without stronger native stop-reason
 * evidence, do not claim which resource was exhausted or that a retry will
 * succeed. Only received public output is available to preserve.
 */
export const CLAUDE_RESPONSE_LIMIT_MESSAGE =
  "Claude reached a response limit before finishing (output or context). Any received partial response has been preserved. Try a shorter answer or lower effort; use /compact if the conversation context is full.";

/**
 * Match only Cafe's exact terminal guidance. Arbitrary provider/user prose,
 * substrings and lookalike messages must not expose a recovery action.
 */
export function isClaudeResponseLimitError(message: string): boolean {
  return message === CLAUDE_RESPONSE_LIMIT_MESSAGE;
}

/**
 * Editable user-owned text, prepared locally and submitted only by the normal
 * Send action. Preparation itself does not replay the original prompt or
 * attachments and performs no side effect. A later user Send uses ordinary
 * tool permissions; this request cannot guarantee the model will not repeat work.
 */
export const CLAUDE_SHORTER_CONTINUATION_PROMPT =
  "Continue the existing work without repeating completed actions. Give me a concise answer first, then expand in small sections if needed.";
