import { type ReactNode, useEffect, useEffectEvent, useRef } from "react";

import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  setBrowserOnlineStatus,
  type WsConnectionStatus,
} from "../rpc/wsConnectionState";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";

const FORCED_WS_RECONNECT_DEBOUNCE_MS = 5_000;
type WsAutoReconnectTrigger = "focus" | "online" | "visible";

export function shouldAutoReconnect(
  status: WsConnectionStatus,
  trigger: WsAutoReconnectTrigger,
): boolean {
  const uiState = getWsConnectionUiState(status);

  // The protocol owns every active retry and its backoff. Resume events must
  // neither reset a waiting/attempting schedule nor resurrect a definitive
  // admission/configuration rejection. Only a stale idle session can resume.
  if (status.reconnectPhase !== "idle") return false;

  if (trigger === "online") {
    return uiState === "offline" || uiState === "reconnecting" || uiState === "error";
  }

  return status.online && status.hasConnected && uiState === "reconnecting";
}

export function WebSocketConnectionCoordinator() {
  const lastForcedReconnectAtRef = useRef(0);

  // Reconnect status is surfaced by ConnectionStatusIndicator beside Settings
  // (spinner + retry detail on hover/tap); failures here stay quiet so the
  // transport can keep retrying without stacking toasts.
  const runReconnect = useEffectEvent(() => {
    lastForcedReconnectAtRef.current = Date.now();
    void getPrimaryEnvironmentConnection()
      .reconnect()
      .catch((error) => {
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
    // only visibilitychange/pageshow. Offer the same idle-session wakeup on
    // return; an active protocol still owns its delayed timer and capped ramp.
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

  // A live protocol owns its retry timer, including catch-up after a frozen
  // renderer. A second UI watchdog must not replace that runtime/reset its
  // capped ramp because a delayed timer is mistaken for exhausted retries.
  return null;
}

export function WebSocketConnectionSurface({ children }: { readonly children: ReactNode }) {
  return children;
}
