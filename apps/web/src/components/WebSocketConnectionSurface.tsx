import { type ReactNode, useEffect, useEffectEvent, useRef } from "react";

import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  setBrowserOnlineStatus,
  type WsConnectionStatus,
  useWsConnectionStatus,
} from "../rpc/wsConnectionState";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";

const FORCED_WS_RECONNECT_DEBOUNCE_MS = 5_000;
export const EXHAUSTED_WS_RECONNECT_RETRY_MS = 15_000;
type WsAutoReconnectTrigger = "focus" | "online" | "visible";

export function reconnectPrimaryWebSocketTransport(connection: {
  readonly client: { readonly reconnect: () => Promise<void> };
}): Promise<void> {
  return connection.client.reconnect();
}

export function shouldAutoReconnect(
  status: WsConnectionStatus,
  trigger: WsAutoReconnectTrigger,
): boolean {
  const uiState = getWsConnectionUiState(status);

  if (trigger === "online") {
    return (
      uiState === "offline" ||
      uiState === "reconnecting" ||
      uiState === "error" ||
      status.reconnectPhase === "exhausted"
    );
  }

  return (
    status.online &&
    (uiState === "error" || uiState === "reconnecting" || status.reconnectPhase === "exhausted")
  );
}

export function shouldRestartStalledReconnect(
  status: WsConnectionStatus,
  expectedNextRetryAt: string,
): boolean {
  return (
    status.reconnectPhase === "waiting" &&
    status.nextRetryAt === expectedNextRetryAt &&
    status.online
  );
}

export function shouldRestartExhaustedReconnect(status: WsConnectionStatus): boolean {
  return status.reconnectPhase === "exhausted" && status.online && status.phase === "disconnected";
}

export function WebSocketConnectionCoordinator() {
  const status = useWsConnectionStatus();
  const restartExhaustedReconnect = shouldRestartExhaustedReconnect(status);
  const lastForcedReconnectAtRef = useRef(0);

  // Reconnect status is surfaced inline by ConnectionStatusIndicator in the chat
  // header (spinner + retry detail on hover/tap); failures here stay quiet so the
  // transport can keep retrying without stacking toasts.
  const runReconnect = useEffectEvent(() => {
    lastForcedReconnectAtRef.current = Date.now();
    // Automatic recovery only needs to replace the transport session. Waiting
    // on EnvironmentConnection.reconnect() would also wait for the next shell
    // snapshot. A second focus/timer recovery can reset that bootstrap gate and
    // leave the older automatic-reconnect promise pending forever. The primary
    // shell subscription already resubscribes and applies a fresh snapshot when
    // its transport changes, and the primary connection has no remote metadata
    // refresh step to skip here.
    void reconnectPrimaryWebSocketTransport(getPrimaryEnvironmentConnection()).catch((error) => {
      console.warn("Automatic WebSocket reconnect failed", { error });
    });
  });
  const syncBrowserOnlineStatus = useEffectEvent(() => {
    setBrowserOnlineStatus(navigator.onLine !== false);
  });
  const triggerAutoReconnect = useEffectEvent((trigger: WsAutoReconnectTrigger) => {
    const currentStatus =
      trigger === "online" ? setBrowserOnlineStatus(true) : getWsConnectionStatus();

    if (!shouldAutoReconnect(currentStatus, trigger)) {
      return;
    }
    if (Date.now() - lastForcedReconnectAtRef.current < FORCED_WS_RECONNECT_DEBOUNCE_MS) {
      return;
    }

    runReconnect();
  });

  useEffect(() => {
    const handleOnline = () => {
      triggerAutoReconnect("online");
    };
    const handleFocus = () => {
      triggerAutoReconnect("focus");
    };
    // Mobile browsers freeze background tabs (the socket dies and the backoff
    // timer stops ticking) and often resume them without firing window focus —
    // only visibilitychange/pageshow. Reconnect immediately on return instead
    // of waiting out a stale retry timer.
    const handleVisible = () => {
      if (document.visibilityState === "visible") {
        triggerAutoReconnect("visible");
      }
    };

    syncBrowserOnlineStatus();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", syncBrowserOnlineStatus);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("pageshow", handleVisible);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", syncBrowserOnlineStatus);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("pageshow", handleVisible);
    };
  }, []);

  useEffect(() => {
    if (status.reconnectPhase !== "waiting" || status.nextRetryAt === null || !status.online) {
      return;
    }

    const nextRetryAt = status.nextRetryAt;
    const timeoutMs = Math.max(0, new Date(nextRetryAt).getTime() - Date.now()) + 1_500;
    const timeoutId = window.setTimeout(() => {
      const currentStatus = getWsConnectionStatus();
      if (!shouldRestartStalledReconnect(currentStatus, nextRetryAt)) {
        return;
      }

      runReconnect();
    }, timeoutMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [status.nextRetryAt, status.online, status.reconnectAttemptCount, status.reconnectPhase]);

  useEffect(() => {
    if (!restartExhaustedReconnect) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (shouldRestartExhaustedReconnect(getWsConnectionStatus())) {
        runReconnect();
      }
    }, EXHAUSTED_WS_RECONNECT_RETRY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [restartExhaustedReconnect]);

  return null;
}

export function WebSocketConnectionSurface({ children }: { readonly children: ReactNode }) {
  return children;
}
