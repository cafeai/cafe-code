import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry";

export type WsConnectionUiState = "connected" | "connecting" | "error" | "offline" | "reconnecting";
export type WsReconnectPhase = "attempting" | "exhausted" | "idle" | "waiting";

export const WS_RECONNECT_INITIAL_DELAY_MS = 1_000;
export const WS_RECONNECT_BACKOFF_FACTOR = 2;
export const WS_RECONNECT_MAX_DELAY_MS = 64_000;
export const WS_RECONNECT_MAX_RETRIES = 7;
export const WS_RECONNECT_MAX_ATTEMPTS = WS_RECONNECT_MAX_RETRIES + 1;

export interface WsConnectionStatus {
  readonly attemptCount: number;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
  readonly connectionLabel: string | null;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
  readonly hasConnected: boolean;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly nextRetryAt: string | null;
  readonly online: boolean;
  readonly phase: "idle" | "connecting" | "connected" | "disconnected";
  readonly reconnectAttemptCount: number;
  readonly reconnectMaxAttempts: number;
  readonly reconnectPhase: WsReconnectPhase;
  readonly socketUrl: string | null;
}

export interface WsConnectionDiagnosticEvent {
  readonly at: string;
  readonly kind: "attempt" | "closed" | "error" | "online-state" | "opened";
  readonly phase: WsConnectionStatus["phase"];
  readonly reconnectPhase: WsReconnectPhase;
  readonly attemptCount: number;
  readonly reconnectAttemptCount: number;
  readonly closeCode: number | null;
  readonly online: boolean;
}

export interface WsConnectionDiagnostics {
  readonly phase: WsConnectionStatus["phase"];
  readonly reconnectPhase: WsReconnectPhase;
  readonly hasConnected: boolean;
  readonly online: boolean;
  readonly attemptCount: number;
  readonly reconnectAttemptCount: number;
  readonly reconnectMaxAttempts: number;
  readonly closeCode: number | null;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
  readonly lastErrorAt: string | null;
  readonly nextRetryAt: string | null;
  readonly recentEvents: ReadonlyArray<WsConnectionDiagnosticEvent>;
}

const WS_CONNECTION_DIAGNOSTIC_EVENT_LIMIT = 32;
const wsConnectionDiagnosticEvents: WsConnectionDiagnosticEvent[] = [];

const INITIAL_WS_CONNECTION_STATUS = Object.freeze<WsConnectionStatus>({
  attemptCount: 0,
  closeCode: null,
  closeReason: null,
  connectionLabel: null,
  connectedAt: null,
  disconnectedAt: null,
  hasConnected: false,
  lastError: null,
  lastErrorAt: null,
  nextRetryAt: null,
  online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
  phase: "idle",
  reconnectAttemptCount: 0,
  reconnectMaxAttempts: WS_RECONNECT_MAX_ATTEMPTS,
  reconnectPhase: "idle",
  socketUrl: null,
});

export const wsConnectionStatusAtom = Atom.make(INITIAL_WS_CONNECTION_STATUS).pipe(
  Atom.keepAlive,
  Atom.withLabel("ws-connection-status"),
);

function isoNow() {
  return new Date().toISOString();
}

function updateWsConnectionStatus(
  updater: (current: WsConnectionStatus) => WsConnectionStatus,
): WsConnectionStatus {
  const nextStatus = updater(getWsConnectionStatus());
  appAtomRegistry.set(wsConnectionStatusAtom, nextStatus);
  return nextStatus;
}

function recordDiagnosticEvent(
  kind: WsConnectionDiagnosticEvent["kind"],
  status: WsConnectionStatus,
): void {
  wsConnectionDiagnosticEvents.push({
    at: isoNow(),
    kind,
    phase: status.phase,
    reconnectPhase: status.reconnectPhase,
    attemptCount: status.attemptCount,
    reconnectAttemptCount: status.reconnectAttemptCount,
    closeCode: status.closeCode,
    online: status.online,
  });
  if (wsConnectionDiagnosticEvents.length > WS_CONNECTION_DIAGNOSTIC_EVENT_LIMIT) {
    wsConnectionDiagnosticEvents.splice(
      0,
      wsConnectionDiagnosticEvents.length - WS_CONNECTION_DIAGNOSTIC_EVENT_LIMIT,
    );
  }
}

export interface WsConnectionMetadata {
  readonly connectionLabel?: string | null;
  readonly versionMismatchHint?: string | null;
}

function normalizeConnectionLabel(label: string | null | undefined): string | null {
  const normalized = label?.trim();
  return normalized ? normalized : null;
}

export function getWsConnectionStatus(): WsConnectionStatus {
  return appAtomRegistry.get(wsConnectionStatusAtom);
}

/**
 * Safe renderer/debug view. It intentionally omits socket URLs, environment
 * labels, close reasons, and error messages because remote servers and network
 * intermediaries can place sensitive text in those fields.
 */
export function getWsConnectionDiagnostics(): WsConnectionDiagnostics {
  const status = getWsConnectionStatus();
  return {
    phase: status.phase,
    reconnectPhase: status.reconnectPhase,
    hasConnected: status.hasConnected,
    online: status.online,
    attemptCount: status.attemptCount,
    reconnectAttemptCount: status.reconnectAttemptCount,
    reconnectMaxAttempts: status.reconnectMaxAttempts,
    closeCode: status.closeCode,
    connectedAt: status.connectedAt,
    disconnectedAt: status.disconnectedAt,
    lastErrorAt: status.lastErrorAt,
    nextRetryAt: status.nextRetryAt,
    recentEvents: wsConnectionDiagnosticEvents.map((event) => ({ ...event })),
  };
}

