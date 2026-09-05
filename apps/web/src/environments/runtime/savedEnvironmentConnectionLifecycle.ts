import { getWsReconnectDelayMsForRetry, type WsReconnectPhase } from "../../rpc/wsConnectionState";
import type { SavedEnvironmentConnectionState } from "./catalog";

/**
 * The transport lifecycle subset persisted in the saved-environment runtime
 * store. Keeping the transition functions pure makes the browser `error` then
 * `close` event pair idempotent and prevents UI copy from guessing whether the
 * transport still has retries available.
 */
export interface SavedEnvironmentConnectionLifecycleState {
  readonly connectionState: SavedEnvironmentConnectionState;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly nextRetryAt: string | null;
  readonly reconnectAttemptCount: number;
  readonly reconnectPhase: WsReconnectPhase;
}

export type SavedEnvironmentConnectionLifecyclePatch =
  Partial<SavedEnvironmentConnectionLifecycleState>;

export const INITIAL_SAVED_ENVIRONMENT_CONNECTION_LIFECYCLE =
  Object.freeze<SavedEnvironmentConnectionLifecycleState>({
    connectionState: "disconnected",
    connectedAt: null,
    disconnectedAt: null,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    reconnectAttemptCount: 0,
    reconnectPhase: "idle",
  });

export function beginSavedEnvironmentReconnect(
  _current: SavedEnvironmentConnectionLifecycleState,
): SavedEnvironmentConnectionLifecyclePatch {
  return {
    connectionState: "connecting",
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    // WsTransport.reconnect replaces the Effect protocol session, resetting
    // its bounded retry schedule. The upcoming socket is therefore attempt one
    // even when it replaces a session that was already waiting or exhausted.
    reconnectAttemptCount: 1,
    reconnectPhase: "attempting",
  };
}

export function recordSavedEnvironmentConnectionAttempt(
  current: SavedEnvironmentConnectionLifecycleState,
): SavedEnvironmentConnectionLifecyclePatch {
  // Manual reconnect marks the upcoming attempt before the new session is
  // constructed. The subsequent WebSocket constructor callback must not count
  // that same attempt twice.
  if (current.connectionState === "connecting" && current.reconnectPhase === "attempting") {
    return {};
  }

  return {
    connectionState: "connecting",
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    reconnectAttemptCount: current.reconnectAttemptCount + 1,
    reconnectPhase: "attempting",
  };
}

export function recordSavedEnvironmentConnectionOpened(
  connectedAt: string,
): SavedEnvironmentConnectionLifecyclePatch {
  return {
    connectionState: "connected",
    connectedAt,
    disconnectedAt: null,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    // Keep the live socket as attempt one of the current protocol cycle. If it
    // later closes, Effect consumes the first retry delay before constructing
    // attempt two, and the eighth failed socket is truly terminal.
    reconnectAttemptCount: 1,
    reconnectPhase: "idle",
  };
}

export function recordSavedEnvironmentTransportFailure(
  current: SavedEnvironmentConnectionLifecycleState,
  input: {
    readonly message: string;
    readonly nowMs: number;
  },
): SavedEnvironmentConnectionLifecyclePatch {
  // Browsers normally emit `error` and then `close` for one failed attempt.
  // Preserve the first terminal/waiting decision so the close event cannot
  // turn an exhausted failure back into an apparent in-flight reconnect.
  if (current.reconnectPhase === "waiting" || current.reconnectPhase === "exhausted") {
    return {};
  }

  const retryDelayMs = getWsReconnectDelayMsForRetry(
    Math.max(0, current.reconnectAttemptCount - 1),
  );
  const exhausted = retryDelayMs === null;
  const disconnectedAt = new Date(input.nowMs).toISOString();
  return {
    connectionState: exhausted ? "error" : "disconnected",
    disconnectedAt,
    lastError: input.message,
    lastErrorAt: disconnectedAt,
    nextRetryAt: exhausted ? null : new Date(input.nowMs + retryDelayMs).toISOString(),
    reconnectPhase: exhausted ? "exhausted" : "waiting",
  };
}

export function recordSavedEnvironmentManualDisconnect(
  disconnectedAt: string,
): SavedEnvironmentConnectionLifecyclePatch {
  return {
    connectionState: "disconnected",
    disconnectedAt,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    reconnectAttemptCount: 0,
    reconnectPhase: "idle",
  };
}

export function recordSavedEnvironmentTerminalError(input: {
  readonly message: string;
  readonly occurredAt: string;
}): SavedEnvironmentConnectionLifecyclePatch {
  return {
    connectionState: "error",
    disconnectedAt: input.occurredAt,
    lastError: input.message,
    lastErrorAt: input.occurredAt,
    nextRetryAt: null,
    reconnectPhase: "exhausted",
  };
}
