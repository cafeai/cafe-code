const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /Unable to connect to the Cafe Code server WebSocket\./i,
  /\bping timeout\b/i,
] as const;

const RECOVERABLE_PROVIDER_ERROR_PATTERNS = [
  // Claude SDK execution diagnostics can arrive as `lastError` even when the
  // turn continues through normal assistant/tool activity. Keep that forensic
  // marker in debug/work-log data instead of showing it as a user-facing error.
  /^\[ede_diagnostic\]\s+result_type=user\s+last_content_type=n\/a\s+stop_reason=null\b/i,
  /\bProvider adapter process error \(claudeAgent\)[\s\S]*No message found with message\.uuid\b/i,
  /\bProvider adapter process error \(claudeAgent\)[\s\S]*No conversation found with session ID\b/i,
  /\bProvider adapter request failed \(claudeAgent\)[\s\S]*No conversation found with session ID\b/i,
  /\bClaude Code returned an error result: No message found with message\.uuid\b/i,
] as const;

export function isTransportConnectionErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

export function isRecoverableProviderErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return RECOVERABLE_PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

export function sanitizeThreadErrorMessage(message: string | null | undefined): string | null {
  return isTransportConnectionErrorMessage(message) || isRecoverableProviderErrorMessage(message)
    ? null
    : (message ?? null);
}