export function getWsConnectionUiState(status: WsConnectionStatus): WsConnectionUiState {
  if (status.phase === "connected") {
    return "connected";
  }

  if (!status.online && (status.disconnectedAt !== null || status.phase === "disconnected")) {
    return "offline";
  }

  if (!status.hasConnected) {
    return status.phase === "disconnected" ? "error" : "connecting";
  }

  return "reconnecting";
}

export function recordWsConnectionAttempt(
  socketUrl: string,
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const connectionLabel = normalizeConnectionLabel(metadata?.connectionLabel);
  const status = updateWsConnectionStatus((current) => ({
    ...current,
    attemptCount: current.attemptCount + 1,
    connectionLabel: connectionLabel ?? current.connectionLabel,
    nextRetryAt: null,
    phase: "connecting",
    reconnectAttemptCount: current.phase === "connected" ? 1 : current.reconnectAttemptCount + 1,
    reconnectPhase: "attempting",
    socketUrl,
  }));
  recordDiagnosticEvent("attempt", status);
  return status;
}

export function recordWsConnectionOpened(metadata?: WsConnectionMetadata): WsConnectionStatus {
  const connectionLabel = normalizeConnectionLabel(metadata?.connectionLabel);
  const status = updateWsConnectionStatus((current) => ({
    ...current,
    closeCode: null,
    closeReason: null,
    connectionLabel: connectionLabel ?? current.connectionLabel,
    connectedAt: isoNow(),
    disconnectedAt: null,
    hasConnected: true,
    nextRetryAt: null,
    phase: "connected",
    reconnectAttemptCount: 0,
    reconnectPhase: "idle",
  }));
  recordDiagnosticEvent("opened", status);
  return status;
}

function appendHint(message: string | null | undefined, hint: string | null | undefined) {
  const normalizedMessage = message?.trim();
  const normalizedHint = hint?.trim();
  if (!normalizedMessage) {
    return normalizedHint ? `Hint: ${normalizedHint}` : null;
  }
  return normalizedHint ? `${normalizedMessage} Hint: ${normalizedHint}` : normalizedMessage;
}

export function recordWsConnectionErrored(
  message?: string | null,
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const status = updateWsConnectionStatus((current) =>
    applyDisconnectState(current, {
      lastError:
        appendHint(message, metadata?.versionMismatchHint) ??
        appendHint(current.lastError, metadata?.versionMismatchHint),
      lastErrorAt: isoNow(),
    }),
  );
  recordDiagnosticEvent("error", status);
  return status;
}

export function recordWsConnectionClosed(
  details?: {
    readonly code?: number;
    readonly reason?: string;
  },
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const connectionLabel = normalizeConnectionLabel(metadata?.connectionLabel);
  const status = updateWsConnectionStatus((current) =>
    applyDisconnectState(
      current,
      {
        closeCode: details?.code ?? current.closeCode,
        closeReason:
          appendHint(details?.reason, metadata?.versionMismatchHint) ??
          appendHint(current.closeReason, metadata?.versionMismatchHint),
      },
      connectionLabel === null ? undefined : { connectionLabel },
    ),
  );
  recordDiagnosticEvent("closed", status);
  return status;
}

export function setBrowserOnlineStatus(online: boolean): WsConnectionStatus {
  const status = updateWsConnectionStatus((current) => ({
    ...current,
    online,
  }));
  recordDiagnosticEvent("online-state", status);
  return status;
}

export function resetWsReconnectBackoff(): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    nextRetryAt: null,
    reconnectAttemptCount: 0,
    reconnectPhase: "idle",
  }));
}

export function resetWsConnectionStateForTests(): void {
  appAtomRegistry.set(wsConnectionStatusAtom, INITIAL_WS_CONNECTION_STATUS);
  wsConnectionDiagnosticEvents.length = 0;
}

export function useWsConnectionStatus(): WsConnectionStatus {
  return useAtomValue(wsConnectionStatusAtom);
}

export function getWsReconnectDelayMsForRetry(retryIndex: number): number | null {
  if (!Number.isInteger(retryIndex) || retryIndex < 0 || retryIndex >= WS_RECONNECT_MAX_RETRIES) {
    return null;
  }

  return Math.min(
    Math.round(WS_RECONNECT_INITIAL_DELAY_MS * WS_RECONNECT_BACKOFF_FACTOR ** retryIndex),
    WS_RECONNECT_MAX_DELAY_MS,
  );
}

function applyDisconnectState(
  current: WsConnectionStatus,
  updates: Partial<
    Pick<WsConnectionStatus, "closeCode" | "closeReason" | "lastError" | "lastErrorAt">
  >,
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const disconnectedAt = current.disconnectedAt ?? isoNow();
  const nextRetryDelayMs =
    current.nextRetryAt !== null || current.reconnectPhase === "exhausted"
      ? null
      : getWsReconnectDelayMsForRetry(Math.max(0, current.reconnectAttemptCount - 1));

  return {
    ...current,
    ...updates,
    connectionLabel: normalizeConnectionLabel(metadata?.connectionLabel) ?? current.connectionLabel,
    disconnectedAt,
    nextRetryAt:
      nextRetryDelayMs === null
        ? current.nextRetryAt
        : new Date(Date.now() + nextRetryDelayMs).toISOString(),
    phase: "disconnected",
    reconnectPhase:
      current.reconnectPhase === "waiting" || current.reconnectPhase === "exhausted"
        ? current.reconnectPhase
        : nextRetryDelayMs === null
          ? "exhausted"
          : "waiting",
  };
}
