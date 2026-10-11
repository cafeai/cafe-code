import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getWsConnectionStatus,
  getWsConnectionDiagnostics,
  getWsReconnectDelayMsForRetry,
  getWsConnectionUiState,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  recordWsConnectionTerminalError,
  recordWsHeartbeatTimeout,
  recordWsRetryScheduled,
  resetWsConnectionStateForTests,
  setBrowserOnlineStatus,
} from "./wsConnectionState";

describe("wsConnectionState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T20:30:00.000Z"));
    resetWsConnectionStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats a disconnected browser as offline once the websocket drops", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsConnectionClosed({ code: 1006, reason: "offline" });
    setBrowserOnlineStatus(false);

    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("offline");
  });

  it("stays in the initial connecting state until the first disconnect", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");

    expect(getWsConnectionStatus()).toMatchObject({
      attemptCount: 1,
      hasConnected: false,
      phase: "connecting",
    });
    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("connecting");
  });

  it("schedules the next retry after a failed websocket attempt", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws", {
      connectionLabel: "Remote Mac",
    });
    recordWsConnectionErrored("Unable to connect to the Cafe Code server WebSocket.");

    const firstRetryDelayMs = getWsReconnectDelayMsForRetry(0);
    if (firstRetryDelayMs === null) {
      throw new Error("Expected an initial retry delay.");
    }

    expect(getWsConnectionStatus()).toMatchObject({
      connectionLabel: "Remote Mac",
      nextRetryAt: new Date(Date.now() + firstRetryDelayMs).toISOString(),
      reconnectAttemptCount: 1,
      reconnectPhase: "waiting",
    });
  });

  it("adds a version mismatch hint to websocket errors when metadata includes one", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws", {
      connectionLabel: "Remote Mac",
    });
    recordWsConnectionErrored("Unable to connect to the Cafe Code server WebSocket.", {
      versionMismatchHint: "Version mismatch. Try syncing the client and server.",
    });

    expect(getWsConnectionStatus()).toMatchObject({
      lastError:
        "Unable to connect to the Cafe Code server WebSocket. Hint: Version mismatch. Try syncing the client and server.",
    });
  });

  it("adds a version mismatch hint to websocket close reasons when metadata includes one", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsConnectionClosed(
      { code: 1006, reason: "socket closed" },
      {
        versionMismatchHint: "Version mismatch. Try syncing the client and server.",
      },
    );

    expect(getWsConnectionStatus()).toMatchObject({
      closeReason: "socket closed Hint: Version mismatch. Try syncing the client and server.",
    });
  });

  it("keeps a long transient outage waiting at the capped delay", () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      recordWsConnectionAttempt("ws://localhost:3020/ws");
      recordWsConnectionErrored("Unable to connect to the Cafe Code server WebSocket.");
    }

    expect(getWsConnectionStatus()).toMatchObject({
      nextRetryAt: new Date(Date.now() + 64_000).toISOString(),
      reconnectAttemptCount: 12,
      reconnectMaxAttempts: null,
      reconnectPhase: "waiting",
    });
  });

  it("reserves exhaustion for an explicit terminal rejection", () => {
    recordWsConnectionAttempt(null);
    recordWsConnectionTerminalError("Unable to connect to the Cafe Code server WebSocket.");

    expect(getWsConnectionStatus()).toMatchObject({
      nextRetryAt: null,
      reconnectAttemptCount: 1,
      reconnectPhase: "exhausted",
      socketUrl: null,
    });
  });

  it("tracks the same post-open attempt and delay as the actual protocol", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsConnectionClosed({ code: 1012, reason: "synthetic restart" });
    expect(getWsConnectionStatus()).toMatchObject({
      reconnectAttemptCount: 1,
      nextRetryAt: new Date(Date.now() + 1_000).toISOString(),
    });
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionErrored("Unable to connect to the Cafe Code server WebSocket.");
    expect(getWsConnectionStatus()).toMatchObject({
      reconnectAttemptCount: 2,
      nextRetryAt: new Date(Date.now() + 2_000).toISOString(),
    });
  });

  it("caps valid retry delays and rejects invalid retry indices", () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6, 7, 100, Number.MAX_SAFE_INTEGER].map(getWsReconnectDelayMsForRetry),
    ).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 64_000, 64_000, 64_000]);
    expect(
      [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY].map(getWsReconnectDelayMsForRetry),
    ).toEqual([null, null, null, null]);
  });

  it("uses the enforcing schedule's deadline after a handshake without a healthy Pong", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsConnectionErrored("WebSocket heartbeat timed out.");
    const nextRetryAt = new Date(Date.now() + 8_000).toISOString();
    recordWsRetryScheduled({ retryIndex: 3, delayMs: 8_000, nextRetryAt });

    expect(getWsConnectionStatus()).toMatchObject({
      reconnectAttemptCount: 4,
      nextRetryAt,
      retryDelayMs: 8_000,
      reconnectPhase: "waiting",
      phase: "disconnected",
    });
  });

  it("publishes bounded heartbeat and actual retry diagnostics without retained payloads", () => {
    recordWsConnectionAttempt("wss://secret.example.test/ws?token=secret");
    recordWsConnectionOpened();
    recordWsHeartbeatTimeout();
    vi.advanceTimersByTime(1_000);
    recordWsHeartbeatTimeout();
    const lastHeartbeatTimeoutAt = new Date().toISOString();
    recordWsRetryScheduled({
      retryIndex: 6,
      delayMs: 64_000,
      nextRetryAt: new Date(Date.now() + 64_000).toISOString(),
    });
    const diagnostics = getWsConnectionDiagnostics();
    expect(diagnostics).toMatchObject({
      heartbeatTimeoutCount: 2,
      lastHeartbeatTimeoutAt,
      retryDelayMs: 64_000,
    });
    expect(diagnostics.recentEvents.slice(-2).map((event) => event.kind)).toEqual([
      "heartbeat-timeout",
      "retry-scheduled",
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
    recordWsConnectionAttempt(null);
    expect(getWsConnectionDiagnostics()).toMatchObject({
      retryDelayMs: null,
      heartbeatTimeoutCount: 2,
    });
    recordWsConnectionOpened();
    expect(getWsConnectionDiagnostics()).toMatchObject({
      retryDelayMs: null,
      heartbeatTimeoutCount: 2,
    });
    recordWsRetryScheduled({
      retryIndex: 0,
      delayMs: 1_000,
      nextRetryAt: new Date().toISOString(),
    });
    recordWsConnectionTerminalError("Connection rejected.");
    expect(getWsConnectionDiagnostics()).toMatchObject({
      retryDelayMs: null,
      heartbeatTimeoutCount: 2,
    });
  });

  it("retains only bounded payload-free websocket lifecycle diagnostics", () => {
    for (let index = 0; index < 20; index += 1) {
      recordWsConnectionAttempt(`wss://secret.example.test/ws?token=secret-${index}`, {
        connectionLabel: `Sensitive host ${index}`,
      });
      recordWsConnectionClosed({
        code: 4_000 + index,
        reason: `private close reason ${index}`,
      });
    }

    const diagnostics = getWsConnectionDiagnostics();
    const serialized = JSON.stringify(diagnostics);
    expect(diagnostics.recentEvents).toHaveLength(32);
    expect(diagnostics.recentEvents.at(-1)).toMatchObject({
      kind: "closed",
      closeCode: 4_019,
    });
    expect(serialized).not.toContain("secret.example.test");
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("Sensitive host");
    expect(serialized).not.toContain("private close reason");
  });
});
