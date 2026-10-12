import { describe, expect, it } from "vitest";

import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import { shouldAutoReconnect } from "./WebSocketConnectionSurface";

function makeStatus(overrides: Partial<WsConnectionStatus> = {}): WsConnectionStatus {
  return {
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
    online: true,
    phase: "idle",
    reconnectAttemptCount: 0,
    reconnectMaxAttempts: null,
    retryDelayMs: null,
    heartbeatTimeoutCount: 0,
    lastHeartbeatTimeoutAt: null,
    reconnectPhase: "idle",
    socketUrl: null,
    ...overrides,
  };
}

describe("WebSocketConnectionSurface.logic", () => {
  it("forces reconnect on online when the app was offline", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          online: false,
          phase: "disconnected",
        }),
        "online",
      ),
    ).toBe(true);
  });

  it("forces reconnect on focus only for previously connected idle disconnected states", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "idle",
        }),
        "focus",
      ),
    ).toBe(true);

    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: false,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "idle",
        }),
        "focus",
      ),
    ).toBe(false);
  });

  it.each(["focus", "visible", "online"] as const)(
    "does not retry terminal admission on %s",
    (trigger) => {
      expect(
        shouldAutoReconnect(
          makeStatus({
            hasConnected: true,
            online: true,
            phase: "disconnected",
            reconnectAttemptCount: 8,
            reconnectPhase: "exhausted",
          }),
          trigger,
        ),
      ).toBe(false);
    },
  );

  it.each(["waiting", "attempting"] as const)(
    "preserves the enforcing %s schedule even past its deadline",
    (phase) => {
      expect(
        shouldAutoReconnect(
          makeStatus({
            hasConnected: true,
            nextRetryAt: "2026-04-03T20:00:01.000Z",
            online: true,
            phase: "disconnected",
            reconnectAttemptCount: 3,
            reconnectPhase: phase,
          }),
          "focus",
        ),
      ).toBe(false);
    },
  );
});
