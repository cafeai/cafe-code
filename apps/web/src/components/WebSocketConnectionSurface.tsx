import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  setBrowserOnlineStatus,
  type WsConnectionStatus,
  useWsConnectionStatus,
  WS_RECONNECT_MAX_ATTEMPTS,
} from "../rpc/wsConnectionState";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";

const FORCED_WS_RECONNECT_DEBOUNCE_MS = 5_000;
type WsAutoReconnectTrigger = "focus" | "online" | "visible";

function formatRetryCountdown(nextRetryAt: string, nowMs: number): string {
  const remainingMs = Math.max(0, new Date(nextRetryAt).getTime() - nowMs);
  return `${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}

function describeOfflineToast(): string {
  return "WebSocket disconnected. Waiting for network.";
}

function formatReconnectAttemptLabel(status: WsConnectionStatus): string {
  const reconnectAttempt = Math.max(
    1,
    Math.min(status.reconnectAttemptCount, WS_RECONNECT_MAX_ATTEMPTS),
  );
  return `Attempt ${reconnectAttempt}/${status.reconnectMaxAttempts}`;
}

function describeExhaustedToast(): string {
  return "Retries exhausted trying to reconnect";
}

function getConnectionDisplayName(status: WsConnectionStatus): string {
  return status.connectionLabel?.trim() || "Cafe Code Server";
}

function buildReconnectTitle(status: WsConnectionStatus): string {
  return `Disconnected from ${getConnectionDisplayName(status)}`;
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
    status.hasConnected &&
    (uiState === "reconnecting" || status.reconnectPhase === "exhausted")
  );
}

export function shouldRestartStalledReconnect(
  status: WsConnectionStatus,
  expectedNextRetryAt: string,
): boolean {
  return (
    status.reconnectPhase === "waiting" &&
    status.nextRetryAt === expectedNextRetryAt &&
    status.online &&
    status.hasConnected
  );
}

export function WebSocketConnectionCoordinator() {
  const status = useWsConnectionStatus();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastForcedReconnectAtRef = useRef(0);
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  const runReconnect = useEffectEvent((showFailureToast: boolean) => {
    lastForcedReconnectAtRef.current = Date.now();
    void getPrimaryEnvironmentConnection()
      .reconnect()
      .catch((error) => {
        if (!showFailureToast) {
          console.warn("Automatic WebSocket reconnect failed", { error });
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Reconnect failed",
            description:
              error instanceof Error ? error.message : "Unable to restart the WebSocket.",
            data: {
              dismissAfterVisibleMs: 8_000,
              hideCopyButton: true,
            },
          }),
        );
      });
  });
  const syncBrowserOnlineStatus = useEffectEvent(() => {
    setBrowserOnlineStatus(navigator.onLine !== false);
  });
  const triggerManualReconnect = useEffectEvent(() => {
    runReconnect(true);
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

    runReconnect(false);
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
    if (status.reconnectPhase !== "waiting" || status.nextRetryAt === null) {
      return;
    }

    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [status.nextRetryAt, status.reconnectPhase]);

  useEffect(() => {
    if (
      status.reconnectPhase !== "waiting" ||
      status.nextRetryAt === null ||
      !status.online ||
      !status.hasConnected
    ) {
      return;
    }

    const nextRetryAt = status.nextRetryAt;
    const timeoutMs = Math.max(0, new Date(nextRetryAt).getTime() - Date.now()) + 1_500;
    const timeoutId = window.setTimeout(() => {
      const currentStatus = getWsConnectionStatus();
      if (!shouldRestartStalledReconnect(currentStatus, nextRetryAt)) {
        return;
      }

      runReconnect(false);
    }, timeoutMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    status.hasConnected,
    status.nextRetryAt,
    status.online,
    status.reconnectAttemptCount,
    status.reconnectPhase,
  ]);

  useEffect(() => {
    const uiState = getWsConnectionUiState(status);
    const shouldShowReconnectToast = status.hasConnected && uiState === "reconnecting";
    const shouldShowOfflineToast = uiState === "offline" && status.disconnectedAt !== null;
    const shouldShowExhaustedToast = status.hasConnected && status.reconnectPhase === "exhausted";

    if (shouldShowReconnectToast || shouldShowOfflineToast || shouldShowExhaustedToast) {
      const toastPayload = shouldShowOfflineToast
        ? stackedThreadToast({
            data: {
              hideCopyButton: true,
            },
            description: describeOfflineToast(),
            timeout: 0,
            title: "Offline",
            type: "warning",
          })
        : shouldShowExhaustedToast
          ? stackedThreadToast({
              actionProps: {
                children: "Retry",
                onClick: triggerManualReconnect,
              },
              data: {
                hideCopyButton: true,
              },
              description: describeExhaustedToast(),
              timeout: 0,
              title: buildReconnectTitle(status),
              type: "error",
            })
          : stackedThreadToast({
              actionProps: {
                children: "Retry now",
                onClick: triggerManualReconnect,
              },
              data: {
                hideCopyButton: true,
              },
              description:
                status.nextRetryAt === null
                  ? `Reconnecting... ${formatReconnectAttemptLabel(status)}`
                  : `Reconnecting in ${formatRetryCountdown(status.nextRetryAt, nowMs)}... ${formatReconnectAttemptLabel(status)}`,
              timeout: 0,
              title: buildReconnectTitle(status),
              type: "loading",
            });

      if (toastIdRef.current) {
        toastManager.update(toastIdRef.current, toastPayload);
      } else {
        toastIdRef.current = toastManager.add(toastPayload);
      }
    } else if (toastIdRef.current) {
      toastManager.close(toastIdRef.current);
      toastIdRef.current = null;
    }

    // Successful automatic reconnects are intentionally quiet. During a long
    // coding session, reconnect/recovered success toasts become noise even when
    // the transport did exactly what it should. Active outages still surface
    // above; recovered state remains available through connection diagnostics.
  }, [nowMs, status]);

  return null;
}

export function WebSocketConnectionSurface({ children }: { readonly children: ReactNode }) {
  return children;
}
