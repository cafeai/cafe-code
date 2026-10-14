import { describe, expect, it, vi } from "vitest";

import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import {
  reconnectPrimaryWebSocketTransport,
  shouldAutoReconnect,
  shouldRestartExhaustedReconnect,
  shouldRestartStalledReconnect,
} from "./WebSocketConnectionSurface";

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
    reconnectMaxAttempts: 8,
    reconnectPhase: "idle",
    socketUrl: null,
    ...overrides,
  };
}

describe("WebSocketConnectionSurface.logic", () => {
  it("restarts only the primary transport instead of waiting on its bootstrap gate", async () => {
    const reconnectTransport = vi.fn(async () => undefined);
    const reconnectEnvironment = vi.fn(async () => undefined);
    const connection = {
      client: { reconnect: reconnectTransport },
      reconnect: reconnectEnvironment,
    };

    await reconnectPrimaryWebSocketTransport(connection);

    expect(reconnectTransport).toHaveBeenCalledOnce();
    expect(reconnectEnvironment).not.toHaveBeenCalled();
  });

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

  it("forces reconnect on focus for disconnected states before or after the first connection", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
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
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(true);
  });

  it("forces reconnect on focus for exhausted reconnect loops", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 8,
          reconnectPhase: "exhausted",
        }),
        "focus",
      ),
    ).toBe(true);
  });

  it("does not disrupt a healthy socket, an active connection attempt, or an offline wait", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "connected",
        }),
        "focus",
      ),
    ).toBe(false);
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: false,
          online: true,
          phase: "connecting",
          reconnectPhase: "attempting",
        }),
        "visible",
      ),
    ).toBe(false);
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: false,
          online: false,
          phase: "disconnected",
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(false);
  });

  it("restarts a stalled reconnect window after the scheduled retry time passes", () => {
    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(true);

    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "attempting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(false);
  });

  it("starts a fresh bounded cycle when a mobile client exhausts retries", () => {
    expect(
      shouldRestartExhaustedReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 8,
          reconnectPhase: "exhausted",
        }),
      ),
    ).toBe(true);
    expect(
      shouldRestartExhaustedReconnect(
        makeStatus({
          hasConnected: false,
          online: true,
          phase: "disconnected",
          reconnectPhase: "exhausted",
        }),
      ),
    ).toBe(true);
  });

  it("restarts a stalled first-connection retry after the scheduled time passes", () => {
    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: false,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(true);
  });
});
