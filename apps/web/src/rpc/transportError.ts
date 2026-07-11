const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /Unable to connect to the Cafe Code server WebSocket\./i,
  /\bping timeout\b/i,
] as const;

// A dropped WebSocket mid-request interrupts the in-flight dispatch fiber, which
// Effect squashes into an opaque "All fibers interrupted without errors." (and
// similar) message. These surface to the user as send failures, so we recognize
// them to explain the real cause rather than leaking Effect internals.
const CONNECTION_INTERRUPTED_PATTERNS = [
  /all fibers interrupted/i,
  /request was aborted/i,
  /\bAbortError\b/i,
  /\bECONNRESET\b/i,
  /\bwebsocket\b/i,
] as const;

const CONNECTION_SEND_FAILURE_MESSAGE =
  "Couldn't reach the server — the connection dropped. Check your connection and try again.";

const RECOVERABLE_PROVIDER_ERROR_PATTERNS = [
  // Claude SDK execution diagnostics can arrive as `lastError` even when the
  // turn continues through normal assistant/tool activity. These are internal
  // execution summaries, not user-actionable failures, and may use stop reasons
  // such as `null` or `tool_use` depending on the Claude Code release.
  /\[ede_diagnostic\](?:\s|$)/i,
  /\bProvider adapter process error \(claudeAgent\)[\s\S]*No message found with message\.uuid\b/i,
  /\bProvider adapter process error \(claudeAgent\)[\s\S]*No conversation found with session ID\b/i,
  /\bProvider adapter request failed \(claudeAgent\)[\s\S]*No conversation found with session ID\b/i,
  /\bClaude Code returned an error result: No message found with message\.uuid\b/i,
  // Codex can emit serverOverloaded for a child or an older turn while the
  // primary thread continues. Keep the durable runtime activity in the work
  // log, but do not let snapshot/replay repeatedly recreate a dismissible
  // thread-level banner from this non-actionable historical diagnostic.
  /\bSelected model is at capacity\b/i,
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

function isConnectionInterruptedMessage(message: string): boolean {
  return (
    isTransportConnectionErrorMessage(message) ||
    CONNECTION_INTERRUPTED_PATTERNS.some((pattern) => pattern.test(message))
  );
}

/**
 * Returns true when a request may have reached the server but its response was
 * lost while the WebSocket session was being replaced. Callers must not infer
 * failure from this result. Only operations with a durable idempotency key may
 * retry automatically after this classification.
 */
export function isIndeterminateTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const normalized = message.trim();
  return normalized.length > 0 && isConnectionInterruptedMessage(normalized);
}

/**
 * Turn a send/dispatch failure into a user-facing thread error. Connection
 * drops (including the interrupted-fiber messages Effect emits when the socket
 * closes mid-upload) become a clear, actionable message instead of leaking an
 * opaque runtime string; everything else passes through, falling back to
 * `fallback` when there is no usable message.
 */
export function describeSendFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const normalized = message.trim();
  if (isIndeterminateTransportError(error)) {
    return CONNECTION_SEND_FAILURE_MESSAGE;
  }
  return normalized.length > 0 ? normalized : fallback;
}
